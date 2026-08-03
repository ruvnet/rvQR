/*!
 * rvQR app — vault, optical send, optical receive.
 * All protocol logic lives in core.js; this file is UI, storage and devices.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function () {
  'use strict';

  var core = window.RVQRCore;
  var qrlib = window.RVQRCode;
  var qrdec = window.RVQRDecode;
  var rvflib = window.RVQRRvf;

  // The roadmap modules load with `defer`, so they are not present while app.js
  // is evaluating. Everything reads them through these getters and treats
  // absence as "feature off" rather than as an error — the vault must render
  // whether or not they ever arrive.
  function fountainLib() { return window.RVQRFountain || null; }
  function cryptoLib() { return window.RVQRCrypto || null; }
  function deltaLib() { return window.RVQRDelta || null; }
  function resumeLib() { return window.RVQRResume || null; }

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ---------------------------------------------------------------------------
  // Hashing — crypto.subtle when the browser offers it, otherwise core's SHA-256.
  // ---------------------------------------------------------------------------

  function hashBytes(bytes) {
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      var copy = bytes.slice();
      return window.crypto.subtle.digest('SHA-256', copy.buffer).then(
        function (buf) { return core.toHex(new Uint8Array(buf)); },
        function () { return core.sha256Hex(bytes); }
      );
    }
    return Promise.resolve(core.sha256Hex(bytes));
  }

  // ---------------------------------------------------------------------------
  // Vault (IndexedDB)
  // ---------------------------------------------------------------------------

  var DB_NAME = 'rvqr';
  var STORE = 'artifacts';
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable in this browser context'));
        return;
      }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function vaultList() {
    return tx('readonly', function (store) { return store.getAll(); }).then(function (rows) {
      rows = rows || [];
      rows.sort(function (a, b) { return b.addedAt - a.addedAt; });
      return rows;
    });
  }

  function vaultGet(id) {
    return tx('readonly', function (store) { return store.get(id); });
  }

  function vaultDelete(id) {
    return tx('readwrite', function (store) { return store.delete(id); });
  }

  function vaultPut(record) {
    return tx('readwrite', function (store) { return store.put(record); }).then(function () {
      return record;
    });
  }

  // Single door into the vault, so the name clamp cannot be forgotten at a
  // call site. Names from a received manifest are unauthenticated input.
  function storeArtifact(name, bytes, origin) {
    var safeName = core.sanitizeName(name);
    return hashBytes(bytes).then(function (sha256) {
      var type = core.detectArtifactType(bytes);
      var record = {
        id: sha256 + ':' + safeName,
        name: safeName,
        size: bytes.length,
        sha256: sha256,
        kind: type.kind,
        kindLabel: type.label,
        kindDetail: type.detail,
        origin: origin || 'import',
        addedAt: Date.now(),
        data: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer
      };
      return vaultPut(record);
    });
  }

  function recordBytes(record) {
    return new Uint8Array(record.data);
  }

  // ---------------------------------------------------------------------------
  // Vault rendering
  // ---------------------------------------------------------------------------

  var cachedVault = [];

  function glyphFor(kind) {
    if (kind === 'rvf') return 'RVF';
    if (kind === 'wasm') return 'WASM';
    return 'BIN';
  }

  function renderVault() {
    return vaultList().then(function (rows) {
      cachedVault = rows;
      var list = $('vaultList');
      list.textContent = '';
      $('vaultCount').textContent = rows.length ? '(' + rows.length + ')' : '';
      refreshSendPicker();

      if (!rows.length) {
        var empty = el('div', 'card empty');
        empty.appendChild(el('p', '', 'No artifacts yet.'));
        empty.appendChild(el('p', 'small', 'Import a file, or load the 40 KB demo WASM module to try a transfer.'));
        list.appendChild(empty);
        return rows;
      }

      rows.forEach(function (row) {
        var btn = el('button', 'card artifact');
        var g = el('div', 'glyph ' + row.kind, glyphFor(row.kind));
        var mid = el('div', 'grow');
        var nameLine = el('div', 'name truncate', row.name);
        var meta = el('div', 'small muted truncate');
        meta.textContent = core.formatBytes(row.size) + ' · ' + row.sha256.slice(0, 12) + '…';
        mid.appendChild(nameLine);
        mid.appendChild(meta);
        var badges = el('div', 'badges');
        if (row.origin === 'received') {
          badges.appendChild(el('span', 'badge received', 'received'));
        }
        badges.appendChild(
          el('span', 'badge ' + row.kind, row.kind === 'generic' ? 'file' : row.kind)
        );
        btn.appendChild(g);
        btn.appendChild(mid);
        btn.appendChild(badges);
        btn.addEventListener('click', function () { openDetail(row.id); });
        list.appendChild(btn);
      });
      return rows;
    }).catch(function (err) {
      var list = $('vaultList');
      list.textContent = '';
      var n = el('div', 'card');
      n.appendChild(el('div', 'notice bad', 'Storage unavailable: ' + err.message));
      list.appendChild(n);
    });
  }

  // ---------------------------------------------------------------------------
  // Artifact detail sheet
  // ---------------------------------------------------------------------------

  var dialog = $('detail');

  function showSheet() {
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  function hideSheet() {
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
  }

  function openDetail(id) {
    vaultGet(id).then(function (row) {
      if (!row) return;
      var bytes = recordBytes(row);
      $('detailName').textContent = row.name;
      var body = $('detailBody');
      body.textContent = '';

      var dl = el('dl', 'kv');
      function kv(k, v, cls) {
        dl.appendChild(el('dt', '', k));
        dl.appendChild(el('dd', cls || '', v));
      }
      kv('Type', row.kindLabel);
      kv('Detected because', row.kindDetail, 'small muted');
      kv('Size', core.formatBytes(row.size) + ' (' + row.size.toLocaleString() + ' bytes)');
      kv('SHA-256', row.sha256, 'mono');
      kv('Added', new Date(row.addedAt).toLocaleString() + ' · ' + row.origin, 'small muted');
      kv('First bytes', core.hexPreview(bytes, 32), 'mono');
      body.appendChild(dl);

      if (row.kind === 'rvf') {
        var rvfBox = el('div', 'card tight');
        rvfBox.style.marginTop = '1rem';
        rvfBox.appendChild(el('h3', '', 'Container contents'));
        var rvfStatus = el('p', 'small muted', 'Loading the RVF microkernel\u2026');
        rvfBox.appendChild(rvfStatus);
        body.appendChild(rvfBox);
        renderRvf(rvfBox, rvfStatus, bytes);
      }

      if (row.kind === 'wasm') {
        var wasmBox = el('div', 'card tight');
        wasmBox.style.marginTop = '1rem';
        wasmBox.appendChild(el('h3', '', 'Module inspection'));
        var status = el('p', 'small muted', 'Compiling (no instantiation, no execution)…');
        wasmBox.appendChild(status);
        body.appendChild(wasmBox);
        inspectWasm(bytes).then(function (info) {
          status.textContent =
            info.exports.length + ' exports, ' + info.imports.length + ' imports. ' +
            'Compiled only — the module was never instantiated and no function was called.';
          if (info.exports.length) {
            var pre = el('div', 'mono small');
            pre.style.marginTop = '.5rem';
            pre.style.maxHeight = '160px';
            pre.style.overflowY = 'auto';
            pre.textContent = info.exports
              .map(function (e) { return e.kind + ' ' + e.name; })
              .join('\n');
            wasmBox.appendChild(pre);
          }
        }, function (err) {
          status.textContent = 'Could not compile: ' + err.message;
        });
      }

      var actions = el('div', 'row');
      actions.style.marginTop = '1.2rem';
      var sendBtn = el('button', 'btn-primary grow', 'Send this');
      sendBtn.addEventListener('click', function () {
        hideSheet();
        selectTab('send');
        $('sendPick').value = row.id;
        startSend(row.id);
      });
      var dlBtn = el('button', '', 'Download');
      dlBtn.addEventListener('click', function () { download(row); });
      var delBtn = el('button', 'btn-danger', 'Delete');
      delBtn.addEventListener('click', function () {
        if (!confirm('Delete "' + row.name + '" from this device?')) return;
        vaultDelete(row.id).then(function () {
          hideSheet();
          toast('Deleted');
          renderVault();
        });
      });
      actions.appendChild(sendBtn);
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);
      body.appendChild(actions);

      showSheet();
    });
  }

  // ---------------------------------------------------------------------------
  // RVF container inspection
  //
  // The microkernel is instantiated to parse the container. That is this app
  // loading a tool, not the artifact running: the kernel imports nothing, and
  // the container is data passed to it.
  // ---------------------------------------------------------------------------

  function renderRvf(box, status, bytes) {
    if (!rvflib) {
      status.textContent = 'The RVF binding failed to load.';
      return;
    }
    rvflib.load('./demo/rvf_wasm_bg.wasm').then(function (kernel) {
      var report = rvflib.inspect(kernel, bytes);
      status.textContent = report.header
        ? 'Parsed by the RVF microkernel \u2014 ' + report.segmentCount +
          ' segments, first segment ' + report.header.typeName + '.'
        : 'The kernel could not read a segment header here.';

      if (report.header) {
        var dl = el('dl', 'kv small');
        function kv(k, v) {
          dl.appendChild(el('dt', '', k));
          dl.appendChild(el('dd', '', v));
        }
        kv('Magic', report.header.magicBytes + '  (v1 segment magic)');
        kv('Version', String(report.header.version));
        kv('First segment', report.header.typeName + ' (type ' + report.header.type + ')');
        box.appendChild(dl);
      }

      if (report.segments.length) {
        var wrap = el('div', 'scroll-x');
        wrap.style.marginTop = '.8rem';
        var table = el('table', 'seg');
        var thead = el('tr');
        ['#', 'Type', 'Size', 'Offset', 'CRC32C'].forEach(function (h) {
          thead.appendChild(el('th', '', h));
        });
        table.appendChild(thead);
        report.segments.forEach(function (seg) {
          var tr = el('tr');
          tr.appendChild(el('td', 'num', String(seg.index)));
          tr.appendChild(el('td', '', seg.typeName));
          tr.appendChild(el('td', 'num', core.formatBytes(seg.size)));
          tr.appendChild(el('td', 'num', String(seg.offset)));
          tr.appendChild(el('td', 'mono', seg.crc32c || '\u2014'));
          table.appendChild(tr);
        });
        wrap.appendChild(table);
        box.appendChild(wrap);
      }

      if (report.checks.length) {
        var checks = el('div');
        checks.style.marginTop = '.8rem';
        report.checks.forEach(function (c) {
          var row = el('div', 'check ' + c.status);
          var marks = { pass: '\u2713', warn: '!', fail: '\u2717', unavailable: '\u2013' };
          row.appendChild(el('div', 'mark', marks[c.status] || '\u2013'));
          var b = el('div', 'body');
          b.appendChild(el('strong', '', c.name));
          b.appendChild(el('span', '', c.detail));
          row.appendChild(b);
          checks.appendChild(row);
        });
        box.appendChild(checks);
      }

      if (report.vectors && report.vectors.ok) {
        buildQueryPanel(box, kernel, bytes, report);
      }
      buildInventoryPanel(box, bytes, kernel);
    }, function (err) {
      status.textContent = 'Could not load the RVF microkernel: ' + err.message +
        (window.location.protocol === 'file:'
          ? ' (opening the page over http rather than from disk will fix this)'
          : '');
    });
  }

  /** Live nearest-neighbour search over the vectors in the container. */
  function buildQueryPanel(box, kernel, bytes, report) {
    var vectors = report.vectors;
    var panel = el('div');
    panel.style.marginTop = '1rem';
    panel.appendChild(el('h3', '', 'Search these vectors'));
    panel.appendChild(el('p', 'small muted',
      vectors.count + ' vectors of ' + vectors.dim + ' dimensions. Pick a stored ' +
      'vector as the query, or roll a random one, and rvQR ranks the rest by distance.'));

    var controls = el('div', 'row');
    var metricSel = el('select');
    ['cosine', 'euclidean', 'inner product'].forEach(function (m) {
      var o = el('option', '', m);
      o.value = m;
      metricSel.appendChild(o);
    });
    metricSel.style.flex = '1 1 8rem';
    var randomBtn = el('button', 'btn-sm', 'Random query');
    var storedBtn = el('button', 'btn-sm', 'Use a stored vector');
    controls.appendChild(metricSel);
    controls.appendChild(randomBtn);
    controls.appendChild(storedBtn);
    panel.appendChild(controls);

    var queryLabel = el('p', 'small muted');
    queryLabel.style.margin = '.6rem 0 .2rem';
    panel.appendChild(queryLabel);
    var results = el('div');
    panel.appendChild(results);
    box.appendChild(panel);

    var current = null;
    var currentLabel = '';

    function run() {
      if (!current) return;
      var metric = metricSel.value;
      var ranked = rvflib.queryVectors(vectors, current, 5, metric);
      results.textContent = '';
      queryLabel.textContent = 'Query: ' + currentLabel + ' \u00b7 metric ' + metric;
      if (!ranked.length) {
        results.appendChild(el('p', 'small muted', 'No results.'));
        return;
      }
      var worst = Math.max.apply(null, ranked.map(function (r) { return Math.abs(r.distance); })) || 1;
      ranked.forEach(function (r) {
        var row = el('div', 'rank');
        row.appendChild(el('span', 'id', 'id ' + r.id));
        var bar = el('div', 'bar2');
        var fill = el('i');
        // Nearer means a longer bar, so the eye reads it the right way round.
        fill.style.width = Math.max(3, 100 - (Math.abs(r.distance) / worst) * 92) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', 'd', r.distance.toFixed(4)));
        results.appendChild(row);
      });

      // Show the kernel's own answer too when it disagrees, rather than
      // quietly presenting one engine's numbers as the truth.
      if (report.store && report.store.agrees === false) {
        var note = el('p', 'small muted');
        note.style.marginTop = '.5rem';
        note.textContent = 'Ranking comes from rvQR\u2019s reader. The bundled 0.1.9 ' +
          'kernel reads this container\u2019s vector header transposed, so its own ' +
          'store query returns ids that do not match the file.';
        results.appendChild(note);
      }
    }

    randomBtn.addEventListener('click', function () {
      current = rvflib.randomUnitVector(vectors.dim);
      currentLabel = 'random unit vector';
      run();
    });
    storedBtn.addEventListener('click', function () {
      var i = Math.floor(Math.random() * vectors.count);
      current = vectors.vectors[i];
      currentLabel = 'stored vector id ' + vectors.ids[i];
      run();
    });
    metricSel.addEventListener('change', run);

    // Start with a stored vector: its own id coming back at distance zero is
    // the clearest possible demonstration that the search is real.
    current = vectors.vectors[0];
    currentLabel = 'stored vector id ' + vectors.ids[0];
    run();
  }

  // ---------------------------------------------------------------------------
  // Delta transfer
  //
  // Needs a reverse channel the optical link does not have, so it borrows one:
  // the receiver shows an inventory of what it holds as a QR, and the sender
  // reads that with its own camera. Both devices therefore need a camera for
  // this flow, which is the honest cost of the feature.
  // ---------------------------------------------------------------------------

  function buildInventoryPanel(box, bytes, kernel) {
    var lib = deltaLib();
    if (!lib) return;
    var panel = el('div');
    panel.style.marginTop = '1rem';
    panel.appendChild(el('h3', '', 'Update from another device'));
    panel.appendChild(el('p', 'small muted',
      'Show this code to a device holding a newer copy. It works out which ' +
      'segments you are missing and sends only those.'));
    var btn = el('button', 'btn-sm', 'Show my inventory');
    panel.appendChild(btn);
    var out = el('div');
    out.style.marginTop = '.7rem';
    panel.appendChild(out);
    box.appendChild(panel);

    btn.addEventListener('click', function () {
      out.textContent = '';
      try {
        var parser = kernel && lib.wasmParser ? lib.wasmParser(kernel.exports) : undefined;
        var inv = lib.inventory(bytes, parser ? { parser: parser } : undefined);
        var qrData = lib.inventoryQr(inv);
        var chunks = qrData.chunks && qrData.chunks.length ? qrData.chunks : [qrData.text];
        out.appendChild(el('p', 'small muted',
          qrData.bytes + ' bytes of inventory' +
          (chunks.length > 1 ? ' across ' + chunks.length + ' codes — scan them all' : '') + '.'));
        chunks.forEach(function (text, idx) {
          var holder = el('div');
          holder.style.background = '#fff';
          holder.style.padding = '8px';
          holder.style.borderRadius = '10px';
          holder.style.marginTop = '.5rem';
          var canvas = document.createElement('canvas');
          canvas.style.width = '100%';
          canvas.style.maxWidth = '300px';
          canvas.style.display = 'block';
          canvas.style.imageRendering = 'pixelated';
          holder.appendChild(canvas);
          out.appendChild(holder);
          var qr = qrlib.encodeText(text, { ecl: 'L' });
          qrlib.drawOnCanvas(qr, canvas, { size: 600 });
          out.appendChild(el('p', 'small muted',
            (chunks.length > 1 ? 'part ' + (idx + 1) + ' of ' + chunks.length + ' · ' : '') +
            'QR version ' + qr.version));
        });
      } catch (e) {
        out.appendChild(el('div', 'notice bad', 'Could not build an inventory: ' + e.message));
      }
    });
  }

  function runDeltaDiff() {
    var lib = deltaLib();
    var box = $('deltaResult');
    box.textContent = '';
    if (!lib) {
      box.appendChild(el('div', 'notice bad', 'The delta module did not load.'));
      return;
    }
    if (!send.record) {
      box.appendChild(el('div', 'notice', 'Choose the artifact you want to send first.'));
      return;
    }
    var text = $('deltaInventory').value.trim();
    if (!text) {
      box.appendChild(el('div', 'notice', 'Paste or scan their inventory first.'));
      return;
    }
    try {
      var receiverInv = lib.decodeInventory(text);
      var mine = lib.inventory(recordBytes(send.record));
      var d = lib.diff(mine, receiverInv);
      var saved = d.bytesSaved || 0;
      var ratio = d.ratio || (d.bytesToSend ? send.record.size / d.bytesToSend : 0);

      var n = el('div', 'notice good');
      n.appendChild(el('strong', '',
        core.formatBytes(d.bytesToSend) + ' instead of ' + core.formatBytes(send.record.size) + '. '));
      n.appendChild(document.createTextNode(
        (d.missing ? d.missing.length : 0) + ' segments to send, ' +
        core.formatBytes(saved) + ' saved' +
        (ratio ? ' — ' + ratio.toFixed(1) + '× less data' : '') + '.'
      ));
      box.appendChild(n);

      var go = el('button', 'btn-primary', 'Send just those segments');
      go.style.marginTop = '.6rem';
      go.addEventListener('click', function () {
        try {
          var payload = lib.buildDeltaPayload(recordBytes(send.record), d.missing, { base: receiverInv });
          startSend(null, payload, send.record.name + '.delta');
          toast('Sending a ' + core.formatBytes(payload.length) + ' delta');
        } catch (e) {
          toast('Could not build the delta: ' + e.message);
        }
      });
      box.appendChild(go);
    } catch (e) {
      box.appendChild(el('div', 'notice bad', 'That does not look like an inventory: ' + e.message));
    }
  }

  // Compile-only: WebAssembly.compile validates and reads the module's shape.
  // It never runs code — instantiation is what would run a start function.
  function inspectWasm(bytes) {
    if (!window.WebAssembly || !WebAssembly.compile) {
      return Promise.reject(new Error('WebAssembly unavailable'));
    }
    return WebAssembly.compile(bytes.slice().buffer).then(function (mod) {
      return {
        exports: WebAssembly.Module.exports(mod),
        imports: WebAssembly.Module.imports(mod)
      };
    });
  }

  function download(row) {
    var blob = new Blob([recordBytes(row)], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = row.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ---------------------------------------------------------------------------
  // Import paths
  // ---------------------------------------------------------------------------

  function importFiles(files) {
    var queue = Array.prototype.slice.call(files);
    if (!queue.length) return;
    var done = 0;
    queue.reduce(function (chain, file) {
      return chain.then(function () {
        return file.arrayBuffer().then(function (buf) {
          return storeArtifact(file.name, new Uint8Array(buf), 'import');
        }).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      toast(done === 1 ? 'Imported 1 artifact' : 'Imported ' + done + ' artifacts');
      renderVault();
    }).catch(function (err) {
      toast('Import failed: ' + err.message);
    });
  }

  function loadDemo(file) {
    return fetch('./demo/' + file)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        return storeArtifact(file, new Uint8Array(buf), 'demo');
      })
      .then(function (record) {
        toast('Loaded ' + file);
        return renderVault().then(function () { return record; });
      })
      .catch(function (err) {
        toast('Could not load demo: ' + err.message);
        var list = $('vaultList');
        var n = el('div', 'card');
        n.appendChild(el('div', 'notice',
          'Loading the bundled demo needs the page to be served over http (GitHub Pages or any local server). ' +
          'Opened straight from disk, browsers block reading the neighbouring file. Import any file instead.'));
        list.insertBefore(n, list.firstChild);
      });
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  var send = {
    record: null,
    frames: [],
    index: 0,
    playing: false,
    timer: null,
    fps: 5,
    chunk: core.DEFAULT_CHUNK,
    ecl: 'L',
    mode: core.MODE_INDEXED,
    stream: null,   // the erasure-coded symbol source, when in that mode
    esi: 0,         // next encoding symbol id to emit
    sign: false,
    identity: null
  };

  function refreshSendPicker() {
    var pick = $('sendPick');
    var current = pick.value;
    pick.textContent = '';
    if (!cachedVault.length) {
      var opt = el('option', '', 'No artifacts in the vault yet');
      opt.value = '';
      pick.appendChild(opt);
      $('sendStageCard').hidden = true;
      stopSend();
      return;
    }
    var placeholder = el('option', '', 'Choose an artifact…');
    placeholder.value = '';
    pick.appendChild(placeholder);
    cachedVault.forEach(function (row) {
      var o = el('option', '', row.name + ' · ' + core.formatBytes(row.size));
      o.value = row.id;
      pick.appendChild(o);
    });
    if (current) pick.value = current;
  }

  function stopSend() {
    send.playing = false;
    clearInterval(send.timer);
    send.timer = null;
  }

  function startSend(id, overrideBytes, overrideName) {
    stopSend();
    return vaultGet(id).then(function (row) {
      if (!row && !overrideBytes) return;
      send.record = row || null;
      var bytes = overrideBytes || recordBytes(row);
      var name = overrideName || (row ? row.name : 'artifact.bin');
      var hash = overrideBytes ? core.sha256Hex(bytes) : row.sha256;

      return signIfRequested({ name: name, size: bytes.length, sha256: hash })
        .then(function (signature) {
          if (send.mode === core.MODE_FOUNTAIN && fountainLib()) {
            var encoder = fountainLib().encoder(bytes, send.chunk);
            send.stream = core.buildFountainStream(encoder, {
              name: name, sha256: hash, size: bytes.length
            });
            if (signature) send.stream.manifest = withSignature(send.stream.manifest, signature);
            send.frames = null;
            send.esi = 0;
            send.index = 0;
            $('scrub').max = '0';
            $('sendStageCard').hidden = false;
            $('sendMeta').textContent =
              name + ' · ' + core.formatBytes(bytes.length) + ' · erasure-coded, K=' +
              encoder.K + ' · ' + encoder.symbolSize + ' B/symbol · transfer ' +
              send.stream.transferId + (signature ? ' · signed' : '');
            drawFrame(0);
            play(true);
            return;
          }

          send.stream = null;
          var built = core.buildFrames(bytes, { name: name, chunk: send.chunk, sha256: hash });
          if (signature) built.frames[0] = withSignature(built.frames[0], signature);
          send.frames = built.frames;
          send.index = 0;
          $('scrub').max = String(built.frames.length - 1);
          $('scrub').value = '0';
          $('sendStageCard').hidden = false;
          $('sendMeta').textContent =
            name + ' · ' + core.formatBytes(bytes.length) + ' · ' + built.chunk +
            ' B/frame · transfer ' + built.transferId + (signature ? ' · signed' : '');
          drawFrame(0);
          play(true);
        });
    });
  }

  function withSignature(manifestFrame, signature) {
    var obj = JSON.parse(manifestFrame);
    obj.m.sig = signature.sig;
    obj.m.pub = signature.pub;
    return JSON.stringify(obj);
  }

  function drawFrame(i) {
    var text;
    if (send.stream) {
      // An erasure-coded stream has no end: frame 0 is the manifest and every
      // subsequent tick emits the next encoding symbol, for ever. The receiver
      // stops when it has enough, which the sender never learns.
      send.index = Math.max(0, i);
      if (send.index === 0) {
        text = send.stream.manifest;
      } else {
        text = send.stream.symbolFrame(send.esi++);
      }
    } else {
      if (!send.frames || !send.frames.length) return;
      send.index = ((i % send.frames.length) + send.frames.length) % send.frames.length;
      text = send.frames[send.index];
    }
    var qr;
    try {
      qr = qrlib.encodeText(text, { ecl: send.ecl });
    } catch (e) {
      toast('Frame too large for one QR symbol — lower the chunk size');
      stopSend();
      return;
    }
    qrlib.drawOnCanvas(qr, $('qrCanvas'), { size: 640, quietZone: 4 });

    var circumference = 2 * Math.PI * 33;
    if (send.stream) {
      var emitted = send.esi;
      var k = send.stream.K;
      $('sendFrameLabel').textContent =
        'symbol ' + emitted + '  ·  K = ' + k + '  ·  QR version ' + qr.version;
      // The ring shows progress towards K, then simply keeps going: past K
      // every extra symbol is insurance, not progress.
      var frac = Math.min(1, emitted / k);
      $('ringFill').setAttribute('stroke-dasharray',
        (circumference * frac).toFixed(1) + ' ' + circumference.toFixed(1));
      $('ringText').textContent = emitted <= k ? Math.round(frac * 100) + '%' : '+' + (emitted - k);
      return;
    }
    var total = send.frames.length;
    var shown = send.index + 1;
    $('sendFrameLabel').textContent =
      'frame ' + shown + ' / ' + total + '  ·  QR version ' + qr.version;
    var pct = Math.round((shown / total) * 100);
    $('ringFill').setAttribute(
      'stroke-dasharray',
      (circumference * shown / total).toFixed(1) + ' ' + circumference.toFixed(1)
    );
    $('ringText').textContent = pct + '%';
    $('scrub').value = String(send.index);
  }

  function play(on) {
    stopSend();
    send.playing = on;
    $('playBtn').textContent = on ? 'Pause' : 'Play';
    if (!on) return;
    send.timer = setInterval(function () {
      drawFrame(send.index + 1);
    }, Math.round(1000 / send.fps));
  }

  // ---------------------------------------------------------------------------
  // Receive
  // ---------------------------------------------------------------------------

  var rx = {
    gate: core.createFrameGate(),
    verification: null,
    pin: null,
    resume: null,
    pending: [],
    state: core.createReceiver(),
    stream: null,
    detector: null,
    running: false,
    lastText: null,
    finalizing: false
  };

  // Two decoding engines. The native one is faster and better tested, so it
  // wins when present; the bundled decoder means "no BarcodeDetector" is no
  // longer the same as "cannot scan".
  function nativeScannerAvailable() {
    return typeof window.BarcodeDetector !== 'undefined';
  }
  function scannerKind() {
    if (nativeScannerAvailable()) return 'native';
    return qrdec ? 'fallback' : 'none';
  }
  function isFramed() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true; // cross-origin frame: even asking throws
    }
  }
  // A cross-origin frame must be granted camera access explicitly by its host
  // page. Without allow="camera" the request is refused no matter what the
  // user does, so it is worth saying that plainly instead of blaming them.
  function cameraBlockedByFrame() {
    if (!isFramed()) return false;
    try {
      if (document.featurePolicy && document.featurePolicy.allowsFeature) {
        return !document.featurePolicy.allowsFeature('camera');
      }
    } catch (e) { /* fall through */ }
    return true;
  }

  function renderCapabilityNotice() {
    var box = $('capabilityNotice');
    box.textContent = '';
    var kind = scannerKind();

    if (cameraBlockedByFrame()) {
      var f = el('div', 'notice');
      f.appendChild(el('strong', '', 'This page is embedded in a frame that does not grant camera access. '));
      f.appendChild(document.createTextNode(
        'That is a decision made by the surrounding page, not by rvQR or by you, ' +
        'and no permission prompt can override it. Open rvQR directly to scan — '
      ));
      var link = el('a', '', 'open in its own tab');
      link.href = window.location.href;
      link.target = '_blank';
      link.rel = 'noopener';
      f.appendChild(link);
      f.appendChild(document.createTextNode(
        ' — or use the picture and paste options below, which work anywhere.'
      ));
      box.appendChild(f);
    }

    if (kind === 'none') {
      var n = el('div', 'notice bad');
      n.appendChild(el('strong', '', 'No decoder available. '));
      n.appendChild(document.createTextNode('The bundled decoder failed to load.'));
      box.appendChild(n);
      $('scanBtn').disabled = true;
    }

    $('scannerNote').textContent = kind === 'native'
      ? 'Scanning with this browser\u2019s native barcode reader.'
      : kind === 'fallback'
        ? 'This browser has no native barcode reader, so rvQR is using its own decoder. ' +
          'It reads the smaller symbols comfortably; on the densest frames, hold steady ' +
          'or ask the sender to drop the chunk size to 256 bytes.'
        : '';
  }

  function resetReceiver() {
    rx.state = core.createReceiver();
    rx.gate = core.createFrameGate();
    rx.verification = null;
    rx.pending = [];
    rx.finalizing = false;
    rx.lastText = null;
    $('rxCard').hidden = true;
    $('rxResult').textContent = '';
    $('rxGrid').textContent = '';
    $('rxBar').style.width = '0%';
    $('rxTitle').textContent = 'Waiting for frames…';
    $('rxMeta').textContent = '—';
  }

  function startCamera() {
    if (rx.running) { stopCamera(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera unavailable in this context');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (stream) {
      rx.stream = stream;
      var v = $('video');
      v.srcObject = stream;
      $('scanCard').hidden = false;
      $('rxCard').hidden = false;
      $('scanBtn').textContent = 'Stop camera';
      rx.running = true;
      rx.detector = nativeScannerAvailable()
        ? new window.BarcodeDetector({ formats: ['qr_code'] })
        : null;
      return v.play().catch(function () { /* autoplay policies */ });
    }).then(function () {
      scanLoop();
    }).catch(function (err) {
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' && isFramed()) {
        toast('The surrounding page blocks camera access — use a picture instead');
      } else if (name === 'NotAllowedError') {
        toast('Camera permission denied');
      } else if (name === 'NotFoundError') {
        toast('No camera on this device — use a picture instead');
      } else {
        toast('Camera error: ' + (err && err.message ? err.message : name));
      }
      renderCapabilityNotice();
    });
  }

  function stopCamera() {
    rx.running = false;
    if (rx.stream) {
      rx.stream.getTracks().forEach(function (t) { t.stop(); });
      rx.stream = null;
    }
    $('scanCard').hidden = true;
    $('scanBtn').textContent = 'Start camera';
  }

  var grabCanvas = null;

  /** Pulls the current video frame out as ImageData for the bundled decoder. */
  function grabFrame(video) {
    if (!grabCanvas) grabCanvas = document.createElement('canvas');
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    // Downscale very large frames: the decoder does not need 4K, and the
    // scan loop has to keep up with the camera.
    var maxSide = 1024;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    grabCanvas.width = Math.round(w * scale);
    grabCanvas.height = Math.round(h * scale);
    var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, grabCanvas.width, grabCanvas.height);
    return ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
  }

  function scanLoop() {
    if (!rx.running) return;
    var v = $('video');
    if (v.readyState < 2) {
      requestAnimationFrame(scanLoop);
      return;
    }
    if (rx.detector) {
      rx.detector.detect(v).then(function (codes) {
        for (var i = 0; i < codes.length; i++) feedFrame(codes[i].rawValue);
      }).catch(function () { /* transient detector errors are normal */ })
        .then(function () { requestAnimationFrame(scanLoop); });
      return;
    }
    // Fallback decoder: synchronous and heavier, so yield between frames
    // rather than pinning the main thread — and skip frames that cannot pay
    // for themselves. The gate is applied only on this path: the native
    // detector is cheap and handles motion better than a gate would, so
    // throttling it would cost frames for no saving.
    try {
      var image = grabFrame(v);
      if (image) {
        var decision = core.gateFrame(rx.gate, core.frameSignature(image));
        if (decision.decode) {
          var results = qrdec.decodeImage(image, { all: true, invert: false });
          for (var r = 0; r < results.length; r++) feedFrame(results[r].text);
        }
        rx.gateStats = rx.gate;
      }
    } catch (e) { /* keep scanning */ }
    setTimeout(function () { requestAnimationFrame(scanLoop); }, 60);
  }

  // ---------------------------------------------------------------------------
  // Decoding frames out of a still picture
  // ---------------------------------------------------------------------------

  /** Decodes every QR in one image file and resolves with their texts. */
  function decodeImageToText(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var texts = [];
        try {
          if (!grabCanvas) grabCanvas = document.createElement('canvas');
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          grabCanvas.width = Math.round(img.width * scale);
          grabCanvas.height = Math.round(img.height * scale);
          var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, grabCanvas.width, grabCanvas.height);
          var data = ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
          texts = qrdec.decodeImage(data, { all: true }).map(function (r) { return r.text; });
        } catch (e) { /* resolve with what we have */ }
        URL.revokeObjectURL(url);
        resolve(texts);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve([]); };
      img.src = url;
    });
  }

  function renderModeNote() {
    var note = $('modeNote');
    if (send.mode === core.MODE_FOUNTAIN) {
      note.textContent = fountainLib()
        ? 'The sender emits encoding symbols for ever; the receiver stops as soon as any K of them have landed, whichever ones those were. A dropped frame costs one extra symbol instead of a whole loop.'
        : 'The erasure-coding module has not loaded, so this send will use indexed frames.';
    } else {
      note.textContent = 'Numbered chunks, looped until the receiver has them all. A missed frame waits for the next pass.';
    }
  }

  function renderSignNote() {
    var note = $('signNote');
    if (!send.sign) {
      note.textContent = 'Unsigned. The receiver can verify the bytes arrived intact, but not who sent them.';
      return;
    }
    if (!cryptoLib()) {
      note.textContent = 'The crypto module has not loaded, so this transfer cannot be signed.';
      return;
    }
    ensureIdentity().then(function (identity) {
      note.textContent = identity
        ? 'Signing with this device\u2019s key. Read the fingerprint to the other person out loud so they can pin it: ' + identity.fingerprint
        : 'A signing key could not be created on this device.';
    });
  }

  function decodeImageFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var box = $('imageResult');
    box.textContent = '';
    box.appendChild(el('div', 'notice', 'Reading ' + list.length + ' image' +
      (list.length === 1 ? '' : 's') + '\u2026'));

    var totalFound = 0, totalAccepted = 0, processed = 0;
    list.forEach(function (file) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          if (!grabCanvas) grabCanvas = document.createElement('canvas');
          // Big photos get scaled down, but not so far that modules vanish.
          var maxSide = 1600;
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          grabCanvas.width = Math.round(img.width * scale);
          grabCanvas.height = Math.round(img.height * scale);
          var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, grabCanvas.width, grabCanvas.height);
          var data = ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
          var results = qrdec.decodeImage(data, { all: true });
          totalFound += results.length;
          for (var i = 0; i < results.length; i++) {
            rx.lastText = null; // a still image may legitimately repeat a frame
            var before = rx.state.received;
            feedFrame(results[i].text);
            if (rx.state.received > before) totalAccepted++;
          }
        } catch (e) { /* report below */ }
        URL.revokeObjectURL(url);
        if (++processed === list.length) reportImageDecode(totalFound, totalAccepted);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        if (++processed === list.length) reportImageDecode(totalFound, totalAccepted);
      };
      img.src = url;
    });
  }

  function reportImageDecode(found, accepted) {
    var box = $('imageResult');
    box.textContent = '';
    if (!found) {
      box.appendChild(el('div', 'notice bad',
        'No QR codes found. Fill more of the picture with the code, keep it in ' +
        'focus, and avoid glare across the screen.'));
      return;
    }
    box.appendChild(el('div', 'notice good',
      'Read ' + found + ' code' + (found === 1 ? '' : 's') + ', ' + accepted +
      ' new frame' + (accepted === 1 ? '' : 's') + ' accepted.'));
    $('rxCard').hidden = false;
  }

  function feedFrame(text) {
    if (rx.finalizing) return;
    if (text === rx.lastText) return; // cheap guard against re-reading one frame
    rx.lastText = text;
    var before = rx.state.status;
    var beforeManifest = rx.state.manifest;
    core.ingest(rx.state, text, Date.now());

    // The manifest is what says whether this is an erasure-coded transfer, so
    // the decoder is attached the moment one arrives — before any symbol can
    // need it, because symbols are replayed from state on attach below.
    if (!beforeManifest && rx.state.manifest && rx.state.mode === core.MODE_FOUNTAIN) {
      attachFountainDecoder();
    }
    if (rx.state.manifest && !rx.verification) verifyManifestSignature();
    recordFrameForResume(text);
    if (rx.state.status !== 'IDLE') $('rxCard').hidden = false;
    if (before === 'IDLE' && rx.state.status === 'COLLECTING') {
      toast('Transfer ' + rx.state.transferId + ' detected');
    }
    renderReceiveProgress();
    if (core.isComplete(rx.state)) finishReceive();
  }

  // Attaches the erasure decoder and replays any symbols that arrived before
  // the manifest did — frames can turn up in any order, including this one.
  function attachFountainDecoder() {
    var lib = fountainLib();
    var m = rx.state.manifest;
    if (!lib || !m || rx.state.codec) return;
    try {
      var decoder = lib.decoder(m.k, m.symbolSize, m.k * m.symbolSize);
      core.useCodec(rx.state, decoder);
      var seqs = core.receivedSequences(rx.state);
      for (var i = 0; i < seqs.length; i++) {
        var payload = rx.state.chunks[seqs[i]];
        if (payload) rx.state.decodable = decoder.add({ esi: seqs[i], bytes: payload }) === true;
      }
    } catch (e) {
      toast('Could not start the erasure decoder: ' + e.message);
    }
  }

  // --- signatures ------------------------------------------------------------

  function verifyManifestSignature() {
    var lib = cryptoLib();
    var m = rx.state.manifest;
    if (!m) return;
    if (!m.sig || !m.pub) {
      rx.verification = { state: 'unsigned' };
      renderVerification();
      return;
    }
    if (!lib) {
      rx.verification = { state: 'unsigned', note: 'signature present but the crypto module did not load' };
      renderVerification();
      return;
    }
    Promise.resolve()
      .then(function () {
        return lib.verifyManifest(
          { name: m.name, size: m.size, sha256: m.sha256 },
          m.sig, m.pub
        );
      })
      .then(function (ok) {
        var fp = lib.fingerprint(m.pub);
        if (!ok) {
          rx.verification = { state: 'bad', fingerprint: fp };
        } else if (rx.pin) {
          rx.verification = {
            state: lib.fingerprintEqual(fp, rx.pin) ? 'pinned' : 'wrong-key',
            fingerprint: fp
          };
        } else {
          rx.verification = { state: 'signed', fingerprint: fp };
        }
        renderVerification();
      })
      .catch(function () {
        rx.verification = { state: 'bad' };
        renderVerification();
      });
  }

  // Three outcomes, none of which may be mistaken for another. A signature
  // from an unpinned key proves only that one key signed it — not that it is
  // the key you wanted — so it must never read like a pass.
  var VERIFY_COPY = {
    unsigned: ['warn', 'Unsigned', 'The manifest carries no signature. The hash proves the bytes are intact; nothing proves who sent them.'],
    signed: ['warn', 'Signed, but by an unknown key', 'A signature checks out, but you have not pinned this fingerprint, so it only shows that some key signed the transfer. Compare the fingerprint out of band and pin it.'],
    pinned: ['pass', 'Signed by the key you pinned', 'The signature matches the fingerprint you pinned.'],
    'wrong-key': ['fail', 'Signed by a DIFFERENT key', 'A valid signature, but not from the fingerprint you pinned. Treat this transfer as hostile until you know why.'],
    bad: ['fail', 'Signature does not verify', 'The manifest claims a signature that does not check out against the key it names.']
  };

  function renderVerification() {
    var box = $('pinState');
    if (!box) return;
    var v = rx.verification;
    if (!v) { box.textContent = ''; return; }
    var copy = VERIFY_COPY[v.state] || VERIFY_COPY.unsigned;
    box.textContent = '';
    var row = el('div', 'check ' + copy[0]);
    var marks = { pass: '\u2713', warn: '!', fail: '\u2717' };
    row.appendChild(el('div', 'mark', marks[copy[0]] || '!'));
    var body = el('div', 'body');
    body.appendChild(el('strong', '', copy[1]));
    body.appendChild(el('span', '', copy[2] + (v.fingerprint ? ' Fingerprint: ' + v.fingerprint : '')));
    row.appendChild(body);
    box.appendChild(row);
  }

  function signIfRequested(manifestFields) {
    var lib = cryptoLib();
    if (!send.sign || !lib) return Promise.resolve(null);
    return ensureIdentity().then(function (identity) {
      if (!identity) return null;
      return Promise.resolve(lib.signManifest(manifestFields, identity.secret))
        .then(function (sig) {
          return { sig: typeof sig === 'string' ? sig : lib.b64uEncode(sig), pub: identity.pubEncoded };
        });
    }).catch(function () { return null; });
  }

  // One key per browser, kept in local storage. This is a demonstration of the
  // mechanism, not a key management system: anything that can read the page's
  // storage can read this key.
  var IDENTITY_KEY = 'rvqr.identity.v1';
  function ensureIdentity() {
    var lib = cryptoLib();
    if (!lib) return Promise.resolve(null);
    if (send.identity) return Promise.resolve(send.identity);
    var store = safeStorage();
    var saved = null;
    try { saved = store && store.getItem(IDENTITY_KEY); } catch (e) { saved = null; }
    if (saved) {
      try {
        var parsed = JSON.parse(saved);
        send.identity = parsed;
        return Promise.resolve(parsed);
      } catch (e) { /* regenerate below */ }
    }
    return Promise.resolve(lib.generateKeyPair()).then(function (kp) {
      var secret = kp.secretKey || kp.secret || kp.privateKey;
      var pub = kp.publicKey || kp.pub;
      var identity = {
        secret: typeof secret === 'string' ? secret : lib.toHex(secret),
        pubEncoded: typeof pub === 'string' ? pub : lib.toHex(pub)
      };
      identity.fingerprint = lib.fingerprint(identity.pubEncoded);
      send.identity = identity;
      try { if (store) store.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* ephemeral */ }
      return identity;
    }).catch(function () { return null; });
  }

  // --- resume ----------------------------------------------------------------

  var RESUME_BATCH = 20; // the module's author measured 1290us/frame unbatched vs 63us at 20

  function resumeStore() {
    var lib = resumeLib();
    if (!lib || !window.indexedDB) return Promise.resolve(null);
    if (rx.resume) return Promise.resolve(rx.resume);
    return Promise.resolve(lib.open({ factory: window.indexedDB }))
      .then(function (store) { rx.resume = store; return store; })
      .catch(function () { return null; });
  }

  function recordFrameForResume(text) {
    if (!resumeLib() || !rx.state.manifest) return;
    rx.pending.push(text);
    if (rx.pending.length < RESUME_BATCH && !core.isComplete(rx.state)) return;
    var batch = rx.pending.splice(0, rx.pending.length);
    resumeStore().then(function (store) {
      if (!store || !store.recordFrame) return;
      // One transaction for the batch: per-frame writes cost ~20x more, and a
      // camera delivers frames far faster than IndexedDB likes to commit.
      return store.recordFrame(rx.state, batch);
    }).catch(function () { /* resume is a convenience, never a blocker */ });
  }

  function offerResume() {
    if (!resumeLib()) return;
    resumeStore().then(function (store) {
      if (!store || !store.listResumable) return null;
      return store.listResumable();
    }).then(function (list) {
      var box = $('resumeBanner');
      if (!box || !list || !list.length) return;
      box.textContent = '';
      var n = el('div', 'notice');
      n.appendChild(el('strong', '', list.length === 1
        ? '1 transfer in progress. '
        : list.length + ' transfers in progress. '));
      n.appendChild(document.createTextNode(
        'Frames you already scanned are still here — pick up where you left off.'
      ));
      box.appendChild(n);
      var row = el('div', 'row');
      row.style.marginTop = '.6rem';
      list.slice(0, 3).forEach(function (entry) {
        var label = (entry.name || 'transfer') + ' · ' +
          (entry.received || 0) + ' frames';
        var b = el('button', 'btn-sm', 'Continue ' + label);
        b.addEventListener('click', function () { resumeTransfer(entry); });
        row.appendChild(b);
      });
      box.appendChild(row);
    }).catch(function () { /* nothing to offer */ });
  }

  function resumeTransfer(entry) {
    resumeStore().then(function (store) {
      if (!store || !store.restore) return;
      return store.restore(entry.id || entry.transferId);
    }).then(function (state) {
      if (!state) { toast('That transfer could not be restored'); return; }
      rx.state = state;
      rx.finalizing = false;
      rx.lastText = null;
      if (state.mode === core.MODE_FOUNTAIN) attachFountainDecoder();
      $('rxCard').hidden = false;
      $('resumeBanner').textContent = '';
      renderReceiveProgress();
      toast('Resumed at ' + (state.received || 0) + ' frames');
      if (core.isComplete(rx.state)) finishReceive();
    }).catch(function (err) {
      toast('Could not resume: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  function renderReceiveProgress() {
    var s = rx.state;
    if (!s.total) return;
    if (s.mode === core.MODE_FOUNTAIN) {
      var k = s.needed || (s.manifest ? s.manifest.k : 0);
      var got = s.symbols;
      var fpct = k ? Math.min(100, Math.round((got / k) * 100)) : 0;
      $('rxBar').style.width = fpct + '%';
      $('rxTitle').textContent = (s.manifest ? core.sanitizeName(s.manifest.name) + ' — ' : '') +
        got + ' / ' + k + ' symbols';
      $('rxMeta').textContent = 'erasure-coded · any ' + k + ' symbols rebuild it · ' +
        s.duplicates + ' duplicates · ' + s.rejected + ' rejected' +
        (s.manifest ? ' · ' + core.formatBytes(s.manifest.size) : '');
      $('rxGrid').textContent = '';
      return;
    }
    var need = s.total - 1;
    var have = s.received;
    var pct = need ? Math.round((have / need) * 100) : 100;
    $('rxBar').style.width = pct + '%';
    $('rxTitle').textContent = s.manifest
      ? core.sanitizeName(s.manifest.name) + ' — ' + pct + '%'
      : 'Collecting frames — ' + pct + '% (waiting for the manifest)';
    $('rxMeta').textContent =
      have + ' / ' + need + ' data frames · ' + s.duplicates + ' duplicates · ' +
      s.rejected + ' rejected' +
      (s.manifest ? ' · ' + core.formatBytes(s.manifest.size) : '');

    // The cell count comes from gridPlan, never straight from s.total: the
    // frame count is attacker-controlled and must not be able to drive how
    // many DOM nodes this builds. Past the cap each cell stands for a run of
    // frames and lights up once that whole run has landed.
    var plan = core.gridPlan(s.total);
    var grid = $('rxGrid');
    if (grid.childElementCount !== plan.cells) {
      grid.textContent = '';
      for (var i = 0; i < plan.cells; i++) grid.appendChild(el('i'));
    }
    if (!plan.cells) return;

    var counts = new Uint32Array(plan.cells);
    for (var key in s.chunks) {
      var idx = core.cellForSequence(plan, Number(key));
      if (idx >= 0) counts[idx]++;
    }
    for (var c = 0; c < plan.cells; c++) {
      var first = c * plan.framesPerCell + 1;
      var span = Math.min(plan.framesPerCell, need - (first - 1));
      var full = span > 0 && counts[c] >= span;
      var cell = grid.children[c];
      if (full !== cell.classList.contains('have')) cell.classList.toggle('have', full);
    }
    if (plan.bucketed) {
      $('rxMeta').textContent += ' · grid shows ' + plan.framesPerCell + ' frames per cell';
    }
  }

  function finishReceive() {
    if (rx.finalizing) return;
    rx.finalizing = true;
    var s = rx.state;
    var bytes;
    try {
      bytes = core.assemble(s);
    } catch (e) {
      showReceiveResult(false, 'Reassembly failed: ' + e.message);
      return;
    }
    hashBytes(bytes).then(function (digest) {
      if (digest !== s.manifest.sha256) {
        s.status = 'REJECTED';
        showReceiveResult(false,
          'Hash mismatch — the whole transfer was discarded. Expected ' +
          s.manifest.sha256.slice(0, 16) + '…, got ' + digest.slice(0, 16) + '…');
        return;
      }
      s.status = 'VERIFIED';
      return storeArtifact(s.manifest.name, bytes, 'received').then(function () {
        stopCamera();
        showReceiveResult(true,
          'Verified and stored: ' + s.manifest.name + ' (' + core.formatBytes(bytes.length) +
          '). SHA-256 matches the manifest. Nothing was executed.');
        renderVault();
      });
    }).catch(function (err) {
      showReceiveResult(false, 'Failed to store: ' + err.message);
    });
  }

  function showReceiveResult(ok, msg) {
    var box = $('rxResult');
    box.textContent = '';
    var n = el('div', 'notice ' + (ok ? 'good' : 'bad'), msg);
    box.appendChild(n);
    if (ok) {
      var go = el('button', 'btn-sm', 'Open vault');
      go.style.marginTop = '.6rem';
      go.addEventListener('click', function () { selectTab('vault'); });
      box.appendChild(go);
    }
    renderReceiveProgress();
  }

  // ---------------------------------------------------------------------------
  // Welcome
  //
  // Shown once, re-openable from About, and never on the critical path: the
  // vault renders and the app is usable whether or not this ever appears.
  // ---------------------------------------------------------------------------

  var welcomeDialog = $('welcome');
  var welcomeReturnFocus = null;
  var stage = null;

  function safeStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null; // private mode, or an embedded frame denying storage
    }
  }

  function openWelcome(opener) {
    welcomeReturnFocus = opener || null;
    welcomeDialog.classList.add('enter');
    if (welcomeDialog.showModal) welcomeDialog.showModal();
    else welcomeDialog.setAttribute('open', '');
    startStage();
    // Focus the primary action, not the dialog, so Enter does the useful thing.
    var primary = $('welcomeStart');
    if (primary && primary.focus) primary.focus();
  }

  function closeWelcome() {
    // Native dialogs fire 'close' for every dismissal route — button, Escape,
    // backdrop — so the bookkeeping lives in that one handler. Only the
    // no-showModal fallback has to do it here.
    if (welcomeDialog.close && welcomeDialog.open) {
      welcomeDialog.close();
      return;
    }
    stopStage();
    core.markWelcomeSeen(safeStorage());
    welcomeDialog.removeAttribute('open');
    if (welcomeReturnFocus && welcomeReturnFocus.focus) welcomeReturnFocus.focus();
    welcomeReturnFocus = null;
  }

  // ---------------------------------------------------------------------------
  // Welcome animation
  //
  // The subject is its own illustration: frames leaving a screen, crossing a
  // gap, and filling a receiver's grid. It is decorative, so it yields to
  // everything — a reduced-motion preference renders one composed still frame
  // instead, and it stops entirely whenever the dialog is not on screen.
  // ---------------------------------------------------------------------------


  function stageColors() {
    var css = getComputedStyle(document.documentElement);
    var read = function (name, fallback) {
      var v = css.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    return {
      accent: read('--accent', '#2dd4bf'),
      line: read('--line', '#24303f'),
      muted: read('--muted', '#8b9bb0'),
      surface: read('--surface', '#121821')
    };
  }

  // A fixed pseudo-random matrix with finder-like corners: unmistakably a QR
  // code at a glance without pretending to be a scannable one.
  function stageMatrix(n) {
    var cells = [];
    var seed = 0x5eed;
    for (var y = 0; y < n; y++) {
      var row = [];
      for (var x = 0; x < n; x++) {
        var corner = (x < 3 && y < 3) || (x >= n - 3 && y < 3) || (x < 3 && y >= n - 3);
        if (corner) {
          var lx = x >= n - 3 ? n - 1 - x : x;
          var ly = y >= n - 3 ? n - 1 - y : y;
          row.push(lx === 1 && ly === 1 ? 0 : 1);
        } else {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          row.push((seed >>> 17) & 1);
        }
      }
      cells.push(row);
    }
    return cells;
  }

  function createStage(canvas) {
    return {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      matrix: stageMatrix(9),
      n: 9,
      model: core.createStageModel(),
      raf: 0,
      running: false
    };
  }

  function stageGeometry(st) {
    var w = st.canvas.width, h = st.canvas.height;
    var pad = Math.round(h * 0.12);
    var side = h - pad * 2;
    return {
      w: w, h: h, pad: pad, side: side,
      senderX: pad, senderY: pad,
      recvX: w - pad - side, recvY: pad,
      travel: (w - pad - side) - (pad + side)
    };
  }

  function drawStage(st) {
    var m = st.model;
    var ctx = st.ctx, c = stageColors(), g = stageGeometry(st);
    if (!ctx || g.side <= 0) return; // nothing sensible to draw into
    ctx.clearRect(0, 0, g.w, g.h);

    // Sender: the QR matrix.
    var cell = g.side / st.n;
    ctx.fillStyle = c.accent;
    for (var y = 0; y < st.n; y++) {
      for (var x = 0; x < st.n; x++) {
        if (!st.matrix[y][x]) continue;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(
          g.senderX + x * cell + 0.5, g.senderY + y * cell + 0.5,
          Math.ceil(cell) - 1, Math.ceil(cell) - 1
        );
      }
    }
    ctx.globalAlpha = 1;

    // The gap the data crosses.
    ctx.strokeStyle = c.line;
    ctx.lineWidth = Math.max(1, g.h * 0.008);
    ctx.setLineDash([g.h * 0.03, g.h * 0.05]);
    ctx.beginPath();
    ctx.moveTo(g.senderX + g.side + g.pad * 0.6, g.h / 2);
    ctx.lineTo(g.recvX - g.pad * 0.6, g.h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Receiver: a grid that fills as frames land.
    var cols = 4, rows = 3;
    var rcw = g.side / cols, rch = g.side / rows;
    for (var i = 0; i < m.cells; i++) {
      var cx = g.recvX + (i % cols) * rcw;
      var cy = g.recvY + Math.floor(i / cols) * rch;
      var filled = i < m.landed;
      ctx.fillStyle = filled ? c.accent : c.line;
      ctx.globalAlpha = filled ? 0.9 : 0.5;
      roundRect(ctx, cx + 1.5, cy + 1.5, rcw - 3, rch - 3, Math.min(rcw, rch) * 0.18);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Frames in flight.
    var size = Math.max(6, g.side * 0.2);
    for (var p = 0; p < m.packets.length; p++) {
      var pk = m.packets[p];
      var px = g.senderX + g.side + pk.progress * g.travel;
      var py = g.h / 2 - size / 2 + Math.sin(pk.progress * Math.PI) * (pk.drift * g.h * 0.06);
      ctx.globalAlpha = pk.progress > 0.9 ? (1 - pk.progress) * 10 : 1;
      ctx.fillStyle = c.accent;
      roundRect(ctx, px, py, size, size, size * 0.22);
      ctx.fill();
      // A couple of dark notches so it reads as a frame, not a dot.
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = c.surface;
      ctx.fillRect(px + size * 0.18, py + size * 0.18, size * 0.22, size * 0.22);
      ctx.fillRect(px + size * 0.6, py + size * 0.6, size * 0.22, size * 0.22);
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (!(w > 0) || !(h > 0)) return; // arcTo throws on degenerate boxes
    var rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function startStage() {
    var canvas = $('welcomeStage');
    if (!canvas || !canvas.getContext) return;
    if (!stage) stage = createStage(canvas);

    // Whatever happens next, paint something correct first. A decorative loop
    // that fails to start must degrade to a still picture, never to a blank
    // panel — the panel has to carry its meaning on its own.
    stage.model = core.stageStillModel(core.createStageModel());
    safeDraw();

    var reduced = core.prefersReducedMotion(
      window.matchMedia ? window.matchMedia.bind(window) : null
    );
    if (reduced) return; // the still above is the whole story

    stopStage();
    stage.model = core.createStageModel();
    stage.running = true;

    var tick = function (now) {
      if (!stage.running) return;
      // Re-check the world every frame rather than trusting a flag set once:
      // the dialog can be closed by routes this loop never hears about.
      var env = {
        open: !!welcomeDialog.open,
        visible: !document.hidden,
        reduced: false
      };
      if (!env.open) { stopStage(); return; }
      stage.raf = requestAnimationFrame(tick);
      var step = core.stageAdvance(stage.model, now, env);
      if (step.draw) safeDraw();
    };
    stage.raf = requestAnimationFrame(tick);
  }

  // A decorative animation must never become a source of console noise or a
  // half-painted panel: one failure stops the loop and leaves the still.
  function safeDraw() {
    try {
      drawStage(stage);
    } catch (e) {
      stopStage();
      try {
        stage.model = core.stageStillModel(core.createStageModel());
        drawStage(stage);
      } catch (e2) { /* nothing further to try */ }
    }
  }

  function stopStage() {
    if (!stage) return;
    stage.running = false;
    if (stage.raf) cancelAnimationFrame(stage.raf);
    stage.raf = 0;
  }

  // ---------------------------------------------------------------------------
  // Tabs and wiring
  // ---------------------------------------------------------------------------

  var TABS = ['vault', 'send', 'receive', 'guide', 'about'];

  function selectTab(name) {
    TABS.forEach(function (t) {
      $('tab-' + t).hidden = t !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabbar button'), function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    });
    if (name !== 'send') play(false);
    if (name !== 'receive') stopCamera();
    window.scrollTo(0, 0);
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabbar button'), function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.tab); });
    });

    $('importBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $('demoRvfBtn').addEventListener('click', function () { loadDemo('ruvnet-demo.rvf'); });
    $('demoWasmBtn').addEventListener('click', function () { loadDemo('rvf_wasm_bg.wasm'); });

    $('imageBtn').addEventListener('click', function () { $('imageInput').click(); });
    $('imageInput').addEventListener('change', function (e) {
      decodeImageFiles(e.target.files);
      e.target.value = '';
    });
    $('imageDrop').addEventListener('drop', function (e) {
      // Handled here as well as globally so a dropped picture on the Receive
      // tab is decoded rather than imported into the vault.
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) decodeImageFiles(e.dataTransfer.files);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.goto); });
    });
    $('refreshBtn').addEventListener('click', function () { renderVault(); });
    $('detailClose').addEventListener('click', hideSheet);

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && e.relatedTarget) return;
        document.body.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', function (e) {
      if (e.defaultPrevented) return; // the Receive drop zone already took it
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        selectTab('vault');
        importFiles(e.dataTransfer.files);
      }
    });

    $('sendPick').addEventListener('change', function (e) {
      if (e.target.value) startSend(e.target.value);
      else { stopSend(); $('sendStageCard').hidden = true; }
    });
    $('playBtn').addEventListener('click', function () { play(!send.playing); });
    $('restartBtn').addEventListener('click', function () { drawFrame(0); play(true); });
    $('scrub').addEventListener('input', function (e) {
      play(false);
      drawFrame(Number(e.target.value));
    });
    $('chunkRange').addEventListener('input', function (e) {
      send.chunk = Number(e.target.value);
      $('chunkLabel').textContent = String(send.chunk);
    });
    $('chunkRange').addEventListener('change', function () {
      if (send.record) startSend(send.record.id);
    });
    $('fpsRange').addEventListener('input', function (e) {
      send.fps = Number(e.target.value);
      $('fpsLabel').textContent = String(send.fps);
      if (send.playing) play(true);
    });
    $('eclPick').addEventListener('change', function (e) {
      send.ecl = e.target.value;
      drawFrame(send.index);
    });

    // --- transfer mode ---
    $('modePick').addEventListener('change', function (e) {
      send.mode = e.target.value === 'fountain' ? core.MODE_FOUNTAIN : core.MODE_INDEXED;
      renderModeNote();
      if (send.record) startSend(send.record.id);
    });
    $('signSend').addEventListener('change', function (e) {
      send.sign = !!e.target.checked;
      renderSignNote();
      if (send.record) startSend(send.record.id);
    });

    // --- delta ---
    $('deltaDiffBtn').addEventListener('click', runDeltaDiff);
    $('deltaImageBtn').addEventListener('click', function () { $('deltaImageInput').click(); });
    $('deltaImageInput').addEventListener('change', function (e) {
      var files = e.target.files;
      e.target.value = '';
      if (!files || !files.length || !qrdec) return;
      decodeImageToText(files[0]).then(function (texts) {
        if (!texts.length) { toast('No code found in that picture'); return; }
        $('deltaInventory').value = texts.join('\n');
        toast('Read ' + texts.length + ' code' + (texts.length === 1 ? '' : 's'));
        runDeltaDiff();
      });
    });

    // --- signature pinning ---
    $('pinSet').addEventListener('click', function () {
      var v = $('pinInput').value.trim();
      if (!v) { toast('Enter a fingerprint first'); return; }
      rx.pin = v;
      toast('Pinned ' + v);
      if (rx.state.manifest) { rx.verification = null; verifyManifestSignature(); }
    });
    $('pinClear').addEventListener('click', function () {
      rx.pin = null;
      $('pinInput').value = '';
      if (rx.state.manifest) { rx.verification = null; verifyManifestSignature(); }
      else { rx.verification = null; renderVerification(); }
      toast('Pin cleared');
    });

    $('scanBtn').addEventListener('click', startCamera);
    $('resetRxBtn').addEventListener('click', function () {
      resetReceiver();
      toast('Receiver reset');
    });
    $('manualBtn').addEventListener('click', function () {
      var lines = $('manualFrames').value.split('\n');
      var fed = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        rx.lastText = null;
        feedFrame(line);
        fed++;
      }
      $('rxCard').hidden = false;
      toast('Fed ' + fed + ' frame' + (fed === 1 ? '' : 's'));
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { play(false); stopStage(); }
      else if (welcomeDialog.open) startStage();
    });

    // --- welcome ---
    $('welcomeStart').addEventListener('click', function () {
      closeWelcome();
      // The primary action does something: load the demo and land the user on
      // Send, ready to go. A first-run modal whose only outcome is vanishing
      // has wasted the one moment it had.
      loadDemo('ruvnet-demo.rvf').then(function (record) {
        selectTab('send');
        if (record && record.id) {
          $('sendPick').value = record.id;
          startSend(record.id);
        }
      });
    });
    $('welcomeClose').addEventListener('click', closeWelcome);
    $('showWelcome').addEventListener('click', function (e) { openWelcome(e.currentTarget); });
    // Escape and the backdrop both route through the dialog's own close event,
    // so dismissal is recorded however it happened.
    welcomeDialog.addEventListener('close', function () {
      stopStage();
      core.markWelcomeSeen(safeStorage());
      if (welcomeReturnFocus && welcomeReturnFocus.focus) welcomeReturnFocus.focus();
      welcomeReturnFocus = null;
    });
    welcomeDialog.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || welcomeDialog.showModal) return;
      // Manual focus trap only for browsers without showModal, which traps
      // focus natively.
      var focusable = welcomeDialog.querySelectorAll('button, [href], input, select, textarea');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    welcomeDialog.addEventListener('cancel', function () { stopStage(); });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  wire();
  renderCapabilityNotice();
  resetReceiver();
  // Deliberately after the vault render resolves: the welcome is an
  // enhancement, and the app must be usable whether or not it ever appears.
  if (core.shouldShowWelcome(safeStorage())) {
    setTimeout(function () { openWelcome(null); }, 0);
  }

  // The optional modules arrive after this script runs, so the notes that
  // describe them are filled in once the document is ready rather than now.
  window.addEventListener('load', function () {
    renderModeNote();
    renderSignNote();
    offerResume();
    if (!fountainLib()) $('modePick').disabled = true;
    if (!cryptoLib()) $('signSend').disabled = true;
    if (!deltaLib()) $('deltaSendCard').hidden = true;
  });

  renderVault().then(function () {
    var kind = scannerKind();
    $('statusChip').textContent = kind === 'native'
      ? 'alpha \u00b7 native scan'
      : kind === 'fallback' ? 'alpha \u00b7 built-in scan' : 'alpha \u00b7 send only';
  });
})();
