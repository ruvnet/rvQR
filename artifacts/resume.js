/*!
 * rvQR resume — durable in-flight transfer state.
 *
 * A camera transfer of a large artifact takes minutes. Tabs get closed, phones
 * lock, browsers get killed under memory pressure. This module persists a
 * receive incrementally so that none of those events costs the frames already
 * scanned: reopen the page, pick the transfer back up, and keep scanning from
 * where the last frame landed.
 *
 * The IndexedDB factory is injected. In a browser that is the global
 * `indexedDB`; in Node tests it is memoryFactory(), an in-memory fake. Both run
 * the same store code — the fake exists so the persistence logic can be tested
 * headlessly, not so a second implementation can drift away from the first.
 *
 * This module owns its own database. It does not touch the vault schema in
 * app.js.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRResume = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'rvqr-resume';
  var DB_VERSION = 1;
  var STORE_META = 'transfers';
  var STORE_CHUNKS = 'chunks';
  var INDEX_TRANSFER = 'transferId';

  // How long an untouched transfer survives.
  //
  // Seven days is long enough that "I'll finish scanning tomorrow" and "I'll
  // finish it after the weekend" both work, and short enough that a phone does
  // not silently accumulate half-received artifacts for a month. Partial
  // transfers are the largest thing this module stores and the least useful
  // once abandoned, so the default errs toward reclaiming space. Pruning runs
  // on open and can be called explicitly.
  var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Ceilings on anything read back out of storage. Persisted state is not
  // hostile the way a QR frame is, but it is still input: another tab, an older
  // version of this code, or a corrupted record can all produce values that
  // must not reach an allocation unchecked.
  var MAX_TOTAL_FRAMES = 65536;
  var MAX_CHUNK_BYTES = 4096;

  /** Every rejection carries a stable `reason`; the message is for humans. */
  function ResumeError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'ResumeError';
    err.reason = reason;
    return err;
  }

  function isQuotaError(err) {
    if (!err) return false;
    var name = err.name || '';
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 || err.code === 1014;
  }

  function wrapError(err) {
    if (err && err.name === 'ResumeError') return err;
    if (isQuotaError(err)) {
      return ResumeError(
        'quota-exceeded',
        'the browser refused the write: storage for this site is full. ' +
          'Free space or drop an old transfer, then continue scanning.'
      );
    }
    return ResumeError('storage-failed', (err && err.message) || String(err));
  }

  // --- Promise adapters over the IndexedDB request API ------------------------

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        reject(wrapError(request.error));
      };
    });
  }

  /**
   * Runs `fn` inside one transaction and resolves only once the transaction
   * has actually committed.
   *
   * Resolving on the last request instead would report a durable write that
   * the browser may still abort — precisely the case this module exists to
   * survive.
   */
  function runTx(db, storeNames, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (e) {
        reject(wrapError(e));
        return;
      }
      var value;
      var failed = null;
      tx.oncomplete = function () { failed ? reject(failed) : resolve(value); };
      tx.onerror = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        reject(failed || wrapError(tx.error));
      };
      tx.onabort = function () {
        reject(failed || wrapError(tx.error) || ResumeError('storage-failed', 'transaction aborted'));
      };
      var stores = {};
      (typeof storeNames === 'string' ? [storeNames] : storeNames).forEach(function (n) {
        stores[n] = tx.objectStore(n);
      });
      Promise.resolve()
        .then(function () { return fn(stores, tx); })
        .then(function (v) { value = v; })
        .catch(function (e) {
          failed = wrapError(e);
          try { tx.abort(); } catch (ignored) { /* already aborting */ }
        });
    });
  }

  // --- Record shapes ----------------------------------------------------------

  function chunkKey(transferId, seq) {
    return transferId + ':' + seq;
  }

  /**
   * The compact, repeatedly-rewritten half of the persisted state.
   *
   * Everything here is fixed size regardless of how far the transfer has got —
   * the received frames live in their own records and are written once each.
   * Rewriting a growing list of sequence numbers on every frame would make a
   * long transfer quadratic in exactly the case that needs to stay cheap.
   */
  function metaRecord(transferId, state, now) {
    var m = state.manifest || null;
    return {
      id: transferId,
      updatedAt: now,
      hashPrefix: state.hashPrefix || null,
      total: state.total || 0,
      received: state.received || 0,
      manifest: m && {
        name: m.name, size: m.size, sha256: m.sha256, chunk: m.chunk
      }
    };
  }

  function manifestMatches(a, b) {
    if (!a || !b) return false;
    return a.sha256 === b.sha256 && a.size === b.size &&
      a.chunk === b.chunk && a.name === b.name;
  }

  // --- Store ------------------------------------------------------------------

  /**
   * Opens (and upgrades) the resume database.
   *
   * opts: { factory, dbName, ttlMs, now, prune }
   *   factory — an IDBFactory. Defaults to the global indexedDB.
   *   now     — () => epoch ms. Injectable so TTL behaviour is testable.
   *   prune   — set false to skip the prune-on-open.
   */
  function open(opts) {
    opts = opts || {};
    var factory = opts.factory ||
      (typeof indexedDB !== 'undefined' ? indexedDB : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.indexedDB : null);
    if (!factory) {
      return Promise.reject(ResumeError('no-indexeddb', 'no IndexedDB implementation available'));
    }
    var dbName = opts.dbName || DB_NAME;
    var ttlMs = opts.ttlMs === undefined ? DEFAULT_TTL_MS : Math.max(0, Number(opts.ttlMs) || 0);
    var now = opts.now || function () { return Date.now(); };

    return new Promise(function (resolve, reject) {
      var request;
      try {
        request = factory.open(dbName, DB_VERSION);
      } catch (e) {
        reject(wrapError(e));
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          var chunks = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
          chunks.createIndex(INDEX_TRANSFER, 'transferId', { unique: false });
        }
      };
      request.onerror = function () { reject(wrapError(request.error)); };
      request.onsuccess = function () {
        var store = createStore(request.result, { ttlMs: ttlMs, now: now });
        if (opts.prune === false) { resolve(store); return; }
        store.prune().then(function () { resolve(store); }, function () { resolve(store); });
      };
    });
  }

  function createStore(db, config) {
    var ttlMs = config.ttlMs;
    var now = config.now;

    // Which sequence numbers are already durable, per transfer. Purely an
    // optimisation: it lets saveProgress write only the frames that arrived
    // since the last call instead of rewriting the whole artifact each time.
    // It is rebuilt from storage by loadProgress/restore, so a fresh tab that
    // resumes a transfer does not re-write what it just read back.
    var persisted = Object.create(null);

    function seqSet(transferId) {
      if (!persisted[transferId]) persisted[transferId] = Object.create(null);
      return persisted[transferId];
    }

    function putAll(stores, transferId, meta, pending) {
      stores[STORE_META].put(meta);
      for (var i = 0; i < pending.length; i++) {
        stores[STORE_CHUNKS].put({
          key: chunkKey(transferId, pending[i].seq),
          transferId: transferId,
          seq: pending[i].seq,
          bytes: pending[i].bytes
        });
      }
    }

    /**
     * Persists whatever of `state` is not yet durable: the fixed-size meta
     * record every time, and each newly arrived chunk exactly once.
     *
     * Both go in one transaction, so a chunk write that fails — quota, most
     * likely — takes the meta update down with it and leaves the stored
     * received-count honest rather than claiming a frame that was never
     * written.
     */
    function saveProgress(transferId, state) {
      if (!transferId) return Promise.reject(ResumeError('bad-transfer-id', 'transferId is required'));
      if (!state) return Promise.reject(ResumeError('bad-state', 'state is required'));
      var known = seqSet(transferId);
      var pending = [];
      var chunks = state.chunks || {};
      var bytes = 0;
      for (var key in chunks) {
        var seq = Number(key);
        if (known[seq]) continue;
        var payload = chunks[key];
        if (!payload || typeof payload.length !== 'number') continue;
        pending.push({ seq: seq, bytes: payload });
        bytes += payload.length;
      }
      var meta = metaRecord(transferId, state, now());
      return runTx(db, [STORE_META, STORE_CHUNKS], 'readwrite', function (stores) {
        putAll(stores, transferId, meta, pending);
      }).then(function () {
        for (var i = 0; i < pending.length; i++) known[pending[i].seq] = true;
        return { ok: true, wrote: pending.length, bytes: bytes, updatedAt: meta.updatedAt };
      });
    }

    /**
     * The single-frame path, for a receiver that persists as it scans rather
     * than in batches. One chunk record plus one meta record per call.
     */
    function recordFrame(transferId, seq, payload, state) {
      if (!Number.isInteger(seq) || seq < 1) {
        return Promise.reject(ResumeError('bad-seq', 'sequence ' + seq + ' is not a data frame'));
      }
      if (!payload || payload.length > MAX_CHUNK_BYTES) {
        return Promise.reject(ResumeError('bad-chunk', 'chunk of ' + (payload && payload.length) + ' bytes'));
      }
      var known = seqSet(transferId);
      var meta = metaRecord(transferId, state || {}, now());
      var pending = known[seq] ? [] : [{ seq: seq, bytes: payload }];
      return runTx(db, [STORE_META, STORE_CHUNKS], 'readwrite', function (stores) {
        putAll(stores, transferId, meta, pending);
      }).then(function () {
        known[seq] = true;
        return { ok: true, wrote: pending.length, bytes: pending.length ? payload.length : 0 };
      });
    }

    /** The meta record for one transfer, or null. Does not read the chunks. */
    function loadProgress(transferId) {
      return runTx(db, [STORE_META], 'readonly', function (stores) {
        return requestPromise(stores[STORE_META].get(transferId));
      }).then(function (meta) {
        return meta || null;
      });
    }

    /**
     * Every resumable transfer, newest first, with enough detail for a picker:
     * name, size, how far it got, and whether it is past its TTL.
     */
    function listResumable(opts) {
      opts = opts || {};
      var at = now();
      return runTx(db, [STORE_META], 'readonly', function (stores) {
        return requestPromise(stores[STORE_META].getAll());
      }).then(function (rows) {
        return (rows || [])
          .map(function (m) {
            var total = Math.max(0, (m.total || 0) - 1);
            return {
              id: m.id,
              name: (m.manifest && m.manifest.name) || null,
              size: (m.manifest && m.manifest.size) || 0,
              sha256: (m.manifest && m.manifest.sha256) || null,
              received: m.received || 0,
              total: total,
              percent: total ? Math.min(100, Math.round(((m.received || 0) / total) * 100)) : 0,
              updatedAt: m.updatedAt || 0,
              ageMs: at - (m.updatedAt || 0),
              stale: ttlMs > 0 && at - (m.updatedAt || 0) > ttlMs
            };
          })
          .filter(function (row) { return opts.includeStale ? true : !row.stale; })
          .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      });
    }

    function chunkKeysFor(stores, transferId) {
      var index = stores[STORE_CHUNKS].index(INDEX_TRANSFER);
      return requestPromise(index.getAllKeys(transferId));
    }

    /** Removes a transfer and every chunk it owns. */
    function dropProgress(transferId) {
      return runTx(db, [STORE_META, STORE_CHUNKS], 'readwrite', function (stores) {
        return chunkKeysFor(stores, transferId).then(function (keys) {
          for (var i = 0; i < keys.length; i++) stores[STORE_CHUNKS].delete(keys[i]);
          stores[STORE_META].delete(transferId);
          return keys.length;
        });
      }).then(function (removed) {
        delete persisted[transferId];
        return { ok: true, chunks: removed };
      });
    }

    /** Drops every transfer untouched for longer than the TTL. */
    function prune(opts) {
      opts = opts || {};
      var ttl = opts.ttlMs === undefined ? ttlMs : Math.max(0, Number(opts.ttlMs) || 0);
      if (!ttl) return Promise.resolve({ removed: [], scanned: 0 });
      var at = opts.now || now();
      return runTx(db, [STORE_META], 'readonly', function (stores) {
        return requestPromise(stores[STORE_META].getAll());
      }).then(function (rows) {
        var stale = (rows || []).filter(function (m) {
          return at - (m.updatedAt || 0) > ttl;
        }).map(function (m) { return m.id; });
        return stale.reduce(function (chain, id) {
          return chain.then(function () { return dropProgress(id); });
        }, Promise.resolve()).then(function () {
          return { removed: stale, scanned: (rows || []).length };
        });
      });
    }

    /**
     * Rebuilds a receiver state from storage, shaped exactly like the one
     * core.createReceiver() produces, so the caller can hand it straight back
     * to core.ingest() and core.finalize().
     *
     * `expectManifest` is the manifest the live scan is seeing. If the stored
     * transfer describes a different artifact — same transfer id, different
     * bytes — resuming would interleave two files into one, so it is refused.
     */
    function restore(transferId, expectManifest) {
      return runTx(db, [STORE_META, STORE_CHUNKS], 'readonly', function (stores) {
        return requestPromise(stores[STORE_META].get(transferId)).then(function (meta) {
          if (!meta) return null;
          var index = stores[STORE_CHUNKS].index(INDEX_TRANSFER);
          return requestPromise(index.getAll(transferId)).then(function (rows) {
            return { meta: meta, rows: rows || [] };
          });
        });
      }).then(function (found) {
        if (!found) fail('no-such-transfer', 'nothing stored for transfer ' + transferId);
        var meta = found.meta;
        if (!Number.isInteger(meta.total) || meta.total < 1 || meta.total > MAX_TOTAL_FRAMES) {
          fail('corrupt-progress', 'stored frame count ' + meta.total + ' is out of range');
        }
        if (expectManifest && !manifestMatches(meta.manifest, expectManifest)) {
          fail(
            'manifest-mismatch',
            'stored transfer ' + transferId + ' is ' +
              (meta.manifest ? meta.manifest.name + ' (' + String(meta.manifest.sha256).slice(0, 8) + '…)' : 'unknown') +
              ', the scan is showing ' + expectManifest.name + ' (' + String(expectManifest.sha256).slice(0, 8) + '…)'
          );
        }
        var known = seqSet(transferId);
        var chunks = Object.create(null);
        var received = 0;
        for (var i = 0; i < found.rows.length; i++) {
          var row = found.rows[i];
          if (!Number.isInteger(row.seq) || row.seq < 1 || row.seq >= meta.total) continue;
          if (!row.bytes || row.bytes.length > MAX_CHUNK_BYTES) continue;
          if (row.seq in chunks) continue;
          chunks[row.seq] = row.bytes;
          known[row.seq] = true;
          received++;
        }
        var at = now();
        return {
          status: 'COLLECTING',
          transferId: transferId,
          hashPrefix: meta.hashPrefix,
          total: meta.total,
          manifest: meta.manifest,
          chunks: chunks,
          received: received,
          duplicates: 0,
          rejected: 0,
          startedAt: at,
          lastProgressAt: at,
          switches: 0,
          result: null,
          resumed: true,
          resumedFrom: meta.updatedAt
        };
      });
    }

    function close() {
      try { db.close(); } catch (ignored) { /* already closed */ }
    }

    return {
      db: db,
      ttlMs: ttlMs,
      saveProgress: saveProgress,
      recordFrame: recordFrame,
      loadProgress: loadProgress,
      listResumable: listResumable,
      dropProgress: dropProgress,
      prune: prune,
      restore: restore,
      close: close
    };
  }

  function fail(reason, message) {
    throw ResumeError(reason, message);
  }

  // --- In-memory IndexedDB fake ----------------------------------------------
  // Enough of IDBFactory for the store above and nothing more. It exists so the
  // persistence logic can be exercised in Node; the browser runs the same store
  // code against the real thing.

  function memoryFactory(options) {
    var opts = options || {};
    var databases = Object.create(null);
    var quotaBytes = opts.quotaBytes === undefined ? Infinity : opts.quotaBytes;
    var tick = opts.tick || function (fn) { Promise.resolve().then(fn); };

    function sizeOf(value) {
      var n = 64;
      for (var k in value) {
        n += k.length;
        var v = value[k];
        if (v && typeof v.length === 'number' && typeof v !== 'string') n += v.length;
        else if (typeof v === 'string') n += v.length;
        else if (v && typeof v === 'object') n += JSON.stringify(v).length;
        else n += 8;
      }
      return n;
    }

    function makeRequest() {
      return { onsuccess: null, onerror: null, result: undefined, error: null };
    }

    function settle(request, value, error) {
      tick(function () {
        if (error) {
          request.error = error;
          if (request.onerror) request.onerror({ target: request, preventDefault: function () {} });
        } else {
          request.result = value;
          if (request.onsuccess) request.onsuccess({ target: request });
        }
      });
    }

    function createDatabase(name) {
      return { name: name, version: 0, stores: Object.create(null), used: 0, closed: false };
    }

    function storeHandle(state, data, tx) {
      return {
        keyPath: data.keyPath,
        put: function (value) {
          var request = makeRequest();
          tx.enqueue(request, function () {
            var key = value[data.keyPath];
            if (key === undefined) throw new Error('record has no key');
            var previous = data.records.get(key);
            var delta = sizeOf(value) - (previous ? sizeOf(previous) : 0);
            if (state.used + delta > quotaBytes) {
              var err = new Error('quota exceeded');
              err.name = 'QuotaExceededError';
              err.code = 22;
              throw err;
            }
            state.used += delta;
            data.records.set(key, value);
            return key;
          });
          return request;
        },
        get: function (key) {
          var request = makeRequest();
          tx.enqueue(request, function () { return data.records.get(key); });
          return request;
        },
        delete: function (key) {
          var request = makeRequest();
          tx.enqueue(request, function () {
            var previous = data.records.get(key);
            if (previous) state.used -= sizeOf(previous);
            data.records.delete(key);
            return undefined;
          });
          return request;
        },
        getAll: function () {
          var request = makeRequest();
          tx.enqueue(request, function () {
            return Array.from(data.records.values());
          });
          return request;
        },
        index: function (indexName) {
          var keyPath = data.indexes[indexName];
          if (keyPath === undefined) throw new Error('no such index: ' + indexName);
          return {
            getAll: function (value) {
              var request = makeRequest();
              tx.enqueue(request, function () {
                return Array.from(data.records.values()).filter(function (r) {
                  return value === undefined || r[keyPath] === value;
                });
              });
              return request;
            },
            getAllKeys: function (value) {
              var request = makeRequest();
              tx.enqueue(request, function () {
                var out = [];
                data.records.forEach(function (r, key) {
                  if (value === undefined || r[keyPath] === value) out.push(key);
                });
                return out;
              });
              return request;
            }
          };
        }
      };
    }

    function makeTransaction(state, names) {
      var list = typeof names === 'string' ? [names] : names.slice();
      var snapshots = Object.create(null);
      var usedBefore = state.used;
      list.forEach(function (n) {
        if (!state.stores[n]) throw new Error('no such object store: ' + n);
        snapshots[n] = new Map(state.stores[n].records);
      });

      var tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        _pending: 0,
        _done: false,
        _drained: false
      };

      function finish(kind) {
        if (tx._done) return;
        tx._done = true;
        if (kind === 'abort') {
          list.forEach(function (n) { state.stores[n].records = snapshots[n]; });
          state.used = usedBefore;
          if (tx.onabort) tx.onabort({ target: tx });
        } else if (tx.oncomplete) {
          tx.oncomplete({ target: tx });
        }
      }

      tx.enqueue = function (request, work) {
        if (tx._done) throw new Error('transaction is not active');
        tx._pending++;
        tick(function () {
          if (tx._done) return;
          var value, error = null;
          try { value = work(); } catch (e) { error = e; }
          tx._pending--;
          if (error) {
            tx.error = error;
            settle(request, undefined, error);
            tick(function () {
              if (!tx._done) {
                if (tx.onerror) tx.onerror({ target: tx, preventDefault: function () {} });
                finish('abort');
              }
            });
            return;
          }
          settle(request, value, null);
          maybeComplete();
        });
      };

      function maybeComplete() {
        tick(function () {
          if (!tx._done && tx._drained && tx._pending === 0) finish('complete');
        });
      }

      tx.objectStore = function (name) {
        if (list.indexOf(name) < 0) throw new Error('store ' + name + ' is not in this transaction');
        return storeHandle(state, state.stores[name], tx);
      };
      tx.abort = function () { finish('abort'); };

      // The caller queues its requests synchronously (or across a few
      // microtasks of promise plumbing); the transaction is considered drained
      // once control has returned to the event loop with nothing outstanding.
      // A real IndexedDB transaction commits on the same rule.
      setTimeout(function () {
        tx._drained = true;
        maybeComplete();
      }, 0);

      return tx;
    }

    return {
      _databases: databases,
      open: function (name, version) {
        var request = makeRequest();
        request.onupgradeneeded = null;
        tick(function () {
          var state = databases[name] || (databases[name] = createDatabase(name));
          var db = {
            name: name,
            version: state.version,
            objectStoreNames: {
              contains: function (n) { return !!state.stores[n]; }
            },
            createObjectStore: function (n, config) {
              state.stores[n] = {
                keyPath: (config && config.keyPath) || 'id',
                records: new Map(),
                indexes: Object.create(null)
              };
              return {
                createIndex: function (indexName, keyPath) {
                  state.stores[n].indexes[indexName] = keyPath;
                }
              };
            },
            transaction: function (names, mode) {
              if (state.closed) throw new Error('database is closed');
              return makeTransaction(state, names, mode);
            },
            close: function () { state.closed = true; }
          };
          request.result = db;
          if (version > state.version) {
            state.version = version;
            state.closed = false;
            db.version = version;
            if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
          }
          state.closed = false;
          if (request.onsuccess) request.onsuccess({ target: request });
        });
        return request;
      }
    };
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_META: STORE_META,
    STORE_CHUNKS: STORE_CHUNKS,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    MAX_TOTAL_FRAMES: MAX_TOTAL_FRAMES,
    MAX_CHUNK_BYTES: MAX_CHUNK_BYTES,
    ResumeError: ResumeError,
    isQuotaError: isQuotaError,
    open: open,
    memoryFactory: memoryFactory
  };
});
