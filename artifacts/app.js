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
    ecl: 'L'
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

  function startSend(id) {
    stopSend();
    vaultGet(id).then(function (row) {
      if (!row) return;
      send.record = row;
      var bytes = recordBytes(row);
      var built = core.buildFrames(bytes, {
        name: row.name,
        chunk: send.chunk,
        sha256: row.sha256
      });
      send.frames = built.frames;
      send.index = 0;
      $('scrub').max = String(built.frames.length - 1);
      $('scrub').value = '0';
      $('sendStageCard').hidden = false;
      $('sendMeta').textContent =
        row.name + ' · ' + core.formatBytes(row.size) + ' · ' + built.chunk +
        ' B/frame · transfer ' + built.transferId;
      drawFrame(0);
      play(true);
    });
  }

  function drawFrame(i) {
    if (!send.frames.length) return;
    send.index = ((i % send.frames.length) + send.frames.length) % send.frames.length;
    var text = send.frames[send.index];
    var qr;
    try {
      qr = qrlib.encodeText(text, { ecl: send.ecl });
    } catch (e) {
      toast('Frame too large for one QR symbol — lower the chunk size');
      stopSend();
      return;
    }
    qrlib.drawOnCanvas(qr, $('qrCanvas'), { size: 640, quietZone: 4 });

    var total = send.frames.length;
    var shown = send.index + 1;
    $('sendFrameLabel').textContent =
      'frame ' + shown + ' / ' + total + '  ·  QR version ' + qr.version;
    var pct = Math.round((shown / total) * 100);
    var circumference = 2 * Math.PI * 33;
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
    core.ingest(rx.state, text, Date.now());
    if (rx.state.status !== 'IDLE') $('rxCard').hidden = false;
    if (before === 'IDLE' && rx.state.status === 'COLLECTING') {
      toast('Transfer ' + rx.state.transferId + ' detected');
    }
    renderReceiveProgress();
    if (core.isComplete(rx.state)) finishReceive();
  }

  function renderReceiveProgress() {
    var s = rx.state;
    if (!s.total) return;
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

  renderVault().then(function () {
    var kind = scannerKind();
    $('statusChip').textContent = kind === 'native'
      ? 'alpha \u00b7 native scan'
      : kind === 'fallback' ? 'alpha \u00b7 built-in scan' : 'alpha \u00b7 send only';
  });
})();
