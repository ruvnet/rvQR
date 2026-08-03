/*!
 * rvQR protocol v2 test suite — standalone.
 *
 * Node:    `node artifacts/proto2.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after core.js and proto2.js, then call
 *          RVQRProto2Tests.runAll(RVQRProto2, RVQRCore, RVQRQr).
 *
 * Byte-exactness is asserted with node:crypto's SHA-256 rather than with
 * lengths, and rather than with core.js's own SHA-256: a suite that verifies a
 * module using that module's hash proves only that it is self-consistent.
 *
 * The v1-versus-v2 density comparison is MEASURED against the real encoder at a
 * fixed QR version every run, not quoted from the design notes.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var proto2 = require('./proto2.js');
      var core = require('./core.js');
      var qrlib = require('./vendor/qrcode.js');
      var nodeCrypto = require('crypto');
      var results = api.runAll(proto2, core, qrlib, function (bytes) {
        return nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
      });
      results.forEach(function (r) {
        console.log(
          (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')
        );
      });
      var summary = api.summarize(results);
      console.log(
        '\n' + summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed'
      );
      if (typeof process !== 'undefined') process.exit(summary.failed ? 1 : 0);
    }
  } else {
    root.RVQRProto2Tests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The operating point the design targets: a version 19 symbol at error
  // correction level L. Robust enough to read off a phone screen across a room,
  // and the level the app defaults to.
  var QR_VERSION = 19;
  var QR_ECL = 'L';

  function runAll(P, core, qrlib, sha256Hex) {
    var results = [];

    function test(name, fn) {
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || '' });
      } catch (err) {
        results.push({ name: name, ok: false, detail: err && err.message ? err.message : String(err) });
      }
    }

    function assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }

    function eq(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(expected) +
          ', got ' + JSON.stringify(actual));
      }
    }

    /** Byte-exactness, via an independent SHA-256. Never a length comparison. */
    function sameBytes(a, b, msg) {
      var ha = sha256Hex(a);
      var hb = sha256Hex(b);
      if (ha !== hb) {
        throw new Error((msg || 'bytes differ') + ': sha256 ' + ha.slice(0, 16) +
          ' vs ' + hb.slice(0, 16) + ' (lengths ' + a.length + '/' + b.length + ')');
      }
    }

    /** Deterministic filler, so a failure is reproducible. */
    function filler(n, seed) {
      var b = new Uint8Array(n);
      var x = (seed || 1) >>> 0;
      for (var i = 0; i < n; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        b[i] = (x >>> 24) & 0xff;
      }
      return b;
    }

    /** Drives a whole transfer through the receiver and returns the verdict. */
    function roundtrip(bytes, opts) {
      var built = P.buildFrames(bytes, opts || {});
      var rx = P.createReceiver();
      for (var i = 0; i < built.frames.length; i++) {
        var r = P.ingest(rx, built.frames[i]);
        assert(r.accepted, 'frame ' + i + ' refused: ' + r.reason);
      }
      assert(P.isComplete(rx), 'transfer did not complete');
      return { built: built, rx: rx, out: P.finalize(rx) };
    }

    // --- roundtrip across sizes ----------------------------------------------

    test('proto2: roundtrip at 0, 1, one chunk, and one chunk plus one byte', function () {
      var chunk = 256;
      var sizes = [0, 1, chunk - 1, chunk, chunk + 1, chunk * 3, chunk * 3 + 7];
      var seen = [];
      for (var i = 0; i < sizes.length; i++) {
        var bytes = filler(sizes[i], i + 1);
        var t = roundtrip(bytes, { chunk: chunk, name: 'roundtrip.bin' });
        assert(t.out.ok, 'size ' + sizes[i] + ' rejected: ' + t.out.reason);
        sameBytes(t.out.bytes, bytes, 'size ' + sizes[i] + ' came back changed');
        eq(t.out.sha256, sha256Hex(bytes), 'size ' + sizes[i] + ' digest');
        // The empty artifact is the manifest alone: nothing to chunk.
        eq(t.built.total, sizes[i] === 0 ? 1 : 1 + Math.ceil(sizes[i] / chunk),
          'frame count at size ' + sizes[i]);
        seen.push(sizes[i]);
      }
      return seen.length + ' sizes, byte-exact: ' + seen.join(', ');
    });

    test('proto2: a zero-byte artifact needs exactly one frame', function () {
      var t = roundtrip(new Uint8Array(0), { chunk: 512, name: 'empty.bin' });
      eq(t.built.frames.length, 1, 'frame count');
      assert(t.out.ok, 'refused: ' + t.out.reason);
      eq(t.out.bytes.length, 0, 'length');
      sameBytes(t.out.bytes, new Uint8Array(0), 'empty artifact');
      return 'manifest only, ' + t.built.frames[0].length + ' bytes on the wire';
    });

    test('proto2: roundtrip survives the ASCII transport armour', function () {
      var bytes = filler(1500, 9);
      var built = P.buildFrames(bytes, { chunk: 300, name: 'armoured.bin' });
      var rx = P.createReceiver();
      for (var i = 0; i < built.frames.length; i++) {
        var text = P.toTransport(built.frames[i]);
        // The armour's whole purpose: every character is single-byte UTF-8, so
        // a decoder that can only hand back a string loses nothing.
        for (var c = 0; c < text.length; c++) {
          assert(text.charCodeAt(c) <= 0x7f, 'armoured char ' + c + ' is not ASCII');
        }
        sameBytes(P.fromTransport(text), built.frames[i], 'armour roundtrip of frame ' + i);
        var r = P.ingest(rx, text);
        assert(r.accepted, 'armoured frame ' + i + ' refused: ' + r.reason);
      }
      var out = P.finalize(rx);
      assert(out.ok, 'refused: ' + out.reason);
      sameBytes(out.bytes, bytes, 'artifact through the armour');
      return built.frames.length + ' frames, ASCII-only, byte-exact';
    });

    // --- the measurement ------------------------------------------------------

    test('proto2: MEASURED bytes per frame, v1 vs v2, at one QR version', function () {
      var cap = qrlib.byteCapacity(QR_VERSION, qrlib.ECC[QR_ECL]);
      var probe = filler(65536, 3);

      // v1: the largest chunk whose real built frame still fits the symbol.
      // Built with core.buildFrames, measured as string length, because a v1
      // frame is ASCII JSON and therefore one character per QR byte.
      var v1Max = 0, v1Frame = 0;
      for (var c = core.MAX_CHUNK; c >= core.MIN_CHUNK; c--) {
        var b1 = core.buildFrames(probe, { chunk: c, name: 'measure.bin' });
        if (b1.frames[1].length <= cap) { v1Max = c; v1Frame = b1.frames[1].length; break; }
      }
      assert(v1Max > 0, 'no v1 chunk fits a version ' + QR_VERSION + ' symbol');

      // v1 at its shipped default, which is the figure the 44% overhead quotes.
      var v1Def = core.buildFrames(probe, { chunk: core.DEFAULT_CHUNK, name: 'measure.bin' });
      var v1DefOverhead = (v1Def.frames[1].length / core.DEFAULT_CHUNK - 1) * 100;

      // v2 binary: the largest chunk whose real built frame fits.
      var v2Max = 0, v2Frame = 0;
      for (var d = cap; d >= 1; d--) {
        var b2 = P.buildFrames(probe, { chunk: d, name: 'measure.bin' });
        if (b2.frames[1].length <= cap) { v2Max = d; v2Frame = b2.frames[1].length; break; }
      }
      assert(v2Max > 0, 'no v2 chunk fits a version ' + QR_VERSION + ' symbol');

      // v2 armoured: same, measured after the ASCII repack.
      var v2aMax = 0, v2aFrame = 0;
      for (var e = cap; e >= 1; e--) {
        var b3 = P.buildFrames(probe, { chunk: e, name: 'measure.bin' });
        var t3 = P.toTransport(b3.frames[1]);
        if (t3.length <= cap) { v2aMax = e; v2aFrame = t3.length; break; }
      }
      assert(v2aMax > 0, 'no armoured v2 chunk fits a version ' + QR_VERSION + ' symbol');

      // Every frame counted above must actually encode at this version.
      qrlib.encodeBytes(P.buildFrames(probe, { chunk: v2Max, name: 'measure.bin' }).frames[1],
        { ecl: QR_ECL, version: QR_VERSION });

      var ratioBin = v2Max / v1Max;
      var ratioArm = v2aMax / v1Max;
      var ratioBinVsDefault = v2Max / core.DEFAULT_CHUNK;

      // The claim under test is that v2 is materially denser at the same
      // operating point. It is asserted as a floor, not pinned to a figure, so
      // this reports the truth rather than defending a number.
      assert(ratioBin > 1.3, 'v2 binary only reached ' + ratioBin.toFixed(3) + 'x of v1');
      assert(ratioArm > 1.15, 'v2 armoured only reached ' + ratioArm.toFixed(3) + 'x of v1');

      return 'QR v' + QR_VERSION + '-' + QR_ECL + ' holds ' + cap + ' B | ' +
        'v1 max payload ' + v1Max + ' B/frame (frame ' + v1Frame + ' B) | ' +
        'v1 at its ' + core.DEFAULT_CHUNK + ' B default costs ' + v1Def.frames[1].length +
        ' B, ' + v1DefOverhead.toFixed(1) + '% overhead | ' +
        'v2 binary ' + v2Max + ' B/frame (frame ' + v2Frame + ' B) = ' +
        ratioBin.toFixed(3) + 'x v1 max, ' + ratioBinVsDefault.toFixed(3) + 'x v1 default | ' +
        'v2 armoured ' + v2aMax + ' B/frame (frame ' + v2aFrame + ' B) = ' +
        ratioArm.toFixed(3) + 'x v1 max';
    });

    test('proto2: the header costs 28 bytes and the payload costs nothing', function () {
      eq(P.HEADER_BYTES, 28, 'header size');
      var bytes = filler(1024, 4);
      var built = P.buildFrames(bytes, { chunk: 256, name: 'x.bin' });
      for (var i = 1; i < built.frames.length; i++) {
        eq(built.frames[i].length, 28 + 256, 'data frame ' + i + ' size');
        // The payload appears verbatim — no expansion of any kind.
        sameBytes(built.frames[i].subarray(28), bytes.subarray((i - 1) * 256, i * 256),
          'frame ' + i + ' payload is not the raw slice');
      }
      return '28 B fixed + payload verbatim';
    });

    // --- every header field roundtrips ---------------------------------------

    test('proto2: every header field survives a roundtrip', function () {
      var bytes = filler(700, 5);
      var built = P.buildFrames(bytes, {
        chunk: 300, name: 'fields.bin',
        transferId: 'deadbeef', codecId: P.CODEC_NONE, dictId: P.DICT_NONE
      });
      var man = P.parseFrame(built.frames[0]);
      assert(man.ok, 'manifest refused: ' + man.reason);
      var f = man.frame;
      eq(f.version, 2, 'version');
      eq(f.kind, 'manifest', 'kind');
      eq(f.mode, P.MODE_INDEXED, 'mode');
      eq(f.modeName, 'indexed', 'modeName');
      eq(f.codecId, P.CODEC_NONE, 'codecId');
      eq(f.dictId, P.DICT_NONE, 'dictId');
      eq(f.transferIdHex, 'deadbeef', 'transferId');
      eq(f.index, 0, 'index');
      eq(f.total, built.total, 'total');
      eq(f.payloadLen, f.payload.length, 'payloadLen');
      eq(f.manifest.originalSize, 700, 'originalSize');
      eq(f.manifest.compressedSize, 700, 'compressedSize');
      eq(f.manifest.chunkSize, 300, 'chunkSize');
      eq(f.manifest.k, 0, 'k');
      eq(f.manifest.name, 'fields.bin', 'name');
      eq(f.manifest.sha256, sha256Hex(bytes), 'contentHash');
      // The header prefix and the full digest are the same hash.
      eq(f.contentHash32, P.parseFrame(built.frames[1]).frame.contentHash32,
        'contentHash32 differs between frames of one transfer');

      var d = P.parseFrame(built.frames[2]);
      assert(d.ok, 'data frame refused: ' + d.reason);
      eq(d.frame.kind, 'data', 'data kind');
      eq(d.frame.index, 2, 'data index');
      eq(d.frame.total, built.total, 'data total');
      eq(d.frame.payloadLen, 300, 'data payloadLen');
      sameBytes(d.frame.payload, bytes.subarray(300, 600), 'data payload');
      return '17 fields, header and manifest';
    });

    test('proto2: multi-byte fields are little-endian at the documented offsets', function () {
      var bytes = filler(256, 6);
      // 128 is core.MIN_CHUNK; anything smaller is clamped up, so a test that
      // asked for 32 would be asserting against a chunk size it never got.
      var built = P.buildFrames(bytes, { chunk: 128, name: 'endian.bin', transferId: '01020304' });
      var f = built.frames[0];
      eq(f[0], 0x52, 'magic[0]'); eq(f[1], 0x56, 'magic[1]');
      eq(f[2], 0x51, 'magic[2]'); eq(f[3], 0x32, 'magic[3]');
      eq(f[4], 2, 'version byte');
      // transferId 0x01020304 little-endian is 04 03 02 01.
      eq(f[8], 0x04, 'transferId byte 0'); eq(f[9], 0x03, 'transferId byte 1');
      eq(f[10], 0x02, 'transferId byte 2'); eq(f[11], 0x01, 'transferId byte 3');
      // total is 3 (manifest + two 128-byte chunks) at offset 15, u24 LE.
      eq(f[15], 3, 'total low byte'); eq(f[16], 0, 'total mid'); eq(f[17], 0, 'total high');
      // payloadLen at 18, u16 LE: 47 fixed + 10 name bytes.
      eq(f[18], 57, 'payloadLen low'); eq(f[19], 0, 'payloadLen high');
      return 'magic, version, transferId, total, payloadLen at documented offsets';
    });

    test('proto2: codec and dictionary ids roundtrip, "none" included', function () {
      var bytes = filler(400, 7);
      // A codec that "compressed" to a different stream, so the two sizes differ.
      var stream = filler(250, 8);
      var cases = [
        ['none', P.CODEC_NONE, P.DICT_NONE, null],
        ['scf1', P.CODEC_SCF1, P.DICT_NONE, stream],
        ['deflate-raw', P.CODEC_DEFLATE_RAW, P.DICT_NONE, stream],
        ['brotli', P.CODEC_BROTLI, P.DICT_NONE, stream]
      ];
      var names = [];
      for (var i = 0; i < cases.length; i++) {
        var built = P.buildFrames(bytes, {
          chunk: 128, name: 'codec.bin',
          codecId: cases[i][1], dictId: cases[i][2], stream: cases[i][3] || undefined
        });
        var p = P.parseFrame(built.frames[0]);
        assert(p.ok, cases[i][0] + ' manifest refused: ' + p.reason);
        eq(p.frame.codecId, cases[i][1], cases[i][0] + ' codecId');
        eq(p.frame.codecName, cases[i][0], cases[i][0] + ' codecName');
        eq(p.frame.dictId, P.DICT_NONE, cases[i][0] + ' dictId');
        eq(p.frame.dictName, 'none', cases[i][0] + ' dictName');
        eq(p.frame.manifest.originalSize, 400, cases[i][0] + ' originalSize');
        eq(p.frame.manifest.compressedSize, cases[i][3] ? 250 : 400, cases[i][0] + ' compressedSize');
        // Every data frame repeats the codec, so a receiver that missed the
        // manifest still cannot be handed bytes it does not know how to read.
        eq(P.parseFrame(built.frames[1]).frame.codecId, cases[i][1], cases[i][0] + ' data codecId');
        names.push(cases[i][0]);
      }
      return names.join(', ') + ' — 0 is a value, not an absence';
    });

    test('proto2: a compressed transfer is refused without a decoder, and verified with one', function () {
      var bytes = filler(300, 11);
      // A trivially invertible stand-in codec: every byte XOR 0x5a.
      var stream = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) stream[i] = bytes[i] ^ 0x5a;

      var t = roundtrip(bytes, { chunk: 128, name: 'c.bin', codecId: P.CODEC_SCF1, stream: stream });
      eq(t.out.ok, false, 'a declared codec with no decoder must not be handed over');
      eq(t.out.reason, 'no-codec', 'reason');

      var built = P.buildFrames(bytes, { chunk: 128, name: 'c.bin', codecId: P.CODEC_SCF1, stream: stream });
      var rx = P.createReceiver();
      built.frames.forEach(function (fr) { P.ingest(rx, fr); });
      var out = P.finalize(rx, {
        decode: function (s, codecId, dictId) {
          eq(codecId, P.CODEC_SCF1, 'codecId passed to the decoder');
          eq(dictId, P.DICT_NONE, 'dictId passed to the decoder');
          var o = new Uint8Array(s.length);
          for (var j = 0; j < s.length; j++) o[j] = s[j] ^ 0x5a;
          return o;
        }
      });
      assert(out.ok, 'refused with a decoder: ' + out.reason);
      sameBytes(out.bytes, bytes, 'decoded artifact');
      return 'no-codec refused, injected decoder verified byte-exact';
    });

    test('proto2: a decoder returning the wrong length is refused, not trusted', function () {
      var bytes = filler(300, 12);
      var stream = filler(300, 13);
      var built = P.buildFrames(bytes, { chunk: 128, name: 'c.bin', codecId: P.CODEC_BROTLI, stream: stream });
      var rx = P.createReceiver();
      built.frames.forEach(function (fr) { P.ingest(rx, fr); });
      var out = P.finalize(rx, { decode: function () { return new Uint8Array(299); } });
      eq(out.ok, false, 'short decode was accepted');
      eq(out.reason, 'original-size-mismatch', 'reason');
      return 'declared originalSize is enforced against the decoder too';
    });

    // --- fountain mode --------------------------------------------------------

    test('proto2: fountain mode carries K and symbol size, and ESI may exceed K', function () {
      var bytes = filler(1000, 14);
      var symbolSize = 250;
      var K = Math.ceil(bytes.length / symbolSize);
      var encoder = {
        K: K, symbolSize: symbolSize, totalBytes: bytes.length,
        symbol: function (esi) {
          var start = (esi % K) * symbolSize;
          return { esi: esi, bytes: bytes.subarray(start, Math.min(start + symbolSize, bytes.length)) };
        }
      };
      var stream = P.buildFountainStream(encoder, {
        name: 'f.bin', contentHash: core.sha256Bytes(bytes), transferId: 'aabbccdd'
      });
      var man = P.parseFrame(stream.manifest);
      assert(man.ok, 'manifest refused: ' + man.reason);
      eq(man.frame.mode, P.MODE_FOUNTAIN, 'mode');
      eq(man.frame.modeName, 'fountain', 'modeName');
      eq(man.frame.total, K, 'total is K');
      eq(man.frame.manifest.k, K, 'manifest k');
      eq(man.frame.manifest.chunkSize, symbolSize, 'symbol size');

      // A repair symbol's ESI runs above K by design and must still parse.
      var repair = P.parseFrame(stream.symbolFrame(K + 40));
      assert(repair.ok, 'repair symbol refused: ' + repair.reason);
      eq(repair.frame.index, K + 40, 'repair ESI');
      eq(repair.frame.mode, P.MODE_FOUNTAIN, 'repair mode');
      return 'K=' + K + ', symbolSize=' + symbolSize + ', ESI ' + (K + 40) + ' accepted';
    });

    // --- hostile frames -------------------------------------------------------

    test('proto2: hostile frames are refused without throwing', function () {
      var bytes = filler(600, 15);
      var built = P.buildFrames(bytes, { chunk: 200, name: 'hostile.bin' });
      var good = built.frames[1];
      var manifest = built.frames[0];

      function mutate(src, fn) {
        var c = Uint8Array.from(src);
        fn(c);
        return c;
      }

      var cases = [
        ['empty', new Uint8Array(0), 'truncated-header'],
        ['header truncated by one', good.subarray(0, 27), 'truncated-header'],
        ['payload truncated', good.subarray(0, good.length - 1), 'length-mismatch'],
        ['payload extended', (function () {
          var c = new Uint8Array(good.length + 1);
          c.set(good);
          return c;
        })(), 'length-mismatch'],
        ['wrong magic', mutate(good, function (c) { c[0] = 0x53; }), 'bad-magic'],
        ['delta RVQD magic', mutate(good, function (c) { c[3] = 0x44; }), 'bad-magic'],
        ['version 3', mutate(good, function (c) { c[4] = 3; }), 'bad-version'],
        ['version 1 in a v2 header', mutate(good, function (c) { c[4] = 1; }), 'bad-version'],
        ['unknown mode 7', mutate(good, function (c) { c[5] = 7; }), 'unknown-mode'],
        ['unknown codec 200', mutate(good, function (c) { c[6] = 200; }), 'unknown-codec'],
        ['unknown dictionary 9', mutate(good, function (c) { c[7] = 9; }), 'unknown-dictionary'],
        ['total 0', mutate(good, function (c) { c[15] = 0; c[16] = 0; c[17] = 0; }), 'too-many-frames'],
        ['total 16777215', mutate(good, function (c) {
          c[15] = 0xff; c[16] = 0xff; c[17] = 0xff;
        }), 'too-many-frames'],
        ['index at or past total', mutate(good, function (c) {
          c[12] = 0xf0; c[13] = 0; c[14] = 0;
        }), 'bad-index'],
        ['payloadLen 65535', mutate(good, function (c) { c[18] = 0xff; c[19] = 0xff; }), 'payload-too-large'],
        ['payloadLen understated', mutate(good, function (c) { c[18] = 10; c[19] = 0; }), 'length-mismatch'],
        ['payload byte flipped', mutate(good, function (c) { c[40] ^= 0xff; }), 'transport-hash-mismatch'],
        ['transport hash flipped', mutate(good, function (c) { c[24] ^= 0xff; }), 'transport-hash-mismatch'],
        ['manifest truncated body', (function () {
          // A manifest whose declared length is honest but whose body is short.
          var body = new Uint8Array(20);
          return P.encodeFrame({
            mode: 0, codecId: 0, dictId: 0, transferId: 1, index: 0, total: 2,
            contentHash32: 0, payload: body
          });
        })(), 'truncated-manifest'],
        ['manifest name length 0', mutate(manifest, function (c) { c[28 + 46] = 0; }), 'bad-name'],
        ['manifest name overruns the body', mutate(manifest, function (c) { c[28 + 46] = 255; }), 'bad-name-length'],
        ['manifest absurd originalSize', mutate(manifest, function (c) {
          c[28 + 0] = 0xff; c[28 + 1] = 0xff; c[28 + 2] = 0xff; c[28 + 3] = 0xff;
        }), 'artifact-too-large'],
        ['manifest chunkSize 0', mutate(manifest, function (c) { c[28 + 40] = 0; c[28 + 41] = 0; }), 'bad-chunk'],
        ['manifest chunkSize over the QR ceiling', mutate(manifest, function (c) {
          c[28 + 40] = 0xff; c[28 + 41] = 0xff;
        }), 'bad-chunk'],
        ['a Uint8Array of pure noise', filler(64, 99), 'bad-magic'],
        ['null', null, 'not-a-frame'],
        ['a number', 12345, 'not-a-frame']
      ];

      var checked = [];
      for (var i = 0; i < cases.length; i++) {
        var name = cases[i][0];
        var r;
        // "without throwing" is the assertion: parseFrame is the boundary
        // between the camera and everything else, so it returns verdicts.
        try {
          r = P.parseFrame(cases[i][1]);
        } catch (e) {
          throw new Error(name + ' threw: ' + (e && e.message ? e.message : String(e)));
        }
        assert(r && r.ok === false, name + ' was accepted');
        // Every mutated manifest above re-hashes wrong, so a transport-hash
        // rejection is also a correct refusal — the frame is still refused.
        assert(r.reason === cases[i][2] || r.reason === 'transport-hash-mismatch',
          name + ': expected ' + cases[i][2] + ', got ' + r.reason);
        checked.push(name);
      }
      return checked.length + ' hostile frames refused, none threw';
    });

    test('proto2: a manifest with an oversized name cannot be built or parsed', function () {
      var bytes = filler(64, 16);
      var threw = false;
      try {
        // 300 bytes of name: past the u8 field and past MAX_NAME_LENGTH.
        P.encodeManifestBody({
          originalSize: 64, compressedSize: 64, contentHash: core.sha256Bytes(bytes),
          chunkSize: 64, k: 0, name: new Array(301).join('a')
        });
      } catch (e) { threw = true; }
      assert(threw, 'a 300-byte name was encoded');
      // And a name that fits the field is clamped by the builder, never by
      // truncating bytes the hash covers.
      var built = P.buildFrames(bytes, { chunk: 64, name: new Array(400).join('b') + '.bin' });
      var p = P.parseFrame(built.frames[0]);
      assert(p.ok, 'clamped name refused: ' + p.reason);
      assert(p.frame.manifest.name.length <= P.MAX_NAME_LENGTH, 'name exceeds the ceiling');
      return 'over-length rejected at encode, clamped at build to ' +
        p.frame.manifest.name.length + ' bytes';
    });

    test('proto2: declared sizes that disagree with the bytes are rejected, not repaired', function () {
      var bytes = filler(500, 17);
      var built = P.buildFrames(bytes, { chunk: 200, name: 'sizes.bin' });

      // A manifest claiming a frame count its own size and chunk do not imply.
      var bad = Uint8Array.from(built.frames[0]);
      bad[15] = 9; // total = 9, but ceil(500/200)+1 = 4
      var rebuilt = P.encodeFrame({
        mode: 0, codecId: 0, dictId: 0, transferId: 1, index: 0, total: 9,
        contentHash32: 0, payload: built.frames[0].subarray(28)
      });
      var r = P.parseFrame(rebuilt);
      eq(r.ok, false, 'inconsistent frame count accepted');
      assert(r.reason === 'frame-count-mismatch' || r.reason === 'content-hash-mismatch',
        'reason: ' + r.reason);

      // A codec-free manifest whose two sizes differ has contradicted itself.
      var body = P.encodeManifestBody({
        originalSize: 500, compressedSize: 400, contentHash: core.sha256Bytes(bytes),
        chunkSize: 200, k: 0, name: 'x.bin'
      });
      var f2 = P.encodeFrame({
        mode: 0, codecId: P.CODEC_NONE, dictId: 0, transferId: 1, index: 0,
        total: 3, contentHash32: (function () {
          var d = core.sha256Bytes(bytes);
          return (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
        })(), payload: body
      });
      var r2 = P.parseFrame(f2);
      eq(r2.ok, false, 'codec-free size disagreement accepted');
      eq(r2.reason, 'size-mismatch', 'reason');
      return 'frame-count and size disagreements both refused';
    });

    test('proto2: a transport-hash mismatch is caught before the payload is used', function () {
      var bytes = filler(400, 18);
      var built = P.buildFrames(bytes, { chunk: 200, name: 'th.bin' });
      var rx = P.createReceiver();
      P.ingest(rx, built.frames[0]);
      var tampered = Uint8Array.from(built.frames[1]);
      tampered[28] ^= 0x01; // one bit of payload
      var r = P.ingest(rx, tampered);
      eq(r.accepted, false, 'a tampered payload was accepted');
      eq(r.reason, 'transport-hash-mismatch', 'reason');
      eq(rx.received, 0, 'the tampered payload reached the chunk table');
      // And the honest frame still lands afterwards.
      assert(P.ingest(rx, built.frames[1]).accepted, 'the honest frame was refused after the tampered one');
      return 'rejected on parse, receiver state untouched';
    });

    test('proto2: the artifact hash is checked on finalize, not merely per frame', function () {
      var bytes = filler(400, 19);
      var built = P.buildFrames(bytes, { chunk: 200, name: 'fh.bin' });
      var rx = P.createReceiver();
      built.frames.forEach(function (fr) { P.ingest(rx, fr); });
      assert(P.isComplete(rx), 'not complete');
      // Every frame is individually well-formed; the artifact is not the one
      // the manifest describes. Only the finalize-time hash can see that.
      rx.chunks[1] = filler(200, 20);
      var out = P.finalize(rx);
      eq(out.ok, false, 'a substituted chunk passed verification');
      eq(out.reason, 'hash-mismatch', 'reason');
      eq(rx.status, 'REJECTED', 'status');
      eq(out.expected, sha256Hex(bytes), 'expected digest reported');
      return 'substituted chunk caught by the content hash';
    });

    // --- interop --------------------------------------------------------------

    test('proto2: a v2 parser fed a v1 frame refuses it by name', function () {
      var bytes = filler(300, 21);
      var v1 = core.buildFrames(bytes, { chunk: 128, name: 'v1.bin' });
      var checked = 0;
      for (var i = 0; i < v1.frames.length; i++) {
        var asString = P.parseFrame(v1.frames[i]);
        eq(asString.ok, false, 'v1 frame ' + i + ' accepted as v2');
        eq(asString.reason, 'v1-frame', 'v1 frame ' + i + ' as string');
        // And as raw bytes, which is how it would arrive from a byte-mode read.
        var asBytes = P.parseFrame(new TextEncoder().encode(v1.frames[i]));
        eq(asBytes.ok, false, 'v1 bytes ' + i + ' accepted as v2');
        eq(asBytes.reason, 'v1-frame', 'v1 frame ' + i + ' as bytes');
        checked++;
      }
      eq(P.identify(v1.frames[0]), 'v1', 'identify on a v1 string');
      return checked + ' v1 frames named as v1, both as text and as bytes';
    });

    test('proto2: a v1 parser fed a v2 frame refuses it by name', function () {
      var bytes = filler(300, 22);
      var built = P.buildFrames(bytes, { chunk: 128, name: 'v2.bin' });
      var checked = 0;
      for (var i = 0; i < built.frames.length; i++) {
        // How a v2 frame reaches a v1 parser: through a text-only decoder,
        // which is exactly the ASCII-armoured form. The magic survives the
        // armour's first characters only in the binary form, so both are tried.
        var asLatin = '';
        for (var b = 0; b < built.frames[i].length; b++) {
          asLatin += String.fromCharCode(built.frames[i][b]);
        }
        var r = core.parseFrame(asLatin);
        eq(r.ok, false, 'v2 frame ' + i + ' accepted by v1');
        eq(r.reason, 'v2-frame', 'v2 frame ' + i + ' reason');
        checked++;
      }
      // v1 still calls genuine noise noise.
      eq(core.parseFrame('hello world').reason, 'not-a-frame', 'noise reason drifted');
      eq(core.parseFrame('').reason, 'not-a-frame', 'empty reason drifted');
      eq(P.identify(built.frames[0]), 'v2', 'identify on v2 bytes');
      eq(P.identify(P.toTransport(built.frames[0])), 'v2-armoured', 'identify on armoured v2');
      return checked + ' v2 frames named as v2 by the v1 parser';
    });

    test('proto2: v1 frames still build byte-for-byte as they did', function () {
      // The v1 wire form is frozen: a v1 sender and a v2 receiver meet in the
      // wild, and so do a v1 sender and an older v1 receiver. This pins the
      // exact bytes, not merely the shape.
      var bytes = filler(512, 23);
      var built = core.buildFrames(bytes, {
        chunk: 256, name: 'frozen.bin', transferId: 'deadbeef'
      });
      eq(built.total, 3, 'frame count');
      var manifest = JSON.parse(built.frames[0]);
      eq(manifest.v, 1, 'v1 protocol version');
      eq(manifest.t, 'deadbeef', 'transfer id');
      eq(manifest.i, 0, 'manifest index');
      eq(manifest.m.chunk, 256, 'chunk');
      var data = JSON.parse(built.frames[1]);
      eq(data.p, core.b64uEncode(bytes.subarray(0, 256)), 'payload is still base64url');
      // The whole frame, hashed independently.
      eq(sha256Hex(new TextEncoder().encode(built.frames[1])),
        sha256Hex(new TextEncoder().encode(JSON.stringify({
          v: 1, t: 'deadbeef', h: core.sha256Hex(bytes).slice(0, 8), i: 1, n: 3,
          p: core.b64uEncode(bytes.subarray(0, 256))
        }))), 'v1 data frame bytes changed');
      return 'v1 manifest and data frames byte-identical to the frozen form';
    });

    // --- transport armour edge cases ------------------------------------------

    test('proto2: the armour refuses non-ASCII and non-zero padding', function () {
      var frame = P.buildFrames(filler(100, 24), { chunk: 100, name: 'a.bin' }).frames[1];
      var text = P.toTransport(frame);
      eq(P.fromTransport(text + 'ÿ'), null, 'a non-ASCII character was accepted');
      // Corrupt the final character's pad bits. Two strings must never decode
      // to one frame, or a frame stops being identified by its bytes.
      var padded = text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) ^ 0x01);
      var decoded = P.fromTransport(padded);
      assert(decoded === null || sha256Hex(decoded) !== sha256Hex(frame),
        'a mutated pad bit decoded to the same frame');
      return 'non-ASCII refused, pad bits are load-bearing';
    });

    test('proto2: the armour costs 8/7, measurably less than base64url 4/3', function () {
      var sizes = [1, 28, 100, 512, 764];
      var rows = [];
      for (var i = 0; i < sizes.length; i++) {
        var b = filler(sizes[i], 25 + i);
        var armour = P.toTransport(b).length / sizes[i];
        var b64 = core.b64uEncode(b).length / sizes[i];
        // At one byte the two tie at 2 characters — rounding, not a property of
        // either scheme. The advantage is asserted from a real frame's size up,
        // since HEADER_BYTES is the smallest frame that exists.
        assert(armour <= b64, 'at ' + sizes[i] + ' B the armour was worse than base64url');
        if (sizes[i] >= P.HEADER_BYTES) {
          assert(armour < b64, 'at ' + sizes[i] + ' B the armour was not denser than base64url');
        }
        assert(armour <= 8 / 7 + 1 / sizes[i], 'armour exceeded 8/7 at ' + sizes[i] + ' B');
        rows.push(sizes[i] + 'B:' + armour.toFixed(3) + 'x vs ' + b64.toFixed(3) + 'x');
      }
      return rows.join(' | ');
    });

    // --- armour and payload allocation ----------------------------------------
    //
    // toTransport used to append one character at a time and fromTransport's
    // output used to be handed on as a view. Both were found by measurement,
    // not by review — bench/suites/memory.mjs caught the first at 37.60× the
    // artifact retained and the second at 1.04×. These tests pin the fixes and,
    // just as importantly, pin the wire bytes across them.

    /**
     * The armour, computed a completely different way: bit by bit, MSB-first,
     * with no shift accumulator at all. Obviously correct at the cost of being
     * slow, which is what a reference implementation is for. If this and
     * toTransport ever disagree, the fast one is wrong.
     */
    function referenceArmour(frame) {
      var outLen = Math.ceil((frame.length * 8) / 7);
      var chars = new Array(outLen);
      for (var j = 0; j < outLen; j++) {
        var v = 0;
        for (var k = 0; k < 7; k++) {
          var bit = j * 7 + k;
          var byteIndex = (bit - (bit % 8)) / 8;
          // Bits past the end of the frame are the zero padding fromTransport
          // insists on. Reading them as 0 here is what makes that a spec.
          var b = byteIndex < frame.length ? (frame[byteIndex] >>> (7 - (bit % 8))) & 1 : 0;
          v = (v << 1) | b;
        }
        chars[j] = String.fromCharCode(v);
      }
      return chars.join('');
    }

    /** The armour string as the bytes it stands for. Every char is <= 0x7F. */
    function armourBytes(text) {
      var b = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
      return b;
    }

    test('proto2: the armour is byte-identical to the pre-change implementation', function () {
      // Every size that exercises a different tail: the septet boundary at 7
      // bytes, the header at 28, a full frame at 693, the version 40 ceiling.
      var sizes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 27, 28, 29, 55, 56, 127, 128,
        255, 512, 665, 693, 1024, 2953];

      // Taken from the character-at-a-time implementation this replaced, over
      // exactly these sizes and this filler. It is the wire format: if this
      // digest moves, every v2 receiver in the world stops reading v2.
      var GOLDEN = '9423dc627887302a5916ab2e748abac7aee6c119baeda76ab2fbed2dd35ea909';

      var joined = [];
      var chars = 0;
      for (var i = 0; i < sizes.length; i++) {
        var frame = filler(sizes[i], i + 1);
        var text = P.toTransport(frame);
        eq(text.length, Math.ceil((sizes[i] * 8) / 7), 'armour length at ' + sizes[i] + ' B');
        eq(text, referenceArmour(frame), 'armour of ' + sizes[i] + ' B differs from the reference');
        sameBytes(P.fromTransport(text), frame, 'armour roundtrip at ' + sizes[i] + ' B');
        joined.push(text);
        chars += text.length;
      }
      eq(sha256Hex(armourBytes(joined.join(''))), GOLDEN, 'the armoured bytes moved');
      return sizes.length + ' sizes, ' + chars + ' armoured characters, digest unchanged';
    });

    test('proto2: armouring many frames does not retain a rope', function () {
      var g = typeof globalThis !== 'undefined' ? globalThis : null;
      var canWeigh = !!(g && typeof g.gc === 'function' && g.process &&
        typeof g.process.memoryUsage === 'function');
      if (!canWeigh) return 'skipped — needs node --expose-gc';

      // heapUsed + external, because a string lands in one and a typed array in
      // the other, and this test is about not confusing the two.
      function live() {
        var m = g.process.memoryUsage();
        return m.heapUsed + m.external;
      }
      function settle() { g.gc(); g.gc(); g.gc(); }

      var COUNT = 400;
      var frames = new Array(COUNT);
      for (var i = 0; i < COUNT; i++) frames[i] = filler(693, 1000 + i);

      settle();
      var before = live();
      var held = new Array(COUNT);
      var outBytes = 0;
      for (var j = 0; j < COUNT; j++) {
        held[j] = P.toTransport(frames[j]);
        outBytes += held[j].length;
      }
      settle();
      var perOutputByte = (live() - before) / outBytes;
      // Deliberately loose. A flat one-byte-per-character string measures about
      // 1.03 B per output byte here and the rope measured 31.58 — the interval
      // between them is two orders of magnitude wide, so a threshold of 4 can
      // absorb any amount of allocator noise and still fail the moment the
      // concatenation comes back.
      assert(perOutputByte < 4,
        'armouring ' + COUNT + ' frames retained ' + perOutputByte.toFixed(2) +
        ' B per output byte — a cons-string rope is back');
      // The strings must still be the strings. A cheap measurement of the wrong
      // thing is worse than no measurement.
      eq(held[0], referenceArmour(frames[0]), 'the first armoured frame is wrong');
      eq(held[COUNT - 1], referenceArmour(frames[COUNT - 1]), 'the last armoured frame is wrong');
      return COUNT + ' frames held at ' + perOutputByte.toFixed(2) + ' B per output byte (rope: 31.58)';
    });

    test('proto2: a parsed frame owns its payload, so the frame buffer is collectable', function () {
      var built = P.buildFrames(filler(2000, 41), { chunk: 665, name: 'own.bin' });
      var frame = built.frames[1];
      var parsed = P.parseFrame(frame);
      assert(parsed.ok, 'refused: ' + parsed.reason);
      var payload = parsed.frame.payload;

      // Structural: nothing sits in front of the payload and nothing sits
      // behind it. A subarray view of a 693-byte frame would fail both.
      eq(payload.byteOffset, 0, 'the payload starts partway into a larger buffer');
      eq(payload.buffer.byteLength, payload.length,
        'the payload is backed by a buffer larger than itself');
      eq(payload.length, parsed.frame.payloadLen, 'payload length');

      // Behavioural: the caller still holds the frame it passed in. Writing
      // through it must not reach the payload, or "owns" means nothing.
      var expected = payload.slice();
      frame[P.HEADER_BYTES] = frame[P.HEADER_BYTES] ^ 0xff;
      sameBytes(payload, expected, 'the payload changed when the caller mutated the frame');

      // The same for the armoured path, which is the one the app actually uses.
      var viaArmour = P.parseFrame(P.toTransport(built.frames[2]));
      assert(viaArmour.ok, 'armoured frame refused: ' + viaArmour.reason);
      eq(viaArmour.frame.payload.byteOffset, 0, 'armoured payload is offset into a frame buffer');
      eq(viaArmour.frame.payload.buffer.byteLength, viaArmour.frame.payload.length,
        'armoured payload is backed by the whole frame');
      return 'payload owns a ' + payload.buffer.byteLength + '-byte buffer, frame is ' +
        frame.length + ' B';
    });

    test('proto2: holding payloads costs less than holding views of frames', function () {
      var g = typeof globalThis !== 'undefined' ? globalThis : null;
      var canWeigh = !!(g && typeof g.gc === 'function' && g.process &&
        typeof g.process.memoryUsage === 'function');
      if (!canWeigh) return 'skipped — needs node --expose-gc';

      function live() {
        var m = g.process.memoryUsage();
        return m.heapUsed + m.external;
      }
      function settle() { g.gc(); g.gc(); g.gc(); }

      // The app's operating point: 665-byte payloads in 693-byte frames.
      //
      // Both arms start from armoured strings and NOT from a live frame list,
      // which is the whole point: a view costs nothing extra while something
      // else still holds the frame, and a receiver holds nothing else. Its
      // camera hands it one frame at a time. Measuring against a retained frame
      // list would show the header as free, which is the mistake that let this
      // through in the first place.
      var CHUNK = 665;
      var COUNT = 900;
      var armoured = new Array(COUNT);
      for (var i = 0; i < COUNT; i++) {
        armoured[i] = P.toTransport(P.encodeFrame({
          mode: P.MODE_INDEXED, codecId: P.CODEC_NONE, dictId: P.DICT_NONE,
          transferId: 1, index: i + 1, total: COUNT + 1, contentHash32: 0,
          payload: filler(CHUNK, 2000 + i)
        }));
      }

      // Both arms hold exactly COUNT typed arrays, so per-object overhead is
      // identical and the difference is only the bytes each one keeps alive.
      function weigh(pick) {
        settle();
        var before = live();
        var kept = new Array(COUNT);
        for (var k = 0; k < COUNT; k++) kept[k] = pick(armoured[k]);
        settle();
        var bytes = live() - before;
        kept.length = 0;
        return bytes;
      }

      // What the receiver used to hold: a payload-shaped window onto a frame
      // buffer that nothing else references, so the header rides along.
      var viewBytes = weigh(function (text) {
        return P.fromTransport(text).subarray(P.HEADER_BYTES);
      });
      var ownBytes = weigh(function (text) { return P.parseFrame(text).frame.payload; });

      var payloadTotal = CHUNK * COUNT;
      var viewRatio = viewBytes / payloadTotal;
      var ownRatio = ownBytes / payloadTotal;
      // A view pins the header too: 693/665 = 1.0421× the payload bytes. The
      // copy is what removes that, and this is the assertion that a future
      // change back to a view has to argue with.
      assert(ownBytes < viewBytes,
        'copied payloads (' + ownBytes + ' B) did not cost less than views (' + viewBytes + ' B)');
      var saved = (viewBytes - ownBytes) / COUNT;
      assert(saved > P.HEADER_BYTES / 2,
        'the saving was ' + saved.toFixed(1) + ' B per frame, well under the ' +
        P.HEADER_BYTES + '-byte header a view pins');
      return COUNT + ' payloads: owned ' + ownRatio.toFixed(3) + '× vs view ' +
        viewRatio.toFixed(3) + '× (saved ' + saved.toFixed(1) + ' B per frame, header is ' +
        P.HEADER_BYTES + ' B)';
    });

    // --- receiver discipline --------------------------------------------------

    test('proto2: the receiver refuses frames that disagree about the transfer', function () {
      var a = P.buildFrames(filler(300, 30), { chunk: 150, name: 'a.bin', transferId: '11111111' });
      var b = P.buildFrames(filler(300, 31), { chunk: 150, name: 'b.bin', transferId: '22222222' });
      var rx = P.createReceiver();
      assert(P.ingest(rx, a.frames[0]).accepted, 'first manifest refused');
      var other = P.ingest(rx, b.frames[1]);
      eq(other.accepted, false, 'a frame from another transfer was mixed in');
      eq(other.reason, 'other-transfer', 'reason');
      eq(P.ingest(rx, a.frames[0]).reason, 'duplicate', 'duplicate manifest');
      assert(P.ingest(rx, a.frames[1]).accepted, 'honest frame refused');
      eq(P.ingest(rx, a.frames[1]).reason, 'duplicate', 'duplicate data frame');

      // Same transfer id, contradictory codec: not something to average out.
      var mixed = P.encodeFrame({
        mode: 0, codecId: P.CODEC_BROTLI, dictId: 0, transferId: 0x11111111,
        index: 2, total: a.total, contentHash32: 0, payload: filler(150, 32)
      });
      eq(P.ingest(rx, mixed).reason, 'codec-mismatch', 'codec disagreement');
      return 'other-transfer, duplicate, and codec-mismatch all refused';
    });

    test('proto2: an incomplete transfer cannot be finalized', function () {
      var built = P.buildFrames(filler(600, 33), { chunk: 200, name: 'i.bin' });
      var rx = P.createReceiver();
      P.ingest(rx, built.frames[0]);
      P.ingest(rx, built.frames[1]);
      assert(!P.isComplete(rx), 'reported complete while a frame was missing');
      eq(P.finalize(rx).reason, 'incomplete', 'reason');
      // Data frames without their manifest are held, never assembled blind.
      var rx2 = P.createReceiver();
      for (var i = 1; i < built.frames.length; i++) P.ingest(rx2, built.frames[i]);
      assert(!P.isComplete(rx2), 'complete without a manifest');
      eq(P.finalize(rx2).reason, 'incomplete', 'reason without a manifest');
      return 'missing frame and missing manifest both refuse to finalize';
    });

    test('proto2: frames arriving out of order reassemble byte-exactly', function () {
      var bytes = filler(1400, 34);
      var built = P.buildFrames(bytes, { chunk: 200, name: 'o.bin' });
      var order = [];
      for (var i = 0; i < built.frames.length; i++) order.push(i);
      order.reverse(); // manifest last, data frames descending
      var rx = P.createReceiver();
      for (var j = 0; j < order.length; j++) {
        assert(P.ingest(rx, built.frames[order[j]]).accepted, 'frame ' + order[j] + ' refused');
      }
      var out = P.finalize(rx);
      assert(out.ok, 'refused: ' + out.reason);
      sameBytes(out.bytes, bytes, 'out-of-order reassembly');
      return built.frames.length + ' frames reversed, byte-exact';
    });

    test('proto2: the artifact name is sanitized on the way out', function () {
      var bytes = filler(64, 35);
      // A name a v2 sender is free to put on the wire, since the content hash
      // does not cover it. buildFrames sanitizes on send; finalize does it
      // again on receive, because the sender is not the one to be trusted.
      var body = P.encodeManifestBody({
        originalSize: 64, compressedSize: 64, contentHash: core.sha256Bytes(bytes),
        chunkSize: 64, k: 0, name: '../../etc/passwd'
      });
      var d = core.sha256Bytes(bytes);
      var ch32 = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
      var head = { mode: 0, codecId: 0, dictId: 0, transferId: 7, total: 2, contentHash32: ch32 };
      var rx = P.createReceiver();
      P.ingest(rx, P.encodeFrame({
        mode: head.mode, codecId: 0, dictId: 0, transferId: 7, index: 0,
        total: 2, contentHash32: ch32, payload: body
      }));
      P.ingest(rx, P.encodeFrame({
        mode: head.mode, codecId: 0, dictId: 0, transferId: 7, index: 1,
        total: 2, contentHash32: ch32, payload: bytes
      }));
      var out = P.finalize(rx);
      assert(out.ok, 'refused: ' + out.reason);
      eq(out.declaredName, '../../etc/passwd', 'the declared name should be reported verbatim');
      assert(out.name.indexOf('/') < 0, 'path separators survived: ' + out.name);
      assert(out.name.indexOf('..') !== 0, 'a leading .. survived: ' + out.name);
      sameBytes(out.bytes, bytes, 'artifact');
      return 'declared "' + out.declaredName + '" stored as "' + out.name + '"';
    });

    test('proto2: the ceilings are no looser than v1\'s', function () {
      eq(P.MAX_FRAMES, core.MAX_FRAMES, 'MAX_FRAMES');
      eq(P.MAX_RECEIVE_CHUNK, core.MAX_RECEIVE_CHUNK, 'MAX_RECEIVE_CHUNK');
      eq(P.MAX_ARTIFACT_BYTES, core.MAX_ARTIFACT_BYTES, 'MAX_ARTIFACT_BYTES');
      eq(P.MAX_NAME_LENGTH, core.MAX_NAME_LENGTH, 'MAX_NAME_LENGTH');
      // v2 is stricter in one place: a frame payload cannot exceed what a
      // version 40 symbol holds, whatever the u16 field would allow.
      eq(P.MAX_PAYLOAD_BYTES, core.MAX_RECEIVE_CHUNK, 'MAX_PAYLOAD_BYTES');
      assert(P.MAX_PAYLOAD_BYTES < 65535, 'the u16 payloadLen field is not bounded below its width');
      var threw = false;
      try {
        P.encodeFrame({
          mode: 0, codecId: 0, dictId: 0, transferId: 1, index: 1, total: 2,
          contentHash32: 0, payload: new Uint8Array(P.MAX_PAYLOAD_BYTES + 1)
        });
      } catch (e) { threw = true; }
      assert(threw, 'an over-ceiling payload was encoded');
      return 'four ceilings shared with v1, payload bounded to ' + P.MAX_PAYLOAD_BYTES + ' B';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
