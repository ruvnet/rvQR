/*!
 * qrcode.js — a small, dependency-free QR Code encoder (byte mode).
 *
 * Implements ISO/IEC 18004 QR Code symbol generation. The structure follows the
 * two classic MIT-licensed reference implementations:
 *   - "QR Code generator library" by Project Nayuki (MIT) — algorithmic
 *     alignment-pattern placement, raw-module counting, block splitting, and
 *     penalty scoring are modelled on it.
 *   - "qrcode-generator" by Kazuhiko Arase (MIT) — the overall shape of a tiny
 *     drop-in encoder with a getModule(x, y) accessor.
 * Reimplemented for rvQR; no code copied verbatim from either project.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) Project Nayuki. (https://www.nayuki.io/page/qr-code-generator-library)
 * Copyright (c) 2009 Kazuhiko Arase (https://github.com/kazuhikoarase/qrcode-generator)
 * Copyright (c) 2026 rUv
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRCode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_VERSION = 1;
  var MAX_VERSION = 40;

  // Error correction levels. formatBits is the 2-bit field baked into format info.
  var ECC = {
    L: { name: 'L', ordinal: 0, formatBits: 1 },
    M: { name: 'M', ordinal: 1, formatBits: 0 },
    Q: { name: 'Q', ordinal: 2, formatBits: 3 },
    H: { name: 'H', ordinal: 3, formatBits: 2 }
  };

  // ISO/IEC 18004 Table 13-22, indexed [eccOrdinal][version]; index 0 unused.
  var ECC_CODEWORDS_PER_BLOCK = [
    // 1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];

  var NUM_ERROR_CORRECTION_BLOCKS = [
    // 1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1,  1,  1,  1,  1,  1,  2,  2,  2,  2,  4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1,  1,  1,  1,  2,  2,  4,  4,  4,  5,  5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1,  1,  1,  2,  2,  4,  4,  6,  6,  8,  8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1,  1,  1,  2,  4,  4,  4,  5,  6,  8,  8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];

  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // ---------------------------------------------------------------------------
  // Geometry helpers (derived, not tabulated)
  // ---------------------------------------------------------------------------

  // Total number of data + error-correction modules available in a symbol,
  // i.e. every module that is not part of a function pattern or format/version
  // information.
  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  // Number of 8-bit data codewords (excluding error correction) for a symbol.
  function getNumDataCodewords(ver, ecl) {
    return (
      Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] *
        NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver]
    );
  }

  function getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    var size = ver * 4 + 17;
    var numAlign = Math.floor(ver / 7) + 2;
    var step =
      ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // GF(2^8) arithmetic for Reed-Solomon, primitive polynomial x^8+x^4+x^3+x^2+1
  // ---------------------------------------------------------------------------

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function reedSolomonComputeDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (var j = 0; j < divisor.length; j++) {
        result[j] ^= gfMultiply(divisor[j], factor);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Bit buffer
  // ---------------------------------------------------------------------------

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.append = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  // ---------------------------------------------------------------------------
  // QrCode
  // ---------------------------------------------------------------------------

  function QrCode(version, ecl, dataCodewords, mask) {
    this.version = version;
    this.errorCorrectionLevel = ecl;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }

    this.drawFunctionPatterns();
    var allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    if (mask === -1 || mask === undefined || mask === null) {
      var minPenalty = Infinity;
      for (var i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        var penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          mask = i;
          minPenalty = penalty;
        }
        this.applyMask(i); // XOR is its own inverse
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  QrCode.prototype.getModule = function (x, y) {
    return (
      x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]
    );
  };

  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function () {
    var i, j;
    // Timing patterns
    for (i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    // Finder patterns plus separators
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    // Alignment patterns
    var alignPos = getAlignmentPatternPositions(this.version);
    var numAlign = alignPos.length;
    for (i = 0; i < numAlign; i++) {
      for (j = 0; j < numAlign; j++) {
        // Skip the three corners occupied by finder patterns
        if (
          !(
            (i === 0 && j === 0) ||
            (i === 0 && j === numAlign - 1) ||
            (i === numAlign - 1 && j === 0)
          )
        ) {
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
        }
      }
    }

    // Format and version info (format bits are overwritten later with the
    // real mask; drawing a dummy here reserves the modules).
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrCode.prototype.drawFormatBits = function (mask) {
    var data = (this.errorCorrectionLevel.formatBits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    // First copy: around the top-left finder
    for (var k = 0; k <= 5; k++) this.setFunctionModule(8, k, getBit(bits, k));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (var m = 9; m < 15; m++)
      this.setFunctionModule(14 - m, 8, getBit(bits, m));

    // Second copy: split between bottom-left and top-right
    for (var n = 0; n < 8; n++)
      this.setFunctionModule(this.size - 1 - n, 8, getBit(bits, n));
    for (var p = 8; p < 15; p++)
      this.setFunctionModule(8, this.size - 15 + p, getBit(bits, p));
    this.setFunctionModule(8, this.size - 8, true); // always-dark module
  };

  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = this.size - 11 + (j % 3);
      var b = Math.floor(j / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(
          x + dx,
          y + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1
        );
      }
    }
  };

  // Splits data into blocks, appends Reed-Solomon parity, and interleaves.
  QrCode.prototype.addEccAndInterleave = function (data) {
    var ver = this.version;
    var ecl = this.errorCorrectionLevel;
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      var block = Array.prototype.slice.call(dat);
      if (i < numShortBlocks) block.push(0); // placeholder keeps columns aligned
      for (var e = 0; e < ecc.length; e++) block.push(ecc[e]);
      blocks.push(block);
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var b = 0; b < blocks.length; b++) {
        // Skip the padding slot in short blocks' data section
        if (col !== shortBlockLen - blockEccLen || b >= numShortBlocks) {
          result.push(blocks[b][col]);
        }
      }
    }
    return result;
  };

  // Draws codewords in the standard two-module-wide upward/downward zigzag.
  QrCode.prototype.drawCodewords = function (data) {
    var i = 0; // bit index into data
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
          // Remaining modules stay light; they are still masked below.
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new Error('bad mask');
        }
        if (!this.isFunction[y][x] && invert) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var result = 0;
    var size = this.size;
    var x, y, i;

    // Rule 1 + rule 3, horizontal
    for (y = 0; y < size; y++) {
      var runColor = false, runX = 0;
      var runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }

    // Rule 1 + rule 3, vertical
    for (x = 0; x < size; x++) {
      var runColorV = false, runY = 0;
      var runHistoryV = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (this.modules[y][x] === runColorV) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistoryV);
          if (!runColorV) result += this.finderPenaltyCountPatterns(runHistoryV) * PENALTY_N3;
          runColorV = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColorV, runY, runHistoryV) * PENALTY_N3;
    }

    // Rule 2: 2x2 blocks of one color
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = this.modules[y][x];
        if (
          c === this.modules[y][x + 1] &&
          c === this.modules[y + 1][x] &&
          c === this.modules[y + 1][x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 4: balance of dark modules
    var dark = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    }
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  QrCode.prototype.finderPenaltyCountPatterns = function (runHistory) {
    var n = runHistory[1];
    var core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  };

  QrCode.prototype.finderPenaltyTerminateAndCount = function (
    currentRunColor,
    currentRunLength,
    runHistory
  ) {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size; // add light border
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  };

  QrCode.prototype.finderPenaltyAddHistory = function (
    currentRunLength,
    runHistory
  ) {
    if (runHistory[0] === 0) currentRunLength += this.size; // add light border
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  // ---------------------------------------------------------------------------
  // Public encoding entry points
  // ---------------------------------------------------------------------------

  // Byte-mode segment length in bits for a given version.
  function byteSegmentBits(numBytes, version) {
    var ccBits = version <= 9 ? 8 : 16;
    return 4 + ccBits + numBytes * 8;
  }

  // Largest byte-mode payload (in bytes) that fits a given version + level.
  function byteCapacity(version, ecl) {
    var ccBits = version <= 9 ? 8 : 16;
    return Math.floor((getNumDataCodewords(version, ecl) * 8 - 4 - ccBits) / 8);
  }

  function encodeBytes(bytes, options) {
    options = options || {};
    var ecl = typeof options.ecl === 'string' ? ECC[options.ecl] : options.ecl || ECC.L;
    if (!ecl) throw new Error('unknown error correction level');
    var minVersion = options.minVersion || MIN_VERSION;
    var maxVersion = options.maxVersion || MAX_VERSION;
    var mask = options.mask === undefined ? -1 : options.mask;

    var version = options.version || 0;
    if (version) {
      if (byteSegmentBits(bytes.length, version) > getNumDataCodewords(version, ecl) * 8) {
        throw new Error('data does not fit in requested version');
      }
    } else {
      for (version = minVersion; ; version++) {
        if (version > maxVersion) {
          throw new Error(
            'data too long: ' + bytes.length + ' bytes exceeds capacity ' +
            byteCapacity(maxVersion, ecl) + ' at level ' + ecl.name
          );
        }
        if (byteSegmentBits(bytes.length, version) <= getNumDataCodewords(version, ecl) * 8) {
          break;
        }
      }
    }

    var dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
    var bb = new BitBuffer();
    bb.append(4, 4); // byte mode indicator
    bb.append(bytes.length, version <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.append(bytes[i], 8);

    // Terminator, byte alignment, then alternating pad codewords.
    bb.append(0, Math.min(4, dataCapacityBits - bb.bits.length));
    bb.append(0, (8 - (bb.bits.length % 8)) % 8);
    for (var padByte = 0xec; bb.bits.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      bb.append(padByte, 8);
    }

    var dataCodewords = new Uint8Array(bb.bits.length >>> 3);
    for (var j = 0; j < bb.bits.length; j++) {
      dataCodewords[j >>> 3] |= bb.bits[j] << (7 - (j & 7));
    }

    return new QrCode(version, ecl, dataCodewords, mask);
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function encodeText(text, options) {
    return encodeBytes(utf8Bytes(text), options);
  }

  // Draws a symbol onto a 2D canvas context, snapping to whole device pixels so
  // module edges stay crisp for a camera.
  function drawOnCanvas(qr, canvas, opts) {
    opts = opts || {};
    var quiet = opts.quietZone === undefined ? 4 : opts.quietZone;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var dim = qr.size + quiet * 2;
    var target = opts.size || canvas.width || 512;
    var scale = Math.max(1, Math.floor(target / dim));
    var px = dim * scale;
    canvas.width = px;
    canvas.height = px;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) {
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    }
    return { pixels: px, scale: scale };
  }

  return {
    ECC: ECC,
    encodeText: encodeText,
    encodeBytes: encodeBytes,
    byteCapacity: byteCapacity,
    getNumDataCodewords: getNumDataCodewords,
    getNumRawDataModules: getNumRawDataModules,
    getAlignmentPatternPositions: getAlignmentPatternPositions,
    drawOnCanvas: drawOnCanvas,
    MIN_VERSION: MIN_VERSION,
    MAX_VERSION: MAX_VERSION
  };
});
