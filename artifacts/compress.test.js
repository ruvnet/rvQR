/*!
 * rvQR adaptive compression test suite — standalone.
 *
 * Node:    `node artifacts/compress.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after core.js and compress.js, then call
 *          RVQRCompressTests.runAll(RVQRCompress).
 *
 * The decision half of compress.js is pure arithmetic over sizes, so those
 * tests are exact rather than tolerant and no codec runs in them at all — a
 * fake codec that returns a chosen length is enough to express any case,
 * including the ones no real codec would produce. That is deliberate: the
 * boundary cases this module exists for are boundary cases of the ARITHMETIC,
 * and pinning them to whatever brotli happens to do would make them untestable.
 *
 * Four groups carry most of the weight.
 *
 * The ENVELOPE group proves the decision is made on the envelope and not the
 * payload, at both edges of the 8% gate, and includes the measured band where
 * the two figures disagree: 1,000 B → 909 B is a 9.10% payload win and a 7.95%
 * envelope win, and it is refused.
 *
 * The IDENTIFIER group proves ADR-027 §2.2 cannot recur here — id 3 is
 * registered and refused, every admissible pair resolves to exactly one
 * decoder, and the disagreement with proto2.js's shipped table is reported per
 * id rather than assumed away.
 *
 * The DICTIONARY group proves fail-closed, and proves it against the measured
 * failure it exists for: a wrong dictionary of the right length is refused
 * before a decoder is handed back, because neither zstd nor raw deflate raises
 * anything when it decodes one.
 *
 * The PLANNER group proves the codec axis is an axis and not a second
 * mechanism: scoring the no-codec value reproduces planner.costTerms() term for
 * term, so the rebasing has not grown an objective of its own.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var compress = require('./compress.js');
      var results = api.runAll(compress);
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
    root.RVQRCompressTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The 40,989-byte microkernel and the 2,304-byte demo container: the two
  // artifacts docs/benchmarks.md and ADR-003 §1 both measure against.
  var WASM_BYTES = 40989;
  var RVF_BYTES = 2304;

  // ADR-003 §1's measured Brotli-6 outputs for those two, quoted so the
  // envelope verdicts below are verdicts about real compression rather than
  // about numbers chosen to produce them.
  var WASM_BROTLI6 = 16636;
  var RVF_BROTLI6 = 1745;

  function runAll(C) {
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
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
      }
    }

    function near(actual, expected, tolerance, msg) {
      if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected +
          ' ± ' + tolerance);
      }
    }

    function throws(reason, fn, msg) {
      var caught = null;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      assert(caught, (msg || 'expected a rejection') + ', nothing was thrown');
      eq(caught.reason, reason, msg || 'rejection reason');
      return caught;
    }

    /** A codec that returns a chosen number of bytes. No real codec required. */
    function fakeCodec(outputLength) {
      return {
        compress: function (bytes) {
          var n = typeof outputLength === 'function' ? outputLength(bytes.length) : outputLength;
          return new Uint8Array(Math.max(0, Math.floor(n)));
        },
        decompress: function () { throw new Error('not needed'); }
      };
    }

    /** A platform, described rather than probed, so a test can present any. */
    function platform(over) {
      over = over || {};
      var zlibFns = over.zlib === null ? null : (over.zlib || {
        brotliCompressSync: noop, brotliDecompressSync: noop,
        zstdCompressSync: noop, zstdDecompressSync: noop,
        deflateRawSync: noop, inflateRawSync: noop
      });
      var formats = over.streamFormats || [];
      var streams = formats.length
        ? function (f) { if (formats.indexOf(f) < 0) throw new Error('unsupported'); }
        : null;
      return {
        zlib: zlibFns,
        CompressionStream: streams,
        DecompressionStream: streams
      };
    }

    function noop() { return new Uint8Array(0); }

    /** A 64-character hex string of one digit — a digest that is not the digest. */
    function hexOf(digit) {
      var out = '';
      for (var i = 0; i < 64; i++) out += digit;
      return out;
    }

    function bytesOf(n, fill) {
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) out[i] = typeof fill === 'function' ? fill(i) : (fill || 0);
      return out;
    }

    // --- The envelope, and the gate on it ------------------------------------

    test('compress: the envelope model reproduces proto2.js’s frame geometry', function () {
      var one = C.envelopeBytes(764, { chunk: 764, armour: false, nameLen: 12 });
      eq(one.frames, 2, 'a 764 B stream is one manifest frame and one data frame');
      eq(one.bytes, (28 + 47 + 12) + (28 + 764), 'raw bytes are header + manifest + header + chunk');

      var armoured = C.envelopeBytes(764, { chunk: 764, armour: true, nameLen: 12 });
      eq(armoured.bytes, Math.ceil(87 * 8 / 7) + Math.ceil(792 * 8 / 7),
        'armour is 8/7 rounded up PER FRAME, not once at the end');

      var empty = C.envelopeBytes(0, { chunk: 764, armour: false, nameLen: 12 });
      eq(empty.frames, 1, 'an empty stream still pays a manifest frame');
      eq(empty.bytes, 87, 'and nothing else');
      return 'header 28 B, manifest body 47 B + name, armour 8/7 per frame';
    });

    test('compress: the restated frame constants still match proto2.js', function () {
      var P = null;
      try {
        P = typeof require === 'function' ? require('./proto2.js') : null;
      } catch (e) {
        P = null;
      }
      if (!P) return 'proto2.js not loadable here — constants unchecked, which is the honest report';
      eq(C.HEADER_BYTES, P.HEADER_BYTES, 'HEADER_BYTES drifted from proto2.js');
      eq(C.MANIFEST_FIXED_BYTES, P.MANIFEST_FIXED_BYTES, 'MANIFEST_FIXED_BYTES drifted from proto2.js');
      return 'HEADER_BYTES ' + P.HEADER_BYTES + ', MANIFEST_FIXED_BYTES ' + P.MANIFEST_FIXED_BYTES;
    });

    test('compress: a shrinking payload can leave the envelope short of the gate', function () {
      // Measured band, chunk 764, armour on: the payload clears 8% and the
      // envelope does not. Every one of these would be compressed by a payload
      // rule and is refused by this one.
      var band = [
        { original: 600, compressed: 543 },
        { original: 764, compressed: 694 },
        { original: 1000, compressed: 909 },
        { original: 1528, compressed: 1395 },
        { original: 3000, compressed: 2745 },
        { original: 10000, compressed: 9190 }
      ];
      band.forEach(function (row) {
        var cell = C.evaluate({
          originalBytes: row.original, compressedBytes: row.compressed, codecId: C.CODEC_BROTLI
        });
        assert(cell.payloadGain >= C.ENVELOPE_GAIN_GATE,
          row.original + ' B: the payload gain should clear the gate, got ' + cell.payloadGain);
        assert(cell.envelopeGain < C.ENVELOPE_GAIN_GATE,
          row.original + ' B: the envelope gain should not, got ' + cell.envelopeGain);
        eq(cell.passesGate, false, row.original + ' B should be refused');
        assert(cell.reason.indexOf('PAYLOAD clears') >= 0,
          row.original + ' B: the reason should name the disagreement, got ' + cell.reason);
      });
      return band.length + ' measured cases where payload and envelope disagree across 8%';
    });

    test('compress: the 8% rule takes opposite branches at its two edges', function () {
      // ADR-003 §4.3. Solved on the envelope, which is the thing being gated:
      // for a 40,989 B artifact the baseline envelope is fixed, so the LARGEST
      // compressed size that still clears the gate is found by bisection on the
      // model rather than asserted from a constant that could drift with it.
      var baseline = C.envelopeBytes(WASM_BYTES).bytes;
      var target = baseline * (1 - C.ENVELOPE_GAIN_GATE);
      var lo = 0;
      var hi = WASM_BYTES;
      while (lo < hi) {
        var mid = Math.ceil((lo + hi) / 2);
        if (C.envelopeBytes(mid).bytes <= target) lo = mid; else hi = mid - 1;
      }
      var justPasses = C.evaluate({ originalBytes: WASM_BYTES, compressedBytes: lo });
      var justFails = C.evaluate({ originalBytes: WASM_BYTES, compressedBytes: lo + 1 });
      eq(justPasses.passesGate, true, lo + ' B should clear the gate');
      eq(justFails.passesGate, false, (lo + 1) + ' B should miss it');
      assert(justPasses.envelopeGain >= C.ENVELOPE_GAIN_GATE, 'passing side below the gate');
      assert(justFails.envelopeGain < C.ENVELOPE_GAIN_GATE, 'failing side above the gate');
      return 'boundary at ' + lo + ' B compressed, gain ' +
        (justPasses.envelopeGain * 100).toFixed(3) + '% against ' +
        (justFails.envelopeGain * 100).toFixed(3) + '%';
    });

    test('compress: an incompressible artifact costs bytes and is refused', function () {
      // Measured: brotli quality 6 on 8,192 bytes of crypto.randomBytes returns
      // 8,196, and on the already-brotli-compressed WASM module returns 16,640.
      [{ o: 8192, c: 8196 }, { o: WASM_BROTLI6, c: WASM_BROTLI6 + 4 }].forEach(function (row) {
        var cell = C.evaluate({ originalBytes: row.o, compressedBytes: row.c, codecId: C.CODEC_BROTLI });
        assert(cell.envelopeGain < 0, row.o + ' B: the envelope should have grown, got ' + cell.envelopeGain);
        eq(cell.passesGate, false, row.o + ' B should be refused');
        eq(cell.framesSaved, 0, row.o + ' B: no frame should be saved');
        assert(cell.reason.indexOf('did not shrink at all') >= 0, 'the reason should say so: ' + cell.reason);
      });
      var decision = C.choose({
        originalBytes: 8192,
        candidates: [{ codecId: C.CODEC_BROTLI, compressedBytes: 8196 }]
      });
      eq(decision.compress, false, 'the decision should decline');
      eq(decision.codecId, C.CODEC_NONE, 'and set codec id 0');
      eq(decision.streamBytes, 8192, 'and send the artifact as it stands');
      return 'brotli-6 on random bytes: 8,192 → 8,196, envelope +5 B, refused';
    });

    test('compress: the repository’s own artifacts clear the gate, with their real figures', function () {
      var wasm = C.evaluate({
        originalBytes: WASM_BYTES, compressedBytes: WASM_BROTLI6, codecId: C.CODEC_BROTLI
      });
      var rvf = C.evaluate({
        originalBytes: RVF_BYTES, compressedBytes: RVF_BROTLI6, codecId: C.CODEC_BROTLI, nameLen: 15
      });
      eq(wasm.passesGate, true, 'the 40,989 B module should compress');
      eq(rvf.passesGate, true, 'the 2,304 B container should compress');
      near(wasm.ratio, 2.464, 0.001, 'ADR-003 §1’s measured WASM ratio');
      near(rvf.ratio, 1.320, 0.001, 'ADR-003 §1’s measured RVF ratio');
      assert(wasm.envelopeGain > 0.59 && wasm.envelopeGain < 0.60,
        'WASM envelope gain should be ~59.3%, got ' + wasm.envelopeGain);
      assert(rvf.envelopeGain > 0.23 && rvf.envelopeGain < 0.24,
        'RVF envelope gain should be ~23.4%, got ' + rvf.envelopeGain);
      eq(wasm.framesBefore, 55, 'WASM baseline frames at chunk 764');
      eq(wasm.framesAfter, 23, 'WASM compressed frames');
      eq(rvf.framesBefore, 5, 'RVF baseline frames');
      eq(rvf.framesAfter, 4, 'RVF compressed frames');
      return 'wasm ' + wasm.ratio.toFixed(3) + '× → ' + (wasm.envelopeGain * 100).toFixed(2) +
        '% envelope, ' + wasm.framesBefore + ' → ' + wasm.framesAfter + ' frames; rvf ' +
        rvf.ratio.toFixed(3) + '× → ' + (rvf.envelopeGain * 100).toFixed(2) + '%, ' +
        rvf.framesBefore + ' → ' + rvf.framesAfter + ' frames';
    });

    test('compress: every result carries both figures whether it passed or failed', function () {
      var cases = [
        { o: WASM_BYTES, c: WASM_BROTLI6 },
        { o: 1000, c: 909 },
        { o: 8192, c: 8196 },
        { o: RVF_BYTES, c: RVF_BROTLI6 }
      ];
      cases.forEach(function (row) {
        var cell = C.evaluate({ originalBytes: row.o, compressedBytes: row.c });
        ['payloadGain', 'envelopeGain', 'envelopeBefore', 'envelopeAfter', 'framesBefore',
          'framesAfter', 'ratio', 'margin'].forEach(function (key) {
          assert(typeof cell[key] === 'number' && isFinite(cell[key]),
            row.o + '/' + row.c + ' is missing a finite ' + key);
        });
        assert(cell.reason.indexOf('payload ') >= 0 && cell.reason.indexOf('envelope ') >= 0,
          'the reason must quote both figures: ' + cell.reason);
        near(cell.margin, cell.envelopeGain - cell.gate, 1e-12, 'margin should be gain − gate');
      });
      return cases.length + ' results, each reporting the codec’s number and the transport’s';
    });

    test('compress: a bigger chunk changes the verdict, and the chunk is an argument', function () {
      // The manifest frame and the header are the whole of the effect, so the
      // same two payload sizes are judged differently at different chunks.
      var small = C.evaluate({ originalBytes: 1200, compressedBytes: 1090, chunk: 256 });
      var large = C.evaluate({ originalBytes: 1200, compressedBytes: 1090, chunk: 764 });
      assert(small.envelopeGain !== large.envelopeGain,
        'the chunk must move the envelope gain, got ' + small.envelopeGain + ' both ways');
      eq(small.chunk, 256, 'the chunk is reported back');
      eq(large.chunk, 764, 'and it is the one that was asked for');
      return 'chunk 256 → ' + (small.envelopeGain * 100).toFixed(2) + '%, chunk 764 → ' +
        (large.envelopeGain * 100).toFixed(2) + '%';
    });

    // --- The identifier determines the decoder -------------------------------

    test('compress: the codec table is ADR-003 §2.1, ids and all', function () {
      var expected = [
        [0, 'none'], [1, 'lz4'], [2, 'zstd'], [3, 'custom'],
        [4, 'brotli'], [5, 'scf1'], [6, 'deflate-raw']
      ];
      eq(C.CODECS.length, expected.length, 'codec count');
      expected.forEach(function (row) {
        var codec = C.codecById(row[0]);
        assert(codec, 'no codec at id ' + row[0]);
        eq(codec.name, row[1], 'id ' + row[0]);
      });
      eq(C.CODEC_ZSTD, 2, 'Zstd keeps RuVector’s id');
      eq(C.CODEC_BROTLI, 4, 'Brotli takes an rvQR extension id');
      return '0 none, 1 lz4, 2 zstd, 3 custom, 4 brotli, 5 scf1, 6 deflate-raw';
    });

    test('compress: id 3 is registered and refused — ADR-027 §2.2 cannot recur here', function () {
      var custom = C.codecById(C.CODEC_CUSTOM);
      assert(custom, 'id 3 must be in the table, so a receiver can say what it means');
      eq(custom.usable, false, 'and it must not be usable');
      var caught = throws('ambiguous-codec', function () {
        C.decoderFor(C.CODEC_CUSTOM, C.DICT_NONE);
      }, 'resolving a decoder for Custom');
      assert(caught.message.indexOf('ADR-027') >= 0, 'the message should cite the record: ' + caught.message);
      throws('ambiguous-codec', function () {
        C.compressWith(bytesOf(64, 1), C.CODEC_CUSTOM, { custom: fakeCodec(10) });
      }, 'compressing with Custom, even with an implementation to hand');
      return 'an id that names no decoder is unrepresentable rather than discouraged';
    });

    test('compress: no reachable path can select the reserved id, anywhere', function () {
      // "Registered and refused" has to be structural, not a habit. Id 3 must
      // be absent from every list a decision is made from, not merely rejected
      // if something asked for it.
      var detection = C.detectCodecs(platform());
      var order = C.preferenceOrder(bytesOf(64, 5), detection, {});
      eq(order.indexOf(C.CODEC_CUSTOM), -1, 'the preference order offered id 3');

      var axis = C.codecAxis({ env: platform() });
      axis.forEach(function (v) {
        assert(v.codecId !== C.CODEC_CUSTOM, 'the codec axis offered id 3');
      });

      var available = detection.available.map(function (r) { return r.id; });
      eq(available.indexOf(C.CODEC_CUSTOM), -1, 'detection reported id 3 as available');

      // Even asked for by name, and even with an implementation to hand.
      throws('ambiguous-codec', function () {
        C.preferenceOrder(bytesOf(64, 5), detection, { prefer: 'custom' }) &&
          C.compressWith(bytesOf(64, 1), C.CODEC_CUSTOM, { custom: fakeCodec(1) });
      }, 'forcing it through the preference');

      // And the general invariant: nothing usable may be ambiguous.
      C.CODECS.forEach(function (codec) {
        if (codec.family === 'ambiguous') {
          eq(codec.usable, false, codec.name + ' is ambiguous and must not be usable');
        }
        if (codec.usable) {
          assert(codec.family !== 'ambiguous',
            codec.name + ' is usable and must therefore name a decoder');
        }
      });
      return 'id 3 is in no order, no axis, no availability list, and no decision';
    });

    test('compress: every admissible id resolves to exactly one decoder', function () {
      var seen = {};
      C.CODECS.forEach(function (codec) {
        if (!codec.usable) return;
        var decoder = C.decoderFor(codec.id, C.DICT_NONE);
        eq(decoder.codecId, codec.id, 'the decoder should carry the id it was asked for');
        eq(decoder.codecName, codec.name, 'and name the codec');
        eq(decoder.dictId, 0, 'and say no dictionary explicitly');
        assert(decoder.description.indexOf('id ' + codec.id) >= 0,
          'the description should be readable by a human: ' + decoder.description);
        assert(!seen[decoder.description], 'two ids produced the same decoder description');
        seen[decoder.description] = true;
      });
      throws('unknown-codec', function () { C.decoderFor(7, 0); }, 'an id past the table');
      throws('unknown-codec', function () { C.decoderFor(-1, 0); }, 'a negative id');
      return Object.keys(seen).length + ' ids, ' + Object.keys(seen).length + ' distinct decoders';
    });

    test('compress: proto2.js’s shipped table disagrees, and that is reported per id', function () {
      var divergence = C.describeWireDivergence();
      var byId = {};
      divergence.rows.forEach(function (row) { byId[row.id] = row; });

      eq(byId[0].agrees, true, 'id 0 agrees in both tables');
      eq(byId[1].agrees, false, 'id 1 is lz4 here and scf1 in proto2.js');
      eq(byId[2].agrees, false, 'id 2 is zstd here and deflate-raw in proto2.js');
      eq(byId[3].agrees, false, 'id 3 is custom here and brotli in proto2.js');

      eq(C.wireCompatible(C.CODEC_NONE).ok, true, 'codec 0 crosses the wire today');
      eq(C.wireCompatible(C.CODEC_ZSTD).ok, false, 'codec 2 would be decoded as deflate-raw');
      assert(C.wireCompatible(C.CODEC_ZSTD).reason.indexOf('ADR-027') >= 0,
        'and the reason should name the defect: ' + C.wireCompatible(C.CODEC_ZSTD).reason);
      eq(C.wireCompatible(C.CODEC_BROTLI).ok, false, 'codec 4 is refused by parseFrame outright');
      assert(C.wireCompatible(C.CODEC_BROTLI).reason.indexOf('unknown-codec') >= 0,
        'naming the rejection proto2 would give: ' + C.wireCompatible(C.CODEC_BROTLI).reason);
      assert(divergence.required.indexOf('DICT_NAMES') >= 0,
        'the dictionary field’s ceiling should be reported too');
      return 'ids 1, 2 and 3 mean different codecs in the two tables; 4, 5 and 6 are refused';
    });

    // --- Platform detection --------------------------------------------------

    test('compress: availability is detected, and nothing is claimed that is absent', function () {
      var nothing = C.detectCodecs({});
      eq(nothing.anyAvailable, false, 'a platform with neither zlib nor streams has no codec');
      nothing.codecs.forEach(function (row) {
        if (row.id === C.CODEC_NONE) return;
        eq(row.available, false, row.name + ' should be unavailable');
        assert(row.reason.length > 0, row.name + ' should say why');
      });

      var node = C.detectCodecs(platform());
      var byName = {};
      node.codecs.forEach(function (row) { byName[row.name] = row; });
      eq(byName.zstd.available, true, 'zstd from node:zlib');
      eq(byName.brotli.available, true, 'brotli from node:zlib');
      eq(byName['deflate-raw'].available, true, 'deflate-raw from node:zlib');
      eq(byName.lz4.available, false, 'lz4 has no implementation anywhere in this repository');
      eq(byName.scf1.available, false, 'nor does scf1');
      eq(byName.custom.available, false, 'and Custom is refused rather than absent');
      return nothing.available.length + ' codecs on a bare platform, ' +
        node.available.length + ' on one with node:zlib';
    });

    test('compress: a browser has deflate-raw and does NOT have brotli or zstd', function () {
      // The WHATWG Compression Streams format list is gzip, deflate,
      // deflate-raw. A browser has no zlib.
      var browser = C.detectCodecs(platform({
        zlib: null,
        streamFormats: ['gzip', 'deflate', 'deflate-raw']
      }));
      var byName = {};
      browser.codecs.forEach(function (row) { byName[row.name] = row; });
      eq(byName['deflate-raw'].available, true, 'deflate-raw is the one codec every browser has');
      eq(byName['deflate-raw'].via, 'CompressionStream', 'and it comes from the stream API');
      assert(byName['deflate-raw'].reason.indexOf('asynchronous') >= 0,
        'which is asynchronous, and that must be said: ' + byName['deflate-raw'].reason);
      eq(byName.brotli.available, false, 'no browser exposes brotli through CompressionStream');
      eq(byName.zstd.available, false, 'nor zstd');
      eq(byName['deflate-raw'].supportsDictionary, false,
        'and CompressionStream takes no dictionary parameter');
      return 'browser: deflate-raw only, asynchronous, no dictionary';
    });

    test('compress: a CompressionStream that accepts “brotli” does not make brotli available', function () {
      // Node v22.22.1 constructs new CompressionStream('brotli') without error.
      // That is a Node extension to the WHATWG list, and reading it as browser
      // brotli would claim a codec no browser implements.
      var probed = C.detectCodecs(platform({
        zlib: null,
        streamFormats: ['gzip', 'deflate', 'deflate-raw', 'brotli']
      }));
      var brotli = null;
      probed.codecs.forEach(function (row) { if (row.name === 'brotli') brotli = row; });
      eq(brotli.available, false, 'the non-standard probe must not promote brotli');
      assert(probed.streamFormats.indexOf('brotli') >= 0, 'the probe result is still recorded');
      eq(probed.nonStandardStreamFormats.length, 1, 'and flagged as outside the specification');
      eq(probed.nonStandardStreamFormats[0], 'brotli', 'by name');
      assert(brotli.reason.indexOf('Node extension') >= 0,
        'and the reason should say what it is: ' + brotli.reason);
      eq(C.STANDARD_STREAM_FORMATS.join(','), 'gzip,deflate,deflate-raw',
        'the standard list is three formats and none of them is brotli');
      return 'a Node-only format string is recorded, not believed';
    });

    test('compress: no codec at all is a decision, not an error', function () {
      var decision = C.compressArtifact(bytesOf(4096, function (i) { return i & 0xff; }), {
        env: {},
        codecs: {}
      });
      eq(decision.compress, false, 'nothing to compress with means no compression');
      eq(decision.codecId, C.CODEC_NONE, 'codec id 0');
      eq(decision.dictId, C.DICT_NONE, 'dictionary 0');
      eq(decision.streamBytes, 4096, 'the artifact goes as it stands');
      assert(decision.reason.indexOf('no codec was available') >= 0,
        'and the reason says so: ' + decision.reason);
      assert(decision.decoder, 'a decoder is still named');
      eq(decision.decoder.codecName, 'none', 'and it is the null decoder');
      eq(decision.wire.ok, true, 'which every proto2.js receiver already accepts');
      return 'the same shape as a decision that tried three codecs and refused them all';
    });

    // --- Dictionaries --------------------------------------------------------

    test('compress: rvQR ships no dictionary, and says so rather than implying it', function () {
      eq(C.DICTIONARIES.length, 0, 'ADR-003 §2.4: no corpus assembled, no dictionary trained');
      eq(C.DICT_NONE, 0, 'and 0 means none, declared');
      var axis = C.codecAxis({ env: platform() });
      axis.forEach(function (value) {
        eq(value.dictId, 0, 'no axis value may carry a dictionary that does not exist');
      });
      return axis.length + ' axis values, every one at dictId 0';
    });

    test('compress: a dictionary is identified by id, version AND the digest of its bytes', function () {
      var dict = C.defineDictionary({ id: 1, version: 3, bytes: bytesOf(512, 7), label: 'rvf-structural' });
      eq(dict.id, 1, 'id');
      eq(dict.version, 3, 'version');
      eq(dict.byteLength, 512, 'length');
      eq(typeof dict.digest, 'string', 'digest is a hex string');
      eq(dict.digest.length, 64, 'a full SHA-256');

      var twin = C.defineDictionary({ id: 1, version: 3, bytes: bytesOf(512, 8) });
      eq(twin.id, dict.id, 'the same id');
      eq(twin.version, dict.version, 'and the same version');
      assert(twin.digest !== dict.digest, 'but different bytes must hash differently');

      throws('bad-dictionary-id', function () { C.defineDictionary({ id: 0, version: 1, bytes: bytesOf(8) }); });
      throws('bad-dictionary-version', function () { C.defineDictionary({ id: 1, bytes: bytesOf(8) }); });
      throws('bad-dictionary', function () { C.defineDictionary({ id: 1, version: 0 }); });
      return 'two dictionaries agreeing on id and version and disagreeing on bytes are distinguishable';
    });

    test('compress: a dictionary mismatch fails closed, in all three ways it can be wrong', function () {
      var held = [C.defineDictionary({ id: 1, version: 3, bytes: bytesOf(512, 7) })];

      var ok = C.resolveDictionary({ dictId: 1, dictVersion: 3, digest: held[0].digest }, held);
      eq(ok.id, 1, 'the matching case still resolves');

      throws('unknown-dictionary', function () {
        C.resolveDictionary({ dictId: 2 }, held);
      }, 'an id nobody deployed');
      throws('dictionary-version-mismatch', function () {
        C.resolveDictionary({ dictId: 1, dictVersion: 4 }, held);
      }, 'a version skew');
      var caught = throws('dictionary-digest-mismatch', function () {
        C.resolveDictionary({ dictId: 1, dictVersion: 3, digest: hexOf('f') }, held);
      }, 'two dictionaries agreeing on their labels and disagreeing on their bytes');
      assert(caught.message.indexOf('right number of wrong bytes') >= 0,
        'and the message should say why this is checked here: ' + caught.message);

      eq(C.resolveDictionary({ dictId: 0 }, held), null, 'dictId 0 resolves to no dictionary, not an error');
      return 'no branch returns a dictionary it could not confirm';
    });

    test('compress: a decoder is not handed back for a dictionary that did not check out', function () {
      var held = [C.defineDictionary({ id: 1, version: 3, bytes: bytesOf(512, 7) })];
      var good = C.decoderFor(C.CODEC_ZSTD, 1, held, { dictVersion: 3, digest: held[0].digest });
      eq(good.dictId, 1, 'the good case names the dictionary');
      eq(good.dictVersion, 3, 'and its version');
      eq(good.dictDigest, held[0].digest, 'and its digest');
      assert(good.description.indexOf('sha256') >= 0, 'in a description a receiver can log');

      throws('dictionary-digest-mismatch', function () {
        C.decoderFor(C.CODEC_ZSTD, 1, held, { dictVersion: 3, digest: hexOf('0') });
      }, 'a wrong dictionary of the right length');
      throws('unknown-dictionary', function () {
        C.decoderFor(C.CODEC_ZSTD, 9, held);
      }, 'a dictionary this receiver does not hold');
      return 'the check runs before the decoder exists, not after the transfer is spent';
    });

    test('compress: brotli refuses a dictionary rather than accepting one it will ignore', function () {
      // Measured: node:zlib brotliCompressSync returns 1,746 B with and without
      // a {dictionary} option, and raises nothing. A stream labelled with a
      // dictionary it was not built with is the ADR-027 §2.2 defect exactly.
      eq(C.codecById(C.CODEC_BROTLI).supportsDictionary, false, 'brotli must not claim dictionary support');
      var held = [C.defineDictionary({ id: 1, version: 0, bytes: bytesOf(512, 7) })];
      var caught = throws('codec-takes-no-dictionary', function () {
        C.decoderFor(C.CODEC_BROTLI, 1, held, { dictVersion: 0, digest: held[0].digest });
      }, 'naming a brotli stream as dictionary-compressed');
      assert(caught.message.indexOf('silently ignores') >= 0,
        'and the message should say what node:zlib actually does: ' + caught.message);
      throws('codec-takes-no-dictionary', function () {
        C.compressWith(bytesOf(64, 1), C.CODEC_BROTLI, { brotli: fakeCodec(32) }, { dictionary: held[0] });
      }, 'and compressing that way');
      return 'the option node:zlib accepts and ignores cannot be used to mislabel a stream';
    });

    // --- Choosing ------------------------------------------------------------

    test('compress: the winner is the smallest ENVELOPE, and ties break on the codec id', function () {
      var decision = C.choose({
        originalBytes: WASM_BYTES,
        candidates: [
          { codecId: C.CODEC_DEFLATE_RAW, compressedBytes: 18013 },
          { codecId: C.CODEC_BROTLI, compressedBytes: WASM_BROTLI6 },
          { codecId: C.CODEC_ZSTD, compressedBytes: 17193 }
        ]
      });
      eq(decision.compress, true, 'all three clear the gate');
      eq(decision.codecId, C.CODEC_BROTLI, 'and brotli produced the smallest envelope');
      eq(decision.considered.length, 3, 'every codec tried is reported');
      assert(decision.reason.indexOf('ahead of') >= 0, 'the reason names the runner-up: ' + decision.reason);

      var tie = C.choose({
        originalBytes: WASM_BYTES,
        candidates: [
          { codecId: C.CODEC_DEFLATE_RAW, compressedBytes: 17000 },
          { codecId: C.CODEC_BROTLI, compressedBytes: 17000 },
          { codecId: C.CODEC_ZSTD, compressedBytes: 17000 }
        ]
      });
      eq(tie.codecId, C.CODEC_ZSTD, 'a tie goes to the lower id — Zstd is ADR-003 §2.1’s default');
      return 'brotli 16,636 B beats zstd 17,193 B beats deflate-raw 18,013 B on the real module';
    });

    test('compress: the decision does not depend on the order the codecs were tried', function () {
      var candidates = [
        { codecId: C.CODEC_ZSTD, compressedBytes: 17193 },
        { codecId: C.CODEC_BROTLI, compressedBytes: WASM_BROTLI6 },
        { codecId: C.CODEC_DEFLATE_RAW, compressedBytes: 18013 }
      ];
      var forward = C.choose({ originalBytes: WASM_BYTES, candidates: candidates });
      var backward = C.choose({ originalBytes: WASM_BYTES, candidates: candidates.slice().reverse() });
      eq(forward.codecId, backward.codecId, 'reversing the input changed the winner');
      eq(forward.streamBytes, backward.streamBytes, 'and the stream');
      eq(forward.envelopeBytes, backward.envelopeBytes, 'and the envelope');
      return 'deterministic: the platform’s codec ordering cannot move the choice';
    });

    test('compress: the same bytes decide the same way twice, and no clock is read', function () {
      var bytes = bytesOf(20000, function (i) { return (i * 7) & 0xff; });
      var codecs = { zstd: fakeCodec(9000), brotli: fakeCodec(8500), 'deflate-raw': fakeCodec(9500) };
      var a = C.compressArtifact(bytes, { env: platform(), codecs: codecs });
      var b = C.compressArtifact(bytes, { env: platform(), codecs: codecs });
      eq(a.codecId, b.codecId, 'the codec moved between two identical runs');
      eq(a.streamBytes, b.streamBytes, 'the stream moved');
      eq(a.envelopeBytes, b.envelopeBytes, 'the envelope moved');
      eq(a.reason, b.reason, 'the reasoning moved');
      return 'pure over its inputs: nothing here times anything';
    });

    test('compress: above 8 MB an estimate is taken, and an overturned estimate is reported', function () {
      // The prefix is chosen to compress well and the tail not to, so the
      // estimate passes and the whole-artifact measurement refuses it. An
      // estimate that says yes is a reason to measure, not a reason to ship.
      var total = 9 * 1024 * 1024;
      var prefix = 64 * 1024;
      var lying = {
        compress: function (bytes) {
          // Prefix: 10× smaller. Whole artifact: no gain at all.
          var out = bytes.length <= prefix ? Math.floor(bytes.length / 10) : bytes.length;
          return new Uint8Array(out);
        }
      };
      var decision = C.compressArtifact(bytesOf(total, 0), {
        env: platform({ zlib: { zstdCompressSync: noop, zstdDecompressSync: noop } }),
        codecs: { zstd: lying },
        samplePrefix: prefix
      });
      eq(decision.sampled, true, 'a 9 MiB artifact is above the 8 MB sampling threshold');
      eq(decision.samplePrefixBytes, prefix, 'and the prefix length is reported');
      eq(decision.compress, false, 'the full measurement refused what the estimate admitted');
      eq(decision.overturned.length, 1, 'and the overturn is reported rather than absorbed');
      assert(decision.overturned[0].note.indexOf('overturned') >= 0,
        'in words: ' + decision.overturned[0].note);

      var small = C.compressArtifact(bytesOf(4096, 0), {
        env: platform({ zlib: { zstdCompressSync: noop, zstdDecompressSync: noop } }),
        codecs: { zstd: fakeCodec(1000) }
      });
      eq(small.sampled, false, 'under the threshold the whole artifact is compared for real');
      eq(small.samplePrefixBytes, null, 'and no prefix is quoted');
      return 'estimate on ' + prefix + ' B passed, full 9 MiB measurement refused it';
    });

    test('compress: a codec declined on its sample is reported as declined, not as measured', function () {
      // The other half of the sampled path: an estimate that fails means the
      // whole artifact was never encoded, so there is no compressed size to
      // report and inventing one would put a number in the report that nothing
      // produced.
      var decision = C.compressArtifact(bytesOf(9 * 1024 * 1024, 0), {
        env: platform({ zlib: { zstdCompressSync: noop, zstdDecompressSync: noop } }),
        codecs: { zstd: { compress: function (bytes) { return new Uint8Array(bytes.length); } } },
        samplePrefix: 32 * 1024
      });
      eq(decision.compress, false, 'a codec that gains nothing should be declined');
      eq(decision.considered.length, 0, 'and nothing should be reported as measured');
      eq(decision.declined.length, 1, 'the decline is reported instead');
      eq(decision.declined[0].codecName, 'zstd', 'by name');
      assert(decision.declined[0].note.indexOf('never encoded') >= 0,
        'saying the full encode never happened: ' + decision.declined[0].note);
      assert(decision.reason.indexOf('were available and every one was declined') >= 0,
        'and the decision must not claim no codec existed: ' + decision.reason);
      return 'declined on a 32 KiB sample, and the report says so rather than reporting a zero';
    });

    test('compress: ADR-003 §2.3’s HTML branch is implemented, not deferred to the caller', function () {
      // core.detectArtifactType() has no HTML kind, so this half of §2.3 has to
      // be decided here or not at all.
      function ascii(text) {
        var out = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
        return out;
      }
      eq(C.classifyArtifact(ascii('<!doctype html><html><body>hi')), 'html', 'a doctype');
      eq(C.classifyArtifact(ascii('<!DOCTYPE HTML PUBLIC "-//W3C//">')), 'html', 'shouting');
      eq(C.classifyArtifact(ascii('\n\n  <html lang="en">')), 'html', 'leading whitespace');
      eq(C.classifyArtifact(ascii('{"not":"html"}')), 'generic', 'JSON is not HTML');

      // A binary that happens to contain the bytes '<html' must not be routed
      // as HTML: the sniff stops at the first NUL rather than hunting.
      var binary = new Uint8Array(64);
      binary[0] = 0; binary[1] = 1;
      var marker = ascii('<html>');
      for (var m = 0; m < marker.length; m++) binary[10 + m] = marker[m];
      eq(C.classifyArtifact(binary), 'generic', 'a binary containing <html is not HTML');

      var wasm = new Uint8Array(64);
      wasm[0] = 0x00; wasm[1] = 0x61; wasm[2] = 0x73; wasm[3] = 0x6d;
      eq(C.classifyArtifact(wasm), 'wasm', 'the WASM magic still wins');

      var detection = C.detectCodecs(platform());
      eq(C.preferenceOrder(ascii('<!doctype html><html>'), detection, {})[0], C.CODEC_BROTLI,
        'HTML prefers brotli, per §2.3');
      eq(C.preferenceOrder(ascii('{"a":1}'), detection, {})[0], C.CODEC_ZSTD,
        'everything else prefers zstd, per §2.1’s default');
      return 'wasm and html → brotli (id 4), everything else → zstd (id 2)';
    });

    test('compress: the estimate can run at a different level, and the report says whether it did', function () {
      // ADR-003 §2.3 wants the 1 MB prefix encoded at a FAST level. The level
      // belongs to the injected codec, so the only honest mechanism is a second
      // map — and the result has to say which one was used.
      var slowCalls = 0;
      var fastCalls = 0;
      var slow = { compress: function (b) { slowCalls++; return new Uint8Array(Math.floor(b.length / 4)); } };
      var fast = { compress: function (b) { fastCalls++; return new Uint8Array(Math.floor(b.length / 3)); } };
      var env = platform({ zlib: { zstdCompressSync: noop, zstdDecompressSync: noop } });

      var split = C.compressArtifact(bytesOf(9 * 1024 * 1024, 0), {
        env: env, codecs: { zstd: slow }, sampleCodecs: { zstd: fast }, samplePrefix: 64 * 1024
      });
      eq(split.sampleCodecsDistinct, true, 'a distinct sample map should be reported as distinct');
      eq(fastCalls, 1, 'the fast codec should have encoded the prefix exactly once');
      eq(slowCalls, 1, 'and the slow codec the whole artifact exactly once');
      eq(split.compress, true, 'and the full result cleared the gate');

      slowCalls = 0; fastCalls = 0;
      var same = C.compressArtifact(bytesOf(9 * 1024 * 1024, 0), {
        env: env, codecs: { zstd: slow }, samplePrefix: 64 * 1024
      });
      eq(same.sampleCodecsDistinct, false,
        'without a sample map the estimate ran at the same level, and must not imply otherwise');
      eq(slowCalls, 2, 'the one codec encoded both the prefix and the whole artifact');

      var under = C.compressArtifact(bytesOf(4096, 0), {
        env: env, codecs: { zstd: slow }, sampleCodecs: { zstd: fast }
      });
      eq(under.sampleCodecsDistinct, null, 'under 8 MB nothing is sampled, so there is nothing to report');
      eq(under.sampled, false, 'and §2.3’s whole-artifact branch ran instead');
      return 'prefix at the fast level, full encode at the real one, and the report distinguishes them';
    });

    test('compress: under 8 MB nothing is estimated — the whole artifact is compared', function () {
      // §2.3's first branch has no estimate in it at all, and the boundary is
      // exactly 8 MB. A codec must see the whole artifact and nothing else.
      var seen = [];
      var codec = { compress: function (b) { seen.push(b.length); return new Uint8Array(b.length); } };
      var env = platform({ zlib: { zstdCompressSync: noop, zstdDecompressSync: noop } });

      var atBoundary = 8 * 1024 * 1024;
      var d = C.compressArtifact(bytesOf(atBoundary, 0), { env: env, codecs: { zstd: codec } });
      eq(d.sampled, false, 'exactly 8 MB is not above the threshold');
      eq(seen.length, 1, 'one encode');
      eq(seen[0], atBoundary, 'of the whole artifact');

      seen = [];
      var over = C.compressArtifact(bytesOf(atBoundary + 1, 0), { env: env, codecs: { zstd: codec } });
      eq(over.sampled, true, 'one byte more is above it');
      eq(seen[0], C.SAMPLE_PREFIX_BYTES, 'and the first encode is the 1 MB prefix');
      eq(C.SAMPLE_ABOVE_BYTES, 8 * 1024 * 1024, 'the threshold is §2.3’s 8 MB');
      eq(C.SAMPLE_PREFIX_BYTES, 1024 * 1024, 'and the prefix is §2.3’s 1 MB');
      return '8 MB whole-artifact, 8 MB + 1 B sampled at a 1 MiB prefix';
    });

    test('compress: type preference orders the codecs and does not select them', function () {
      // ADR-003 §2.3 prefers Brotli for WASM. §2.3's other half compresses and
      // compares for real under 8 MB, so the preference is a tie-break.
      var wasm = new Uint8Array(64);
      wasm[0] = 0x00; wasm[1] = 0x61; wasm[2] = 0x73; wasm[3] = 0x6d;
      var order = C.preferenceOrder(wasm, C.detectCodecs(platform()), {});
      eq(order[0], C.CODEC_BROTLI, 'a WASM module puts brotli first');

      var generic = C.preferenceOrder(bytesOf(64, 5), C.detectCodecs(platform()), {});
      eq(generic[0], C.CODEC_ZSTD, 'everything else puts zstd first, per ADR-003 §2.1');

      var forced = C.preferenceOrder(wasm, C.detectCodecs(platform()), { prefer: 'deflate-raw' });
      eq(forced[0], C.CODEC_DEFLATE_RAW, 'a caller that knows better can say so');

      // The preference must not decide the outcome: brotli goes first and loses.
      var decision = C.compressArtifact(wasm, {
        env: platform(),
        codecs: { brotli: fakeCodec(50), zstd: fakeCodec(20), 'deflate-raw': fakeCodec(60) }
      });
      eq(decision.codecId, C.CODEC_ZSTD, 'the measurement beat the preference');
      return 'order [' + order.join(',') + '] for wasm, and the winner is still measured';
    });

    // --- Against the real platform, and the real artifacts -------------------
    // Everything above runs on fake codecs on purpose, so the arithmetic is
    // testable independently of what this machine has. These three close the
    // loop: they run the codecs this platform actually exposes, on the bytes in
    // this repository, and check the verdicts against what was measured.

    /** node:zlib and node:fs, or null in a browser. Never assumed present. */
    function nodePlatform() {
      if (typeof require !== 'function') return null;
      try {
        var zlib = require('zlib');
        var fs = require('fs');
        var path = require('path');
        return {
          env: {
            zlib: zlib,
            CompressionStream: typeof CompressionStream === 'function' ? CompressionStream : null,
            DecompressionStream: typeof DecompressionStream === 'function' ? DecompressionStream : null
          },
          codecs: {
            brotli: {
              compress: function (bytes) {
                var params = {};
                params[zlib.constants.BROTLI_PARAM_QUALITY] = 6;
                params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = bytes.length;
                return zlib.brotliCompressSync(bytes, { params: params });
              },
              decompress: function (bytes) { return zlib.brotliDecompressSync(bytes); }
            },
            zstd: {
              compress: function (bytes, dictionary) {
                var params = {};
                params[zlib.constants.ZSTD_c_compressionLevel] = 6;
                var o = { params: params };
                if (dictionary) o.dictionary = dictionary;
                return zlib.zstdCompressSync(bytes, o);
              },
              decompress: function (bytes, dictionary) {
                return zlib.zstdDecompressSync(bytes, dictionary ? { dictionary: dictionary } : {});
              }
            },
            'deflate-raw': {
              compress: function (bytes, dictionary) {
                var o = { level: 9 };
                if (dictionary) o.dictionary = dictionary;
                return zlib.deflateRawSync(bytes, o);
              },
              decompress: function (bytes, dictionary) {
                return zlib.inflateRawSync(bytes, dictionary ? { dictionary: dictionary } : {});
              }
            }
          },
          read: function (rel) {
            return new Uint8Array(fs.readFileSync(path.join(__dirname, '..', rel)));
          }
        };
      } catch (e) {
        return null;
      }
    }

    test('compress: the real codecs on the real artifacts reach the measured verdicts', function () {
      var node = nodePlatform();
      if (!node) return 'node:zlib not available here — the platform half is unmeasurable, which is the honest report';

      var rows = [];
      [['artifacts/demo/rvf_wasm_bg.wasm', true], ['artifacts/demo/ruvnet-demo.rvf', true],
        ['standalone.html', true]].forEach(function (spec) {
        var bytes;
        try {
          bytes = node.read(spec[0]);
        } catch (e) {
          return; // absent in this checkout; the report lists what was found
        }
        var decision = C.compressArtifact(bytes, { env: node.env, codecs: node.codecs });
        eq(decision.compress, spec[1], spec[0] + ' should ' + (spec[1] ? '' : 'not ') + 'compress');
        assert(decision.best.envelopeGain >= C.ENVELOPE_GAIN_GATE,
          spec[0] + ' cleared with only ' + decision.best.envelopeGain);
        assert(decision.streamBytes < bytes.length, spec[0] + ' should have shrunk');
        eq(decision.sampled, false, spec[0] + ' is under 8 MB and must be compared whole');
        rows.push(spec[0].split('/').pop() + ' [' + C.classifyArtifact(bytes) + '] ' +
          bytes.length + ' B → ' + decision.streamBytes +
          ' B (' + decision.codecName + ' id ' + decision.codecId + ', dict ' + decision.dictId +
          ', envelope ' + (decision.best.envelopeGain * 100).toFixed(2) + '%, ' +
          decision.best.framesBefore + ' → ' + decision.best.framesAfter + ' frames)');
      });
      assert(rows.length > 0, 'none of the repository’s artifacts was readable');
      return rows.join('; ');
    });

    test('compress: real incompressible bytes are refused, and cost nothing on the wire', function () {
      var node = nodePlatform();
      if (!node) return 'node:zlib not available here — skipped';

      // Already-compressed input: the WASM module put through brotli once, then
      // offered to the decision as an artifact in its own right.
      var wasm;
      try {
        wasm = node.read('artifacts/demo/rvf_wasm_bg.wasm');
      } catch (e) {
        return 'the demo module is absent from this checkout';
      }
      var already = node.codecs.brotli.compress(wasm);
      var decision = C.compressArtifact(already, { env: node.env, codecs: node.codecs });
      eq(decision.compress, false, 'compressing an already-compressed artifact should be refused');
      eq(decision.codecId, C.CODEC_NONE, 'and it goes with codec id 0');
      eq(decision.streamBytes, already.length, 'and the stream is the artifact');
      decision.considered.forEach(function (cell) {
        assert(cell.envelopeGain < C.ENVELOPE_GAIN_GATE,
          cell.codecName + ' should not have cleared the gate on compressed input');
      });
      var best = decision.considered.reduce(function (a, b) {
        return b.envelopeGain > a.envelopeGain ? b : a;
      });
      return already.length + ' B of brotli output: best of ' + decision.considered.length +
        ' codecs was ' + best.codecName + ' at ' + (best.envelopeGain * 100).toFixed(2) +
        '% envelope, all refused';
    });

    test('compress: a wrong dictionary decodes into garbage, and this module refuses before it can', function () {
      var node = nodePlatform();
      if (!node) return 'node:zlib not available here — skipped';
      var rvf;
      try {
        rvf = node.read('artifacts/demo/ruvnet-demo.rvf');
      } catch (e) {
        return 'the demo container is absent from this checkout';
      }

      var right = C.defineDictionary({ id: 1, version: 0, bytes: rvf.subarray(0, 1024), label: 'held-by-both' });
      var wrong = C.defineDictionary({ id: 1, version: 0, bytes: bytesOf(1024, 7), label: 'held-by-one' });
      assert(right.digest !== wrong.digest, 'the two dictionaries must hash differently');

      var stream = node.codecs['deflate-raw'].compress(rvf, right.bytes);
      var correct = node.codecs['deflate-raw'].decompress(stream, right.bytes);
      eq(correct.length, rvf.length, 'the right dictionary reconstructs the right length');

      // THE MEASURED HAZARD. Raw deflate has no checksum, so a wrong dictionary
      // of the right length produces the right number of wrong bytes and raises
      // nothing at all. This is why the check lives here and not in the codec.
      var garbage = null;
      var threw = false;
      try {
        garbage = node.codecs['deflate-raw'].decompress(stream, wrong.bytes);
      } catch (e) {
        threw = true;
      }
      if (!threw) {
        eq(garbage.length, rvf.length, 'the garbage came back at the right length');
        var identical = garbage.length === rvf.length;
        for (var i = 0; identical && i < rvf.length; i++) if (garbage[i] !== rvf[i]) identical = false;
        eq(identical, false, 'and it is not the artifact');
      }

      // And the refusal, which costs one frame rather than the whole transfer.
      throws('dictionary-digest-mismatch', function () {
        C.decoderFor(C.CODEC_DEFLATE_RAW, 1, [wrong], { dictVersion: 0, digest: right.digest });
      }, 'a receiver holding the wrong dictionary');
      return threw
        ? 'this zlib build threw on the wrong dictionary; the digest check refuses it either way'
        : 'inflateRaw returned ' + garbage.length + ' wrong bytes and raised nothing; ' +
          'the digest check refuses before a decoder exists';
    });

    // --- The planner axis ----------------------------------------------------

    test('compress: the codec axis is built like planner’s granularity axis', function () {
      var axis = C.codecAxis({ env: platform() });
      eq(axis[0].codecId, C.CODEC_NONE, 'the no-codec value is always present and always first');
      assert(axis.length >= 4, 'and the available codecs follow: ' + axis.length + ' values');
      var ids = axis.map(function (v) { return v.codecId; });
      eq(ids.indexOf(C.CODEC_CUSTOM), -1, 'an ambiguous id never reaches the axis');
      eq(ids.indexOf(C.CODEC_LZ4), -1, 'nor does one with no implementation');

      var bare = C.codecAxis({ env: {} });
      eq(bare.length, 1, 'a platform with nothing still offers the no-codec strategy');
      eq(bare[0].codecId, C.CODEC_NONE, 'which is a strategy, not a fallback');

      var strict = C.codecAxis({ env: platform(), wireCompatibleOnly: true });
      eq(strict.length, 1, 'and proto2.js as shipped accepts only codec id 0 of these');
      return axis.length + ' axis values, ' + strict.length + ' of them crossable today';
    });

    test('compress: crossing the axis in leaves delta candidates alone', function () {
      var candidates = [
        { id: 'optical/v2/indexed/764/full/complete', label: 'optical v2', granularity: 'full' },
        { id: 'optical/v2/indexed/764/span/complete', label: 'span delta', granularity: 'span' }
      ];
      var axis = C.codecAxis({ env: platform() });
      var expanded = C.expandCandidates(candidates, axis);
      eq(expanded.length, axis.length + 1, 'the full candidate crosses, the delta candidate does not');

      var deltas = expanded.filter(function (c) { return c.granularity === 'span'; });
      eq(deltas.length, 1, 'exactly one span candidate survives');
      eq(deltas[0].codecId, C.CODEC_NONE, 'carrying no codec');

      var ids = {};
      expanded.forEach(function (c) {
        assert(!ids[c.id], 'two expanded candidates share the id ' + c.id);
        ids[c.id] = true;
      });
      return expanded.length + ' candidates, every id distinct';
    });

    test('compress: scoring the no-codec axis value reproduces planner.costTerms exactly', function () {
      var planner = null;
      try {
        planner = typeof require === 'function' ? require('./planner.js') : null;
      } catch (e) {
        planner = null;
      }
      if (!planner) return 'planner.js not loadable here — the rebasing check is skipped, which is the honest report';

      var situation = {
        artifact: { bytes: WASM_BYTES, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0.1, fps: 5, symbolBytes: 792 },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: planner.RADIO_ANY },
        trust: { verified: true }
      };
      var all = planner.candidates(situation);
      var checked = 0;
      all.forEach(function (candidate) {
        if (candidate.granularity !== 'full') return;
        var direct = planner.costTerms(candidate, situation);
        var rebased = C.scoreAxis(planner, candidate, situation, WASM_BYTES);
        ['T', 'E', 'B', 'R', 'J'].forEach(function (key) {
          near(rebased[key], direct[key], 1e-12,
            candidate.id + ' ' + key + ' diverged from planner’s own arithmetic');
        });
        checked++;
      });
      assert(checked > 0, 'no full-granularity candidate was checked');
      return checked + ' candidates, every term identical to planner.costTerms at stream = artifact';
    });

    test('compress: a codec moves J through the same term granularity moves', function () {
      var planner = null;
      try {
        planner = typeof require === 'function' ? require('./planner.js') : null;
      } catch (e) {
        planner = null;
      }
      if (!planner) return 'planner.js not loadable here — skipped';

      var situation = {
        artifact: { bytes: WASM_BYTES, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0, fps: 5, symbolBytes: 792 },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: planner.RADIO_ANY },
        trust: { verified: true }
      };
      var candidate = planner.candidates(situation).filter(function (c) {
        return c.id === 'optical/v2/indexed/512/full/complete';
      })[0];
      assert(candidate, 'expected a v2 indexed whole-artifact candidate');

      var plain = C.scoreAxis(planner, candidate, situation, WASM_BYTES);
      var compressed = C.scoreAxis(planner, candidate, situation, WASM_BROTLI6);

      assert(compressed.J < plain.J, 'compression should lower J: ' + compressed.J + ' vs ' + plain.J);
      assert(compressed.T < plain.T, 'through time');
      assert(compressed.B < plain.B, 'and through bytes');
      eq(compressed.R, plain.R, 'and not through risk — no hazard reads the artifact size');
      assert(compressed.model.dataSymbols < plain.model.dataSymbols,
        'because the stream is shorter, which is exactly how granularity acts');
      eq(compressed.reference.wireBytes, plain.reference.wireBytes,
        'both are divided by ONE reference at the original size');
      return 'J ' + plain.J.toFixed(4) + ' → ' + compressed.J.toFixed(4) + ', symbols ' +
        plain.model.dataSymbols + ' → ' + compressed.model.dataSymbols;
    });

    test('compress: the shared reference is what makes two codecs comparable', function () {
      var planner = null;
      try {
        planner = typeof require === 'function' ? require('./planner.js') : null;
      } catch (e) {
        planner = null;
      }
      if (!planner) return 'planner.js not loadable here — skipped';

      var situation = {
        artifact: { bytes: WASM_BYTES },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0, fps: 5, symbolBytes: 792 },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: planner.RADIO_ANY },
        trust: { verified: true }
      };
      var candidate = planner.candidates(situation).filter(function (c) {
        return c.id === 'optical/v2/indexed/512/full/complete';
      })[0];
      assert(candidate, 'expected a v2 indexed whole-artifact candidate');

      var brotli = C.scoreAxis(planner, candidate, situation, WASM_BROTLI6);
      var zstd = C.scoreAxis(planner, candidate, situation, 17193);
      assert(brotli.J < zstd.J, 'the smaller stream should score better: ' + brotli.J + ' vs ' + zstd.J);
      eq(brotli.reference.seconds, zstd.reference.seconds, 'against the same reference seconds');
      eq(brotli.reference.wireBytes, zstd.reference.wireBytes, 'and the same reference bytes');

      // The failure this rebasing exists to prevent: normalising each codec
      // against a reference evaluated at its own compressed size scores every
      // one of them at B = 1, which orders them all identically.
      var naive = planner.costTerms(candidate, {
        artifact: { bytes: WASM_BROTLI6 },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0, fps: 5, symbolBytes: 792 },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: planner.RADIO_ANY },
        trust: { verified: true }
      });
      assert(naive.B > brotli.B,
        'a per-candidate reference should flatter the compressed candidate: ' +
        naive.B + ' against ' + brotli.B);
      return 'brotli J ' + brotli.J.toFixed(4) + ' < zstd J ' + zstd.J.toFixed(4) +
        '; a per-candidate basis would have scored B = ' + naive.B.toFixed(3);
    });

    test('compress: scoreAxis refuses to score what it was not given a measurement for', function () {
      var planner = null;
      try {
        planner = typeof require === 'function' ? require('./planner.js') : null;
      } catch (e) {
        planner = null;
      }
      if (!planner) return 'planner.js not loadable here — skipped';
      var situation = {
        artifact: { bytes: WASM_BYTES },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0, fps: 5, symbolBytes: 792 },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: planner.RADIO_ANY },
        trust: { verified: true }
      };
      var candidate = planner.candidates(situation)[0];
      throws('bad-stream-size', function () { C.scoreAxis(planner, candidate, situation, 0); },
        'a stream length of zero');
      throws('bad-stream-size', function () { C.scoreAxis(planner, candidate, situation, undefined); },
        'no stream length at all');
      throws('bad-planner', function () { C.scoreAxis({}, candidate, situation, 100); },
        'something that is not a planner');
      return 'an axis value is scored on a measured stream or not at all';
    });

    // --- Rejections ----------------------------------------------------------

    test('compress: a malformed request is refused with a stable reason', function () {
      throws('bad-artifact-size', function () { C.evaluate({ originalBytes: 0, compressedBytes: 0 }); }, 'zero bytes');
      throws('bad-artifact-size', function () { C.evaluate({ compressedBytes: 10 }); }, 'no original at all');
      throws('bad-compressed-size', function () { C.evaluate({ originalBytes: 100 }); }, 'no compressed size');
      throws('bad-artifact-size', function () { C.choose({ candidates: [] }); }, 'choosing for nothing');
      throws('bad-artifact-size', function () { C.compressArtifact(new Uint8Array(0)); }, 'an empty artifact');
      throws('stream-too-large', function () { C.envelopeBytes(1e12); }, 'a stream from a hostile manifest');
      throws('dictionary-too-large', function () {
        C.defineDictionary({ id: 1, version: 0, bytes: { length: 8 * 1024 * 1024 } });
      }, 'a dictionary from a hostile manifest');
      throws('codec-unavailable', function () {
        C.compressWith(bytesOf(64, 1), C.CODEC_ZSTD, {});
      }, 'a codec with nothing behind it');
      return 'every reason is a stable string, matching delta.js, semdelta.js and planner.js';
    });

    test('compress: a CompressError is shaped like the other modules’ errors', function () {
      var caught = throws('bad-artifact-size', function () { C.evaluate({ originalBytes: -1, compressedBytes: 1 }); });
      eq(caught.name, 'CompressError', 'error name');
      assert(caught instanceof Error, 'still an Error');
      assert(caught.message.length > 0, 'and carries a message for humans');
      return 'reason for callers, message for people';
    });

    // --- Honesty -------------------------------------------------------------

    test('compress: the stated limits name every claim this cannot make', function () {
      var limits = C.describeLimits();
      assert(Array.isArray(limits) && limits.length >= 6, 'expected at least six caveats');
      var joined = limits.join(' ').toLowerCase();
      assert(joined.indexOf('not a measurement') >= 0, 'does not admit the envelope is arithmetic');
      assert(joined.indexOf('decode time') >= 0, 'does not disclaim what the gate ignores');
      assert(joined.indexOf('ships no dictionary') >= 0, 'does not say no dictionary exists');
      assert(joined.indexOf('without raising anything') >= 0, 'does not say why fail-closed is here');
      assert(joined.indexOf('gates nothing') >= 0, 'does not disclaim encode cost');
      assert(joined.indexOf('prefix is not a smaller artifact') >= 0, 'does not disclaim the sampled path');
      assert(joined.indexOf('is final for that codec') >= 0,
        'does not admit which direction of the estimate is unrecoverable');
      assert(joined.indexOf('fast level') >= 0, 'does not disclaim the level the estimate ran at');
      assert(joined.indexOf('not a content-type detector') >= 0,
        'does not disclaim the artifact sniff');
      return limits.length + ' caveats';
    });

    test('compress: the changes other modules need are reported, not made', function () {
      var changes = C.describePlannerChanges();
      assert(changes.length >= 4, 'expected at least four');
      var joined = changes.join(' ');
      assert(joined.indexOf('streamBytes()') >= 0, 'the single point a codec acts through');
      assert(joined.indexOf('candidates()') >= 0, 'and the enumeration that has to cross it in');
      assert(joined.indexOf('energyModel()') >= 0, 'and the term that is charged on the wrong quantity');
      assert(joined.indexOf('changes nothing else') >= 0, 'and a statement that none of it was done here');

      var divergence = C.describeWireDivergence();
      assert(divergence.summary.indexOf('Nothing in this module changes proto2.js') >= 0,
        'proto2.js is reported, not edited: ' + divergence.summary);
      return changes.length + ' planner changes and the proto2.js table, all reported';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
