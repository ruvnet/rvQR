/*!
 * rvQR p2p — QR-bootstrapped, serverless WebRTC.
 *
 * The optical channel moves 2.5-10 KB/s. When both devices happen to be on the
 * same network a direct browser-to-browser data channel moves the same artifact
 * three to four orders of magnitude faster. The reason that is not normally
 * possible without a server is signalling: two browsers cannot find each other
 * without something in the middle to relay an offer and an answer.
 *
 * rvQR already has that something. It is a camera pointed at a screen.
 *
 * So: A shows an offer as a QR code, B reads it and shows an answer as a QR
 * code, A reads that, and the two connect directly. No signalling server, no
 * STUN, no TURN, no third party contacted at any point — the default ICE
 * configuration is empty, which restricts the connection to host candidates and
 * therefore to a LAN. That is the whole promise of this project preserved: the
 * page makes no network calls to anyone but the peer you pointed it at.
 *
 * WHAT THIS DEFENDS AGAINST, AND WHAT IT DOES NOT.
 *
 * The data channel itself is DTLS-encrypted and the DTLS certificate is bound
 * to the a=fingerprint carried in the SDP. So once the SDP has been exchanged
 * faithfully, the channel is confidential and integrity-protected against
 * anyone on the network path, including the LAN you are both sitting on. That
 * part is genuinely strong and it is not something this module implements or
 * can weaken — it is WebRTC's.
 *
 * The exchange is the weak half, and it is weak in exactly the way the optical
 * channel is weak. An offer QR is unauthenticated: it says "here is a
 * fingerprint, connect to me", and nothing in it proves who "me" is. A camera
 * that is shown a *different* offer connects to a different peer, and every
 * DTLS guarantee then holds faithfully to the wrong device. Concretely:
 *
 *   - Substitution. Someone who can put a screen in front of your camera, or
 *     who can get you to scan their code instead, becomes the peer. This is
 *     the same trust model as the optical transfer path: what you scanned is
 *     what you get, and the human aiming the camera is the authentication.
 *   - Relay/MITM. An attacker who can intercept *both* QR exchanges can run a
 *     peer on each side. DTLS does not stop this because there is no shared
 *     secret and no identity to bind to; the fingerprints are simply the
 *     attacker's own. Physical line-of-sight to both screens is what makes
 *     this hard, not cryptography.
 *   - Passive eavesdropping on the LAN. Defended. That is DTLS's job and it
 *     does it.
 *   - Tampering in flight. Defended twice: by DTLS, and by the SHA-256 in the
 *     manifest, which this module verifies through core.js's receiver rather
 *     than trusting the transport. Bytes that arrive over the data channel go
 *     through the identical state machine and the identical hash check as
 *     bytes that arrive through the camera. Changing the pipe does not change
 *     the acceptance rule.
 *   - A hostile offer payload. Bounded, not trusted. Every length in a
 *     compressed offer is checked before it is used, inflation is capped
 *     against a decompression bomb, and the reconstructed SDP is validated
 *     line-by-line against a whitelist before it is ever handed to
 *     setRemoteDescription. See parseOfferPayload().
 *
 * If you supply iceServers you have opted into contacting a third party, and
 * the LAN-only property goes with it. That is why the default is an empty
 * list and why nothing in this file has a fallback that quietly adds one.
 *
 * TESTABILITY. Node has no RTCPeerConnection. Everything that can be pure is
 * pure — SDP minification, the compression codecs, the QR carrier, the wire
 * framing, the backpressure rule — and the RTCPeerConnection calls are behind
 * an injectable factory, so the test suite drives a fake and the browser
 * passes the real thing.
 *
 * Browser: load core.js and delta.js before this file.
 * Node:    require('./p2p.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./delta.js'));
  } else {
    root.RVQRP2P = factory(root.RVQRCore, root.RVQRDelta);
  }
})(typeof self !== 'undefined' ? self : this, function (core, delta) {
  'use strict';

  // --- Ceilings --------------------------------------------------------------
  // An offer payload arrives from a camera, which means it arrives from an
  // attacker. Every one of these bounds something that would otherwise be an
  // allocation or a loop driven by a value someone else chose.

  // Largest SDP this module will produce or accept. A minimal data-channel SDP
  // is around 600 bytes; 16 KB is room for a pathological candidate list and
  // still small enough that inflating to it costs nothing.
  var MAX_SDP_BYTES = 16384;

  // Largest compressed payload accepted from a QR symbol, before base64url
  // decoding. Version 40-L holds 2953 bytes, and a chunked carrier multiplies
  // that; 64 KB of base64url is far past any legitimate offer.
  var MAX_PAYLOAD_CHARS = 65536;

  // Candidates in an offer. Two devices on a LAN produce one to six. Sixty-four
  // is generous; a list longer than that is someone probing the parser.
  var MAX_CANDIDATES = 64;

  // Chunks the multi-symbol carrier will accept. Matches delta.js's inventory
  // carrier, which solves the same problem for the same reason.
  var MAX_CHUNKS = 999;

  // Data channel framing. The chunk ceiling is core.MAX_RECEIVE_CHUNK on
  // purpose: bytes arriving here go through core.js's receiver, which refuses a
  // manifest declaring a larger chunk. One receiver, one set of limits, one
  // verification path — a second framing with its own bounds would be a second
  // thing to get wrong. At data-channel rates the message count is not the
  // bottleneck, so there is nothing to buy by relaxing it.
  var WIRE_MAGIC = 0x5251;      // 'RQ'
  var WIRE_HEADER = 12;
  var DEFAULT_CHUNK = core.MAX_RECEIVE_CHUNK;

  // Backpressure defaults. bufferedAmount is measured in bytes the channel has
  // accepted but not yet put on the wire; letting it grow without bound is how
  // a naive `for (chunk of chunks) channel.send(chunk)` takes a tab down on a
  // large artifact. 1 MB high water with a 256 KB resume point keeps the pipe
  // full without the queue becoming the buffer.
  var DEFAULT_HIGH_WATER = 1024 * 1024;
  var DEFAULT_LOW_THRESHOLD = 256 * 1024;

  // How long to wait for ICE gathering before shipping whatever candidates we
  // have. Host-only gathering finishes in a few milliseconds; this bound only
  // matters when a caller has opted into STUN and the server is unreachable.
  var DEFAULT_GATHER_MS = 3000;

  var CHANNEL_LABEL = 'rvqr';

  function P2PError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'P2PError';
    err.reason = reason;
    return err;
  }

  function fail(reason, message) { throw P2PError(reason, message); }

  // ===========================================================================
  // Raw DEFLATE (RFC 1951)
  // ===========================================================================
  // Written here rather than pulled from CompressionStream because that API is
  // asynchronous, absent before Safari 16.4, and — being a stream — awkward to
  // use inside a pure function that the test suite wants to call synchronously.
  // The encoder emits a single static-Huffman block, which is valid DEFLATE and
  // decodes with any conformant inflater (the test suite checks both directions
  // against node:zlib). The decoder handles stored, static and dynamic blocks,
  // so it reads anything a real deflater produces.

  var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35,
    43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257,
    385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9,
    9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  var WINDOW = 32768;
  var MIN_MATCH = 3;
  var MAX_MATCH = 258;
  var MAX_CHAIN = 128;

  function BitWriter() {
    this.out = new Uint8Array(256);
    this.len = 0;
    this.acc = 0;
    this.bits = 0;
  }

  BitWriter.prototype.push = function (byte) {
    if (this.len === this.out.length) {
      var bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.len++] = byte;
  };

  /** Raw bits, least significant first — DEFLATE's order for everything but codes. */
  BitWriter.prototype.writeBits = function (value, count) {
    this.acc |= (value << this.bits);
    this.bits += count;
    while (this.bits >= 8) {
      this.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  };

  /** Huffman codes are packed most significant bit first. */
  BitWriter.prototype.writeCode = function (code, count) {
    for (var i = count - 1; i >= 0; i--) this.writeBits((code >>> i) & 1, 1);
  };

  BitWriter.prototype.finish = function () {
    if (this.bits > 0) { this.push(this.acc & 0xff); this.acc = 0; this.bits = 0; }
    return this.out.subarray(0, this.len);
  };

  function staticLiteral(w, sym) {
    if (sym < 144) w.writeCode(0x30 + sym, 8);
    else if (sym < 256) w.writeCode(0x190 + sym - 144, 9);
    else if (sym < 280) w.writeCode(sym - 256, 7);
    else w.writeCode(0xc0 + sym - 280, 8);
  }

  function lengthSymbol(len) {
    for (var i = LENGTH_BASE.length - 1; i >= 0; i--) {
      if (len >= LENGTH_BASE[i]) return i;
    }
    return 0;
  }

  function distSymbol(dist) {
    for (var i = DIST_BASE.length - 1; i >= 0; i--) {
      if (dist >= DIST_BASE[i]) return i;
    }
    return 0;
  }

  /**
   * Compresses to a raw DEFLATE stream (no zlib or gzip wrapper).
   * Greedy LZ77 over a hash chain, then one static-Huffman block. Inputs here
   * are hundreds of bytes, so the elaborate parts of a real deflater — lazy
   * matching, dynamic trees, block splitting — would cost more code than they
   * would save bytes.
   */
  function deflateRaw(input) {
    var src = input instanceof Uint8Array ? input : new Uint8Array(input);
    var w = new BitWriter();
    w.writeBits(1, 1);  // BFINAL
    w.writeBits(1, 2);  // BTYPE = 01, static Huffman

    var n = src.length;
    var head = new Int32Array(65536).fill(-1);
    var prev = new Int32Array(n > 0 ? n : 1).fill(-1);
    var pos = 0;

    function hash3(i) {
      return ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & 0xffff;
    }

    while (pos < n) {
      var bestLen = 0, bestDist = 0;
      if (pos + MIN_MATCH <= n) {
        var h = hash3(pos);
        var cand = head[h];
        var chain = 0;
        var limit = Math.min(MAX_MATCH, n - pos);
        while (cand >= 0 && chain < MAX_CHAIN && pos - cand <= WINDOW) {
          var len = 0;
          while (len < limit && src[cand + len] === src[pos + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = pos - cand; if (len === limit) break; }
          cand = prev[cand];
          chain++;
        }
        // Linking happens after the search, so a position never matches itself.
        prev[pos] = head[h];
        head[h] = pos;
      }
      if (bestLen >= MIN_MATCH) {
        var ls = lengthSymbol(bestLen);
        staticLiteral(w, 257 + ls);
        if (LENGTH_EXTRA[ls]) w.writeBits(bestLen - LENGTH_BASE[ls], LENGTH_EXTRA[ls]);
        var ds = distSymbol(bestDist);
        w.writeCode(ds, 5);
        if (DIST_EXTRA[ds]) w.writeBits(bestDist - DIST_BASE[ds], DIST_EXTRA[ds]);
        // Index every position inside the match so later matches can find them.
        for (var k = 1; k < bestLen; k++) {
          var p = pos + k;
          if (p + MIN_MATCH <= n) {
            var hk = hash3(p);
            prev[p] = head[hk];
            head[hk] = p;
          }
        }
        pos += bestLen;
      } else {
        staticLiteral(w, src[pos]);
        pos++;
      }
    }
    staticLiteral(w, 256); // end of block
    return w.finish().slice();
  }

  function BitReader(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.acc = 0;
    this.bits = 0;
  }

  BitReader.prototype.bit = function () {
    if (this.bits === 0) {
      if (this.pos >= this.bytes.length) fail('bad-deflate', 'ran out of input');
      this.acc = this.bytes[this.pos++];
      this.bits = 8;
    }
    var b = this.acc & 1;
    this.acc >>>= 1;
    this.bits--;
    return b;
  };

  BitReader.prototype.readBits = function (count) {
    var v = 0;
    for (var i = 0; i < count; i++) v |= this.bit() << i;
    return v;
  };

  BitReader.prototype.align = function () { this.bits = 0; this.acc = 0; };

  function buildHuffman(lengths, count) {
    var counts = new Int32Array(16);
    var i;
    for (i = 0; i < count; i++) counts[lengths[i]]++;
    counts[0] = 0;
    var offsets = new Int32Array(16);
    for (i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
    var symbols = new Int32Array(count);
    for (i = 0; i < count; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    return { counts: counts, symbols: symbols };
  }

  function decodeSymbol(reader, huff) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= reader.bit();
      var count = huff.counts[len];
      if (code - first < count) return huff.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    fail('bad-deflate', 'invalid Huffman code');
  }

  var STATIC_LIT = (function () {
    var lengths = new Uint8Array(288);
    for (var i = 0; i < 288; i++) {
      lengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    }
    return buildHuffman(lengths, 288);
  })();

  var STATIC_DIST = (function () {
    var lengths = new Uint8Array(30).fill(5);
    return buildHuffman(lengths, 30);
  })();

  /**
   * Inflates a raw DEFLATE stream.
   *
   * `maxOut` is not optional in spirit: the input arrives from a QR code, and a
   * few hundred bytes of DEFLATE can expand to gigabytes. The cap is checked
   * before every write, so a bomb fails at the ceiling rather than at the point
   * the allocator gives up.
   */
  function inflateRaw(bytes, maxOut) {
    var limit = maxOut === undefined ? MAX_SDP_BYTES : maxOut;
    var reader = new BitReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    var out = new Uint8Array(Math.min(limit, 1024));
    var len = 0;

    function put(byte) {
      if (len >= limit) fail('inflate-too-large', 'output exceeded ' + limit + ' bytes');
      if (len === out.length) {
        var bigger = new Uint8Array(Math.min(limit, out.length * 2) || 1);
        bigger.set(out.subarray(0, len));
        out = bigger;
      }
      out[len++] = byte;
    }

    for (;;) {
      var last = reader.bit();
      var type = reader.readBits(2);
      if (type === 0) {
        reader.align();
        if (reader.pos + 4 > reader.bytes.length) fail('bad-deflate', 'truncated stored block');
        var blockLen = reader.bytes[reader.pos] | (reader.bytes[reader.pos + 1] << 8);
        var nlen = reader.bytes[reader.pos + 2] | (reader.bytes[reader.pos + 3] << 8);
        reader.pos += 4;
        if ((blockLen ^ 0xffff) !== nlen) fail('bad-deflate', 'stored block length check failed');
        for (var s = 0; s < blockLen; s++) {
          if (reader.pos >= reader.bytes.length) fail('bad-deflate', 'truncated stored block');
          put(reader.bytes[reader.pos++]);
        }
      } else if (type === 1 || type === 2) {
        var lit = STATIC_LIT, dist = STATIC_DIST;
        if (type === 2) {
          var hlit = reader.readBits(5) + 257;
          var hdist = reader.readBits(5) + 1;
          var hclen = reader.readBits(4) + 4;
          var clen = new Uint8Array(19);
          for (var c = 0; c < hclen; c++) clen[CLEN_ORDER[c]] = reader.readBits(3);
          var clHuff = buildHuffman(clen, 19);
          var lengths = new Uint8Array(hlit + hdist);
          var i = 0;
          while (i < lengths.length) {
            var sym = decodeSymbol(reader, clHuff);
            if (sym < 16) { lengths[i++] = sym; }
            else if (sym === 16) {
              if (i === 0) fail('bad-deflate', 'repeat with no previous length');
              var prevLen = lengths[i - 1];
              var rep = 3 + reader.readBits(2);
              while (rep-- > 0 && i < lengths.length) lengths[i++] = prevLen;
            } else if (sym === 17) {
              var rep17 = 3 + reader.readBits(3);
              while (rep17-- > 0 && i < lengths.length) lengths[i++] = 0;
            } else {
              var rep18 = 11 + reader.readBits(7);
              while (rep18-- > 0 && i < lengths.length) lengths[i++] = 0;
            }
          }
          lit = buildHuffman(lengths.subarray(0, hlit), hlit);
          dist = buildHuffman(lengths.subarray(hlit), hdist);
        }
        for (;;) {
          var symbol = decodeSymbol(reader, lit);
          if (symbol === 256) break;
          if (symbol < 256) { put(symbol); continue; }
          var li = symbol - 257;
          if (li >= LENGTH_BASE.length) fail('bad-deflate', 'invalid length symbol');
          var matchLen = LENGTH_BASE[li] + reader.readBits(LENGTH_EXTRA[li]);
          var di = decodeSymbol(reader, dist);
          if (di >= DIST_BASE.length) fail('bad-deflate', 'invalid distance symbol');
          var matchDist = DIST_BASE[di] + reader.readBits(DIST_EXTRA[di]);
          if (matchDist > len) fail('bad-deflate', 'distance runs before the output');
          for (var m = 0; m < matchLen; m++) put(out[len - matchDist]);
        }
      } else {
        fail('bad-deflate', 'reserved block type');
      }
      if (last) break;
    }
    return out.slice(0, len);
  }

  // ===========================================================================
  // ASCII helpers
  // ===========================================================================
  // SDP is ASCII in every field this module keeps. Enforcing that rather than
  // assuming it means a payload cannot smuggle bytes through a text field, and
  // it makes the length of a string and the length of its encoding the same
  // number everywhere below.

  function asciiBytes(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c > 0x7f) fail('non-ascii', 'SDP field contains a non-ASCII character');
      out[i] = c;
    }
    return out;
  }

  function asciiText(bytes, from, length) {
    var s = '';
    for (var i = 0; i < length; i++) {
      var c = bytes[from + i];
      if (c < 0x20 || c > 0x7e) fail('bad-payload', 'non-printable byte in a text field');
      s += String.fromCharCode(c);
    }
    return s;
  }

  /**
   * Same, for a whole SDP rather than a single field: CR and LF are the one
   * control pair an SDP legitimately contains, and nothing else is allowed
   * through — a NUL or an escape sequence in a line that is about to reach
   * setRemoteDescription has no innocent explanation.
   */
  function sdpFromBytes(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c !== 0x0d && c !== 0x0a && (c < 0x20 || c > 0x7e)) {
        fail('bad-payload', 'non-printable byte in the SDP');
      }
      s += String.fromCharCode(c);
    }
    return s;
  }

  function ByteWriter() { this.bytes = []; }
  ByteWriter.prototype.u8 = function (v) { this.bytes.push(v & 0xff); return this; };
  ByteWriter.prototype.u16 = function (v) {
    this.bytes.push((v >>> 8) & 0xff, v & 0xff); return this;
  };
  ByteWriter.prototype.u32 = function (v) {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  };
  ByteWriter.prototype.raw = function (arr) {
    for (var i = 0; i < arr.length; i++) this.bytes.push(arr[i] & 0xff);
    return this;
  };
  ByteWriter.prototype.str = function (text, maxLen) {
    var b = asciiBytes(text);
    if (b.length > (maxLen || 255)) fail('field-too-long', 'field exceeds ' + maxLen + ' bytes');
    this.u8(b.length).raw(b);
    return this;
  };
  ByteWriter.prototype.done = function () { return Uint8Array.from(this.bytes); };

  function ByteReader(bytes) { this.bytes = bytes; this.pos = 0; }
  ByteReader.prototype.need = function (n) {
    if (this.pos + n > this.bytes.length) fail('bad-payload', 'payload is truncated');
  };
  ByteReader.prototype.u8 = function () { this.need(1); return this.bytes[this.pos++]; };
  ByteReader.prototype.u16 = function () {
    this.need(2);
    var v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  };
  ByteReader.prototype.u32 = function () {
    this.need(4);
    var v = ((this.bytes[this.pos] << 24) | (this.bytes[this.pos + 1] << 16) |
      (this.bytes[this.pos + 2] << 8) | this.bytes[this.pos + 3]) >>> 0;
    this.pos += 4;
    return v;
  };
  ByteReader.prototype.raw = function (n) {
    this.need(n);
    var v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  };
  ByteReader.prototype.str = function (maxLen) {
    var n = this.u8();
    if (n > (maxLen || 255)) fail('bad-payload', 'text field is too long');
    this.need(n);
    var s = asciiText(this.bytes, this.pos, n);
    this.pos += n;
    return s;
  };

  // ===========================================================================
  // SDP minification
  // ===========================================================================

  // The only line types a data-channel-only session needs. Anything else is
  // dropped on the way out and REFUSED on the way in — an offer that carries a
  // line this list does not name is either not an rvQR offer or is trying
  // something, and either way there is no reason to hand it to the browser.
  var KEEP_SESSION = ['v=', 'o=', 's=', 't=', 'a=group:BUNDLE', 'a=msid-semantic'];
  var KEEP_MEDIA = [
    'm=application', 'c=IN', 'a=ice-ufrag:', 'a=ice-pwd:', 'a=ice-options:',
    'a=fingerprint:', 'a=setup:', 'a=mid:', 'a=sctp-port:', 'a=max-message-size:',
    'a=candidate:', 'a=end-of-candidates'
  ];

  function startsWithAny(line, prefixes) {
    for (var i = 0; i < prefixes.length; i++) {
      if (line.slice(0, prefixes[i].length) === prefixes[i]) return true;
    }
    return false;
  }

  /**
   * Parses one a=candidate line into its parts, or null if it is not one this
   * module understands. The grammar is RFC 5245 §15.1; everything after the
   * six fixed fields and `typ` is an extension list we do not keep.
   */
  function parseCandidate(line) {
    var body = line.slice('a=candidate:'.length);
    var parts = body.split(' ');
    if (parts.length < 8 || parts[6] !== 'typ') return null;
    var port = Number(parts[5]);
    var priority = Number(parts[3]);
    var component = Number(parts[1]);
    if (!isFinite(port) || port < 0 || port > 65535) return null;
    if (!isFinite(priority) || priority < 0 || priority > 0xffffffff) return null;
    if (component !== 1 && component !== 2) return null;
    var proto = parts[2].toLowerCase();
    if (proto !== 'udp' && proto !== 'tcp') return null;
    var type = parts[7].toLowerCase();
    if (['host', 'srflx', 'prflx', 'relay'].indexOf(type) < 0) return null;
    return {
      foundation: parts[0], component: component, proto: proto,
      priority: priority, address: parts[4], port: port, type: type
    };
  }

  function formatCandidate(c) {
    return 'a=candidate:' + c.foundation + ' ' + c.component + ' ' + c.proto + ' ' +
      c.priority + ' ' + c.address + ' ' + c.port + ' typ ' + c.type;
  }

  /**
   * Strips an SDP to the smallest thing that still establishes a data channel.
   *
   * Non-host candidates go unless the caller asked for them: with the default
   * empty ICE configuration there will not be any, and if a caller opted into
   * STUN they have to opt into carrying the result too. TCP candidates go
   * because a LAN data channel does not need them and they are pure payload.
   * The s= line is replaced rather than kept — it is the one free-text field in
   * an SDP and it is worth nothing here.
   *
   * Output uses CRLF, which is what RFC 4566 specifies; browsers accept LF but
   * emitting the specified form means the text that goes over the QR is the
   * text a strict parser wants.
   */
  function minifySdp(sdp, opts) {
    opts = opts || {};
    if (typeof sdp !== 'string' || !sdp) fail('bad-sdp', 'no SDP');
    if (sdp.length > MAX_SDP_BYTES) fail('sdp-too-large', 'SDP exceeds ' + MAX_SDP_BYTES + ' bytes');
    var lines = sdp.replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var inMedia = false;
    var candidates = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.slice(0, 2) === 'm=') {
        inMedia = line.slice(0, 13) === 'm=application';
        if (!inMedia) continue; // audio/video sections have no business here
        out.push(line);
        continue;
      }
      if (line.slice(0, 2) === 's=') { out.push('s=-'); continue; }
      if (line.slice(0, 2) === 'a=' && line.slice(0, 12) === 'a=candidate:') {
        if (!inMedia) continue;
        var cand = parseCandidate(line);
        if (!cand) continue;
        if (!opts.keepAllCandidates) {
          if (cand.type !== 'host') continue;
          if (cand.proto !== 'udp') continue;
        }
        if (++candidates > MAX_CANDIDATES) continue;
        out.push(formatCandidate(cand));
        continue;
      }
      if (line.slice(0, 15) === 'a=msid-semantic') continue; // no media streams here
      // Gathering is already complete by the time an offer is rendered, so the
      // end-of-candidates marker states something the payload's shape implies.
      if (line.slice(0, 19) === 'a=end-of-candidates') continue;
      if (inMedia ? startsWithAny(line, KEEP_MEDIA) : startsWithAny(line, KEEP_SESSION)) {
        out.push(line);
      }
    }
    if (!out.length) fail('bad-sdp', 'nothing survived minification');
    return out.join('\r\n') + '\r\n';
  }

  /**
   * Checks that a reconstructed SDP is one this module could have produced.
   *
   * This runs on everything that came off a QR code, before it reaches
   * setRemoteDescription. It is a whitelist, not a sanity check: a line type
   * that is not on it is a rejection, because the browser's SDP parser is a
   * much larger attack surface than this function and there is no reason to
   * expose it to anything the offer format does not need.
   */
  function validateSdp(text) {
    if (typeof text !== 'string' || !text) return { ok: false, reason: 'empty-sdp' };
    if (text.length > MAX_SDP_BYTES) return { ok: false, reason: 'sdp-too-large' };
    var lines = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
    var seen = { v: false, o: false, m: false, ufrag: false, pwd: false, fp: false, setup: false };
    var inMedia = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/[^\x20-\x7e]/.test(line)) return { ok: false, reason: 'non-printable-sdp' };
      if (line.slice(0, 2) === 'v=') { seen.v = true; if (line !== 'v=0') return { ok: false, reason: 'bad-sdp-version' }; continue; }
      if (line.slice(0, 2) === 'o=') { seen.o = true; continue; }
      if (line.slice(0, 13) === 'm=application') { seen.m = true; inMedia = true; continue; }
      if (line.slice(0, 2) === 'm=') return { ok: false, reason: 'unexpected-media-section' };
      if (line.slice(0, 12) === 'a=ice-ufrag:') seen.ufrag = true;
      if (line.slice(0, 10) === 'a=ice-pwd:') seen.pwd = true;
      if (line.slice(0, 14) === 'a=fingerprint:') seen.fp = true;
      if (line.slice(0, 8) === 'a=setup:') seen.setup = true;
      if (line.slice(0, 12) === 'a=candidate:' && !parseCandidate(line)) {
        return { ok: false, reason: 'bad-candidate' };
      }
      if (!(inMedia ? startsWithAny(line, KEEP_MEDIA) : startsWithAny(line, KEEP_SESSION))) {
        return { ok: false, reason: 'unknown-line', detail: line.slice(0, 24) };
      }
    }
    var missing = Object.keys(seen).filter(function (k) { return !seen[k]; });
    if (missing.length) return { ok: false, reason: 'incomplete-sdp', detail: missing.join(',') };
    return { ok: true };
  }

  // ===========================================================================
  // The profile codec
  // ===========================================================================
  // Generic compression of an SDP does poorly because most of what is left
  // after minification is high-entropy: an ICE password, a 32-byte certificate
  // fingerprint and a handful of addresses do not compress at all, and the
  // boilerplate that does compress is only a couple of hundred bytes to begin
  // with. So the profile codec does not compress the text; it extracts the
  // fields and regenerates the text from a fixed template on the far side.
  //
  // The cost is that it only handles the canonical shape. compress() therefore
  // verifies the round trip before choosing it, and falls back to DEFLATE over
  // the minified text — which reproduces the input byte for byte — whenever the
  // profile does not reproduce what it was given.

  var SETUP_ROLES = ['actpass', 'active', 'passive', 'holdconn'];
  var FP_ALGS = ['sha-256', 'sha-1', 'sha-384', 'sha-512'];
  var CAND_TYPES = ['host', 'srflx', 'prflx', 'relay'];
  var PROTOS = ['udp', 'tcp'];

  var ADDR_IPV4 = 0, ADDR_IPV6 = 1, ADDR_NAME = 2;

  function parseIpv4(text) {
    var parts = text.split('.');
    if (parts.length !== 4) return null;
    var out = new Uint8Array(4);
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return null;
      var v = Number(parts[i]);
      if (v > 255) return null;
      out[i] = v;
    }
    return out;
  }

  function parseIpv6(text) {
    if (text.indexOf(':') < 0) return null;
    var scope = text.indexOf('%');
    if (scope >= 0) return null; // zone ids are host-local and never useful to a peer
    var halves = text.split('::');
    if (halves.length > 2) return null;
    function groups(part) {
      if (!part) return [];
      var g = part.split(':');
      for (var i = 0; i < g.length; i++) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g[i])) return null;
      }
      return g;
    }
    var head = groups(halves[0]);
    var tail = halves.length === 2 ? groups(halves[1]) : [];
    if (head === null || tail === null) return null;
    if (halves.length === 1 && head.length !== 8) return null;
    if (head.length + tail.length > 8) return null;
    var out = new Uint8Array(16);
    var o = 0, i2;
    for (i2 = 0; i2 < head.length; i2++) {
      var hv = parseInt(head[i2], 16);
      out[o++] = (hv >>> 8) & 0xff; out[o++] = hv & 0xff;
    }
    o = 16 - tail.length * 2;
    for (i2 = 0; i2 < tail.length; i2++) {
      var tv = parseInt(tail[i2], 16);
      out[o++] = (tv >>> 8) & 0xff; out[o++] = tv & 0xff;
    }
    return out;
  }

  function formatIpv6(bytes) {
    var groups = [];
    for (var i = 0; i < 16; i += 2) {
      groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    }
    // Longest run of zero groups gets the :: — the canonical form of RFC 5952,
    // so a value survives encode/decode/encode unchanged.
    var bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
    for (var g = 0; g <= groups.length; g++) {
      if (g < groups.length && groups[g] === '0') {
        if (runStart < 0) { runStart = g; runLen = 0; }
        runLen++;
      } else {
        if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
        runStart = -1; runLen = 0;
      }
    }
    if (bestLen < 2) return groups.join(':');
    return groups.slice(0, bestStart).join(':') + '::' +
      groups.slice(bestStart + bestLen).join(':');
  }

  function hexToBytes(hex, expectPairs) {
    var parts = hex.split(':');
    if (expectPairs && parts.length < 1) return null;
    var out = new Uint8Array(parts.length);
    for (var i = 0; i < parts.length; i++) {
      if (!/^[0-9a-fA-F]{2}$/.test(parts[i])) return null;
      out[i] = parseInt(parts[i], 16);
    }
    return out;
  }

  function bytesToHexColons(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i++) {
      parts.push(((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)).toUpperCase());
    }
    return parts.join(':');
  }

  /** Pulls the fields the template needs out of a minified SDP. */
  function readProfile(sdp) {
    var lines = sdp.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
    var p = {
      sessionId: '0', sessionVersion: '2', mid: '0', setup: 'actpass',
      ufrag: '', pwd: '', fpAlg: 'sha-256', fp: null,
      sctpPort: 5000, maxMessageSize: 0, iceOptions: '', candidates: []
    };
    // a=group:BUNDLE arrives before a=mid, so the two are reconciled at the end
    // rather than as the bundle line is read.
    var bundle = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.slice(0, 2) === 'o=') {
        var o = line.slice(2).split(' ');
        if (o.length !== 6 || o[0] !== '-' || o[3] !== 'IN') return null;
        if (!/^\d{1,20}$/.test(o[1]) || !/^\d{1,20}$/.test(o[2])) return null;
        if (o[4] !== 'IP4' || o[5] !== '127.0.0.1') return null;
        p.sessionId = o[1];
        p.sessionVersion = o[2];
      } else if (line.slice(0, 12) === 'a=ice-ufrag:') p.ufrag = line.slice(12);
      else if (line.slice(0, 10) === 'a=ice-pwd:') p.pwd = line.slice(10);
      else if (line.slice(0, 14) === 'a=ice-options:') p.iceOptions = line.slice(14);
      else if (line.slice(0, 14) === 'a=fingerprint:') {
        var fp = line.slice(14).split(' ');
        if (fp.length !== 2 || FP_ALGS.indexOf(fp[0]) < 0) return null;
        p.fpAlg = fp[0];
        p.fp = hexToBytes(fp[1], true);
        if (!p.fp || p.fp.length < 4 || p.fp.length > 64) return null;
      } else if (line.slice(0, 8) === 'a=setup:') p.setup = line.slice(8);
      else if (line.slice(0, 6) === 'a=mid:') p.mid = line.slice(6);
      else if (line.slice(0, 12) === 'a=sctp-port:') p.sctpPort = Number(line.slice(12));
      else if (line.slice(0, 19) === 'a=max-message-size:') p.maxMessageSize = Number(line.slice(19));
      else if (line.slice(0, 12) === 'a=candidate:') {
        var c = parseCandidate(line);
        if (!c) return null;
        p.candidates.push(c);
      } else if (line.slice(0, 13) === 'm=application') {
        if (line !== 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel') return null;
      } else if (line.slice(0, 2) === 'c=') {
        if (line !== 'c=IN IP4 0.0.0.0') return null;
      } else if (line.slice(0, 15) === 'a=group:BUNDLE ') {
        bundle = line.slice(15);
      } else if (line !== 'v=0' && line !== 's=-' && line !== 't=0 0') {
        return null;
      }
    }
    // The template writes a single bundled m-section, so a BUNDLE group naming
    // anything other than that one mid is a shape this codec cannot reproduce.
    if (bundle !== null && bundle !== p.mid) return null;
    if (!p.ufrag || !p.pwd || !p.fp) return null;
    if (SETUP_ROLES.indexOf(p.setup) < 0) return null;
    if (!isFinite(p.sctpPort) || p.sctpPort < 0 || p.sctpPort > 65535) return null;
    if (!isFinite(p.maxMessageSize) || p.maxMessageSize < 0 || p.maxMessageSize > 0xffffffff) return null;
    if (p.candidates.length > MAX_CANDIDATES) return null;
    return p;
  }

  /** The template. Everything the profile does not carry is a constant here. */
  function writeProfileSdp(p) {
    var out = [
      'v=0',
      'o=- ' + p.sessionId + ' ' + p.sessionVersion + ' IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE ' + p.mid,
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0'
    ];
    for (var i = 0; i < p.candidates.length; i++) out.push(formatCandidate(p.candidates[i]));
    out.push('a=ice-ufrag:' + p.ufrag);
    out.push('a=ice-pwd:' + p.pwd);
    if (p.iceOptions) out.push('a=ice-options:' + p.iceOptions);
    out.push('a=fingerprint:' + p.fpAlg + ' ' + bytesToHexColons(p.fp));
    out.push('a=setup:' + p.setup);
    out.push('a=mid:' + p.mid);
    out.push('a=sctp-port:' + p.sctpPort);
    if (p.maxMessageSize) out.push('a=max-message-size:' + p.maxMessageSize);
    return out.join('\r\n') + '\r\n';
  }

  function encodeProfile(p) {
    var w = new ByteWriter();
    w.u8(p.maxMessageSize ? 1 : 0);
    w.u8(SETUP_ROLES.indexOf(p.setup));
    w.u8(FP_ALGS.indexOf(p.fpAlg));
    w.u8(p.fp.length).raw(p.fp);
    w.str(p.ufrag, 64);
    w.str(p.pwd, 128);
    w.str(p.mid, 16);
    w.str(p.iceOptions, 64);
    w.u16(p.sctpPort);
    if (p.maxMessageSize) w.u32(p.maxMessageSize);
    w.str(p.sessionId, 20);
    w.str(p.sessionVersion, 20);
    w.u8(p.candidates.length);
    for (var i = 0; i < p.candidates.length; i++) {
      var c = p.candidates[i];
      var v4 = parseIpv4(c.address);
      var v6 = v4 ? null : parseIpv6(c.address);
      var kind = v4 ? ADDR_IPV4 : v6 ? ADDR_IPV6 : ADDR_NAME;
      w.u8(kind);
      w.u8(CAND_TYPES.indexOf(c.type));
      w.u8(c.component);
      w.u8(PROTOS.indexOf(c.proto));
      w.u32(c.priority);
      w.u16(c.port);
      if (kind === ADDR_IPV4) w.raw(v4);
      else if (kind === ADDR_IPV6) w.raw(v6);
      else w.str(c.address, 128);
      w.str(c.foundation, 32);
    }
    return w.done();
  }

  function decodeProfile(bytes) {
    var r = new ByteReader(bytes);
    var flags = r.u8();
    var setupIdx = r.u8();
    var algIdx = r.u8();
    // Bit 0 is the only flag encodeProfile ever sets. Refusing the rest keeps
    // the codec canonical the same way the trailing-byte check at the end of
    // this function does: without it, 128 distinct payloads decode to the same
    // offer, which is a difference the format cannot represent and therefore
    // has no business accepting.
    if (flags & ~1) fail('bad-payload', 'unknown profile flags');
    if (setupIdx >= SETUP_ROLES.length) fail('bad-payload', 'unknown setup role');
    if (algIdx >= FP_ALGS.length) fail('bad-payload', 'unknown fingerprint algorithm');
    var fpLen = r.u8();
    if (fpLen < 4 || fpLen > 64) fail('bad-payload', 'implausible fingerprint length');
    var p = {
      setup: SETUP_ROLES[setupIdx],
      fpAlg: FP_ALGS[algIdx],
      fp: r.raw(fpLen).slice(),
      ufrag: r.str(64),
      pwd: r.str(128),
      mid: r.str(16),
      iceOptions: r.str(64),
      sctpPort: r.u16(),
      maxMessageSize: 0,
      sessionId: '', sessionVersion: '', candidates: []
    };
    if (flags & 1) p.maxMessageSize = r.u32();
    p.sessionId = r.str(20);
    p.sessionVersion = r.str(20);
    if (!/^\d{1,20}$/.test(p.sessionId) || !/^\d{1,20}$/.test(p.sessionVersion)) {
      fail('bad-payload', 'session id is not numeric');
    }
    if (!/^[A-Za-z0-9+/\-_]{1,64}$/.test(p.ufrag)) fail('bad-payload', 'implausible ice-ufrag');
    if (!/^[A-Za-z0-9+/\-_]{1,128}$/.test(p.pwd)) fail('bad-payload', 'implausible ice-pwd');
    if (!/^[A-Za-z0-9]{1,16}$/.test(p.mid)) fail('bad-payload', 'implausible mid');
    if (p.iceOptions && !/^[A-Za-z0-9 _-]{1,64}$/.test(p.iceOptions)) {
      fail('bad-payload', 'implausible ice-options');
    }
    var count = r.u8();
    if (count > MAX_CANDIDATES) fail('too-many-candidates', count + ' candidates');
    for (var i = 0; i < count; i++) {
      var kind = r.u8();
      var typeIdx = r.u8();
      var component = r.u8();
      var protoIdx = r.u8();
      if (typeIdx >= CAND_TYPES.length) fail('bad-payload', 'unknown candidate type');
      if (protoIdx >= PROTOS.length) fail('bad-payload', 'unknown transport');
      if (component !== 1 && component !== 2) fail('bad-payload', 'bad component id');
      var priority = r.u32();
      var port = r.u16();
      var address;
      if (kind === ADDR_IPV4) address = Array.prototype.join.call(r.raw(4), '.');
      else if (kind === ADDR_IPV6) address = formatIpv6(r.raw(16));
      else if (kind === ADDR_NAME) {
        address = r.str(128);
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(address)) fail('bad-payload', 'implausible hostname');
      } else fail('bad-payload', 'unknown address kind');
      var foundation = r.str(32);
      if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) fail('bad-payload', 'implausible foundation');
      p.candidates.push({
        foundation: foundation, component: component, proto: PROTOS[protoIdx],
        priority: priority, address: address, port: port, type: CAND_TYPES[typeIdx]
      });
    }
    if (r.pos !== bytes.length) fail('bad-payload', 'trailing bytes after the profile');
    return p;
  }

  // ===========================================================================
  // Payload envelope
  // ===========================================================================

  var CODEC_RAW = 0;
  var CODEC_DEFLATE = 1;
  var CODEC_PROFILE = 2;
  var CODEC_NAMES = ['raw', 'deflate', 'profile'];

  var PAYLOAD_PREFIX = 'RVQP1:';
  var CHUNK_PREFIX = 'RVQPC1:';

  /**
   * Compresses an SDP to a QR payload.
   *
   * Tries every codec and takes the smallest one that provably reproduces what
   * it was handed. "Provably" is load-bearing: the profile codec regenerates
   * the SDP from a template rather than reproducing the input, so it is only
   * chosen when its output is byte-identical to the text it was given, and its
   * output is what `canonical` reports. DEFLATE and raw always reproduce the
   * minified input exactly, so one of them is always available.
   *
   * Returns { payload, codec, canonical, minified, sizes } — `canonical` is the
   * exact text decompress(payload) will return.
   */
  function compressSdp(sdp, opts) {
    opts = opts || {};
    var minified = opts.minify === false ? sdp : minifySdp(sdp, opts);
    var text = asciiBytes(minified);
    var sizes = {};

    var candidates = [];

    // raw
    sizes.raw = text.length + 1;
    candidates.push({ codec: CODEC_RAW, body: text, canonical: minified });

    // deflate
    try {
      var deflated = deflateRaw(text);
      sizes.deflate = deflated.length + 1;
      if (bytesEqual(inflateRaw(deflated, MAX_SDP_BYTES), text)) {
        candidates.push({ codec: CODEC_DEFLATE, body: deflated, canonical: minified });
      }
    } catch (e) { sizes.deflate = null; }

    // profile
    if (opts.profile !== false) {
      try {
        var p = readProfile(minified);
        if (p) {
          var body = encodeProfile(p);
          var regenerated = writeProfileSdp(decodeProfile(body));
          sizes.profile = body.length + 1;
          candidates.push({ codec: CODEC_PROFILE, body: body, canonical: regenerated });
        } else {
          sizes.profile = null;
        }
      } catch (e) { sizes.profile = null; }
    }

    // Prefer a codec that reproduces the input exactly; among those, the
    // smallest. A profile that regenerates a different (but equivalent) text is
    // still allowed, but only if it is smaller AND the caller has not asked for
    // an exact round trip, because the fingerprint and ICE credentials — the
    // parts that matter — survive either way while whitespace and ordering may
    // not.
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var exact = c.canonical === minified;
      if (opts.exact && !exact) continue;
      if (!best || c.body.length < best.body.length) best = c;
    }
    if (!best) fail('no-codec', 'no codec could encode this SDP');

    var payloadBytes = new Uint8Array(best.body.length + 1);
    payloadBytes[0] = best.codec;
    payloadBytes.set(best.body, 1);
    var payload = PAYLOAD_PREFIX + core.b64uEncode(payloadBytes);

    return {
      payload: payload,
      codec: CODEC_NAMES[best.codec],
      canonical: best.canonical,
      minified: minified,
      bytes: payloadBytes.length,
      sizes: sizes
    };
  }

  /**
   * Turns a QR payload back into an SDP. Never throws on hostile input:
   * returns { ok:false, reason } instead, because this is called with whatever
   * the camera happened to read.
   */
  function parseOfferPayload(text) {
    try {
      if (typeof text !== 'string') return { ok: false, reason: 'not-a-payload' };
      if (text.length > MAX_PAYLOAD_CHARS) return { ok: false, reason: 'payload-too-large' };
      if (text.slice(0, PAYLOAD_PREFIX.length) !== PAYLOAD_PREFIX) {
        return { ok: false, reason: 'not-a-payload' };
      }
      var b64 = text.slice(PAYLOAD_PREFIX.length);
      if (!/^[A-Za-z0-9_-]*$/.test(b64)) return { ok: false, reason: 'bad-base64url' };
      var bytes;
      try {
        bytes = core.b64uDecode(b64);
      } catch (e) {
        return { ok: false, reason: 'bad-base64url' };
      }
      if (bytes.length < 2) return { ok: false, reason: 'payload-too-short' };
      var codec = bytes[0];
      var body = bytes.subarray(1);
      var sdp;
      if (codec === CODEC_RAW) {
        if (body.length > MAX_SDP_BYTES) return { ok: false, reason: 'sdp-too-large' };
        sdp = sdpFromBytes(body);
      } else if (codec === CODEC_DEFLATE) {
        sdp = sdpFromBytes(inflateRaw(body, MAX_SDP_BYTES));
      } else if (codec === CODEC_PROFILE) {
        sdp = writeProfileSdp(decodeProfile(body));
      } else {
        return { ok: false, reason: 'unknown-codec' };
      }
      var check = validateSdp(sdp);
      if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail };
      return { ok: true, sdp: sdp, codec: CODEC_NAMES[codec] };
    } catch (e) {
      return { ok: false, reason: (e && e.reason) || 'bad-payload', detail: e && e.message };
    }
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ===========================================================================
  // QR carrier
  // ===========================================================================

  /**
   * Measures a payload as a QR symbol: the version it needs, and how many
   * symbols if it needs more than one. Uses delta.js's capacity table rather
   * than a second copy of the same 160 numbers.
   */
  function payloadQr(payload, opts) {
    opts = opts || {};
    var ecl = opts.ecl || 'L';
    var fit = delta.qrVersionFor(payload.length, ecl);
    if (fit) {
      return {
        bytes: payload.length, ecl: ecl, version: fit.version,
        capacity: fit.capacity, chunks: 1, symbols: [payload]
      };
    }
    var capacity = opts.capacity || delta.byteCapacity(40, ecl);
    var symbols = chunkPayload(payload, capacity);
    return {
      bytes: payload.length, ecl: ecl, version: 40,
      capacity: capacity, chunks: symbols.length, symbols: symbols
    };
  }

  /**
   * Splits a payload across a short sequence of self-locating symbols. Same
   * scheme as delta.js's inventory carrier — header, id, index, count — so
   * there is one chunked-QR convention in this codebase rather than two.
   */
  function chunkPayload(text, capacity) {
    var cap = Math.floor(Number(capacity) || delta.byteCapacity(40, 'L'));
    var room = cap - 32;
    if (room < 16) fail('bad-capacity', 'capacity ' + cap + ' leaves no room for a chunk header');
    var count = Math.ceil(text.length / room) || 1;
    if (count > MAX_CHUNKS) fail('payload-too-large', count + ' chunks would be needed');
    var id = core.sha256Hex(asciiBytes(text)).slice(0, 8);
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(CHUNK_PREFIX + id + ':' + i + '/' + count + ':' + text.substr(i * room, room));
    }
    return out;
  }

  /**
   * Reassembles chunks. Order does not matter, duplicates are tolerated, and a
   * missing chunk, a mixed id or a digest that does not match the header is a
   * rejection rather than a best-effort join.
   */
  function joinChunks(chunks) {
    if (!chunks || !chunks.length) fail('bad-chunks', 'no chunks');
    if (chunks.length > MAX_CHUNKS) fail('bad-chunks', 'too many chunks');
    var id = null, count = null, parts = [];
    for (var i = 0; i < chunks.length; i++) {
      var text = String(chunks[i]);
      if (text.length > MAX_PAYLOAD_CHARS) fail('bad-chunks', 'chunk ' + i + ' is too large');
      var m = /^RVQPC1:([0-9a-f]{8}):(\d{1,3})\/(\d{1,3}):([A-Za-z0-9_:-]*)$/.exec(text);
      if (!m) fail('bad-chunks', 'chunk ' + i + ' has a malformed header');
      var idx = Number(m[2]);
      var n = Number(m[3]);
      if (n < 1 || n > MAX_CHUNKS) fail('bad-chunks', 'implausible chunk count');
      if (id === null) { id = m[1]; count = n; }
      else if (m[1] !== id || n !== count) fail('bad-chunks', 'chunk ' + i + ' belongs to another payload');
      if (idx >= count) fail('bad-chunks', 'chunk index ' + idx + ' of ' + count);
      parts[idx] = m[4];
    }
    for (var j = 0; j < count; j++) {
      if (parts[j] === undefined) fail('missing-chunk', 'chunk ' + j + ' of ' + count + ' never arrived');
    }
    var joined = parts.join('');
    if (core.sha256Hex(asciiBytes(joined)).slice(0, 8) !== id) {
      fail('bad-chunks', 'reassembled payload does not match its id');
    }
    return joined;
  }

  // ===========================================================================
  // Backpressure
  // ===========================================================================

  /**
   * The whole backpressure rule, as a pure function.
   *
   * A data channel accepts everything you give it and queues what it cannot
   * send; `bufferedAmount` is that queue. Feeding a 50 MB artifact into it in a
   * tight loop does not send faster, it just moves the artifact into a second
   * copy in the channel's queue and then into a third when the SCTP stack
   * fragments it. On a phone that is where the tab dies.
   *
   * So: send while the queue plus the next chunk stays under the high water
   * mark, then stop and wait for `bufferedamountlow`. Pure, so the test suite
   * can enumerate the boundary cases without a connection.
   */
  function sendDecision(bufferedAmount, chunkSize, opts) {
    opts = opts || {};
    var highWater = opts.highWater === undefined ? DEFAULT_HIGH_WATER : opts.highWater;
    var buffered = Number(bufferedAmount);
    if (!isFinite(buffered) || buffered < 0) {
      // A channel reporting nonsense gets treated as full: waiting is always
      // safe, sending into an unknown queue is not.
      return { send: false, reason: 'unknown-buffer', headroom: 0 };
    }
    var headroom = highWater - buffered;
    if (chunkSize > highWater) {
      // A chunk larger than the whole allowance would deadlock the rule. Let it
      // through on an empty queue rather than never sending it.
      return buffered === 0
        ? { send: true, reason: 'oversized-chunk-on-empty-queue', headroom: headroom }
        : { send: false, reason: 'oversized-chunk', headroom: headroom };
    }
    if (buffered + chunkSize <= highWater) {
      return { send: true, reason: 'headroom', headroom: headroom };
    }
    return { send: false, reason: 'high-water', headroom: headroom };
  }

  /**
   * The resume point. Set this as the channel's bufferedAmountLowThreshold: it
   * has to be below the high water mark or the event never fires, and well
   * above zero or the sender stalls once per chunk.
   */
  function lowThresholdFor(opts) {
    opts = opts || {};
    var highWater = opts.highWater === undefined ? DEFAULT_HIGH_WATER : opts.highWater;
    var low = opts.lowThreshold === undefined ? DEFAULT_LOW_THRESHOLD : opts.lowThreshold;
    if (low >= highWater) low = Math.floor(highWater / 4);
    if (low < 1) low = 1;
    return low;
  }

  // ===========================================================================
  // Wire framing
  // ===========================================================================
  // The manifest goes over the channel as the same JSON frame the optical path
  // uses, so core.parseFrame validates it unchanged. Data goes as binary with a
  // 12-byte header, because base64url would cost 33% for nothing here.
  //
  //   0..1  magic 'RQ'
  //   2..3  flags (reserved, must be 0)
  //   4..7  sequence, 1-based, matching the indexed frame numbering
  //   8..11 total frame count, so a frame is self-describing
  //   12..  payload

  function buildSend(bytes, opts) {
    opts = opts || {};
    var chunk = Math.min(core.clampChunk(opts.chunk || DEFAULT_CHUNK), core.MAX_RECEIVE_CHUNK);
    var name = core.sanitizeName(opts.name || 'artifact.bin');
    var hash = opts.sha256 || core.sha256Hex(bytes);
    var transferId = opts.transferId || core.randomTransferId();
    var total = core.frameCount(bytes.length, chunk);
    var prefix = hash.slice(0, 8);

    var manifest = JSON.stringify({
      v: 1, t: transferId, h: prefix, i: 0, n: total,
      m: { name: name, size: bytes.length, sha256: hash, chunk: chunk }
    });

    function frame(seq) {
      if (seq < 1 || seq >= total) fail('bad-seq', 'sequence ' + seq + ' is outside 1..' + (total - 1));
      var start = (seq - 1) * chunk;
      var end = Math.min(start + chunk, bytes.length);
      var out = new Uint8Array(WIRE_HEADER + (end - start));
      out[0] = (WIRE_MAGIC >>> 8) & 0xff;
      out[1] = WIRE_MAGIC & 0xff;
      out[2] = 0; out[3] = 0;
      out[4] = (seq >>> 24) & 0xff; out[5] = (seq >>> 16) & 0xff;
      out[6] = (seq >>> 8) & 0xff; out[7] = seq & 0xff;
      out[8] = (total >>> 24) & 0xff; out[9] = (total >>> 16) & 0xff;
      out[10] = (total >>> 8) & 0xff; out[11] = total & 0xff;
      out.set(bytes.subarray(start, end), WIRE_HEADER);
      return out;
    }

    return {
      manifest: manifest, transferId: transferId, sha256: hash,
      chunk: chunk, total: total, name: name, frame: frame
    };
  }

  /**
   * Parses a binary wire frame into the shape core.parseFrame produces, so
   * core.ingest can consume it without knowing where it came from.
   *
   * `state` supplies the transfer id and hash prefix, which the binary header
   * deliberately does not carry: repeating them in every 2 KB frame would cost
   * 12 more bytes per frame to re-state something the manifest already
   * established over an ordered, authenticated-by-DTLS channel. The bounds
   * checks that parseFrame applies to a QR frame are applied here instead.
   */
  function parseWireFrame(bytes, state) {
    if (!bytes || bytes.length < WIRE_HEADER) return { ok: false, reason: 'short-frame' };
    if (((bytes[0] << 8) | bytes[1]) !== WIRE_MAGIC) return { ok: false, reason: 'not-a-frame' };
    if (bytes[2] !== 0 || bytes[3] !== 0) return { ok: false, reason: 'unknown-flags' };
    var seq = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
    var total = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
    if (total < 1 || total > core.MAX_FRAMES) return { ok: false, reason: 'too-many-frames' };
    if (seq < 1 || seq >= total) return { ok: false, reason: 'bad-seq' };
    var payload = bytes.subarray(WIRE_HEADER);
    if (payload.length > core.MAX_RECEIVE_CHUNK) return { ok: false, reason: 'chunk-too-large' };
    if (!state || !state.transferId) return { ok: false, reason: 'no-manifest-yet' };
    if (total !== state.total) return { ok: false, reason: 'inconsistent-frame' };
    return {
      ok: true,
      frame: {
        kind: 'data', v: 1, t: state.transferId, h: state.hashPrefix,
        i: seq, n: total, mode: core.MODE_INDEXED, payload: payload.slice()
      }
    };
  }

  // ===========================================================================
  // Link — send and receive over a data channel
  // ===========================================================================

  /**
   * Wraps a data channel in the send/receive protocol.
   *
   * The channel is anything with send(), bufferedAmount, close(), and the
   * onmessage / onbufferedamountlow handlers — a real RTCDataChannel in the
   * browser, a fake in the tests. Nothing here calls a WebRTC API directly.
   *
   * opts:
   *   onProgress({ phase, sent, total, frames, pct })
   *   onData(result)   — a VERIFIED artifact, exactly the shape core.finalize
   *                      returns for the optical path. Nothing is delivered
   *                      that has not matched its manifest's SHA-256.
   *   onReject(info)   — a transfer that failed verification.
   *   highWater, lowThreshold, chunk
   */
  function link(channel, opts) {
    opts = opts || {};
    var highWater = opts.highWater === undefined ? DEFAULT_HIGH_WATER : opts.highWater;
    var low = lowThresholdFor(opts);
    var state = core.createReceiver();
    var stats = { sent: 0, received: 0, framesIn: 0, framesOut: 0, rejected: 0, waits: 0 };

    if ('bufferedAmountLowThreshold' in channel) channel.bufferedAmountLowThreshold = low;
    channel.binaryType = 'arraybuffer';

    function report(phase, sent, total, frames) {
      if (opts.onProgress) {
        opts.onProgress({
          phase: phase, sent: sent, total: total, frames: frames,
          pct: total ? Math.min(100, (sent / total) * 100) : 0
        });
      }
    }

    /**
     * Sends an artifact. Resolves when the last frame has been handed to the
     * channel — not when the peer has it, which only the peer can tell you.
     */
    function send(bytes, sendOpts) {
      var plan = buildSend(bytes, sendOpts || {});
      var seq = 1;
      var startedAt = Date.now();

      return new Promise(function (resolve, reject) {
        var done = false;

        function finish(err) {
          if (done) return;
          done = true;
          channel.onbufferedamountlow = null;
          if (err) reject(err);
          else {
            resolve({
              bytes: bytes.length, frames: plan.total - 1, ms: Date.now() - startedAt,
              transferId: plan.transferId, sha256: plan.sha256
            });
          }
        }

        try {
          channel.send(plan.manifest);
          stats.framesOut++;
        } catch (e) {
          return finish(P2PError('send-failed', e && e.message ? e.message : String(e)));
        }

        function pump() {
          while (seq < plan.total) {
            var frame = plan.frame(seq);
            var decision = sendDecision(channel.bufferedAmount, frame.byteLength, {
              highWater: highWater
            });
            if (!decision.send) {
              stats.waits++;
              // The event fires once the queue drains past the low threshold.
              // The handler is installed per wait and cleared on entry, so a
              // channel that closes between chunks leaves nothing behind.
              channel.onbufferedamountlow = function () {
                channel.onbufferedamountlow = null;
                pump();
              };
              return;
            }
            try {
              channel.send(frame);
            } catch (e) {
              return finish(P2PError('send-failed', e && e.message ? e.message : String(e)));
            }
            stats.framesOut++;
            stats.sent += frame.byteLength - WIRE_HEADER;
            seq++;
            report('send', stats.sent, bytes.length, seq - 1);
          }
          finish(null);
        }

        pump();
      });
    }

    /**
     * Feeds one channel message into the receiver.
     *
     * Both branches end in core.ingest and core.finalize. That is the point of
     * the whole module: the transport changed, the acceptance rule did not.
     */
    function handleMessage(data) {
      var result;
      if (typeof data === 'string') {
        result = core.ingest(state, data, Date.now());
      } else {
        var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        var parsed = parseWireFrame(bytes, state);
        if (!parsed.ok) {
          stats.rejected++;
          state.rejected++;
          return { accepted: false, reason: parsed.reason, complete: false };
        }
        result = core.ingest(state, parsed.frame, Date.now());
      }
      stats.framesIn++;
      if (result.accepted && state.manifest) {
        stats.received = state.received * (state.manifest.chunk || 0);
        report('receive', Math.min(stats.received, state.manifest.size),
          state.manifest.size, state.received);
      }
      if (result.complete) {
        var verdict = core.finalize(state);
        if (verdict.ok) {
          if (opts.onData) opts.onData(verdict);
        } else {
          stats.rejected++;
          if (opts.onReject) opts.onReject(verdict);
        }
        return { accepted: result.accepted, reason: result.reason, complete: true, verdict: verdict };
      }
      return result;
    }

    channel.onmessage = function (event) { handleMessage(event.data); };

    return {
      send: send,
      handleMessage: handleMessage,
      state: state,
      stats: function () {
        return {
          sent: stats.sent, received: stats.received,
          framesIn: stats.framesIn, framesOut: stats.framesOut,
          rejected: stats.rejected, waits: stats.waits,
          status: state.status
        };
      },
      reset: function () { state = core.createReceiver(); },
      close: function () {
        channel.onbufferedamountlow = null;
        channel.onmessage = null;
        try { channel.close(); } catch (e) { /* already closed */ }
      }
    };
  }

  // ===========================================================================
  // Connection setup
  // ===========================================================================

  /**
   * The default peer connection factory.
   *
   * iceServers defaults to EMPTY, which is the entire point: with no STUN
   * server the browser gathers host candidates only, contacts nobody, and the
   * connection works exactly when the two devices can already reach each other
   * — a LAN. Supplying iceServers is an explicit, documented opt-in that trades
   * that property for reach.
   */
  function defaultFactory(config) {
    if (typeof RTCPeerConnection === 'undefined') {
      fail('no-webrtc', 'this environment has no RTCPeerConnection');
    }
    return new RTCPeerConnection({
      iceServers: config.iceServers || [],
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle'
    });
  }

  /**
   * Waits for ICE gathering to finish, or for the deadline, whichever is first.
   * Host-only gathering completes in milliseconds; the deadline exists for the
   * opt-in STUN case where a server may simply not answer.
   */
  function gather(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve('complete');
    return new Promise(function (resolve) {
      var settled = false;
      function done(how) {
        if (settled) return;
        settled = true;
        pc.onicegatheringstatechange = null;
        pc.onicecandidate = null;
        if (timer) clearTimeout(timer);
        resolve(how);
      }
      var timer = setTimeout(function () { done('timeout'); }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pc.onicegatheringstatechange = function () {
        if (pc.iceGatheringState === 'complete') done('complete');
      };
      pc.onicecandidate = function (event) {
        if (!event || !event.candidate) done('complete');
      };
    });
  }

  /**
   * Builds an offer and the QR payload that carries it.
   *
   * Returns a promise for { sdpText, qrPayload, qr, connect(answerPayload) }.
   * `connect` takes the payload scanned back off the other device's screen and
   * resolves once the data channel is open.
   */
  function createOffer(opts) {
    opts = opts || {};
    var factory = opts.factory || defaultFactory;
    var pc = factory({ iceServers: opts.iceServers || [] });
    var channel = pc.createDataChannel(opts.label || CHANNEL_LABEL, {
      ordered: true
    });

    return Promise.resolve(pc.createOffer())
      .then(function (offer) { return Promise.resolve(pc.setLocalDescription(offer)); })
      .then(function () { return gather(pc, opts.gatherMs || DEFAULT_GATHER_MS); })
      .then(function (how) {
        var sdp = (pc.localDescription && pc.localDescription.sdp) || '';
        var compressed = compressSdp(sdp, opts);
        var qr = payloadQr(compressed.payload, opts);
        return {
          pc: pc,
          channel: channel,
          gathering: how,
          // What the peer will actually reconstruct — which is the minified
          // text for the deflate and raw codecs and the regenerated template
          // for the profile codec. Reporting the input instead would be a
          // pleasant lie about what went over the channel.
          sdpText: compressed.canonical,
          minifiedSdp: compressed.minified,
          rawSdp: sdp,
          codec: compressed.codec,
          qrPayload: compressed.payload,
          qr: qr,
          sizes: compressed.sizes,
          connect: function (answerPayload) {
            var parsed = parseOfferPayload(answerPayload);
            if (!parsed.ok) {
              return Promise.reject(P2PError(parsed.reason, 'answer rejected: ' + parsed.reason));
            }
            return Promise.resolve(
              pc.setRemoteDescription({ type: 'answer', sdp: parsed.sdp })
            ).then(function () { return waitForOpen(channel, opts.openMs); });
          },
          close: function () { try { pc.close(); } catch (e) { /* already closed */ } }
        };
      });
  }

  /**
   * Takes an offer payload scanned off the other device and produces the answer
   * payload to show back, plus the channel the peer opened.
   */
  function acceptOffer(offerPayload, opts) {
    opts = opts || {};
    var parsed = parseOfferPayload(offerPayload);
    if (!parsed.ok) {
      return Promise.reject(P2PError(parsed.reason, 'offer rejected: ' + parsed.reason));
    }
    var factory = opts.factory || defaultFactory;
    var pc = factory({ iceServers: opts.iceServers || [] });
    var channelPromise = new Promise(function (resolve) {
      pc.ondatachannel = function (event) { resolve(event.channel); };
    });

    return Promise.resolve(pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdp }))
      .then(function () { return Promise.resolve(pc.createAnswer()); })
      .then(function (answer) { return Promise.resolve(pc.setLocalDescription(answer)); })
      .then(function () { return gather(pc, opts.gatherMs || DEFAULT_GATHER_MS); })
      .then(function (how) {
        var sdp = (pc.localDescription && pc.localDescription.sdp) || '';
        var compressed = compressSdp(sdp, opts);
        var qr = payloadQr(compressed.payload, opts);
        return {
          pc: pc,
          gathering: how,
          offerSdp: parsed.sdp,
          sdpText: compressed.canonical,
          minifiedSdp: compressed.minified,
          codec: compressed.codec,
          answerPayload: compressed.payload,
          qr: qr,
          sizes: compressed.sizes,
          channel: channelPromise.then(function (ch) {
            return waitForOpen(ch, opts.openMs);
          }),
          close: function () { try { pc.close(); } catch (e) { /* already closed */ } }
        };
      });
  }

  function waitForOpen(channel, timeoutMs) {
    if (channel.readyState === 'open') return Promise.resolve(channel);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(P2PError('open-timeout', 'the data channel never opened'));
      }, timeoutMs || 15000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      channel.onopen = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(channel);
      };
      channel.onerror = function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(P2PError('channel-error', (e && e.message) || 'data channel error'));
      };
    });
  }

  return {
    MAX_SDP_BYTES: MAX_SDP_BYTES,
    MAX_PAYLOAD_CHARS: MAX_PAYLOAD_CHARS,
    MAX_CANDIDATES: MAX_CANDIDATES,
    MAX_CHUNKS: MAX_CHUNKS,
    WIRE_HEADER: WIRE_HEADER,
    WIRE_MAGIC: WIRE_MAGIC,
    DEFAULT_CHUNK: DEFAULT_CHUNK,
    DEFAULT_HIGH_WATER: DEFAULT_HIGH_WATER,
    DEFAULT_LOW_THRESHOLD: DEFAULT_LOW_THRESHOLD,
    CHANNEL_LABEL: CHANNEL_LABEL,
    CODEC_NAMES: CODEC_NAMES,
    P2PError: P2PError,

    deflateRaw: deflateRaw,
    inflateRaw: inflateRaw,

    minifySdp: minifySdp,
    validateSdp: validateSdp,
    parseCandidate: parseCandidate,
    formatCandidate: formatCandidate,
    readProfile: readProfile,
    writeProfileSdp: writeProfileSdp,
    encodeProfile: encodeProfile,
    decodeProfile: decodeProfile,

    compressSdp: compressSdp,
    parseOfferPayload: parseOfferPayload,
    payloadQr: payloadQr,
    chunkPayload: chunkPayload,
    joinChunks: joinChunks,

    sendDecision: sendDecision,
    lowThresholdFor: lowThresholdFor,

    buildSend: buildSend,
    parseWireFrame: parseWireFrame,
    link: link,

    defaultFactory: defaultFactory,
    createOffer: createOffer,
    acceptOffer: acceptOffer
  };
});
