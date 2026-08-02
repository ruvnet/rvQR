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
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRTests = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runAll(core, qrlib) {
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

    test('frames from another transfer are ignored', function () {
      var a = transfer(rndBytes(1200), { name: 'a.bin', chunk: 512, transferId: 'aaaaaaaa' });
      var b = transfer(rndBytes(1200), { name: 'b.bin', chunk: 512, transferId: 'bbbbbbbb' });
      var rx = core.createReceiver();
      core.ingest(rx, a.frames[0]);
      var r = core.ingest(rx, b.frames[1]);
      assert(!r.accepted, 'foreign frame accepted');
      assertEqual(r.reason, 'other-transfer', 'reason');
      for (var i = 1; i < a.frames.length; i++) core.ingest(rx, a.frames[i]);
      var res = core.finalize(rx);
      assert(res.ok, 'clean transfer should still verify');
      assertEqual(res.name, 'a.bin', 'name');
      return 'kept transfer aaaaaaaa';
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

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
