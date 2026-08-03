/*!
 * rvQR fountain test suite — standalone.
 *
 * Node:    `node artifacts/fountain.test.js` — one line per test, non-zero
 *          exit on any failure.
 * Browser: load after fountain.js and call RVQRFountainTests.runAll(fountain).
 *          Cases needing node:crypto or the demo files are skipped there.
 *
 * Byte-exactness is checked with SHA-256 over the whole reconstruction, not
 * with a length or a prefix — a fountain code that returns the right number of
 * wrong bytes is the failure mode worth catching.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var fountain = require('./fountain.js');
      var results = api.runAll(fountain, {
        sha256: function (bytes) {
          return require('crypto').createHash('sha256')
            .update(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length))
            .digest('hex');
        },
        readFile: function (rel) {
          var path = require('path');
          return new Uint8Array(require('fs').readFileSync(path.join(__dirname, rel)));
        }
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
    root.RVQRFountainTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object} fountain the fountain module under test
   * @param {{sha256?:function, readFile?:function}} env host services; without
   *   sha256 the byte-exactness cases fall back to a full element compare,
   *   without readFile the demo-artifact cases are skipped
   * @returns {Array<{name:string, ok:boolean, detail:string}>}
   */
  function runAll(fountain, env) {
    env = env || {};
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
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    // Identity check for reconstructions: SHA-256 when the host offers it, so
    // a failure names two digests rather than "arrays differ".
    function digest(bytes) {
      if (env.sha256) return env.sha256(bytes);
      var h = 0;
      for (var i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + bytes[i]) | 0;
      return 'len' + bytes.length + ':' + (h >>> 0).toString(16);
    }
    function assertSameBytes(got, want, msg) {
      assert(got !== null && got !== undefined, (msg || 'decode') + ': got null');
      var dg = digest(got), dw = digest(want);
      if (dg !== dw || !bytesEqual(got, want)) {
        throw new Error((msg || 'bytes') + ': sha ' + dg.slice(0, 16) + ' != ' + dw.slice(0, 16) +
          ' (len ' + got.length + ' vs ' + want.length + ')');
      }
    }

    // Deterministic pseudo-random source so any failure is reproducible.
    var seed = 0x5eed1e;
    function rnd() {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed >>> 8;
    }
    function rndBytes(n) {
      var out = new Uint8Array(n);
      for (var i = 0; i < n; i++) out[i] = rnd() & 255;
      return out;
    }
    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = rnd() % (i + 1);
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    // Feeds symbols starting at `firstEsi` until the decoder reports ready,
    // dropping each with probability lossPct. Returns the reconstruction and
    // the reception overhead (symbols accepted beyond K).
    function driveToDecode(enc, T, totalBytes, opts) {
      opts = opts || {};
      var lossPct = opts.lossPct || 0;
      var esi = opts.firstEsi || 0;
      var limit = enc.K + (opts.slack || 200);
      var dec = fountain.decoder(enc.K, T, totalBytes);
      var offered = 0;
      while (offered < limit * 4) {
        offered++;
        var thisEsi = esi++;
        if (lossPct && (rnd() % 100) < lossPct) continue;
        if (dec.add(enc.symbol(thisEsi))) {
          return { bytes: dec.decode(), overhead: dec.received - enc.K, decoder: dec };
        }
        if (dec.received > limit) break;
      }
      throw new Error('never became decodable (K=' + enc.K + ', accepted ' + dec.received + ')');
    }

    // --- round trip, no loss -------------------------------------------------

    var T = 256;
    var sizes = [0, 1, T - 1, T, T + 1, 2 * T, 1000, 4096, 20000];
    sizes.forEach(function (n) {
      test('roundtrip, no loss, ' + n + ' bytes', function () {
        var src = rndBytes(n);
        var enc = fountain.encoder(src, T);
        assertEqual(enc.K, Math.max(1, Math.ceil(n / T)), 'K');
        var got = driveToDecode(enc, T, n);
        assertSameBytes(got.bytes, src, 'roundtrip ' + n);
        return 'K=' + enc.K + ' L=' + enc.parameters.L + ' overhead=' + got.overhead;
      });
    });

    test('roundtrip across symbol sizes 1..1024', function () {
      var sizesT = [1, 2, 3, 7, 64, 100, 512, 1024];
      var detail = [];
      sizesT.forEach(function (t) {
        var src = rndBytes(t * 11 + 5);
        var enc = fountain.encoder(src, t);
        var got = driveToDecode(enc, t, src.length);
        assertSameBytes(got.bytes, src, 'T=' + t);
        detail.push(t + ':+' + got.overhead);
      });
      return detail.join(' ');
    });

    // --- the systematic property --------------------------------------------

    test('symbols 0..K-1 are the source symbols verbatim', function () {
      var src = rndBytes(5000);
      var enc = fountain.encoder(src, T);
      for (var i = 0; i < enc.K; i++) {
        var sym = enc.symbol(i);
        assertEqual(sym.esi, i, 'esi');
        assertEqual(sym.bytes.length, T, 'symbol length');
        var off = i * T;
        var want = new Uint8Array(T);
        want.set(src.subarray(off, Math.min(off + T, src.length)));
        assert(bytesEqual(sym.bytes, want), 'systematic symbol ' + i + ' differs from source');
      }
      return enc.K + ' symbols match';
    });

    test('mutating a returned symbol cannot corrupt the encoder', function () {
      var src = rndBytes(3000);
      var enc = fountain.encoder(src, T);
      var a = enc.symbol(3);
      a.bytes.fill(0xff);
      var b = enc.symbol(3);
      assert(!bytesEqual(a.bytes, b.bytes), 'encoder handed out its own buffer');
      var got = driveToDecode(enc, T, src.length);
      assertSameBytes(got.bytes, src, 'after mutation');
      return 'buffers are copies';
    });

    // --- determinism ---------------------------------------------------------

    test('symbol(i) is stable across encoder instances', function () {
      var src = rndBytes(7000);
      var e1 = fountain.encoder(src, T);
      var e2 = fountain.encoder(src.slice(), T);
      assertEqual(e1.K, e2.K, 'K');
      var checked = 0;
      [0, 1, 5, e1.K - 1, e1.K, e1.K + 1, e1.K + 97, 100000, 16777215].forEach(function (esi) {
        var s1 = e1.symbol(esi), s2 = e2.symbol(esi);
        assert(bytesEqual(s1.bytes, s2.bytes), 'esi ' + esi + ' differs between instances');
        checked++;
      });
      return checked + ' ESIs identical';
    });

    test('a restarted sender resumes the same stream', function () {
      var src = rndBytes(4000);
      var enc = fountain.encoder(src, T);
      var first = [];
      for (var i = 0; i < 20; i++) first.push(enc.symbol(enc.K + i));
      var restarted = fountain.encoder(src, T);
      for (i = 0; i < 20; i++) {
        assert(bytesEqual(first[i].bytes, restarted.symbol(enc.K + i).bytes),
          'repair symbol ' + i + ' changed after restart');
      }
      return '20 repair symbols reproduced';
    });

    test('parameters and systematic index are pure functions of K', function () {
      var mismatch = 0;
      for (var K = 1; K <= 40; K++) {
        var p1 = JSON.stringify(fountain.parameters(K));
        var p2 = JSON.stringify(fountain.parameters(K));
        if (p1 !== p2) mismatch++;
        if (fountain.systematicIndex(K) !== fountain.systematicIndex(K)) mismatch++;
      }
      assertEqual(mismatch, 0, 'unstable derivations');
      return 'K=1..40 stable';
    });

    // --- loss ----------------------------------------------------------------

    [20, 40, 60].forEach(function (pct) {
      test('random loss, ' + pct + '% dropped', function () {
        var src = rndBytes(12000);
        var enc = fountain.encoder(src, T);
        var worst = 0, runs = 8;
        for (var r = 0; r < runs; r++) {
          var got = driveToDecode(enc, T, src.length, { lossPct: pct, firstEsi: r * 7 });
          assertSameBytes(got.bytes, src, pct + '% loss run ' + r);
          if (got.overhead > worst) worst = got.overhead;
        }
        return runs + ' runs, K=' + enc.K + ', worst overhead +' + worst;
      });
    });

    test('order independence: shuffled symbols decode identically', function () {
      var src = rndBytes(9000);
      var enc = fountain.encoder(src, T);
      var pool = [];
      for (var i = 0; i < enc.K + 12; i++) pool.push(enc.symbol(i));

      var inOrder = fountain.decoder(enc.K, T, src.length);
      for (i = 0; i < pool.length && !inOrder.add(pool[i]); i++) { /* feed */ }
      var reference = inOrder.decode();
      assertSameBytes(reference, src, 'in-order');

      for (var trial = 0; trial < 12; trial++) {
        var mixed = shuffle(pool);
        var dec = fountain.decoder(enc.K, T, src.length);
        var done = false;
        for (i = 0; i < mixed.length && !done; i++) done = dec.add(mixed[i]);
        assert(done, 'shuffled trial ' + trial + ' never decoded');
        assertSameBytes(dec.decode(), reference, 'shuffled trial ' + trial);
      }
      return '12 shuffles, byte-identical';
    });

    test('repair symbols alone reconstruct the object', function () {
      var detail = [];
      [[600, 128], [12000, 256], [40000, 512]].forEach(function (cfg) {
        var src = rndBytes(cfg[0]);
        var enc = fountain.encoder(src, cfg[1]);
        // Start past the systematic range: not one source symbol is offered.
        var got = driveToDecode(enc, cfg[1], src.length, { firstEsi: enc.K });
        assertSameBytes(got.bytes, src, 'repair-only ' + cfg[0]);
        detail.push('K=' + enc.K + ' +' + got.overhead);
      });
      return detail.join(', ');
    });

    test('repair-only under 50% loss', function () {
      var src = rndBytes(15000);
      var enc = fountain.encoder(src, 256);
      for (var r = 0; r < 6; r++) {
        var got = driveToDecode(enc, 256, src.length, { firstEsi: enc.K + r * 13, lossPct: 50 });
        assertSameBytes(got.bytes, src, 'repair-only lossy run ' + r);
      }
      return '6 runs, K=' + enc.K;
    });

    // --- overhead distribution ----------------------------------------------

    test('reception overhead distribution', function () {
      var hist = {}, trials = 0, sum = 0, max = 0;
      [8, 25, 60, 120, 200].forEach(function (K) {
        var t = 128;
        var src = rndBytes(K * t - 9);
        var enc = fountain.encoder(src, t);
        assertEqual(enc.K, K, 'K for size');
        for (var i = 0; i < 40; i++) {
          var got = driveToDecode(enc, t, src.length, { lossPct: 35, firstEsi: i * 31 });
          assertSameBytes(got.bytes, src, 'overhead trial K=' + K + ' #' + i);
          hist[got.overhead] = (hist[got.overhead] || 0) + 1;
          sum += got.overhead;
          trials++;
          if (got.overhead > max) max = got.overhead;
        }
      });
      var cum = 0, at = {};
      for (var k = 0; k <= max; k++) {
        cum += hist[k] || 0;
        at[k] = (100 * cum / trials).toFixed(1);
      }
      // The headline claim: K+2 symbols suffice essentially always.
      var withinTwo = 100 * ((hist[0] || 0) + (hist[1] || 0) + (hist[2] || 0)) / trials;
      assert(withinTwo >= 99, 'only ' + withinTwo.toFixed(1) + '% decoded within K+2');
      return trials + ' trials, mean +' + (sum / trials).toFixed(3) + ', max +' + max +
        ', <=+0 ' + at[0] + '%, <=+1 ' + (at[1] || at[0]) + '%, <=+2 ' + (at[2] || at[1] || at[0]) + '%';
    });

    // --- truncated streams ---------------------------------------------------

    test('a truncated stream returns null, never wrong bytes', function () {
      var src = rndBytes(10000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K, T, src.length);
      var ready = false;
      for (var i = 0; i < enc.K - 1; i++) ready = dec.add(enc.symbol(i));
      assert(!ready, 'claimed decodable with K-1 symbols');
      assertEqual(dec.decode(), null, 'decode() with K-1 symbols');
      assert(dec.needed > 0, 'needed should be positive');
      // One symbol short of every prefix along the way must also stay null.
      var nulls = 0;
      var dec2 = fountain.decoder(enc.K, T, src.length);
      for (i = 0; i < enc.K + 5; i++) {
        var done = dec2.add(enc.symbol(i));
        if (!done) {
          assertEqual(dec2.decode(), null, 'partial decode at ' + i);
          nulls++;
        } else break;
      }
      assertSameBytes(dec2.decode(), src, 'after completion');
      return nulls + ' partial states all null';
    });

    test('needed counts down and reaches zero exactly at decodability', function () {
      var src = rndBytes(6000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K, T, src.length);
      assertEqual(dec.needed, enc.K, 'initial needed should equal K');
      var prev = dec.needed, done = false;
      for (var i = 0; i < enc.K + 20 && !done; i++) {
        done = dec.add(enc.symbol(i));
        assert(dec.needed <= prev, 'needed increased');
        prev = dec.needed;
      }
      assert(done, 'never decoded');
      assertEqual(dec.needed, 0, 'needed at completion');
      return 'K=' + enc.K + ', received=' + dec.received;
    });

    // --- hostile input -------------------------------------------------------

    test('malformed symbols are ignored without throwing', function () {
      var src = rndBytes(8000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K, T, src.length);
      var junk = [
        null, undefined, 0, '', 'not a symbol', [], {},
        { esi: 0 },
        { esi: 0, bytes: null },
        { esi: 0, bytes: new Uint8Array(0) },
        { esi: 0, bytes: new Uint8Array(T - 1) },
        { esi: 0, bytes: new Uint8Array(T + 1) },
        { esi: 0, bytes: new Uint8Array(1000000) },
        { esi: -1, bytes: new Uint8Array(T) },
        { esi: 1.5, bytes: new Uint8Array(T) },
        { esi: NaN, bytes: new Uint8Array(T) },
        { esi: Infinity, bytes: new Uint8Array(T) },
        { esi: -0.0001, bytes: new Uint8Array(T) },
        { esi: 16777216, bytes: new Uint8Array(T) },
        { esi: 1e300, bytes: new Uint8Array(T) },
        { esi: '3', bytes: new Uint8Array(T) },
        { esi: { valueOf: function () { return 3; } }, bytes: new Uint8Array(T) },
        // Duck-typed payloads: right length, no bytes behind it. Reading these
        // positionally yields undefined, which coerces to an all-zero symbol —
        // a well-formed equation carrying a lie. They must be refused outright.
        { esi: 2, bytes: { length: T } },
        { esi: 2, bytes: { length: T, 0: 1, 1: 2 } },
        { esi: 2, bytes: new DataView(new ArrayBuffer(T)) },
        { esi: 2, bytes: new Uint32Array(T) },
        { esi: 2, bytes: 'x'.repeat(T) }
      ];
      junk.forEach(function (j, idx) {
        var r = dec.add(j);
        assertEqual(r, false, 'junk #' + idx + ' reported decodable');
      });
      assertEqual(dec.received, 0, 'junk was counted as received');
      // A decoder poisoned with junk still decodes normally afterwards.
      var got = false;
      for (var i = 0; i < enc.K + 20 && !got; i++) got = dec.add(enc.symbol(i));
      assert(got, 'decoder unusable after junk');
      assertSameBytes(dec.decode(), src, 'after junk');
      return junk.length + ' hostile inputs rejected';
    });

    test('duplicate ESIs are ignored, not double-counted', function () {
      var src = rndBytes(5000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K, T, src.length);
      var sym = enc.symbol(0);
      for (var i = 0; i < 50; i++) dec.add({ esi: 0, bytes: sym.bytes.slice() });
      assertEqual(dec.received, 1, 'duplicates counted');
      // A duplicated ESI carrying different bytes must not displace the first.
      var evil = sym.bytes.slice(); evil[0] ^= 0xff;
      dec.add({ esi: 0, bytes: evil });
      assertEqual(dec.received, 1, 'contradicting duplicate accepted');
      var done = false;
      for (i = 1; i < enc.K + 20 && !done; i++) done = dec.add(enc.symbol(i));
      assert(done, 'never decoded');
      assertSameBytes(dec.decode(), src, 'after duplicates');
      return 'first-wins, 51 duplicates dropped';
    });

    test('a redundant but consistent symbol is accepted and harmless', function () {
      var src = rndBytes(4000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K, T, src.length);
      var done = false;
      for (var i = 0; i < enc.K + 30 && !done; i++) done = dec.add(enc.symbol(i));
      assert(done, 'never decoded');
      var before = dec.decode();
      // Feeding more after completion must keep answering the same bytes.
      for (i = 0; i < 10; i++) assertEqual(dec.add(enc.symbol(5000 + i)), true, 'post-decode add');
      assertSameBytes(dec.decode(), before, 'answer changed after extra symbols');
      return 'stable across 10 extra symbols';
    });

    test('out-of-range construction is rejected loudly', function () {
      var bad = 0;
      function rejects(fn) {
        try { fn(); } catch (e) { bad++; return; }
        throw new Error('accepted invalid arguments');
      }
      rejects(function () { fountain.encoder(new Uint8Array(10), 0); });
      rejects(function () { fountain.encoder(new Uint8Array(10), -1); });
      rejects(function () { fountain.encoder(new Uint8Array(10), 1.5); });
      rejects(function () { fountain.encoder(new Uint8Array(10), NaN); });
      rejects(function () { fountain.decoder(0, 256, 10); });
      rejects(function () { fountain.decoder(-5, 256, 10); });
      rejects(function () { fountain.decoder(10, 256, -1); });
      rejects(function () { fountain.decoder(fountain.MAX_SYMBOLS + 1, 256, 10); });
      rejects(function () { fountain.encoder(new Uint8Array(10), 256).symbol(-1); });
      rejects(function () { fountain.encoder(new Uint8Array(10), 256).symbol(1e300); });
      return bad + ' invalid argument sets rejected';
    });

    test('an oversized totalBytes claim cannot over-read', function () {
      var src = rndBytes(1000);
      var enc = fountain.encoder(src, T);
      // A lying manifest claims far more bytes than K*T can hold.
      var dec = fountain.decoder(enc.K, T, 1 << 28);
      assert(dec.totalBytes <= enc.K * T, 'totalBytes not clamped');
      var done = false;
      for (var i = 0; i < enc.K + 20 && !done; i++) done = dec.add(enc.symbol(i));
      var out = dec.decode();
      assertEqual(out.length, enc.K * T, 'clamped output length');
      assert(bytesEqual(out.subarray(0, 1000), src), 'prefix corrupted');
      return 'clamped to K*T = ' + (enc.K * T);
    });

    test('wrong K, repair-only, never yields the original bytes', function () {
      var src = rndBytes(8000);
      var enc = fountain.encoder(src, T);
      // Repair symbols built for K=32 fed to a decoder told K=33. The tuple
      // generator keys on K, so the equations disagree and the system must not
      // resolve to the original object. (Systematic ESIs are deliberately
      // excluded here — see the next case for why they would pass.)
      var dec = fountain.decoder(enc.K + 1, T, src.length);
      var done = false;
      for (var i = 0; i < enc.K + 60 && !done; i++) done = dec.add(enc.symbol(enc.K + i));
      var out = dec.decode();
      assert(out === null || !bytesEqual(out, src.subarray(0, out.length)),
        'mismatched K produced the original bytes by accident');
      return done ? 'resolved to different bytes' : 'never resolved';
    });

    test('systematic ESIs carry the source even if K is misreported', function () {
      // Not a bug, and worth pinning down so nobody "fixes" it: ESIs below K
      // are the source symbols in the clear. A receiver that collects them has
      // the object no matter what K it thinks it is decoding, because
      // reconstruction evaluates the same LT rows the symbols satisfied.
      var src = rndBytes(8000);
      var enc = fountain.encoder(src, T);
      var dec = fountain.decoder(enc.K + 1, T, src.length);
      var done = false;
      for (var i = 0; i < enc.K + 40 && !done; i++) done = dec.add(enc.symbol(i));
      assert(done, 'never resolved');
      assertSameBytes(dec.decode(), src, 'systematic passthrough');
      return 'source recovered from systematic ESIs at K+1';
    });

    // --- real artifacts ------------------------------------------------------

    if (env.readFile) {
      [
        ['demo/ruvnet-demo.rvf', 2304, 256],
        ['demo/rvf_wasm_bg.wasm', 40989, 512]
      ].forEach(function (cfg) {
        var rel = cfg[0], expectLen = cfg[1], t = cfg[2];

        test('real artifact ' + rel + ' roundtrips byte-exact', function () {
          var src = env.readFile(rel);
          assertEqual(src.length, expectLen, 'artifact length');
          var enc = fountain.encoder(src, t);
          var got = driveToDecode(enc, t, src.length);
          assertSameBytes(got.bytes, src, rel);
          return 'K=' + enc.K + ' L=' + enc.parameters.L + ' T=' + t +
            ' overhead=+' + got.overhead + ' sha=' + digest(got.bytes).slice(0, 12);
        });

        test('real artifact ' + rel + ' survives 50% loss, repair-only', function () {
          var src = env.readFile(rel);
          var enc = fountain.encoder(src, t);
          var got = driveToDecode(enc, t, src.length, { firstEsi: enc.K, lossPct: 50 });
          assertSameBytes(got.bytes, src, rel + ' lossy repair-only');
          return 'K=' + enc.K + ' overhead=+' + got.overhead;
        });

        test('real artifact ' + rel + ' timings', function () {
          var src = env.readFile(rel);
          var now = (typeof process !== 'undefined' && process.hrtime)
            ? function () { return Number(process.hrtime.bigint()) / 1e6; }
            : function () { return Date.now(); };

          var t0 = now();
          var enc = fountain.encoder(src, t);
          var t1 = now();
          var pool = [];
          for (var i = 0; i < enc.K + 5; i++) pool.push(enc.symbol(i));
          var t2 = now();
          // Repair-only, the expensive path: every symbol needs elimination.
          var repair = [];
          for (i = 0; i < enc.K + 5; i++) repair.push(enc.symbol(enc.K + i));
          var t3 = now();
          var dec = fountain.decoder(enc.K, t, src.length);
          var done = false;
          for (i = 0; i < repair.length && !done; i++) done = dec.add(repair[i]);
          var out = dec.decode();
          var t4 = now();
          assertSameBytes(out, src, rel + ' timing run');
          return 'K=' + enc.K + ' | setup ' + (t1 - t0).toFixed(2) + 'ms' +
            ' | ' + pool.length + ' systematic ' + (t2 - t1).toFixed(2) + 'ms' +
            ' | ' + repair.length + ' repair ' + (t3 - t2).toFixed(2) + 'ms' +
            ' | decode ' + (t4 - t3).toFixed(2) + 'ms';
        });
      });
    } else {
      results.push({
        name: 'real artifact cases', ok: true, detail: 'skipped: no file access'
      });
    }

    // --- parameter sanity ----------------------------------------------------

    test('derived parameters stay well-formed across K=1..600', function () {
      for (var K = 1; K <= 600; K++) {
        var p = fountain.parameters(K);
        assertEqual(p.L, K + p.S + p.H, 'L = K+S+H at K=' + K);
        assertEqual(p.B, p.W - p.S, 'B = W-S at K=' + K);
        assert(p.B >= 0, 'B negative at K=' + K);
        assert(p.W >= 2, 'W too small at K=' + K);
        assert(p.P >= p.H, 'inactive block too small for HDPC identity at K=' + K);
        assert(p.P1 >= 2 && p.P1 >= p.P, 'P1 invalid at K=' + K);
      }
      return 'K=1..600 consistent';
    });

    test('every K in 1..120 encodes and decodes', function () {
      var worst = 0;
      for (var K = 1; K <= 120; K++) {
        var t = 32;
        var src = rndBytes(K * t);
        var enc = fountain.encoder(src, t);
        assertEqual(enc.K, K, 'K at ' + K);
        var got = driveToDecode(enc, t, src.length, { firstEsi: K });
        assertSameBytes(got.bytes, src, 'K=' + K);
        if (got.overhead > worst) worst = got.overhead;
      }
      return 'K=1..120 repair-only, worst overhead +' + worst;
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
