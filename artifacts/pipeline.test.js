/*!
 * rvQR streaming receive pipeline test suite — standalone.
 *
 * Node:    `node artifacts/pipeline.test.js` — one line per test, non-zero exit
 *          on any failure. Two tests weigh retained memory and SKIP without
 *          `--expose-gc`; the summary says so rather than printing a green
 *          total over tests that never ran.
 * Browser: load after core.js, proto2.js and pipeline.js, then call
 *          RVQRPipelineTests.runAll(RVQRPipeline, RVQRCore, RVQRProto2, artifacts).
 *
 * Six groups, one per thing ADR-025 could get wrong here.
 *
 * The DIGEST group is the load-bearing one, because everything else rests on it.
 * pipeline.js contains a second SHA-256 implementation — an incremental one,
 * written because nothing in this codebase offers a synchronous streaming
 * digest and buffering the payload to hash it would have defeated the whole
 * increment. A second implementation of a hash is a second chance to be subtly
 * wrong, so it is checked against core.js's one-shot at every length that
 * exercises a different padding case, at every block boundary, under every
 * split of the input, and over the real demo artifacts.
 *
 * The COPY group is ADR-025 criterion 1 — "copy count is asserted, not
 * inspected... fails the test above 2". It asserts in BOTH directions, which is
 * the part that makes it an instrument rather than a formality: the same ledger
 * is run over the SHIPPED core.js and proto2.js receivers, where it measures
 * 3.00 copies and `assertCopyBudget` throws, and over the streaming receiver,
 * where it measures 1.00 and does not. An instrument that has never failed
 * anything is not evidence.
 *
 * The EXACTNESS group is criterion 5: streaming verification byte-exact against
 * the buffered result, on both demo artifacts, on both protocols, compared as
 * bytes AND as digest.
 *
 * The ARRIVAL group is the regression this rewrite could most easily have been:
 * a streaming receiver that quietly required ordered arrival. Frames are fed
 * reversed, shuffled, doubled, tripled, and shuffled-with-duplicates, and a
 * late manifest is fed twice the way a looping sender would deliver it.
 *
 * The REFUSAL group is what the receiver must not do: hand over an artifact
 * whose digest does not match, keep a complete-but-unverified artifact alive,
 * or accept a transfer shape it cannot actually stream.
 *
 * The HONESTY group asserts what this build is NOT entitled to claim. ADR-025
 * specifies a Rust pipeline with memory mapping, SIMD BLAKE3 and a radio tier;
 * three of its seven criteria cannot be met by a JavaScript static site, and
 * this group asserts they are still DECLARED, with reasons, rather than
 * quietly dropped from the report.
 *
 * Nothing here reads a clock or a network. The shuffles are seeded.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var fs = require('fs');
      var path = require('path');
      var artifacts = [];
      var add = function (label, rel) {
        try {
          artifacts.push({ label: label, bytes: new Uint8Array(fs.readFileSync(rel)) });
        } catch (e) { /* optional */ }
      };
      add('ruvnet-demo.rvf', path.join(__dirname, 'demo', 'ruvnet-demo.rvf'));
      add('rvf_wasm_bg.wasm', path.join(__dirname, 'demo', 'rvf_wasm_bg.wasm'));
      // The artifact bench/suites/memory.mjs reports the over-budget number on.
      // Optional, because it is a build output; when it is present the copy
      // count is asserted on the very bytes the red number came from.
      add('standalone.html', path.join(__dirname, '..', 'standalone.html'));

      var results = api.runAll(
        require('./pipeline.js'),
        require('./core.js'),
        require('./proto2.js'),
        artifacts
      );
      results.forEach(function (r) {
        console.log(
          (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')
        );
      });
      var summary = api.summarize(results);
      console.log(
        '\n' + summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed' +
          (summary.skipped ? ', ' + summary.skipped + ' skipped (run with --expose-gc)' : '')
      );
      if (typeof process !== 'undefined') process.exit(summary.failed ? 1 : 0);
    }
  } else {
    root.RVQRPipelineTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var V1_CHUNK = 512;
  var V2_CHUNK = 665; // the payload that fills a version 19-L symbol

  /** Seeded xorshift32. The shuffles have to be the same every run. */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function shuffled(n, seed) {
    var idx = new Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;
    var rand = rng(seed);
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1));
      var t = idx[j]; idx[j] = idx[k]; idx[k] = t;
    }
    return idx;
  }

  /** A deterministic stand-in when the demo artifacts are not on disk. */
  function syntheticArtifact(n, seed) {
    var out = new Uint8Array(n);
    var rand = rng(seed);
    for (var i = 0; i < n; i++) out[i] = Math.floor(rand() * 256) & 255;
    return out;
  }

  function runAll(P, core, proto2, artifacts) {
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

    function sameBytes(a, b, msg) {
      assert(!!a && !!b, (msg || 'bytes') + ': one side is missing');
      eq(a.length, b.length, (msg || 'bytes') + ': length');
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error((msg || 'bytes') + ': differ at ' + i + ' (' + a[i] + ' vs ' + b[i] + ')');
      }
      return true;
    }

    // The corpus. Falls back to deterministic blobs so the suite is meaningful
    // in a browser tab and on a checkout without the build output, and says
    // which it used in every detail line that depends on it.
    var corpus = (artifacts && artifacts.length ? artifacts.slice() : []).filter(function (a) {
      return a && a.bytes && a.bytes.length > 0;
    });
    var syntheticUsed = false;
    if (corpus.length < 2) {
      syntheticUsed = true;
      corpus = [
        { label: 'synthetic-2304', bytes: syntheticArtifact(2304, 0x5eed) },
        { label: 'synthetic-40989', bytes: syntheticArtifact(40989, 0xbeef) }
      ];
    }
    // The two "demo artifacts" criterion 5 names. Anything else in the corpus
    // (standalone.html) is extra, and the copy group uses all of it.
    var demos = corpus.slice(0, 2);

    // --- protocol harnesses ---------------------------------------------------
    // One shape over both wire formats, so every test below runs twice without
    // being written twice.

    var PROTOCOLS = [
      {
        name: 'v1',
        adapter: P.V1,
        chunk: V1_CHUNK,
        build: function (bytes) {
          var b = core.buildFrames(bytes, { chunk: V1_CHUNK, name: 'artifact.bin', transferId: 'aaaaaaaa' });
          return { frames: b.frames, sha256: b.sha256, total: b.total };
        },
        bufferedRun: function (frames) {
          var st = core.createReceiver();
          for (var i = 0; i < frames.length; i++) core.ingest(st, frames[i]);
          return core.finalize(st);
        }
      },
      {
        name: 'v2',
        adapter: P.V2,
        chunk: V2_CHUNK,
        build: function (bytes) {
          var b = proto2.buildFrames(bytes, { chunk: V2_CHUNK, name: 'artifact.bin', transferId: 0x11223344 });
          return { frames: b.frames, sha256: b.sha256, total: b.total };
        },
        bufferedRun: function (frames) {
          var st = proto2.createReceiver();
          for (var i = 0; i < frames.length; i++) proto2.ingest(st, frames[i]);
          return proto2.finalize(st);
        }
      }
    ];

    /** Feeds an order of frames into a fresh streaming receiver. */
    function stream(proto, frames, order, opts) {
      var st = P.createReceiver(proto.adapter, opts);
      var rejects = 0;
      for (var i = 0; i < order.length; i++) {
        var r = P.ingest(st, frames[order[i]]);
        if (!r.accepted && r.reason !== 'duplicate') rejects++;
      }
      return { state: st, result: P.finalize(st), rejects: rejects };
    }

    function inOrder(n) {
      var o = new Array(n);
      for (var i = 0; i < n; i++) o[i] = i;
      return o;
    }

    // =========================================================================
    // DIGEST — the incremental SHA-256 against core.js's one-shot
    // =========================================================================

    test('digest: incremental SHA-256 matches core.sha256Hex at every padding case', function () {
      // Every length that lands the message on a different side of the two
      // padding branches: the block boundary at 64, the 55/56 boundary where
      // the 9 padding bytes stop fitting, and the second block that forces.
      var lengths = [0, 1, 2, 31, 32, 53, 54, 55, 56, 57, 62, 63, 64, 65, 111,
        112, 118, 119, 120, 121, 127, 128, 129, 191, 192, 255, 256, 512, 665,
        1000, 4096];
      for (var i = 0; i < lengths.length; i++) {
        var n = lengths[i];
        var b = new Uint8Array(n);
        for (var j = 0; j < n; j++) b[j] = (j * 31 + n) & 255;
        eq(P.sha256Hex(b), core.sha256Hex(b), 'digest at ' + n + ' B');
      }
      return lengths.length + ' lengths, 0 B to 4096 B, identical to the one-shot';
    });

    test('digest: the same bytes split any way produce the same digest', function () {
      var n = 5000;
      var b = new Uint8Array(n);
      for (var i = 0; i < n; i++) b[i] = (i * 17 + 5) & 255;
      var want = core.sha256Hex(b);
      // Splits chosen to straddle the block size in every direction, plus a
      // seeded random one, plus one byte at a time.
      var splitSets = [[1], [63], [64], [65], [64, 1], [1, 64], [100, 900, 4000], [4999, 1]];
      for (var s = 0; s < splitSets.length; s++) {
        var h = P.createSha256();
        var off = 0, k = 0;
        while (off < n) {
          var take = Math.min(splitSets[s][k % splitSets[s].length], n - off);
          h.update(b.subarray(off, off + take));
          off += take; k++;
        }
        eq(h.digestHex(), want, 'digest under split set ' + s);
      }
      var rand = rng(0xc0ffee);
      var hr = P.createSha256();
      var o = 0;
      while (o < n) {
        var t = Math.min(1 + Math.floor(rand() * 200), n - o);
        hr.update(b.subarray(o, o + t));
        o += t;
      }
      eq(hr.digestHex(), want, 'digest under a seeded random split');

      var one = P.createSha256();
      for (var q = 0; q < n; q++) one.update(b.subarray(q, q + 1));
      eq(one.digestHex(), want, 'digest one byte at a time');
      return splitSets.length + ' fixed splits, a seeded split, and 5000 single-byte updates';
    });

    test('digest: matches the one-shot on the real artifacts', function () {
      var notes = [];
      for (var i = 0; i < corpus.length; i++) {
        eq(P.sha256Hex(corpus[i].bytes), core.sha256Hex(corpus[i].bytes), corpus[i].label);
        notes.push(corpus[i].label + ' (' + corpus[i].bytes.length + ' B)');
      }
      return notes.join(', ') + (syntheticUsed ? ' — synthetic, the demo files were absent' : '');
    });

    test('digest: it is incremental, not a buffer that hashes at the end', function () {
      // The claim under test is a memory claim, so it is checked as one: the
      // hasher must allocate a fixed 64-byte carry regardless of input size,
      // and must compress blocks as they arrive rather than at digest() time.
      var big = syntheticArtifact(200000, 0x1234);
      var h = P.createSha256();
      h.update(big);
      var beforeDigest = h.stats();
      eq(beforeDigest.blocks, Math.floor(200000 / 64), 'blocks compressed before digest() was called');
      eq(beforeDigest.carryBytes, P.BLOCK_BYTES, 'the carry buffer is one block, whatever the input size');
      h.digestHex();
      var after = h.stats();
      assert(after.blocks - beforeDigest.blocks <= 2, 'digest() finished in at most two padding blocks');
      var threw = false;
      try { h.update(new Uint8Array(1)); } catch (e) { threw = true; }
      assert(threw, 'update after digest was accepted');
      return '200000 B absorbed in ' + beforeDigest.blocks + ' blocks with a ' + P.BLOCK_BYTES + ' B carry';
    });

    test('digest: the frontier absorbs whole blocks, so no payload byte is carried', function () {
      // The frontier deliberately stops on a 64-byte boundary until the final
      // run. That is what keeps the hasher's carry buffer empty, and it is the
      // difference between "the copy is small" and "there is no copy".
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var run = stream(proto, built.frames, inOrder(built.frames.length));
        assert(run.result.ok, proto.name + ': transfer did not verify');
        var st = run.state.hasher.stats();
        assert(st.carriedBytes < P.BLOCK_BYTES,
          proto.name + ': ' + st.carriedBytes + ' B were carried, expected under ' + P.BLOCK_BYTES);
        eq(st.bytes, demos[1].bytes.length, proto.name + ': bytes absorbed');
        notes.push(proto.name + ' carried ' + st.carriedBytes + ' B of ' + st.bytes);
      }
      return notes.join('; ') + ' — the tail of the final run only';
    });

    // =========================================================================
    // COPY — ADR-025 criterion 1, asserted in both directions
    // =========================================================================

    test('copies: the shipped receivers are OVER budget and the instrument throws', function () {
      // The direction that makes this an instrument. If the ledger cannot fail
      // the receiver that bench/suites/memory.mjs independently measures at
      // 2.59x and 2.42x, then it passing the streaming one means nothing.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var measured = P.measureBuffered(proto.adapter, built.frames);
        assert(measured.result.ok, proto.name + ': the shipped receiver did not verify');
        assert(measured.report.copies >= 2,
          proto.name + ': expected the shipped receiver at or above 2 copies, got ' + measured.report.copies);
        eq(measured.report.withinBudget, false, proto.name + ': the shipped receiver was reported within budget');
        var threw = false;
        try { P.assertCopyBudget(measured.report); } catch (e) { threw = true; }
        assert(threw, proto.name + ': assertCopyBudget did not throw above the budget');
        notes.push(proto.name + ' ' + measured.report.copies.toFixed(2) + 'x');
      }
      return notes.join(', ') + ' — chunk list, assembled output and the hash\'s padded copy, all live at once';
    });

    test('copies: the streaming receiver is UNDER budget on every artifact', function () {
      var notes = [];
      for (var c = 0; c < corpus.length; c++) {
        for (var p = 0; p < PROTOCOLS.length; p++) {
          var proto = PROTOCOLS[p];
          var built = proto.build(corpus[c].bytes);
          var run = stream(proto, built.frames, inOrder(built.frames.length));
          assert(run.result.ok, proto.name + '/' + corpus[c].label + ': did not verify');
          // The assertion criterion 1 asks for: it throws above 2.
          P.assertCopyBudget(run.result.copies);
          notes.push(proto.name + '/' + corpus[c].label + ' ' + run.result.copies.copies.toFixed(4) + 'x');
        }
      }
      return notes.join(', ');
    });

    test('copies: exactly one write pass and one read pass over the payload', function () {
      // ADR-025 section 2.2 in full: "one unavoidable read, one unavoidable
      // write; anything else is a defect". Both are counted, not argued.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var run = stream(proto, built.frames, inOrder(built.frames.length));
        var rep = run.result.copies;
        eq(rep.writePasses, 1, proto.name + ': write passes over the payload');
        eq(rep.hashPasses, 1, proto.name + ': read passes over the payload');
        eq(rep.writeBytes, demos[1].bytes.length, proto.name + ': bytes written');
        eq(rep.hashBytes, demos[1].bytes.length, proto.name + ': bytes hashed');
        notes.push(proto.name + ' 1 write + 1 read over ' + rep.writeBytes + ' B');
      }
      return notes.join(', ');
    });

    test('copies: what is still held at handover is the artifact and nothing else', function () {
      var proto = PROTOCOLS[0];
      var built = proto.build(demos[1].bytes);
      var run = stream(proto, built.frames, inOrder(built.frames.length));
      var kinds = run.result.copies.byKind;
      // Every frame payload that ever passed through was released; what remains
      // is the output, the index bitmap and the hasher's carry.
      eq(run.result.copies.openHandles, 3, 'buffers still live at handover');
      var overhead = run.state.total + P.BLOCK_BYTES;
      eq(run.state.ledger.live, demos[1].bytes.length + overhead, 'live bytes at handover');
      assert(kinds['frame-payload'] === demos[1].bytes.length,
        'the frame payloads that passed through totalled the artifact exactly');
      assert(kinds.output === demos[1].bytes.length, 'the output buffer is the artifact size');
      return 'artifact + ' + overhead + ' B of index and carry, ' +
        (run.state.ledger.live / demos[1].bytes.length).toFixed(4) + 'x';
    });

    test('copies: a manifest-last transfer stays inside budget at every artifact size', function () {
      // The one place a streaming receiver can reintroduce the defect at the
      // front: data arriving before the manifest has nowhere to go, so it gets
      // queued, and every queued byte will also exist in the output.
      //
      // This is checked at EVERY size in the corpus, on both protocols, because
      // the failure this caught was size-dependent: a flat 256 KiB queue bound
      // measured 2.0036 copies on the 40 KB artifact — under the bound and over
      // the budget, because for a small enough artifact any absolute bound is a
      // second full copy. The bound is a fraction of the transfer for that
      // reason, and the assertion below is what keeps it one.
      var notes = [];
      for (var c = 0; c < corpus.length; c++) {
        for (var p = 0; p < PROTOCOLS.length; p++) {
          var proto = PROTOCOLS[p];
          var built = proto.build(corpus[c].bytes);
          var order = [];
          for (var i = 1; i < built.frames.length; i++) order.push(i);
          order.push(0); // the manifest last, the worst case for the queue
          var st = P.createReceiver(proto.adapter);
          var overflowed = 0;
          for (var k = 0; k < order.length; k++) {
            var r = P.ingest(st, built.frames[order[k]]);
            if (r.reason === 'manifest-pending-overflow') overflowed++;
          }
          var rep = P.copyReport(st.ledger, corpus[c].label + '/' + proto.name + ' manifest last');
          P.assertCopyBudget(rep);
          assert(rep.copies < 1 + P.DEFAULT_PENDING_FRACTION + 0.3,
            proto.name + '/' + corpus[c].label + ': ' + rep.copies.toFixed(4) +
              'x exceeds one artifact plus the queue fraction');
          if (c === corpus.length - 1) {
            notes.push(proto.name + ' ' + rep.copies.toFixed(4) + 'x, ' + overflowed + ' refused');
          }
        }
      }
      return 'all ' + corpus.length + ' artifacts x2 protocols; on ' +
        corpus[corpus.length - 1].label + ': ' + notes.join(', ');
    });

    test('copies: retained memory agrees with the ledger', function () {
      // Corroboration, because the ledger is arithmetic and arithmetic can be
      // wrong about the world. Same method bench/lib/memprobe.mjs uses:
      // heapUsed + external after a forced collection, because a typed array's
      // bytes live outside the JS heap and heapUsed alone would miss them.
      var g = typeof globalThis !== 'undefined' ? globalThis : null;
      var canWeigh = !!(g && typeof g.gc === 'function' && g.process &&
        typeof g.process.memoryUsage === 'function');
      if (!canWeigh) return 'skipped — needs node --expose-gc';

      function live() {
        var m = g.process.memoryUsage();
        return m.heapUsed + m.external;
      }
      function settle() { g.gc(); g.gc(); g.gc(); }

      var art = corpus[corpus.length - 1].bytes;
      var proto = PROTOCOLS[0];

      // The origin is taken BEFORE the frames are built, the way
      // bench/lib/memprobe.mjs takes it: the frame list is a harness artefact
      // that a real receiver never holds, so it is built after the origin and
      // drained as it is consumed. Measuring from after the build instead
      // charges the receiver a negative for releasing someone else's memory,
      // which is how this test first reported -0.465x.
      settle();
      var origin = live();
      var built = proto.build(art);
      var frames = built.frames;
      var st = P.createReceiver(proto.adapter);
      for (var i = 0; i < frames.length; i++) {
        P.ingest(st, frames[i]);
        frames[i] = null; // a receiver holds one frame at a time, never the list
      }
      var res = P.finalize(st);
      settle();
      var retained = live() - origin;
      assert(res.ok, 'the transfer did not verify');
      var measured = retained / art.length;
      assert(measured < P.COPY_BUDGET,
        'retained ' + measured.toFixed(3) + 'x, budget is under ' + P.COPY_BUDGET);
      // The ledger claimed roughly one artifact; the scale has to agree.
      assert(Math.abs(measured - res.copies.copies) < 0.35,
        'the ledger said ' + res.copies.copies.toFixed(3) + 'x and the heap said ' + measured.toFixed(3) + 'x');
      return corpus[corpus.length - 1].label + ': ' + measured.toFixed(3) +
        'x retained against a ledger claim of ' + res.copies.copies.toFixed(3) + 'x';
    });

    test('copies: retained memory shows the shipped receiver over budget', function () {
      // The other half of the corroboration. bench/suites/memory.mjs reports
      // 2.59x for v1 and 2.42x for v2 on standalone.html; this asserts the
      // direction here, on whatever the largest artifact available is, so the
      // red number is reproduced by the suite rather than only cited by it.
      var g = typeof globalThis !== 'undefined' ? globalThis : null;
      var canWeigh = !!(g && typeof g.gc === 'function' && g.process &&
        typeof g.process.memoryUsage === 'function');
      if (!canWeigh) return 'skipped — needs node --expose-gc';

      function live() {
        var m = g.process.memoryUsage();
        return m.heapUsed + m.external;
      }
      function settle() { g.gc(); g.gc(); g.gc(); }

      var art = corpus[corpus.length - 1].bytes;
      var proto = PROTOCOLS[0];

      settle();
      var origin = live();
      var frames = proto.build(art).frames;
      var st = core.createReceiver();
      for (var i = 0; i < frames.length; i++) {
        core.ingest(st, frames[i]);
        frames[i] = null;
      }
      var res = core.finalize(st);
      settle();
      var retained = live() - origin;
      assert(res.ok, 'the shipped receiver did not verify');
      var measured = retained / art.length;
      assert(measured >= P.COPY_BUDGET,
        'expected the shipped receiver at or above ' + P.COPY_BUDGET + 'x, measured ' + measured.toFixed(3) + 'x');
      return corpus[corpus.length - 1].label + ': ' + measured.toFixed(3) +
        'x retained by the chunk list and the assembled output together';
    });

    // =========================================================================
    // EXACTNESS — ADR-025 criterion 5
    // =========================================================================

    test('exactness: streaming verification is byte-exact against the buffered result', function () {
      var notes = [];
      for (var c = 0; c < demos.length; c++) {
        for (var p = 0; p < PROTOCOLS.length; p++) {
          var proto = PROTOCOLS[p];
          var built = proto.build(demos[c].bytes);
          var buffered = proto.bufferedRun(built.frames);
          var streamed = stream(proto, built.frames, inOrder(built.frames.length)).result;
          assert(buffered.ok, proto.name + '/' + demos[c].label + ': buffered did not verify');
          assert(streamed.ok, proto.name + '/' + demos[c].label + ': streaming did not verify');
          sameBytes(streamed.bytes, buffered.bytes, proto.name + '/' + demos[c].label + ': bytes');
          sameBytes(streamed.bytes, demos[c].bytes, proto.name + '/' + demos[c].label + ': against the source');
          eq(streamed.sha256, buffered.sha256, proto.name + '/' + demos[c].label + ': digest');
          eq(streamed.sha256, built.sha256, proto.name + '/' + demos[c].label + ': against the sender');
          eq(streamed.name, buffered.name, proto.name + '/' + demos[c].label + ': name');
          notes.push(proto.name + '/' + demos[c].label);
        }
      }
      return notes.join(', ') + ' — bytes and digest identical' +
        (syntheticUsed ? ' (synthetic corpus, the demo files were absent)' : '');
    });

    test('exactness: the same holds on the largest artifact available', function () {
      var art = corpus[corpus.length - 1];
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(art.bytes);
        var buffered = proto.bufferedRun(built.frames);
        var streamed = stream(proto, built.frames, inOrder(built.frames.length)).result;
        sameBytes(streamed.bytes, buffered.bytes, proto.name + ': bytes');
        eq(streamed.sha256, buffered.sha256, proto.name + ': digest');
        notes.push(proto.name + ' ' + built.total + ' frames');
      }
      return art.label + ' (' + art.bytes.length + ' B): ' + notes.join(', ');
    });

    test('exactness: the digest is decided before finalize is called', function () {
      // Not a performance nicety. ADR-025 section 2.3 says the artifact is
      // never simultaneously complete and unverified in memory; that is only
      // true if the frontier reaches the end INSIDE the ingest that delivers
      // the last byte, which is what this asserts.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[0].bytes);
        var st = P.createReceiver(proto.adapter);
        for (var i = 0; i < built.frames.length; i++) {
          eq(st.digestHex, null, proto.name + ': the digest settled early, at frame ' + i);
          P.ingest(st, built.frames[i]);
        }
        eq(st.digestHex, built.sha256, proto.name + ': the digest at completion');
        eq(st.digestMatches, true, proto.name + ': it matched the manifest at completion');
        var blocksBefore = st.hasher.stats().blocks;
        var res = P.finalize(st);
        assert(res.ok, proto.name + ': finalize refused a verified transfer');
        eq(st.hasher.stats().blocks, blocksBefore, proto.name + ': finalize compressed further blocks');
        notes.push(proto.name);
      }
      return notes.join(', ') + ': the digest lands with the last byte; finalize is a handover';
    });

    // =========================================================================
    // ARRIVAL — out of order, duplicated, and both at once
    // =========================================================================

    test('arrival: fully reversed data reassembles byte-exactly in one hash burst', function () {
      // The frontier's worst case: frame 1 arrives last, so nothing can be
      // hashed until the final arrival and the whole artifact is absorbed in
      // one run. A receiver that quietly required ordered arrival would fail
      // here, and one that hashed eagerly would produce the wrong digest.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var order = [0];
        for (var i = built.frames.length - 1; i >= 1; i--) order.push(i);
        var run = stream(proto, built.frames, order);
        assert(run.result.ok, proto.name + ': reversed arrival did not verify: ' + run.result.reason);
        sameBytes(run.result.bytes, demos[1].bytes, proto.name + ': reversed bytes');
        eq(run.result.sha256, built.sha256, proto.name + ': digest');
        eq(run.rejects, 0, proto.name + ': frames were refused');
        var stats = run.state.hasher.stats();
        eq(stats.updates, 1, proto.name + ': the frontier advanced more than once');
        eq(stats.bytes, demos[1].bytes.length, proto.name + ': bytes absorbed');
        P.assertCopyBudget(run.result.copies);
        notes.push(proto.name + ' ' + run.result.copies.copies.toFixed(4) + 'x in 1 update');
      }
      return 'manifest first, data descending: ' + notes.join(', ');
    });

    test('arrival: shuffled order reassembles byte-exactly, under four seeds', function () {
      var seeds = [1, 0x9e3779b9, 0x5bf03635, 0xdeadbeef];
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        for (var s = 0; s < seeds.length; s++) {
          // The manifest first, then the data shuffled — a sender emits the
          // manifest first and cycles the data, and a camera catches the data
          // in whatever order it happens to see it.
          var data = shuffled(built.frames.length - 1, seeds[s]).map(function (i) { return i + 1; });
          var run = stream(proto, built.frames, [0].concat(data));
          assert(run.result.ok, proto.name + ' seed ' + s + ': did not verify: ' + run.result.reason);
          sameBytes(run.result.bytes, demos[1].bytes, proto.name + ' seed ' + s + ': bytes');
          eq(run.result.sha256, built.sha256, proto.name + ' seed ' + s + ': digest');
          eq(run.rejects, 0, proto.name + ' seed ' + s + ': frames were refused');
          P.assertCopyBudget(run.result.copies);
        }
        notes.push(proto.name + ' x' + seeds.length);
      }
      return notes.join(', ') + ' shuffles, all byte-exact and all inside the copy budget';
    });

    test('arrival: duplicates are counted and discarded, not rewritten or rehashed', function () {
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[0].bytes);
        var n = built.frames.length;
        // Every frame three times, in order.
        var order = [];
        for (var i = 0; i < n; i++) { order.push(i); order.push(i); order.push(i); }
        var run = stream(proto, built.frames, order);
        assert(run.result.ok, proto.name + ': did not verify under triplication');
        sameBytes(run.result.bytes, demos[0].bytes, proto.name + ': bytes');
        eq(run.state.received, n - 1, proto.name + ': accepted data frames');
        eq(run.state.duplicates, 2 * n, proto.name + ': duplicates counted');
        // The proof it did not rehash: exactly one read pass over the payload.
        eq(run.result.copies.hashPasses, 1, proto.name + ': read passes');
        eq(run.result.copies.writePasses, 1, proto.name + ': write passes');
        notes.push(proto.name + ' ' + run.state.duplicates + ' duplicates over ' + n + ' frames');
      }
      return notes.join(', ') + ' — still one write and one read over the payload';
    });

    test('arrival: shuffled AND duplicated together', function () {
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var n = built.frames.length;
        // Every data frame twice, shuffled, behind the manifest — a sender
        // emitting the manifest first and a camera catching the rest of the
        // cycle in whatever order and however many times it happens to see it.
        var doubled = [];
        for (var i = 1; i < n; i++) { doubled.push(i); doubled.push(i); }
        var order = [0].concat(
          shuffled(doubled.length, 0x13572468).map(function (k) { return doubled[k]; })
        );
        var run = stream(proto, built.frames, order);
        assert(run.result.ok, proto.name + ': did not verify: ' + run.result.reason);
        sameBytes(run.result.bytes, demos[1].bytes, proto.name + ': bytes');
        eq(run.result.sha256, built.sha256, proto.name + ': digest');
        eq(run.state.duplicates, n - 1, proto.name + ': duplicates counted');
        eq(run.result.copies.writePasses, 1, proto.name + ': write passes');
        eq(run.result.copies.hashPasses, 1, proto.name + ': read passes');
        P.assertCopyBudget(run.result.copies);
        notes.push(proto.name + ' ' + order.length + ' arrivals for ' + n + ' frames');
      }
      return notes.join(', ') + ' — still one write and one read over the payload';
    });

    test('arrival: a wholly shuffled cycle, manifest included, completes on the second pass', function () {
      // The combined worst case, and the honest consequence of the bounded
      // pre-manifest queue: shuffle everything including the manifest and some
      // data lands before the receiver knows where to put it. It is refused by
      // name, the sender's next cycle delivers it, and the artifact is exact.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var n = built.frames.length;
        var order = shuffled(n, 0x2468ace0);
        var st = P.createReceiver(proto.adapter);
        var refused = 0;
        for (var pass = 0; pass < 2; pass++) {
          for (var k = 0; k < order.length; k++) {
            var r = P.ingest(st, built.frames[order[k]]);
            if (r.reason === 'manifest-pending-overflow') refused++;
          }
        }
        var res = P.finalize(st);
        assert(res.ok, proto.name + ': two shuffled cycles did not complete it: ' + res.reason);
        sameBytes(res.bytes, demos[1].bytes, proto.name + ': bytes');
        P.assertCopyBudget(res.copies);
        notes.push(proto.name + ' ' + refused + ' refused pre-manifest, ' + res.copies.copies.toFixed(4) + 'x');
      }
      return notes.join(', ');
    });

    test('arrival: a late manifest completes on the sender\'s second cycle', function () {
      // The bounded pre-manifest queue has a consequence and it is stated as a
      // behaviour rather than hidden: data arriving before the manifest past
      // the bound is refused by name, and the looping sender delivers it again.
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[1].bytes);
        var n = built.frames.length;
        var cycle = [];
        for (var i = 1; i < n; i++) cycle.push(i);
        cycle.push(0);
        var st = P.createReceiver(proto.adapter);
        var overflowed = 0;
        for (var k = 0; k < cycle.length; k++) {
          var r = P.ingest(st, built.frames[cycle[k]]);
          if (r.reason === 'manifest-pending-overflow') overflowed++;
        }
        assert(overflowed > 0, proto.name + ': the queue bound was never reached, the test proves nothing');
        assert(!P.isComplete(st), proto.name + ': completed on the first cycle');
        eq(P.finalize(st).reason, 'incomplete', proto.name + ': finalize claimed something before completion');
        for (var m = 0; m < cycle.length; m++) P.ingest(st, built.frames[cycle[m]]);
        var res = P.finalize(st);
        assert(res.ok, proto.name + ': the second cycle did not complete it: ' + res.reason);
        sameBytes(res.bytes, demos[1].bytes, proto.name + ': bytes after two cycles');
        P.assertCopyBudget(res.copies);
        notes.push(proto.name + ' ' + overflowed + ' refused then recovered at ' + res.copies.copies.toFixed(4) + 'x');
      }
      return notes.join(', ');
    });

    test('arrival: an incomplete transfer hands over nothing and names what is missing', function () {
      var proto = PROTOCOLS[0];
      var built = proto.build(demos[1].bytes);
      var order = inOrder(built.frames.length).filter(function (i) { return i !== 3 && i !== 17; });
      var run = stream(proto, built.frames, order);
      eq(run.result.ok, false, 'an incomplete transfer reported ok');
      eq(run.result.reason, 'incomplete', 'reason');
      eq(run.result.bytes, undefined, 'bytes were handed over');
      var missing = P.missingSequences(run.state);
      eq(missing.length, 2, 'missing count');
      eq(missing[0], 3, 'first missing');
      eq(missing[1], 17, 'second missing');
      eq(run.state.digestHex, null, 'a digest was produced for an incomplete artifact');
      return 'two frames withheld, both named, no bytes and no digest';
    });

    // =========================================================================
    // REFUSAL — what the receiver must not do
    // =========================================================================

    test('refusal: a corrupted payload is refused and the output is released at once', function () {
      var notes = [];
      for (var p = 0; p < PROTOCOLS.length; p++) {
        var proto = PROTOCOLS[p];
        var built = proto.build(demos[0].bytes);
        var st = P.createReceiver(proto.adapter);
        for (var i = 0; i < built.frames.length; i++) {
          var parsed = proto.adapter.parse(built.frames[i]);
          assert(parsed.ok, proto.name + ': frame ' + i + ' did not parse');
          // Corrupt after parsing, so the frame's own transport hash — which v2
          // carries and v1 does not — cannot mask the artifact-level failure
          // this test is about.
          if (i === 2) parsed.frame.payload[0] ^= 0xff;
          P.ingest(st, parsed.frame);
        }
        eq(st.status, 'REJECTED', proto.name + ': status after a bad digest');
        eq(st.out, null, proto.name + ': the artifact was still held after the digest failed');
        eq(st.ledger.live, st.total + P.BLOCK_BYTES, proto.name + ': the output buffer was not released');
        var res = P.finalize(st);
        eq(res.ok, false, proto.name + ': a corrupted artifact was accepted');
        eq(res.reason, 'hash-mismatch', proto.name + ': reason');
        eq(res.expected, built.sha256, proto.name + ': expected digest reported');
        assert(res.actual !== built.sha256, proto.name + ': the actual digest was not reported');
        eq(res.bytes, undefined, proto.name + ': bytes were handed over anyway');
        notes.push(proto.name);
      }
      return notes.join(', ') + ': released at completion, not at finalize — the window is zero';
    });

    test('refusal: a fountain transfer is refused by name, not mis-streamed', function () {
      // A symbol has no fixed offset, so there is nothing to stream it into.
      // Refusing by name is the difference between a limit and a bug.
      var manifest = JSON.stringify({
        v: 1, t: 'aaaaaaaa', h: 'deadbeef', i: 0, n: 4,
        m: {
          name: 'a.bin', size: 2048, sha256: 'deadbeef' + new Array(57).join('0') + '0',
          chunk: 512, mode: 'fountain', k: 4, symbolSize: 512
        }
      });
      var st = P.createReceiver(P.V1);
      var r = P.ingest(st, manifest);
      eq(r.accepted, false, 'a fountain manifest was accepted');
      assert(r.reason === 'fountain-unsupported' || r.reason === 'bad-sha256',
        'unexpected reason: ' + r.reason);
      // And the same through the parser, with a well-formed digest.
      var art = demos[0].bytes;
      var hex = core.sha256Hex(art);
      var good = JSON.stringify({
        v: 1, t: 'aaaaaaaa', h: hex.slice(0, 8), i: 0, n: Math.ceil(art.length / 512),
        m: {
          name: 'a.bin', size: art.length, sha256: hex, chunk: 512,
          mode: 'fountain', k: Math.ceil(art.length / 512), symbolSize: 512
        }
      });
      var st2 = P.createReceiver(P.V1);
      var r2 = P.ingest(st2, good);
      eq(r2.accepted, false, 'a well-formed fountain manifest was accepted');
      eq(r2.reason, 'fountain-unsupported', 'reason');
      eq(st2.out, null, 'a buffer was allocated for a transfer that cannot be streamed');
      return 'refused as fountain-unsupported, no buffer allocated';
    });

    test('refusal: a compressed v2 transfer is refused by name', function () {
      // The manifest digest covers the DECODED artifact, so streaming the
      // digest would mean streaming the decompressor. ADR-025 section 2.3's
      // bounded decompression is what that needs, and it is not built here.
      var art = demos[0].bytes;
      // A stand-in "compressed" stream: the codec is declared, the receiver
      // must refuse before it can matter what the bytes are.
      var stream2 = art.subarray(0, art.length - 16);
      var built = proto2.buildFrames(art, {
        chunk: V2_CHUNK, name: 'a.bin', transferId: 7,
        codecId: proto2.CODEC_SCF1, stream: stream2
      });
      var st = P.createReceiver(P.V2);
      var r = P.ingest(st, built.frames[0]);
      eq(r.accepted, false, 'a compressed manifest was accepted');
      eq(r.reason, 'codec-unsupported', 'reason');
      eq(st.out, null, 'a buffer was allocated for a transfer that cannot be streamed');
      return 'codec ' + proto2.CODEC_NAMES[proto2.CODEC_SCF1] + ' refused as codec-unsupported';
    });

    test('refusal: a frame that disagrees with the manifest is refused, not padded', function () {
      var proto = PROTOCOLS[0];
      var built = proto.build(demos[0].bytes);
      var st = P.createReceiver(proto.adapter);
      P.ingest(st, built.frames[0]);
      var parsed = proto.adapter.parse(built.frames[1]);
      // Short by one byte. A truncated frame and a mis-stated length are the
      // same event from here and neither is repairable.
      parsed.frame.payload = parsed.frame.payload.subarray(0, parsed.frame.payload.length - 1);
      var r = P.ingest(st, parsed.frame);
      eq(r.accepted, false, 'a short payload was written');
      eq(r.reason, 'payload-length-mismatch', 'reason');
      eq(st.received, 0, 'a refused frame was counted as received');
      eq(st.rejected, 1, 'a refused frame was not counted as rejected');
      // And an index outside the transfer.
      var far = proto.adapter.parse(built.frames[1]);
      far.frame.i = built.frames.length + 5;
      var r2 = P.ingest(st, far.frame);
      eq(r2.accepted, false, 'an out-of-range index was written');
      return 'short payload and out-of-range index both refused, nothing written';
    });

    test('refusal: frames from another transfer are refused', function () {
      var proto = PROTOCOLS[0];
      var a = core.buildFrames(demos[0].bytes, { chunk: V1_CHUNK, name: 'a.bin', transferId: 'aaaaaaaa' });
      var b = core.buildFrames(demos[1].bytes, { chunk: V1_CHUNK, name: 'b.bin', transferId: 'bbbbbbbb' });
      var st = P.createReceiver(proto.adapter);
      P.ingest(st, a.frames[0]);
      var r = P.ingest(st, b.frames[1]);
      eq(r.accepted, false, 'a frame from another transfer was accepted');
      eq(r.reason, 'other-transfer', 'reason');
      for (var i = 1; i < a.frames.length; i++) P.ingest(st, a.frames[i]);
      var res = P.finalize(st);
      assert(res.ok, 'the original transfer did not survive the interloper');
      sameBytes(res.bytes, demos[0].bytes, 'bytes');
      return 'the interloper is refused and the transfer in progress is unharmed';
    });

    // =========================================================================
    // HONESTY — what this build is not entitled to claim
    // =========================================================================

    test('honesty: criteria 2, 3 and 6 are declared not applicable, with reasons', function () {
      // A criterion that quietly disappears from a report reads exactly like a
      // criterion that was met. These three cannot be met by a JavaScript
      // static site, so the code carries the reason and this asserts it is
      // still there.
      var byId = {};
      P.ADR025_CRITERIA.forEach(function (c) { byId[c.id] = c; });
      eq(P.ADR025_CRITERIA.length, 7, 'ADR-025 has seven acceptance criteria');
      [2, 3, 6].forEach(function (id) {
        assert(byId[id], 'criterion ' + id + ' is missing entirely');
        eq(byId[id].status, 'not-applicable', 'criterion ' + id + ' status');
        assert(typeof byId[id].reason === 'string' && byId[id].reason.length > 40,
          'criterion ' + id + ' has no stated reason');
      });
      assert(/1 GB|4\.7 days|2\.44/.test(byId[2].reason), 'criterion 2 does not say why 1 GB is unmeasurable here');
      assert(/radio/.test(byId[3].reason), 'criterion 3 does not name the missing radio tier');
      assert(/SIMD|intrinsic/i.test(byId[6].reason), 'criterion 6 does not say there are no SIMD paths');
      eq(byId[1].status, 'met', 'criterion 1');
      eq(byId[5].status, 'met', 'criterion 5');
      return 'criteria 2, 3 and 6 not applicable — no 1 GB run, no radio tier, no SIMD path';
    });

    test('honesty: this module IS wired into the app, and stays wired', function () {
      // This guard was written asserting the OPPOSITE — that the module was not
      // yet reachable from the page — so that it would fail the moment wiring
      // landed and force its own claim to be corrected. It did exactly that.
      //
      // Inverted rather than deleted, because the property worth guarding did
      // not disappear when it flipped: a module the app cannot reach is not
      // shipped, and a receiver that silently stops being used would otherwise
      // leave every copy-count figure in this file describing code no user
      // runs. A claim with an expiry date beats a comment that quietly rots.
      var wired = false;
      if (typeof require === 'function' && typeof __dirname === 'string') {
        try {
          var fs = require('fs');
          var pathmod = require('path');
          var page = fs.readFileSync(pathmod.join(__dirname, 'index.html'), 'utf8');
          wired = page.indexOf('pipeline.js') >= 0;
        } catch (e) {
          return 'skipped — index.html was not readable';
        }
      } else {
        return 'skipped — needs a filesystem';
      }
      eq(wired, true, 'index.html no longer loads pipeline.js — the streaming receiver has been unwired, and every copy figure in this file now describes code the app does not run');
      return 'index.html loads pipeline.js; the receiver measured here is the one that ships';
    });

    test('honesty: the peak-RSS budget is not what this increment moved', function () {
      // bench/suites/memory.mjs reports 75.2 MiB of 128 MiB, and it was green
      // before this file existed. The copy count was the red number, and it is
      // the only one this file is entitled to claim.
      var proto = PROTOCOLS[0];
      var built = proto.build(demos[1].bytes);
      var streamed = stream(proto, built.frames, inOrder(built.frames.length));
      var buffered = P.measureBuffered(proto.adapter, built.frames);
      assert(streamed.result.copies.copies < buffered.report.copies,
        'the streaming receiver did not improve on the buffered one');
      var factor = buffered.report.copies / streamed.result.copies.copies;
      assert(factor > 2, 'expected a factor above 2, got ' + factor.toFixed(2));
      return 'copies ' + buffered.report.copies.toFixed(2) + 'x to ' +
        streamed.result.copies.copies.toFixed(2) + 'x, a factor of ' + factor.toFixed(2) +
        ' — the 128 MiB peak-RSS budget was already green and is untouched';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    // Skips are counted explicitly. A suite reporting "n/n passed" while a test
    // quietly did nothing is a false green.
    var skipped = results.filter(function (r) {
      return typeof r.detail === 'string' && r.detail.indexOf('skipped') === 0;
    }).length;
    return { total: results.length, passed: passed, failed: results.length - passed, skipped: skipped };
  }

  return { runAll: runAll, summarize: summarize };
});
