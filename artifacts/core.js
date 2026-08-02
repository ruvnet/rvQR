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

  // --- Hostile-input ceilings ------------------------------------------------
  // Every one of these bounds something an attacker controls with a single QR
  // code. A frame is unauthenticated input from whatever happens to be pointed
  // at the camera, so any value a receiver takes from one has to be bounded
  // before it reaches an allocation or a loop.

  // Largest frame count a receiver will adopt. 65536 frames is 32 MB at the
  // 512-byte default chunk and 64 MB at the 1024-byte maximum — far more than
  // an optical channel running at kilobytes per second can deliver in one
  // sitting, and small enough that the derived arrays stay trivial.
  var MAX_FRAMES = 65536;

  // A chunk larger than this cannot have arrived by QR: 2953 bytes is the
  // absolute byte-mode capacity of a version 40 symbol at error correction
  // level L, and the frame's JSON header and base64url expansion eat into that
  // further. A manifest claiming more is lying about its own transport.
  var MAX_RECEIVE_CHUNK = 2953;

  // Ceiling on the artifact size a manifest may declare, independent of the
  // frame maths. Bounds the single allocation in assemble().
  var MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

  // Longest artifact name accepted from a frame, and the length names are
  // clamped to on the way in.
  var MAX_NAME_LENGTH = 255;
  var SAFE_NAME_LENGTH = 120;

  // Most cells the receive grid will ever draw, whatever the frame count says.
  var MAX_GRID_CELLS = 4096;

  // How long a transfer must go without progress before a frame from a
  // different transfer is allowed to take over. A manifest is a deliberate
  // start-of-transfer marker so it gets the shorter fuse.
  var STALE_TRANSFER_MS = 3000;
  var STALE_MANIFEST_MS = 1000;

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

  // Pure arithmetic on the declared values. It must NOT clamp: a receiver
  // checks a manifest against the chunk size that manifest declares, and
  // silently substituting the sender's own limits here would make a consistent
  // manifest look inconsistent.
  function frameCount(size, chunk) {
    return 1 + Math.ceil(size / chunk);
  }

  /**
   * How many grid cells to draw for a transfer, and how many frames each cell
   * stands for. Pure, and deliberately independent of the frame count a frame
   * claims: the cell count is capped so a hostile n can never drive the DOM.
   */
  function gridPlan(total, maxCells) {
    var limit = maxCells || MAX_GRID_CELLS;
    var dataFrames = Math.max(0, (total || 0) - 1);
    var cells = Math.min(dataFrames, limit);
    return {
      dataFrames: dataFrames,
      cells: cells,
      framesPerCell: cells ? Math.ceil(dataFrames / cells) : 0,
      bucketed: cells > 0 && cells < dataFrames
    };
  }

  /** Which cell a sequence number falls in, given a plan. */
  function cellForSequence(plan, seq) {
    if (!plan.cells) return -1;
    return Math.min(plan.cells - 1, Math.floor((seq - 1) / plan.framesPerCell));
  }

  /**
   * Strips anything that could confuse a filesystem or a UI out of an artifact
   * name, and clamps the length while keeping a short extension readable.
   * Names arrive from unauthenticated frames, so this runs on receive as well
   * as on import.
   */
  function sanitizeName(name, maxLength) {
    var limit = maxLength || SAFE_NAME_LENGTH;
    var out = String(name === undefined || name === null ? '' : name)
      .replace(/[\x00-\x1f\x7f]/g, '') // control characters
      .replace(/[\\/]+/g, '_') // path separators: a name stays a name
      .replace(/^\.+/, '') // no leading dots, so no '..' and no hidden files
      .trim();
    if (!out) out = 'artifact.bin';
    if (out.length <= limit) return out;
    var dot = out.lastIndexOf('.');
    var ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : '';
    return out.slice(0, Math.max(1, limit - ext.length)) + ext;
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
    // n drives allocations and loops in every receiver, so it is bounded here,
    // before any caller can act on it, rather than at each use site.
    if (obj.n > MAX_FRAMES) return { ok: false, reason: 'too-many-frames' };

    if (obj.i === 0) {
      var m = obj.m;
      if (!m || typeof m !== 'object') return { ok: false, reason: 'missing-manifest' };
      if (typeof m.name !== 'string' || !m.name) return { ok: false, reason: 'bad-name' };
      if (m.name.length > MAX_NAME_LENGTH) return { ok: false, reason: 'name-too-long' };
      if (!Number.isInteger(m.size) || m.size < 0) return { ok: false, reason: 'bad-size' };
      if (m.size > MAX_ARTIFACT_BYTES) return { ok: false, reason: 'artifact-too-large' };
      if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) {
        return { ok: false, reason: 'bad-sha256' };
      }
      if (!Number.isInteger(m.chunk) || m.chunk < 1) return { ok: false, reason: 'bad-chunk' };
      if (m.chunk > MAX_RECEIVE_CHUNK) return { ok: false, reason: 'chunk-too-large' };
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
      lastProgressAt: null,
      switches: 0,
      result: null
    };
  }

  /**
   * Whether a frame from a different transfer should take over the receiver.
   *
   * Pinning the first transfer id forever is the safe-looking choice and the
   * wrong one: a single stray frame would capture the receiver, and a sender
   * that legitimately restarts — which it does on every new send, and whenever
   * the chunk size changes — would be stonewalled until someone found the
   * Reset button. So a new transfer wins once the current one has visibly
   * stalled, and a manifest (an explicit start-of-transfer marker) gets a
   * shorter fuse than a stray data frame.
   *
   * Without a clock the strict rule stands, so a caller that passes no
   * timestamps keeps the old deterministic behaviour.
   */
  function shouldAdoptNewTransfer(state, frame, nowMs, opts) {
    if (state.status === 'VERIFIED' || state.status === 'REJECTED') return true;
    if (typeof nowMs !== 'number' || typeof state.lastProgressAt !== 'number') {
      return false;
    }
    var stale = frame.kind === 'manifest'
      ? (opts && opts.manifestMs) || STALE_MANIFEST_MS
      : (opts && opts.staleMs) || STALE_TRANSFER_MS;
    return nowMs - state.lastProgressAt >= stale;
  }

  function adoptTransfer(state, frame, nowMs) {
    var switches = state.switches;
    var rejected = state.rejected;
    state.status = 'COLLECTING';
    state.transferId = frame.t;
    state.hashPrefix = frame.h;
    state.total = frame.n;
    state.manifest = null;
    state.chunks = Object.create(null);
    state.received = 0;
    state.duplicates = 0;
    state.rejected = rejected;
    state.result = null;
    state.startedAt = typeof nowMs === 'number' ? nowMs : null;
    state.lastProgressAt = typeof nowMs === 'number' ? nowMs : null;
    state.switches = switches + 1;
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
  function ingest(state, textOrFrame, nowMs, opts) {
    var parsed =
      typeof textOrFrame === 'string'
        ? parseFrame(textOrFrame)
        : { ok: true, frame: textOrFrame };
    if (!parsed.ok) {
      state.rejected++;
      return { accepted: false, reason: parsed.reason, complete: false };
    }
    var f = parsed.frame;
    var switched = false;

    if (state.status === 'IDLE') {
      adoptTransfer(state, f, nowMs);
      state.switches = 0;
    } else if (f.t !== state.transferId) {
      if (!shouldAdoptNewTransfer(state, f, nowMs, opts)) {
        state.rejected++;
        return { accepted: false, reason: 'other-transfer', complete: isComplete(state) };
      }
      adoptTransfer(state, f, nowMs);
      switched = true;
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

    if (typeof nowMs === 'number') state.lastProgressAt = nowMs;
    var complete = isComplete(state);
    if (complete && state.status === 'COLLECTING') state.status = 'COMPLETE';
    return { accepted: true, reason: null, complete: complete, switched: switched };
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
    // The name is the one field a sender controls that the hash does not cover,
    // so it is clamped and stripped here rather than trusted downstream.
    state.result = {
      ok: true,
      bytes: bytes,
      sha256: digest,
      name: sanitizeName(state.manifest.name),
      declaredName: state.manifest.name
    };
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
    MAX_FRAMES: MAX_FRAMES,
    MAX_RECEIVE_CHUNK: MAX_RECEIVE_CHUNK,
    MAX_ARTIFACT_BYTES: MAX_ARTIFACT_BYTES,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    SAFE_NAME_LENGTH: SAFE_NAME_LENGTH,
    MAX_GRID_CELLS: MAX_GRID_CELLS,
    STALE_TRANSFER_MS: STALE_TRANSFER_MS,
    STALE_MANIFEST_MS: STALE_MANIFEST_MS,
    gridPlan: gridPlan,
    cellForSequence: cellForSequence,
    sanitizeName: sanitizeName,
    shouldAdoptNewTransfer: shouldAdoptNewTransfer,
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
