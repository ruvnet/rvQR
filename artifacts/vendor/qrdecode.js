/*!
 * qrdecode.js — a small QR Code decoder for rvQR.
 *
 * Written for this project rather than vendored from an existing library, so
 * that it shares the (reference-verified) version tables in qrcode.js instead
 * of carrying a second copy that could drift. The algorithms are the standard
 * ones from ISO/IEC 18004 and the published literature: a block-adaptive
 * binarizer, 1:1:3:1:1 finder-pattern search, a perspective transform anchored
 * on the three finders plus an alignment pattern, then format decoding,
 * de-interleaving and Reed-Solomon error correction over GF(2^8).
 *
 * It exists because BarcodeDetector does not: Firefox has no implementation and
 * Safari only gained one in 17. Where the native API is present the app uses it,
 * because it is faster and better tested; this is the fallback.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory(
    typeof module === 'object' && module.exports
      ? require('./qrcode.js')
      : root.RVQRCode
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRDecode = api;
})(typeof self !== 'undefined' ? self : this, function (qrlib) {
  'use strict';

  // ---------------------------------------------------------------------------
  // GF(2^8) — same field as the encoder, x^8+x^4+x^3+x^2+1
  // ---------------------------------------------------------------------------

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gdiv(a, b) {
    if (b === 0) throw new Error('divide by zero in GF(256)');
    if (a === 0) return 0;
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
  }
  function ginv(a) {
    return EXP[255 - LOG[a]];
  }

  /** Evaluates a polynomial (highest degree first) at x. */
  function polyEval(poly, x) {
    var y = 0;
    for (var i = 0; i < poly.length; i++) y = gmul(y, x) ^ poly[i];
    return y;
  }

  function polyMul(a, b) {
    var out = new Uint8Array(a.length + b.length - 1);
    for (var i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      for (var j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i], b[j]);
    }
    return out;
  }

  /**
   * Reed-Solomon decode in place. Returns the number of errors corrected, or
   * -1 when the block cannot be recovered.
   *
   * Syndromes use roots alpha^0 .. alpha^(ecc-1), matching the generator the
   * encoder builds.
   */
  function rsDecode(block, eccLen) {
    var n = block.length;
    var syn = new Uint8Array(eccLen);
    var hasError = false;
    for (var i = 0; i < eccLen; i++) {
      syn[i] = polyEval(block, EXP[i]);
      if (syn[i]) hasError = true;
    }
    if (!hasError) return 0;

    // Berlekamp-Massey: find the error locator polynomial.
    var lambda = [1], b = [1], l = 0, m = 1, bScale = 1;
    for (var r = 0; r < eccLen; r++) {
      var delta = syn[r];
      for (var k = 1; k <= l; k++) {
        delta ^= gmul(lambda[lambda.length - 1 - k] || 0, syn[r - k]);
      }
      if (delta === 0) {
        m++;
      } else if (2 * l <= r) {
        var oldLambda = lambda.slice();
        var scale = gdiv(delta, bScale);
        var shifted = new Array(m).fill(0);
        var bShift = b.concat(shifted);
        lambda = addPoly(lambda, scalePoly(bShift, scale));
        l = r + 1 - l;
        b = oldLambda;
        bScale = delta;
        m = 1;
      } else {
        var scale2 = gdiv(delta, bScale);
        var bShift2 = b.concat(new Array(m).fill(0));
        lambda = addPoly(lambda, scalePoly(bShift2, scale2));
        m++;
      }
    }

    var errCount = lambda.length - 1;
    if (errCount <= 0 || errCount > (eccLen >> 1)) return -1;

    // Chien search: roots of lambda give the error positions.
    var positions = [];
    for (var p = 0; p < n; p++) {
      // position p (from the end) corresponds to alpha^-p
      if (polyEval(lambda, EXP[(255 - p) % 255]) === 0) positions.push(p);
    }
    if (positions.length !== errCount) return -1;

    // Forney: omega(x) = syn(x) * lambda(x) mod x^eccLen
    var synPoly = [];
    for (var s = eccLen - 1; s >= 0; s--) synPoly.push(syn[s]);
    var omega = polyMul(synPoly, lambda);
    omega = omega.slice(Math.max(0, omega.length - eccLen));

    var lambdaDeriv = [];
    var deg = lambda.length - 1;
    for (var d = 0; d < deg; d++) {
      // formal derivative in GF(2): only odd-power terms survive
      var power = deg - d;
      lambdaDeriv.push(power % 2 === 1 ? lambda[d] : 0);
    }

    for (var e = 0; e < positions.length; e++) {
      var pos = positions[e];
      var xInv = EXP[(255 - pos) % 255];
      var num = polyEval(omega, xInv);
      var den = polyEval(lambdaDeriv, xInv);
      if (den === 0) return -1;
      var magnitude = gmul(gdiv(num, den), EXP[pos % 255]);
      var idx = n - 1 - pos;
      if (idx < 0 || idx >= n) return -1;
      block[idx] ^= magnitude;
    }

    // Verify: syndromes must now vanish.
    for (var v = 0; v < eccLen; v++) {
      if (polyEval(block, EXP[v]) !== 0) return -1;
    }
    return positions.length;
  }

  function addPoly(a, b) {
    var len = Math.max(a.length, b.length);
    var out = new Array(len).fill(0);
    for (var i = 0; i < a.length; i++) out[len - a.length + i] ^= a[i];
    for (var j = 0; j < b.length; j++) out[len - b.length + j] ^= b[j];
    while (out.length > 1 && out[0] === 0) out.shift();
    return out;
  }
  function scalePoly(a, s) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = gmul(a[i], s);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Matrix -> text
  // ---------------------------------------------------------------------------

  var ECC_BY_FORMAT_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  /** Reads and BCH-corrects the 15-bit format information. */
  function readFormat(get, size) {
    var copies = [0, 0];
    var i;
    for (i = 0; i <= 5; i++) copies[0] |= (get(8, i) ? 1 : 0) << i;
    copies[0] |= (get(8, 7) ? 1 : 0) << 6;
    copies[0] |= (get(8, 8) ? 1 : 0) << 7;
    copies[0] |= (get(7, 8) ? 1 : 0) << 8;
    for (i = 9; i < 15; i++) copies[0] |= (get(14 - i, 8) ? 1 : 0) << i;

    for (i = 0; i < 8; i++) copies[1] |= (get(size - 1 - i, 8) ? 1 : 0) << i;
    for (i = 8; i < 15; i++) copies[1] |= (get(8, size - 15 + i) ? 1 : 0) << i;

    for (var c = 0; c < 2; c++) {
      var best = decodeFormatBits(copies[c] ^ 0x5412);
      if (best !== null) return best;
    }
    return null;
  }

  // Brute-force nearest codeword: only 32 valid format values exist, so this is
  // both exact and trivial. Accepts up to 3 bit errors, per the BCH(15,5) bound.
  function decodeFormatBits(unmasked) {
    var bestDist = 32, best = null;
    for (var data = 0; data < 32; data++) {
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var candidate = (data << 10) | rem;
      var dist = popcount(candidate ^ unmasked);
      if (dist < bestDist) { bestDist = dist; best = data; }
    }
    if (bestDist > 3) return null;
    return { ecc: ECC_BY_FORMAT_BITS[(best >>> 3) & 3], mask: best & 7 };
  }

  function popcount(x) {
    var c = 0;
    while (x) { c += x & 1; x >>>= 1; }
    return c;
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  /** Marks every function-pattern module for a version, mirroring the encoder. */
  function functionMap(version, size) {
    var map = [];
    var y, x;
    for (y = 0; y < size; y++) map.push(new Uint8Array(size));
    function block(ox, oy, w, h) {
      for (var yy = oy; yy < oy + h; yy++) {
        for (var xx = ox; xx < ox + w; xx++) {
          if (yy >= 0 && yy < size && xx >= 0 && xx < size) map[yy][xx] = 1;
        }
      }
    }
    block(0, 0, 9, 9);
    block(size - 8, 0, 8, 9);
    block(0, size - 8, 9, 8);
    for (var t = 0; t < size; t++) { map[6][t] = 1; map[t][6] = 1; }

    var align = qrlib.getAlignmentPatternPositions(version);
    for (var i = 0; i < align.length; i++) {
      for (var j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) ||
            (i === align.length - 1 && j === 0)) continue;
        block(align[i] - 2, align[j] - 2, 5, 5);
      }
    }
    if (version >= 7) {
      block(size - 11, 0, 3, 6);
      block(0, size - 11, 6, 3);
    }
    return map;
  }

  /**
   * Decodes a module matrix. `get(x, y)` returns true for dark.
   * This is the pure, testable core: no pixels, no camera.
   */
  function decodeMatrix(get, size) {
    if (size < 21 || size > 177 || (size - 17) % 4 !== 0) {
      return { ok: false, reason: 'bad-size' };
    }
    var version = (size - 17) / 4;
    var format = readFormat(get, size);
    if (!format) return { ok: false, reason: 'format-unreadable' };

    var ecl = qrlib.ECC[format.ecc];
    var fmap = functionMap(version, size);

    // Unmask and read codewords in the standard zigzag.
    var rawCount = Math.floor(qrlib.getNumRawDataModules(version) / 8);
    var codewords = new Uint8Array(rawCount);
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (fmap[y][x]) continue;
          if (bitIndex >= rawCount * 8) continue;
          var dark = get(x, y);
          if (maskBit(format.mask, x, y)) dark = !dark;
          if (dark) codewords[bitIndex >>> 3] |= 0x80 >>> (bitIndex & 7);
          bitIndex++;
        }
      }
    }

    // De-interleave into blocks, exactly inverting the encoder's layout.
    var numBlocks = qrlib.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version];
    var eccPerBlock = qrlib.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
    var numShort = numBlocks - (rawCount % numBlocks);
    var shortLen = Math.floor(rawCount / numBlocks);
    var shortDataLen = shortLen - eccPerBlock;

    // The encoder lays every block out in a uniform (shortLen + 1) slot array:
    // data first, then a single padding slot at index shortDataLen that only
    // short blocks use and that is never transmitted, then the parity. Undoing
    // it is the same walk with the same slot skipped.
    var slotCount = shortLen + 1;
    var slots = [];
    for (var b = 0; b < numBlocks; b++) slots.push(new Uint8Array(slotCount));
    var pos = 0;
    for (var col = 0; col < slotCount; col++) {
      for (var bb = 0; bb < numBlocks; bb++) {
        if (col === shortDataLen && bb < numShort) continue; // untransmitted pad
        if (pos < rawCount) slots[bb][col] = codewords[pos++];
      }
    }

    var blocks = [];
    for (var bi = 0; bi < numBlocks; bi++) {
      var isShort = bi < numShort;
      var dataLen = shortDataLen + (isShort ? 0 : 1);
      var block = new Uint8Array(dataLen + eccPerBlock);
      for (var di = 0; di < dataLen; di++) block[di] = slots[bi][di];
      for (var ei = 0; ei < eccPerBlock; ei++) {
        block[dataLen + ei] = slots[bi][shortDataLen + 1 + ei];
      }
      blocks.push(block);
    }

    // Correct each block and concatenate the data halves.
    var data = [];
    var corrected = 0;
    for (var c = 0; c < blocks.length; c++) {
      var res = rsDecode(blocks[c], eccPerBlock);
      if (res < 0) return { ok: false, reason: 'ecc-failed', version: version, ecc: format.ecc };
      corrected += res;
      var dataLen = blocks[c].length - eccPerBlock;
      for (var d = 0; d < dataLen; d++) data.push(blocks[c][d]);
    }

    var text = readSegments(data, version);
    if (text === null) return { ok: false, reason: 'bad-segments', version: version };
    return {
      ok: true, text: text, version: version, ecc: format.ecc,
      mask: format.mask, size: size, corrections: corrected
    };
  }

  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  /** Reads mode segments out of the corrected data codewords. */
  function readSegments(data, version) {
    var bitPos = 0;
    var totalBits = data.length * 8;
    function bits(n) {
      if (bitPos + n > totalBits) return -1;
      var v = 0;
      for (var i = 0; i < n; i++) {
        var byteIdx = (bitPos + i) >>> 3;
        var bit = (data[byteIdx] >>> (7 - ((bitPos + i) & 7))) & 1;
        v = (v << 1) | bit;
      }
      bitPos += n;
      return v;
    }
    function countBits(mode) {
      if (version <= 9) return mode === 1 ? 10 : mode === 2 ? 9 : mode === 4 ? 8 : 8;
      if (version <= 26) return mode === 1 ? 12 : mode === 2 ? 11 : mode === 4 ? 16 : 10;
      return mode === 1 ? 14 : mode === 2 ? 13 : mode === 4 ? 16 : 12;
    }

    var bytes = [];
    for (;;) {
      var mode = bits(4);
      if (mode <= 0) break; // terminator or out of data
      if (mode === 7) { // ECI — skip the assignment number, keep decoding
        var first = bits(8);
        if (first < 0) return null;
        if (first >= 0xc0) bits(16);
        else if (first >= 0x80) bits(8);
        continue;
      }
      var count = bits(countBits(mode));
      if (count < 0) return null;
      var i, v;
      if (mode === 4) { // byte
        for (i = 0; i < count; i++) {
          v = bits(8);
          if (v < 0) return null;
          bytes.push(v);
        }
      } else if (mode === 1) { // numeric
        for (i = 0; i + 3 <= count; i += 3) {
          v = bits(10);
          if (v < 0) return null;
          pushDigits(bytes, v, 3);
        }
        if (count - i === 2) { v = bits(7); if (v < 0) return null; pushDigits(bytes, v, 2); }
        else if (count - i === 1) { v = bits(4); if (v < 0) return null; pushDigits(bytes, v, 1); }
      } else if (mode === 2) { // alphanumeric
        for (i = 0; i + 2 <= count; i += 2) {
          v = bits(11);
          if (v < 0) return null;
          bytes.push(ALNUM.charCodeAt(Math.floor(v / 45)));
          bytes.push(ALNUM.charCodeAt(v % 45));
        }
        if (count - i === 1) {
          v = bits(6);
          if (v < 0) return null;
          bytes.push(ALNUM.charCodeAt(v));
        }
      } else {
        return null; // kanji and structured append are not supported
      }
    }
    return utf8Decode(bytes);
  }

  function pushDigits(out, value, n) {
    var s = String(value);
    while (s.length < n) s = '0' + s;
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  }

  function utf8Decode(bytes) {
    var arr = new Uint8Array(bytes);
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(arr);
    }
    var out = '';
    for (var i = 0; i < arr.length; i++) out += String.fromCharCode(arr[i]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Image -> matrix
  // ---------------------------------------------------------------------------

  /** Converts ImageData-like input to a luminance array. */
  function toLuminance(image) {
    var w = image.width, h = image.height, d = image.data;
    var lum = new Uint8ClampedArray(w * h);
    for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
    }
    return { data: lum, width: w, height: h };
  }

  var BLOCK = 8;

  /**
   * Block-adaptive threshold. A global threshold fails on photographs of
   * screens, where one corner is often much brighter than the other.
   */
  function binarize(gray) {
    var w = gray.width, h = gray.height, src = gray.data;
    var bw = Math.max(1, Math.ceil(w / BLOCK));
    var bh = Math.max(1, Math.ceil(h / BLOCK));
    var averages = new Float32Array(bw * bh);
    var mins = new Uint8Array(bw * bh).fill(255);
    var maxs = new Uint8Array(bw * bh);

    var bx, by, x, y;
    for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
        var sum = 0, n = 0, mn = 255, mx = 0;
        for (y = by * BLOCK; y < Math.min((by + 1) * BLOCK, h); y++) {
          for (x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, w); x++) {
            var v = src[y * w + x];
            sum += v; n++;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        averages[by * bw + bx] = n ? sum / n : 128;
        mins[by * bw + bx] = mn;
        maxs[by * bw + bx] = mx;
      }
    }

    var out = new Uint8Array(w * h);
    for (by = 0; by < bh; by++) {
      for (bx = 0; bx < bw; bx++) {
        // Average over a 5x5 neighbourhood of blocks, so a block that is
        // entirely dark (inside a finder) borrows its threshold from around it.
        var acc = 0, cnt = 0;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var nx = bx + dx, ny = by + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            acc += averages[ny * bw + nx];
            cnt++;
          }
        }
        var neighbourhood = cnt ? acc / cnt : 128;
        var threshold = neighbourhood;
        var idx = by * bw + bx;
        var contrast = maxs[idx] - mins[idx];
        if (contrast <= 24) {
          // A block with no edge in it carries no information about where the
          // threshold should sit. Half its own minimum keeps a uniformly light
          // block light — which matters, because the quiet zone around a symbol
          // is exactly that, and calling a wide margin dark wrecks everything
          // downstream. A block that is genuinely darker than its surroundings
          // (the middle of a finder) takes the neighbourhood value instead.
          threshold = mins[idx] / 2;
          if (mins[idx] < neighbourhood) threshold = neighbourhood;
        }
        for (y = by * BLOCK; y < Math.min((by + 1) * BLOCK, h); y++) {
          for (x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, w); x++) {
            out[y * w + x] = src[y * w + x] < threshold ? 1 : 0;
          }
        }
      }
    }
    return { data: out, width: w, height: h };
  }

  /** Scans for 1:1:3:1:1 runs and returns candidate finder centres. */
  function findFinders(bin) {
    var w = bin.width, h = bin.height, d = bin.data;
    var candidates = [];

    function checkRatio(counts) {
      var total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
      if (total < 7) return false;
      var unit = total / 7;
      var tol = unit * 0.6;
      return Math.abs(unit - counts[0]) < tol &&
        Math.abs(unit - counts[1]) < tol &&
        Math.abs(unit * 3 - counts[2]) < tol * 2 &&
        Math.abs(unit - counts[3]) < tol &&
        Math.abs(unit - counts[4]) < tol;
    }

    function verifyVertical(cx, cy, maxCount) {
      var counts = [0, 0, 0, 0, 0];
      var y = cy;
      while (y >= 0 && d[y * w + cx]) { counts[2]++; y--; }
      while (y >= 0 && !d[y * w + cx] && counts[1] <= maxCount) { counts[1]++; y--; }
      while (y >= 0 && d[y * w + cx] && counts[0] <= maxCount) { counts[0]++; y--; }
      y = cy + 1;
      while (y < h && d[y * w + cx]) { counts[2]++; y++; }
      while (y < h && !d[y * w + cx] && counts[3] <= maxCount) { counts[3]++; y++; }
      while (y < h && d[y * w + cx] && counts[4] <= maxCount) { counts[4]++; y++; }
      if (!checkRatio(counts)) return -1;
      // `y` sits one past the last row counted, the same convention the
      // horizontal scan uses, so the shared centre formula applies.
      return centerFromEnd(counts, y);
    }

    function centerFromEnd(counts, end) {
      return end - counts[4] - counts[3] - counts[2] / 2;
    }

    for (var y = 0; y < h; y++) {
      var counts = [0, 0, 0, 0, 0];
      var state = 0;
      for (var x = 0; x < w; x++) {
        var dark = d[y * w + x];
        if (dark) {
          if (state % 2 === 1) state++;
          counts[state]++;
        } else {
          if (state % 2 === 0) {
            if (state === 4) {
              if (checkRatio(counts)) {
                var cx = Math.floor(centerFromEnd(counts, x));
                var unit = (counts[0] + counts[1] + counts[2] + counts[3] + counts[4]) / 7;
                var cyEst = verifyVertical(cx, y, unit * 3);
                if (cyEst >= 0) {
                  candidates.push({ x: cx, y: Math.floor(cyEst), size: unit });
                }
              }
              counts = [counts[2], counts[3], counts[4], 1, 0];
              state = 3;
            } else {
              counts[++state]++;
            }
          } else {
            counts[state]++;
          }
        }
      }
      if (state === 4 && checkRatio(counts)) {
        var cx2 = Math.floor(centerFromEnd(counts, w));
        var unit2 = (counts[0] + counts[1] + counts[2] + counts[3] + counts[4]) / 7;
        var cy2 = verifyVertical(cx2, y, unit2 * 3);
        if (cy2 >= 0) candidates.push({ x: cx2, y: Math.floor(cy2), size: unit2 });
      }
    }

    // Cluster candidates that refer to the same physical pattern.
    var clusters = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var placed = false;
      for (var k = 0; k < clusters.length; k++) {
        var cl = clusters[k];
        if (Math.abs(cl.x - c.x) <= cl.size && Math.abs(cl.y - c.y) <= cl.size) {
          cl.x = (cl.x * cl.n + c.x) / (cl.n + 1);
          cl.y = (cl.y * cl.n + c.y) / (cl.n + 1);
          cl.size = (cl.size * cl.n + c.size) / (cl.n + 1);
          cl.n++;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ x: c.x, y: c.y, size: c.size, n: 1 });
    }
    return clusters.filter(function (c) { return c.n >= 2; });
  }

  /** Orders three finder centres into { topLeft, topRight, bottomLeft }. */
  function orderFinders(a, b, c) {
    function dist(p, q) {
      var dx = p.x - q.x, dy = p.y - q.y;
      return dx * dx + dy * dy;
    }
    var ab = dist(a, b), bc = dist(b, c), ac = dist(a, c);
    var corner, p1, p2;
    if (bc >= ab && bc >= ac) { corner = a; p1 = b; p2 = c; }
    else if (ac >= ab && ac >= bc) { corner = b; p1 = a; p2 = c; }
    else { corner = c; p1 = a; p2 = b; }

    // Cross product decides which of the two is the top-right. Image y grows
    // downward, so (topRight - topLeft) × (bottomLeft - topLeft) is positive.
    var cross = (p1.x - corner.x) * (p2.y - corner.y) - (p1.y - corner.y) * (p2.x - corner.x);
    var topRight = cross > 0 ? p1 : p2;
    var bottomLeft = cross > 0 ? p2 : p1;
    return { topLeft: corner, topRight: topRight, bottomLeft: bottomLeft };
  }

  // --- perspective transform -------------------------------------------------

  function squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3) {
    var dx3 = x0 - x1 + x2 - x3;
    var dy3 = y0 - y1 + y2 - y3;
    if (dx3 === 0 && dy3 === 0) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    }
    var dx1 = x1 - x2, dx2 = x3 - x2;
    var dy1 = y1 - y2, dy2 = y3 - y2;
    var denom = dx1 * dy2 - dx2 * dy1;
    if (!denom) return null;
    var a13 = (dx3 * dy2 - dx2 * dy3) / denom;
    var a23 = (dx1 * dy3 - dx3 * dy1) / denom;
    return [
      x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0,
      y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0,
      a13, a23, 1
    ];
  }

  function adjugate(m) {
    return [
      m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
    ];
  }

  function matMul(a, b) {
    return [
      a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
      a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
      a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8]
    ];
  }

  function quadToQuad(src, dst) {
    var s = squareToQuad.apply(null, src);
    var d = squareToQuad.apply(null, dst);
    if (!s || !d) return null;
    return matMul(d, adjugate(s));
  }

  function applyTransform(t, x, y) {
    var denom = t[6] * x + t[7] * y + t[8];
    if (!denom) return null;
    return {
      x: (t[0] * x + t[1] * y + t[2]) / denom,
      y: (t[3] * x + t[4] * y + t[5]) / denom
    };
  }

  /**
   * Looks for an alignment pattern near an expected image point.
   *
   * A horizontal line through the centre of an alignment pattern crosses five
   * runs of equal length — dark, light, dark, light, dark. Matching that run
   * pattern rather than probing fixed pixel offsets keeps working when the
   * module size at that corner differs from the average, which is exactly what
   * happens on a tilted view: the far corner's modules are a different size
   * from the ones the finder patterns measured.
   */
  function findAlignment(bin, cx, cy, moduleSize, symbolSpan) {
    var radius = Math.ceil(Math.max(moduleSize * 5, (symbolSpan || 0) * 0.1));
    var w = bin.width, h = bin.height, d = bin.data;
    var x0 = Math.max(1, Math.floor(cx - radius));
    var x1 = Math.min(w - 1, Math.ceil(cx + radius));
    var y0 = Math.max(1, Math.floor(cy - radius));
    var y1 = Math.min(h - 1, Math.ceil(cy + radius));
    var best = null, bestScore = Infinity;

    function equalRuns(runs) {
      var avg = (runs[0] + runs[1] + runs[2] + runs[3] + runs[4]) / 5;
      if (avg < 0.8) return false;
      for (var i = 0; i < 5; i++) {
        if (Math.abs(runs[i] - avg) > avg * 0.7) return false;
      }
      // The pattern is one module per run, so the total spans five modules.
      return Math.abs(avg - moduleSize) < moduleSize * 0.7;
    }

    // Measures the five runs centred on (x, y) along one axis.
    function runsAt(x, y, stepX, stepY) {
      var runs = [0, 0, 0, 0, 0];
      if (!d[y * w + x]) return null;
      var px = x, py = y;
      while (inside(px, py) && d[py * w + px]) { runs[2]++; px -= stepX; py -= stepY; }
      while (inside(px, py) && !d[py * w + px]) { runs[1]++; px -= stepX; py -= stepY; }
      while (inside(px, py) && d[py * w + px]) { runs[0]++; px -= stepX; py -= stepY; }
      px = x + stepX; py = y + stepY;
      while (inside(px, py) && d[py * w + px]) { runs[2]++; px += stepX; py += stepY; }
      while (inside(px, py) && !d[py * w + px]) { runs[3]++; px += stepX; py += stepY; }
      while (inside(px, py) && d[py * w + px]) { runs[4]++; px += stepX; py += stepY; }
      return runs;
    }
    function inside(x, y) {
      return x >= 0 && y >= 0 && x < w && y < h;
    }

    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (!d[y * w + x]) continue;
        var hr = runsAt(x, y, 1, 0);
        if (!hr || !equalRuns(hr)) continue;
        var vr = runsAt(x, y, 0, 1);
        if (!vr || !equalRuns(vr)) continue;
        var score = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (score < bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
    }
    return best;
  }

  /**
   * Samples the module grid through a transform. The neighbourhood vote steadies
   * noisy photographs, but at very low pixel density it starts averaging in the
   * neighbouring module, so below three pixels per module take the single
   * nearest pixel instead.
   */
  function sampleGrid(bin, size, transform, moduleSize) {
    var w = bin.width, h = bin.height, d = bin.data;
    var matrix = [];
    for (var y = 0; y < size; y++) {
      var row = new Uint8Array(size);
      for (var x = 0; x < size; x++) {
        var p = applyTransform(transform, x + 0.5, y + 0.5);
        if (!p) return null;
        var px = Math.round(p.x), py = Math.round(p.y);
        if (px < 0 || py < 0 || px >= w || py >= h) return null;
        if (moduleSize !== undefined && moduleSize < 3) {
          row[x] = d[py * w + px];
        } else {
          var votes = 0, total = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var qx = px + dx, qy = py + dy;
              if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
              votes += d[qy * w + qx];
              total++;
            }
          }
          row[x] = votes * 2 > total ? 1 : 0;
        }
      }
      matrix.push(row);
    }
    return matrix;
  }

  /**
   * Full pipeline over an ImageData-like object.
   * Returns every symbol it can read — a photo of a screen may contain more
   * than one frame, and the receiver is happy to take them all.
   */
  function decodeImage(image, options) {
    // Default to collecting every symbol: one photo of a sending screen can
    // hold several frames, and the receiver is glad to have them all.
    options = options || { all: true };
    if (options.all === undefined) options.all = true;
    var gray = toLuminance(image);
    var attempts = [binarize(gray)];
    if (options.invert !== false) {
      // Some screenshots come through inverted; trying both is cheap.
      var inverted = { data: new Uint8ClampedArray(gray.data.length), width: gray.width, height: gray.height };
      for (var i = 0; i < gray.data.length; i++) inverted.data[i] = 255 - gray.data[i];
      attempts.push(binarize(inverted));
    }

    var found = [];
    var seen = Object.create(null);
    for (var a = 0; a < attempts.length; a++) {
      var bin = attempts[a];
      var finders = findFinders(bin);
      if (finders.length < 3) continue;

      // Rank by how many scan lines confirmed each candidate, not by size.
      // Dense data regions throw off 1:1:3:1:1 false positives all the time,
      // and those are often *larger* than the real finders — sorting by size
      // buries the true corners behind noise.
      finders.sort(function (p, q) { return q.n - p.n; });
      // 12 was exactly enough for FOUR symbols and therefore enough for none:
      // a 4-frame sheet contributes 12 true finders, so a single false positive
      // ranking above a true one pushed a real corner out of the window and that
      // frame became unfindable. It cost 40 of 200 random 4-frame sheets — the
      // multi-frame photo path silently returning three frames out of four.
      //
      // The candidate loop is C(limit, 3), so raising this is not obviously
      // free; measured on 200 fixed sheets, it is. Dropped sheets fall to zero
      // at 14 and stay there, while median decode time is flat because
      // binarisation and finder detection dominate:
      //
      //   cap 12: 40/200 dropped, 26.96 ms   cap 18: 0/200, 27.55 ms
      //   cap 14:  0/200 dropped, 27.47 ms   cap 20: 0/200, 27.01 ms
      //   cap 16:  0/200 dropped, 28.36 ms   cap 24: 0/200, 26.65 ms
      //
      // 24 carries eight symbols' worth of finders rather than sitting one
      // false positive away from the cliff, and measures no slower than 12.
      var limit = Math.min(finders.length, 24);

      // Score every triple by how much it looks like three corners of one
      // symbol, then try the most plausible first.
      var triples = [];
      for (var i1 = 0; i1 < limit; i1++) {
        for (var i2 = i1 + 1; i2 < limit; i2++) {
          for (var i3 = i2 + 1; i3 < limit; i3++) {
            var score = tripleScore(finders[i1], finders[i2], finders[i3]);
            if (score !== null) {
              triples.push({ score: score, f: [finders[i1], finders[i2], finders[i3]] });
            }
          }
        }
      }
      triples.sort(function (p, q) { return p.score - q.score; });

      for (var t = 0; t < triples.length && t < 40; t++) {
        var res = tryTriple(bin, triples[t].f[0], triples[t].f[1], triples[t].f[2]);
        if (res && res.ok && !seen[res.text]) {
          seen[res.text] = true;
          found.push(res);
          if (!options.all) break;
        }
      }
      if (found.length) break;
    }
    return found;
  }

  /**
   * How much three candidates look like the corners of one symbol: lower is
   * better, null rejects outright. Three finders form a right isosceles
   * triangle, and share a module size — both hold under moderate perspective.
   */
  function tripleScore(a, b, c) {
    var avg = (a.size + b.size + c.size) / 3;
    var sizeSpread = Math.max(
      Math.abs(a.size - avg), Math.abs(b.size - avg), Math.abs(c.size - avg)
    ) / avg;
    if (sizeSpread > 0.4) return null;

    var ord = orderFinders(a, b, c);
    var tl = ord.topLeft, tr = ord.topRight, bl = ord.bottomLeft;
    var legTR = Math.sqrt(Math.pow(tr.x - tl.x, 2) + Math.pow(tr.y - tl.y, 2));
    var legBL = Math.sqrt(Math.pow(bl.x - tl.x, 2) + Math.pow(bl.y - tl.y, 2));
    if (legTR < avg * 10 || legBL < avg * 10) return null; // too close together
    var legRatio = Math.abs(legTR - legBL) / Math.max(legTR, legBL);
    if (legRatio > 0.35) return null;

    // Angle at the top-left corner should be near 90 degrees.
    var dot = (tr.x - tl.x) * (bl.x - tl.x) + (tr.y - tl.y) * (bl.y - tl.y);
    var cosAngle = dot / (legTR * legBL);
    if (Math.abs(cosAngle) > 0.35) return null;

    // The implied dimension has to be a legal QR size.
    var dimension = Math.round(((legTR + legBL) / 2) / avg) + 7;
    if (dimension < 21 || dimension > 177) return null;

    return sizeSpread + legRatio + Math.abs(cosAngle);
  }

  function tryTriple(bin, f1, f2, f3) {
    var sizes = [f1.size, f2.size, f3.size];
    var avg = (sizes[0] + sizes[1] + sizes[2]) / 3;
    for (var s = 0; s < 3; s++) {
      if (Math.abs(sizes[s] - avg) > avg * 0.6) return null; // not one symbol
    }
    var ord = orderFinders(f1, f2, f3);
    var tl = ord.topLeft, tr = ord.topRight, bl = ord.bottomLeft;

    var moduleSize = avg;
    var distTR = Math.sqrt(Math.pow(tr.x - tl.x, 2) + Math.pow(tr.y - tl.y, 2));
    var distBL = Math.sqrt(Math.pow(bl.x - tl.x, 2) + Math.pow(bl.y - tl.y, 2));
    var dimension = Math.round(((distTR + distBL) / 2) / moduleSize) + 7;
    // Snap to the nearest legal dimension (21, 25, 29, ... 177).
    var mod = (dimension - 17) % 4;
    if (mod !== 0) dimension += mod > 2 ? 4 - mod : -mod;
    if (dimension < 21 || dimension > 177) return null;
    var version = (dimension - 17) / 4;

    // Corner points in grid space, and their image counterparts.
    var srcQuad, dstQuad;
    var alignPositions = qrlib.getAlignmentPatternPositions(version);
    var alignPoint = null;
    if (alignPositions.length >= 2) {
      var expected = applyTransform(
        quadToQuad(
          [3.5, 3.5, dimension - 3.5, 3.5, dimension - 3.5, dimension - 3.5, 3.5, dimension - 3.5],
          [tl.x, tl.y, tr.x, tr.y,
            tr.x + bl.x - tl.x, tr.y + bl.y - tl.y, bl.x, bl.y]
        ) || [1, 0, 0, 0, 1, 0, 0, 0, 1],
        alignPositions[alignPositions.length - 1] + 0.5,
        alignPositions[alignPositions.length - 1] + 0.5
      );
      if (expected) {
        alignPoint = findAlignment(bin, expected.x, expected.y, moduleSize, distTR);
      }
    }

    // Two candidate mappings: one anchored on the bottom-right alignment
    // pattern (handles a tilted view), one assuming a parallelogram (all that
    // is possible on version 1, and fine for a square-on view). Try the better
    // one first and fall back, because a mislocated alignment pattern would
    // otherwise throw away a symbol the simple mapping could have read.
    var candidates = [];
    if (alignPoint) {
      var ap = alignPositions[alignPositions.length - 1] + 0.5;
      candidates.push({
        src: [3.5, 3.5, dimension - 3.5, 3.5, ap, ap, 3.5, dimension - 3.5],
        dst: [tl.x, tl.y, tr.x, tr.y, alignPoint.x, alignPoint.y, bl.x, bl.y]
      });
    }
    candidates.push({
      src: [3.5, 3.5, dimension - 3.5, 3.5, dimension - 3.5, dimension - 3.5, 3.5, dimension - 3.5],
      dst: [tl.x, tl.y, tr.x, tr.y,
        tr.x + bl.x - tl.x, tr.y + bl.y - tl.y, bl.x, bl.y]
    });

    // Two sampling styles as well: the neighbourhood vote steadies noise, but
    // on a blurred photograph of a dense symbol it averages across module
    // boundaries, so a single-pixel read sometimes succeeds where the vote
    // fails. Both are cheap next to giving up on the frame.
    for (var c = 0; c < candidates.length; c++) {
      var transform = quadToQuad(candidates[c].src, candidates[c].dst);
      if (!transform) continue;
      for (var style = 0; style < 2; style++) {
        var matrix = sampleGrid(bin, dimension, transform, style === 0 ? moduleSize : 1);
        if (!matrix) continue;
        var result = decodeMatrix(function (x, y) { return !!matrix[y][x]; }, dimension);
        if (result && result.ok) return result;
      }
    }
    return null;
  }

  function decode(image) {
    var all = decodeImage(image, { all: false });
    return all.length ? all[0] : { ok: false, reason: 'not-found' };
  }

  return {
    decode: decode,
    decodeImage: decodeImage,
    decodeMatrix: decodeMatrix,
    binarize: binarize,
    toLuminance: toLuminance,
    findFinders: findFinders,
    rsDecode: rsDecode
  };
});
