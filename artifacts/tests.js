/*!
 * rvQR test suite — one set of assertions, two runners.
 *
 * Browser: open artifacts/test.html — renders the results as a pass/fail table.
 * Node:    runAll(core, qrlib) returns [{ name, ok, detail }]; see the Testing
 *          section of the README for the one-liner that runs it.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    // Run directly: `node artifacts/tests.js`. Without this the documented
    // simple command is a silent no-op, which is worse than no command at all.
    if (typeof require === 'function' && require.main === module) {
      var core = require('./core.js');
      var qrlib = require('./vendor/qrcode.js');
      var qrdec = require('./vendor/qrdecode.js');
      var rvflib = require('./rvf.js');
      var fs = require('fs');
      var path = require('path');
      var print = function (r) {
        console.log(
          (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')
        );
      };
      var mods = {};
      try { mods.fountain = require('./fountain.js'); } catch (e) { /* optional */ }
      try { mods.proto2 = require('./proto2.js'); } catch (e) { /* optional */ }
      try { mods.provenance = require('./provenance.js'); } catch (e) { /* optional */ }
      try { mods.delta = require('./delta.js'); } catch (e) { /* optional */ }
      try { mods.crypto = require('./crypto.js'); } catch (e) { /* optional */ }
      try { mods.semdelta = require('./semdelta.js'); } catch (e) { /* optional */ }
      try { mods.planner = require('./planner.js'); } catch (e) { /* optional */ }
      try { mods.compress = require('./compress.js'); } catch (e) { /* optional */ }
      // The attestation panel is asserted against the REAL verifier and the
      // REAL gate. The one thing that is injected is `verifyChain`, which
      // attest.js takes by injection precisely because no root of trust exists
      // here — the app supplies none, so the attested rendering is reachable
      // from a test and from nowhere else, and a test says exactly that.
      try { mods.attest = require('./attest.js'); } catch (e) { /* optional */ }
      // The compression panel is asserted against REAL codec output, not a
      // stub: compress.js takes its codecs by injection precisely so a caller
      // can hand it the platform's own, and node:zlib is this runner's. A
      // browser has none of these — see the platform tests, which assert what
      // the panel says when it has only CompressionStream, or nothing at all.
      try { mods.zlib = require('node:zlib'); } catch (e) { /* optional */ }
      // app.js exports its provenance view model and nothing else outside a
      // browser: the UI half of that file returns early without a document.
      try { mods.view = require('./app.js'); } catch (e) { /* optional */ }
      // The page itself, so the tests can assert that the module is actually
      // loaded rather than merely present on disk. An unreferenced module is
      // dead code, and the standalone build derives its script list from here.
      try { mods.indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); } catch (e) { /* optional */ }
      // The artifact the app's own demo button loads, so the compression panel
      // is asserted against the bytes an operator will actually put through it
      // rather than against a fixture invented to compress well. Optional: the
      // suite falls back to a deterministic structured blob without it.
      try {
        mods.demoWasm = new Uint8Array(fs.readFileSync(path.join(__dirname, 'demo', 'rvf_wasm_bg.wasm')));
      } catch (e) { /* optional */ }
      var results = api.runAll(core, qrlib, qrdec, mods);
      results.forEach(print);

      var kernelPath = path.join(__dirname, 'demo', 'rvf_wasm_bg.wasm');
      var containerPath = path.join(__dirname, 'demo', 'ruvnet-demo.rvf');
      var finish = function (extra) {
        (extra || []).forEach(print);
        var all = results.concat(extra || []);
        var summary = api.summarize(all);
        console.log(
          '\n' + summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed'
        );
        if (typeof process !== 'undefined') process.exit(summary.failed ? 1 : 0);
      };
      // The sealed-inventory tests need a real handshake, so they are
      // asynchronous like the RVF suite and land in the same summary.
      var async = api.runDeltaChoiceTests(core, mods).then(null, function (err) {
        return [{ name: 'delta choice suite', ok: false, detail: String(err) }];
      });
      if (fs.existsSync(kernelPath) && fs.existsSync(containerPath)) {
        async = async.then(function (rows) {
          return api.runRvfTests(
            rvflib,
            new Uint8Array(fs.readFileSync(kernelPath)),
            new Uint8Array(fs.readFileSync(containerPath))
          ).then(function (more) { return rows.concat(more); },
            function (err) { return rows.concat([{ name: 'RVF suite', ok: false, detail: String(err) }]); });
        });
      }
      async.then(finish, function (err) {
        finish([{ name: 'async suites', ok: false, detail: String(err) }]);
      });
    }
  } else {
    root.RVQRTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runAll(core, qrlib, qrdec, mods) {
    mods = mods || {};
    var results = [];
    function test(name, fn) {
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || '' });
      } catch (e) {
        results.push({ name: name, ok: false, detail: e && e.message ? e.message : String(e) });
      }
    }
    function assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }
    function assertEqual(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
      }
    }
    function bytesEqual(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    // Deterministic pseudo-random bytes so failures are reproducible.
    var seed = 0x2f6e2b1;
    function rndBytes(n) {
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (seed >>> 16) & 0xff;
      }
      return out;
    }
    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        var j = (seed >>> 8) % (i + 1);
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    // -- base64url -----------------------------------------------------------

    test('base64url roundtrips every length 0..260', function () {
      for (var n = 0; n <= 260; n++) {
        var bytes = rndBytes(n);
        var back = core.b64uDecode(core.b64uEncode(bytes));
        assert(bytesEqual(bytes, back), 'roundtrip failed at length ' + n);
      }
      return '261 lengths';
    });

    test('base64url uses the url-safe alphabet and no padding', function () {
      var enc = core.b64uEncode(new Uint8Array([251, 255, 190, 255, 255]));
      assert(!/[+/=]/.test(enc), 'found +, / or = in ' + enc);
      assert(/^[A-Za-z0-9_-]+$/.test(enc), 'unexpected characters in ' + enc);
      return enc;
    });

    test('base64url rejects malformed input', function () {
      var threw = 0;
      try { core.b64uDecode('A'); } catch (e) { threw++; }
      try { core.b64uDecode('AB*D'); } catch (e) { threw++; }
      assertEqual(threw, 2, 'expected two rejections');
      return 'bad length + bad character';
    });

    // -- SHA-256 -------------------------------------------------------------

    test('SHA-256 matches published test vectors', function () {
      var enc = function (s) {
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
      };
      assertEqual(
        core.sha256Hex(new Uint8Array(0)),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'empty string'
      );
      assertEqual(
        core.sha256Hex(enc('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'abc'
      );
      assertEqual(
        core.sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        '448-bit message'
      );
      // Crosses the 64-byte block boundary and the length-padding edge.
      var long = new Uint8Array(1000);
      for (var i = 0; i < 1000; i++) long[i] = 0x61;
      assertEqual(core.sha256Hex(long).length, 64, 'hex length');
      return '3 vectors + boundary case';
    });

    // -- artifact type detection --------------------------------------------

    test('detects WASM, RVF segment, RVF root manifest, and generic files', function () {
      var wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9, 9]);
      assertEqual(core.detectArtifactType(wasm).kind, 'wasm', 'wasm magic');

      var rvfSeg = new Uint8Array(64);
      rvfSeg.set([0x53, 0x46, 0x56, 0x52], 0);
      assertEqual(core.detectArtifactType(rvfSeg).kind, 'rvf', 'segment magic');

      // Root manifest lives in the tail 4096-byte region.
      var rvfRoot = new Uint8Array(9000);
      rvfRoot.set([0x30, 0x4d, 0x56, 0x52], 9000 - 4096);
      assertEqual(core.detectArtifactType(rvfRoot).kind, 'rvf', 'root magic in tail');

      // The same magic sitting outside the tail region must NOT be claimed.
      var notRvf = new Uint8Array(9000);
      notRvf.set([0x30, 0x4d, 0x56, 0x52], 100);
      assertEqual(core.detectArtifactType(notRvf).kind, 'generic', 'magic outside tail');

      assertEqual(core.detectArtifactType(new Uint8Array([1, 2, 3])).kind, 'generic', 'generic');
      return '5 cases';
    });

    // -- frame roundtrip -----------------------------------------------------

    test('chunk -> frame -> parse roundtrip preserves every byte', function () {
      var bytes = rndBytes(5000);
      var built = core.buildFrames(bytes, { name: 'round.bin', chunk: 512, transferId: 'deadbeef' });
      assertEqual(built.total, core.frameCount(5000, 512), 'frame count');
      assertEqual(built.frames.length, built.total, 'frames array length');

      var m = core.parseFrame(built.frames[0]);
      assert(m.ok, 'manifest parse failed: ' + m.reason);
      assertEqual(m.frame.kind, 'manifest', 'frame 0 kind');
      assertEqual(m.frame.m.size, 5000, 'manifest size');
      assertEqual(m.frame.m.sha256, core.sha256Hex(bytes), 'manifest hash');
      assertEqual(m.frame.h, m.frame.m.sha256.slice(0, 8), 'hash prefix');

      var offset = 0;
      for (var i = 1; i < built.total; i++) {
        var p = core.parseFrame(built.frames[i]);
        assert(p.ok, 'frame ' + i + ' parse failed: ' + p.reason);
        assertEqual(p.frame.i, i, 'sequence');
        assertEqual(p.frame.t, 'deadbeef', 'transfer id');
        var expect = bytes.subarray(offset, Math.min(offset + 512, bytes.length));
        assert(bytesEqual(p.frame.payload, expect), 'payload mismatch at frame ' + i);
        offset += p.frame.payload.length;
      }
      assertEqual(offset, 5000, 'covered bytes');
      return built.total + ' frames';
    });

    test('frame text stays inside the QR byte budget', function () {
      var bytes = rndBytes(4096);
      var built = core.buildFrames(bytes, { name: 'budget-check-artifact-name.wasm', chunk: 512 });
      var max = 0;
      for (var i = 0; i < built.frames.length; i++) {
        max = Math.max(max, built.frames[i].length);
      }
      // 512-byte chunks must still fit a version well under the 40 ceiling.
      assert(max < 900, 'frame text unexpectedly large: ' + max);
      return 'largest frame ' + max + ' bytes';
    });

    // -- reassembly ----------------------------------------------------------

    function transfer(bytes, opts) {
      return core.buildFrames(bytes, opts || { name: 'x.bin', chunk: 512, transferId: 'a1b2c3d4' });
    }

    test('in-order reassembly verifies against the manifest hash', function () {
      var bytes = rndBytes(4000);
      var built = transfer(bytes);
      var rx = core.createReceiver();
      for (var i = 0; i < built.frames.length; i++) core.ingest(rx, built.frames[i]);
      assertEqual(rx.status, 'COMPLETE', 'status after all frames');
      var res = core.finalize(rx);
      assert(res.ok, 'finalize rejected: ' + res.reason);
      assert(bytesEqual(res.bytes, bytes), 'bytes differ');
      assertEqual(rx.status, 'VERIFIED', 'status after finalize');
      return built.total + ' frames verified';
    });

    test('out-of-order arrival reassembles correctly (manifest last)', function () {
      var bytes = rndBytes(7777);
      var built = transfer(bytes, { name: 'shuffled.bin', chunk: 400, transferId: '0badc0de' });
      var order = shuffle(built.frames.map(function (_, i) { return i; }));
      // Force the manifest to arrive dead last, the worst case for a receiver.
      order = order.filter(function (i) { return i !== 0; }).concat([0]);
      var rx = core.createReceiver();
      var completedEarly = false;
      for (var k = 0; k < order.length; k++) {
        var r = core.ingest(rx, built.frames[order[k]]);
        assert(r.accepted, 'frame ' + order[k] + ' rejected: ' + r.reason);
        if (r.complete && k < order.length - 1) completedEarly = true;
      }
      assert(!completedEarly, 'reported complete before the manifest arrived');
      var res = core.finalize(rx);
      assert(res.ok, 'finalize rejected: ' + res.reason);
      assert(bytesEqual(res.bytes, bytes), 'bytes differ after shuffled arrival');
      return built.total + ' frames, manifest last';
    });

    test('duplicate frames are counted and ignored', function () {
      var bytes = rndBytes(2500);
      var built = transfer(bytes, { name: 'dupes.bin', chunk: 256, transferId: 'feedface' });
      var rx = core.createReceiver();
      for (var pass = 0; pass < 3; pass++) {
        for (var i = 0; i < built.frames.length; i++) core.ingest(rx, built.frames[i]);
      }
      assertEqual(rx.received, built.total - 1, 'unique data frames stored');
      assertEqual(rx.duplicates, (built.total) * 2, 'duplicate count');
      var res = core.finalize(rx);
      assert(res.ok, 'finalize rejected: ' + res.reason);
      assert(bytesEqual(res.bytes, bytes), 'bytes differ');
      return rx.duplicates + ' duplicates absorbed';
    });

    test('a corrupted payload is rejected by the hash check', function () {
      var bytes = rndBytes(3000);
      var built = transfer(bytes, { name: 'corrupt.bin', chunk: 512, transferId: 'cafebabe' });
      var frames = built.frames.slice();
      // Flip one byte inside frame 3's payload, keeping the frame well-formed.
      var victim = core.parseFrame(frames[3]).frame;
      var tampered = new Uint8Array(victim.payload);
      tampered[0] ^= 0xff;
      frames[3] = JSON.stringify({
        v: 1, t: built.transferId, h: built.sha256.slice(0, 8),
        i: 3, n: built.total, p: core.b64uEncode(tampered)
      });

      var rx = core.createReceiver();
      for (var i = 0; i < frames.length; i++) core.ingest(rx, frames[i]);
      assert(core.isComplete(rx), 'transfer should look complete');
      var res = core.finalize(rx);
      assert(!res.ok, 'corrupted transfer was accepted');
      assertEqual(res.reason, 'hash-mismatch', 'rejection reason');
      assertEqual(rx.status, 'REJECTED', 'receiver status');
      assert(!res.bytes, 'rejected transfer must not hand back bytes');
      return 'rejected as ' + res.reason;
    });

    test('a truncated transfer never finalizes', function () {
      var bytes = rndBytes(3000);
      var built = transfer(bytes, { name: 'partial.bin', chunk: 512, transferId: '11223344' });
      var rx = core.createReceiver();
      for (var i = 0; i < built.frames.length - 1; i++) core.ingest(rx, built.frames[i]);
      assert(!core.isComplete(rx), 'should not be complete');
      var res = core.finalize(rx);
      assert(!res.ok, 'incomplete transfer finalized');
      assertEqual(res.reason, 'incomplete', 'reason');
      assertEqual(core.missingSequences(rx).length, 1, 'missing count');
      return 'missing sequence ' + core.missingSequences(rx)[0];
    });

    test('a foreign frame cannot hijack a transfer that is still progressing', function () {
      var a = transfer(rndBytes(1200), { name: 'a.bin', chunk: 512, transferId: 'aaaaaaaa' });
      var b = transfer(rndBytes(1200), { name: 'b.bin', chunk: 512, transferId: 'bbbbbbbb' });
      var rx = core.createReceiver();
      var t0 = 1000;
      core.ingest(rx, a.frames[0], t0);
      // Both a stray data frame and a stray manifest arrive while transfer a is
      // healthy. Neither may take over.
      var r1 = core.ingest(rx, b.frames[1], t0 + 100);
      assert(!r1.accepted, 'foreign data frame accepted');
      assertEqual(r1.reason, 'other-transfer', 'reason');
      var r2 = core.ingest(rx, b.frames[0], t0 + 200);
      assert(!r2.accepted, 'foreign manifest accepted while active');
      assertEqual(r2.reason, 'other-transfer', 'manifest reason');

      for (var i = 1; i < a.frames.length; i++) core.ingest(rx, a.frames[i], t0 + 300 + i);
      var res = core.finalize(rx);
      assert(res.ok, 'clean transfer should still verify');
      assertEqual(res.name, 'a.bin', 'name');
      assertEqual(rx.switches, 0, 'no switch should have happened');
      return 'kept transfer aaaaaaaa through 2 intrusions';
    });

    test('a restarted sender is picked up once the old transfer goes quiet', function () {
      var bytesA = rndBytes(3000);
      var bytesB = rndBytes(2000);
      var a = transfer(bytesA, { name: 'old.bin', chunk: 512, transferId: 'aaaaaaaa' });
      var b = transfer(bytesB, { name: 'new.bin', chunk: 512, transferId: 'bbbbbbbb' });
      var rx = core.createReceiver();

      // Half of transfer a arrives, then the sender restarts with a new id —
      // exactly what the app does on every fresh send or chunk-size change.
      var t = 1000;
      core.ingest(rx, a.frames[0], t);
      core.ingest(rx, a.frames[1], (t += 200));
      core.ingest(rx, a.frames[2], (t += 200));
      assertEqual(rx.transferId, 'aaaaaaaa', 'still on the old transfer');

      // The new sender's manifest lands after a gap longer than the manifest fuse.
      var sw = core.ingest(rx, b.frames[0], t + core.STALE_MANIFEST_MS + 1);
      assert(sw.accepted, 'restart manifest rejected: ' + sw.reason);
      assert(sw.switched, 'should have reported a switch');
      assertEqual(rx.transferId, 'bbbbbbbb', 'did not adopt the new transfer');
      assertEqual(rx.received, 0, 'stale chunks were not cleared');
      assertEqual(rx.switches, 1, 'switch counter');

      t += core.STALE_MANIFEST_MS + 1;
      for (var i = 1; i < b.frames.length; i++) core.ingest(rx, b.frames[i], (t += 100));
      var res = core.finalize(rx);
      assert(res.ok, 'restarted transfer failed to verify: ' + res.reason);
      assert(bytesEqual(res.bytes, bytesB), 'wrong bytes after switch');
      assertEqual(res.name, 'new.bin', 'name after switch');
      return 'recovered onto transfer bbbbbbbb';
    });

    test('a stray data frame takes over only after the longer stall window', function () {
      var a = transfer(rndBytes(1200), { name: 'a.bin', chunk: 512, transferId: 'aaaaaaaa' });
      var b = transfer(rndBytes(1200), { name: 'b.bin', chunk: 512, transferId: 'bbbbbbbb' });
      var rx = core.createReceiver();
      core.ingest(rx, a.frames[0], 1000);

      // Past the manifest fuse but short of the data fuse: still no takeover.
      var early = core.ingest(rx, b.frames[1], 1000 + core.STALE_MANIFEST_MS + 50);
      assert(!early.accepted, 'data frame took over too early');
      // Past the data fuse: adopted.
      var late = core.ingest(rx, b.frames[1], 1000 + core.STALE_TRANSFER_MS + 1);
      assert(late.accepted, 'stalled receiver never recovered: ' + late.reason);
      assertEqual(rx.transferId, 'bbbbbbbb', 'did not adopt');
      return 'data fuse ' + core.STALE_TRANSFER_MS + 'ms, manifest fuse ' + core.STALE_MANIFEST_MS + 'ms';
    });

    test('without a clock the strict single-transfer rule still holds', function () {
      var a = transfer(rndBytes(1200), { name: 'a.bin', chunk: 512, transferId: 'aaaaaaaa' });
      var b = transfer(rndBytes(1200), { name: 'b.bin', chunk: 512, transferId: 'bbbbbbbb' });
      var rx = core.createReceiver();
      core.ingest(rx, a.frames[0]);
      var r = core.ingest(rx, b.frames[0]);
      assert(!r.accepted, 'switched without any timestamps to justify it');
      assertEqual(r.reason, 'other-transfer', 'reason');
      return 'no clock, no switching';
    });

    // -- hostile bounds ------------------------------------------------------

    test('a frame claiming an absurd frame count is rejected outright', function () {
      // The reported freeze: one QR whose n is Number.MAX_SAFE_INTEGER made the
      // receiver try to allocate a DOM node per expected frame.
      var poc = '{"v":1,"t":"00000000","h":"00000000","i":1,"n":9007199254740991,"p":""}';
      var got = core.parseFrame(poc);
      assert(!got.ok, 'the proof-of-concept frame parsed');
      assertEqual(got.reason, 'too-many-frames', 'reason');

      // The ceiling itself is inclusive, one past it is not.
      var atCap = '{"v":1,"t":"00000000","h":"00000000","i":1,"n":' + core.MAX_FRAMES + ',"p":""}';
      assert(core.parseFrame(atCap).ok, 'the cap itself should be accepted');
      var overCap = '{"v":1,"t":"00000000","h":"00000000","i":1,"n":' + (core.MAX_FRAMES + 1) + ',"p":""}';
      assertEqual(core.parseFrame(overCap).reason, 'too-many-frames', 'one past the cap');

      // And a receiver never adopts it, so nothing downstream sees the value.
      var rx = core.createReceiver();
      var r = core.ingest(rx, poc);
      assert(!r.accepted, 'hostile frame ingested');
      assertEqual(rx.total, 0, 'hostile n reached receiver state');
      assertEqual(rx.status, 'IDLE', 'receiver left IDLE on a rejected frame');
      return 'cap ' + core.MAX_FRAMES + ' frames';
    });

    test('a self-consistent manifest can still be too big to accept', function () {
      // Every internal check passes — the hash prefix matches, and the frame
      // count agrees with size and chunk. It is refused on size alone.
      var size = 1024 * 1024 * 1024;
      var chunk = 128;
      var hash = '00'.repeat(32);
      var manifest = JSON.stringify({
        v: 1, t: '00000000', h: hash.slice(0, 8), i: 0,
        n: 1 + Math.ceil(size / chunk),
        m: { name: 'big.bin', size: size, sha256: hash, chunk: chunk }
      });
      var got = core.parseFrame(manifest);
      assert(!got.ok, 'oversized manifest accepted');
      assertEqual(got.reason, 'too-many-frames', 'reason');

      // Same idea with a chunk no QR symbol could ever have carried.
      var wide = JSON.stringify({
        v: 1, t: '00000000', h: hash.slice(0, 8), i: 0, n: 2,
        m: { name: 'wide.bin', size: 5000, sha256: hash, chunk: 5000 }
      });
      assertEqual(core.parseFrame(wide).reason, 'chunk-too-large', 'chunk ceiling');

      // And an over-long name.
      var longName = JSON.stringify({
        v: 1, t: '00000000', h: hash.slice(0, 8), i: 0, n: 2,
        m: { name: 'x'.repeat(600) + '.bin', size: 10, sha256: hash, chunk: 512 }
      });
      assertEqual(core.parseFrame(longName).reason, 'name-too-long', 'name ceiling');
      return 'size, chunk and name ceilings all enforced';
    });

    test('the receive grid is capped no matter what the frame count claims', function () {
      var totals = [1, 2, 83, core.MAX_GRID_CELLS, core.MAX_GRID_CELLS + 2, core.MAX_FRAMES];
      for (var i = 0; i < totals.length; i++) {
        var plan = core.gridPlan(totals[i]);
        assert(plan.cells <= core.MAX_GRID_CELLS,
          'plan for total ' + totals[i] + ' wants ' + plan.cells + ' cells');
        assert(plan.cells <= Math.max(0, totals[i] - 1), 'more cells than frames');
        // Every data frame must land inside the drawn range, or the grid lies.
        if (plan.cells) {
          assertEqual(core.cellForSequence(plan, 1), 0, 'first frame cell');
          var last = core.cellForSequence(plan, totals[i] - 1);
          assert(last >= 0 && last < plan.cells, 'last frame maps outside the grid');
        }
      }
      // The worst case a receiver will ever adopt still draws a bounded grid.
      var worst = core.gridPlan(core.MAX_FRAMES);
      assertEqual(worst.cells, core.MAX_GRID_CELLS, 'worst-case cell count');
      assert(worst.bucketed, 'worst case should be bucketed');
      assert(worst.framesPerCell * worst.cells >= worst.dataFrames, 'buckets do not cover all frames');
      return core.MAX_FRAMES + ' frames -> ' + worst.cells + ' cells at ' +
        worst.framesPerCell + ' frames each';
    });

    test('artifact names are stripped and clamped', function () {
      assertEqual(core.sanitizeName('rvf_wasm_bg.wasm'), 'rvf_wasm_bg.wasm', 'plain name');
      assertEqual(core.sanitizeName('my cool-file v2.wasm'), 'my cool-file v2.wasm', 'spaces kept');
      assert(core.sanitizeName('../../etc/passwd').indexOf('/') === -1, 'path separator survived');
      assert(core.sanitizeName('../../etc/passwd').charAt(0) !== '.', 'leading dot survived');
      assertEqual(core.sanitizeName(''), 'artifact.bin', 'empty name');
      assertEqual(core.sanitizeName('a\u0000b\u001fc.bin'), 'abc.bin', 'control characters');
      var long = core.sanitizeName('n'.repeat(400) + '.wasm');
      assertEqual(long.length, core.SAFE_NAME_LENGTH, 'clamped length');
      assert(/\.wasm$/.test(long), 'extension preserved through the clamp');
      return 'clamped to ' + core.SAFE_NAME_LENGTH + ' chars';
    });

    test('a verified transfer hands back a sanitized name', function () {
      var bytes = rndBytes(600);
      var hash = core.sha256Hex(bytes);
      var hostile = '../../../etc/cron.d/payload';
      var frames = [
        JSON.stringify({
          v: 1, t: 'aaaaaaaa', h: hash.slice(0, 8), i: 0, n: 2,
          m: { name: hostile, size: bytes.length, sha256: hash, chunk: 1024 }
        }),
        JSON.stringify({
          v: 1, t: 'aaaaaaaa', h: hash.slice(0, 8), i: 1, n: 2,
          p: core.b64uEncode(bytes)
        })
      ];
      var rx = core.createReceiver();
      for (var i = 0; i < frames.length; i++) core.ingest(rx, frames[i]);
      var res = core.finalize(rx);
      assert(res.ok, 'transfer failed: ' + res.reason);
      assert(res.name.indexOf('/') === -1, 'sanitized name still has a separator');
      assertEqual(res.declaredName, hostile, 'the declared name should still be reported');
      return res.name;
    });

    test('malformed and hostile frames are rejected without throwing', function () {
      var rx = core.createReceiver();
      var cases = [
        ['', 'not-a-frame'],
        ['hello world', 'not-a-frame'],
        ['{not json', 'bad-json'],
        ['{"v":2,"t":"aaaaaaaa","h":"bbbbbbbb","i":0,"n":1}', 'bad-version'],
        ['{"v":1,"t":"ZZ","h":"bbbbbbbb","i":0,"n":1}', 'bad-transfer-id'],
        ['{"v":1,"t":"aaaaaaaa","h":"XY","i":0,"n":1}', 'bad-hash-prefix'],
        ['{"v":1,"t":"aaaaaaaa","h":"bbbbbbbb","i":-1,"n":1}', 'bad-seq'],
        ['{"v":1,"t":"aaaaaaaa","h":"bbbbbbbb","i":5,"n":2}', 'bad-total'],
        ['{"v":1,"t":"aaaaaaaa","h":"bbbbbbbb","i":0,"n":2}', 'missing-manifest'],
        ['{"v":1,"t":"aaaaaaaa","h":"bbbbbbbb","i":1,"n":2}', 'missing-payload'],
        ['{"v":1,"t":"aaaaaaaa","h":"bbbbbbbb","i":1,"n":2,"p":"!!!!"}', 'bad-payload']
      ];
      for (var i = 0; i < cases.length; i++) {
        var got = core.parseFrame(cases[i][0]);
        assert(!got.ok, 'case ' + i + ' unexpectedly parsed');
        assertEqual(got.reason, cases[i][1], 'case ' + i + ' reason');
        var r = core.ingest(rx, cases[i][0]);
        assert(!r.accepted, 'case ' + i + ' ingested');
      }
      assertEqual(rx.rejected, cases.length, 'rejected counter');
      return cases.length + ' hostile inputs';
    });

    test('a manifest whose frame count contradicts size/chunk is rejected', function () {
      var bytes = rndBytes(1000);
      var built = transfer(bytes, { name: 'lie.bin', chunk: 512, transferId: '99887766' });
      var manifest = JSON.parse(built.frames[0]);
      manifest.n = manifest.n + 3; // claim more frames than size/chunk implies
      var got = core.parseFrame(JSON.stringify(manifest));
      assert(!got.ok, 'inconsistent manifest accepted');
      assertEqual(got.reason, 'frame-count-mismatch', 'reason');

      var manifest2 = JSON.parse(built.frames[0]);
      manifest2.h = '00000000'; // prefix no longer matches the full hash
      var got2 = core.parseFrame(JSON.stringify(manifest2));
      assert(!got2.ok, 'prefix mismatch accepted');
      assertEqual(got2.reason, 'hash-prefix-mismatch', 'reason 2');
      return 'both tampered manifests rejected';
    });

    test('size edge cases: 0, 1, exactly one chunk, one chunk plus one', function () {
      var sizes = [0, 1, 512, 513, 1024];
      for (var s = 0; s < sizes.length; s++) {
        var bytes = rndBytes(sizes[s]);
        var built = core.buildFrames(bytes, { name: 'edge.bin', chunk: 512, transferId: '0f0f0f0f' });
        assertEqual(built.total, 1 + Math.ceil(sizes[s] / 512), 'frame count for ' + sizes[s]);
        var rx = core.createReceiver();
        for (var i = 0; i < built.frames.length; i++) core.ingest(rx, built.frames[i]);
        var res = core.finalize(rx);
        assert(res.ok, 'size ' + sizes[s] + ' rejected: ' + res.reason);
        assert(bytesEqual(res.bytes, bytes), 'size ' + sizes[s] + ' bytes differ');
      }
      return sizes.join(', ') + ' bytes';
    });

    test('a 40 KB artifact survives a lossy, shuffled, duplicating channel', function () {
      var bytes = rndBytes(40989); // same size as the bundled demo wasm
      var built = core.buildFrames(bytes, { name: 'rvf_wasm_bg.wasm', chunk: 512 });
      var rx = core.createReceiver();
      var order = shuffle(built.frames.map(function (_, i) { return i; }));
      var delivered = Object.create(null);
      var attempts = 0;
      // Drop roughly one frame in five on the first pass, then keep replaying
      // the loop the way a real sender does until the receiver has everything.
      for (var pass = 0; pass < 12 && !core.isComplete(rx); pass++) {
        for (var k = 0; k < order.length; k++) {
          var idx = order[k];
          attempts++;
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          var drop = pass === 0 && (seed >>> 9) % 5 === 0;
          if (drop) continue;
          delivered[idx] = true;
          core.ingest(rx, built.frames[idx]);
        }
      }
      assert(core.isComplete(rx), 'never completed');
      var res = core.finalize(rx);
      assert(res.ok, 'finalize rejected: ' + res.reason);
      assert(bytesEqual(res.bytes, bytes), 'bytes differ');
      return built.total + ' frames, ' + attempts + ' delivery attempts, ' +
        rx.duplicates + ' duplicates';
    });

    // -- QR encoder ----------------------------------------------------------

    if (qrlib) {
      test('QR: HELLO RVQR encodes with valid finder, timing and format patterns', function () {
        var qr = qrlib.encodeText('HELLO RVQR', { ecl: 'M' });
        checkStructure(qr);
        return 'version ' + qr.version + ', mask ' + qr.mask + ', ' + qr.size + 'x' + qr.size;
      });

      test('QR: structure holds across versions and error correction levels', function () {
        var levels = ['L', 'M', 'Q', 'H'];
        var count = 0;
        for (var li = 0; li < levels.length; li++) {
          for (var v = 1; v <= 40; v += 7) {
            var cap = qrlib.byteCapacity(v, qrlib.ECC[levels[li]]);
            var payload = rndBytes(Math.max(1, Math.min(cap, cap - 3)));
            var qr = qrlib.encodeBytes(payload, { ecl: levels[li], version: v });
            assertEqual(qr.version, v, 'version honoured');
            assertEqual(qr.size, v * 4 + 17, 'size');
            checkStructure(qr);
            count++;
          }
        }
        return count + ' symbols checked';
      });

      test('QR: format information decodes back to the level and mask used', function () {
        var levels = { L: 1, M: 0, Q: 3, H: 2 };
        var names = Object.keys(levels);
        for (var i = 0; i < names.length; i++) {
          for (var mask = 0; mask < 8; mask++) {
            var qr = qrlib.encodeBytes(rndBytes(20), { ecl: names[i], version: 5, mask: mask });
            var f = readFormatBits(qr);
            assert(f.valid, 'BCH check failed for ' + names[i] + ' mask ' + mask);
            assertEqual(f.copy1, f.copy2, 'the two format copies disagree');
            assertEqual(f.eccBits, levels[names[i]], 'ecc bits for ' + names[i]);
            assertEqual(f.mask, mask, 'mask bits');
          }
        }
        return '32 level/mask combinations';
      });

      test('QR: real transfer frames all encode within the version ceiling', function () {
        var bytes = rndBytes(20000);
        var built = core.buildFrames(bytes, { name: 'transfer.wasm', chunk: 512 });
        var maxVersion = 0;
        for (var i = 0; i < built.frames.length; i += 7) {
          var qr = qrlib.encodeText(built.frames[i], { ecl: 'L' });
          checkStructure(qr);
          maxVersion = Math.max(maxVersion, qr.version);
        }
        assert(maxVersion <= 25, 'version ' + maxVersion + ' is denser than a phone camera likes');
        return 'largest version ' + maxVersion;
      });

      test('QR: capacity boundary is enforced exactly', function () {
        var cap = qrlib.byteCapacity(10, qrlib.ECC.M);
        qrlib.encodeBytes(rndBytes(cap), { ecl: 'M', version: 10 }); // must not throw
        var threw = false;
        try {
          qrlib.encodeBytes(rndBytes(cap + 1), { ecl: 'M', version: 10 });
        } catch (e) {
          threw = true;
        }
        assert(threw, 'over-capacity payload was accepted');
        return 'v10-M capacity ' + cap + ' bytes';
      });
    }

    // -- erasure-coded transfers ---------------------------------------------

    if (mods.fountain) {
      test('fountain: a lossy stream still reconstructs the object exactly', function () {
        var bytes = rndBytes(2304); // the demo container's size
        var hash = core.sha256Hex(bytes);
        var encoder = mods.fountain.encoder(bytes, 512);
        var stream = core.buildFountainStream(encoder, {
          name: 'ruvnet-demo.rvf', sha256: hash, transferId: 'f0f0f0f0', size: bytes.length
        });

        var rx = core.createReceiver();
        core.useCodec(rx, mods.fountain.decoder(encoder.K, encoder.symbolSize, encoder.totalBytes));
        core.ingest(rx, stream.manifest);
        assertEqual(rx.mode, core.MODE_FOUNTAIN, 'mode adopted from the manifest');

        // Drop one symbol in three. The sender never learns which — it just
        // keeps emitting, which is the whole point of the scheme.
        var emitted = 0;
        for (var esi = 0; esi < encoder.K * 4 && !core.isComplete(rx); esi++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          if ((seed >>> 9) % 3 === 0) continue; // lost in the air
          core.ingest(rx, stream.symbolFrame(esi));
          emitted++;
        }
        assert(core.isComplete(rx), 'never became decodable after ' + emitted + ' symbols');
        var res = core.finalize(rx);
        assert(res.ok, 'finalize rejected: ' + res.reason);
        assert(bytesEqual(res.bytes, bytes), 'reconstructed bytes differ from the source');
        return encoder.K + ' symbols needed, ' + emitted + ' delivered through a lossy channel';
      });

      test('fountain: repair symbols alone rebuild the object', function () {
        // Nothing systematic arrives at all — every symbol is a repair symbol.
        var bytes = rndBytes(900);
        var hash = core.sha256Hex(bytes);
        var encoder = mods.fountain.encoder(bytes, 256);
        var stream = core.buildFountainStream(encoder, { name: 'r.bin', sha256: hash, size: bytes.length });
        var rx = core.createReceiver();
        core.useCodec(rx, mods.fountain.decoder(encoder.K, encoder.symbolSize, encoder.totalBytes));
        core.ingest(rx, stream.manifest);
        for (var esi = encoder.K; esi < encoder.K * 6 && !core.isComplete(rx); esi++) {
          core.ingest(rx, stream.symbolFrame(esi));
        }
        assert(core.isComplete(rx), 'repair-only stream never decoded');
        var res = core.finalize(rx);
        assert(res.ok, 'finalize rejected: ' + res.reason);
        assert(bytesEqual(res.bytes, bytes), 'bytes differ');
        return 'rebuilt from ' + rx.symbols + ' repair symbols, K=' + encoder.K;
      });

      test('fountain: a corrupted symbol still cannot forge an accepted file', function () {
        var bytes = rndBytes(1200);
        var hash = core.sha256Hex(bytes);
        var encoder = mods.fountain.encoder(bytes, 300);
        var stream = core.buildFountainStream(encoder, { name: 'c.bin', sha256: hash, size: bytes.length });
        var rx = core.createReceiver();
        core.useCodec(rx, mods.fountain.decoder(encoder.K, encoder.symbolSize, encoder.totalBytes));
        core.ingest(rx, stream.manifest);
        for (var esi = 0; esi < encoder.K * 3 && !core.isComplete(rx); esi++) {
          var frame = stream.symbolFrame(esi);
          if (esi === 1) {
            // Flip a byte inside one symbol, keeping the frame well-formed.
            var obj = JSON.parse(frame);
            var raw = core.b64uDecode(obj.p);
            raw[0] ^= 0xff;
            obj.p = core.b64uEncode(raw);
            frame = JSON.stringify(obj);
          }
          core.ingest(rx, frame);
        }
        // Whether it decodes or not, the hash is the gate: nothing wrong is
        // ever handed back as ok.
        var res = core.finalize(rx);
        if (res.ok) {
          assert(bytesEqual(res.bytes, bytes), 'accepted bytes that differ from the source');
          return 'corruption absorbed by the code, output still exact';
        }
        assert(res.reason === 'hash-mismatch' || res.reason === 'incomplete' ||
          res.reason === 'assembly-failed', 'unexpected reason ' + res.reason);
        return 'rejected as ' + res.reason;
      });
    }

    test('an unknown transfer mode is refused, not guessed at', function () {
      var hash = core.sha256Hex(rndBytes(64));
      function manifest(mode, extra) {
        var m = { name: 'x.bin', size: 1000, sha256: hash, chunk: 512 };
        if (mode !== undefined) m.mode = mode;
        for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
        return JSON.stringify({ v: 1, t: 'aaaaaaaa', h: hash.slice(0, 8), i: 0, n: 3, m: m });
      }
      // A future mode this build has never heard of.
      assertEqual(core.parseFrame(manifest('raptorq-v2')).reason, 'unknown-mode', 'unknown mode');
      assertEqual(core.parseFrame(manifest(42)).reason, 'unknown-mode', 'non-string mode');
      // Absent mode still means the original indexed stream.
      var plain = core.parseFrame(manifest(undefined));
      assert(plain.ok, 'a manifest without a mode should still parse: ' + plain.reason);
      assertEqual(plain.frame.mode, core.MODE_INDEXED, 'default mode');
      return 'unknown modes rejected, absent mode defaults to indexed';
    });

    test('an erasure-coded manifest must agree with its own arithmetic', function () {
      var hash = core.sha256Hex(rndBytes(64));
      function fountainManifest(over) {
        var m = {
          name: 'x.bin', size: 1000, sha256: hash, chunk: 250,
          mode: 'fountain', k: 4, symbolSize: 250
        };
        for (var key in over) if (Object.prototype.hasOwnProperty.call(over, key)) m[key] = over[key];
        return JSON.stringify({
          v: 1, t: 'aaaaaaaa', h: hash.slice(0, 8), i: 0,
          n: over && over.n !== undefined ? over.n : m.k, m: m
        });
      }
      assert(core.parseFrame(fountainManifest()).ok, 'a consistent fountain manifest should parse');
      assertEqual(core.parseFrame(fountainManifest({ k: 9 })).reason, 'symbol-count-mismatch', 'k vs size');
      assertEqual(core.parseFrame(fountainManifest({ symbolSize: 0 })).reason, 'bad-symbol-size', 'symbol size');
      assertEqual(core.parseFrame(fountainManifest({ k: 0, n: 3 })).reason, 'bad-symbol-count', 'k floor');
      return 'inconsistent erasure-coded manifests refused';
    });

    test('erasure-coded frames may carry ids past K; indexed frames may not', function () {
      var hash = core.sha256Hex(rndBytes(16));
      function frame(flag, i, n) {
        var o = { v: 1, t: 'aaaaaaaa', h: hash.slice(0, 8), i: i, n: n, p: 'AAAA' };
        if (flag) o.f = 1;
        return JSON.stringify(o);
      }
      // A repair symbol's id is above K by design.
      var repair = core.parseFrame(frame(true, 40, 10));
      assert(repair.ok, 'a repair symbol was rejected: ' + repair.reason);
      assertEqual(repair.frame.mode, core.MODE_FOUNTAIN, 'flagged frames are fountain frames');
      // The same numbers without the flag are a malformed indexed frame.
      assertEqual(core.parseFrame(frame(false, 40, 10)).reason, 'bad-total', 'indexed bound still applies');
      // And the absolute ceiling still binds erasure-coded ids.
      assertEqual(core.parseFrame(frame(true, core.MAX_FRAMES + 1, 10)).reason, 'too-many-frames', 'ceiling');
      return 'repair ids allowed past K, ceiling intact';
    });

    test('a receiver refuses to mix indexed and erasure-coded frames', function () {
      var bytes = rndBytes(600);
      var hash = core.sha256Hex(bytes);
      var indexed = core.buildFrames(bytes, { name: 'm.bin', chunk: 300, sha256: hash, transferId: 'abababab' });
      var rx = core.createReceiver();
      core.ingest(rx, indexed.frames[1]);
      // Same transfer id, but now claiming to be erasure-coded.
      var sneaky = JSON.stringify({
        v: 1, t: 'abababab', h: hash.slice(0, 8), f: 1, i: 7, n: 2, p: 'AAAA'
      });
      var r = core.ingest(rx, sneaky);
      assert(!r.accepted, 'a fountain frame was accepted into an indexed transfer');
      assertEqual(r.reason, 'mode-mismatch', 'reason');
      return 'mixed-mode frames rejected';
    });

    // -- keyframe gate -------------------------------------------------------

    // Builds a flat grey ImageData-like frame, optionally with a bright patch,
    // so signatures can be steered precisely.
    function makeFrame(w, h, base, patch) {
      var data = new Uint8ClampedArray(w * h * 4);
      for (var i = 0; i < w * h; i++) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = base;
        data[i * 4 + 3] = 255;
      }
      if (patch) {
        for (var y = patch.y; y < Math.min(h, patch.y + patch.h); y++) {
          for (var x = patch.x; x < Math.min(w, patch.x + patch.w); x++) {
            var p = (y * w + x) * 4;
            data[p] = data[p + 1] = data[p + 2] = patch.value;
          }
        }
      }
      return { data: data, width: w, height: h };
    }

    test('keyframe gate: identical frames have zero difference', function () {
      var a = makeFrame(64, 64, 120, { x: 8, y: 8, w: 24, h: 24, value: 240 });
      var b = makeFrame(64, 64, 120, { x: 8, y: 8, w: 24, h: 24, value: 240 });
      var sigA = core.frameSignature(a);
      var sigB = core.frameSignature(b);
      assertEqual(sigA.length, core.SIGNATURE_SIZE * core.SIGNATURE_SIZE, 'signature size');
      assertEqual(core.signatureDiff(sigA, sigB), 0, 'identical frames');
      assertEqual(core.signatureDiff(sigA, sigA), 0, 'self comparison');
      return core.SIGNATURE_SIZE + 'x' + core.SIGNATURE_SIZE + ' signature, diff 0';
    });

    test('keyframe gate: a changed frame registers a difference', function () {
      var plain = core.frameSignature(makeFrame(64, 64, 120));
      var marked = core.frameSignature(makeFrame(64, 64, 120, { x: 0, y: 0, w: 64, h: 64, value: 255 }));
      var diff = core.signatureDiff(plain, marked);
      assert(diff > core.CHANGE_THRESHOLD, 'a full repaint should exceed the threshold, got ' + diff);
      // Mismatched or absent signatures must read as maximally different
      // rather than accidentally comparing equal.
      assertEqual(core.signatureDiff(null, plain), 255, 'null signature');
      assertEqual(core.signatureDiff(plain, new Uint8Array(4)), 255, 'length mismatch');
      return 'full repaint diff ' + diff.toFixed(1);
    });

    test('keyframe gate: decodes only when changed and settled', function () {
      var gate = core.createFrameGate();
      var still = core.frameSignature(makeFrame(64, 64, 100));
      var first = core.gateFrame(gate, still);
      assert(first.decode, 'the first frame must always be attempted');
      assertEqual(first.reason, 'first-frame', 'first reason');

      // Same picture again: settled, but nothing new to read.
      var second = core.gateFrame(gate, core.frameSignature(makeFrame(64, 64, 100)));
      assert(!second.decode, 'an identical frame should be skipped');
      assertEqual(second.reason, 'unchanged', 'skip reason');

      // A big change arriving in one step reads as motion, not as a new frame:
      // the picture is different from the previous frame, so the camera is
      // still moving and a decode would be wasted.
      var moved = core.gateFrame(gate, core.frameSignature(makeFrame(64, 64, 200)));
      assert(!moved.decode, 'a frame mid-motion should be skipped');
      assertEqual(moved.reason, 'moving', 'motion reason');

      // Hold that new picture still, and now it is worth decoding.
      var settled = core.gateFrame(gate, core.frameSignature(makeFrame(64, 64, 200)));
      assert(settled.decode, 'a settled new picture should be decoded: ' + settled.reason);
      assertEqual(settled.reason, 'changed-and-settled', 'decode reason');
      return 'first, unchanged, moving, changed-and-settled';
    });

    test('keyframe gate: threshold boundaries behave as documented', function () {
      // Signatures differing by a known constant, so the mean absolute
      // difference is exactly that constant.
      function flat(value) {
        var n = core.SIGNATURE_SIZE * core.SIGNATURE_SIZE;
        var sig = new Uint8Array(n);
        for (var i = 0; i < n; i++) sig[i] = value;
        return sig;
      }
      assertEqual(core.signatureDiff(flat(100), flat(109)), 9, 'exact difference');

      // change === threshold decodes (the comparison is < threshold to skip);
      // one below it does not.
      var gate = core.createFrameGate({ settleThreshold: 100 });
      core.gateFrame(gate, flat(100));
      var atThreshold = core.gateFrame(gate, flat(100 + core.CHANGE_THRESHOLD));
      assert(atThreshold.decode, 'a change of exactly the threshold should decode');

      var gate2 = core.createFrameGate({ settleThreshold: 100 });
      core.gateFrame(gate2, flat(100));
      var below = core.gateFrame(gate2, flat(100 + core.CHANGE_THRESHOLD - 1));
      assert(!below.decode, 'one below the threshold should skip');

      // The settle threshold gates on movement from the previous frame.
      var gate3 = core.createFrameGate();
      core.gateFrame(gate3, flat(0));
      var jumpy = core.gateFrame(gate3, flat(core.SETTLE_THRESHOLD + 1));
      assertEqual(jumpy.reason, 'moving', 'just over the settle threshold');
      return 'change ' + core.CHANGE_THRESHOLD + ', settle ' + core.SETTLE_THRESHOLD;
    });

    test('keyframe gate: a starved decoder is let through anyway', function () {
      // A scene creeping just under the settle threshold would otherwise skip
      // for ever; the skip limit guarantees forward progress.
      var gate = core.createFrameGate({ maxSkips: 5 });
      var n = core.SIGNATURE_SIZE * core.SIGNATURE_SIZE;
      function drifting(step) {
        var sig = new Uint8Array(n);
        for (var i = 0; i < n; i++) sig[i] = (step * (core.SETTLE_THRESHOLD + 2)) % 256;
        return sig;
      }
      core.gateFrame(gate, drifting(0));
      var forced = 0;
      for (var i = 1; i <= 20; i++) {
        var d = core.gateFrame(gate, drifting(i));
        if (d.reason === 'skip-limit') forced++;
      }
      assert(forced > 0, 'the skip limit never fired across 20 moving frames');
      return forced + ' forced attempts in 20 frames';
    });

    test('keyframe gate: skips the bulk of a mostly-static sequence', function () {
      // 100 frames of a camera pointed at a sending screen: the picture only
      // actually changes when the sender advances a frame.
      var gate = core.createFrameGate();
      var frames = [];
      var distinct = 12;
      for (var i = 0; i < 100; i++) {
        // A new picture every 100/12 frames, held still in between.
        var epoch = Math.floor(i / Math.ceil(100 / distinct));
        frames.push(makeFrame(64, 64, 40 + epoch * 17));
      }
      for (var f = 0; f < frames.length; f++) {
        core.gateFrame(gate, core.frameSignature(frames[f]));
      }
      assertEqual(gate.seen, 100, 'frames seen');
      assert(gate.attempts < 40, 'expected far fewer than 40 attempts, got ' + gate.attempts);
      var saved = Math.round((1 - gate.attempts / gate.seen) * 100);
      return gate.attempts + ' decode attempts for 100 frames (' + saved + '% skipped)';
    });

    // -- welcome animation ---------------------------------------------------
    // These exist because the loop shipped broken once: the canvas painted a
    // single frame and never changed again, which is invisible to every test
    // that does not actually advance a clock.

    function pumpStage(env, ms, stepMs, opts) {
      var model = core.createStageModel(opts);
      var seen = [], draws = 0;
      for (var t = 0; t <= ms; t += stepMs) {
        var r = core.stageAdvance(model, t, env);
        if (r.draw) { draws++; seen.push(core.stageFingerprint(model)); }
      }
      return { model: model, draws: draws, seen: seen, distinct: countDistinct(seen) };
    }
    function countDistinct(list) {
      var map = {};
      for (var i = 0; i < list.length; i++) map[list[i]] = true;
      var n = 0;
      for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) n++;
      return n;
    }

    test('welcome animation: the picture actually changes over time', function () {
      // The exact scenario that caught the bug: 900 ms of 60 Hz frames with no
      // motion preference. A frozen loop scores 1 here.
      var run = pumpStage({ open: true, visible: true, reduced: false }, 900, 1000 / 60);
      assert(run.draws > 0, 'nothing was drawn at all');
      assert(run.distinct > 5, 'the picture barely changed: ' + run.distinct + ' distinct states');
      assert(run.seen[0] !== run.seen[run.seen.length - 1],
        'first and last frame are identical — the loop is not advancing');
      return run.draws + ' draws, ' + run.distinct + ' distinct pictures in 900ms';
    });

    test('welcome animation: the first frame paints whatever the clock reads', function () {
      // The clock is page-relative, so a model must not decide its first paint
      // by comparing against a zero-initialised timestamp.
      var model = core.createStageModel();
      var late = core.stageAdvance(model, 1e9, { open: true, visible: true });
      assert(late.draw, 'the first frame was skipped on a long-running page');
      assertEqual(late.reason, 'advanced', 'reason');
      var fresh = core.createStageModel();
      assert(core.stageAdvance(fresh, 0, { open: true, visible: true }).draw,
        'the first frame was skipped at time zero');
      return 'paints at t=0 and at t=1e9';
    });

    test('welcome animation: throttled to its frame budget, not the display', function () {
      var run = pumpStage({ open: true, visible: true, reduced: false }, 1000, 1000 / 120, { fps: 30 });
      // One second at the configured 30fps, with a little slack for rounding.
      assert(run.draws <= 32, 'drew ' + run.draws + ' times in a second at 30fps');
      assert(run.draws >= 28, 'only drew ' + run.draws + ' times in a second at 30fps');
      return run.draws + ' draws per second at 120Hz input';
    });

    test('welcome animation: stops when the dialog is closed or hidden', function () {
      var closed = pumpStage({ open: false, visible: true }, 500, 16);
      assertEqual(closed.draws, 0, 'drew while closed');
      var hidden = pumpStage({ open: true, visible: false }, 500, 16);
      assertEqual(hidden.draws, 0, 'drew while the page was hidden');
      // And it resumes cleanly rather than staying wedged.
      var model = core.createStageModel();
      core.stageAdvance(model, 0, { open: false, visible: true });
      assert(core.stageAdvance(model, 16, { open: true, visible: true }).draw, 'never resumed');
      return 'no draws while closed or hidden, resumes after';
    });

    test('welcome animation: reduced motion paints one still and then rests', function () {
      var env = { open: true, visible: true, reduced: true };
      var run = pumpStage(env, 900, 1000 / 60);
      assertEqual(run.draws, 1, 'reduced motion should paint exactly once');
      // The still has to carry the idea on its own: partly filled, one in flight.
      assert(run.model.landed > 0, 'the still shows an empty receiver');
      assert(run.model.landed < run.model.cells, 'the still shows a finished transfer');
      assertEqual(run.model.packets.length, 1, 'the still should show a frame in flight');
      // And it must look different from the animated path, or the preference
      // is not actually being honoured.
      var moving = pumpStage({ open: true, visible: true, reduced: false }, 900, 1000 / 60);
      assert(moving.distinct !== run.distinct, 'both motion modes produced the same output');
      return 'one still: ' + core.stageFingerprint(run.model);
    });

    test('welcome animation: frames cross, land, and the loop restarts', function () {
      var run = pumpStage({ open: true, visible: true, reduced: false }, 20000, 1000 / 60);
      var landedSeen = 0, sawFull = false, sawReset = false;
      var model = core.createStageModel();
      var prevLanded = 0;
      for (var t = 0; t <= 20000; t += 1000 / 60) {
        core.stageAdvance(model, t, { open: true, visible: true });
        if (model.landed > prevLanded) landedSeen++;
        if (model.landed >= model.cells) sawFull = true;
        if (sawFull && model.landed === 0) sawReset = true;
        prevLanded = model.landed;
      }
      assert(landedSeen > 0, 'no frame ever landed');
      assert(sawFull, 'the receiver grid never filled');
      assert(sawReset, 'the animation never looped back to the start');
      return landedSeen + ' landings, filled and looped';
    });

    // -- admission control ---------------------------------------------------

    test('a pinned fingerprint gates the vault write, not just the badge', function () {
      // The release-blocking case: a valid signature from the WRONG key must
      // never reach storage when a pin is configured.
      var refused = core.admitArtifact('21fe-31df-a154-a261', { state: 'wrong-key' });
      assert(!refused.admit, 'a wrong-key transfer must be refused: ' + refused.code);
      assert(refused.code === 'wrong-key', 'code should name the cause, got ' + refused.code);

      var ok = core.admitArtifact('21fe-31df-a154-a261', { state: 'pinned' });
      assert(ok.admit, 'the pinned key must be admitted');
      return 'wrong-key refused, pinned admitted';
    });

    test('a pending signature check never admits', function () {
      // The actual bug: verification is asynchronous, so an artifact could be
      // stored while the verdict was still outstanding.
      var pending = core.admitArtifact('21fe-31df-a154-a261', null);
      assert(!pending.admit, 'a null verdict must not admit');
      assert(pending.code === 'pending', 'got ' + pending.code);
      var half = core.admitArtifact('21fe-31df-a154-a261', {});
      assert(!half.admit, 'a verdict with no state must not admit');
      return 'both pending shapes refused';
    });

    test('every non-pinned verdict is refused while a pin is set', function () {
      var states = ['unsigned', 'signed', 'bad', 'wrong-key', 'something-new'];
      var admitted = states.filter(function (st) {
        return core.admitArtifact('aa-bb-cc-dd', { state: st }).admit;
      });
      assert(admitted.length === 0, 'these should not admit: ' + admitted.join(', '));
      // An unknown future verdict must fail closed rather than fall through.
      assert(
        core.admitArtifact('aa-bb-cc-dd', { state: 'something-new' }).code === 'unknown-verdict',
        'an unrecognised verdict should be named as such'
      );
      return states.length + ' verdicts refused, unknown fails closed';
    });

    test('with no pin the operator has named no signer, so hash alone stores', function () {
      var r = core.admitArtifact(null, { state: 'unsigned' });
      assert(r.admit, 'no pin means integrity is the whole contract');
      assert(r.code === 'no-pin', 'got ' + r.code);
      return 'unpinned path unchanged';
    });

    // -- first-run state -----------------------------------------------------

    test('welcome: shows on every load until explicitly silenced', function () {
      var store = (function () {
        var data = {};
        return {
          getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
          setItem: function (k, v) { data[k] = String(v); },
          removeItem: function (k) { delete data[k]; }
        };
      })();
      assert(core.shouldShowWelcome(store), 'a fresh visitor should see it');
      assert(core.markWelcomeSeen(store), 'marking should succeed');
      assert(
        core.shouldShowWelcome(store),
        'dismissing closes it for the visit only — a refresh shows it again'
      );
      assert(core.suppressWelcome(store), 'opting out should succeed');
      assert(!core.shouldShowWelcome(store), 'an explicit opt-out stops it');
      assert(core.unsuppressWelcome(store), 'undo should succeed');
      assert(core.shouldShowWelcome(store), '"show it again" restores it');
      // A different version key re-shows, which is the point of versioning it.
      assert(core.shouldShowWelcome(store, 'rvqr.welcome.v2'), 'a new version should show again');
      return core.WELCOME_KEY;
    });

    test('welcome: hostile or absent storage never breaks the boot path', function () {
      var hostile = {
        getItem: function () { throw new Error('storage disabled'); },
        setItem: function () { throw new Error('storage disabled'); }
      };
      assert(core.shouldShowWelcome(hostile), 'a throwing store should fall back to showing');
      assertEqual(core.markWelcomeSeen(hostile), false, 'marking should report failure, not throw');
      assert(core.shouldShowWelcome(null), 'no storage at all should fall back to showing');
      assertEqual(core.markWelcomeSeen(null), false, 'no storage marks nothing');
      return 'degrades to showing the welcome';
    });

    test('reduced motion is honoured and safe when unsupported', function () {
      assert(core.prefersReducedMotion(function () { return { matches: true }; }), 'reduce → true');
      assert(!core.prefersReducedMotion(function () { return { matches: false }; }), 'no-preference → false');
      assert(!core.prefersReducedMotion(undefined), 'no matchMedia → false');
      assert(!core.prefersReducedMotion(function () { throw new Error('nope'); }), 'throwing matchMedia → false');
      return '4 branches';
    });

    // -- QR decoder ----------------------------------------------------------

    /**
     * Rasterises a symbol to an ImageData-like object. Kept here rather than in
     * the decoder so the tests drive it exactly the way a camera frame or an
     * uploaded picture would: pixels in, text out.
     */
    function rasterize(qr, opts) {
      opts = opts || {};
      var scale = opts.scale || 4;
      var quiet = opts.quiet === undefined ? 4 : opts.quiet;
      var fg = opts.fg === undefined ? 0 : opts.fg;
      var bg = opts.bg === undefined ? 255 : opts.bg;
      var dim = qr.size + quiet * 2;
      var W = dim * scale;
      var data = new Uint8ClampedArray(W * W * 4);
      for (var y = 0; y < W; y++) {
        for (var x = 0; x < W; x++) {
          var mx = Math.floor(x / scale) - quiet;
          var my = Math.floor(y / scale) - quiet;
          var dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.getModule(mx, my);
          var v = dark ? fg : bg;
          var p = (y * W + x) * 4;
          data[p] = data[p + 1] = data[p + 2] = v;
          data[p + 3] = 255;
        }
      }
      return { data: data, width: W, height: W };
    }

    function blurImage(img, r) {
      var w = img.width, h = img.height, src = img.data;
      var out = new Uint8ClampedArray(src.length);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var acc = 0, n = 0;
          for (var dy = -r; dy <= r; dy++) {
            for (var dx = -r; dx <= r; dx++) {
              var X = x + dx, Y = y + dy;
              if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
              acc += src[(Y * w + X) * 4];
              n++;
            }
          }
          var p = (y * w + x) * 4;
          out[p] = out[p + 1] = out[p + 2] = acc / n;
          out[p + 3] = 255;
        }
      }
      return { data: out, width: w, height: h };
    }

    if (qrdec) {
      test('decoder: matrix roundtrip across every version and level', function () {
        var levels = ['L', 'M', 'Q', 'H'];
        var checked = 0;
        for (var li = 0; li < levels.length; li++) {
          for (var v = 1; v <= 40; v += 3) {
            var cap = Math.min(qrlib.byteCapacity(v, qrlib.ECC[levels[li]]), 64);
            var text = '';
            for (var i = 0; i < cap; i++) text += String.fromCharCode(65 + ((i * 7 + v) % 26));
            var qr = qrlib.encodeText(text, { ecl: levels[li], version: v });
            var got = qrdec.decodeMatrix(function (x, y) { return qr.getModule(x, y); }, qr.size);
            assert(got.ok, 'v' + v + '-' + levels[li] + ' failed: ' + got.reason);
            assertEqual(got.text, text, 'v' + v + '-' + levels[li] + ' text');
            assertEqual(got.version, v, 'version readback');
            assertEqual(got.ecc, levels[li], 'level readback');
            checked++;
          }
        }
        return checked + ' symbols';
      });

      test('decoder: full-capacity payloads survive the roundtrip', function () {
        var checked = 0;
        for (var v = 1; v <= 40; v += 7) {
          var cap = qrlib.byteCapacity(v, qrlib.ECC.L);
          var bytes = rndBytes(cap);
          for (var i = 0; i < cap; i++) bytes[i] = 32 + (bytes[i] % 90); // printable
          var qr = qrlib.encodeBytes(bytes, { ecl: 'L', version: v });
          var got = qrdec.decodeMatrix(function (x, y) { return qr.getModule(x, y); }, qr.size);
          assert(got.ok, 'v' + v + ' failed: ' + got.reason);
          var want = '';
          for (var k = 0; k < bytes.length; k++) want += String.fromCharCode(bytes[k]);
          assertEqual(got.text, want, 'v' + v + ' payload');
          checked++;
        }
        return checked + ' symbols at full capacity';
      });

      test('decoder: reads real transfer frames out of rendered pixels', function () {
        var bytes = rndBytes(2304); // the size of the bundled demo container
        var built = core.buildFrames(bytes, { name: 'ruvnet-demo.rvf', chunk: 512 });
        for (var i = 0; i < built.frames.length; i++) {
          var qr = qrlib.encodeText(built.frames[i], { ecl: 'L' });
          var got = qrdec.decode(rasterize(qr, { scale: 4 }));
          assert(got.ok, 'frame ' + i + ' (v' + qr.version + ') not found');
          assertEqual(got.text, built.frames[i], 'frame ' + i + ' text');
        }
        return built.total + ' frames through the pixel pipeline';
      });

      test('decoder: a decoded frame feeds the receiver end to end', function () {
        var bytes = rndBytes(1500);
        var built = core.buildFrames(bytes, { name: 'pixels.bin', chunk: 400 });
        var rx = core.createReceiver();
        // Decode the frames out of pixels, in reverse, exactly as a camera
        // catching a looping stream might.
        for (var i = built.frames.length - 1; i >= 0; i--) {
          var qr = qrlib.encodeText(built.frames[i], { ecl: 'L' });
          var got = qrdec.decode(rasterize(qr, { scale: 5, quiet: 3 }));
          assert(got.ok, 'frame ' + i + ' failed to decode');
          core.ingest(rx, got.text);
        }
        var res = core.finalize(rx);
        assert(res.ok, 'transfer rejected: ' + res.reason);
        assert(bytesEqual(res.bytes, bytes), 'bytes differ after a pixel round trip');
        return built.total + ' frames decoded and verified';
      });

      test('decoder: survives scale, rotation, noise and uneven light', function () {
        var msg = 'HELLO RVQR';
        var qr = qrlib.encodeText(msg, { ecl: 'M' });
        var cases = [];
        [2, 3, 4, 8].forEach(function (scale) {
          cases.push(['scale ' + scale, rasterize(qr, { scale: scale })]);
        });
        cases.push(['no quiet zone', rasterize(qr, { scale: 5, quiet: 0 })]);
        cases.push(['wide margin', rasterize(qr, { scale: 5, quiet: 20 })]);
        cases.push(['low contrast', rasterize(qr, { scale: 5, fg: 60, bg: 200 })]);
        cases.push(['blurred', blurImage(rasterize(qr, { scale: 6 }), 1)]);
        for (var i = 0; i < cases.length; i++) {
          var got = qrdec.decode(cases[i][1]);
          assert(got.ok && got.text === msg, cases[i][0] + ' failed: ' + (got.reason || 'wrong text'));
        }
        return cases.length + ' renderings';
      });

      test('decoder: reads several frames out of one picture', function () {
        // The image-upload path: photograph a screen, get every frame on it.
        var bytes = rndBytes(1200);
        var built = core.buildFrames(bytes, { name: 'sheet.bin', chunk: 512 });
        var tiles = built.frames.map(function (f) {
          return rasterize(qrlib.encodeText(f, { ecl: 'L' }), { scale: 3, quiet: 4 });
        });
        var cols = 2;
        var tw = Math.max.apply(null, tiles.map(function (t) { return t.width; }));
        var rows = Math.ceil(tiles.length / cols);
        var W = tw * cols, H = tw * rows;
        var sheet = { data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H };
        tiles.forEach(function (t, k) {
          var ox = (k % cols) * tw, oy = Math.floor(k / cols) * tw;
          for (var y = 0; y < t.height; y++) {
            for (var x = 0; x < t.width; x++) {
              var sp = (y * t.width + x) * 4, dp = ((oy + y) * W + (ox + x)) * 4;
              sheet.data[dp] = t.data[sp];
              sheet.data[dp + 1] = t.data[sp + 1];
              sheet.data[dp + 2] = t.data[sp + 2];
              sheet.data[dp + 3] = 255;
            }
          }
        });
        var found = qrdec.decodeImage(sheet, { all: true });
        var texts = {};
        found.forEach(function (f) { texts[f.text] = true; });
        for (var i = 0; i < built.frames.length; i++) {
          assert(texts[built.frames[i]], 'frame ' + i + ' missing from the composite');
        }
        return found.length + ' of ' + built.total + ' frames from a single image';
      });

      test('decoder: the finder window has room for a false positive', function () {
        // Regression for a real defect the test above could only catch by luck.
        // It draws random bytes and mints a random transfer id, so it built a
        // different sheet every run and failed about one run in six — a flake
        // that looked like harness noise and was in fact the decoder dropping a
        // frame. Both sources of variation are pinned here, so the case either
        // always reproduces or is always fixed.
        //
        // A 4-frame sheet contributes 12 true finder patterns. The candidate
        // window used to hold exactly 12, so one false positive out-ranking a
        // true corner made that frame unfindable. Seed 2 is such a sheet: it
        // dropped frame 2 at a window of 12 and drops nothing at 24.
        var s = 2 >>> 0;
        var bytes = new Uint8Array(1200);
        for (var i = 0; i < bytes.length; i++) {
          s = (s * 1103515245 + 12345) >>> 0;
          bytes[i] = (s >>> 16) & 255;
        }
        var built = core.buildFrames(bytes, {
          name: 'sheet.bin', chunk: 512, transferId: 'a1b2c3d4'
        });
        assert(built.frames.length === 4, 'expected a 4-frame sheet, got ' + built.frames.length);

        var tiles = built.frames.map(function (f) {
          return rasterize(qrlib.encodeText(f, { ecl: 'L' }), { scale: 3, quiet: 4 });
        });
        var cols = 2;
        var tw = Math.max.apply(null, tiles.map(function (t) { return t.width; }));
        var W = tw * cols, H = tw * Math.ceil(tiles.length / cols);
        var sheet = { data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H };
        tiles.forEach(function (t, k) {
          var ox = (k % cols) * tw, oy = Math.floor(k / cols) * tw;
          for (var y = 0; y < t.height; y++) {
            for (var x = 0; x < t.width; x++) {
              var sp = (y * t.width + x) * 4, dp = ((oy + y) * W + (ox + x)) * 4;
              sheet.data[dp] = t.data[sp];
              sheet.data[dp + 1] = t.data[sp + 1];
              sheet.data[dp + 2] = t.data[sp + 2];
              sheet.data[dp + 3] = 255;
            }
          }
        });

        var seen = {};
        qrdec.decodeImage(sheet, { all: true }).forEach(function (f) { seen[f.text] = true; });
        for (var j = 0; j < built.frames.length; j++) {
          assert(seen[built.frames[j]], 'frame ' + j + ' missing — finder window too small');
        }
        return 'all 4 frames read from the sheet that a 12-candidate window dropped';
      });

      test('decoder: error correction repairs a damaged symbol', function () {
        var msg = 'rvQR error correction check';
        var qr = qrlib.encodeText(msg, { ecl: 'Q' });
        var matrix = [];
        for (var y = 0; y < qr.size; y++) {
          var row = new Uint8Array(qr.size);
          for (var x = 0; x < qr.size; x++) row[x] = qr.getModule(x, y) ? 1 : 0;
          matrix.push(row);
        }
        // A thumb-sized blot over the data region.
        var blot = Math.max(2, Math.floor(qr.size * 0.09));
        var ox = Math.floor(qr.size * 0.42), oy = Math.floor(qr.size * 0.5);
        for (var by = oy; by < Math.min(qr.size, oy + blot); by++) {
          for (var bx = ox; bx < Math.min(qr.size, ox + blot); bx++) matrix[by][bx] ^= 1;
        }
        var got = qrdec.decodeMatrix(function (x, y) { return !!matrix[y][x]; }, qr.size);
        assert(got.ok, 'damaged symbol not recovered: ' + got.reason);
        assertEqual(got.text, msg, 'recovered text');
        assert(got.corrections > 0, 'expected the decoder to report corrections');
        return got.corrections + ' codewords repaired';
      });

      test('decoder: refuses noise instead of inventing a payload', function () {
        var W = 160;
        var img = { data: new Uint8ClampedArray(W * W * 4), width: W, height: W };
        for (var i = 0; i < W * W; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          var v = (seed >>> 16) & 0xff;
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        var got = qrdec.decode(img);
        assert(!got.ok, 'random noise decoded as ' + JSON.stringify(got.text));
        return 'rejected as ' + got.reason;
      });
    }

    function checkStructure(qr) {
      var size = qr.size;
      // Three finder patterns: dark 7x7 ring, light ring, dark 3x3 core.
      var corners = [[0, 0], [size - 7, 0], [0, size - 7]];
      for (var c = 0; c < corners.length; c++) {
        var ox = corners[c][0], oy = corners[c][1];
        for (var dy = 0; dy < 7; dy++) {
          for (var dx = 0; dx < 7; dx++) {
            var dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            var want = dist !== 2;
            if (qr.getModule(ox + dx, oy + dy) !== want) {
              throw new Error('finder pattern broken at corner ' + c + ' offset ' + dx + ',' + dy);
            }
          }
        }
      }
      // The fourth corner must NOT hold a finder pattern.
      var falseFinder = true;
      for (var fy = 0; fy < 7 && falseFinder; fy++) {
        for (var fx = 0; fx < 7; fx++) {
          var d = Math.max(Math.abs(fx - 3), Math.abs(fy - 3));
          if (qr.getModule(size - 7 + fx, size - 7 + fy) !== (d !== 2)) {
            falseFinder = false;
            break;
          }
        }
      }
      if (falseFinder) throw new Error('unexpected finder pattern in the bottom-right corner');

      // Timing patterns alternate along row 6 and column 6.
      for (var t = 8; t < size - 8; t++) {
        if (qr.getModule(t, 6) !== (t % 2 === 0)) throw new Error('horizontal timing broken at ' + t);
        if (qr.getModule(6, t) !== (t % 2 === 0)) throw new Error('vertical timing broken at ' + t);
      }

      // Separators: the light ring around each finder pattern.
      for (var s = 0; s < 8; s++) {
        if (qr.getModule(7, s) || qr.getModule(s, 7)) throw new Error('top-left separator not light');
        if (qr.getModule(size - 8, s)) throw new Error('top-right separator not light');
        if (qr.getModule(s, size - 8)) throw new Error('bottom-left separator not light');
      }

      // The always-dark module below the top-left format block.
      if (!qr.getModule(8, size - 8)) throw new Error('dark module missing');
      return true;
    }

    // Reads both copies of the 15-bit format information and BCH-checks them.
    function readFormatBits(qr) {
      var size = qr.size;
      var bit = function (x, y) { return qr.getModule(x, y) ? 1 : 0; };
      var copy1 = 0, i;
      for (i = 0; i <= 5; i++) copy1 |= bit(8, i) << i;
      copy1 |= bit(8, 7) << 6;
      copy1 |= bit(8, 8) << 7;
      copy1 |= bit(7, 8) << 8;
      for (i = 9; i < 15; i++) copy1 |= bit(14 - i, 8) << i;

      var copy2 = 0;
      for (i = 0; i < 8; i++) copy2 |= bit(size - 1 - i, 8) << i;
      for (i = 8; i < 15; i++) copy2 |= bit(8, size - 15 + i) << i;

      var unmasked = copy1 ^ 0x5412;
      // BCH(15,5) with generator 0x537: a valid codeword leaves no remainder.
      var rem = unmasked;
      for (var j = 14; j >= 10; j--) {
        if (rem & (1 << j)) rem ^= 0x537 << (j - 10);
      }
      var data = unmasked >>> 10;
      return {
        copy1: copy1,
        copy2: copy2,
        valid: rem === 0,
        eccBits: (data >>> 3) & 3,
        mask: data & 7
      };
    }

    // -- frame formats -------------------------------------------------------
    //
    // The app can send in either of two frame formats and must receive in both.
    // These cover the wiring itself: which format is chosen by default, whether
    // that choice survives into the manifest, and what each receiver says when
    // it is handed the other format. They are written against the pure helpers
    // in core.js and the two protocol modules, not against the DOM, so a
    // failure here points at a decision rather than at a widget.

    var proto2 = mods.proto2 ||
      (typeof window !== 'undefined' ? window.RVQRProto2 : null) || null;

    test('format: the default is v1, and anything unrecognised becomes v1', function () {
      assertEqual(core.DEFAULT_FORMAT, core.FORMAT_V1, 'DEFAULT_FORMAT');
      assertEqual(core.FORMAT_V1, 'v1', 'FORMAT_V1');
      assertEqual(core.FORMAT_V2, 'v2', 'FORMAT_V2');
      var junk = [undefined, null, '', 'v3', 'V2', 0, 2, {}, ['v2']];
      for (var i = 0; i < junk.length; i++) {
        assertEqual(core.normalizeFormat(junk[i]), core.FORMAT_V1,
          'normalizeFormat(' + String(junk[i]) + ')');
      }
      // A v2 choice is the only thing that produces v2 — it is never arrived at
      // by accident, which is the whole point of the default.
      assertEqual(core.normalizeFormat('v2'), core.FORMAT_V2, 'normalizeFormat("v2")');
      return 'default v1; 9 unrecognised values all fall back to v1';
    });

    test('format: a v1 transfer names its format in the manifest, before any data frame', function () {
      var bytes = rndBytes(1600);
      var built = core.buildFrames(bytes, { name: 'a.bin', chunk: 512 });
      assertEqual(core.frameFormat(built.frames[0], proto2), core.FORMAT_V1, 'manifest format');
      // The manifest is frame 0, so a receiver knows the format from the first
      // frame of the transfer rather than by inspecting a data frame.
      var parsed = core.parseFrame(built.frames[0]);
      assert(parsed.ok, 'manifest did not parse');
      assertEqual(parsed.frame.kind, 'manifest', 'frame 0 kind');
      assertEqual(parsed.frame.i, 0, 'manifest index');
      assertEqual(parsed.frame.v, 1, 'declared protocol version');
      for (var i = 1; i < built.frames.length; i++) {
        assertEqual(core.frameFormat(built.frames[i], proto2), core.FORMAT_V1,
          'data frame ' + i + ' format');
      }
      return built.frames.length + ' frames, all v1, manifest at index 0';
    });

    if (proto2) {
      test('format: a v2 transfer names its format in the manifest, through the armour', function () {
        var bytes = rndBytes(1600);
        var built = proto2.buildFrames(bytes, { name: 'a.bin', chunk: 512 });

        // Canonical bytes and the string the app actually puts in a symbol are
        // both recognised. The app sends the armoured form because both QR
        // decoders it can reach return a string and nothing else.
        assertEqual(proto2.identify(built.frames[0]), 'v2', 'identify on raw bytes');
        assertEqual(proto2.identify(proto2.toTransport(built.frames[0])), 'v2-armoured',
          'identify on the armoured form');
        assertEqual(core.frameFormat(proto2.toTransport(built.frames[0]), proto2),
          core.FORMAT_V2, 'manifest format');

        var parsed = proto2.parseFrame(proto2.toTransport(built.frames[0]));
        assert(parsed.ok, 'manifest did not parse: ' + parsed.reason);
        assertEqual(parsed.frame.kind, 'manifest', 'frame 0 kind');
        assertEqual(parsed.frame.index, 0, 'manifest index');
        assertEqual(parsed.frame.version, 2, 'declared protocol version');
        for (var i = 1; i < built.frames.length; i++) {
          assertEqual(core.frameFormat(proto2.toTransport(built.frames[i]), proto2),
            core.FORMAT_V2, 'data frame ' + i + ' format');
        }
        return built.frames.length + ' frames, all v2, manifest at index 0';
      });

      test('format: the choice round-trips through the manifest for both formats', function () {
        var bytes = rndBytes(2304);
        var chosen = [core.FORMAT_V1, core.FORMAT_V2];
        for (var i = 0; i < chosen.length; i++) {
          var format = core.normalizeFormat(chosen[i]);
          var manifest = format === core.FORMAT_V2
            ? proto2.toTransport(proto2.buildFrames(bytes, { name: 'r.bin', chunk: 512 }).frames[0])
            : core.buildFrames(bytes, { name: 'r.bin', chunk: 512 }).frames[0];
          assertEqual(core.frameFormat(manifest, proto2), format,
            'chose ' + format + ', manifest read back as');
        }
        return 'v1 and v2 each come back as themselves';
      });

      test('format: a v1 receiver fed a v2 frame names the format it got', function () {
        var bytes = rndBytes(1200);
        var v2 = proto2.buildFrames(bytes, { name: 'b.bin', chunk: 512 });
        var rx = core.createReceiver();

        // Canonical v2 bytes reach core.parseFrame as text starting "RVQ2",
        // which it refuses by name rather than mis-decoding.
        var raw = String.fromCharCode.apply(null, Array.prototype.slice.call(v2.frames[1], 0, 4));
        var out = core.ingest(rx, raw + 'ignored');
        assertEqual(out.accepted, false, 'a v2 frame was accepted by a v1 receiver');
        assertEqual(out.reason, 'v2-frame', 'reason');
        assertEqual(core.rejectedFormat(out.reason), core.FORMAT_V2, 'named format');

        // Armoured, the frame no longer starts "RVQ2" — that is what the armour
        // does — so core.parseFrame alone can only call it damage. Naming it is
        // frameFormat's job, which is why the app routes on that first.
        var armoured = proto2.toTransport(v2.frames[1]);
        var blind = core.ingest(core.createReceiver(), armoured);
        assertEqual(blind.accepted, false, 'an armoured v2 frame was accepted');
        assertEqual(core.rejectedFormat(blind.reason), null, 'parseFrame alone should not name it');
        assertEqual(core.frameFormat(armoured, proto2), core.FORMAT_V2, 'frameFormat names it');

        var note = core.formatMismatchText(core.FORMAT_V1, core.FORMAT_V2);
        assert(note.indexOf('v2') >= 0 && note.indexOf('v1') >= 0, 'note names both formats');
        assert(note.indexOf('binary') >= 0, 'note says which format arrived in words');
        return 'refused as ' + out.reason + '; armoured form named by frameFormat';
      });

      test('format: a v2 receiver fed a v1 frame names the format it got', function () {
        var bytes = rndBytes(1200);
        var v1 = core.buildFrames(bytes, { name: 'c.bin', chunk: 512 });
        var rx = proto2.createReceiver();

        var out = proto2.ingest(rx, v1.frames[0]);
        assertEqual(out.accepted, false, 'a v1 frame was accepted by a v2 receiver');
        assertEqual(out.reason, 'v1-frame', 'reason');
        assertEqual(core.rejectedFormat(out.reason), core.FORMAT_V1, 'named format');
        assertEqual(rx.status, 'IDLE', 'a refused frame must not start a transfer');

        assertEqual(proto2.identify(v1.frames[0]), 'v1', 'identify on a v1 frame');
        assertEqual(core.frameFormat(v1.frames[0], proto2), core.FORMAT_V1, 'frameFormat');

        var note = core.formatMismatchText(core.FORMAT_V2, core.FORMAT_V1);
        assert(note.indexOf('v1') >= 0 && note.indexOf('v2') >= 0, 'note names both formats');
        assert(note.indexOf('JSON') >= 0, 'note says which format arrived in words');
        return 'refused as ' + out.reason;
      });

      test('format: the mismatch note is silent when the formats agree', function () {
        assertEqual(core.formatMismatchText(core.FORMAT_V1, core.FORMAT_V1), null, 'v1 vs v1');
        assertEqual(core.formatMismatchText(core.FORMAT_V2, core.FORMAT_V2), null, 'v2 vs v2');
        // Something that is neither still gets a sentence, because "not a frame
        // at all" and "the other protocol" are different things to be told.
        var junk = core.formatMismatchText(core.FORMAT_V1, 'unknown');
        assert(junk && junk.indexOf('not an rvQR frame') >= 0, 'unknown input note');
        assertEqual(core.rejectedFormat('bad-json'), null, 'an ordinary reason names no format');
        return 'silent on agreement, explicit on anything else';
      });

      test('format: v2 frames survive the transport the app puts them on', function () {
        // The app armours every v2 frame because both QR decoders it can reach
        // return a string. This walks a whole transfer through that armour and
        // out the far side, which is the path a real scan takes.
        var bytes = rndBytes(3000);
        var built = proto2.buildFrames(bytes, { name: 'wire.bin', chunk: 512 });
        var rx = proto2.createReceiver();
        var order = shuffle(built.frames.map(function (_, i) { return i; }));
        for (var i = 0; i < order.length; i++) {
          var text = proto2.toTransport(built.frames[order[i]]);
          for (var c = 0; c < text.length; c++) {
            assert(text.charCodeAt(c) <= 0x7f, 'armour emitted a non-ASCII code unit');
          }
          proto2.ingest(rx, text);
        }
        assert(proto2.isComplete(rx), 'transfer did not complete');
        var res = proto2.finalize(rx, {});
        assert(res.ok, 'finalize refused: ' + res.reason);
        assert(bytesEqual(res.bytes, bytes), 'reconstructed bytes differ from the source');
        assertEqual(res.name, 'wire.bin', 'name');
        return built.frames.length + ' frames armoured, shuffled, and reassembled exactly';
      });

      test('format: v2 numbers its data frames the way the receive grid expects', function () {
        // The grid is drawn from gridPlan/cellForSequence over the chunk map,
        // and it is the same code for both formats. That only holds because a
        // v2 indexed transfer numbers its data frames 1..total-1, manifest at
        // 0, exactly as v1 does.
        var bytes = rndBytes(4096);
        var v1 = core.buildFrames(bytes, { name: 'g.bin', chunk: 512 });
        var v2 = proto2.buildFrames(bytes, { name: 'g.bin', chunk: 512 });
        assertEqual(v2.total, v1.total, 'frame count');

        var rx = proto2.createReceiver();
        for (var i = 0; i < v2.frames.length; i++) proto2.ingest(rx, proto2.toTransport(v2.frames[i]));
        var plan = core.gridPlan(rx.total);
        var seen = 0;
        for (var key in rx.chunks) {
          var seq = Number(key);
          assert(seq >= 1 && seq < rx.total, 'data frame index ' + seq + ' is out of range');
          assert(core.cellForSequence(plan, seq) >= 0, 'sequence ' + seq + ' has no grid cell');
          seen++;
        }
        assertEqual(seen, rx.total - 1, 'data frames in the chunk map');
        return rx.total + ' frames, ' + plan.cells + ' grid cells, every index placed';
      });

      if (qrdec) {
        test('format: an armoured v2 frame survives real pixels', function () {
          // The claim the whole v2 send path rests on: the armour is chosen so
          // that what comes back out of a rendered symbol is the frame, byte
          // for byte. Asserted through the real encoder and the real decoder
          // rather than trusted, because the armour's alphabet includes every
          // control character and a decoder that normalised even one of them
          // would corrupt frames silently.
          var bytes = rndBytes(2304);
          var built = proto2.buildFrames(bytes, { name: 'pixels.bin', chunk: 512 });
          var rx = proto2.createReceiver();
          for (var i = 0; i < built.frames.length; i++) {
            var text = proto2.toTransport(built.frames[i]);
            var qr = qrlib.encodeText(text, { ecl: 'L' });
            var got = qrdec.decode(rasterize(qr, { scale: 4 }));
            assert(got.ok, 'frame ' + i + ' (v' + qr.version + ') not found');
            assertEqual(got.text.length, text.length, 'frame ' + i + ' length');
            assertEqual(got.text, text, 'frame ' + i + ' text');
            proto2.ingest(rx, got.text);
          }
          var res = proto2.finalize(rx, {});
          assert(res.ok, 'finalize refused after the pixel round trip: ' + res.reason);
          assert(bytesEqual(res.bytes, bytes), 'bytes differ after the pixel round trip');
          return built.total + ' armoured frames through the pixel pipeline';
        });

        test('format: the receiver tells the two formats apart from pixels', function () {
          // Both formats rendered, decoded, and then routed by frameFormat —
          // the same call the app makes before either parser sees a frame.
          var bytes = rndBytes(900);
          var v1 = core.buildFrames(bytes, { name: 'mix.bin', chunk: 512 });
          var v2 = proto2.buildFrames(bytes, { name: 'mix.bin', chunk: 512 });
          var cases = [
            [core.FORMAT_V1, v1.frames[0]],
            [core.FORMAT_V1, v1.frames[1]],
            [core.FORMAT_V2, proto2.toTransport(v2.frames[0])],
            [core.FORMAT_V2, proto2.toTransport(v2.frames[1])]
          ];
          for (var i = 0; i < cases.length; i++) {
            var got = qrdec.decode(rasterize(qrlib.encodeText(cases[i][1], { ecl: 'L' }), { scale: 4 }));
            assert(got.ok, 'case ' + i + ' not decoded');
            assertEqual(core.frameFormat(got.text, proto2), cases[i][0], 'case ' + i + ' format');
          }
          return cases.length + ' symbols, each named correctly from its pixels';
        });
      }

      test('format: a v2 manifest has nowhere to put a signature', function () {
        // The app disables signing for v2 on the strength of this: the body is
        // a fixed 47-byte record plus the name, and a body of any other length
        // is refused. It is a property of the frozen format, not a gap in the
        // wiring, so it is asserted rather than worked around.
        var bytes = rndBytes(600);
        var built = proto2.buildFrames(bytes, { name: 's.bin', chunk: 512 });
        var parsed = proto2.parseFrame(built.frames[0]);
        assert(parsed.ok, 'manifest did not parse');
        assertEqual(parsed.frame.payload.length, proto2.MANIFEST_FIXED_BYTES + 's.bin'.length,
          'manifest body length');
        assertEqual(parsed.frame.manifest.sig, undefined, 'sig field');
        assertEqual(parsed.frame.manifest.pub, undefined, 'pub field');

        // One extra byte appended to the body is refused, so there is no slack
        // a signature could be smuggled into.
        var longer = Uint8Array.from(built.frames[0]);
        var padded = new Uint8Array(longer.length + 1);
        padded.set(longer);
        padded[18] = (longer.length - proto2.HEADER_BYTES + 1) & 0xff;
        var out = proto2.parseFrame(padded);
        assertEqual(out.ok, false, 'a longer manifest body was accepted');
        return 'body is ' + proto2.MANIFEST_FIXED_BYTES + ' bytes plus the name, exactly';
      });
    }

    // -- embedded provenance, as the detail sheet presents it -----------------
    //
    // provenance.test.js already asserts what verify() decides. These assert
    // what the app does with that decision: which of the two lists a claim is
    // rendered from, which of the three verdict states it carries, and that the
    // three states the panel can be in other than "checked and passed" —
    // absent, unreadable, failed — are each reported as themselves.
    //
    // They run against the view model at the top of app.js, which is pure and
    // takes provenance.js's output directly, so a failure here points at a
    // presentation decision rather than at a widget.

    var P = mods.provenance ||
      (typeof window !== 'undefined' ? window.RVQRProvenance : null) || null;
    var view = mods.view ||
      (typeof window !== 'undefined' ? window.RVQRProvenanceView : null) || null;

    if (mods.indexHtml) {
      test('provenance: the page loads provenance.js, so the module actually ships', function () {
        var html = mods.indexHtml;
        var tag = html.indexOf('src="./provenance.js"');
        assert(tag >= 0, 'index.html does not reference provenance.js at all');
        // The standalone build derives its script list from this document, so
        // an unreferenced module is a module that never reaches a user.
        var line = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
        assert(line.indexOf('defer') >= 0, 'provenance.js should be deferred with the optional modules');
        // app.js reads it through a getter, so it may load either side of this
        // tag — but it must be in the document, or the panel has no renderer.
        assert(html.indexOf('src="./app.js"') >= 0, 'index.html does not load app.js');
        return 'loaded, deferred, and therefore bundled';
      });

      test('provenance: no stylesheet rule can give an assertion the pass colour', function () {
        // The view model refuses to put a verdict on an assertion; this refuses
        // to let the stylesheet put one back. --ok is the variable that means
        // "this was checked and it held", in both themes, and no rule in the
        // asserted register may reach for it.
        var html = mods.indexHtml;
        var rules = html.match(/\.claim[^{}]*\{[^}]*\}/g) || [];
        assert(rules.length >= 3, 'the asserted register has almost no styles: ' + rules.length);
        for (var i = 0; i < rules.length; i++) {
          assert(rules[i].indexOf('--ok') < 0,
            'a .claim rule reaches for the pass colour: ' + rules[i].replace(/\s+/g, ' '));
        }
        // And the checked register does use it, so the two really do differ
        // rather than both being colourless.
        assert(/\.check\.pass[^{}]*\{[^}]*--ok/.test(html),
          '.check.pass does not use the pass colour, so nothing distinguishes the two');
        return rules.length + ' rules in the asserted register, none of them green';
      });
    }

    if (P && view) {
      // A container is a chain of RVF v1 segment headers. Built here rather
      // than read from disk so these tests need no fixture and no kernel.
      var SEG_HEADER = 64;
      function segment(type, id, payload) {
        var out = new Uint8Array(SEG_HEADER + payload.length);
        out.set([0x53, 0x46, 0x56, 0x52], 0); // 'SFVR'
        out[4] = 1;
        out[5] = type;
        var dv = new DataView(out.buffer);
        dv.setUint32(8, id >>> 0, true);
        dv.setUint32(16, payload.length, true);
        out.set(payload, SEG_HEADER);
        return out;
      }
      function joinBytes(list) {
        var n = 0, i;
        for (i = 0; i < list.length; i++) n += list[i].length;
        var out = new Uint8Array(n), k = 0;
        for (i = 0; i < list.length; i++) { out.set(list[i], k); k += list[i].length; }
        return out;
      }
      var sha256 = function (b) { return core.sha256Hex(b); };

      // One data segment and one provenance segment describing it. The digest
      // is the real hash of the real bytes, so this container's SBOM is true.
      var dataPayload = rndBytes(512);
      function populated(digestHex) {
        var p = P.emptyProvenance();
        p.sbom = {
          present: true,
          components: [{
            name: 'payload', version: '1', purpose: 'data',
            digest: { sha256: digestHex }, licences: ['MIT'], segment: 0
          }]
        };
        p.licences = { present: true, artifact: ['MIT'], expression: null };
        p.source = {
          present: true, repository: 'git+https://github.com/ruvnet/rvQR',
          commit: '0'.repeat(40), ref: 'refs/heads/main'
        };
        p.signerPolicy = {
          present: true, requiredSigners: 1,
          keys: [{ id: 'release@ruv.net', algorithm: 'ed25519', publicKey: 'AAECAw==', maySign: ['provenance'] }]
        };
        p.build = {
          present: true, builder: 'https://ci.example/rvqr',
          buildType: 'https://slsa.dev/container-based-build/v0.1',
          invocationId: 'run-7', startedOn: '2026-08-03T09:00:00Z',
          finishedOn: '2026-08-03T09:04:00Z', reproducible: true
        };
        p.vulnerabilities = {
          present: true,
          assertions: [{
            advisory: 'CVE-2026-0001', component: 'payload',
            status: 'not_affected', justification: 'vulnerable_code_not_present'
          }]
        };
        return p;
      }
      function build(digestHex) {
        var container = joinBytes([
          segment(0x01, 1, dataPayload),
          segment(P.PROVENANCE_SEGMENT_TYPE, 2, P.encode(populated(digestHex)))
        ]);
        var read = P.readContainer(container);
        return {
          container: container,
          read: read,
          model: view.model(read, P.verify(read.provenance, container, { sha256: sha256 }))
        };
      }

      test('provenance: a checkable hash and an asserted claim get different visual states', function () {
        var m = build(sha256(dataPayload)).model;
        assertEqual(m.state, view.PRESENT, 'state');
        assert(m.checks.length, 'nothing was checked');
        assert(m.claims.length, 'nothing was asserted');

        // Checks carry one of the verdict states and are marked as checkable.
        var verdicts = [view.PASS, view.WARN, view.FAIL, view.UNAVAILABLE];
        for (var i = 0; i < m.checks.length; i++) {
          assert(verdicts.indexOf(m.checks[i].status) >= 0,
            'check "' + m.checks[i].name + '" carries ' + m.checks[i].status);
          assertEqual(m.checks[i].checkable, true, 'check ' + i + ' is not marked checkable');
          assertEqual(m.checks[i].mark, view.MARKS[m.checks[i].status], 'check ' + i + ' mark');
        }

        // Assertions carry none of them, ever. The builder's word about a
        // reproducible build must not be able to pick up the tick a recomputed
        // hash earned two rows above it.
        for (var j = 0; j < m.claims.length; j++) {
          assertEqual(m.claims[j].status, view.ASSERTED, 'claim "' + m.claims[j].name + '" status');
          assertEqual(m.claims[j].checkable, false, 'claim ' + j + ' is marked checkable');
          assert(verdicts.indexOf(m.claims[j].status) < 0, 'claim ' + j + ' carries a verdict');
          assert(m.claims[j].mark !== view.MARKS[view.PASS], 'claim ' + j + ' wears the pass mark');
          assert(m.claims[j].attribution, 'claim ' + j + ' names no author');
        }

        // The reproducibility claim keeps its author in the sentence rather
        // than reading as a property of the bytes.
        var repro = null;
        m.claims.forEach(function (c) { if (c.name === 'Reproducible') repro = c; });
        assert(repro, 'the reproducible claim is not on the asserted list');
        assertEqual(repro.value, 'claimed', 'a boolean assertion rendered as a verdict');
        assertEqual(view.claimText(true), 'claimed', 'claimText(true)');

        // And a passing hash really is a pass, so the distinction is not
        // achieved by refusing to tick anything.
        assertEqual(m.tone, view.PASS, 'tone');
        assert(m.counts.passed >= 1, 'no check passed');
        assertEqual(m.components[0].status, view.PASS, 'component verdict');
        return m.checks.length + ' checked, ' + m.claims.length + ' asserted, no overlap';
      });

      test('provenance: a failed component hash is a failure, not a warning', function () {
        var wrong = 'f'.repeat(64);
        assert(wrong !== sha256(dataPayload), 'the fixture digest is accidentally correct');
        var m = build(wrong).model;

        assertEqual(m.state, view.PRESENT, 'state');
        assertEqual(m.components[0].status, view.FAIL, 'component verdict');
        assertEqual(m.components[0].mark, view.MARKS[view.FAIL], 'component mark');
        assertEqual(m.tone, view.FAIL, 'panel tone');
        assert(m.counts.failed >= 1, 'the failure was not counted');

        // Nothing may soften it into a warning on the way to the screen.
        for (var i = 0; i < m.checks.length; i++) {
          assert(m.checks[i].status !== view.WARN,
            '"' + m.checks[i].name + '" was downgraded to a warning');
        }
        assert(m.components[0].status !== view.WARN, 'the component row was downgraded to a warning');

        // And it leads: a substitution reported quietly is a substitution
        // accepted.
        assert(m.banner, 'a failed hash produced no banner');
        assertEqual(m.banner.tone, view.FAIL, 'banner tone');
        assert(/failed/.test(m.banner.text), 'the banner does not say anything failed');
        assert(/false/.test(m.headline), 'the headline does not say a claim is false: ' + m.headline);

        // A passing check elsewhere must not average the failure away.
        var passes = m.checks.filter(function (c) { return c.status === view.PASS; });
        assert(passes.length >= 1, 'expected the segment-chain check to still pass');
        assertEqual(view.toneFor({ passed: 9, failed: 1, unavailable: 0 }), view.FAIL,
          'one failure among nine passes');
        return 'fail state, ' + passes.length + ' passing checks alongside it, banner raised';
      });

      test('provenance: a container with no provenance segment says so explicitly', function () {
        var container = joinBytes([segment(0x01, 1, dataPayload)]);
        var read = P.readContainer(container);
        assertEqual(read.provenanced, false, 'readContainer.provenanced');
        var m = view.model(read, P.verify(read.provenance, container, { sha256: sha256 }));

        assertEqual(m.state, view.ABSENT, 'state');
        assert(m.state !== view.PRESENT, 'absence rendered as presence');
        assertEqual(m.tone, view.UNAVAILABLE, 'tone');
        assert(m.tone !== view.PASS, 'an unprovenanced container read as a pass');
        assert(m.headline, 'the absent state has no headline');
        assert(m.detail && m.detail.length > 40, 'absence was reported as a blank space');
        assert(/no provenance segment/i.test(m.detail), 'the detail does not say what is missing');
        assertEqual(m.segments, 1, 'segment count reported alongside the absence');
        // Nothing is claimed and nothing is ticked.
        assertEqual(m.claims.length, 0, 'claims rendered for an absent document');
        assertEqual(m.counts.passed, 0, 'passes counted for an absent document');
        return 'absent state, ' + m.segments + ' segments walked, nothing ticked';
      });

      test('provenance: malformed provenance renders an error state rather than throwing', function () {
        var good = P.encode(populated(sha256(dataPayload)));
        var cases = [
          ['empty payload', new Uint8Array(0)],
          ['magic cleared', (function () { var b = Uint8Array.from(good); b[0] = 0; return b; })()],
          ['unknown version', (function () { var b = Uint8Array.from(good); b[4] = 9; return b; })()],
          ['truncated document', good.subarray(0, good.length - 8)],
          ['length lies', (function () {
            var b = Uint8Array.from(good);
            new DataView(b.buffer).setUint32(8, 0xffff, true);
            return b;
          })()],
          ['not JSON', (function () {
            var b = Uint8Array.from(good);
            for (var i = 12; i < b.length; i++) b[i] = 0x7b; // '{'
            return b;
          })()],
          ['trailing bytes', joinBytes([good, new Uint8Array([0, 0, 0, 0])])]
        ];
        for (var i = 0; i < cases.length; i++) {
          var container = joinBytes([
            segment(0x01, 1, dataPayload),
            segment(P.PROVENANCE_SEGMENT_TYPE, 2, cases[i][1])
          ]);
          var read = P.readContainer(container);
          var report = null;
          try {
            report = P.verify(read.provenance, container, { sha256: sha256 });
          } catch (e) {
            throw new Error(cases[i][0] + ': verify threw — ' + e.message);
          }
          var m;
          try {
            m = view.model(read, report);
          } catch (e) {
            throw new Error(cases[i][0] + ': the view model threw — ' + e.message);
          }
          assertEqual(m.state, view.UNREADABLE, cases[i][0] + ' state');
          assert(m.state !== view.ABSENT, cases[i][0] + ' was reported as an absence');
          assert(m.state !== view.PRESENT, cases[i][0] + ' was reported as readable');
          assert(m.detail && m.detail.length, cases[i][0] + ' gave no reason');
          assertEqual(m.counts.passed, 0, cases[i][0] + ' counted a pass');
          assertEqual(m.claims.length, 0, cases[i][0] + ' rendered claims');
        }
        // A reader that returns nothing at all is the same kind of news.
        assertEqual(view.model(null, null).state, view.UNREADABLE, 'a null read');
        assertEqual(view.model(undefined, undefined).state, view.UNREADABLE, 'an undefined read');
        return cases.length + ' malformed documents, each an error state, none thrown';
      });

      test('provenance: a container that cannot be walked is an error, not an absence', function () {
        // Truncated mid-payload: the chain runs off the end, so this app cannot
        // say whether provenance is present. Saying "no provenance" here would
        // be a claim about a file it failed to read.
        var container = joinBytes([segment(0x01, 1, dataPayload)]).subarray(0, 200);
        var read = P.readContainer(container);
        assertEqual(read.ok, false, 'the truncated chain was walked successfully');
        var m = view.model(read, null);
        assertEqual(m.state, view.UNREADABLE, 'state');
        assert(m.state !== view.ABSENT, 'an unreadable container was reported as unprovenanced');
        assertEqual(m.tone, view.FAIL, 'tone');
        return 'truncated chain reported as unreadable';
      });

      test('provenance: every block the document omits is stated, not left blank', function () {
        // An empty-but-valid provenance document. Each absent block must
        // produce a row that says it is absent — the same rule the codec
        // follows, where 0 means "none" because someone wrote it.
        var empty = P.emptyProvenance();
        empty.subject = { name: 'thing.bin', digest: { sha256: sha256(dataPayload) } };
        var container = joinBytes([
          segment(0x01, 1, dataPayload),
          segment(P.PROVENANCE_SEGMENT_TYPE, 2, P.encode(empty))
        ]);
        var read = P.readContainer(container);
        assertEqual(read.ok, true, 'decode: ' + read.reason);
        var m = view.model(read, P.verify(read.provenance, container, { sha256: sha256 }));
        assertEqual(m.state, view.PRESENT, 'state');
        assertEqual(m.components.length, 0, 'components listed for an empty SBOM');

        var labels = {};
        m.facts.forEach(function (f) { labels[f.label] = f; });
        ['Licences', 'Signer policy', 'Source revision', 'Build identity', 'Vulnerability assertions']
          .forEach(function (label) {
            assert(labels[label], label + ' is missing from the document summary');
            assertEqual(labels[label].absent, true, label + ' is not marked absent');
            assert(labels[label].value && labels[label].value.length,
              label + ' was rendered as a blank space');
          });
        // Silence about vulnerabilities is not an all-clear, and the wording
        // has to say so where a reader will see it.
        assert(/not an all-clear/.test(labels['Vulnerability assertions'].value),
          'an empty VEX list reads as an all-clear');

        // Nothing the document says was ticked, because it says nothing. The
        // one passing check is the container's own segment chain, which is a
        // fact about the file rather than about its provenance.
        var passed = m.checks.filter(function (c) { return c.status === view.PASS; });
        assertEqual(passed.length, 1, 'passing checks on an empty document');
        assertEqual(passed[0].name, 'Segment chain', 'the only pass should be the segment walk');
        assertEqual(m.counts.failed, 0, 'an empty document failed something');
        return Object.keys(labels).length + ' rows, each absence stated';
      });

      test('provenance: the panel reports what it could not check, without folding it into a pass', function () {
        // A component naming a segment this container does not have. The hash
        // cannot be recomputed, so it is neither a pass nor a silent omission.
        var p = P.emptyProvenance();
        p.sbom = {
          present: true,
          components: [{ name: 'ghost', version: '1', digest: { sha256: 'a'.repeat(64) }, segment: 99 }]
        };
        var container = joinBytes([
          segment(0x01, 1, dataPayload),
          segment(P.PROVENANCE_SEGMENT_TYPE, 2, P.encode(p))
        ]);
        var read = P.readContainer(container);
        var m = view.model(read, P.verify(read.provenance, container, { sha256: sha256 }));
        assertEqual(m.state, view.PRESENT, 'state');
        assertEqual(m.components.length, 1, 'component count');
        // verify() calls a component naming a segment outside the container a
        // failure, not an omission, and the row must carry that verdict rather
        // than a shrug.
        assertEqual(m.components[0].status, view.FAIL, 'a component naming a segment 99 that does not exist');
        assertEqual(m.tone, view.FAIL, 'tone');
        assert(m.components[0].detail.length, 'the row explains nothing');
        return 'a component bound to a segment that is not there fails loudly';
      });

      test('provenance: a document that does not re-encode canonically is reported, not corrected', function () {
        var canonical = new TextDecoder().decode(
          P.encode(populated(sha256(dataPayload))).subarray(12)
        );
        var doc = JSON.parse(canonical);
        // Re-serialise with the top-level keys in the opposite order: the same
        // claims, different bytes, so a hash over this provenance is not
        // reproducible from what it says.
        var reordered = {};
        Object.keys(doc).reverse().forEach(function (k) { reordered[k] = doc[k]; });
        var text = JSON.stringify(reordered);
        assert(text !== canonical, 'the fixture did not actually change the encoding');
        var body = new TextEncoder().encode(text);
        var payload = new Uint8Array(12 + body.length);
        payload.set([0x52, 0x56, 0x50, 0x56], 0);
        payload[4] = 1;
        new DataView(payload.buffer).setUint32(8, body.length, true);
        payload.set(body, 12);
        var container = joinBytes([
          segment(0x01, 1, dataPayload),
          segment(P.PROVENANCE_SEGMENT_TYPE, 2, payload)
        ]);
        var read = P.readContainer(container);
        assertEqual(read.ok, true, 'decode: ' + read.reason);
        var m = view.model(read, P.verify(read.provenance, container, { sha256: sha256 }));
        assertEqual(m.canonical, false, 'a reordered document was called canonical');
        assert(m.canonicalNote && m.canonicalNote.length, 'the panel says nothing about it');
        return 'non-canonical encoding surfaced rather than rewritten';
      });
    }

    // -- the delta strategy choice, as the send panel presents it -------------
    //
    // semdelta.test.js already asserts that chooseDelta() picks the smaller of
    // the two payloads. These assert that the panel tells the user which one it
    // picked, what both would have cost, and why — and that the size it quotes
    // is the size of the bytes the button actually ships. A strategy chosen
    // silently is a strategy nobody can debug, and a quoted size that came from
    // a different plan than the payload is worse than no size at all.

    var SD = mods.semdelta ||
      (typeof window !== 'undefined' ? window.RVQRSemDelta : null) || null;
    var DL = mods.delta ||
      (typeof window !== 'undefined' ? window.RVQRDelta : null) || null;
    var choiceView = (mods.view && mods.view.deltaChoice) ||
      (typeof window !== 'undefined' ? window.RVQRDeltaChoiceView : null) || null;

    if (mods.indexHtml) {
      test('delta choice: the page loads semdelta.js, so the module actually ships', function () {
        var html = mods.indexHtml;
        var tag = html.indexOf('src="./semdelta.js"');
        assert(tag >= 0, 'index.html does not reference semdelta.js at all');
        // The standalone build derives its script list by regex from this
        // document, so a module the page does not name is a module no user ever
        // receives — which is the whole reason this test exists.
        var line = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
        assert(line.indexOf('defer') >= 0, 'semdelta.js should be deferred with the optional modules');
        assert(/<script[^>]*src="\.\/semdelta\.js"/.test(line),
          'the tag is not the shape the build\'s regex matches: ' + line);

        // It reads RVQRDelta and RVQRCrypto at load time, and deferred scripts
        // run in document order, so it has to come after both.
        var afterDelta = html.indexOf('src="./delta.js"');
        var afterCrypto = html.indexOf('src="./crypto.js"');
        assert(afterDelta >= 0 && afterDelta < tag, 'semdelta.js is not loaded after delta.js');
        assert(afterCrypto >= 0 && afterCrypto < tag, 'semdelta.js is not loaded after crypto.js');
        return 'loaded, deferred, after both of its dependencies';
      });

      test('delta choice: the send panel offers the pairing step the sealed inventory needs', function () {
        var html = mods.indexHtml;
        // Every control the wiring reaches for by id. A missing one is a
        // TypeError on boot, not a missing feature.
        ['deltaPairStep', 'deltaPairBtn', 'deltaPairConfirmBtn', 'deltaPairImageBtn',
          'deltaPairImageInput', 'deltaPairReply', 'deltaPairResult'].forEach(function (id) {
          assert(html.indexOf('id="' + id + '"') >= 0, 'index.html has no #' + id);
        });
        // Inside the delta card rather than somewhere else on the page.
        var card = html.indexOf('id="deltaSendCard"');
        assert(card >= 0 && html.indexOf('id="deltaPairStep"') > card,
          'the pairing step is not inside the delta card');
        // And it reuses the page's own numbered-step register rather than
        // introducing a second one.
        assert(/<ol class="steps">[\s\S]{0,400}id="deltaPairStep"/.test(html),
          'the pairing step does not use the existing .steps list');
        return '7 controls, inside the delta card, in the existing step register';
      });
    }

    if (SD && DL && choiceView) {
      // Vec containers built here rather than read from disk so these tests need
      // no fixture and no kernel. The payload layout is the one semdelta.js
      // documents: u16 dim | u16 count | u16 flags | count × {u64 id, dim × f32}.
      var VEC_TYPE = 0x01;
      function vecRecord(id, dim, fill) {
        var r = new Uint8Array(8 + dim * 4);
        r[0] = id & 0xff; r[1] = (id >>> 8) & 0xff;
        r[2] = (id >>> 16) & 0xff; r[3] = (id >>> 24) & 0xff;
        for (var i = 8; i < r.length; i++) r[i] = (fill + i * 7) & 0xff;
        return r;
      }
      function vecContainer(dim, fills) {
        var stride = 8 + dim * 4;
        var payload = new Uint8Array(6 + stride * fills.length);
        payload[0] = dim & 0xff; payload[1] = (dim >>> 8) & 0xff;
        payload[2] = fills.length & 0xff; payload[3] = (fills.length >>> 8) & 0xff;
        for (var i = 0; i < fills.length; i++) {
          payload.set(vecRecord(i + 1, dim, fills[i]), 6 + i * stride);
        }
        var out = new Uint8Array(64 + payload.length);
        out.set([0x53, 0x46, 0x56, 0x52], 0); // 'SFVR'
        out[4] = 1;
        out[5] = VEC_TYPE;
        var dv = new DataView(out.buffer);
        dv.setUint32(8, 1, true);
        dv.setUint32(16, payload.length, true);
        out.set(payload, 64);
        return out;
      }
      function fillsOf(n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(i & 0xff);
        return out;
      }
      function withChanged(fills, count) {
        var out = fills.slice();
        for (var i = 0; i < count; i++) out[i] = (out[i] + 91) & 0xff;
        return out;
      }
      // dim 6 clears semdelta's 32-byte minimum unit, so records really are
      // decomposed rather than silently collapsing back to one span.
      var DIM = 6;
      function panel(sender, receiverBytes) {
        var chosen = SD.chooseDelta(sender, SD.semanticInventory(receiverBytes));
        return { chosen: chosen, model: choiceView.model(chosen, { formatBytes: core.formatBytes }) };
      }
      function labelled(model) {
        var out = {};
        model.rows.forEach(function (r) { out[r.label] = r; });
        return out;
      }

      test('delta choice: a slab with three records rewritten sends the semantic delta, and says so', function () {
        var base = fillsOf(200);
        var receiver = vecContainer(DIM, base);
        var sender = vecContainer(DIM, withChanged(base, 3));
        var p = panel(sender, receiver);

        assertEqual(p.chosen.chosen, 'semantic', 'strategy chosen');
        assertEqual(p.model.strategy, 'semantic', 'strategy the panel reports');

        // The headline names the strategy. A reader who takes in one line has
        // to take in which one ran.
        assert(p.model.headline.indexOf('Semantic delta') === 0,
          'the headline does not lead with the strategy: ' + p.model.headline);
        assert(p.model.headline.indexOf(core.formatBytes(p.chosen.bytes)) >= 0,
          'the headline does not carry the delta size: ' + p.model.headline);
        assert(p.model.headline.indexOf(core.formatBytes(p.chosen.fullBytes)) >= 0,
          'the headline does not carry the full size: ' + p.model.headline);

        // Both figures are on screen, whichever won. A panel that showed only
        // the winner would be unfalsifiable.
        var rows = labelled(p.model);
        assertEqual(p.model.rows.length, 3, 'row count');
        assertEqual(rows['Span delta'].text, core.formatBytes(p.chosen.spanBytes), 'span row');
        assertEqual(rows['Semantic delta'].text,
          core.formatBytes(p.chosen.semanticBytes) + ' — chosen', 'semantic row');
        assertEqual(rows['Full transfer'].text, core.formatBytes(p.chosen.fullBytes), 'full row');
        assertEqual(rows['Span delta'].chosen, false, 'the losing row is marked chosen');
        assertEqual(rows['Semantic delta'].chosen, true, 'the winning row is not marked chosen');

        // The explanation is semdelta's own sentence, unedited: the module that
        // made the choice is the one that describes it.
        assertEqual(p.model.reason, p.chosen.reason, 'the panel rewrote the reason');
        assert(/3 of \d+ units carried/.test(p.model.reason), 'reason: ' + p.model.reason);
        assertEqual(p.model.summary.indexOf('3 of ' + p.chosen.unitCount + ' units to send'), 0,
          'summary: ' + p.model.summary);

        // A real saving, and presented as one.
        assertEqual(p.model.tone, 'good', 'tone');
        assertEqual(p.model.note, null, 'a genuine saving carried a caveat: ' + p.model.note);
        assert(p.model.summary.indexOf('× less data') > 0, 'summary: ' + p.model.summary);
        return p.model.headline + ' / ' + p.model.summary;
      });

      test('delta choice: when the unit table costs more than it saves the span delta wins, and the panel says why', function () {
        // 60 of 100 records rewritten. The table costs 1414 bytes and saves
        // 1350, so the finer delta is the bigger one — the exact case
        // semdelta.js warns about, and the reason the comparison is measured
        // rather than assumed.
        var base = fillsOf(100);
        var receiver = vecContainer(DIM, base);
        var sender = vecContainer(DIM, withChanged(base, 60));
        var p = panel(sender, receiver);

        assertEqual(p.chosen.chosen, 'span', 'strategy chosen');
        assert(p.chosen.semanticBytes > p.chosen.spanBytes,
          'the fixture no longer makes the semantic delta the larger one');
        assertEqual(p.model.strategy, 'span', 'strategy the panel reports');
        assert(p.model.headline.indexOf('Span delta') === 0,
          'the headline does not lead with the strategy: ' + p.model.headline);

        var rows = labelled(p.model);
        assertEqual(rows['Span delta'].text,
          core.formatBytes(p.chosen.spanBytes) + ' — chosen', 'span row');
        assertEqual(rows['Semantic delta'].text, core.formatBytes(p.chosen.semanticBytes), 'semantic row');
        assertEqual(rows['Semantic delta'].chosen, false, 'the losing row is marked chosen');
        // The number the semantic delta would have cost is still on screen, so
        // the choice can be checked rather than taken on trust.
        assert(rows['Semantic delta'].bytes > rows['Span delta'].bytes,
          'the losing figure was not rendered');
        assert(/unit table costs \d+ bytes, more than the \d+ bytes of payload it saves/.test(p.model.reason),
          'the panel does not explain the guard: ' + p.model.reason);

        // This fixture also lands on the case where the winning delta is still
        // bigger than the container. It must not be dressed as a saving: no
        // encouraging tone, and a sentence saying plainly that sending the
        // whole artifact would be cheaper.
        assert(p.chosen.bytes > p.chosen.fullBytes, 'the fixture no longer exceeds a full transfer');
        assertEqual(p.model.tone, '', 'a delta larger than the artifact wore the good tone');
        assert(p.model.note && /smaller than the container itself/.test(p.model.note),
          'the panel does not say the delta costs more than the whole artifact');
        assert(p.model.summary.indexOf('0 B saved') > 0, 'summary: ' + p.model.summary);
        assert(p.model.summary.indexOf('× less data') < 0,
          'a delta larger than the artifact claimed a ratio: ' + p.model.summary);
        return p.model.headline + ' — ' + p.model.reason;
      });

      test('delta choice: the size the panel quotes is the size of the bytes the button sends', function () {
        // The button ships chosen.payload. If the panel quoted a figure derived
        // from anything else — a re-run of the losing plan, an estimate — this
        // is where it would part company from reality.
        var base = fillsOf(200);
        var cases = [
          ['semantic', vecContainer(DIM, base), vecContainer(DIM, withChanged(base, 3))],
          ['span', vecContainer(DIM, fillsOf(100)), vecContainer(DIM, withChanged(fillsOf(100), 60))]
        ];
        var notes = [];
        for (var i = 0; i < cases.length; i++) {
          var expect = cases[i][0], receiver = cases[i][1], sender = cases[i][2];
          var p = panel(sender, receiver);
          assertEqual(p.chosen.chosen, expect, 'strategy for the ' + expect + ' case');
          assertEqual(p.chosen.bytes, p.chosen.payload.length,
            'the quoted size is not the payload length (' + expect + ')');
          assert(p.model.headline.indexOf(core.formatBytes(p.chosen.payload.length)) >= 0,
            'the headline quotes something other than the payload it would send: ' + p.model.headline);

          // And those bytes really do rebuild the sender's container on a
          // device holding the receiver's. A quoted size for a payload that
          // does not reconstruct is a lie with a number attached.
          var rebuilt = SD.applyChosen(receiver, p.chosen);
          assertEqual(rebuilt.sha256, core.sha256Hex(sender), 'reconstruction (' + expect + ')');
          notes.push(expect + ' ' + p.chosen.payload.length + ' B');
        }
        return notes.join(', ') + ' — quoted, sent and reconstructed';
      });

      test('delta choice: a receiver holding everything still gets an honest comparison', function () {
        // Nothing to send. The span delta is a bare header; the semantic delta
        // is a bare header plus a table describing the whole container, so it
        // loses — and the panel must not present "no change" as a saving it
        // did not make.
        var same = vecContainer(DIM, fillsOf(100));
        var p = panel(same, same);
        assertEqual(p.chosen.chosen, 'span', 'strategy chosen');
        assertEqual(p.chosen.spanDiff.missing.length, 0, 'segments to send');
        assertEqual(p.chosen.unitDiff.missing.length, 0, 'units to send');
        assertEqual(p.model.summary.indexOf('0 of ' + p.chosen.spanCount + ' segments to send'), 0,
          'summary: ' + p.model.summary);
        var rows = labelled(p.model);
        assert(rows['Semantic delta'].bytes > rows['Span delta'].bytes,
          'the empty semantic delta was not the larger one');
        assertEqual(rows['Span delta'].chosen, true, 'the span row is not marked chosen');
        return p.model.headline + ' — ' + p.model.summary;
      });

      test('delta choice: a result the panel cannot describe renders nothing rather than something wrong', function () {
        // The panel is fed by a module that may not have loaded and by data
        // that ultimately arrived from another device. Neither may produce a
        // confident-looking figure out of nothing.
        assertEqual(choiceView.model(null, {}), null, 'null');
        assertEqual(choiceView.model({}, {}), null, 'an empty object');
        assertEqual(choiceView.model({ chosen: 'best', bytes: 10 }, {}), null, 'an unknown strategy');
        return '3 unusable results, no panel';
      });
    }

    // --- The transfer plan ----------------------------------------------------
    //
    // planner.test.js already asserts that plan() picks the right strategy and
    // that a hard rule cannot be outvoted. These assert something it cannot:
    // that the decision and the reasons behind it reach the screen.
    //
    // Every string checked below is a string the panel renders verbatim —
    // `headline` and `summary` go into the notice, each term's `label` and
    // `text` become a <dt>/<dd> pair, and each rejection's `label` and `text`
    // become another. Asserting on those rather than on the numbers behind them
    // is deliberate: this file has already shipped a regression that a test
    // reading an element's property could not see, because a property being
    // right is not the same fact as the right thing being displayed.

    var PL = mods.planner ||
      (typeof window !== 'undefined' ? window.RVQRPlanner : null) || null;
    var planView = (mods.view && mods.view.transferPlan) ||
      (typeof window !== 'undefined' ? window.RVQRTransferPlanView : null) || null;

    if (mods.indexHtml) {
      test('transfer plan: the page loads planner.js, so the module actually ships', function () {
        var html = mods.indexHtml;
        var tag = html.indexOf('src="./planner.js"');
        assert(tag >= 0, 'index.html does not reference planner.js at all');
        // The standalone build derives its script list by regex from this
        // document, so a tag of any other shape ships a page whose planner is
        // missing — which is how a module with a green suite reaches nobody.
        var line = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
        assert(/<script[^>]*src="\.\/planner\.js"/.test(line),
          'the tag is not the shape the build\'s regex matches: ' + line);
        assert(line.indexOf('defer') >= 0, 'planner.js should be deferred with the optional modules');

        // It reads RVQRCore at load time, so it has to follow core.js.
        var afterCore = html.indexOf('src="./core.js"');
        assert(afterCore >= 0 && afterCore < tag, 'planner.js is not loaded after core.js');
        // And before app.js, which reads the planner through a getter that
        // must not find an empty window on the send path.
        var appTag = html.indexOf('src="./app.js"');
        assert(appTag >= 0 && tag < appTag, 'planner.js is not loaded before app.js');
        return 'loaded, deferred, after core.js and before app.js';
      });

      test('transfer plan: the send settings offer the radio policy the rules filter on', function () {
        var html = mods.indexHtml;
        // Every control the wiring reaches for by id. A missing one is a
        // TypeError on boot, not a missing feature.
        ['radioPolicyRow', 'radioPick', 'radioNote'].forEach(function (id) {
          assert(html.indexOf('id="' + id + '"') >= 0, 'index.html has no #' + id);
        });
        // With the settings, because it is the operator's rule rather than the
        // planner's opinion — and inside the send card, not somewhere else.
        var card = html.indexOf('id="sendSettingsCard"');
        assert(card >= 0 && html.indexOf('id="radioPolicyRow"') > card,
          'the radio policy is not inside the send settings card');
        // Both of planner.js's policies, and offline the one you get by not
        // choosing: it is the only one this build can carry out.
        assert(/<option value="offline" selected>/.test(html),
          'offline-only is not the default radio policy');
        assert(html.indexOf('<option value="any">') >= 0, 'no option allows a radio link');
        return '3 controls in the send settings, offline-only by default';
      });
    }

    if (PL && planView) {
      // One situation, varied a field at a time, so each test changes exactly
      // the thing it is about. The numbers are a real container's shape: a
      // 1.6 MB artifact against a receiver holding 200 spans of it.
      function situation(over) {
        var s = {
          artifact: { bytes: 1651200, name: 'demo.rvf' },
          receiver: {
            holds: 'span', baseBytes: 1651200, spanCount: 200, unitCount: 0,
            decomposableBytes: 0, overlap: 0.99, baseConfidence: 1, supportsV2: false
          },
          link: { lossRate: 0, fps: 5, symbolBytes: 792 },
          device: { role: 'sender' },
          policy: { radio: 'offline', commit: true, allowPartialVerification: false },
          trust: { verified: true, pinnedKeyId: null, presentedKeyId: null }
        };
        Object.keys(over || {}).forEach(function (k) {
          s[k] = JSON.parse(JSON.stringify(s[k]));
          Object.keys(over[k]).forEach(function (f) { s[k][f] = over[k][f]; });
        });
        return s;
      }
      // The weights the app hands in: the planner's own constants, so a
      // re-weighted objective cannot leave this panel quoting the old split.
      var WEIGHTS = {
        T: PL.WEIGHT_TIME, E: PL.WEIGHT_ENERGY, B: PL.WEIGHT_BYTES, R: PL.WEIGHT_RISK
      };
      function panel(over) {
        var plan = PL.plan(situation(over));
        return { plan: plan, model: planView.model(plan, { weights: WEIGHTS }) };
      }
      function rowsByLabel(rows) {
        var out = {};
        rows.forEach(function (r) { out[r.label] = r; });
        return out;
      }

      test('transfer plan: the chosen strategy, its cost and all four terms reach the screen', function () {
        var p = panel();
        assert(p.plan.chosen, 'the fixture no longer admits any strategy');

        // The strategy leads the headline. A reader who takes in one line has
        // to take in what is about to happen.
        assertEqual(p.model.headline.indexOf(p.plan.chosen.label), 0,
          'the headline does not lead with the strategy: ' + p.model.headline);
        assert(p.model.headline.indexOf('J = ' + p.plan.J.toFixed(3)) > 0,
          'the headline does not carry J: ' + p.model.headline);

        // J alone is a bare number. It is a cost against one fixed reference —
        // what this app did before anybody chose anything — so the panel says
        // so rather than leaving a reader to guess the scale.
        assert(/^J = \d\.\d{3} — \d+% of what sending it the old way would have cost\.$/
          .test(p.model.scoreText), 'scoreText: ' + p.model.scoreText);

        // All four terms, each with the weight it carries, so a reader can see
        // which one cost this strategy the ranking instead of being handed a
        // total and trusted with it.
        assertEqual(p.model.terms.length, 4, 'term count');
        var terms = rowsByLabel(p.model.terms);
        assert(terms['Time (45% of J)'], 'no Time row: ' + Object.keys(terms).join(', '));
        assert(terms['Energy (20% of J)'], 'no Energy row');
        assert(terms['Bytes (20% of J)'], 'no Bytes row');
        assert(terms['Risk (15% of J)'], 'no Risk row');
        assertEqual(terms['Time (45% of J)'].text,
          p.plan.terms.T.toFixed(2) + ' × 0.45 = ' + (p.plan.terms.T * 0.45).toFixed(3),
          'the Time row');

        // The four displayed contributions add up to the displayed J, to the
        // precision they are displayed at. A panel whose parts do not sum to
        // its total is a panel nobody can check.
        var sum = 0;
        p.model.terms.forEach(function (r) { sum += Number(r.text.split('= ')[1]); });
        assert(Math.abs(sum - p.plan.J) < 0.002, 'terms sum to ' + sum + ', J is ' + p.plan.J);

        assertEqual(p.model.reason, p.plan.reason, 'the panel rewrote the planner\'s reason');
        assertEqual(p.model.ok, true, 'ok');
        assertEqual(p.model.runnable, true, 'runnable');
        return p.model.headline + ' / ' + p.model.scoreText;
      });

      test('transfer plan: rejected strategies are shown, in the words of the rule that killed them', function () {
        var p = panel();
        assert(p.plan.rejected.length > 0, 'the fixture no longer rejects anything');
        assertEqual(p.model.rejected.length, 1, 'rejection groups');

        var row = p.model.rejected[0];
        assertEqual(row.rule, PL.RULE_RADIO, 'the rule that fired');
        assertEqual(row.label, 'Radio policy', 'the rule label the panel shows');
        // The sentence is planner.js's own, unedited. A reason restated by the
        // UI is a reason that can drift away from the rule enforcing it.
        assertEqual(row.reason, p.plan.rejected[0].reason, 'the panel rewrote the reason');
        assertEqual(row.text,
          p.plan.rejected.length + ' strategies — policy is offline-only and this transport needs a radio',
          'the rejection row as displayed');

        // Grouping must not lose a rejection. Every candidate the rules threw
        // out is accounted for by exactly one row on screen.
        var counted = 0;
        p.model.rejected.forEach(function (r) { counted += r.count; });
        assertEqual(counted, p.plan.rejected.length, 'rejections reachable on screen');
        return row.text;
      });

      test('transfer plan: an unverified peer renders no transfer at all, and names the rule', function () {
        // The case the whole shape exists for. Nothing is admissible, so there
        // is no plan — and a blank panel here would be the app going quiet at
        // exactly the moment it has something to say.
        var p = panel({ trust: { verified: false } });
        assertEqual(p.plan.chosen, null, 'a strategy survived an unverified peer');
        assertEqual(p.model.ok, false, 'ok');
        assertEqual(p.model.runnable, false, 'runnable');
        assertEqual(p.model.strategy, null, 'strategy');
        assertEqual(p.model.headline, 'No transfer is possible.', 'headline');
        assertEqual(p.model.summary,
          'All ' + p.plan.candidateCount + ' strategies rvQR could use were blocked by a ' +
          'hard rule, so there is nothing left to send. Nothing was sent.', 'summary');
        assertEqual(p.model.tone, 'bad', 'a refusal wore an encouraging tone');

        // No score, no terms: there is nothing that was ranked, and printing a
        // J for a plan that does not exist would invent one.
        assertEqual(p.model.scoreText, null, 'scoreText');
        assertEqual(p.model.terms.length, 0, 'terms rendered for a plan that does not exist');

        // And the reason is on screen, in the rule's own words.
        assertEqual(p.model.rejected.length, 1, 'rejection groups');
        assertEqual(p.model.rejected[0].rule, PL.RULE_TRUST, 'the rule that fired');
        assertEqual(p.model.rejected[0].label, 'Trust', 'the rule label the panel shows');
        assertEqual(p.model.rejected[0].text,
          p.plan.candidateCount + ' strategies — the peer is not verified, and an ' +
          'unverified peer is not a transfer partner at any score',
          'the rejection row as displayed');
        assert(p.model.reason.indexOf('no strategy passed the hard rules') === 0,
          'reason: ' + p.model.reason);
        return p.model.headline + ' ' + p.model.rejected[0].text;
      });

      test('transfer plan: a peer presenting the wrong key is refused, and the panel says which', function () {
        // The pinned-fingerprint case, wired through from the session so that
        // pinning is enforced by the rule rather than by anybody remembering to
        // check it at the call site.
        var p = panel({ trust: { verified: true, pinnedKeyId: 'aaaa1111', presentedKeyId: 'bbbb2222' } });
        assertEqual(p.plan.chosen, null, 'a strategy survived a key mismatch');
        assertEqual(p.model.headline, 'No transfer is possible.', 'headline');
        assertEqual(p.model.rejected[0].rule, PL.RULE_TRUST, 'the rule that fired');
        assert(p.model.rejected[0].text.indexOf('presented bbbb2222 where aaaa1111 is pinned') > 0,
          'the panel does not say which key turned up: ' + p.model.rejected[0].text);
        return p.model.rejected[0].text;
      });

      test('transfer plan: a plan needing a radio is described, and not offered as a send', function () {
        // planner.js ranks a peer radio link because a planner should describe
        // the world rather than this build. rvQR has no radio, so the panel
        // reports the plan and the caller offers no button for it.
        var p = panel({ policy: { radio: PL.RADIO_ANY, commit: true, allowPartialVerification: false } });
        assertEqual(p.plan.chosen.transport, 'peer', 'the fixture no longer picks the radio link');
        assertEqual(p.model.ok, true, 'ok — a strategy was chosen');
        assertEqual(p.model.runnable, false, 'runnable');
        assertEqual(p.model.tone, '', 'a plan this build cannot run wore the good tone');
        assert(p.model.note && /rvQR has no radio transport/.test(p.model.note),
          'the panel does not say the plan cannot be run: ' + p.model.note);
        // Still described in full: the operator changed a policy and this is
        // what it bought them.
        assertEqual(p.model.terms.length, 4, 'terms');
        assertEqual(p.model.headline.indexOf(p.plan.chosen.label), 0, 'headline');
        return p.model.headline + ' — ' + p.model.note;
      });

      test('transfer plan: a cold receiver and a stocked one are planned differently, and both say so', function () {
        // "Whether the receiver reported an inventory" is an input, not a
        // formality: a receiver that published nothing bounds the sender to
        // whole-artifact strategies, and the panel must not offer a delta
        // against a table nobody has.
        var cold = panel({ receiver: { holds: 'none', spanCount: 0, overlap: 0 } });
        assertEqual(cold.plan.chosen.granularity, PL.GRANULARITY_FULL,
          'a delta was planned against a receiver that published nothing');
        assert(cold.model.headline.indexOf('whole artifact') > 0,
          'the headline does not say the whole artifact goes: ' + cold.model.headline);

        var warm = panel();
        assert(warm.plan.chosen.granularity !== PL.GRANULARITY_FULL,
          'no delta was planned against a receiver holding 99% of it');
        assert(warm.model.headline.indexOf('delta') > 0,
          'the headline does not name the delta road: ' + warm.model.headline);
        // And the cheaper plan is the one against the receiver that already
        // holds most of it, which is the whole reason to ask.
        assert(warm.plan.J < cold.plan.J, 'the delta plan did not score better than the full one');
        return cold.model.headline + ' | ' + warm.model.headline;
      });

      test('transfer plan: nothing that is not a plan produces a panel', function () {
        // The panel is fed by a module that may not have loaded and by a
        // situation built partly from another device's inventory. Neither may
        // produce a confident-looking strategy out of nothing.
        assertEqual(planView.model(null, {}), null, 'null');
        assertEqual(planView.model({}, {}), null, 'an empty object');
        assertEqual(planView.model({ chosen: { label: 'x' } }, {}), null, 'a plan with no rejected list');
        assertEqual(planView.model('a plan', {}), null, 'a string');
        return '4 unusable results, no panel';
      });
    }

    // --- Compression ----------------------------------------------------------
    //
    // compress.test.js already asserts that the gate is applied to the envelope
    // and not to the ratio, and that an identifier determines a decoder. These
    // assert something it cannot: that the decision, BOTH of its figures, and
    // every refusal behind it reach the screen.
    //
    // Every string checked below is a string the panel renders verbatim — the
    // headline and summary go into the notice, each gain row's `label` and
    // `text` become a <dt>/<dd> pair, each codec row and each absent codec
    // become another, and `platform`, `gapText`, `wireNote`, `sampleNote` and
    // `reason` are each a paragraph. Asserting on those rather than on the
    // numbers behind them is deliberate: this file has already shipped a
    // regression that a test reading an element's property could not see.
    //
    // The measurements are REAL. compress.js takes its codecs by injection
    // precisely so a caller can hand it the platform's own, and node:zlib is
    // this runner's; where a browser is the thing under test, the PLATFORM is
    // faked through detectCodecs()'s injectable env and the codec behind it is
    // still real zlib. Nothing here stubs a compression ratio.

    var CMP = mods.compress ||
      (typeof window !== 'undefined' ? window.RVQRCompress : null) || null;
    var cmpView = (mods.view && mods.view.compression) ||
      (typeof window !== 'undefined' ? window.RVQRCompressionView : null) || null;

    if (mods.indexHtml) {
      test('compression: the page loads compress.js, so the module actually ships', function () {
        var html = mods.indexHtml;
        var tag = html.indexOf('src="./compress.js"');
        assert(tag >= 0, 'index.html does not reference compress.js at all');
        // The standalone build derives its script list by regex from this
        // document, so a tag of any other shape ships a page whose compression
        // decision is missing — which is how a module with a green suite
        // reaches nobody.
        var line = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
        assert(/<script[^>]*src="\.\/compress\.js"/.test(line),
          'the tag is not the shape the build\'s regex matches: ' + line);
        assert(line.indexOf('defer') >= 0, 'compress.js should be deferred with the optional modules');

        // It reads RVQRCore at load time, so it has to follow core.js.
        var afterCore = html.indexOf('src="./core.js"');
        assert(afterCore >= 0 && afterCore < tag, 'compress.js is not loaded after core.js');
        // And before app.js, which reaches it through a getter on the send path.
        var appTag = html.indexOf('src="./app.js"');
        assert(appTag >= 0 && tag < appTag, 'compress.js is not loaded before app.js');
        return 'loaded, deferred, after core.js and before app.js';
      });

      test('compression: the send tab shows the decision where it cannot be missed', function () {
        var html = mods.indexHtml;
        ['compressCard', 'compressResult'].forEach(function (id) {
          assert(html.indexOf('id="' + id + '"') >= 0, 'index.html has no #' + id);
        });
        var sendTab = html.indexOf('id="tab-send"');
        var receiveTab = html.indexOf('id="tab-receive"');
        var card = html.indexOf('id="compressCard"');
        assert(sendTab >= 0 && card > sendTab && card < receiveTab,
          'the compression card is not inside the send tab');
        // After the stage whose bytes it describes, and before the delta
        // controls, which are a thing you go and do rather than a thing that
        // was already decided for you.
        assert(html.indexOf('id="sendStageCard"') < card,
          'the compression card does not follow the stage it describes');
        assert(card < html.indexOf('id="deltaSendCard"'),
          'the compression card is inside or after the delta controls');

        // A plain card and NOT a <details>. The outcome that matters most is a
        // refusal, and a refusal folded behind a summary nobody opens is a
        // refusal nobody sees — which is the same failure as not rendering it.
        var open = html.lastIndexOf('<', card);
        assertEqual(html.slice(open, card).indexOf('<div'), 0,
          'the compression card is not a plain div: ' + html.slice(open, card));
        return 'a plain card in the send tab, after the stage and before the delta controls';
      });
    }

    // node:zlib is what makes these measurements real rather than asserted. A
    // browser has none of it, which is itself one of the cases under test —
    // see the platform tests, which fake the PLATFORM and keep the codec real.
    if (CMP && cmpView && mods.zlib) {
      var zlib = mods.zlib;

      function zlibCodecs() {
        var map = {
          'deflate-raw': {
            compress: function (b) { return new Uint8Array(zlib.deflateRawSync(Buffer.from(b))); }
          }
        };
        if (typeof zlib.brotliCompressSync === 'function') {
          map.brotli = { compress: function (b) { return new Uint8Array(zlib.brotliCompressSync(Buffer.from(b))); } };
        }
        if (typeof zlib.zstdCompressSync === 'function') {
          map.zstd = { compress: function (b) { return new Uint8Array(zlib.zstdCompressSync(Buffer.from(b))); } };
        }
        return map;
      }

      function decide(bytes, over) {
        var opts = { env: { zlib: zlib }, codecs: zlibCodecs() };
        Object.keys(over || {}).forEach(function (k) { opts[k] = over[k]; });
        return CMP.compressArtifact(bytes, opts);
      }

      // The same two arguments app.js hands the model: the page's own byte
      // formatter, and the header constant the envelope was computed with, so
      // the caption explaining the gap quotes the number behind it.
      function panel(decision) {
        return cmpView.model(decision, {
          formatBytes: core.formatBytes,
          headerBytes: CMP.HEADER_BYTES
        });
      }

      function byLabel(rows) {
        var out = {};
        rows.forEach(function (r) { out[r.label] = r; });
        return out;
      }

      var PAYLOAD_LABEL = 'Payload gain — the codec’s number';
      var ENVELOPE_LABEL = 'Envelope gain — what the receiver waits through';
      function figure(row) { return row.text.split(' ')[0]; }

      // A deterministic artifact with the structure a codec actually sees in
      // one: a repeated record with a counter in it. Used where the demo WASM
      // module is not on disk, so the suite does not depend on a fixture file.
      function structured(n) {
        var out = new Uint8Array(n);
        for (var i = 0; i < n; i++) {
          out[i] = (i % 96) < 80 ? 0x41 + ((i % 96) % 23) : (Math.floor(i / 96) & 0xff);
        }
        return out;
      }
      var subject = mods.demoWasm && mods.demoWasm.length ? mods.demoWasm : structured(48000);

      /**
       * Deterministic bytes with nothing in them a codec can find.
       *
       * Not this suite's shared rndBytes(): its multiply runs past 2^53 and
       * loses the low bits, and the result compresses by about 40% — measured,
       * after it silently turned the refusal test below into a passing
       * compression. This is xorshift128, which is exact in 32-bit integer
       * arithmetic. Brotli returns 40,004 bytes for 40,000 of it.
       */
      function noiseBytes(n) {
        var x = 0x9e3779b9, y = 0x243f6a88, z = 0xb7e15162, w = 0x0f1e2d3c;
        var out = new Uint8Array(n);
        for (var i = 0; i < n; i++) {
          var t = x ^ (x << 11);
          x = y; y = z; z = w;
          w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
          out[i] = w & 0xff;
        }
        return out;
      }

      test('compression: both figures reach the screen, and they are not the same figure', function () {
        var d = decide(subject);
        assertEqual(d.compress, true, 'the fixture no longer compresses at all');
        var m = panel(d);

        assertEqual(m.gains.length, 2, 'gain rows');
        var g = byLabel(m.gains);
        assert(g[PAYLOAD_LABEL], 'no payload row: ' + Object.keys(g).join(' | '));
        assert(g[ENVELOPE_LABEL], 'no envelope row: ' + Object.keys(g).join(' | '));

        // Two percentages, displayed separately, and DIFFERENT. A panel that
        // showed one of them would hide the disagreement this whole module
        // exists to act on.
        var pf = figure(g[PAYLOAD_LABEL]);
        var ef = figure(g[ENVELOPE_LABEL]);
        assert(/^-?\d+\.\d\d%$/.test(pf), 'the payload figure is not a percentage: ' + g[PAYLOAD_LABEL].text);
        assert(/^-?\d+\.\d\d%$/.test(ef), 'the envelope figure is not a percentage: ' + g[ENVELOPE_LABEL].text);
        assert(pf !== ef, 'the two figures are identical, so the panel shows no gap: ' + pf);
        assert(Number(pf.slice(0, -1)) > Number(ef.slice(0, -1)),
          'the envelope gain is not the smaller of the two: payload ' + pf + ', envelope ' + ef);

        // Each figure is compress.js's own, not one this panel recomputed:
        // both appear verbatim inside the sentence that module wrote.
        assert(d.best.reason.indexOf('payload ' + pf) > 0,
          'the payload figure is not the module\'s: ' + d.best.reason);
        assert(d.best.reason.indexOf('envelope ' + ef) > 0,
          'the envelope figure is not the module\'s: ' + d.best.reason);

        // The envelope row carries the wire bytes and the frames, because a
        // percentage on its own cannot be checked against anything.
        assert(g[ENVELOPE_LABEL].text.indexOf(
          d.best.envelopeBefore + ' B became ' + d.best.envelopeAfter + ' B') > 0,
          'the envelope row does not carry the byte counts: ' + g[ENVELOPE_LABEL].text);
        assert(g[PAYLOAD_LABEL].text.indexOf(
          d.best.originalBytes + ' B of artifact became ' + d.best.compressedBytes + ' B') > 0,
          'the payload row does not carry the byte counts: ' + g[PAYLOAD_LABEL].text);

        // And the caption under them agrees with the two figures it sits under,
        // to the precision they are displayed at.
        var gap = (Number(pf.slice(0, -1)) - Number(ef.slice(0, -1))).toFixed(2);
        assert(m.gapText.indexOf('differ by ' + gap + ' points') > 0, 'gapText: ' + m.gapText);
        assert(m.gapText.indexOf(CMP.HEADER_BYTES + ' B header') > 0,
          'the caption does not name what the gap is made of: ' + m.gapText);
        return pf + ' payload, ' + ef + ' envelope, ' + gap + ' points apart';
      });

      test('compression: a codec that clears the gate and cannot cross the wire says both', function () {
        // ADR-003 §2.1 numbers zstd 2, brotli 4 and deflate-raw 6; proto2.js
        // ships a four-entry table that means different codecs by 1, 2 and 3
        // and refuses anything past it. So a winner today is a winner that
        // cannot be put on a frame, and the panel has to carry both facts —
        // "this compresses well" and "this transfer would be rejected on the
        // first frame" are different news.
        var d = decide(subject);
        assertEqual(d.compress, true, 'the fixture no longer compresses');
        assertEqual(d.wire.ok, false,
          'proto2.js now agrees with ADR-003 §2.1 — the send path can carry a codec and should');
        var m = panel(d);

        assertEqual(m.ok, true, 'ok — a codec did clear the gate');
        assertEqual(m.sendable, false, 'sendable');
        assertEqual(m.tone, '', 'a transfer that is not actually compressed wore the good tone');
        assertEqual(m.headline, d.codecName + ' clears the gate, and cannot be put on a frame.',
          'headline');
        // What actually happens, in compress.js's own vocabulary for an
        // uncompressed transfer.
        assertEqual(m.summary, 'The artifact goes as it stands: ' +
          core.formatBytes(d.originalBytes) + ', codec id 0, transport hash equal to content hash.',
          'summary');
        // The verdict is the module's sentence, unedited, and it names the id.
        assertEqual(m.wireNote, d.wire.reason, 'the panel rewrote the wire verdict');
        assert(m.wireNote.indexOf('codec id ' + d.codecId) > 0,
          'the wire note does not say which id: ' + m.wireNote);
        return m.headline + ' ' + m.wireNote;
      });

      test('compression: incompressible bytes are refused, and the panel shows the envelope growing', function () {
        var noise = noiseBytes(40000);
        var d = decide(noise);
        assertEqual(d.compress, false, 'random bytes compressed');
        assertEqual(d.codecId, CMP.CODEC_NONE, 'codec id');
        var m = panel(d);

        assertEqual(m.ok, false, 'ok');
        assertEqual(m.sendable, false, 'sendable');
        assertEqual(m.headline, 'Not compressed: nothing clears the 8.00% envelope gate.', 'headline');
        assertEqual(m.summary, 'The artifact goes as it stands: ' + core.formatBytes(40000) +
          ', codec id 0, transport hash equal to content hash.', 'summary');

        // A refusal is a MEASUREMENT and is rendered as one. Both figures are
        // still on screen and both are negative — the alternative, an empty
        // panel, is indistinguishable from a module that never ran.
        assertEqual(m.gains.length, 2, 'gain rows');
        var g = byLabel(m.gains);
        assertEqual(figure(g[PAYLOAD_LABEL]).charAt(0), '-',
          'the payload gain is not shown as negative: ' + g[PAYLOAD_LABEL].text);
        assertEqual(figure(g[ENVELOPE_LABEL]).charAt(0), '-',
          'the envelope gain is not shown as negative: ' + g[ENVELOPE_LABEL].text);

        // The envelope GREW, and the row says by how much and that no frame
        // was saved for it.
        var best = null;
        d.considered.forEach(function (c) { if (!best || c.envelopeGain > best.envelopeGain) best = c; });
        assert(best.envelopeAfter > best.envelopeBefore,
          'the fixture no longer grows the envelope: ' + best.envelopeBefore + ' → ' + best.envelopeAfter);
        assert(g[ENVELOPE_LABEL].text.indexOf(
          best.envelopeBefore + ' B became ' + best.envelopeAfter + ' B') > 0,
          'the envelope row does not show the growth: ' + g[ENVELOPE_LABEL].text);
        assert(g[ENVELOPE_LABEL].text.indexOf('no frame saved') > 0,
          'the envelope row does not say no frame was saved: ' + g[ENVELOPE_LABEL].text);

        // Every codec that was tried is on screen with its own sentence, each
        // saying what its attempt would have COST to send.
        assertEqual(m.rows.length, d.considered.length, 'codec rows');
        m.rows.forEach(function (r) {
          assert(r.text.indexOf('the envelope did not shrink at all, so this costs') > 0,
            'a refused codec\'s row does not say what it costs: ' + r.label + ' — ' + r.text);
        });
        assertEqual(m.reason, d.reason, 'the panel rewrote the decision\'s reason');
        return g[ENVELOPE_LABEL].text;
      });

      test('compression: a browser with neither brotli nor zstd says what it does have', function () {
        // The platform every receiver of this app actually runs on: no
        // node:zlib at all, and a CompressionStream whose format list is the
        // WHATWG one. The PLATFORM is faked here through detectCodecs()'s own
        // injectable env; the codec behind deflate-raw is still real zlib, so
        // the figures on the panel are measured rather than asserted.
        var ok = ['gzip', 'deflate', 'deflate-raw'];
        function Streams(format) { if (ok.indexOf(format) < 0) throw new Error('unsupported format'); }
        var det = CMP.detectCodecs({ CompressionStream: Streams, DecompressionStream: Streams });

        assertEqual(det.available.length, 1, 'a browser offered more than one codec');
        assertEqual(det.available[0].name, 'deflate-raw', 'the one codec a browser has');
        assertEqual(det.available[0].via, 'CompressionStream', 'how it has it');

        var d = decide(subject, { detection: det });
        var m = panel(d);

        assertEqual(m.platform, 'This platform offers deflate-raw via CompressionStream. ' +
          'It does not offer zstd or brotli — each one’s own reason is below.', 'platform');
        assert(m.platform.indexOf('brotli via') < 0,
          'the panel claimed a codec the browser does not have: ' + m.platform);

        // Each absent codec's own sentence, unedited. The brotli one is the
        // one worth reading twice: a CompressionStream that accepts 'brotli'
        // is a Node extension and is not evidence of browser brotli.
        assertEqual(m.missing.length, 2, 'missing rows');
        var miss = byLabel(m.missing);
        assert(miss.zstd.text.indexOf('no browser exposes zstd through CompressionStream') > 0,
          'zstd row: ' + miss.zstd.text);
        assert(miss.brotli.text.indexOf('is a Node extension and is not evidence of browser brotli') > 0,
          'brotli row: ' + miss.brotli.text);

        // And it still decided, on the one codec it has, with both figures.
        assertEqual(m.rows.length, 1, 'codec rows');
        assertEqual(m.rows[0].label, 'deflate-raw', 'the codec that ran');
        assertEqual(m.gains.length, 2, 'gain rows');
        return m.platform + ' → ' + figure(byLabel(m.gains)[ENVELOPE_LABEL]) + ' envelope';
      });

      test('compression: a platform with no codec at all is a decision, not a failure', function () {
        var det = CMP.detectCodecs({});
        assertEqual(det.anyAvailable, false, 'something was available on an empty platform');
        var d = decide(subject, { detection: det });
        var m = panel(d);

        assertEqual(m.ok, false, 'ok');
        assertEqual(m.headline, 'Not compressed: this platform has no codec to try.', 'headline');
        // No figures, because no encode happened. Printing a gain for a codec
        // that never ran would put a number on the panel nothing produced.
        assertEqual(m.gains.length, 0, 'figures shown for encodes that never happened');
        assertEqual(m.gapText, null, 'a gap caption with no figures above it');
        assertEqual(m.rows.length, 0, 'codec rows');
        assertEqual(m.platform, 'This platform offers no codec at all, so nothing was tried ' +
          'and the artifact goes as it stands.', 'platform');
        // The three codecs that have an implementation somewhere each say why
        // they are not here, rather than being silently absent.
        assertEqual(m.missing.length, 3, 'missing rows');
        assertEqual(m.reason.indexOf('no codec was available, so the artifact goes as it stands'), 0,
          'reason: ' + m.reason);
        return m.headline;
      });

      test('compression: a decision taken from a sample says so, and does not imply a fast estimate', function () {
        // The above-8 MB branch, reached at this size through compress.js's own
        // sampleAbove parameter rather than by building an 8 MB fixture.
        var d = decide(subject, { sampleAbove: 1024, samplePrefix: 2048 });
        assertEqual(d.sampled, true, 'the sampled branch was not taken');
        var m = panel(d);
        assertEqual(m.sampleNote.indexOf('Measured on a 2048 B prefix first'), 0,
          'sampleNote: ' + m.sampleNote);
        // ADR-003 §2.3 wants that prefix encoded at a FAST level, which is the
        // caller's to supply and this one did not. Saying so is the difference
        // between a report and a claim.
        assert(m.sampleNote.indexOf('at the SAME level as the full encode') > 0,
          'the panel implied a fast estimate that never ran: ' + m.sampleNote);
        return m.sampleNote;
      });

      test('compression: codecs declined on a sample are on screen, not counted as zero', function () {
        var noise = noiseBytes(40000);
        var d = decide(noise, { sampleAbove: 1024, samplePrefix: 2048 });
        assertEqual(d.compress, false, 'random bytes compressed');
        assertEqual(d.considered.length, 0, 'a codec was encoded in full after its estimate lost');
        assert(d.declined.length > 0, 'nothing was declined on the sample');
        var m = panel(d);

        assertEqual(m.headline, 'Not compressed: nothing clears the 8.00% envelope gate.',
          'headline — a codec existed, its estimate lost');
        assertEqual(m.gains.length, 0, 'figures shown for a full encode that never happened');
        assertEqual(m.rows.length, d.declined.length, 'codec rows');
        m.rows.forEach(function (r) {
          assert(r.text.indexOf('so the whole artifact was never encoded') > 0,
            'a declined codec\'s row does not say it was never encoded: ' + r.label + ' — ' + r.text);
        });
        return m.rows.length + ' declined on a 2048 B sample, all on screen';
      });

      test('compression: a v1 send is told the envelope is not its own framing', function () {
        // compress.js's envelope is v2's geometry, restated from proto2.js. On
        // a v2 send that IS the transport. On a v1 send it is not — a v1 frame
        // is JSON with a base64 payload and carries more per chunk, and more
        // fixed overhead means a SMALLER envelope gain for the same payload
        // saving. Presenting the v2 figure to a v1 sender without saying so
        // would be presenting an upper bound as a measurement.
        var d = decide(subject, { chunk: 512 });

        var v2 = cmpView.model(d, {
          formatBytes: core.formatBytes,
          headerBytes: CMP.HEADER_BYTES,
          manifestBytes: CMP.MANIFEST_FIXED_BYTES,
          v2Frames: true
        });
        assertEqual(v2.geometryNote,
          'Envelope modelled at 512 B per frame, which is the framing this send uses.',
          'the v2 note');

        var v1 = cmpView.model(d, {
          formatBytes: core.formatBytes,
          headerBytes: CMP.HEADER_BYTES,
          manifestBytes: CMP.MANIFEST_FIXED_BYTES,
          v2Frames: false
        });
        assertEqual(v1.geometryNote, 'Envelope modelled at 512 B per frame, on v2 binary ' +
          'frames — a ' + CMP.HEADER_BYTES + ' B header, a ' + CMP.MANIFEST_FIXED_BYTES +
          ' B manifest and 8/7 ASCII armour. This send is v1 JSON, which carries more per ' +
          'chunk, so the envelope gain above is an upper bound on what a v1 transfer would ' +
          'actually save.', 'the v1 note');
        // The two figures themselves are untouched by which framing is in use:
        // only the caption changes, because only the caveat changed.
        assertEqual(v1.gains[1].text, v2.gains[1].text, 'the envelope row moved with the caption');
        return v1.geometryNote;
      });

      test('compression: nothing that is not a decision produces a panel', function () {
        // The panel is fed by a module that may not have loaded and by a codec
        // shim that may have thrown. Neither may produce a confident-looking
        // percentage out of nothing.
        assertEqual(cmpView.model(null, {}), null, 'null');
        assertEqual(cmpView.model({}, {}), null, 'an empty object');
        assertEqual(cmpView.model({ compress: true }, {}), null, 'a decision with no considered list');
        assertEqual(cmpView.model({ considered: [] }, {}), null, 'a decision with no verdict');
        assertEqual(cmpView.model('compressed', {}), null, 'a string');
        return '5 unusable results, no panel';
      });
    }

    // --- Device attestation ----------------------------------------------------
    //
    // attest.test.js already asserts that the verifier cannot decide, that the
    // gate cannot be fed raw claims, and that an unrecognised state fails
    // closed. These assert what it cannot: that the two answers reach the screen
    // AS TWO, that the three outcomes of ADR-021 §4.3 are told apart there, that
    // the privacy trade §4.7 wants is on screen before the feature can be
    // enabled, and that no root of trust is ever shown as available.
    //
    // Every string checked below is a string the panel renders verbatim — the
    // badge and headline go into the notice, `verdict.label`/`verdict.text` and
    // `decision.label`/`decision.text` become the two <dl>s, each unmet rule and
    // each root become another <dt>/<dd> pair, and `privacy`, `separationNote`,
    // `challengeNote`, `rootsNote`, `reachabilityNote` and `custodyNote` are
    // each a paragraph. Asserting on those rather than on the objects behind
    // them is the same choice the compression tests make and for the same
    // reason: a plausible-looking screen is only catchable at the screen.
    //
    // The verdicts are REAL. Nothing below hand-builds a verdict object; each
    // one comes out of verifyAttestation() over evidence in the module's own
    // format, and the one attested case reaches that state the only way it can
    // — through the injected `verifyChain` predicate attest.js exists to take
    // from a caller that has a root of trust. app.js injects none, which is
    // itself asserted.

    var ATT = mods.attest ||
      (typeof window !== 'undefined' ? window.RVQRAttest : null) || null;
    var attView = (mods.view && mods.view.attestation) ||
      (typeof window !== 'undefined' ? window.RVQRAttestationView : null) || null;

    if (mods.indexHtml) {
      test('attestation: the page loads attest.js, so the module actually ships', function () {
        var html = mods.indexHtml;
        var tag = html.indexOf('src="./attest.js"');
        assert(tag >= 0, 'index.html does not reference attest.js at all');
        // The standalone build derives its script list by regex from this
        // document, so a tag of any other shape ships a page with no
        // attestation panel — which is how a module with 37 green tests reaches
        // nobody, the state this increment exists to leave.
        var line = html.slice(html.lastIndexOf('<script', tag), html.indexOf('>', tag) + 1);
        assert(/<script[^>]*src="\.\/attest\.js"/.test(line),
          'the tag is not the shape the build\'s regex matches: ' + line);
        assert(line.indexOf('defer') >= 0, 'attest.js should be deferred with the optional modules');

        var afterCore = html.indexOf('src="./core.js"');
        assert(afterCore >= 0 && afterCore < tag, 'attest.js is not loaded after core.js');
        var appTag = html.indexOf('src="./app.js"');
        assert(appTag >= 0 && tag < appTag, 'attest.js is not loaded before app.js');
        return 'loaded, deferred, after core.js and before app.js';
      });

      test('attestation: the send tab shows the decision where it cannot be missed', function () {
        var html = mods.indexHtml;
        ['attestCard', 'attestPrivacy', 'attestPolicyPick', 'attestClassPick',
          'attestGrant', 'attestEvidence', 'attestCheckBtn', 'attestResult',
          'attestRoots'].forEach(function (id) {
          assert(html.indexOf('id="' + id + '"') >= 0, 'index.html has no #' + id);
        });
        var sendTab = html.indexOf('id="tab-send"');
        var receiveTab = html.indexOf('id="tab-receive"');
        var card = html.indexOf('id="attestCard"');
        assert(sendTab >= 0 && card > sendTab && card < receiveTab,
          'the attestation card is not inside the send tab');
        // After the pairing step, because the receiver it talks about is the
        // device paired up there, and a grant is made to that identity.
        assert(html.indexOf('id="deltaSendCard"') < card,
          'the attestation card does not follow the pairing step it names');

        // A plain card and NOT a <details>. An undeclared policy is refused BY
        // DESIGN, and a refusal folded behind a summary nobody opens is a
        // refusal nobody sees.
        var open = html.lastIndexOf('<', card);
        assertEqual(html.slice(open, card).indexOf('<div'), 0,
          'the attestation card is not a plain div: ' + html.slice(open, card));
        return 'a plain card in the send tab, under the pairing step';
      });

      test('attestation: the privacy notice sits above every control that could enable it', function () {
        // ADR-021 §4.7 wants the trade documented "before attestation is
        // enabled". In the document that means above; in the model it means
        // canDeclare, tested below. Both, because either alone is escapable.
        var html = mods.indexHtml;
        var privacy = html.indexOf('id="attestPrivacy"');
        ['attestPolicyPick', 'attestClassPick', 'attestGrant', 'attestEvidence', 'attestCheckBtn']
          .forEach(function (id) {
            var control = html.indexOf('id="' + id + '"');
            assert(privacy < control,
              '#' + id + ' comes before the privacy notice, so the trade is disclosed after the fact');
          });
        // And above the panel that reports outcomes, so it is not something the
        // operator scrolls past on the way to a verdict.
        assert(privacy < html.indexOf('id="attestResult"'), 'the notice follows the results');
        return 'above all five controls and the result panel';
      });

      test('attestation: no root of trust is offered as a choice anywhere on the page', function () {
        // ADR-021 §2.1's four are unexercised, every one of them. A picker
        // offering "TPM 2.0" would be the UI claiming a capability the module
        // disclaims in describeRoots() two files away — so there is no such
        // control, and this is what keeps one from arriving later.
        var html = mods.indexHtml;
        var options = html.match(/<option[^>]*>[^<]*<\/option>/g) || [];
        ['dice', 'tpm2', 'tpm 2.0', 'secure enclave', 'secure-enclave',
          'android-key', 'android hardware'].forEach(function (name) {
          options.forEach(function (opt) {
            assert(opt.toLowerCase().indexOf(name) < 0,
              'a root of trust is offered as a choice: ' + opt);
          });
        });
        return options.length + ' options on the page, none of them a root of trust';
      });
    }

    if (ATT && attView) {
      // The sender's half of the binding, and the only outside data the
      // verifier takes. The session id and the challenge are the app's; the
      // policy is never in this object, by construction.
      var EXPECT = { sessionId: 'session-1', nonce: 'challenge-1' };

      /**
       * Evidence in the module's own format. The measurement is a real digest
       * shape — even-length lowercase hex — because parseEvidence refuses
       * anything else, and a fixture that could not be read would test the
       * malformed path while claiming to test the attested one.
       */
      function evidence(over) {
        var ev = {
          root: ATT.ROOT_DICE,
          deviceId: 'device-a',
          sessionId: EXPECT.sessionId,
          nonce: EXPECT.nonce,
          measurement: '9f2c4e7a1b0d3856',
          policyEpoch: 12,
          signerSetId: 'fleet-signers-2026',
          storageClasses: ['credential', 'generic']
        };
        Object.keys(over || {}).forEach(function (k) { ev[k] = over[k]; });
        return ev;
      }

      /** A policy whose four preconditions the evidence above satisfies. */
      function fullPolicy(over) {
        var p = {
          requireAttestation: true,
          trustedSignerSets: ['fleet-signers-2026'],
          minPolicyEpoch: 12,
          approvedMeasurements: ['9f2c4e7a1b0d3856'],
          grants: [{ device: 'device-a', classes: ['credential'] }]
        };
        Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
        return p;
      }

      /**
       * The whole pipeline, in the order app.js runs it, and then the model.
       *
       * `opts.verifyChain` is passed through because that is the injection
       * point: a caller with a root of trust supplies one, and this repository
       * is not such a caller. Everything else is the real module.
       */
      function panel(policy, ev, request, opts) {
        var verdict = ATT.verifyAttestation(ev, EXPECT, opts);
        var decision = ATT.admitTransfer(policy, verdict, request);
        var receipt = ATT.attestationReceipt(verdict, decision, policy);
        return attView.model({
          verdict: verdict,
          decision: decision,
          receipt: receipt,
          roots: ATT.describeRoots(),
          limits: ATT.describeLimits(),
          custody: ATT.describeKeyCustody()
        }, { challenge: { sessionId: EXPECT.sessionId, nonce: EXPECT.nonce } });
      }

      /** The only way to reach `attested` anywhere: a verifier that says yes. */
      var CHAIN_OK = { verifyChain: function () { return true; } };

      test('attestation: the three states of ADR-021 §4.3 are three different renderings', function () {
        // The criterion is that unattested is never conflated with
        // attested-and-approved, and both have to be told apart from a refusal.
        var approved = panel(fullPolicy(), evidence(),
          { artifactClass: 'credential', peerId: 'peer-9' }, CHAIN_OK);
        var permitted = panel(
          { requireAttestation: false, grants: [{ device: 'peer-9', classes: ['credential'] }] },
          null, { artifactClass: 'credential', peerId: 'peer-9' });
        var refused = panel(fullPolicy({ grants: [] }), evidence(),
          { artifactClass: 'credential', peerId: 'peer-9' }, CHAIN_OK);

        assertEqual(approved.outcome, 'attested-approved', 'the attested outcome');
        assertEqual(permitted.outcome, 'unattested-permitted', 'the unattested outcome');
        assertEqual(refused.outcome, 'refused', 'the refused outcome');

        // Distinct by class, by badge and by sentence — three signals, so the
        // panel does not rest on colour alone.
        [['tone', 'tone'], ['badge', 'badge'], ['headline', 'headline']].forEach(function (f) {
          var a = approved[f[0]], b = permitted[f[0]], c = refused[f[0]];
          assert(a !== b && b !== c && a !== c,
            'two of the three outcomes share a ' + f[1] + ': ' +
            JSON.stringify([a, b, c]));
        });
        assertEqual(approved.tone, 'good', 'the attested tone');
        assertEqual(refused.tone, 'bad', 'the refused tone');
        // Deliberately NOT the good tone: a transfer nobody verified is news,
        // not good news, and a green notice would say it was checked.
        assertEqual(permitted.tone, '', 'the unattested-permitted tone');

        assertEqual(permitted.badge, 'Unattested — nobody asked', 'the unattested badge');
        assertEqual(permitted.headline,
          'Unattested, and permitted because nobody asked.', 'the unattested headline');
        assertEqual(approved.headline, 'Attested, and separately granted.', 'the attested headline');
        return approved.badge + ' / ' + permitted.badge + ' / ' + refused.badge;
      });

      test('attestation: a device measured, approved and current is still refused, and the panel shows both halves', function () {
        // ADR-021 §2.2 and §4.1, at the screen. The evidence verifies and all
        // four preconditions pass; only the capability grant is missing. The
        // verdict block must still read Attested, and the decision block must
        // still refuse, because they are answers to different questions.
        var m = panel(fullPolicy({ grants: [] }), evidence(),
          { artifactClass: 'credential', peerId: 'peer-9' }, CHAIN_OK);

        assertEqual(m.verdict.state, 'attested', 'the verdict state');
        assertEqual(m.verdict.label, 'Attested', 'the verdict heading');
        assertEqual(m.decision.code, 'capability-refused', 'the decision code');
        assertEqual(m.decision.admit, false, 'admitted anyway');
        assertEqual(m.outcome, 'refused', 'the outcome');

        // The device's measured facts are on screen under the verdict, and the
        // refusal is under the decision. Neither block borrows the other's
        // answer.
        var measured = m.verdict.facts.filter(function (f) {
          return f.label === 'RVM measurement';
        })[0];
        assert(measured && measured.text === '9f2c4e7a1b0d3856', 'the measurement is not shown');
        assert(m.verdict.text.indexOf('not permission to receive anything') > 0,
          'the verdict block does not say what a verdict is not: ' + m.verdict.text);
        assert(m.decision.text.indexOf(
          'may be measured, approved and current and still be the wrong device') > 0,
          'the decision block does not say why: ' + m.decision.text);
        // And the invariant itself, in the module's words, between the two.
        assert(m.separationNote.indexOf('evidence, never authorization') > 0,
          'the separation note is not the module\'s own: ' + m.separationNote);
        return m.decision.label;
      });

      test('attestation: the verdict block carries no permission, and the decision block carries no claim', function () {
        // The information barrier, at the screen. Nothing a reader could take
        // as permission may appear in the verdict block, and the decision block
        // renders the gate's own sentence rather than a restatement of it.
        var verdict = ATT.verifyAttestation(evidence(), EXPECT, CHAIN_OK);
        var decision = ATT.admitTransfer(fullPolicy(), verdict,
          { artifactClass: 'credential', peerId: 'peer-9' });
        var block = attView.verdictBlock(verdict);
        ['admit', 'allow', 'ok', 'trusted', 'granted'].forEach(function (k) {
          assertEqual(block[k], undefined, 'the verdict block published ' + k);
        });
        assertEqual(block.text, verdict.reason, 'the verdict reason was re-worded');
        assertEqual(attView.decisionBlock(decision).text, decision.reason,
          'the decision reason was re-worded');
        assert(block.title !== attView.decisionBlock(decision).title,
          'the two blocks share a title, so they read as one answer');
        return block.title + ' / ' + attView.decisionBlock(decision).title;
      });

      test('attestation: the privacy trade is on screen before attestation is enabled', function () {
        // Nothing declared, nothing granted, no evidence — the state an
        // operator meets the panel in. The disclosure has to be there THEN,
        // because §4.7 is about what is visible before the feature is turned
        // on rather than after.
        var m = panel({}, null, { artifactClass: 'generic', peerId: null });
        assertEqual(m.decision.code, 'policy-undeclared',
          'the fixture has already enabled something');
        assert(m.privacy && m.privacy.indexOf('identifies a device') > 0,
          'no privacy disclosure on the untouched panel: ' + m.privacy);
        assertEqual(m.privacy, ATT.describeLimits().filter(function (l) {
          return l.indexOf('identifies a device') >= 0;
        })[0], 'the disclosure is not the module\'s own sentence');

        // And the rule, rather than the ordering: the controls that declare a
        // policy are enabled only because the disclosure rendered. A model
        // whose limits do not carry it cannot enable attestation at all.
        assertEqual(m.canDeclare, true, 'the disclosure is present and yet nothing can be declared');
        var stripped = attView.model({
          verdict: null, decision: null, roots: ATT.describeRoots(),
          limits: ATT.describeLimits().filter(function (l) {
            return l.indexOf('identifies a device') < 0;
          })
        }, {});
        assertEqual(stripped.privacy, null, 'a disclosure appeared from nowhere');
        assertEqual(stripped.canDeclare, false,
          'attestation can be enabled with no privacy disclosure on screen');
        return 'disclosed, and the control is gated on the disclosure';
      });

      test('attestation: an unexercised root is never displayed as available', function () {
        var m = panel({}, null, { artifactClass: 'generic', peerId: null });
        assertEqual(m.roots.length, 4, 'not all four roots are on screen');
        m.roots.forEach(function (row) {
          assertEqual(row.status, 'unexercised', row.id + ' claims a status');
          assertEqual(row.available, false, row.id + ' is shown as available');
          // The status travels with the NAME, so a list read down its headings
          // alone still says so.
          assert(row.label.indexOf('unexercised') > 0,
            row.id + '’s heading does not carry its status: ' + row.label);
          assert(row.text.indexOf('implements none of the protocol behind it') > 0,
            row.id + '’s note is not the module’s own: ' + row.text);
        });
        assert(m.rootsNote.indexOf('None of the four roots of trust') === 0,
          'the roots note is not the module’s own: ' + m.rootsNote);
        // And why no evidence can reach `attested` here, said in the same place.
        assert(m.reachabilityNote.indexOf('the attested state is unreachable') > 0,
          'the panel does not say the attested state is out of reach: ' + m.reachabilityNote);
        assert(m.custodyNote.indexOf('ADR-035 is not superseded') > 0,
          'the panel does not say the signing key is still in localStorage');
        return '4 roots, all unexercised, none offered';
      });

      test('attestation: an undeclared policy is its own explained state, not an error', function () {
        // ADR-021 §2.3: whether unattested is acceptable is the sender's
        // decision "not a default". The app declines to make it, and the panel
        // has to say which decision is missing rather than reporting a failure.
        var m = panel({ grants: [{ device: 'peer-9', classes: ['generic'] }] }, null,
          { artifactClass: 'generic', peerId: 'peer-9' });
        assertEqual(m.decision.code, 'policy-undeclared', 'the code');
        assertEqual(m.decision.label, 'This sender has not declared a policy', 'the heading');
        assertEqual(m.headline, 'Refused: this sender has not declared a policy.', 'the headline');
        assert(m.decision.text.indexOf('there is no default to fall back on') > 0,
          'the panel does not say why: ' + m.decision.text);
        // The evidence bar was never even reached: the verdict is `unattested`,
        // which is a state and not a failure, and the panel shows it as one.
        assertEqual(m.verdict.state, 'unattested', 'the verdict state');
        assertEqual(m.verdict.label, 'Unattested — no evidence was offered', 'the verdict heading');
        // And it is a different state from a device that tried and failed.
        var bad = panel({ requireAttestation: false }, evidence({ measurement: 'm-approved' }),
          { artifactClass: 'generic', peerId: 'peer-9' });
        assert(bad.headline !== m.headline, 'undeclared and malformed share a headline');
        assert(bad.decision.label !== m.decision.label, 'undeclared and malformed share a heading');
        return m.decision.label;
      });

      test('attestation: malformed evidence is refused as malformed, never as absent', function () {
        // 'm-approved' is not a digest. parseEvidence names the field that
        // stopped it, verifyAttestation carries that sentence into the verdict,
        // and the panel renders it — so an operator is told what to fix rather
        // than told "malformed".
        var raw = evidence({ measurement: 'm-approved' });
        var why = ATT.parseEvidence(raw);
        assertEqual(why.ok, false, 'the fixture parses after all');
        assert(why.reason.indexOf('even-length run of lowercase hex') > 0,
          'parseEvidence blamed something else: ' + why.reason);

        var m = panel({ requireAttestation: false, grants: [{ device: 'peer-9', classes: ['generic'] }] },
          raw, { artifactClass: 'generic', peerId: 'peer-9' });
        assertEqual(m.verdict.state, 'malformed', 'the verdict state');
        assertEqual(m.decision.code, 'malformed-evidence', 'the decision code');
        assertEqual(m.outcome, 'refused', 'the outcome');
        // The field-level reason reaches the screen inside the verdict block.
        assert(m.verdict.text.indexOf(why.reason) > 0,
          'the reason parseEvidence gave is not on screen: ' + m.verdict.text);
        assert(m.decision.text.indexOf('a device that tried and failed is not a device that never tried') > 0,
          'the decision does not distinguish malformed from absent: ' + m.decision.text);
        // The grant would have covered an unattested device — so this refusal
        // is the evidence bar, not the capability one, and the two must not
        // look alike.
        var absent = panel({ requireAttestation: false, grants: [{ device: 'peer-9', classes: ['generic'] }] },
          null, { artifactClass: 'generic', peerId: 'peer-9' });
        assertEqual(absent.outcome, 'unattested-permitted',
          'the same policy refused an absent-evidence device too');
        assert(absent.verdict.label !== m.verdict.label, 'absent and malformed share a heading');
        return m.verdict.label;
      });

      test('attestation: a state this build does not know fails closed on screen', function () {
        // ADR-021 §4.2, at the screen. A verdict-shaped object carrying a state
        // from a future build must not fall through into a rendering that looks
        // like any kind of pass.
        var future = ATT.verifyAttestation(evidence(), EXPECT, CHAIN_OK);
        future.state = 'attested-with-quantum-witness';
        var decision = ATT.admitTransfer(fullPolicy(), future,
          { artifactClass: 'credential', peerId: 'peer-9' });
        var m = attView.model({
          verdict: future, decision: decision, roots: ATT.describeRoots(),
          limits: ATT.describeLimits()
        }, {});
        assertEqual(m.outcome, 'refused', 'an unknown state was not refused');
        assertEqual(m.decision.code, 'unknown-attestation-state', 'the code');
        assertEqual(m.decision.label, 'An attestation state this build does not know', 'the heading');
        // The unknown state is named rather than blanked, so the operator can
        // report what arrived.
        assertEqual(m.verdict.label, 'attested-with-quantum-witness',
          'the unknown state was not named on screen');
        return m.verdict.label + ' → ' + m.decision.code;
      });

      test('attestation: every unmet precondition reaches the screen, not only the first', function () {
        // A device failing three of the four should say so: fixing one will not
        // be enough, and a panel showing the first would send its operator round
        // the loop three times.
        var m = panel(fullPolicy({
          trustedSignerSets: ['someone-else'],
          minPolicyEpoch: 99,
          approvedMeasurements: ['00ff']
        }), evidence(), { artifactClass: 'credential', peerId: 'peer-9' }, CHAIN_OK);
        assertEqual(m.outcome, 'refused', 'the outcome');
        var rules = m.decision.unmet.map(function (u) { return u.label; });
        ['Signer set', 'Policy epoch', 'RVM measurement'].forEach(function (label) {
          assert(rules.indexOf(label) >= 0, label + ' is not on screen: ' + rules.join(', '));
        });
        // Each row is the module's own sentence about that rule.
        var epoch = m.decision.unmet.filter(function (u) { return u.label === 'Policy epoch'; })[0];
        assert(epoch.text.indexOf('policy epoch 12 and this sender requires at least 99') > 0,
          'the epoch row is not the module’s own: ' + epoch.text);
        return rules.join(', ');
      });

      test('attestation: which identity a grant was matched against is never left to look alike', function () {
        // An attested device id and a pinned peer key are not the same claim.
        // The panel names which one carried the grant, because ADR-035's key is
        // still in localStorage and a grant resting on it is a weaker binding.
        var attested = panel(fullPolicy(), evidence(),
          { artifactClass: 'credential', peerId: 'peer-9' }, CHAIN_OK);
        assertEqual(attested.decision.identitySource, 'attestation', 'the attested identity source');
        assert(attested.identityNote.indexOf('attested device id device-a') > 0,
          'the attested identity is not named: ' + attested.identityNote);

        var peer = panel({ requireAttestation: false, grants: [{ device: 'peer-9', classes: ['generic'] }] },
          null, { artifactClass: 'generic', peerId: 'peer-9' });
        assertEqual(peer.decision.identitySource, 'peer', 'the peer identity source');
        assert(peer.identityNote.indexOf('materially weaker binding') > 0,
          'the weaker binding is not named: ' + peer.identityNote);
        assert(attested.identityNote !== peer.identityNote, 'the two identities read alike');
        return attested.decision.identitySource + ' / ' + peer.decision.identitySource;
      });

      test('attestation: with no verifier injected the panel reports unverified, and says the attested state is out of reach', function () {
        // This is app.js's call shape: no third argument, because this
        // repository has no root of trust to put there. A test that passed one
        // here would be testing a caller that does not exist.
        var m = panel({ requireAttestation: false, grants: [{ device: 'peer-9', classes: ['generic'] }] },
          evidence(), { artifactClass: 'generic', peerId: 'peer-9' });
        assertEqual(m.verdict.state, 'unverified', 'the verdict state');
        assertEqual(m.decision.code, 'unverified-evidence', 'the decision code');
        assertEqual(m.outcome, 'refused', 'evidence nobody checked was not refused');
        // Not published, because the verifier established nothing: a device's
        // own claims never reach the screen as facts on this path.
        assertEqual(m.verdict.facts.length, 0, 'unverified claims reached the panel as facts');
        assert(m.reachabilityNote.indexOf('never degrades into a pass') > 0,
          'the panel does not say a check that cannot run is not a pass');
        return m.verdict.label;
      });

      test('attestation: evidence bound to another session, and a spent challenge, are told apart', function () {
        // ADR-021 §4.5. A recording is a genuine attestation, so the binding is
        // the check that matters — and the two ways it fails are different
        // facts with different fixes.
        var elsewhere = panel({ requireAttestation: false, grants: [] },
          evidence({ sessionId: 'session-2' }), { artifactClass: 'generic', peerId: 'peer-9' }, CHAIN_OK);
        assertEqual(elsewhere.verdict.state, 'unbound', 'the unbound state');
        assertEqual(elsewhere.decision.code, 'unbound-evidence', 'the unbound code');

        var spent = ATT.verifyAttestation(evidence(), {
          sessionId: EXPECT.sessionId, nonce: EXPECT.nonce,
          consumedNonces: [EXPECT.nonce]
        }, CHAIN_OK);
        var replayed = attView.model({
          verdict: spent,
          decision: ATT.admitTransfer({ requireAttestation: false }, spent,
            { artifactClass: 'generic', peerId: 'peer-9' }),
          roots: ATT.describeRoots(), limits: ATT.describeLimits()
        }, { challenge: { sessionId: EXPECT.sessionId, nonce: EXPECT.nonce } });
        assertEqual(replayed.verdict.state, 'replayed', 'the replayed state');
        assert(replayed.verdict.label !== elsewhere.verdict.label,
          'a recording and a stray session share a heading');
        assert(replayed.headline !== elsewhere.headline,
          'a recording and a stray session share a headline');
        // And the panel says what evidence had to be bound to, so the operator
        // can see the challenge that was issued.
        assert(replayed.challengeNote.indexOf('challenge-1') > 0,
          'the challenge is not on screen: ' + replayed.challengeNote);
        return elsewhere.verdict.label + ' / ' + replayed.verdict.label;
      });

      test('attestation: a recording and a replay check that could not run do not read alike', function () {
        // attest.js refuses both as `replayed`, and they are different news: one
        // is a challenge this sender knows it answered, the other is a sender
        // that has lost the ability to tell. A single heading would erase that.
        var known = ATT.verifyAttestation(evidence(), {
          sessionId: EXPECT.sessionId, nonce: EXPECT.nonce, consumedNonces: [EXPECT.nonce]
        }, CHAIN_OK);
        var spent = [];
        for (var i = 0; i <= ATT.LIMITS.consumedNonces; i++) spent.push('spent-' + i);
        var undetermined = ATT.verifyAttestation(evidence(), {
          sessionId: EXPECT.sessionId, nonce: EXPECT.nonce, consumedNonces: spent
        }, CHAIN_OK);

        assertEqual(known.state, 'replayed', 'the known-recording state');
        assertEqual(undetermined.state, 'replayed', 'the undetermined state');
        var a = attView.verdictBlock(known).label;
        var b = attView.verdictBlock(undetermined).label;
        assert(a !== b, 'both replayed cases share a heading: ' + a);
        assert(b.indexOf('could not be performed') > 0, 'the undetermined heading: ' + b);
        // And the module's own sentence, which says which one this is, is what
        // the panel renders underneath.
        assert(attView.verdictBlock(undetermined).text.indexOf('CANNOT BE DETERMINED') > 0,
          'the undetermined reason is not on screen');
        return a + ' / ' + b;
      });

      test('attestation: a panel with no verdict and no decision refuses rather than reassures', function () {
        // The panel is fed by a module that may not have loaded and by a
        // handshake that may never have happened. Nothing missing may render as
        // anything a reader could take for a pass.
        var m = attView.model({ roots: ATT.describeRoots(), limits: ATT.describeLimits() }, {});
        assertEqual(m.outcome, 'refused', 'an empty panel was not refused');
        assertEqual(m.decision.admit, false, 'an empty panel admitted');
        assertEqual(m.verdict.state, null, 'a state appeared from nowhere');
        assert(m.verdict.label.indexOf('Nothing yet') === 0, 'the verdict block: ' + m.verdict.label);
        assert(m.decision.label.indexOf('Nothing yet') === 0, 'the decision block: ' + m.decision.label);
        // With no session there is nothing for evidence to be bound to, and the
        // panel says that rather than printing a challenge nobody issued.
        assert(m.challengeNote.indexOf('no paired session') > 0,
          'the panel invented a binding: ' + m.challengeNote);
        return m.badge;
      });
    }

    return results;
  }

  /**
   * The delta-choice tests that need a real crypto.js session.
   *
   * Separate from runAll for the same reason the RVF suite is: sealing is
   * asynchronous. The sealed path is the point of the exercise — an inventory
   * lists which artifacts and which versions a device holds, so it travels
   * encrypted or the feature is not the feature — and a test that skipped the
   * seal would be testing something the app does not do.
   */
  function runDeltaChoiceTests(core, mods) {
    mods = mods || {};
    var results = [];
    function record(name, promise) {
      return Promise.resolve(promise).then(
        function (detail) { results.push({ name: name, ok: true, detail: detail || '' }); },
        function (e) {
          results.push({ name: name, ok: false, detail: e && e.message ? e.message : String(e) });
        }
      );
    }
    function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
    function assertEqual(a, b, m) {
      if (a !== b) throw new Error((m || 'expected') + ': got ' + a + ', want ' + b);
    }

    var SD = mods.semdelta ||
      (typeof window !== 'undefined' ? window.RVQRSemDelta : null) || null;
    var CR = mods.crypto ||
      (typeof window !== 'undefined' ? window.RVQRCrypto : null) || null;
    var choiceView = (mods.view && mods.view.deltaChoice) ||
      (typeof window !== 'undefined' ? window.RVQRDeltaChoiceView : null) || null;
    if (!SD || !CR || !choiceView) return Promise.resolve(results);

    // The context string app.js seals under. It is asserted here rather than
    // merely used, because both ends have to name the same thing and a silent
    // disagreement shows up as an unopenable inventory much later.
    var CONTEXT = 'rvqr/semantic-inventory/v1';

    function vecContainer(dim, fills) {
      var stride = 8 + dim * 4;
      var payload = new Uint8Array(6 + stride * fills.length);
      payload[0] = dim & 0xff; payload[1] = (dim >>> 8) & 0xff;
      payload[2] = fills.length & 0xff; payload[3] = (fills.length >>> 8) & 0xff;
      for (var i = 0; i < fills.length; i++) {
        var r = new Uint8Array(stride);
        var id = i + 1;
        r[0] = id & 0xff; r[1] = (id >>> 8) & 0xff;
        r[2] = (id >>> 16) & 0xff; r[3] = (id >>> 24) & 0xff;
        for (var k = 8; k < stride; k++) r[k] = (fills[i] + k * 7) & 0xff;
        payload.set(r, 6 + i * stride);
      }
      var out = new Uint8Array(64 + payload.length);
      out.set([0x53, 0x46, 0x56, 0x52], 0);
      out[4] = 1;
      out[5] = 0x01;
      var dv = new DataView(out.buffer);
      dv.setUint32(8, 1, true);
      dv.setUint32(16, payload.length, true);
      out.set(payload, 64);
      return out;
    }
    function fillsOf(n) {
      var out = [];
      for (var i = 0; i < n; i++) out.push(i & 0xff);
      return out;
    }

    /** A real handshake: invite, accept, confirm. No stubs on either side. */
    function sessionPair() {
      return Promise.resolve(CR.sessionInvite({})).then(function (state) {
        return Promise.resolve(CR.sessionAccept(state.bootstrap, {})).then(function (accepted) {
          assert(accepted.ok, 'the responder rejected the invite: ' + accepted.reason);
          return Promise.resolve(CR.sessionConfirm(state, accepted.bootstrap, {}))
            .then(function (confirmed) {
              assert(confirmed.ok, 'the initiator rejected the reply: ' + confirmed.reason);
              // responder seals (it is the receiver), initiator opens (it is
              // the sender) — the same direction app.js uses.
              return { receiver: accepted.session, sender: confirmed.session };
            });
        });
      });
    }

    var base = fillsOf(200);
    var receiverBytes = vecContainer(6, base);
    var senderFills = base.slice();
    senderFills[4] = (senderFills[4] + 91) & 0xff;
    senderFills[9] = (senderFills[9] + 91) & 0xff;
    var senderBytes = vecContainer(6, senderFills);

    var chain = record(
      'delta choice: the sealed inventory drives the same choice the plaintext one would',
      sessionPair().then(function (pair) {
        var plain = SD.semanticInventory(receiverBytes);
        return SD.sealInventory(plain, pair.receiver, { context: CONTEXT }).then(function (sealed) {
          assertEqual(typeof sealed, 'string', 'a sealed inventory is base64url text');
          // It really is sealed: neither plaintext inventory magic survives.
          var raw = core.b64uDecode(sealed);
          var head = core.toHex(raw.subarray(0, 4));
          assert(head !== '52565349', 'the semantic inventory magic is still in the clear');
          assert(head !== '52565149', 'the span inventory magic is still in the clear');

          return SD.openInventory(sealed, pair.sender, { context: CONTEXT }).then(function (opened) {
            assertEqual(opened.root, plain.root, 'the opened inventory describes a different container');
            assertEqual(opened.units.length, plain.units.length, 'unit count');

            var fromSealed = SD.chooseDelta(senderBytes, opened);
            var fromPlain = SD.chooseDelta(senderBytes, plain);
            assertEqual(fromSealed.chosen, fromPlain.chosen, 'strategy');
            assertEqual(fromSealed.bytes, fromPlain.bytes, 'chosen size');
            assertEqual(fromSealed.spanBytes, fromPlain.spanBytes, 'span size');
            assertEqual(fromSealed.semanticBytes, fromPlain.semanticBytes, 'semantic size');

            var model = choiceView.model(fromSealed, { formatBytes: core.formatBytes });
            assertEqual(model.strategy, 'semantic', 'strategy the panel reports');
            assert(model.headline.indexOf('Semantic delta') === 0, 'headline: ' + model.headline);

            // And the payload chosen against the sealed inventory rebuilds the
            // sender's container on the receiver's copy. The encryption is on
            // the path, not around it.
            var rebuilt = SD.applyChosen(receiverBytes, fromSealed);
            assertEqual(rebuilt.sha256, core.sha256Hex(senderBytes), 'reconstruction');
            return sealed.length + ' sealed characters, ' + model.headline;
          });
        });
      })
    );

    chain = chain.then(function () {
      return record(
        'delta choice: a sealed inventory does not open for anyone but the session it was sealed to',
        Promise.all([sessionPair(), sessionPair()]).then(function (pairs) {
          var inv = SD.semanticInventory(receiverBytes);
          return SD.sealInventory(inv, pairs[0].receiver, { context: CONTEXT }).then(function (sealed) {
            var attempts = [
              ['a different session', SD.openInventory(sealed, pairs[1].sender, { context: CONTEXT })],
              ['a different context', SD.openInventory(sealed, pairs[0].sender, { context: 'rvqr/manifest' })],
              ['a flipped byte', (function () {
                var raw = core.b64uDecode(sealed);
                raw[raw.length - 1] ^= 0x01;
                return SD.openInventory(core.b64uEncode(raw), pairs[0].sender, { context: CONTEXT });
              })()]
            ];
            return Promise.all(attempts.map(function (a) {
              return a[1].then(
                function () { throw new Error(a[0] + ' opened the inventory'); },
                function () { return a[0]; }
              );
            })).then(function (names) {
              return names.length + ' rejected: ' + names.join(', ');
            });
          });
        })
      );
    });

    return chain.then(function () { return results; });
  }

  /**
   * RVF tests. Separate from runAll because they need the microkernel and the
   * demo container, which arrive asynchronously in both runners.
   */
  function runRvfTests(rvflib, kernelBytes, containerBytes) {
    var results = [];
    function record(name, fn) {
      try {
        results.push({ name: name, ok: true, detail: fn() || '' });
      } catch (e) {
        results.push({ name: name, ok: false, detail: e && e.message ? e.message : String(e) });
      }
    }
    function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
    function assertEqual(a, b, m) {
      if (a !== b) throw new Error((m || 'expected') + ': got ' + a + ', want ' + b);
    }

    return rvflib.load(kernelBytes).then(function (kernel) {
      var report = rvflib.inspect(kernel, containerBytes);

      record('RVF: the demo container parses with the real microkernel', function () {
        assert(report.ok, 'inspection failed: ' + report.notes.join(' '));
        assert(report.header, 'no header');
        assertEqual(report.header.magicBytes, '53 46 56 52', 'segment magic');
        assertEqual(report.header.typeName, 'Manifest', 'first segment type');
        return report.segmentCount + ' segments, header version ' + report.header.version;
      });

      record('RVF: the segment table accounts for every byte', function () {
        assertEqual(report.segments.length, 4, 'segment count');
        var types = report.segments.map(function (s) { return s.typeName; }).join(', ');
        assertEqual(types, 'Manifest, Vec, Witness, Manifest', 'segment types');
        // Each segment is a 64-byte header plus its payload, 64-byte aligned.
        var end = 0;
        for (var i = 0; i < report.segments.length; i++) {
          var seg = report.segments[i];
          assert(seg.offset >= end, 'segment ' + i + ' overlaps the previous one');
          end = seg.payloadOffset + seg.size;
        }
        assert(containerBytes.length - end < 64,
          'the chain leaves ' + (containerBytes.length - end) + ' unexplained bytes');
        return end + ' of ' + containerBytes.length + ' bytes covered';
      });

      record('RVF: 24 vectors of 16 dimensions, ids 1..24', function () {
        assert(report.vectors && report.vectors.ok,
          'no vectors: ' + (report.vectors && report.vectors.reason));
        assertEqual(report.vectors.count, 24, 'vector count');
        assertEqual(report.vectors.dim, 16, 'dimensionality');
        assertEqual(report.vectors.trailing, 0, 'unexplained trailing bytes');
        for (var i = 0; i < 24; i++) {
          assertEqual(report.vectors.ids[i], i + 1, 'id at index ' + i);
        }
        return '24 × 16, ids 1..24, segment fully accounted for';
      });

      record('RVF: the vectors are unit length, as written', function () {
        var worst = 0;
        for (var i = 0; i < report.vectors.count; i++) {
          var v = report.vectors.vectors[i], sum = 0;
          for (var d = 0; d < v.length; d++) sum += v[d] * v[d];
          worst = Math.max(worst, Math.abs(Math.sqrt(sum) - 1));
        }
        assert(worst < 0.001, 'worst norm deviation ' + worst);
        return 'largest deviation from unit norm ' + worst.toExponential(2);
      });

      record('RVF: searching finds a stored vector at distance zero', function () {
        var vectors = report.vectors;
        for (var probe = 0; probe < 3; probe++) {
          var idx = probe * 9;
          var ranked = rvflib.queryVectors(vectors, vectors.vectors[idx], 5, 'cosine');
          assertEqual(ranked.length, 5, 'result count');
          assertEqual(ranked[0].id, vectors.ids[idx], 'nearest id for probe ' + probe);
          assert(Math.abs(ranked[0].distance) < 1e-5,
            'self-distance was ' + ranked[0].distance);
          for (var r = 1; r < ranked.length; r++) {
            assert(ranked[r].distance >= ranked[r - 1].distance, 'results out of order');
          }
        }
        return 'exact self-match on 3 probes, results ordered';
      });

      record('RVF: the kernel cross-check is reported, not hidden', function () {
        var check = null;
        for (var i = 0; i < report.checks.length; i++) {
          if (report.checks[i].name === 'Kernel store cross-check') check = report.checks[i];
        }
        assert(check, 'no cross-check was performed');
        // The published 0.1.9 kernel reads this container's vector header
        // transposed. Whatever it does, the app must surface it rather than
        // silently choosing a winner.
        if (report.store.agrees) {
          assertEqual(check.status, 'pass', 'agreement should read as a pass');
        } else {
          assertEqual(check.status, 'warn', 'disagreement must be surfaced as a warning');
          assert(check.detail.indexOf(String(report.store.count)) >= 0,
            'the warning should quote what the kernel actually reported');
        }
        return report.store.agrees
          ? 'kernel agrees with the reader'
          : 'kernel reported ' + report.store.count + ' × ' + report.store.dimension +
            ', flagged as a warning';
      });

      record('RVF: checks that cannot be made honestly are marked unavailable', function () {
        var byName = {};
        report.checks.forEach(function (c) { byName[c.name] = c; });
        assert(byName['Checksum verification'], 'no checksum check reported');
        assertEqual(byName['Checksum verification'].status, 'unavailable', 'checksum status');
        assert(byName['Witness chain'], 'no witness check reported');
        assertEqual(byName['Witness chain'].status, 'unavailable', 'witness status');
        return 'checksum and witness both reported as unavailable';
      });

      record('RVF: malformed containers are refused without throwing', function () {
        var cases = [
          ['empty', new Uint8Array(0)],
          ['random noise', (function () {
            var b = new Uint8Array(2304);
            for (var i = 0; i < b.length; i++) b[i] = (i * 7919) & 0xff;
            return b;
          })()],
          ['truncated', containerBytes.subarray(0, 100)],
          ['magic cleared', (function () {
            var b = Uint8Array.from(containerBytes);
            b[0] = 0;
            return b;
          })()]
        ];
        for (var i = 0; i < cases.length; i++) {
          var r = rvflib.inspect(kernel, cases[i][1]);
          assert(r && typeof r === 'object', cases[i][0] + ' returned nothing');
          if (cases[i][0] !== 'truncated') {
            assert(!r.ok, cases[i][0] + ' was accepted as a valid container');
          }
        }
        return cases.length + ' malformed inputs handled';
      });

      return results;
    }, function (err) {
      results.push({
        name: 'RVF: microkernel loads',
        ok: false,
        detail: 'could not instantiate: ' + (err && err.message ? err.message : String(err))
      });
      return results;
    });
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return {
    runAll: runAll,
    runRvfTests: runRvfTests,
    runDeltaChoiceTests: runDeltaChoiceTests,
    summarize: summarize
  };
});
