/*!
 * rvQR core — protocol primitives shared by the browser app and the test suite.
 *
 * Everything in here is a pure function over plain data: no DOM, no camera, no
 * storage. That is deliberate — the send path, the receive path, and the Node
 * test harness all exercise the same code.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var DEFAULT_CHUNK = 512;
  var MIN_CHUNK = 128;
  var MAX_CHUNK = 1024;

  // --- base64url (RFC 4648 §5, unpadded) -------------------------------------

  var B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64U_INV = (function () {
    var inv = new Int16Array(128).fill(-1);
    for (var i = 0; i < B64U.length; i++) inv[B64U.charCodeAt(i)] = i;
    return inv;
  })();

  function b64uEncode(bytes) {
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63] +
        B64U[(n >>> 6) & 63] + B64U[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var a = bytes[i] << 16;
      out += B64U[(a >>> 18) & 63] + B64U[(a >>> 12) & 63];
    } else if (rem === 2) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64U[(b >>> 18) & 63] + B64U[(b >>> 12) & 63] + B64U[(b >>> 6) & 63];
    }
    return out;
  }

  function b64uDecode(str) {
    var clean = String(str);
    var len = clean.length;
    var full = len >>> 2;
    var rem = len & 3;
    if (rem === 1) throw new Error('invalid base64url length');
    var outLen = full * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
    var out = new Uint8Array(outLen);
    var oi = 0, i = 0, n, c;
    function val(ch) {
      c = ch < 128 ? B64U_INV[ch] : -1;
      if (c < 0) throw new Error('invalid base64url character');
      return c;
    }
    for (var f = 0; f < full; f++, i += 4) {
      n =
        (val(clean.charCodeAt(i)) << 18) |
        (val(clean.charCodeAt(i + 1)) << 12) |
        (val(clean.charCodeAt(i + 2)) << 6) |
        val(clean.charCodeAt(i + 3));
      out[oi++] = (n >>> 16) & 255;
      out[oi++] = (n >>> 8) & 255;
      out[oi++] = n & 255;
    }
    if (rem === 2) {
      n = (val(clean.charCodeAt(i)) << 18) | (val(clean.charCodeAt(i + 1)) << 12);
      out[oi++] = (n >>> 16) & 255;
    } else if (rem === 3) {
      n =
        (val(clean.charCodeAt(i)) << 18) |
        (val(clean.charCodeAt(i + 1)) << 12) |
        (val(clean.charCodeAt(i + 2)) << 6);
      out[oi++] = (n >>> 16) & 255;
      out[oi++] = (n >>> 8) & 255;
    }
    return out;
  }

  // --- SHA-256 ---------------------------------------------------------------
  // Synchronous and dependency-free so the same hash function runs in Node
  // tests and in the browser. The app prefers crypto.subtle for large files and
  // falls back to this.

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function sha256Bytes(input) {
    var h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var len = input.length;
    var bitLenHi = Math.floor((len / 0x20000000) | 0);
    var bitLenLo = (len << 3) >>> 0;
    var withPad = len + 9;
    var total = withPad + ((64 - (withPad % 64)) % 64);
    var msg = new Uint8Array(total);
    msg.set(input);
    msg[len] = 0x80;
    msg[total - 8] = (bitLenHi >>> 24) & 255;
    msg[total - 7] = (bitLenHi >>> 16) & 255;
    msg[total - 6] = (bitLenHi >>> 8) & 255;
    msg[total - 5] = bitLenHi & 255;
    msg[total - 4] = (bitLenLo >>> 24) & 255;
    msg[total - 3] = (bitLenLo >>> 16) & 255;
    msg[total - 2] = (bitLenLo >>> 8) & 255;
    msg[total - 1] = bitLenLo & 255;

    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] =
          (msg[off + i * 4] << 24) |
          (msg[off + i * 4 + 1] << 16) |
          (msg[off + i * 4 + 2] << 8) |
          msg[off + i * 4 + 3];
      }
      for (var t = 16; t < 64; t++) {
        var w15 = w[t - 15], w2 = w[t - 2];
        var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];
      for (var j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = (h[k] >>> 24) & 255;
      out[k * 4 + 1] = (h[k] >>> 16) & 255;
      out[k * 4 + 2] = (h[k] >>> 8) & 255;
      out[k * 4 + 3] = h[k] & 255;
    }
    return out;
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  function sha256Hex(bytes) {
    return toHex(sha256Bytes(bytes));
  }

  // --- Artifact type detection ----------------------------------------------
  // RVF containers per ADR-009: segments carry the wire magic 53 46 56 52 and
  // the 4096-byte root manifest at the tail carries 30 4D 56 52.

  var RVF_SEGMENT_MAGIC = [0x53, 0x46, 0x56, 0x52];
  var RVF_ROOT_MAGIC = [0x30, 0x4d, 0x56, 0x52];
  var WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
  var RVF_ROOT_REGION = 4096;

  function matchesAt(bytes, magic, offset) {
    if (offset + magic.length > bytes.length) return false;
    for (var i = 0; i < magic.length; i++) {
      if (bytes[offset + i] !== magic[i]) return false;
    }
    return true;
  }

  function findMagicInTail(bytes, magic, regionSize) {
    var start = Math.max(0, bytes.length - regionSize);
    for (var i = start; i + magic.length <= bytes.length; i++) {
      if (matchesAt(bytes, magic, i)) return i;
    }
    return -1;
  }

  function detectArtifactType(bytes) {
    if (matchesAt(bytes, WASM_MAGIC, 0)) {
      return {
        kind: 'wasm',
        label: 'WASM module',
        detail: 'Starts with the WebAssembly magic \\0asm.'
      };
    }
    if (matchesAt(bytes, RVF_SEGMENT_MAGIC, 0)) {
      return {
        kind: 'rvf',
        label: 'RVF container',
        detail: 'Starts with the RVF segment magic 53 46 56 52.'
      };
    }
    var rootAt = findMagicInTail(bytes, RVF_ROOT_MAGIC, RVF_ROOT_REGION);
    if (rootAt >= 0) {
      return {
        kind: 'rvf',
        label: 'RVF container',
        detail:
          'Root manifest magic 30 4D 56 52 found at offset ' + rootAt +
          ' in the tail region.'
      };
    }
    return { kind: 'generic', label: 'Generic file', detail: 'No known container magic.' };
  }

  // --- Frame construction ----------------------------------------------------

  function clampChunk(chunk) {
    chunk = Math.floor(Number(chunk) || DEFAULT_CHUNK);
    if (chunk < MIN_CHUNK) chunk = MIN_CHUNK;
    if (chunk > MAX_CHUNK) chunk = MAX_CHUNK;
    return chunk;
  }

  function frameCount(size, chunk) {
    return 1 + Math.ceil(size / clampChunk(chunk));
  }

  function randomTransferId() {
    var bytes = new Uint8Array(4);
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.crypto && g.crypto.getRandomValues) g.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
    return toHex(bytes);
  }

  /**
   * Builds the complete list of frame strings for an artifact.
   * opts: { name, chunk, transferId, sha256 } — sha256 is computed if absent.
   */
  function buildFrames(bytes, opts) {
    opts = opts || {};
    var chunk = clampChunk(opts.chunk);
    var name = String(opts.name || 'artifact.bin');
    var hash = opts.sha256 || sha256Hex(bytes);
    var transferId = opts.transferId || randomTransferId();
    var total = frameCount(bytes.length, chunk);
    var prefix = hash.slice(0, 8);

    var frames = [
      JSON.stringify({
        v: PROTOCOL_VERSION,
        t: transferId,
        h: prefix,
        i: 0,
        n: total,
        m: { name: name, size: bytes.length, sha256: hash, chunk: chunk }
      })
    ];
    for (var seq = 1; seq < total; seq++) {
      var start = (seq - 1) * chunk;
      var slice = bytes.subarray(start, Math.min(start + chunk, bytes.length));
      frames.push(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          t: transferId,
          h: prefix,
          i: seq,
          n: total,
          p: b64uEncode(slice)
        })
      );
    }
    return { frames: frames, transferId: transferId, sha256: hash, chunk: chunk, total: total };
  }

  /** Parses one frame string. Never throws; returns { ok:false, reason } instead. */
  function parseFrame(text) {
    if (typeof text !== 'string' || text.length < 2 || text.charAt(0) !== '{') {
      return { ok: false, reason: 'not-a-frame' };
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'bad-json' };
    }
    if (!obj || typeof obj !== 'object') return { ok: false, reason: 'bad-json' };
    if (obj.v !== PROTOCOL_VERSION) return { ok: false, reason: 'bad-version' };
    if (typeof obj.t !== 'string' || !/^[0-9a-f]{8}$/.test(obj.t)) {
      return { ok: false, reason: 'bad-transfer-id' };
    }
    if (typeof obj.h !== 'string' || !/^[0-9a-f]{8}$/.test(obj.h)) {
      return { ok: false, reason: 'bad-hash-prefix' };
    }
    if (!Number.isInteger(obj.i) || obj.i < 0) return { ok: false, reason: 'bad-seq' };
    if (!Number.isInteger(obj.n) || obj.n < 1 || obj.i >= obj.n) {
      return { ok: false, reason: 'bad-total' };
    }

    if (obj.i === 0) {
      var m = obj.m;
      if (!m || typeof m !== 'object') return { ok: false, reason: 'missing-manifest' };
      if (typeof m.name !== 'string' || !m.name) return { ok: false, reason: 'bad-name' };
      if (!Number.isInteger(m.size) || m.size < 0) return { ok: false, reason: 'bad-size' };
      if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) {
        return { ok: false, reason: 'bad-sha256' };
      }
      if (!Number.isInteger(m.chunk) || m.chunk < 1) return { ok: false, reason: 'bad-chunk' };
      if (m.sha256.slice(0, 8) !== obj.h) return { ok: false, reason: 'hash-prefix-mismatch' };
      if (frameCount(m.size, m.chunk) !== obj.n) return { ok: false, reason: 'frame-count-mismatch' };
      return { ok: true, frame: { kind: 'manifest', v: obj.v, t: obj.t, h: obj.h, i: 0, n: obj.n, m: m } };
    }

    if (typeof obj.p !== 'string') return { ok: false, reason: 'missing-payload' };
    var payload;
    try {
      payload = b64uDecode(obj.p);
    } catch (e) {
      return { ok: false, reason: 'bad-payload' };
    }
    return {
      ok: true,
      frame: { kind: 'data', v: obj.v, t: obj.t, h: obj.h, i: obj.i, n: obj.n, payload: payload }
    };
  }

  // --- Receiver state machine ------------------------------------------------

  function createReceiver() {
    return {
      status: 'IDLE',
      transferId: null,
      hashPrefix: null,
      total: 0,
      manifest: null,
      chunks: Object.create(null),
      received: 0,
      duplicates: 0,
      rejected: 0,
      startedAt: null,
      result: null
    };
  }

  function receivedSequences(state) {
    return Object.keys(state.chunks).map(Number).sort(function (a, b) { return a - b; });
  }

  function missingSequences(state, limit) {
    var out = [];
    if (!state.total) return out;
    for (var i = 1; i < state.total; i++) {
      if (!(i in state.chunks)) {
        out.push(i);
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }

  function isComplete(state) {
    if (!state.manifest || !state.total) return false;
    for (var i = 1; i < state.total; i++) if (!(i in state.chunks)) return false;
    return true;
  }

  /**
   * Feeds one decoded QR string (or a pre-parsed frame) into a receiver.
   * Returns { accepted, reason, complete } and mutates state in place.
   */
  function ingest(state, textOrFrame, nowMs) {
    var parsed =
      typeof textOrFrame === 'string'
        ? parseFrame(textOrFrame)
        : { ok: true, frame: textOrFrame };
    if (!parsed.ok) {
      state.rejected++;
      return { accepted: false, reason: parsed.reason, complete: false };
    }
    var f = parsed.frame;

    if (state.status === 'IDLE') {
      state.status = 'COLLECTING';
      state.transferId = f.t;
      state.hashPrefix = f.h;
      state.total = f.n;
      state.startedAt = nowMs === undefined ? null : nowMs;
    } else if (f.t !== state.transferId) {
      state.rejected++;
      return { accepted: false, reason: 'other-transfer', complete: isComplete(state) };
    } else if (f.h !== state.hashPrefix || f.n !== state.total) {
      // Same transfer id but inconsistent framing: refuse rather than mix bytes.
      state.rejected++;
      return { accepted: false, reason: 'inconsistent-frame', complete: isComplete(state) };
    }

    if (f.kind === 'manifest') {
      if (state.manifest) {
        state.duplicates++;
        return { accepted: false, reason: 'duplicate', complete: isComplete(state) };
      }
      state.manifest = f.m;
    } else {
      if (f.i in state.chunks) {
        state.duplicates++;
        return { accepted: false, reason: 'duplicate', complete: isComplete(state) };
      }
      state.chunks[f.i] = f.payload;
      state.received++;
    }

    var complete = isComplete(state);
    if (complete && state.status === 'COLLECTING') state.status = 'COMPLETE';
    return { accepted: true, reason: null, complete: complete };
  }

  /** Concatenates collected chunks in sequence order. Assumes isComplete(). */
  function assemble(state) {
    var size = state.manifest.size;
    var out = new Uint8Array(size);
    var offset = 0;
    for (var i = 1; i < state.total; i++) {
      var part = state.chunks[i];
      if (!part) throw new Error('assemble called before transfer completed');
      if (offset + part.length > size) {
        out.set(part.subarray(0, size - offset), offset);
        offset = size;
        break;
      }
      out.set(part, offset);
      offset += part.length;
    }
    if (offset !== size) throw new Error('assembled length mismatch');
    return out;
  }

  /**
   * Assembles and verifies. Nothing is ever handed to the caller as "accepted"
   * unless the SHA-256 matches the manifest exactly.
   * hashFn is optional and defaults to the built-in SHA-256.
   */
  function finalize(state, hashFn) {
    if (!isComplete(state)) {
      return { ok: false, reason: 'incomplete' };
    }
    var bytes;
    try {
      bytes = assemble(state);
    } catch (e) {
      state.status = 'REJECTED';
      return { ok: false, reason: 'assembly-failed' };
    }
    var digest = (hashFn || sha256Hex)(bytes);
    if (digest !== state.manifest.sha256) {
      state.status = 'REJECTED';
      state.result = { ok: false, reason: 'hash-mismatch', expected: state.manifest.sha256, actual: digest };
      return state.result;
    }
    state.status = 'VERIFIED';
    state.result = { ok: true, bytes: bytes, sha256: digest, name: state.manifest.name };
    return state.result;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function hexPreview(bytes, count) {
    var n = Math.min(count || 32, bytes.length);
    var parts = [];
    for (var i = 0; i < n; i++) {
      parts.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
    }
    return parts.join(' ');
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    DEFAULT_CHUNK: DEFAULT_CHUNK,
    MIN_CHUNK: MIN_CHUNK,
    MAX_CHUNK: MAX_CHUNK,
    b64uEncode: b64uEncode,
    b64uDecode: b64uDecode,
    sha256Hex: sha256Hex,
    sha256Bytes: sha256Bytes,
    toHex: toHex,
    detectArtifactType: detectArtifactType,
    clampChunk: clampChunk,
    frameCount: frameCount,
    randomTransferId: randomTransferId,
    buildFrames: buildFrames,
    parseFrame: parseFrame,
    createReceiver: createReceiver,
    ingest: ingest,
    isComplete: isComplete,
    assemble: assemble,
    finalize: finalize,
    receivedSequences: receivedSequences,
    missingSequences: missingSequences,
    formatBytes: formatBytes,
    hexPreview: hexPreview
  };
});
