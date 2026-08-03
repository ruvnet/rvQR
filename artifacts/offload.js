/*!
 * rvQR offload — the main thread's half of the worker split.
 *
 * The app calls this and nothing else. Whether the work actually happens on a
 * worker thread is a property of the environment, not of the call site: every
 * method returns a promise, and every method resolves to the same value either
 * way, because both paths run the identical job table out of worker.js.
 *
 * WHY THE FALLBACK IS NOT OPTIONAL. rvQR is a single directory of files that
 * is supposed to work when you double-click it. A file:// page cannot
 * construct a same-origin Worker in Chrome at all; a page inside a sandboxed
 * iframe cannot either; a CSP without worker-src can refuse one even when the
 * script itself is allowed (this page ships `script-src 'self' file:
 * 'wasm-unsafe-eval'` and no worker-src, so `blob:` worker construction — the
 * usual trick for inlining a worker — is exactly the thing that gets blocked).
 * In every one of those cases the app must still decode, still hash and still
 * transfer. It loses parallelism. It does not lose function.
 *
 * So construction never throws on a missing or blocked worker. `ready`
 * resolves to { mode, reason } and `mode` tells you which path you got.
 *
 * BUFFER OWNERSHIP. By default every byte argument is COPIED into the worker
 * and the caller keeps its buffer. Pass { transfer: true } and the argument's
 * buffer is handed over instead — zero-copy, and NEUTERED: after the call the
 * caller's view has byteLength 0. Never pass transfer:true for a buffer you
 * still own (a canvas's ImageData, an artifact you are also hashing). The
 * inline path detaches the buffer too, so the contract does not quietly change
 * when the worker is unavailable and code written against one path breaks on
 * the other. See detach() below for the one case where it cannot.
 *
 * Browser: load worker.js before this file if you want an inline fallback that
 *          is possible at all (it supplies the job table), then offload.js.
 * Node:    require('./offload.js') — pass a WorkerCtor to exercise the worker
 *          path over worker_threads.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./worker.js'));
  } else {
    root.RVQROffload = factory(root.RVQRWorker || null);
  }
})(typeof self !== 'undefined' ? self : this, function (defaultHandlers) {
  'use strict';

  // How long to wait for a worker's hello before writing it off. A worker that
  // has to importScripts five files off a cold cache is slow; a worker that
  // was refused by CSP is silent for ever. Four seconds separates them without
  // making a broken page feel hung — nothing is blocked while we wait, because
  // calls made before `ready` are queued and replayed.
  var DEFAULT_TIMEOUT_MS = 4000;

  var MODE_WORKER = 'worker';
  var MODE_INLINE = 'inline';
  var MODE_PENDING = 'pending';

  /**
   * Detaches an ArrayBuffer so the caller cannot keep using it after handing
   * it over. On the worker path postMessage does this for us; inline there is
   * nothing to hand it to, so we transfer it to a throwaway clone.
   *
   * Returns false where the platform has no structuredClone (older Safari), in
   * which case the buffer survives an inline transfer:true call. That is a
   * one-way divergence — code that respects the documented contract still
   * works — but it is the reason the contract is stated as "treat it as gone"
   * rather than "it will throw if you touch it".
   */
  function detach(buffer) {
    if (typeof structuredClone !== 'function' || !buffer) return false;
    try {
      structuredClone(buffer, { transfer: [buffer] });
      return true;
    } catch (e) {
      return false;
    }
  }

  function bufferOf(value) {
    if (!value) return null;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value;
    if (value.buffer && typeof value.byteLength === 'number') return value.buffer;
    return null;
  }

  function now() {
    if (typeof performance !== 'undefined' && performance && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  function resolveWorkerCtor(opts) {
    if (opts.WorkerCtor) return opts.WorkerCtor;
    if (typeof Worker !== 'undefined') return Worker;
    return null;
  }

  /**
   * Creates an offload client.
   *
   * opts:
   *   workerUrl  — same-origin worker script. Default './worker.js'. A blob:
   *                URL would be portable across directories and is deliberately
   *                not the default: blob: workers are the first casualty of a
   *                CSP without worker-src.
   *   fallback   — 'auto' (default): use a worker if one can be had, inline
   *                otherwise, and switch to inline if a live worker dies.
   *                'never': stay on the worker; failures reject.
   *                'always': never construct a worker at all.
   *   handlers   — the job table for the inline path. Defaults to worker.js.
   *   WorkerCtor — constructor to use instead of the global Worker.
   *   timeoutMs  — hello deadline.
   */
  function create(opts) {
    opts = opts || {};
    var handlers = opts.handlers || defaultHandlers;
    var fallback = opts.fallback || 'auto';
    var timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    var workerUrl = opts.workerUrl || './worker.js';

    var mode = MODE_PENDING;
    var reason = null;
    var capabilities = null;
    var worker = null;
    var pending = Object.create(null);   // id -> { resolve, reject, job, recoverable }
    var queued = [];                     // calls made before the handshake settled
    var nextId = 1;
    var settled = false;
    var timer = null;
    var stats = {
      calls: 0, workerCalls: 0, inlineCalls: 0,
      failures: 0, workerMs: 0, inlineMs: 0
    };

    var readyResolve;
    var ready = new Promise(function (res) { readyResolve = res; });

    function settle(nextMode, why) {
      if (settled) return;
      settled = true;
      mode = nextMode;
      reason = why || null;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      var q = queued;
      queued = [];
      for (var i = 0; i < q.length; i++) dispatch(q[i]);
      readyResolve({ mode: mode, reason: reason, capabilities: capabilities });
    }

    /**
     * Gives up on the worker. Every call still in flight is re-run inline when
     * the fallback allows it — except one that transferred its argument away,
     * whose bytes went with the dead worker and cannot be reconstructed.
     */
    function demote(why) {
      var dying = worker;
      worker = null;
      if (dying) {
        try { dying.terminate(); } catch (e) { /* already gone */ }
      }
      if (!settled) { settle(MODE_INLINE, why); }
      else { mode = MODE_INLINE; reason = why; }

      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        var call = pending[ids[i]];
        delete pending[ids[i]];
        if (fallback === 'never') {
          call.reject(offloadError('worker-lost', why));
        } else if (!call.recoverable) {
          call.reject(offloadError(
            'buffer-lost',
            'the worker died holding a transferred buffer, which cannot be replayed'
          ));
        } else {
          runInline(call);
        }
      }
    }

    function offloadError(code, message) {
      var err = new Error(message || code);
      err.reason = code;
      return err;
    }

    function attach(ctor) {
      var w;
      try {
        w = new ctor(workerUrl);
      } catch (e) {
        return settle(MODE_INLINE, 'worker construction failed: ' +
          (e && e.message ? e.message : String(e)));
      }
      worker = w;

      w.onmessage = function (event) {
        var msg = event && event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.hello !== undefined) {
          if (!handlers || msg.hello === handlers.PROTOCOL) {
            capabilities = msg.capabilities || null;
            settle(MODE_WORKER, null);
          } else {
            demote('worker speaks protocol ' + msg.hello + ', this build speaks ' +
              handlers.PROTOCOL);
          }
          return;
        }
        var call = pending[msg.id];
        if (!call) return;
        delete pending[msg.id];
        stats.workerMs += now() - call.startedAt;
        if (msg.ok) {
          call.resolve(msg.result);
        } else {
          stats.failures++;
          call.reject(offloadError(msg.reason || 'job-failed', msg.message));
        }
      };

      w.onerror = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        var why = event && event.message
          ? 'worker error: ' + event.message
          : 'worker failed to start';
        if (fallback === 'never') {
          if (!settled) settle(MODE_WORKER, why);
          return;
        }
        demote(why);
      };

      w.onmessageerror = function () {
        // A message that would not clone. The job is unrecoverable but the
        // worker is fine, so this does not demote.
        demote('a message could not be deserialised');
      };

      if (timeoutMs > 0) {
        timer = setTimeout(function () {
          timer = null;
          if (!settled) {
            if (fallback === 'never') settle(MODE_WORKER, 'handshake timed out');
            else demote('worker did not answer within ' + timeoutMs + 'ms');
          }
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    }

    function runInline(call) {
      if (!handlers) {
        stats.failures++;
        call.reject(offloadError(
          'no-handlers',
          'no inline job table: load worker.js on the page or pass opts.handlers'
        ));
        return;
      }
      var started = now();
      var out;
      try {
        out = handlers.handle(call.job);
      } catch (e) {
        // handle() is documented never to throw; if it ever does, the promise
        // still has to settle.
        out = { ok: false, reason: 'job-failed', message: e && e.message ? e.message : String(e) };
      }
      stats.inlineCalls++;
      stats.inlineMs += now() - started;
      // Match the worker path's ownership semantics before resolving, so a
      // caller that reads its own buffer afterwards fails the same way here.
      for (var i = 0; i < call.detach.length; i++) detach(call.detach[i]);
      if (out.ok) call.resolve(out.result);
      else { stats.failures++; call.reject(offloadError(out.reason, out.message)); }
    }

    function dispatch(call) {
      if (mode === MODE_WORKER && worker) {
        var id = nextId++;
        call.startedAt = now();
        pending[id] = call;
        stats.workerCalls++;
        try {
          worker.postMessage({ id: id, job: call.job }, call.transfer);
        } catch (e) {
          delete pending[id];
          stats.workerCalls--;
          if (fallback === 'never') {
            stats.failures++;
            call.reject(offloadError('post-failed', e && e.message ? e.message : String(e)));
          } else {
            demote('postMessage failed: ' + (e && e.message ? e.message : String(e)));
            if (call.recoverable) runInline(call);
            else call.reject(offloadError('buffer-lost', 'transferred buffer did not survive'));
          }
        }
        return;
      }
      runInline(call);
    }

    /**
     * Submits one job.
     *
     * transfer  — buffers to hand to the worker. Whatever appears here is
     *             neutered on both paths; see the header.
     */
    function submit(job, transfer) {
      stats.calls++;
      return new Promise(function (resolve, reject) {
        var call = {
          job: job,
          transfer: transfer || [],
          detach: transfer || [],
          // A call that gave its bytes away cannot be replayed on another path.
          recoverable: !transfer || !transfer.length,
          resolve: resolve,
          reject: reject,
          startedAt: 0
        };
        if (!settled) queued.push(call);
        else dispatch(call);
      });
    }

    // --- Public jobs ---------------------------------------------------------

    /**
     * Decodes every QR symbol in an ImageData-shaped object.
     *
     * The pixel buffer is COPIED by default: the caller is usually holding a
     * canvas's ImageData that it is about to reuse for the next camera frame.
     * { transfer: true } is for the case where the caller allocated a fresh
     * buffer for this call and is finished with it.
     */
    function decode(image, options) {
      options = options || {};
      var job = {
        type: 'decode',
        image: { width: image.width, height: image.height, data: image.data },
        all: options.all !== false,
        invert: options.invert === true
      };
      var buf = options.transfer ? bufferOf(image.data) : null;
      return submit(job, buf ? [buf] : []);
    }

    /** SHA-256 as lowercase hex. Copies by default; see decode(). */
    function sha256(bytes, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(bytes) : null;
      return submit({ type: 'sha256', bytes: bytes }, buf ? [buf] : [])
        .then(function (r) { return r.hex; });
    }

    /** The full SHA-256 result, digest bytes included. */
    function sha256Full(bytes, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(bytes) : null;
      return submit({ type: 'sha256', bytes: bytes }, buf ? [buf] : []);
    }

    /** The keyframe gate's 16x16 signature. Copies by default. */
    function signature(image, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(image.data) : null;
      return submit({
        type: 'signature',
        image: { width: image.width, height: image.height, data: image.data },
        size: options.size
      }, buf ? [buf] : []).then(function (r) { return r.signature; });
    }

    /**
     * Opens a fountain encoder. Resolves to a handle carrying { id, K,
     * symbolSize, totalBytes } — hold it and pass it to fountainSymbol.
     * ALWAYS close it: an encoder pins the artifact plus its solved matrix.
     */
    function fountainOpen(bytes, symbolSize, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(bytes) : null;
      return submit({ type: 'fountain.open', bytes: bytes, symbolSize: symbolSize },
        buf ? [buf] : []);
    }

    function sessionId(handle) {
      if (handle && typeof handle === 'object') return handle.id;
      return handle;
    }

    /** One encoding symbol. Resolves to { esi, bytes }. */
    function fountainSymbol(handle, esi) {
      return submit({ type: 'fountain.symbol', id: sessionId(handle), esi: esi });
    }

    /** `count` consecutive symbols from `from`. Resolves to { symbols: [...] }. */
    function fountainSymbols(handle, from, count) {
      return submit({
        type: 'fountain.symbols', id: sessionId(handle), from: from, count: count
      }).then(function (r) { return r.symbols; });
    }

    function fountainDecoder(K, symbolSize, totalBytes) {
      return submit({
        type: 'fountain.decoder', K: K, symbolSize: symbolSize, totalBytes: totalBytes
      });
    }

    /**
     * One decode step. Resolves to { decodable, received, needed }.
     * The symbol bytes are copied by default — they usually came straight out
     * of a frame the caller is still holding.
     */
    function fountainAdd(handle, symbol, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(symbol.bytes) : null;
      return submit({
        type: 'fountain.add', id: sessionId(handle), esi: symbol.esi, bytes: symbol.bytes
      }, buf ? [buf] : []);
    }

    /** The recovered object, or null while the block is still short. */
    function fountainDecode(handle) {
      return submit({ type: 'fountain.decode', id: sessionId(handle) })
        .then(function (r) { return r.bytes; });
    }

    function fountainClose(handle) {
      return submit({ type: 'fountain.close', id: sessionId(handle) });
    }

    /** Segment span plan + hashes for an RVF container. Copies by default. */
    function deltaSpans(bytes, options) {
      options = options || {};
      var buf = options.transfer ? bufferOf(bytes) : null;
      return submit({ type: 'delta.spans', bytes: bytes, hashBytes: options.hashBytes },
        buf ? [buf] : []).then(function (r) { return r.inventory; });
    }

    function terminate() {
      var dying = worker;
      worker = null;
      if (dying) {
        try { dying.terminate(); } catch (e) { /* already gone */ }
      }
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        var call = pending[ids[i]];
        delete pending[ids[i]];
        call.reject(offloadError('terminated', 'offload client was terminated'));
      }
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!settled) settle(MODE_INLINE, 'terminated before the handshake settled');
      mode = MODE_INLINE;
    }

    // --- Bring-up ------------------------------------------------------------

    if (fallback === 'always') {
      settle(MODE_INLINE, 'inline requested');
    } else {
      var ctor = resolveWorkerCtor(opts);
      if (!ctor) settle(MODE_INLINE, 'no Worker constructor in this environment');
      else attach(ctor);
    }

    return {
      ready: ready,
      get mode() { return mode; },
      get reason() { return reason; },
      get capabilities() { return capabilities; },
      stats: function () {
        return {
          mode: mode, reason: reason,
          calls: stats.calls,
          workerCalls: stats.workerCalls, inlineCalls: stats.inlineCalls,
          failures: stats.failures,
          workerMs: stats.workerMs, inlineMs: stats.inlineMs
        };
      },
      submit: submit,
      decode: decode,
      sha256: sha256,
      sha256Full: sha256Full,
      signature: signature,
      fountainOpen: fountainOpen,
      fountainSymbol: fountainSymbol,
      fountainSymbols: fountainSymbols,
      fountainDecoder: fountainDecoder,
      fountainAdd: fountainAdd,
      fountainDecode: fountainDecode,
      fountainClose: fountainClose,
      deltaSpans: deltaSpans,
      terminate: terminate
    };
  }

  return {
    MODE_WORKER: MODE_WORKER,
    MODE_INLINE: MODE_INLINE,
    MODE_PENDING: MODE_PENDING,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    detach: detach,
    create: create
  };
});
