/*!
 * rvQR fountain — a systematic fountain code over GF(256) with the RaptorQ
 * structure of RFC 6330.
 *
 * WHAT THIS IS, PRECISELY. This is NOT an RFC 6330 conformant codec and will
 * not interoperate with one. It reuses RaptorQ's *architecture* — a systematic
 * precode (LDPC + HDPC constraints) feeding an LT-style encoder that draws
 * taps from an "LT" column block and a small permanently-inactive block — but
 * three pieces that RFC 6330 pins down with published tables are derived here
 * instead:
 *
 *   1. Parameters (S, H, W, P1). The RFC reads these from Table 2 for each of
 *      the 477 permitted K' values. This module computes them from the
 *      formulas in `parameters()` below and uses K' = K, so there is no
 *      padding to a table value.
 *   2. The systematic index J(K'). The RFC tabulates a per-K' constant chosen
 *      so the systematic constraint matrix inverts. This module *searches* for
 *      one at runtime (`systematicIndex`), trying seeds until the matrix has
 *      full rank. It is a pure function of K, so encoder and decoder agree
 *      without exchanging anything.
 *   3. Rand[] and G_HDPC. The RFC's Rand[] uses four published 256-entry
 *      tables and G_HDPC is built as MT*GAMMA. This module uses a 32-bit
 *      mixing PRNG and a uniformly random dense GF(256) HDPC block.
 *
 * What IS taken from RFC 6330, structurally: the A = [LDPC | HDPC | LT] block
 * layout, the circulant G_LDPC,1 construction, the G_LDPC,2 ring into the
 * inactive block, the (d, a, b, d1, a1, b1) tuple shape, the Enc[] walk with
 * its prime moduli, and the degree distribution's shape and cut points.
 *
 * Consequences: symbol streams from this module decode only with this module.
 * The reception overhead is measured, not inherited — see fountain.test.js.
 *
 * Everything here is pure: no DOM, no storage, no timers. Works under Node
 * `require` and as the browser global `RVQRFountain`.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRFountain = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Largest source-block symbol count. Decoding is a Gaussian elimination over
  // L ~= K + O(sqrt(K)) unknowns, so cost grows as K^2 * (K + T). 4096 keeps
  // the worst case inside a few seconds on a phone; a QR channel realistically
  // runs at K in the tens or low hundreds.
  var MAX_SYMBOLS = 4096;

  // Encoding symbol ID space. Matches RFC 6330's 24-bit ESI field, which is
  // what a frame header can carry, and bounds the tuple generator's input.
  var MAX_ESI = 16777216;

  // --- GF(256), x^8 + x^4 + x^3 + x^2 + 1 (0x11d, as in RFC 6330 §5.7) ------

  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  // Full 64 KB product table. Row `c` is the map b -> c*b, which turns every
  // scaled row operation into a table lookup instead of two logs and an exp.
  var GF_MUL = new Uint8Array(65536);
  (function () {
    for (var a = 1; a < 256; a++) {
      var la = GF_LOG[a], base = a << 8;
      for (var b = 1; b < 256; b++) GF_MUL[base + b] = GF_EXP[la + GF_LOG[b]];
    }
  })();

  function gfInv(a) { return GF_EXP[255 - GF_LOG[a]]; }

  // --- parameter derivation --------------------------------------------------

  function isPrime(n) {
    if (n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (var i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
    return true;
  }
  function nextPrime(n) { var p = n < 2 ? 2 : n | 0; while (!isPrime(p)) p++; return p; }
  function prevPrime(n) { var p = n | 0; while (p >= 2 && !isPrime(p)) p--; return p < 2 ? 2 : p; }

  // C(h, ceil(h/2)). Exact in a double for every h this function is asked
  // about (h stays under 40 for K <= MAX_SYMBOLS).
  function centralBinomial(h) {
    var k = Math.ceil(h / 2), r = 1;
    for (var i = 1; i <= k; i++) r = (r * (h - k + i)) / i;
    return r;
  }

  /**
   * Derives the code parameters for a source block of K symbols.
   *
   * S and H follow RFC 6330 §5.3.3.3's stated derivations. W and P1 are this
   * module's own choice: W is the largest prime <= K+S, which keeps the LT
   * walk's modulus prime (so `b, b+a, b+2a, ...` visits distinct columns) and
   * leaves P = L-W >= H inactive columns for the HDPC identity to sit in.
   *
   * @param {number} K source symbols in the block, 1..MAX_SYMBOLS
   * @returns {{K,S,H,W,L,P,P1,B:number}} S LDPC rows, H HDPC rows, L unknowns,
   *   columns [0,B) source-side LDPC taps, [B,W) LDPC identity, [W,L) inactive.
   */
  function parameters(K) {
    var X = 1;
    while (X * (X - 1) < 2 * K) X++;
    var S = nextPrime(Math.ceil(K / 100) + X);
    var H = 1;
    while (centralBinomial(H) < K + S) H++;
    var W = prevPrime(K + S);
    var L = K + S + H;
    return { K: K, S: S, H: H, W: W, L: L, P: L - W, P1: Math.max(2, nextPrime(L - W)), B: W - S };
  }

  // --- deterministic randomness ---------------------------------------------

  function mix32(x) {
    x = x | 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
  }

  // Stand-in for RFC 6330's Rand[y, i, m]: `i` selects an independent stream
  // for the same `y`, so one ESI yields six uncorrelated draws.
  function rnd(seed, y, i) {
    return mix32(mix32((seed ^ Math.imul(y | 0, 0x9e3779b1)) | 0) ^ Math.imul((i | 0) + 1, 0x85ebca6b));
  }

  // Degree distribution over 2^20, same shape and cut points as RFC 6330
  // Table 1: half the symbols have degree 2, the tail reaches 30, mean ~4.6.
  var DEG_F = [
    0, 5243, 529531, 704294, 791675, 844104, 879057, 904023, 922747, 937311,
    948962, 958494, 966438, 973160, 978921, 983914, 988283, 992138, 995565,
    998631, 1001391, 1003887, 1006157, 1008229, 1010129, 1011876, 1013490,
    1014983, 1016370, 1017662, 1048576
  ];

  function degree(v) {
    for (var d = 1; d < DEG_F.length; d++) if (v < DEG_F[d]) return d;
    return DEG_F.length - 1;
  }

  /**
   * The (d, a, b, d1, a1, b1) tuple for one encoding symbol ID.
   * d taps walk the LT block mod W; d1 taps walk the inactive block mod P1,
   * skipping residues past P. d1 = 3 for low-degree symbols so that every
   * symbol touches the inactive block at least twice.
   */
  function tupleFor(prm, seed, esi) {
    var W = prm.W, P1 = prm.P1;
    var d = degree(rnd(seed, esi, 0) % 1048576);
    var dMax = Math.max(1, W - 2);
    if (d > dMax) d = dMax;
    var d1 = d < 4 ? 3 : 2;
    if (d1 > prm.P) d1 = prm.P;
    return {
      d: d,
      a: 1 + (rnd(seed, esi, 1) % (W - 1)),
      b: rnd(seed, esi, 2) % W,
      d1: d1,
      a1: 1 + (rnd(seed, esi, 3) % (P1 - 1)),
      b1: rnd(seed, esi, 4) % P1
    };
  }

  // --- constraint and LT rows ------------------------------------------------

  // S sparse binary rows: [G_LDPC,1 | I_S | G_LDPC,2].
  function ldpcCoefs(prm) {
    var S = prm.S, L = prm.L, B = prm.B, W = prm.W, P = prm.P;
    var rows = new Array(S), i, col, a, b;
    for (i = 0; i < S; i++) rows[i] = new Uint8Array(L);
    for (col = 0; col < B; col++) {
      a = 1 + Math.floor(col / S);
      b = col % S;
      rows[b][col] ^= 1;
      b = (b + a) % S; rows[b][col] ^= 1;
      b = (b + a) % S; rows[b][col] ^= 1;
    }
    for (i = 0; i < S; i++) rows[i][B + i] ^= 1;
    for (i = 0; i < S; i++) {
      rows[i][W + (i % P)] ^= 1;
      rows[i][W + ((i + 1) % P)] ^= 1;
    }
    return rows;
  }

  // H dense GF(256) rows over the first L-H columns, identity on the last H.
  // Uniformly random is the strongest choice available for rank: it is what
  // makes the square K-symbol system invert as often as it does.
  function hdpcCoefs(prm, seed) {
    var H = prm.H, L = prm.L, nd = L - H;
    var rows = new Array(H), i, j;
    for (i = 0; i < H; i++) {
      var r = new Uint8Array(L);
      for (j = 0; j < nd; j++) r[j] = rnd(seed ^ 0x5bf03635, j, i) & 255;
      r[nd + i] = 1;
      rows[i] = r;
    }
    return rows;
  }

  // One binary LT row: d taps in [0,W), then d1 taps in [W,L).
  function ltCoefs(prm, seed, esi) {
    var W = prm.W, P = prm.P, P1 = prm.P1;
    var t = tupleFor(prm, seed, esi);
    var r = new Uint8Array(prm.L), j;
    var b = t.b;
    r[b] ^= 1;
    for (j = 1; j < t.d; j++) { b = (b + t.a) % W; r[b] ^= 1; }
    var b1 = t.b1;
    while (b1 >= P) b1 = (b1 + t.a1) % P1;
    r[W + b1] ^= 1;
    for (j = 1; j < t.d1; j++) {
      do { b1 = (b1 + t.a1) % P1; } while (b1 >= P);
      r[W + b1] ^= 1;
    }
    return r;
  }

  // --- rows and elimination --------------------------------------------------

  // Symbol payload lives in its own buffer so a Uint32Array view can XOR it
  // four bytes at a time; `bytes` and `words` alias the same memory.
  function makeRow(L, words) {
    var buf = new ArrayBuffer(words * 4);
    return { coefs: new Uint8Array(L), bytes: new Uint8Array(buf), words: new Uint32Array(buf) };
  }

  // All three operations start at `from` because the caller has already
  // established that both rows are zero to its left.
  function xorRow(dst, src, from, L) {
    var dc = dst.coefs, sc = src.coefs, i;
    for (i = from; i < L; i++) dc[i] ^= sc[i];
    var dw = dst.words, sw = src.words, n = dw.length;
    for (i = 0; i < n; i++) dw[i] ^= sw[i];
  }

  function mulAddRow(dst, src, coef, from, L) {
    var m = GF_MUL.subarray(coef << 8, (coef << 8) + 256);
    var dc = dst.coefs, sc = src.coefs, i;
    for (i = from; i < L; i++) dc[i] ^= m[sc[i]];
    var db = dst.bytes, sb = src.bytes, n = db.length;
    for (i = 0; i < n; i++) db[i] ^= m[sb[i]];
  }

  function scaleRow(row, coef, from, L) {
    var m = GF_MUL.subarray(coef << 8, (coef << 8) + 256);
    var c = row.coefs, i;
    for (i = from; i < L; i++) c[i] = m[c[i]];
    var b = row.bytes, n = b.length;
    for (i = 0; i < n; i++) b[i] = m[b[i]];
  }

  /**
   * Incremental Gaussian elimination over GF(256).
   *
   * Rows arrive one at a time (symbols arrive one at a time), each reduced
   * against the pivots already held and kept if it opens a new column. The
   * result is upper triangular with unit pivots: `pivots[c]` is zero left of
   * column c and 1 at c. `rank === L` is exactly the decodability test, which
   * is why `add()` can answer without a separate pass.
   */
  function Solver(L, words) {
    this.L = L;
    this.words = words;
    this.rank = 0;
    this.pivots = new Array(L);
  }

  Solver.prototype.insert = function (row) {
    var L = this.L, piv = this.pivots, c, v, p;
    for (c = 0; c < L; c++) {
      v = row.coefs[c];
      if (v === 0) continue;
      p = piv[c];
      if (p) {
        if (v === 1) xorRow(row, p, c, L);
        else mulAddRow(row, p, v, c, L);
      } else {
        if (v !== 1) scaleRow(row, gfInv(v), c, L);
        piv[c] = row;
        this.rank++;
        return true;
      }
    }
    return false;
  };

  // Back-substitution. Returns L payload rows, or null while rank is short.
  Solver.prototype.solve = function () {
    var L = this.L;
    if (this.rank !== L) return null;
    var piv = this.pivots, out = new Array(L), c, j, v, i, n;
    for (c = L - 1; c >= 0; c--) {
      var p = piv[c];
      var buf = new ArrayBuffer(this.words * 4);
      var acc = { bytes: new Uint8Array(buf), words: new Uint32Array(buf) };
      acc.words.set(p.words);
      for (j = c + 1; j < L; j++) {
        v = p.coefs[j];
        if (v === 0) continue;
        var src = out[j];
        if (v === 1) {
          for (i = 0, n = acc.words.length; i < n; i++) acc.words[i] ^= src.words[i];
        } else {
          var m = GF_MUL.subarray(v << 8, (v << 8) + 256);
          for (i = 0, n = acc.bytes.length; i < n; i++) acc.bytes[i] ^= m[src.bytes[i]];
        }
      }
      out[c] = acc;
    }
    return out;
  };

  // --- systematic index ------------------------------------------------------

  var SYSTEMATIC_CACHE = {};

  /**
   * The seed that makes the systematic constraint matrix for K invertible —
   * this module's stand-in for RFC 6330's tabulated J(K').
   *
   * Pure in K and cached, so an encoder and a decoder that never speak still
   * pick the same code. Runs a coefficient-only elimination (no payload), so
   * a miss costs roughly a third of one decode.
   *
   * @param {number} K source symbols
   * @returns {number} 32-bit seed
   */
  function systematicIndex(K) {
    if (SYSTEMATIC_CACHE[K] !== undefined) return SYSTEMATIC_CACHE[K];
    var prm = parameters(K);
    for (var j = 0; j < 4096; j++) {
      var seed = mix32(Math.imul(K + 1, 0x27d4eb2d) ^ Math.imul(j + 1, 0x165667b1));
      var s = new Solver(prm.L, 0);
      var i, row;
      var ldpc = ldpcCoefs(prm);
      for (i = 0; i < ldpc.length; i++) {
        row = makeRow(0, 0); row.coefs = ldpc[i]; s.insert(row);
      }
      for (i = 0; i < K; i++) {
        row = makeRow(0, 0); row.coefs = ltCoefs(prm, seed, i); s.insert(row);
      }
      var hdpc = hdpcCoefs(prm, seed);
      for (i = 0; i < hdpc.length; i++) {
        row = makeRow(0, 0); row.coefs = hdpc[i]; s.insert(row);
      }
      if (s.rank === prm.L) {
        SYSTEMATIC_CACHE[K] = seed;
        return seed;
      }
    }
    throw new Error('fountain: no systematic index found for K=' + K);
  }

  // --- input coercion and validation ----------------------------------------

  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input.length === 'number') return Uint8Array.from(input);
    throw new TypeError('fountain: source must be bytes');
  }

  // A symbol payload has to be something that actually holds bytes. Duck
  // typing on `.length` alone is not enough: `{length: T}` would read back as
  // T undefineds, coerce to an all-zero symbol, and enter the linear system as
  // a valid-looking equation that corrupts the block. Byte-wide typed arrays
  // are matched by BYTES_PER_ELEMENT rather than instanceof so views minted in
  // another realm (a worker, an iframe) still pass, while DataView — which has
  // no indexed access — does not.
  function isByteContainer(v) {
    if (v == null || typeof v !== 'object') return false;
    if (ArrayBuffer.isView(v)) return v.BYTES_PER_ELEMENT === 1;
    return Array.isArray(v);
  }

  function checkSymbolSize(T) {
    if (typeof T !== 'number' || !isFinite(T) || Math.floor(T) !== T || T < 1 || T > 65536) {
      throw new RangeError('fountain: symbolSize must be an integer in 1..65536');
    }
    return T;
  }

  function checkK(K) {
    if (typeof K !== 'number' || !isFinite(K) || Math.floor(K) !== K || K < 1 || K > MAX_SYMBOLS) {
      throw new RangeError('fountain: K must be an integer in 1..' + MAX_SYMBOLS);
    }
    return K;
  }

  // --- public API ------------------------------------------------------------

  /**
   * Builds an encoder over one source block.
   *
   * Symbols 0..K-1 are the source symbols verbatim (systematic); every ESI at
   * or above K is a repair symbol, and the supply is unbounded. `symbol(i)`
   * depends only on the source bytes, the symbol size and `i`, so a sender may
   * restart mid-stream and emit the identical bytes.
   *
   * An empty source still yields K = 1 (one all-zero symbol); the receiver
   * truncates to `totalBytes`, so the empty case needs no special path.
   *
   * @param {Uint8Array|ArrayBuffer|number[]} sourceBytes object to encode
   * @param {number} symbolSize payload bytes per symbol, 1..65536
   * @returns {{K:number, symbolCount:number, totalBytes:number,
   *            symbolSize:number, parameters:object, symbol:function}}
   * @throws {RangeError} if symbolSize is out of range or the object needs
   *   more than MAX_SYMBOLS symbols
   */
  function encoder(sourceBytes, symbolSize) {
    var T = checkSymbolSize(symbolSize);
    var src = toBytes(sourceBytes);
    var K = checkK(Math.max(1, Math.ceil(src.length / T)));
    var prm = parameters(K);
    var seed = systematicIndex(K);
    var words = Math.ceil(T / 4);
    var L = prm.L, i;

    var source = new Array(K);
    for (i = 0; i < K; i++) {
      var s = new Uint8Array(T);
      var off = i * T;
      s.set(src.subarray(off, Math.min(off + T, src.length)));
      source[i] = s;
    }

    // A * C = D, with D zero on the constraint rows and the source symbols on
    // the LT rows. Sparse rows go in before the dense HDPC block so most of
    // the elimination runs against sparse pivots.
    var solver = new Solver(L, words);
    var ldpc = ldpcCoefs(prm), row;
    for (i = 0; i < ldpc.length; i++) {
      row = makeRow(L, words); row.coefs = ldpc[i]; solver.insert(row);
    }
    for (i = 0; i < K; i++) {
      row = makeRow(L, words);
      row.coefs = ltCoefs(prm, seed, i);
      row.bytes.set(source[i]);
      solver.insert(row);
    }
    var hdpc = hdpcCoefs(prm, seed);
    for (i = 0; i < hdpc.length; i++) {
      row = makeRow(L, words); row.coefs = hdpc[i]; solver.insert(row);
    }
    var C = solver.solve();
    if (!C) throw new Error('fountain: systematic matrix is singular for K=' + K);

    function symbol(esi) {
      if (typeof esi !== 'number' || !isFinite(esi) || Math.floor(esi) !== esi ||
          esi < 0 || esi >= MAX_ESI) {
        throw new RangeError('fountain: esi must be an integer in 0..' + (MAX_ESI - 1));
      }
      if (esi < K) return { esi: esi, bytes: source[esi].slice() };
      var coefs = ltCoefs(prm, seed, esi);
      var buf = new ArrayBuffer(words * 4);
      var accW = new Uint32Array(buf), c, j, n = accW.length;
      for (c = 0; c < L; c++) {
        if (coefs[c] === 0) continue;
        var cw = C[c].words;
        for (j = 0; j < n; j++) accW[j] ^= cw[j];
      }
      return { esi: esi, bytes: new Uint8Array(buf, 0, T).slice() };
    }

    return {
      K: K,
      // The ESI space, not a stopping point: a fountain sender keeps counting.
      symbolCount: MAX_ESI,
      totalBytes: src.length,
      symbolSize: T,
      parameters: prm,
      symbol: symbol
    };
  }

  /**
   * Builds a decoder for a source block of K symbols.
   *
   * Feed it any symbols, in any order, systematic or repair; `add` reports
   * true the moment the block is recoverable. Symbols that are malformed,
   * duplicated or out of range are ignored rather than thrown — they arrive
   * from a camera pointed at whatever happens to be in front of it.
   *
   * @param {number} K source symbols in the block, as the sender declared
   * @param {number} symbolSize payload bytes per symbol
   * @param {number} totalBytes original object length, for truncation
   * @returns {{add:function, decode:function, received:number, needed:number,
   *            K:number, symbolSize:number, totalBytes:number}}
   * @throws {RangeError} on out-of-range construction arguments
   */
  function decoder(K, symbolSize, totalBytes) {
    checkK(K);
    var T = checkSymbolSize(symbolSize);
    var total = totalBytes;
    if (typeof total !== 'number' || !isFinite(total) || Math.floor(total) !== total || total < 0) {
      throw new RangeError('fountain: totalBytes must be a non-negative integer');
    }
    if (total > K * T) total = K * T;

    var prm = parameters(K);
    var seed = systematicIndex(K);
    var words = Math.ceil(T / 4);
    var L = prm.L, i, row;

    var solver = new Solver(L, words);
    var ldpc = ldpcCoefs(prm);
    for (i = 0; i < ldpc.length; i++) {
      row = makeRow(L, words); row.coefs = ldpc[i]; solver.insert(row);
    }
    var hdpc = hdpcCoefs(prm, seed);
    for (i = 0; i < hdpc.length; i++) {
      row = makeRow(L, words); row.coefs = hdpc[i]; solver.insert(row);
    }

    var seen = Object.create(null);
    var cached = null;

    var self = {
      K: K,
      symbolSize: T,
      totalBytes: total,
      parameters: prm,
      received: 0,
      needed: Math.max(0, L - solver.rank),
      add: add,
      decode: decode,
      isDecodable: function () { return solver.rank === L; }
    };

    /**
     * Offers one encoding symbol.
     * @param {{esi:number, bytes:Uint8Array}} sym
     * @returns {boolean} true once the block can be decoded
     */
    function add(sym) {
      if (!sym || typeof sym !== 'object') return solver.rank === L;
      var esi = sym.esi;
      if (typeof esi !== 'number' || !isFinite(esi) || Math.floor(esi) !== esi ||
          esi < 0 || esi >= MAX_ESI) {
        return solver.rank === L;
      }
      if (seen[esi]) return solver.rank === L;
      var bytes = sym.bytes;
      if (!isByteContainer(bytes) || bytes.length !== T) return solver.rank === L;
      seen[esi] = true;
      self.received++;
      if (solver.rank < L) {
        var r = makeRow(L, words);
        r.coefs = ltCoefs(prm, seed, esi);
        for (var j = 0; j < T; j++) r.bytes[j] = bytes[j] & 255;
        if (solver.insert(r)) cached = null;
        self.needed = Math.max(0, L - solver.rank);
      }
      return solver.rank === L;
    }

    /**
     * Reconstructs the object.
     *
     * Source symbols are regenerated from the solved intermediate symbols
     * rather than copied out of whatever arrived, so a symbol whose payload
     * contradicts the rest of the block changes the answer instead of being
     * trusted in place.
     *
     * @returns {Uint8Array|null} the object, or null while more symbols are
     *   needed — never a partial or speculative result
     */
    function decode() {
      if (solver.rank !== L) return null;
      if (cached) return cached.slice();
      var C = solver.solve();
      if (!C) return null;
      var out = new Uint8Array(K * T);
      var scratch = new ArrayBuffer(words * 4);
      var accW = new Uint32Array(scratch);
      var accB = new Uint8Array(scratch);
      for (var i2 = 0; i2 < K; i2++) {
        accW.fill(0);
        var coefs = ltCoefs(prm, seed, i2);
        for (var c = 0; c < L; c++) {
          if (coefs[c] === 0) continue;
          var cw = C[c].words;
          for (var j = 0; j < accW.length; j++) accW[j] ^= cw[j];
        }
        out.set(accB.subarray(0, T), i2 * T);
      }
      cached = out.subarray(0, total);
      return cached.slice();
    }

    return self;
  }

  return {
    MAX_SYMBOLS: MAX_SYMBOLS,
    MAX_ESI: MAX_ESI,
    encoder: encoder,
    decoder: decoder,
    parameters: parameters,
    systematicIndex: systematicIndex,
    symbolsFor: function (byteLength, symbolSize) {
      return Math.max(1, Math.ceil(byteLength / checkSymbolSize(symbolSize)));
    }
  };
});
