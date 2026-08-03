/*!
 * rvQR crypto — signed manifests and authenticated optical sessions.
 *
 * Same contract as core.js: pure functions over plain data, no DOM, no storage,
 * so the browser app and the Node test runner exercise identical code.
 *
 * Two backends sit behind every asymmetric primitive. WebCrypto is used when
 * the platform has it (Chrome 137+, Safari 17+, Firefox 130+, Node 20+ for
 * Ed25519 and X25519); otherwise a self-contained JS implementation runs. Both
 * are checked against the RFC vectors in crypto.test.js, because a fallback
 * nobody tests is a fallback that silently forges signatures.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRCrypto = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Hostile-input ceilings ------------------------------------------------
  // A bootstrap QR is unauthenticated input from whatever is pointed at the
  // camera, exactly like a transfer frame. Anything a parser reads from one is
  // bounded before it reaches an allocation.

  var MAX_BOOTSTRAP_CHARS = 512;   // signed form is 191; 512 leaves headroom
  var MAX_MANIFEST_BYTES = 4096;   // canonical encoding of a sane manifest is ~90
  var MAX_AEAD_BYTES = 16 * 1024 * 1024;
  var MAX_NAME_LENGTH = 255;       // matches core.js
  var MAX_SEAL_COUNTER = 281474976710655; // 2^48-1: stays exact in a JS number

  var SIG_BYTES = 64;
  var KEY_BYTES = 32;
  var TAG_BYTES = 16;
  var NONCE_BYTES = 12;

  // --- byte helpers ----------------------------------------------------------

  // instanceof would say no to a Uint8Array that came from an iframe or a
  // worker, since each realm has its own constructor. The brand check works
  // across realms, which matters for a library the page may hand foreign data.
  function isBytes(x) {
    return ArrayBuffer.isView(x) &&
      Object.prototype.toString.call(x) === '[object Uint8Array]';
  }

  function toBytes(x, name) {
    if (isBytes(x)) return x;
    if (ArrayBuffer.isView(x)) {
      // Any other byte view (DataView, Int8Array) is reinterpreted, not copied.
      return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') {
      return new Uint8Array(x);
    }
    throw new Error((name || 'value') + ' must be a Uint8Array');
  }

  function concat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < list.length; i++) {
      out.set(list[i], off);
      off += list[i].length;
    }
    return out;
  }

  var HEX = '0123456789abcdef';

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += HEX[bytes[i] >>> 4] + HEX[bytes[i] & 15];
    }
    return out;
  }

  function fromHex(str) {
    var s = String(str);
    if (s.length & 1) throw new Error('hex string must have even length');
    var out = new Uint8Array(s.length >>> 1);
    for (var i = 0; i < out.length; i++) {
      var hi = HEX.indexOf(s.charAt(2 * i));
      var lo = HEX.indexOf(s.charAt(2 * i + 1));
      if (hi < 0 || lo < 0) throw new Error('invalid hex character');
      out[i] = (hi << 4) | lo;
    }
    return out;
  }

  /**
   * Comparison whose running time does not depend on where the first
   * difference is. Used everywhere a MAC, a tag, or a fingerprint is checked:
   * a byte-at-a-time early return leaks the position of the mismatch.
   */
  function timingSafeEqual(a, b) {
    if (!isBytes(a) || !isBytes(b) || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /** Cryptographic randomness or nothing. Math.random must never make a key. */
  function randomBytes(n) {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g || !g.crypto || typeof g.crypto.getRandomValues !== 'function') {
      throw new Error('no cryptographic RNG available');
    }
    var out = new Uint8Array(n);
    var off = 0;
    while (off < n) {
      // getRandomValues rejects requests over 65536 bytes.
      var take = Math.min(65536, n - off);
      g.crypto.getRandomValues(out.subarray(off, off + take));
      off += take;
    }
    return out;
  }

  // --- SHA round constants ---------------------------------------------------
  // FIPS 180-4 defines the round constants as the fractional parts of the cube
  // roots of the first 80 primes, and the initial hash values as those of the
  // square roots of the first 8. Deriving them here rather than pasting 160 hex
  // literals removes any chance of a transcription slip; the NIST and RFC
  // vectors in the test file confirm the result. This runs once at load and
  // costs microseconds.

  function firstPrimes(count) {
    var out = [];
    for (var n = 2; out.length < count; n++) {
      var prime = true;
      for (var d = 2; d * d <= n; d++) {
        if (n % d === 0) { prime = false; break; }
      }
      if (prime) out.push(n);
    }
    return out;
  }

  /** Integer k-th root by Newton descent from a deliberate over-estimate. */
  function iroot(n, k) {
    if (n < 2n) return n;
    var kn = BigInt(k);
    var x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
    for (;;) {
      var y = ((kn - 1n) * x + n / (x ** (kn - 1n))) / kn;
      if (y >= x) return x;
      x = y;
    }
  }

  /** floor(frac(root_k(p)) * 2^bits) for each prime, exactly. */
  function fracRoots(primes, k, bits) {
    var mask = (1n << BigInt(bits)) - 1n;
    var shift = BigInt(bits * k);
    return primes.map(function (p) {
      return iroot(BigInt(p) << shift, k) & mask;
    });
  }

  function toWords32(values) {
    var out = new Uint32Array(values.length);
    for (var i = 0; i < values.length; i++) out[i] = Number(values[i]) >>> 0;
    return out;
  }

  function toWords64(values) {
    var out = new Uint32Array(values.length * 2);
    for (var i = 0; i < values.length; i++) {
      out[2 * i] = Number(values[i] >> 32n) >>> 0;
      out[2 * i + 1] = Number(values[i] & 0xffffffffn) >>> 0;
    }
    return out;
  }

  var PRIMES80 = firstPrimes(80);
  var SHA256_K = toWords32(fracRoots(PRIMES80.slice(0, 64), 3, 32));
  var SHA256_H = toWords32(fracRoots(PRIMES80.slice(0, 8), 2, 32));
  var SHA512_K = toWords64(fracRoots(PRIMES80, 3, 64));
  var SHA512_H = toWords64(fracRoots(PRIMES80.slice(0, 8), 2, 64));

  // --- SHA-256 ---------------------------------------------------------------

  function sha256(message) {
    var msg = toBytes(message, 'message');
    var len = msg.length;
    var blocks = ((len + 8) / 64 | 0) + 1;
    var buf = new Uint8Array(blocks * 64);
    buf.set(msg);
    buf[len] = 0x80;
    // Length in bits, big-endian, in the final 8 bytes. Messages are far below
    // 2^53 bytes here, so the high word is the byte count above 2^29.
    var view = new DataView(buf.buffer);
    view.setUint32(buf.length - 8, Math.floor(len / 536870912), false);
    view.setUint32(buf.length - 4, (len << 3) >>> 0, false);

    var H = SHA256_H.slice();
    var W = new Uint32Array(64);
    for (var b = 0; b < blocks; b++) {
      var p = b * 64, t;
      for (t = 0; t < 16; t++) W[t] = view.getUint32(p + t * 4, false);
      for (t = 16; t < 64; t++) {
        var x = W[t - 15], y = W[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA256_K[t] + W[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var ov = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
    return out;
  }

  // --- SHA-512 ---------------------------------------------------------------
  // Ed25519 is defined over SHA-512, so this is not optional even on platforms
  // with a fast SHA-256. State is held as (hi, lo) uint32 pairs; none of the
  // rotation amounts is exactly 32, which is the one case the shift expressions
  // below would get wrong.

  function rotrHi(h, l, n) {
    return n < 32 ? ((h >>> n) | (l << (32 - n))) : ((l >>> (n - 32)) | (h << (64 - n)));
  }

  function rotrLo(h, l, n) {
    return n < 32 ? ((l >>> n) | (h << (32 - n))) : ((h >>> (n - 32)) | (l << (64 - n)));
  }

  function sha512(message) {
    var msg = toBytes(message, 'message');
    var len = msg.length;
    var blocks = ((len + 16) / 128 | 0) + 1;
    var buf = new Uint8Array(blocks * 128);
    buf.set(msg);
    buf[len] = 0x80;
    var view = new DataView(buf.buffer);
    view.setUint32(buf.length - 8, Math.floor(len / 536870912), false);
    view.setUint32(buf.length - 4, (len << 3) >>> 0, false);

    var H = SHA512_H.slice();
    var W = new Uint32Array(160);
    for (var b = 0; b < blocks; b++) {
      var p = b * 128, t, h, l, xh, xl, yh, yl;
      for (t = 0; t < 16; t++) {
        W[2 * t] = view.getUint32(p + t * 8, false);
        W[2 * t + 1] = view.getUint32(p + t * 8 + 4, false);
      }
      for (t = 16; t < 80; t++) {
        xh = W[2 * (t - 15)]; xl = W[2 * (t - 15) + 1];
        var s0h = rotrHi(xh, xl, 1) ^ rotrHi(xh, xl, 8) ^ (xh >>> 7);
        var s0l = rotrLo(xh, xl, 1) ^ rotrLo(xh, xl, 8) ^ ((xl >>> 7) | (xh << 25));
        yh = W[2 * (t - 2)]; yl = W[2 * (t - 2) + 1];
        var s1h = rotrHi(yh, yl, 19) ^ rotrHi(yh, yl, 61) ^ (yh >>> 6);
        var s1l = rotrLo(yh, yl, 19) ^ rotrLo(yh, yl, 61) ^ ((yl >>> 6) | (yh << 26));
        l = (W[2 * (t - 16) + 1] >>> 0) + (s0l >>> 0);
        h = (W[2 * (t - 16)] + s0h + (l > 4294967295 ? 1 : 0)) >>> 0;
        l = (l >>> 0) + (W[2 * (t - 7) + 1] >>> 0);
        h = (h + W[2 * (t - 7)] + (l > 4294967295 ? 1 : 0)) >>> 0;
        l = (l >>> 0) + (s1l >>> 0);
        h = (h + s1h + (l > 4294967295 ? 1 : 0)) >>> 0;
        W[2 * t] = h; W[2 * t + 1] = l >>> 0;
      }

      var ah = H[0], al = H[1], bh = H[2], bl = H[3];
      var ch = H[4], cl = H[5], dh = H[6], dl = H[7];
      var eh = H[8], el = H[9], fh = H[10], fl = H[11];
      var gh = H[12], gl = H[13], hh = H[14], hl = H[15];

      for (t = 0; t < 80; t++) {
        var S1h = rotrHi(eh, el, 14) ^ rotrHi(eh, el, 18) ^ rotrHi(eh, el, 41);
        var S1l = rotrLo(eh, el, 14) ^ rotrLo(eh, el, 18) ^ rotrLo(eh, el, 41);
        var chh = (eh & fh) ^ (~eh & gh);
        var chl = (el & fl) ^ (~el & gl);
        // T1 = h + S1 + Ch + K[t] + W[t]
        l = (hl >>> 0) + (S1l >>> 0);
        h = (hh + S1h + (l > 4294967295 ? 1 : 0)) >>> 0;
        l = (l >>> 0) + (chl >>> 0);
        h = (h + chh + (l > 4294967295 ? 1 : 0)) >>> 0;
        l = (l >>> 0) + (SHA512_K[2 * t + 1] >>> 0);
        h = (h + SHA512_K[2 * t] + (l > 4294967295 ? 1 : 0)) >>> 0;
        l = (l >>> 0) + (W[2 * t + 1] >>> 0);
        h = (h + W[2 * t] + (l > 4294967295 ? 1 : 0)) >>> 0;
        var t1h = h, t1l = l >>> 0;

        var S0h = rotrHi(ah, al, 28) ^ rotrHi(ah, al, 34) ^ rotrHi(ah, al, 39);
        var S0l = rotrLo(ah, al, 28) ^ rotrLo(ah, al, 34) ^ rotrLo(ah, al, 39);
        var mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
        var mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
        l = (S0l >>> 0) + (mjl >>> 0);
        h = (S0h + mjh + (l > 4294967295 ? 1 : 0)) >>> 0;
        var t2h = h, t2l = l >>> 0;

        hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
        l = (dl >>> 0) + (t1l >>> 0);
        eh = (dh + t1h + (l > 4294967295 ? 1 : 0)) >>> 0; el = l >>> 0;
        dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
        l = (t1l >>> 0) + (t2l >>> 0);
        ah = (t1h + t2h + (l > 4294967295 ? 1 : 0)) >>> 0; al = l >>> 0;
      }

      var state = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
      for (t = 0; t < 8; t++) {
        l = (H[2 * t + 1] >>> 0) + (state[2 * t + 1] >>> 0);
        H[2 * t] = (H[2 * t] + state[2 * t] + (l > 4294967295 ? 1 : 0)) >>> 0;
        H[2 * t + 1] = l >>> 0;
      }
    }

    var out = new Uint8Array(64);
    var ov = new DataView(out.buffer);
    for (var i = 0; i < 16; i++) ov.setUint32(i * 4, H[i], false);
    return out;
  }

  // --- HMAC-SHA256 and HKDF (RFC 5869) ---------------------------------------

  function hmacSha256(key, message) {
    var k = toBytes(key, 'key');
    var msg = toBytes(message, 'message');
    if (k.length > 64) k = sha256(k);
    var pad = new Uint8Array(64);
    pad.set(k);
    var inner = new Uint8Array(64), outer = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      inner[i] = pad[i] ^ 0x36;
      outer[i] = pad[i] ^ 0x5c;
    }
    return sha256(concat([outer, sha256(concat([inner, msg]))]));
  }

  function hkdfExtract(salt, ikm) {
    var s = salt === undefined || salt === null ? new Uint8Array(32) : toBytes(salt, 'salt');
    // RFC 5869 §2.2: an absent salt is a string of HashLen zeros.
    if (s.length === 0) s = new Uint8Array(32);
    return hmacSha256(s, toBytes(ikm, 'ikm'));
  }

  function hkdfExpand(prk, info, length) {
    var len = length === undefined ? 32 : length | 0;
    if (len < 0 || len > 255 * 32) throw new Error('hkdf length out of range');
    var inf = info === undefined || info === null ? new Uint8Array(0) : toBytes(info, 'info');
    var out = new Uint8Array(len);
    var prev = new Uint8Array(0);
    var off = 0, counter = 1;
    while (off < len) {
      prev = hmacSha256(prk, concat([prev, inf, new Uint8Array([counter])]));
      var take = Math.min(32, len - off);
      out.set(prev.subarray(0, take), off);
      off += take;
      counter++;
    }
    return out;
  }

  function hkdf(ikm, salt, info, length) {
    return hkdfExpand(hkdfExtract(salt, ikm), info, length);
  }

  // --- Curve25519 field arithmetic -------------------------------------------
  // Elements are 16 limbs of 16 bits over Z/(2^255-19), the representation used
  // by TweetNaCl: products of two limbs stay well inside the exact range of a
  // double, so the whole field is branch-free and allocation-light. Both X25519
  // and Ed25519 are built on this.

  function gf(init) {
    var r = new Float64Array(16);
    if (init) for (var i = 0; i < init.length; i++) r[i] = init[i];
    return r;
  }

  var gf0 = gf();
  var gf1 = gf([1]);
  var gf121665 = gf([0xdb41, 1]);

  function set25519(r, a) {
    for (var i = 0; i < 16; i++) r[i] = a[i] | 0;
  }

  function car25519(o) {
    var c = 1;
    for (var i = 0; i < 16; i++) {
      var v = o[i] + c + 65535;
      c = Math.floor(v / 65536);
      o[i] = v - c * 65536;
    }
    o[0] += c - 1 + 37 * (c - 1);
  }

  /** Constant-time conditional swap of two field elements. */
  function sel25519(p, q, b) {
    var c = ~(b - 1);
    for (var i = 0; i < 16; i++) {
      var t = c & (p[i] ^ q[i]);
      p[i] ^= t;
      q[i] ^= t;
    }
  }

  function pack25519(o, n) {
    var i, j, b;
    var m = gf(), t = gf();
    for (i = 0; i < 16; i++) t[i] = n[i];
    car25519(t); car25519(t); car25519(t);
    // Two conditional subtractions of p bring the value into [0, p).
    for (j = 0; j < 2; j++) {
      m[0] = t[0] - 0xffed;
      for (i = 1; i < 15; i++) {
        m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
        m[i - 1] &= 0xffff;
      }
      m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
      b = (m[15] >> 16) & 1;
      m[14] &= 0xffff;
      sel25519(t, m, 1 - b);
    }
    for (i = 0; i < 16; i++) {
      o[2 * i] = t[i] & 0xff;
      o[2 * i + 1] = t[i] >> 8;
    }
  }

  function unpack25519(o, n) {
    for (var i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
    o[15] &= 0x7fff;
  }

  function fadd(o, a, b) { for (var i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
  function fsub(o, a, b) { for (var i = 0; i < 16; i++) o[i] = a[i] - b[i]; }

  function fmul(o, a, b) {
    var t = new Float64Array(31), i, j;
    for (i = 0; i < 16; i++) {
      for (j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
    }
    // 2^256 == 38 (mod 2^255-19), so the high half folds back with factor 38.
    for (i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
    for (i = 0; i < 16; i++) o[i] = t[i];
    car25519(o);
    car25519(o);
  }

  function fsqr(o, a) { fmul(o, a, a); }

  /** o = 1/i, by Fermat: i^(p-2). The skipped squarings encode p-2's bits. */
  function inv25519(o, i) {
    var c = gf(), a;
    for (a = 0; a < 16; a++) c[a] = i[a];
    for (a = 253; a >= 0; a--) {
      fsqr(c, c);
      if (a !== 2 && a !== 4) fmul(c, c, i);
    }
    for (a = 0; a < 16; a++) o[a] = c[a];
  }

  /** o = i^((p-5)/8), the exponent used to take square roots mod p. */
  function pow2523(o, i) {
    var c = gf(), a;
    for (a = 0; a < 16; a++) c[a] = i[a];
    for (a = 250; a >= 0; a--) {
      fsqr(c, c);
      if (a !== 1) fmul(c, c, i);
    }
    for (a = 0; a < 16; a++) o[a] = c[a];
  }

  function fverify32(x, y) {
    var d = 0;
    for (var i = 0; i < 32; i++) d |= x[i] ^ y[i];
    return (1 & ((d - 1) >>> 8)) - 1; // 0 when equal, -1 otherwise
  }

  function neq25519(a, b) {
    var c = new Uint8Array(32), d = new Uint8Array(32);
    pack25519(c, a);
    pack25519(d, b);
    return fverify32(c, d);
  }

  function par25519(a) {
    var d = new Uint8Array(32);
    pack25519(d, a);
    return d[0] & 1;
  }

  // Curve constants, derived rather than transcribed. d = -121665/121666 and
  // the base point's y = 4/5 are the definitions in RFC 8032 §5.1; x follows
  // from the curve equation. A wrong limb here would be invisible until a
  // signature failed to verify somewhere else entirely.
  var D = gf(), D2 = gf(), SQRTM1 = gf(), BX = gf(), BY = gf();
  (function initCurve() {
    var num = gf(), den = gf(), t = gf(), chk = gf();
    set25519(num, gf121665);
    fsub(t, gf0, num);                  // -121665
    fadd(den, num, gf1);                // 121666
    inv25519(den, den);
    fmul(D, t, den);
    fadd(D2, D, D);

    // sqrt(-1) = 2^((p-1)/4): p is 5 mod 8, so 2 is a non-residue and that power
    // is a square root of -1. pow2523 gives x^((p-5)/8), and squaring it then
    // multiplying by x once more lands on the exponent (p-1)/4.
    var two = gf([2]), minus1 = gf();
    fsub(minus1, gf0, gf1);
    pow2523(t, two);
    fsqr(SQRTM1, t);
    fmul(SQRTM1, SQRTM1, two);
    fsqr(chk, SQRTM1);
    if (neq25519(chk, minus1)) throw new Error('curve init: sqrt(-1) is wrong');

    // y = 4/5
    var four = gf([4]), five = gf([5]);
    inv25519(t, five);
    fmul(BY, four, t);
    // x^2 = (y^2 - 1) / (d*y^2 + 1)
    var y2 = gf(), n2 = gf(), d2 = gf();
    fsqr(y2, BY);
    fsub(n2, y2, gf1);
    fmul(d2, D, y2);
    fadd(d2, d2, gf1);
    inv25519(d2, d2);
    fmul(t, n2, d2);
    // sqrt via x = t^((p+3)/8), corrected by sqrt(-1) when needed
    pow2523(BX, t);
    fmul(BX, BX, t);
    fsqr(chk, BX);
    if (neq25519(chk, t)) fmul(BX, BX, SQRTM1);
    fsqr(chk, BX);
    if (neq25519(chk, t)) throw new Error('curve init: base point x has no root');
    if (par25519(BX) !== 0) fsub(BX, gf0, BX); // RFC 8032 base point has even x
  })();

  // --- X25519 (RFC 7748) -----------------------------------------------------

  /**
   * Montgomery ladder scalar multiplication. The scalar is clamped per RFC 7748
   * §5, so callers may pass raw 32 bytes.
   */
  function x25519Raw(scalar, point) {
    var n = toBytes(scalar, 'scalar');
    var p = toBytes(point, 'point');
    if (n.length !== 32) throw new Error('x25519 scalar must be 32 bytes');
    if (p.length !== 32) throw new Error('x25519 point must be 32 bytes');
    var z = new Uint8Array(32);
    var x = new Float64Array(80);
    var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
    var i, r;
    for (i = 0; i < 31; i++) z[i] = n[i];
    z[31] = (n[31] & 127) | 64;
    z[0] &= 248;
    unpack25519(x, p);
    for (i = 0; i < 16; i++) {
      b[i] = x[i];
      d[i] = a[i] = c[i] = 0;
    }
    a[0] = d[0] = 1;
    for (i = 254; i >= 0; --i) {
      r = (z[i >>> 3] >>> (i & 7)) & 1;
      sel25519(a, b, r);
      sel25519(c, d, r);
      fadd(e, a, c);
      fsub(a, a, c);
      fadd(c, b, d);
      fsub(b, b, d);
      fsqr(d, e);
      fsqr(f, a);
      fmul(a, c, a);
      fmul(c, b, e);
      fadd(e, a, c);
      fsub(a, a, c);
      fsqr(b, a);
      fsub(c, d, f);
      fmul(a, c, gf121665);
      fadd(a, a, d);
      fmul(c, c, a);
      fmul(a, d, f);
      fmul(d, b, x);
      fsqr(b, e);
      sel25519(a, b, r);
      sel25519(c, d, r);
    }
    for (i = 0; i < 16; i++) {
      x[i + 16] = a[i];
      x[i + 32] = c[i];
      x[i + 48] = b[i];
      x[i + 64] = d[i];
    }
    var x32 = x.subarray(32);
    var x16 = x.subarray(16);
    inv25519(x32, x32);
    fmul(x16, x16, x32);
    var q = new Uint8Array(32);
    pack25519(q, x16);
    return q;
  }

  var X25519_BASE = (function () {
    var b = new Uint8Array(32);
    b[0] = 9;
    return b;
  })();

  function x25519Base(scalar) {
    return x25519Raw(scalar, X25519_BASE);
  }

  // --- Ed25519 (RFC 8032) ----------------------------------------------------
  // Points are (X, Y, Z, T) in extended coordinates. The group order L bounds
  // every scalar; it is the one large constant here that has no cheap
  // derivation, so the RFC 8032 vectors are what confirm it.

  var L = new Float64Array([
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
    0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10
  ]);

  function newPoint() {
    return [gf(), gf(), gf(), gf()];
  }

  /** Unified Edwards addition, p += q. */
  function edAdd(p, q) {
    var a = gf(), b = gf(), c = gf(), d = gf();
    var e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
    fsub(a, p[1], p[0]);
    fsub(t, q[1], q[0]);
    fmul(a, a, t);
    fadd(b, p[0], p[1]);
    fadd(t, q[0], q[1]);
    fmul(b, b, t);
    fmul(c, p[3], q[3]);
    fmul(c, c, D2);
    fmul(d, p[2], q[2]);
    fadd(d, d, d);
    fsub(e, b, a);
    fsub(f, d, c);
    fadd(g, d, c);
    fadd(h, b, a);
    fmul(p[0], e, f);
    fmul(p[1], h, g);
    fmul(p[2], g, f);
    fmul(p[3], e, h);
  }

  function edSwap(p, q, b) {
    for (var i = 0; i < 4; i++) sel25519(p[i], q[i], b);
  }

  function edPack(r, p) {
    var tx = gf(), ty = gf(), zi = gf();
    inv25519(zi, p[2]);
    fmul(tx, p[0], zi);
    fmul(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= par25519(tx) << 7;
  }

  /** Montgomery-style ladder: every bit does the same work either way. */
  function edScalarMul(p, q, s) {
    set25519(p[0], gf0);
    set25519(p[1], gf1);
    set25519(p[2], gf1);
    set25519(p[3], gf0);
    for (var i = 255; i >= 0; --i) {
      var b = (s[(i / 8) | 0] >> (i & 7)) & 1;
      edSwap(p, q, b);
      edAdd(q, p);
      edAdd(p, p);
      edSwap(p, q, b);
    }
  }

  function edScalarBase(p, s) {
    var q = newPoint();
    set25519(q[0], BX);
    set25519(q[1], BY);
    set25519(q[2], gf1);
    fmul(q[3], BX, BY);
    edScalarMul(p, q, s);
  }

  /** Reduces a 64-byte little-endian scalar mod L, in place into r. */
  function modL(r, x) {
    var carry, i, j, k;
    for (i = 63; i >= 32; --i) {
      carry = 0;
      for (j = i - 32, k = i - 12; j < k; ++j) {
        x[j] += carry - 16 * x[i] * L[j - (i - 32)];
        carry = Math.floor((x[j] + 128) / 256);
        x[j] -= carry * 256;
      }
      x[j] += carry;
      x[i] = 0;
    }
    carry = 0;
    for (j = 0; j < 32; j++) {
      x[j] += carry - (x[31] >> 4) * L[j];
      carry = x[j] >> 8;
      x[j] &= 255;
    }
    for (j = 0; j < 32; j++) x[j] -= carry * L[j];
    for (i = 0; i < 32; i++) {
      x[i + 1] += x[i] >> 8;
      r[i] = x[i] & 255;
    }
  }

  function reduceScalar(r) {
    var x = new Float64Array(64), i;
    for (i = 0; i < 64; i++) x[i] = r[i];
    for (i = 0; i < 64; i++) r[i] = 0;
    modL(r, x);
  }

  /**
   * Decompresses a public key into -P (the negation is what the verify equation
   * wants). Returns false for any encoding that is not a point on the curve,
   * which includes most random 32-byte strings.
   */
  function edUnpackNeg(r, pk) {
    var t = gf(), chk = gf(), num = gf(), den = gf();
    var den2 = gf(), den4 = gf(), den6 = gf();
    set25519(r[2], gf1);
    unpack25519(r[1], pk);
    fsqr(num, r[1]);
    fmul(den, num, D);
    fsub(num, num, r[2]);
    fadd(den, r[2], den);
    fsqr(den2, den);
    fsqr(den4, den2);
    fmul(den6, den4, den2);
    fmul(t, den6, num);
    fmul(t, t, den);
    pow2523(t, t);
    fmul(t, t, num);
    fmul(t, t, den);
    fmul(t, t, den);
    fmul(r[0], t, den);
    fsqr(chk, r[0]);
    fmul(chk, chk, den);
    if (neq25519(chk, num)) fmul(r[0], r[0], SQRTM1);
    fsqr(chk, r[0]);
    fmul(chk, chk, den);
    if (neq25519(chk, num)) return false;
    if (par25519(r[0]) === (pk[31] >> 7)) fsub(r[0], gf0, r[0]);
    fmul(r[3], r[0], r[1]);
    return true;
  }

  /** Expands a 32-byte seed into the scalar and the prefix RFC 8032 §5.1.5 uses. */
  function ed25519Expand(seed) {
    var h = sha512(seed);
    h[0] &= 248;
    h[31] &= 127;
    h[31] |= 64;
    return h;
  }

  function ed25519PublicFromSeed(seed) {
    var h = ed25519Expand(seed);
    var p = newPoint();
    edScalarBase(p, h.subarray(0, 32));
    var pk = new Uint8Array(32);
    edPack(pk, p);
    return pk;
  }

  function ed25519SignJs(seed, message) {
    var h = ed25519Expand(seed);
    var pk = ed25519PublicFromSeed(seed);
    var i, j;

    var r = sha512(concat([h.subarray(32, 64), message]));
    reduceScalar(r);
    var p = newPoint();
    edScalarBase(p, r);
    var sig = new Uint8Array(64);
    edPack(sig, p);

    var k = sha512(concat([sig.subarray(0, 32), pk, message]));
    reduceScalar(k);

    // S = r + k*a mod L
    var x = new Float64Array(64);
    for (i = 0; i < 32; i++) x[i] = r[i];
    for (i = 0; i < 32; i++) {
      for (j = 0; j < 32; j++) x[i + j] += k[i] * h[j];
    }
    modL(sig.subarray(32), x);
    return sig;
  }

  function ed25519VerifyJs(publicKey, message, signature) {
    var pk = toBytes(publicKey, 'publicKey');
    var sig = toBytes(signature, 'signature');
    if (pk.length !== 32 || sig.length !== 64) return false;
    // RFC 8032 §5.1.7 requires S < L; without this check a signature can be
    // mauled into a second valid encoding of the same message.
    if (!scalarIsCanonical(sig.subarray(32))) return false;

    var q = newPoint();
    if (!edUnpackNeg(q, pk)) return false;

    var k = sha512(concat([sig.subarray(0, 32), pk, toBytes(message, 'message')]));
    reduceScalar(k);

    var p = newPoint();
    edScalarMul(p, q, k);
    var q2 = newPoint();
    edScalarBase(q2, sig.subarray(32));
    edAdd(p, q2);

    var t = new Uint8Array(32);
    edPack(t, p);
    return fverify32(sig, t) === 0;
  }

  /** True when a 32-byte little-endian scalar is strictly below the group order. */
  function scalarIsCanonical(s) {
    for (var i = 31; i >= 0; i--) {
      if (s[i] > L[i]) return false;
      if (s[i] < L[i]) return true;
    }
    return false; // exactly L is not canonical either
  }

  // --- ChaCha20 and Poly1305 (RFC 8439) --------------------------------------
  // No browser exposes ChaCha20-Poly1305 through WebCrypto, so this one is pure
  // JS everywhere. AES-256-GCM is offered alongside it for platforms that have
  // hardware AES; see aeadSeal's suite argument.

  function rotl32(v, n) {
    return ((v << n) | (v >>> (32 - n))) >>> 0;
  }

  function chachaBlock(key, nonce, counter, out) {
    var x = new Uint32Array(16), s = new Uint32Array(16), i;
    // "expand 32-byte k"
    x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574;
    for (i = 0; i < 8; i++) {
      x[4 + i] = (key[4 * i] | (key[4 * i + 1] << 8) |
        (key[4 * i + 2] << 16) | (key[4 * i + 3] << 24)) >>> 0;
    }
    x[12] = counter >>> 0;
    for (i = 0; i < 3; i++) {
      x[13 + i] = (nonce[4 * i] | (nonce[4 * i + 1] << 8) |
        (nonce[4 * i + 2] << 16) | (nonce[4 * i + 3] << 24)) >>> 0;
    }
    s.set(x);

    function quarter(a, b, c, d) {
      s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
      s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
      s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
      s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
    }

    for (i = 0; i < 10; i++) {
      quarter(0, 4, 8, 12); quarter(1, 5, 9, 13);
      quarter(2, 6, 10, 14); quarter(3, 7, 11, 15);
      quarter(0, 5, 10, 15); quarter(1, 6, 11, 12);
      quarter(2, 7, 8, 13); quarter(3, 4, 9, 14);
    }
    for (i = 0; i < 16; i++) {
      var v = (s[i] + x[i]) >>> 0;
      out[4 * i] = v & 0xff;
      out[4 * i + 1] = (v >>> 8) & 0xff;
      out[4 * i + 2] = (v >>> 16) & 0xff;
      out[4 * i + 3] = (v >>> 24) & 0xff;
    }
  }

  function chacha20(key, nonce, counter, input) {
    var out = new Uint8Array(input.length);
    var block = new Uint8Array(64);
    for (var off = 0; off < input.length; off += 64) {
      chachaBlock(key, nonce, counter + (off / 64), block);
      var take = Math.min(64, input.length - off);
      for (var i = 0; i < take; i++) out[off + i] = input[off + i] ^ block[i];
    }
    return out;
  }

  // Poly1305 over 10 limbs of 13 bits. 130 bits is exactly 10 limbs, so the
  // reduction 2^130 == 5 folds limb i+10 straight back into limb i, and every
  // partial product stays far inside the exact integer range of a double.

  function polyLimbs(bytes, off, hibit, out) {
    var acc = 0, nbits = 0, li = 0;
    for (var i = 0; i < 16; i++) {
      var byte = off + i < bytes.length ? bytes[off + i] : 0;
      acc |= byte << nbits;
      nbits += 8;
      if (nbits >= 13) {
        out[li++] = acc & 0x1fff;
        acc >>>= 13;
        nbits -= 13;
      }
    }
    // 128 bits in, 117 emitted: the remaining 11 sit in limb 9, whose bit 11 is
    // the 2^128 term the RFC appends to every full block.
    out[9] = acc | (hibit ? (1 << 11) : 0);
  }

  function polyMulReduce(h, r) {
    var t = new Float64Array(19), i, j;
    for (i = 0; i < 10; i++) {
      for (j = 0; j < 10; j++) t[i + j] += h[i] * r[j];
    }
    for (i = 0; i < 9; i++) t[i] += 5 * t[i + 10];
    var carry = 0;
    for (i = 0; i < 10; i++) {
      var v = t[i] + carry;
      carry = Math.floor(v / 8192);
      h[i] = v - carry * 8192;
    }
    h[0] += 5 * carry;
    carry = 0;
    for (i = 0; i < 10; i++) {
      var w = h[i] + carry;
      carry = Math.floor(w / 8192);
      h[i] = w - carry * 8192;
    }
    h[0] += 5 * carry;
  }

  function poly1305(key, message) {
    var r = new Float64Array(10), h = new Float64Array(10), blk = new Float64Array(10);
    var i;
    // Clamp per RFC 8439 §2.5: r &= 0x0ffffffc0ffffffc0ffffffc0fffffff.
    var rb = new Uint8Array(16);
    rb.set(key.subarray(0, 16));
    rb[3] &= 15; rb[7] &= 15; rb[11] &= 15; rb[15] &= 15;
    rb[4] &= 252; rb[8] &= 252; rb[12] &= 252;
    polyLimbs(rb, 0, 0, r);

    var full = Math.floor(message.length / 16) * 16;
    for (var off = 0; off < full; off += 16) {
      polyLimbs(message, off, 1, blk);
      for (i = 0; i < 10; i++) h[i] += blk[i];
      polyMulReduce(h, r);
    }
    var rem = message.length - full;
    if (rem > 0) {
      var tail = new Uint8Array(16);
      tail.set(message.subarray(full));
      tail[rem] = 1; // the partial block's own 2^(8*rem) terminator
      polyLimbs(tail, 0, 0, blk);
      for (i = 0; i < 10; i++) h[i] += blk[i];
      polyMulReduce(h, r);
    }

    // Final conditional subtraction of p = 2^130-5, done branch-free.
    var g = new Float64Array(10), carry = 5;
    for (i = 0; i < 10; i++) {
      var v = h[i] + carry;
      carry = Math.floor(v / 8192);
      g[i] = v - carry * 8192;
    }
    var mask = carry ? -1 : 0; // carry out of bit 129 means h >= p
    for (i = 0; i < 10; i++) h[i] = (h[i] & ~mask) | (g[i] & mask);

    // Serialize the low 128 bits, then add s with a byte-wise carry.
    var out = new Uint8Array(16);
    var acc = 0, nbits = 0, li = 0;
    for (i = 0; i < 16; i++) {
      if (nbits < 8) {
        acc |= h[li++] << nbits;
        nbits += 13;
      }
      out[i] = acc & 0xff;
      acc >>>= 8;
      nbits -= 8;
    }
    var c = 0;
    for (i = 0; i < 16; i++) {
      c += out[i] + key[16 + i];
      out[i] = c & 0xff;
      c >>>= 8;
    }
    return out;
  }

  function pad16(n) {
    return n % 16 === 0 ? 0 : 16 - (n % 16);
  }

  function poly1305AeadInput(aad, ciphertext) {
    var parts = [
      aad, new Uint8Array(pad16(aad.length)),
      ciphertext, new Uint8Array(pad16(ciphertext.length)),
      lengths64(aad.length, ciphertext.length)
    ];
    return concat(parts);
  }

  function lengths64(a, c) {
    var out = new Uint8Array(16);
    var lo = a >>> 0, hi = Math.floor(a / 4294967296);
    out[0] = lo & 255; out[1] = (lo >>> 8) & 255;
    out[2] = (lo >>> 16) & 255; out[3] = (lo >>> 24) & 255;
    out[4] = hi & 255; out[5] = (hi >>> 8) & 255;
    lo = c >>> 0; hi = Math.floor(c / 4294967296);
    out[8] = lo & 255; out[9] = (lo >>> 8) & 255;
    out[10] = (lo >>> 16) & 255; out[11] = (lo >>> 24) & 255;
    out[12] = hi & 255; out[13] = (hi >>> 8) & 255;
    return out;
  }

  function chachaPolyKey(key, nonce) {
    var block = new Uint8Array(64);
    chachaBlock(key, nonce, 0, block);
    return block.subarray(0, 32);
  }

  function chachaPolySeal(key, nonce, plaintext, aad) {
    var ct = chacha20(key, nonce, 1, plaintext);
    var tag = poly1305(chachaPolyKey(key, nonce), poly1305AeadInput(aad, ct));
    return concat([ct, tag]);
  }

  function chachaPolyOpen(key, nonce, sealed, aad) {
    if (sealed.length < TAG_BYTES) return null;
    var ct = sealed.subarray(0, sealed.length - TAG_BYTES);
    var tag = sealed.subarray(sealed.length - TAG_BYTES);
    var expect = poly1305(chachaPolyKey(key, nonce), poly1305AeadInput(aad, ct));
    // Compare before decrypting: unauthenticated plaintext never leaves here.
    if (!timingSafeEqual(new Uint8Array(tag), expect)) return null;
    return chacha20(key, nonce, 1, ct);
  }

  // --- WebCrypto backends ----------------------------------------------------
  // Every public asymmetric operation takes opts.backend: 'auto' (default),
  // 'webcrypto', or 'js'. 'auto' uses the platform when it works and the JS
  // implementation otherwise; the explicit values exist so the test suite can
  // force each path rather than testing whichever one happens to be present.

  var subtle = (function () {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    return g && g.crypto && g.crypto.subtle ? g.crypto.subtle : null;
  })();

  // PKCS#8 wrappers for a bare 32-byte seed. The OIDs are 1.3.101.112 (Ed25519)
  // and 1.3.101.110 (X25519); importKey('pkcs8') is the only way to hand
  // WebCrypto a private key we generated ourselves.
  var PKCS8_ED = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
    0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  var PKCS8_X = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
    0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

  function pkcs8(prefix, seed) {
    return concat([new Uint8Array(prefix), seed]);
  }

  var capsPromise = null;

  /**
   * What this platform's WebCrypto actually does, established by running each
   * operation once rather than by sniffing versions. Cached.
   */
  function capabilities() {
    if (capsPromise) return capsPromise;
    if (!subtle) {
      capsPromise = Promise.resolve({
        subtle: false, ed25519: false, x25519: false, hkdf: false, aesGcm: false
      });
      return capsPromise;
    }
    function works(fn) {
      try {
        return Promise.resolve(fn()).then(function () { return true; },
          function () { return false; });
      } catch (e) {
        return Promise.resolve(false);
      }
    }
    capsPromise = Promise.all([
      works(function () {
        return subtle.importKey('raw', new Uint8Array(32), { name: 'Ed25519' }, true, ['verify']);
      }),
      works(function () {
        return subtle.importKey('pkcs8', pkcs8(PKCS8_X, new Uint8Array(32)),
          { name: 'X25519' }, true, ['deriveBits']);
      }),
      works(function () {
        return subtle.importKey('raw', new Uint8Array(32), { name: 'HKDF' }, false, ['deriveBits']);
      }),
      works(function () {
        return subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['encrypt']);
      })
    ]).then(function (r) {
      return { subtle: true, ed25519: r[0], x25519: r[1], hkdf: r[2], aesGcm: r[3] };
    });
    return capsPromise;
  }

  function pickBackend(opts, feature) {
    var want = (opts && opts.backend) || 'auto';
    if (want === 'js') return Promise.resolve('js');
    return capabilities().then(function (caps) {
      if (want === 'webcrypto') {
        if (!caps[feature]) throw new Error('WebCrypto has no ' + feature + ' on this platform');
        return 'webcrypto';
      }
      return caps[feature] ? 'webcrypto' : 'js';
    });
  }

  // --- Ed25519 public API ----------------------------------------------------

  /**
   * A key pair for demos and tests. The private key is the 32-byte seed of
   * RFC 8032; publicKey is its compressed point.
   */
  function generateKeyPair(seed) {
    var s = seed === undefined ? randomBytes(32) : toBytes(seed, 'seed');
    if (s.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
    return { privateKey: new Uint8Array(s), publicKey: ed25519PublicFromSeed(s) };
  }

  function normalizeSeed(privateKey) {
    var sk = toBytes(privateKey, 'privateKey');
    // Accept the 64-byte seed||public form some libraries hand out.
    if (sk.length === 64) return sk.subarray(0, 32);
    if (sk.length !== 32) throw new Error('ed25519 private key must be 32 or 64 bytes');
    return sk;
  }

  function sign(privateKey, message, opts) {
    var seed = normalizeSeed(privateKey);
    var msg = toBytes(message, 'message');
    return pickBackend(opts, 'ed25519').then(function (backend) {
      if (backend === 'js') return ed25519SignJs(seed, msg);
      return subtle.importKey('pkcs8', pkcs8(PKCS8_ED, seed), { name: 'Ed25519' }, false, ['sign'])
        .then(function (key) { return subtle.sign({ name: 'Ed25519' }, key, msg); })
        .then(function (sig) { return new Uint8Array(sig); });
    });
  }

  /**
   * Never throws for bad keys or signatures — a malformed public key is a
   * verification failure, not an exception, because both arrive from a camera.
   */
  function verify(publicKey, message, signature, opts) {
    var pk, msg, sig;
    try {
      pk = toBytes(publicKey, 'publicKey');
      msg = toBytes(message, 'message');
      sig = toBytes(signature, 'signature');
    } catch (e) {
      return Promise.resolve(false);
    }
    if (pk.length !== 32 || sig.length !== SIG_BYTES) return Promise.resolve(false);
    return pickBackend(opts, 'ed25519').then(function (backend) {
      if (backend === 'js') return ed25519VerifyJs(pk, msg, sig);
      // WebCrypto is stricter than some JS implementations about non-canonical
      // S values; the JS path rejects those too (see scalarIsCanonical).
      return subtle.importKey('raw', pk, { name: 'Ed25519' }, false, ['verify'])
        .then(function (key) { return subtle.verify({ name: 'Ed25519' }, key, sig, msg); })
        .then(function (ok) { return ok === true; }, function () { return false; });
    }, function () { return false; });
  }

  // --- key pinning -----------------------------------------------------------

  /**
   * The first 8 bytes of SHA-256(publicKey), grouped for reading aloud. This is
   * what a user compares out-of-band; 64 bits is short enough to check by eye
   * and long enough that producing a collision is not a laptop-scale attack.
   */
  function fingerprint(publicKey) {
    var pk = toBytes(publicKey, 'publicKey');
    var hex = toHex(sha256(pk).subarray(0, 8));
    return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' +
      hex.slice(8, 12) + '-' + hex.slice(12, 16);
  }

  function normalizeFingerprint(value) {
    return String(value === undefined || value === null ? '' : value)
      .toLowerCase().replace(/[^0-9a-f]/g, '');
  }

  /** Compares fingerprints in either grouped or bare form, without early exit. */
  function fingerprintEqual(a, b) {
    var x = normalizeFingerprint(a), y = normalizeFingerprint(b);
    if (x.length !== 16 || y.length !== 16) return false;
    var diff = 0;
    for (var i = 0; i < 16; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  }

  function matchesPin(publicKey, pinned) {
    try {
      return fingerprintEqual(fingerprint(publicKey), pinned);
    } catch (e) {
      return false;
    }
  }

  // --- AEAD suites -----------------------------------------------------------
  // ChaCha20-Poly1305 is the default because it is the only one available on
  // every platform. AES-256-GCM is offered where WebCrypto provides it, since
  // hardware AES is both faster and constant-time in a way JS cannot be.

  var SUITE_CHACHA = 'chacha20-poly1305';
  var SUITE_AESGCM = 'aes-256-gcm';

  function aeadSeal(key, nonce, plaintext, aad, opts) {
    var k, n, pt, ad;
    try {
      k = toBytes(key, 'key');
      n = toBytes(nonce, 'nonce');
      pt = toBytes(plaintext, 'plaintext');
      ad = aad === undefined || aad === null ? new Uint8Array(0) : toBytes(aad, 'aad');
    } catch (e) {
      return Promise.reject(e);
    }
    if (k.length !== KEY_BYTES) return Promise.reject(new Error('aead key must be 32 bytes'));
    if (n.length !== NONCE_BYTES) return Promise.reject(new Error('aead nonce must be 12 bytes'));
    if (pt.length > MAX_AEAD_BYTES) return Promise.reject(new Error('plaintext too large'));
    var suite = (opts && opts.suite) || SUITE_CHACHA;
    if (suite === SUITE_CHACHA) return Promise.resolve(chachaPolySeal(k, n, pt, ad));
    if (suite !== SUITE_AESGCM) return Promise.reject(new Error('unknown aead suite: ' + suite));
    return capabilities().then(function (caps) {
      if (!caps.aesGcm) throw new Error('AES-GCM unavailable on this platform');
      return subtle.importKey('raw', k, { name: 'AES-GCM' }, false, ['encrypt'])
        .then(function (ck) {
          return subtle.encrypt(
            { name: 'AES-GCM', iv: n, additionalData: ad, tagLength: 128 }, ck, pt);
        })
        .then(function (buf) { return new Uint8Array(buf); });
    });
  }

  /** Resolves to the plaintext, or to null if authentication fails. */
  function aeadOpen(key, nonce, sealed, aad, opts) {
    var k, n, ct, ad;
    try {
      k = toBytes(key, 'key');
      n = toBytes(nonce, 'nonce');
      ct = toBytes(sealed, 'sealed');
      ad = aad === undefined || aad === null ? new Uint8Array(0) : toBytes(aad, 'aad');
    } catch (e) {
      return Promise.resolve(null);
    }
    if (k.length !== KEY_BYTES || n.length !== NONCE_BYTES) return Promise.resolve(null);
    if (ct.length < TAG_BYTES || ct.length > MAX_AEAD_BYTES + TAG_BYTES) {
      return Promise.resolve(null);
    }
    var suite = (opts && opts.suite) || SUITE_CHACHA;
    if (suite === SUITE_CHACHA) return Promise.resolve(chachaPolyOpen(k, n, ct, ad));
    if (suite !== SUITE_AESGCM) return Promise.resolve(null);
    return capabilities().then(function (caps) {
      if (!caps.aesGcm) return null;
      return subtle.importKey('raw', k, { name: 'AES-GCM' }, false, ['decrypt'])
        .then(function (ck) {
          return subtle.decrypt(
            { name: 'AES-GCM', iv: n, additionalData: ad, tagLength: 128 }, ck, ct);
        })
        .then(function (buf) { return new Uint8Array(buf); }, function () { return null; });
    });
  }

  // --- canonical manifest encoding -------------------------------------------
  // A signature has to cover a byte string, and JSON.stringify is not one: key
  // order, whitespace and number formatting are all free variables. This
  // encoding fixes the field order by schema index, gives every value an
  // explicit type and width, and refuses anything it does not recognise. A
  // manifest carrying an unknown key is rejected rather than having it silently
  // dropped — dropping it would sign less than the receiver goes on to act on.

  var MANIFEST_MAGIC = [0x72, 0x76, 0x71, 0x72, 0x2d, 0x6d, 0x31, 0x00]; // "rvqr-m1\0"

  var MANIFEST_FIELDS = [
    { key: 'name', type: 'str', required: true },
    { key: 'size', type: 'u53', required: true },
    { key: 'sha256', type: 'hex', bytes: 32, required: true },
    { key: 'chunk', type: 'u32', required: true },
    { key: 'transferId', type: 'hex', bytes: 4, required: false },
    { key: 'total', type: 'u32', required: false },
    { key: 'createdAt', type: 'u53', required: false },
    { key: 'sessionId', type: 'hex', bytes: 8, required: false },
    { key: 'codecs', type: 'u32', required: false }
  ];

  var TYPE_CODE = { str: 1, u32: 2, u53: 3, hex: 4 };

  function utf8Encode(str) {
    if (typeof TextEncoder === 'undefined') throw new Error('TextEncoder unavailable');
    return new TextEncoder().encode(str);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'undefined') throw new Error('TextDecoder unavailable');
    // fatal:true so invalid UTF-8 is an error rather than a run of U+FFFD that
    // would re-encode differently and quietly fail the canonicity check.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function u32be(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  function u53be(n) {
    return concat([u32be(Math.floor(n / 4294967296)), u32be(n >>> 0)]);
  }

  function readU32be(b, off) {
    return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
  }

  function encodeManifestField(field, value) {
    if (field.type === 'str') {
      if (typeof value !== 'string' || !value.length || value.length > MAX_NAME_LENGTH) {
        throw new Error(field.key + ': expected a string of 1..' + MAX_NAME_LENGTH);
      }
      if (/[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(field.key + ': control characters are not encodable');
      }
      return utf8Encode(value);
    }
    if (field.type === 'hex') {
      var pattern = new RegExp('^[0-9a-f]{' + field.bytes * 2 + '}$');
      if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(field.key + ': expected ' + field.bytes * 2 + ' lowercase hex characters');
      }
      return fromHex(value);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(field.key + ': expected a non-negative integer');
    }
    if (field.type === 'u32') {
      if (value > 4294967295) throw new Error(field.key + ': exceeds 32 bits');
      return u32be(value);
    }
    if (value > Number.MAX_SAFE_INTEGER) throw new Error(field.key + ': exceeds 2^53-1');
    return u53be(value);
  }

  /**
   * Stable bytes for a manifest. Reordering the keys of the input object cannot
   * change the output; an unrecognised key is an error rather than a silent
   * omission.
   */
  function canonicalManifestBytes(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest must be an object');
    }
    var known = Object.create(null), i;
    for (i = 0; i < MANIFEST_FIELDS.length; i++) known[MANIFEST_FIELDS[i].key] = true;
    var keys = Object.keys(manifest);
    for (i = 0; i < keys.length; i++) {
      if (manifest[keys[i]] === undefined) continue;
      if (!known[keys[i]]) throw new Error('unknown manifest field: ' + keys[i]);
    }

    var body = [];
    for (i = 0; i < MANIFEST_FIELDS.length; i++) {
      var field = MANIFEST_FIELDS[i];
      var value = manifest[field.key];
      if (value === undefined || value === null) {
        if (field.required) throw new Error('missing required manifest field: ' + field.key);
        continue;
      }
      var encoded = encodeManifestField(field, value);
      if (encoded.length > 65535) throw new Error(field.key + ': value too long');
      body.push(concat([
        new Uint8Array([
          i, TYPE_CODE[field.type], (encoded.length >>> 8) & 255, encoded.length & 255
        ]),
        encoded
      ]));
    }
    var head = [new Uint8Array(MANIFEST_MAGIC), new Uint8Array([body.length])];
    var out = concat(head.concat(body));
    if (out.length > MAX_MANIFEST_BYTES) throw new Error('encoded manifest too large');
    return out;
  }

  /**
   * Inverse of canonicalManifestBytes. Never throws. Rejects any encoding that
   * is not the one canonicalManifestBytes would have produced: duplicate or
   * out-of-order tags, wrong widths, trailing bytes.
   */
  function decodeCanonicalManifest(bytes) {
    var b;
    try {
      b = toBytes(bytes, 'bytes');
    } catch (e) {
      return { ok: false, reason: 'not-bytes' };
    }
    if (b.length > MAX_MANIFEST_BYTES) return { ok: false, reason: 'too-large' };
    if (b.length < MANIFEST_MAGIC.length + 1) return { ok: false, reason: 'too-short' };
    for (var i = 0; i < MANIFEST_MAGIC.length; i++) {
      if (b[i] !== MANIFEST_MAGIC[i]) return { ok: false, reason: 'bad-magic' };
    }
    var off = MANIFEST_MAGIC.length;
    var count = b[off++];
    if (count > MANIFEST_FIELDS.length) return { ok: false, reason: 'too-many-fields' };

    var manifest = {};
    var lastTag = -1;
    for (var f = 0; f < count; f++) {
      if (off + 4 > b.length) return { ok: false, reason: 'truncated-field' };
      var tag = b[off], type = b[off + 1];
      var len = (b[off + 2] << 8) | b[off + 3];
      off += 4;
      if (tag >= MANIFEST_FIELDS.length) return { ok: false, reason: 'unknown-field' };
      if (tag <= lastTag) return { ok: false, reason: 'field-order' };
      lastTag = tag;
      if (off + len > b.length) return { ok: false, reason: 'truncated-value' };
      var field = MANIFEST_FIELDS[tag];
      if (type !== TYPE_CODE[field.type]) return { ok: false, reason: 'field-type' };
      var value = b.subarray(off, off + len);
      off += len;
      try {
        if (field.type === 'str') {
          manifest[field.key] = utf8Decode(value);
        } else if (field.type === 'hex') {
          if (len !== field.bytes) return { ok: false, reason: 'field-width' };
          manifest[field.key] = toHex(value);
        } else if (field.type === 'u32') {
          if (len !== 4) return { ok: false, reason: 'field-width' };
          manifest[field.key] = readU32be(value, 0);
        } else {
          if (len !== 8) return { ok: false, reason: 'field-width' };
          manifest[field.key] = readU32be(value, 0) * 4294967296 + readU32be(value, 4);
        }
      } catch (e) {
        return { ok: false, reason: 'bad-value' };
      }
    }
    if (off !== b.length) return { ok: false, reason: 'trailing-bytes' };

    // Decoding succeeded; canonicity is whether re-encoding is byte-identical.
    var re;
    try {
      re = canonicalManifestBytes(manifest);
    } catch (e) {
      return { ok: false, reason: 'not-canonical' };
    }
    if (!timingSafeEqual(re, b)) return { ok: false, reason: 'not-canonical' };
    return { ok: true, manifest: manifest };
  }

  function signManifest(privateKey, manifest, opts) {
    var bytes;
    try {
      bytes = canonicalManifestBytes(manifest);
    } catch (e) {
      return Promise.reject(e);
    }
    return sign(privateKey, bytes, opts);
  }

  function verifyManifest(publicKey, manifest, signature, opts) {
    var bytes;
    try {
      bytes = canonicalManifestBytes(manifest);
    } catch (e) {
      return Promise.resolve(false);
    }
    return verify(publicKey, bytes, signature, opts);
  }

  // --- base64url (RFC 4648 §5, unpadded) -------------------------------------
  // Same alphabet as core.js. Duplicated rather than imported so crypto.js has
  // no load-order dependency on core.js in the browser.

  var B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64U_INV = (function () {
    var inv = new Int16Array(128).fill(-1);
    for (var i = 0; i < B64U.length; i++) inv[B64U.charCodeAt(i)] = i;
    return inv;
  })();

  function b64uEncode(bytes) {
    var out = '', i = 0, n;
    for (; i + 2 < bytes.length; i += 3) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] +
        B64U[(n >>> 6) & 63] + B64U[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      n = bytes[i] << 16;
      out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63];
    } else if (rem === 2) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63];
    }
    return out;
  }

  function b64uDecode(str) {
    var len = str.length;
    var full = len >>> 2;
    var rem = len & 3;
    if (rem === 1) throw new Error('invalid base64url length');
    var out = new Uint8Array(full * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0));
    var oi = 0, i = 0, n, c;
    function val(ch) {
      c = ch < 128 ? B64U_INV[ch] : -1;
      if (c < 0) throw new Error('invalid base64url character');
      return c;
    }
    for (var f = 0; f < full; f++, i += 4) {
      n = (val(str.charCodeAt(i)) << 18) | (val(str.charCodeAt(i + 1)) << 12) |
        (val(str.charCodeAt(i + 2)) << 6) | val(str.charCodeAt(i + 3));
      out[oi++] = (n >>> 16) & 255;
      out[oi++] = (n >>> 8) & 255;
      out[oi++] = n & 255;
    }
    if (rem === 2) {
      n = (val(str.charCodeAt(i)) << 18) | (val(str.charCodeAt(i + 1)) << 12);
      out[oi++] = (n >>> 16) & 255;
    } else if (rem === 3) {
      n = (val(str.charCodeAt(i)) << 18) | (val(str.charCodeAt(i + 1)) << 12) |
        (val(str.charCodeAt(i + 2)) << 6);
      out[oi++] = (n >>> 16) & 255;
      out[oi++] = (n >>> 8) & 255;
    }
    return out;
  }

  // --- bootstrap payload -----------------------------------------------------
  // The QR one device shows the other to start a session. Layout, all fixed
  // width so the parser needs no length fields:
  //
  //   0        version (1)
  //   1        codec bitmap, high bit set when a signature follows
  //   2..9     session id (8)
  //   10..41   X25519 ephemeral public key (32)
  //   42..73   Ed25519 identity public key (32)
  //   74..137  Ed25519 signature over bytes 0..73 (optional)
  //
  // 74 bytes unsigned, 138 signed. See bootstrapQrEstimate for what that costs
  // in QR versions.

  var BOOTSTRAP_PREFIX = 'rvqrb1:';
  var BOOTSTRAP_VERSION = 1;
  var BOOTSTRAP_UNSIGNED_BYTES = 74;
  var BOOTSTRAP_SIGNED_BYTES = 138;
  var BOOTSTRAP_SIG_FLAG = 0x80;
  var BOOTSTRAP_SIG_CONTEXT = [
    0x72, 0x76, 0x71, 0x72, 0x62, 0x31, 0x2d, 0x73, 0x69, 0x67, 0x00
  ]; // "rvqrb1-sig\0"

  // Codec bits. The low nibble is AEAD suites, the next two bits are payload
  // codecs; the high bit is reserved for the signature flag above.
  var CODEC_CHACHA20_POLY1305 = 0x01;
  var CODEC_AES256_GCM = 0x02;
  var CODEC_FOUNTAIN = 0x10;
  var CODEC_PLAIN = 0x20;
  var CODEC_MASK = 0x7f;

  function bootstrapSigningInput(payload) {
    return concat([
      new Uint8Array(BOOTSTRAP_SIG_CONTEXT),
      payload.subarray(0, BOOTSTRAP_UNSIGNED_BYTES)
    ]);
  }

  /**
   * Builds the bootstrap bytes. When identityPrivate is supplied the payload is
   * signed, which is what lets a receiver holding a pinned fingerprint reject a
   * substituted ephemeral key.
   */
  function encodeBootstrap(fields, opts) {
    var sessionId = toBytes(fields.sessionId, 'sessionId');
    var x = toBytes(fields.x25519PublicKey, 'x25519PublicKey');
    var ed = toBytes(fields.ed25519PublicKey, 'ed25519PublicKey');
    if (sessionId.length !== 8) throw new Error('sessionId must be 8 bytes');
    if (x.length !== 32) throw new Error('x25519PublicKey must be 32 bytes');
    if (ed.length !== 32) throw new Error('ed25519PublicKey must be 32 bytes');
    var codecs = fields.codecs === undefined ? CODEC_CHACHA20_POLY1305 : fields.codecs | 0;
    if ((codecs & ~CODEC_MASK) !== 0) throw new Error('codec bits out of range');

    var signing = fields.identityPrivateKey !== undefined && fields.identityPrivateKey !== null;
    var head = new Uint8Array([
      BOOTSTRAP_VERSION,
      codecs | (signing ? BOOTSTRAP_SIG_FLAG : 0)
    ]);
    var payload = concat([head, sessionId, x, ed]);
    if (!signing) return Promise.resolve(payload);
    return sign(fields.identityPrivateKey, bootstrapSigningInput(payload), opts)
      .then(function (sig) { return concat([payload, sig]); });
  }

  function encodeBootstrapString(fields, opts) {
    return encodeBootstrap(fields, opts).then(function (payload) {
      return BOOTSTRAP_PREFIX + b64uEncode(payload);
    });
  }

  /**
   * Parses a scanned bootstrap. Never throws: everything here arrives from a
   * camera, so malformed and oversized input is a reason string, not an
   * exception. The signature (if present) is not checked here — that needs a
   * pinned key, so it happens in the session helpers.
   */
  function parseBootstrap(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'not-a-string' };
    if (text.length > MAX_BOOTSTRAP_CHARS) return { ok: false, reason: 'too-long' };
    if (text.slice(0, BOOTSTRAP_PREFIX.length) !== BOOTSTRAP_PREFIX) {
      return { ok: false, reason: 'bad-prefix' };
    }
    var payload;
    try {
      payload = b64uDecode(text.slice(BOOTSTRAP_PREFIX.length));
    } catch (e) {
      return { ok: false, reason: 'bad-base64' };
    }
    var signed = payload.length === BOOTSTRAP_SIGNED_BYTES;
    if (!signed && payload.length !== BOOTSTRAP_UNSIGNED_BYTES) {
      return { ok: false, reason: 'bad-length' };
    }
    if (payload[0] !== BOOTSTRAP_VERSION) return { ok: false, reason: 'bad-version' };
    var flags = payload[1];
    if (((flags & BOOTSTRAP_SIG_FLAG) !== 0) !== signed) {
      return { ok: false, reason: 'signature-flag-mismatch' };
    }
    return {
      ok: true,
      bootstrap: {
        version: payload[0],
        codecs: flags & CODEC_MASK,
        sessionId: payload.subarray(2, 10),
        x25519PublicKey: payload.subarray(10, 42),
        ed25519PublicKey: payload.subarray(42, 74),
        signature: signed ? payload.subarray(74, 138) : null,
        signingInput: bootstrapSigningInput(payload),
        bytes: payload
      }
    };
  }

  /** Verifies a bootstrap's self-signature against its own identity key. */
  function verifyBootstrapSignature(bootstrap, opts) {
    if (!bootstrap || !bootstrap.signature) return Promise.resolve(false);
    return verify(bootstrap.ed25519PublicKey, bootstrap.signingInput, bootstrap.signature, opts);
  }

  // Byte-mode capacity by QR version at each error correction level, versions
  // 1..10 (ISO/IEC 18004 table 7). Enough to report what a bootstrap costs.
  var QR_BYTE_CAPACITY = {
    L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
    M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
    Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
    H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119]
  };

  function qrVersionFor(charCount, ecc) {
    var table = QR_BYTE_CAPACITY[ecc || 'M'];
    if (!table) return null;
    for (var i = 0; i < table.length; i++) {
      if (charCount <= table[i]) return i + 1;
    }
    return null; // needs a version above 10
  }

  /** Size of a bootstrap QR, for the docs and for the UI to display. */
  function bootstrapQrEstimate(signed) {
    var bytes = signed ? BOOTSTRAP_SIGNED_BYTES : BOOTSTRAP_UNSIGNED_BYTES;
    var chars = BOOTSTRAP_PREFIX.length + Math.ceil(bytes * 4 / 3);
    return {
      payloadBytes: bytes,
      qrCharacters: chars,
      versionL: qrVersionFor(chars, 'L'),
      versionM: qrVersionFor(chars, 'M'),
      versionQ: qrVersionFor(chars, 'Q')
    };
  }

  // --- session ---------------------------------------------------------------
  // X25519 over the optical channel, HKDF-SHA256 to split the shared secret
  // into one key per direction, then AEAD per record.
  //
  // Nonce discipline: each direction has its own key and its own 4-byte prefix,
  // and the nonce is that prefix followed by the record counter as 8 big-endian
  // bytes. A counter is never reused under a key, and the two directions cannot
  // collide because their keys differ. Counters are capped at 2^48-1 so they
  // stay exact in a JS number; a session would have to send 280 billion records
  // to reach it.

  var SESSION_INFO = 'rvqr-session-v1';
  var REPLAY_WINDOW = 512;

  function x25519Agree(privateKey, peerPublicKey, opts) {
    var sk, pk;
    try {
      sk = toBytes(privateKey, 'privateKey');
      pk = toBytes(peerPublicKey, 'peerPublicKey');
    } catch (e) {
      return Promise.reject(e);
    }
    if (sk.length !== 32 || pk.length !== 32) {
      return Promise.reject(new Error('x25519 keys must be 32 bytes'));
    }
    return pickBackend(opts, 'x25519').then(function (backend) {
      if (backend === 'webcrypto') {
        return subtle.importKey('pkcs8', pkcs8(PKCS8_X, sk), { name: 'X25519' }, false, ['deriveBits'])
          .then(function (priv) {
            return subtle.importKey('raw', pk, { name: 'X25519' }, false, [])
              .then(function (pub) {
                return subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256);
              });
          })
          .then(function (bits) { return new Uint8Array(bits); });
      }
      return x25519Raw(sk, pk);
    }).then(function (shared) {
      // A low-order peer key drives the shared secret to zero for every private
      // key, which would let anyone fix the session key. WebCrypto rejects this
      // itself; the JS path has to check.
      var zero = 0;
      for (var i = 0; i < shared.length; i++) zero |= shared[i];
      if (zero === 0) throw new Error('x25519 produced an all-zero shared secret');
      return shared;
    });
  }

  function x25519GenerateKeyPair(seed) {
    var s = seed === undefined ? randomBytes(32) : toBytes(seed, 'seed');
    if (s.length !== 32) throw new Error('x25519 seed must be 32 bytes');
    return { privateKey: new Uint8Array(s), publicKey: x25519Base(s) };
  }

  function makeReplayWindow() {
    return { highest: -1, bits: new Uint32Array(REPLAY_WINDOW / 32) };
  }

  /** Accepts a counter once, tolerating the reordering an optical channel causes. */
  function replayAccept(win, counter) {
    if (counter < 0 || counter > MAX_SEAL_COUNTER) return false;
    var idx, word, mask, k;
    if (counter <= win.highest) {
      if (win.highest - counter >= REPLAY_WINDOW) return false; // outside the window
      idx = counter % REPLAY_WINDOW;
      word = idx >>> 5;
      mask = 1 << (idx & 31);
      if (win.bits[word] & mask) return false; // already seen
      win.bits[word] |= mask;
      return true;
    }
    // Advancing: clear the slots the window just moved across.
    var span = Math.min(counter - win.highest, REPLAY_WINDOW);
    for (k = counter - span + 1; k <= counter; k++) {
      idx = k % REPLAY_WINDOW;
      win.bits[idx >>> 5] &= ~(1 << (idx & 31));
    }
    idx = counter % REPLAY_WINDOW;
    win.bits[idx >>> 5] |= 1 << (idx & 31);
    win.highest = counter;
    return true;
  }

  function pickSuite(localCodecs, peerCodecs) {
    var both = localCodecs & peerCodecs;
    if (both & CODEC_CHACHA20_POLY1305) return SUITE_CHACHA;
    if (both & CODEC_AES256_GCM) return SUITE_AESGCM;
    return null;
  }

  /**
   * Both sides feed identical bytes to HKDF: the transcript is ordered by role,
   * not by who happens to be running the code, so initiator and responder
   * derive the same keys.
   */
  function deriveSessionKeys(shared, sessionId, initiator, responder) {
    var info = concat([
      utf8Encode(SESSION_INFO), new Uint8Array([0]),
      initiator.x25519PublicKey, responder.x25519PublicKey,
      initiator.ed25519PublicKey, responder.ed25519PublicKey
    ]);
    var okm = hkdf(shared, sessionId, info, 72);
    return {
      i2rKey: okm.subarray(0, 32),
      r2iKey: okm.subarray(32, 64),
      i2rPrefix: okm.subarray(64, 68),
      r2iPrefix: okm.subarray(68, 72)
    };
  }

  function buildSession(role, sessionId, keys, suite, peerIdentity, verifiedPin) {
    var sending = role === 'initiator';
    return {
      role: role,
      sessionId: toHex(sessionId),
      suite: suite,
      sendKey: sending ? keys.i2rKey : keys.r2iKey,
      recvKey: sending ? keys.r2iKey : keys.i2rKey,
      sendPrefix: sending ? keys.i2rPrefix : keys.r2iPrefix,
      recvPrefix: sending ? keys.r2iPrefix : keys.i2rPrefix,
      sendCounter: 0,
      replay: makeReplayWindow(),
      peerIdentity: peerIdentity,
      peerFingerprint: fingerprint(peerIdentity),
      identityVerified: verifiedPin === true
    };
  }

  function sessionNonce(prefix, counter) {
    var nonce = new Uint8Array(NONCE_BYTES);
    nonce.set(prefix, 0);
    // Counter as 8 big-endian bytes; the top two are always zero at 2^48.
    var hi = Math.floor(counter / 4294967296), lo = counter >>> 0;
    nonce[4] = (hi >>> 24) & 255; nonce[5] = (hi >>> 16) & 255;
    nonce[6] = (hi >>> 8) & 255; nonce[7] = hi & 255;
    nonce[8] = (lo >>> 24) & 255; nonce[9] = (lo >>> 16) & 255;
    nonce[10] = (lo >>> 8) & 255; nonce[11] = lo & 255;
    return nonce;
  }

  /** Session id and counter are bound into the AEAD's associated data. */
  function recordAad(session, counter, aad) {
    return concat([
      fromHex(session.sessionId),
      sessionNonce(new Uint8Array(4), counter).subarray(4),
      aad === undefined || aad === null ? new Uint8Array(0) : toBytes(aad, 'aad')
    ]);
  }

  /** seal(session, plaintext, aad) -> counter(8 bytes) || ciphertext || tag. */
  function seal(session, plaintext, aad) {
    if (session.sendCounter > MAX_SEAL_COUNTER) {
      return Promise.reject(new Error('session record counter exhausted'));
    }
    var counter = session.sendCounter++;
    var nonce = sessionNonce(session.sendPrefix, counter);
    return aeadSeal(session.sendKey, nonce, plaintext, recordAad(session, counter, aad),
      { suite: session.suite })
      .then(function (sealed) {
        return concat([nonce.subarray(4), sealed]);
      });
  }

  /** open(session, record, aad) -> { ok, plaintext } or { ok:false, reason }. */
  function open(session, record, aad) {
    var rec;
    try {
      rec = toBytes(record, 'record');
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'not-bytes' });
    }
    if (rec.length < 8 + TAG_BYTES) return Promise.resolve({ ok: false, reason: 'too-short' });
    var hi = readU32be(rec, 0), lo = readU32be(rec, 4);
    if (hi > 65535) return Promise.resolve({ ok: false, reason: 'counter-out-of-range' });
    var counter = hi * 4294967296 + lo;
    if (counter > MAX_SEAL_COUNTER) {
      return Promise.resolve({ ok: false, reason: 'counter-out-of-range' });
    }
    // Replay is checked before the AEAD so a flood of repeats costs nothing,
    // but only committed after the tag verifies — otherwise anyone could burn
    // a counter slot by showing the camera a forged record.
    if (!replayCheckOnly(session.replay, counter)) {
      return Promise.resolve({ ok: false, reason: 'replayed' });
    }
    var nonce = sessionNonce(session.recvPrefix, counter);
    return aeadOpen(session.recvKey, nonce, rec.subarray(8), recordAad(session, counter, aad),
      { suite: session.suite })
      .then(function (plaintext) {
        if (plaintext === null) return { ok: false, reason: 'auth-failed' };
        replayAccept(session.replay, counter);
        return { ok: true, plaintext: plaintext };
      });
  }

  function replayCheckOnly(win, counter) {
    if (counter < 0 || counter > MAX_SEAL_COUNTER) return false;
    if (counter > win.highest) return true;
    if (win.highest - counter >= REPLAY_WINDOW) return false;
    var idx = counter % REPLAY_WINDOW;
    return (win.bits[idx >>> 5] & (1 << (idx & 31))) === 0;
  }

  /** Initiator step 1: make an ephemeral key and the QR to show. */
  function sessionInvite(opts) {
    var o = opts || {};
    var identity = o.identity || generateKeyPair();
    var ephemeral = o.ephemeral || x25519GenerateKeyPair();
    var sessionId = o.sessionId ? toBytes(o.sessionId, 'sessionId') : randomBytes(8);
    var codecs = o.codecs === undefined ? CODEC_CHACHA20_POLY1305 : o.codecs;
    var state = {
      role: 'initiator',
      identity: identity,
      ephemeral: ephemeral,
      sessionId: sessionId,
      codecs: codecs
    };
    return encodeBootstrapString({
      sessionId: sessionId,
      x25519PublicKey: ephemeral.publicKey,
      ed25519PublicKey: identity.publicKey,
      codecs: codecs,
      identityPrivateKey: o.sign === false ? null : identity.privateKey
    }, o).then(function (bootstrap) {
      state.bootstrap = bootstrap;
      return state;
    });
  }

  /**
   * Responder: consume the initiator's QR, derive the session, and produce the
   * reply QR. opts.pinnedFingerprint makes an unsigned or mis-signed invite a
   * hard failure, which is the only configuration that survives an active MITM.
   */
  function sessionAccept(inviteText, opts) {
    var o = opts || {};
    var parsed = parseBootstrap(inviteText);
    if (!parsed.ok) return Promise.resolve({ ok: false, reason: parsed.reason });
    var peer = parsed.bootstrap;
    var identity = o.identity || generateKeyPair();
    var ephemeral = o.ephemeral || x25519GenerateKeyPair();
    var codecs = o.codecs === undefined ? CODEC_CHACHA20_POLY1305 : o.codecs;
    var suite = pickSuite(codecs, peer.codecs);
    if (!suite) return Promise.resolve({ ok: false, reason: 'no-shared-codec' });

    return checkPin(peer, o).then(function (pin) {
      if (!pin.ok) return pin;
      return x25519Agree(ephemeral.privateKey, peer.x25519PublicKey, o).then(function (shared) {
        var keys = deriveSessionKeys(shared, peer.sessionId,
          { x25519PublicKey: peer.x25519PublicKey, ed25519PublicKey: peer.ed25519PublicKey },
          { x25519PublicKey: ephemeral.publicKey, ed25519PublicKey: identity.publicKey });
        var session = buildSession('responder', peer.sessionId, keys, suite,
          peer.ed25519PublicKey, pin.verified);
        return encodeBootstrapString({
          sessionId: peer.sessionId,
          x25519PublicKey: ephemeral.publicKey,
          ed25519PublicKey: identity.publicKey,
          codecs: codecs,
          identityPrivateKey: o.sign === false ? null : identity.privateKey
        }, o).then(function (bootstrap) {
          return { ok: true, session: session, bootstrap: bootstrap, identity: identity };
        });
      }, function (e) {
        return { ok: false, reason: e && e.message ? e.message : 'x25519-failed' };
      });
    });
  }

  /** Initiator step 2: consume the responder's reply QR. */
  function sessionConfirm(state, replyText, opts) {
    var o = opts || {};
    var parsed = parseBootstrap(replyText);
    if (!parsed.ok) return Promise.resolve({ ok: false, reason: parsed.reason });
    var peer = parsed.bootstrap;
    if (!timingSafeEqual(new Uint8Array(peer.sessionId), new Uint8Array(state.sessionId))) {
      return Promise.resolve({ ok: false, reason: 'session-id-mismatch' });
    }
    var suite = pickSuite(state.codecs, peer.codecs);
    if (!suite) return Promise.resolve({ ok: false, reason: 'no-shared-codec' });

    return checkPin(peer, o).then(function (pin) {
      if (!pin.ok) return pin;
      return x25519Agree(state.ephemeral.privateKey, peer.x25519PublicKey, o)
        .then(function (shared) {
          var keys = deriveSessionKeys(shared, state.sessionId,
            {
              x25519PublicKey: state.ephemeral.publicKey,
              ed25519PublicKey: state.identity.publicKey
            },
            { x25519PublicKey: peer.x25519PublicKey, ed25519PublicKey: peer.ed25519PublicKey });
          return {
            ok: true,
            session: buildSession('initiator', state.sessionId, keys, suite,
              peer.ed25519PublicKey, pin.verified)
          };
        }, function (e) {
          return { ok: false, reason: e && e.message ? e.message : 'x25519-failed' };
        });
    });
  }

  function checkPin(peer, opts) {
    var pinned = opts && opts.pinnedFingerprint;
    if (peer.signature) {
      return verifyBootstrapSignature(peer, opts).then(function (ok) {
        // A present-but-invalid signature is always fatal, pinned or not.
        if (!ok) return { ok: false, reason: 'bad-bootstrap-signature' };
        if (pinned && !matchesPin(peer.ed25519PublicKey, pinned)) {
          return { ok: false, reason: 'identity-not-pinned' };
        }
        return { ok: true, verified: !!pinned };
      });
    }
    if (pinned) return Promise.resolve({ ok: false, reason: 'unsigned-bootstrap' });
    return Promise.resolve({ ok: true, verified: false });
  }

  return {
    // hashing and derivation
    sha256: sha256,
    sha512: sha512,
    hmacSha256: hmacSha256,
    hkdf: hkdf,
    hkdfExtract: hkdfExtract,
    hkdfExpand: hkdfExpand,

    // Ed25519
    generateKeyPair: generateKeyPair,
    sign: sign,
    verify: verify,
    signSync: ed25519SignJs,
    verifySync: ed25519VerifyJs,
    publicKeyFromSeed: ed25519PublicFromSeed,

    // signed manifests
    canonicalManifestBytes: canonicalManifestBytes,
    decodeCanonicalManifest: decodeCanonicalManifest,
    signManifest: signManifest,
    verifyManifest: verifyManifest,
    MANIFEST_FIELDS: MANIFEST_FIELDS,

    // key pinning
    fingerprint: fingerprint,
    fingerprintEqual: fingerprintEqual,
    matchesPin: matchesPin,

    // X25519
    x25519GenerateKeyPair: x25519GenerateKeyPair,
    x25519Agree: x25519Agree,
    x25519Raw: x25519Raw,
    x25519Base: x25519Base,

    // AEAD
    aeadSeal: aeadSeal,
    aeadOpen: aeadOpen,
    chacha20: chacha20,
    poly1305: poly1305,
    SUITE_CHACHA: SUITE_CHACHA,
    SUITE_AESGCM: SUITE_AESGCM,

    // bootstrap
    encodeBootstrap: encodeBootstrap,
    encodeBootstrapString: encodeBootstrapString,
    parseBootstrap: parseBootstrap,
    verifyBootstrapSignature: verifyBootstrapSignature,
    bootstrapQrEstimate: bootstrapQrEstimate,
    qrVersionFor: qrVersionFor,
    BOOTSTRAP_PREFIX: BOOTSTRAP_PREFIX,
    CODEC_CHACHA20_POLY1305: CODEC_CHACHA20_POLY1305,
    CODEC_AES256_GCM: CODEC_AES256_GCM,
    CODEC_FOUNTAIN: CODEC_FOUNTAIN,
    CODEC_PLAIN: CODEC_PLAIN,

    // sessions
    sessionInvite: sessionInvite,
    sessionAccept: sessionAccept,
    sessionConfirm: sessionConfirm,
    deriveSessionKeys: deriveSessionKeys,
    seal: seal,
    open: open,
    REPLAY_WINDOW: REPLAY_WINDOW,
    MAX_SEAL_COUNTER: MAX_SEAL_COUNTER,

    // platform
    capabilities: capabilities,
    randomBytes: randomBytes,
    timingSafeEqual: timingSafeEqual,
    toHex: toHex,
    fromHex: fromHex,
    b64uEncode: b64uEncode,
    b64uDecode: b64uDecode
  };
});
