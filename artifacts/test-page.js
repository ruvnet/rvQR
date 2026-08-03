/*!
 * rvQR test page driver — runs the shared suite in the browser and renders it.
 * Kept out of test.html so the page can carry the same strict CSP as the app.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function () {
  'use strict';
  var core = window.RVQRCore, qrlib = window.RVQRCode;
  var qrdec = window.RVQRDecode, rvflib = window.RVQRRvf;
  var results = window.RVQRTests.runAll(core, qrlib, qrdec);
  var sum = window.RVQRTests.summarize(results);

  var list = document.getElementById('results');

  function addRow(r) {
    var li = document.createElement('li');
    var tag = document.createElement('span');
    tag.className = 'tag ' + (r.ok ? 'ok' : 'bad');
    tag.textContent = r.ok ? 'PASS' : 'FAIL';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    if (r.detail) {
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = r.detail;
      name.appendChild(d);
    }
    li.appendChild(tag);
    li.appendChild(name);
    list.appendChild(li);
  }

  function setSummary(all) {
    var s2 = window.RVQRTests.summarize(all);
    var el = document.getElementById('summary');
    el.textContent = s2.passed + ' / ' + s2.total + ' passed' +
      (s2.failed ? ' — ' + s2.failed + ' FAILED' : '');
    el.className = 'summary ' + (s2.failed ? 'fail' : 'pass');
  }

  // The RVF suite needs the microkernel and the demo container, so it runs
  // after the synchronous tests and appends its rows when it lands.
  if (rvflib) {
    Promise.all([
      fetch('./demo/rvf_wasm_bg.wasm').then(function (r) { return r.arrayBuffer(); }),
      fetch('./demo/ruvnet-demo.rvf').then(function (r) { return r.arrayBuffer(); })
    ]).then(function (buffers) {
      return window.RVQRTests.runRvfTests(
        rvflib, new Uint8Array(buffers[0]), new Uint8Array(buffers[1])
      );
    }).then(function (extra) {
      extra.forEach(addRow);
      setSummary(results.concat(extra));
    }, function (err) {
      addRow({
        name: 'RVF suite',
        ok: false,
        detail: 'could not load the demo files (' + err.message +
          '). Serving the page over http rather than from disk will fix this.'
      });
      setSummary(results.concat([{ ok: false }]));
    });
  }

  results.forEach(function (r) {
    var li = document.createElement('li');
    var tag = document.createElement('span');
    tag.className = 'tag ' + (r.ok ? 'ok' : 'bad');
    tag.textContent = r.ok ? 'PASS' : 'FAIL';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    if (r.detail) {
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = r.detail;
      name.appendChild(d);
    }
    li.appendChild(tag);
    li.appendChild(name);
    list.appendChild(li);
  });

  var s = document.getElementById('summary');
  s.textContent = sum.passed + ' / ' + sum.total + ' passed' +
    (sum.failed ? ' — ' + sum.failed + ' FAILED' : '');
  s.className = 'summary ' + (sum.failed ? 'fail' : 'pass');

  // Scannable proof: a plain string and a genuine protocol frame.
  var hello = qrlib.encodeText('HELLO RVQR', { ecl: 'M' });
  qrlib.drawOnCanvas(hello, document.getElementById('qrHello'), { size: 520 });
  document.getElementById('helloMeta').textContent =
    'version ' + hello.version + ' · level M · mask ' + hello.mask + ' · ' +
    hello.size + '×' + hello.size + ' modules';

  var demoBytes = new Uint8Array(1500);
  for (var i = 0; i < demoBytes.length; i++) demoBytes[i] = (i * 7 + 11) & 0xff;
  var built = core.buildFrames(demoBytes, { name: 'selftest.bin', chunk: 512 });
  var frameQr = qrlib.encodeText(built.frames[0], { ecl: 'L' });
  qrlib.drawOnCanvas(frameQr, document.getElementById('qrFrame'), { size: 520 });
  document.getElementById('frameMeta').textContent =
    'manifest frame · ' + built.frames[0].length + ' bytes of text · version ' +
    frameQr.version + ' · level L';

  // Full send/receive round trip, reported live.
  var rx = core.createReceiver();
  built.frames.slice().reverse().forEach(function (f) { core.ingest(rx, f); });
  var res = core.finalize(rx);
  document.getElementById('roundtripNote').textContent = res.ok
    ? built.total + ' frames sent in reverse order, reassembled and verified — SHA-256 ' +
      res.sha256.slice(0, 24) + '…'
    : 'ROUND TRIP FAILED: ' + res.reason;
})();
