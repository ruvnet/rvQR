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

  function loadDemo() {
    fetch('./demo/rvf_wasm_bg.wasm')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        return storeArtifact('rvf_wasm_bg.wasm', new Uint8Array(buf), 'demo');
      })
      .then(function () {
        toast('Demo artifact loaded');
        renderVault();
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
    state: core.createReceiver(),
    stream: null,
    detector: null,
    running: false,
    lastText: null,
    finalizing: false
  };

  function barcodeSupported() {
    return typeof window.BarcodeDetector !== 'undefined';
  }

  function renderCapabilityNotice() {
    var box = $('capabilityNotice');
    box.textContent = '';
    if (barcodeSupported()) return;
    var n = el('div', 'notice');
    n.appendChild(el('strong', '', 'This browser cannot scan. '));
    n.appendChild(document.createTextNode('rvQR uses the native '));
    n.appendChild(el('code', '', 'BarcodeDetector'));
    n.appendChild(document.createTextNode(
      ' API rather than bundling a megabyte of decoder. It is available in ' +
      'Chrome and Edge on Android and desktop, and in Safari 17 and later. ' +
      'You can still send from this device, or paste frames by hand below.'
    ));
    box.appendChild(n);
    $('scanBtn').disabled = true;
  }

  function resetReceiver() {
    rx.state = core.createReceiver();
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
      rx.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      return v.play().catch(function () { /* autoplay policies */ });
    }).then(function () {
      scanLoop();
    }).catch(function (err) {
      toast('Camera error: ' + err.message);
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

  function scanLoop() {
    if (!rx.running) return;
    var v = $('video');
    if (v.readyState >= 2) {
      rx.detector.detect(v).then(function (codes) {
        for (var i = 0; i < codes.length; i++) feedFrame(codes[i].rawValue);
      }).catch(function () { /* transient detector errors are normal */ })
        .then(function () { requestAnimationFrame(scanLoop); });
    } else {
      requestAnimationFrame(scanLoop);
    }
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
  // Tabs and wiring
  // ---------------------------------------------------------------------------

  var TABS = ['vault', 'send', 'receive', 'about'];

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
    $('demoBtn').addEventListener('click', loadDemo);
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
      if (document.hidden) { play(false); }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  wire();
  renderCapabilityNotice();
  resetReceiver();
  renderVault().then(function () {
    $('statusChip').textContent = barcodeSupported() ? 'alpha · scan ready' : 'alpha · send only';
  });
})();
