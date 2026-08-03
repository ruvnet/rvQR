/*!
 * rvQR protocol v2 — a compact binary frame, alongside v1's JSON one.
 *
 * WHY THIS EXISTS. A v1 data frame is JSON with a base64url payload:
 *
 *   {"v":1,"t":"a1b2c3d4","h":"deadbeef","i":7,"n":9,"p":"<base64url>"}
 *
 * That is 739 QR bytes for a 512-byte chunk — 44.3% overhead, measured, not
 * estimated (see proto2.test.js, which recomputes it every run). Two thirds of
 * that is base64url's 4/3 expansion and the rest is the JSON envelope. A QR
 * symbol's byte mode is already 8-bit clean, so both costs are self-inflicted.
 *
 * v2 replaces the envelope with a fixed 28-byte binary header and the base64url
 * with nothing at all: the payload is carried as raw bytes.
 *
 * WHAT v2 DOES NOT DO. It does not compress. codecId and dictId are declared,
 * carried, and enforced, but the codec itself is injected at finalize() the way
 * core.js injects the fountain decoder — this module stays dependency-free so
 * the same code runs in Node and the browser.
 *
 * ---------------------------------------------------------------------------
 * FRAME HEADER — 28 bytes, present on EVERY frame. All multi-byte fields are
 * little-endian. Offsets and sizes are in bytes.
 * ---------------------------------------------------------------------------
 *
 *   Off  Size  Field            Type     Meaning
 *   ---  ----  -----            ----     -------
 *   0    4     magic            bytes    52 56 51 32, i.e. ASCII "RVQ2".
 *                                        Distinct from v1 (a v1 frame is text
 *                                        beginning '{' = 0x7B) and from the
 *                                        delta magics RVQI/RVQD.
 *   4    1     version          u8       2. A parser MUST reject any other
 *                                        value rather than guess.
 *   5    1     mode             u8       0 = indexed, 1 = fountain.
 *                                        Any other value is rejected.
 *   6    1     codecId          u8       0 = none, 1 = scf1, 2 = deflate-raw,
 *                                        3 = brotli. "none" is the value 0, an
 *                                        explicit statement, never an absence.
 *   7    1     dictId           u8       0 = none. Same rule: 0 is a value.
 *   8    4     transferId       u32 LE   Random per transfer. Groups frames.
 *   12   3     index            u24 LE   Indexed: frame number, 0 = manifest.
 *                                        Fountain: encoding symbol id (ESI);
 *                                        0 is still the manifest, and repair
 *                                        symbols run above `total` by design.
 *   15   3     total            u24 LE   Indexed: total frame count, manifest
 *                                        included. Fountain: K, the source
 *                                        symbol count.
 *   18   2     payloadLen       u16 LE   Bytes of payload following the header.
 *                                        MUST equal the actual remainder of the
 *                                        frame exactly — a frame that disagrees
 *                                        with itself is rejected, not trimmed.
 *   20   4     contentHash32    u32 LE   First 4 bytes of SHA-256(original
 *                                        artifact), read little-endian. Binds
 *                                        every frame to the artifact it claims
 *                                        to belong to. The full digest is in
 *                                        the manifest body; this is v1's `h`
 *                                        prefix in four bytes instead of eight
 *                                        hex characters.
 *   24   4     transportHash32  u32 LE   First 4 bytes of SHA-256(payload),
 *                                        read little-endian. Covers what THIS
 *                                        frame carries, and is checked on parse.
 *   28                                   End of header; payload begins.
 *
 * ---------------------------------------------------------------------------
 * MANIFEST BODY — the payload of frame index 0. 47 bytes plus the name.
 * ---------------------------------------------------------------------------
 *
 *   Off  Size  Field            Type     Meaning
 *   ---  ----  -----            ----     -------
 *   0    4     originalSize     u32 LE   Length of the artifact BEFORE the
 *                                        codec. What finalize() reconstructs.
 *   4    4     compressedSize   u32 LE   Length of the codec's output — the
 *                                        byte stream actually cut into frames.
 *                                        Equal to originalSize when codecId is
 *                                        0. Separate fields on purpose: with
 *                                        one, a receiver cannot tell a codec
 *                                        that expanded its input from a lie.
 *   8    32    contentHash      bytes    SHA-256 of the original artifact, in
 *                                        digest order (NOT byte-swapped).
 *                                        contentHash32 above is its first four
 *                                        bytes read little-endian.
 *   40   2     chunkSize        u16 LE   Indexed: bytes per data frame.
 *                                        Fountain: symbol size.
 *   42   4     k                u32 LE   Fountain: source symbol count, and
 *                                        MUST equal the header's `total`.
 *                                        Indexed: 0.
 *   46   1     nameLen          u8       Length of `name` in BYTES, 1..255.
 *   47   var   name             bytes    Artifact name, UTF-8. Not covered by
 *                                        contentHash — it is the one sender-
 *                                        controlled field the hash does not
 *                                        reach, so finalize() sanitizes it.
 *
 * A data frame's payload is a slice of the codec output. Nothing else.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORT. The canonical frame is the byte array above and encodeFrame()
 * returns exactly that; it goes straight into a QR byte-mode segment with no
 * expansion.
 *
 * The decoder bundled with this app (vendor/qrdecode.js) cannot return it.
 * readSegments() collects the byte-mode octets and then hands them to
 * utf8Decode(), so its only output is a JS string: any frame that is not valid
 * UTF-8 comes back with replacement characters and the original bytes are gone.
 * That is a property of the decoder, not of QR — byte mode is 8-bit clean.
 *
 * So toTransport()/fromTransport() provide an ASCII armour for that channel:
 * the frame's bits are repacked 7 at a time into bytes 0x00-0x7F, which are
 * single-byte UTF-8 and therefore survive the decoder's TextDecoder exactly.
 * The cost is 8/7 = 14.3%, against base64url's 4/3 = 33.3%. It is the densest
 * armour available here: two-byte UTF-8 sequences carry 11 bits per 2 bytes
 * (5.5 bits/byte) versus ASCII's 7, so widening the alphabet loses.
 *
 * Both numbers are measured against v1 at a fixed QR version in proto2.test.js
 * rather than asserted here.
 * ---------------------------------------------------------------------------
 *
 * Browser: load core.js before this file (RVQRCore must exist).
 * Node:    require('./proto2.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.RVQRProto2 = factory(root.RVQRCore);
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  var PROTOCOL_VERSION = 2;
  var MAGIC = [0x52, 0x56, 0x51, 0x32]; // "RVQ2"
  var HEADER_BYTES = 28;
  var MANIFEST_FIXED_BYTES = 47;

  // v1's first byte. A v1 frame is JSON text, so it always starts '{'.
  var V1_FIRST_BYTE = 0x7b;

  // Transfer modes, as they appear on the wire. v1 spells these as strings in
  // JSON; here they are the numbers a header actually carries, and the string
  // names are kept only for reporting back to callers that speak v1's dialect.
  var MODE_INDEXED = 0;
  var MODE_FOUNTAIN = 1;
  var MODE_NAMES = ['indexed', 'fountain'];

  // Codec identifiers. 0 is "none" — a declared value, not a missing field.
  // A receiver that does not know a codec refuses the transfer; it never
  // assumes the bytes are uncompressed and hands them on.
  var CODEC_NONE = 0;
  var CODEC_SCF1 = 1;
  var CODEC_DEFLATE_RAW = 2;
  var CODEC_BROTLI = 3;
  var CODEC_NAMES = ['none', 'scf1', 'deflate-raw', 'brotli'];

  // Dictionary identifiers, same rule: 0 is "none", explicitly.
  //
  // These are separate from the codec on purpose. ADR-034's RVQS header carries
  // one SEED_COMPRESSED bit whose doc comment in rvf-types/src/qr_seed.rs reads
  // "Microkernel is Brotli-compressed", while SeedBuilder::compress_microkernel
  // in rvf-runtime/src/qr_seed.rs calls compress::compress — the zero-dependency
  // SCF-1 LZ77 codec. One bit cannot say which of those two produced the bytes,
  // so the flag and the payload are free to disagree, and they do. An explicit
  // codec id makes that disagreement unrepresentable.
  var DICT_NONE = 0;
  var DICT_NAMES = ['none'];

  // --- Hostile-input ceilings ------------------------------------------------
  // Taken from core.js rather than re-chosen, because a v2 receiver is exposed
  // to exactly the same thing a v1 receiver is: an unauthenticated frame from
  // whatever is pointed at the camera. Where v2 differs it is stricter, never
  // looser. Falling back to literals keeps this module loadable if core is
  // stubbed in a test.
  var MAX_FRAMES = core && core.MAX_FRAMES ? core.MAX_FRAMES : 65536;
  var MAX_RECEIVE_CHUNK = core && core.MAX_RECEIVE_CHUNK ? core.MAX_RECEIVE_CHUNK : 2953;
  var MAX_ARTIFACT_BYTES = core && core.MAX_ARTIFACT_BYTES ? core.MAX_ARTIFACT_BYTES : 256 * 1024 * 1024;
  var MAX_NAME_LENGTH = core && core.MAX_NAME_LENGTH ? core.MAX_NAME_LENGTH : 255;

  // The largest payload a single frame may declare. The header's u16 would
  // allow 65535; the transport cannot. A frame claiming more than a version 40
  // symbol holds is lying about how it arrived.
  var MAX_PAYLOAD_BYTES = MAX_RECEIVE_CHUNK;

  // u24 ceiling, so index and total are bounded by the field width as well as
  // by MAX_FRAMES. Stated rather than implied.
  var MAX_U24 = 0xffffff;

  // --- little-endian primitives ----------------------------------------------
  // Written out rather than reached for via DataView so the byte order is
  // visible at every call site and matches the table in the docblock exactly.

  function writeU16(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
  }

  function writeU24(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
  }

  function writeU32(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
    buf[off + 3] = (v >>> 24) & 0xff;
  }

  function readU16(buf, off) {
    return buf[off] | (buf[off + 1] << 8);
  }

  function readU24(buf, off) {
    return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  }

  function readU32(buf, off) {
    // >>> 0 because the top bit would otherwise make this negative, and a
    // negative size is exactly the kind of value that walks past a bound check.
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
  }

  // --- UTF-8 -----------------------------------------------------------------
  // Only the artifact name needs this. TextEncoder is used where it exists; the
  // fallback covers the BMP, which is what a filename realistically holds.

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // --- base128 ASCII armour --------------------------------------------------
  // Bits are taken most-significant-first from the frame and emitted 7 at a
  // time as bytes 0x00-0x7F. The final group is zero-padded, and fromTransport
  // insists those pad bits really are zero: two different strings must never
  // decode to the same frame, or a frame's identity stops being its bytes.

  function toTransport(frame) {
    var outLen = Math.ceil((frame.length * 8) / 7);
    var out = '';
    var acc = 0;
    var bits = 0;
    var produced = 0;
    for (var i = 0; i < frame.length; i++) {
      acc = ((acc << 8) | frame[i]) >>> 0;
      bits += 8;
      while (bits >= 7) {
        bits -= 7;
        out += String.fromCharCode((acc >>> bits) & 0x7f);
        produced++;
      }
    }
    if (produced < outLen) out += String.fromCharCode((acc << (7 - bits)) & 0x7f);
    return out;
  }

  /** Inverse of {@link toTransport}. Returns null on anything malformed. */
  function fromTransport(text) {
    var n = text.length;
    var outLen = Math.floor((n * 7) / 8);
    var out = new Uint8Array(outLen);
    var acc = 0;
    var bits = 0;
    var oi = 0;
    for (var i = 0; i < n; i++) {
      var c = text.charCodeAt(i);
      if (c > 0x7f) return null; // not something toTransport ever emits
      acc = ((acc << 7) | c) >>> 0;
      bits += 7;
      if (bits >= 8) {
        bits -= 8;
        if (oi >= outLen) return null;
        out[oi++] = (acc >>> bits) & 0xff;
      }
    }
    if (oi !== outLen) return null;
    if (bits && (acc & ((1 << bits) - 1)) !== 0) return null; // pad bits must be zero
    return out;
  }

  // --- identification --------------------------------------------------------

  function toBytes(input) {
    if (typeof input === 'string') return null;
    if (input instanceof Uint8Array) return input;
    if (input && typeof input.length === 'number') return Uint8Array.from(input);
    return null;
  }

  function hasMagic(bytes) {
    if (!bytes || bytes.length < MAGIC.length) return false;
    for (var i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
  }

  /**
   * Names the protocol a blob belongs to without decoding it.
   *
   * Returns 'v1', 'v2', 'v2-armoured', or 'unknown'. This is what lets a mixed
   * receiver route rather than guess: mis-decoding a frame from the other
   * protocol is the one failure worse than refusing it.
   */
  function identify(input) {
    if (typeof input === 'string') {
      if (input.charAt(0) === '{') return 'v1';
      var unpacked = fromTransport(input);
      if (hasMagic(unpacked)) return 'v2-armoured';
      return 'unknown';
    }
    var bytes = toBytes(input);
    if (!bytes || !bytes.length) return 'unknown';
    if (hasMagic(bytes)) return 'v2';
    if (bytes[0] === V1_FIRST_BYTE) return 'v1';
    return 'unknown';
  }

  // --- hashing ---------------------------------------------------------------

  /** The first four digest bytes as a little-endian u32 — the wire form. */
  function hash32(bytes) {
    var digest = core.sha256Bytes(bytes);
    return readU32(digest, 0);
  }

  function digestOf(bytes) {
    return core.sha256Bytes(bytes);
  }

  // --- construction ----------------------------------------------------------

  function normalizeTransferId(id) {
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return id >>> 0;
    if (typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)) return parseInt(id, 16) >>> 0;
    return null;
  }

  function transferIdHex(id) {
    var s = (id >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  function randomTransferId() {
    var bytes = new Uint8Array(4);
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.crypto && g.crypto.getRandomValues) g.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
    return readU32(bytes, 0);
  }

  /**
   * Serialises one frame: the 28-byte header followed by `payload`.
   *
   * Both hashes are computed here rather than accepted from the caller, so a
   * frame this function produced always agrees with itself.
   */
  function encodeFrame(fields) {
    var payload = fields.payload || new Uint8Array(0);
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new Error('payload of ' + payload.length + ' exceeds the ' + MAX_PAYLOAD_BYTES + '-byte frame ceiling');
    }
    var out = new Uint8Array(HEADER_BYTES + payload.length);
    out[0] = MAGIC[0];
    out[1] = MAGIC[1];
    out[2] = MAGIC[2];
    out[3] = MAGIC[3];
    out[4] = PROTOCOL_VERSION;
    out[5] = fields.mode;
    out[6] = fields.codecId;
    out[7] = fields.dictId;
    writeU32(out, 8, fields.transferId);
    writeU24(out, 12, fields.index);
    writeU24(out, 15, fields.total);
    writeU16(out, 18, payload.length);
    writeU32(out, 20, fields.contentHash32);
    writeU32(out, 24, hash32(payload));
    out.set(payload, HEADER_BYTES);
    return out;
  }

  /** Serialises the manifest body that becomes frame 0's payload. */
  function encodeManifestBody(m) {
    var nameBytes = utf8Encode(m.name);
    if (!nameBytes.length) throw new Error('artifact name is empty');
    if (nameBytes.length > MAX_NAME_LENGTH) {
      throw new Error('artifact name is ' + nameBytes.length + ' bytes, over the ' + MAX_NAME_LENGTH + '-byte limit');
    }
    var out = new Uint8Array(MANIFEST_FIXED_BYTES + nameBytes.length);
    writeU32(out, 0, m.originalSize);
    writeU32(out, 4, m.compressedSize);
    out.set(m.contentHash, 8);
    writeU16(out, 40, m.chunkSize);
    writeU32(out, 42, m.k);
    out[46] = nameBytes.length;
    out.set(nameBytes, MANIFEST_FIXED_BYTES);
    return out;
  }

  /** Pure arithmetic, matching core.frameCount: manifest plus the data frames. */
  function frameCount(streamSize, chunk) {
    return 1 + Math.ceil(streamSize / chunk);
  }

  /**
   * Builds every frame of an indexed v2 transfer.
   *
   * `bytes` is the original artifact — what the receiver must end up holding.
   * opts.stream is the codec's output, when a codec ran; absent, the artifact
   * is its own stream and codecId must be CODEC_NONE. Keeping the two separate
   * is what lets originalSize and compressedSize be checked against each other
   * rather than assumed equal.
   *
   * opts: { name, chunk, transferId, codecId, dictId, stream, contentHash }
   */
  function buildFrames(bytes, opts) {
    opts = opts || {};
    var codecId = opts.codecId === undefined ? CODEC_NONE : opts.codecId;
    var dictId = opts.dictId === undefined ? DICT_NONE : opts.dictId;
    var stream = opts.stream || bytes;
    if (codecId === CODEC_NONE && stream !== bytes && stream.length !== bytes.length) {
      throw new Error('a stream that differs from the artifact needs a codecId');
    }
    var chunk = clampChunk(opts.chunk);
    var name = core.sanitizeName(opts.name || 'artifact.bin');
    var digest = opts.contentHash || digestOf(bytes);
    var transferId = normalizeTransferId(opts.transferId);
    if (transferId === null) transferId = randomTransferId();
    var total = frameCount(stream.length, chunk);
    if (total > MAX_FRAMES) {
      throw new Error(total + ' frames exceeds the ' + MAX_FRAMES + '-frame ceiling');
    }
    var contentHash32 = readU32(digest, 0);

    var head = {
      mode: MODE_INDEXED, codecId: codecId, dictId: dictId,
      transferId: transferId, total: total, contentHash32: contentHash32
    };

    var manifest = encodeManifestBody({
      originalSize: bytes.length,
      compressedSize: stream.length,
      contentHash: digest,
      chunkSize: chunk,
      k: 0,
      name: name
    });

    var frames = [encodeFrame({
      mode: head.mode, codecId: head.codecId, dictId: head.dictId,
      transferId: head.transferId, index: 0, total: head.total,
      contentHash32: head.contentHash32, payload: manifest
    })];
    for (var seq = 1; seq < total; seq++) {
      var start = (seq - 1) * chunk;
      frames.push(encodeFrame({
        mode: head.mode, codecId: head.codecId, dictId: head.dictId,
        transferId: head.transferId, index: seq, total: head.total,
        contentHash32: head.contentHash32,
        payload: stream.subarray(start, Math.min(start + chunk, stream.length))
      }));
    }
    return {
      frames: frames,
      transferId: transferId,
      transferIdHex: transferIdHex(transferId),
      contentHash: digest,
      sha256: core.toHex(digest),
      chunk: chunk,
      total: total,
      originalSize: bytes.length,
      compressedSize: stream.length,
      codecId: codecId,
      dictId: dictId,
      name: name
    };
  }

  /**
   * The erasure-coded counterpart: a manifest plus an unbounded symbol factory.
   *
   * Mirrors core.buildFountainStream — there is no frame list because there is
   * no last frame; the receiver stops when it can decode.
   */
  function buildFountainStream(encoder, opts) {
    opts = opts || {};
    var codecId = opts.codecId === undefined ? CODEC_NONE : opts.codecId;
    var dictId = opts.dictId === undefined ? DICT_NONE : opts.dictId;
    var digest = opts.contentHash;
    if (!digest) throw new Error('buildFountainStream needs the artifact contentHash');
    var name = core.sanitizeName(opts.name || 'artifact.bin');
    var transferId = normalizeTransferId(opts.transferId);
    if (transferId === null) transferId = randomTransferId();
    var originalSize = opts.originalSize === undefined ? encoder.totalBytes : opts.originalSize;
    var compressedSize = opts.compressedSize === undefined ? encoder.totalBytes : opts.compressedSize;
    var contentHash32 = readU32(digest, 0);
    if (encoder.K > MAX_FRAMES) {
      throw new Error('K of ' + encoder.K + ' exceeds the ' + MAX_FRAMES + '-symbol ceiling');
    }

    var manifest = encodeFrame({
      mode: MODE_FOUNTAIN, codecId: codecId, dictId: dictId,
      transferId: transferId, index: 0, total: encoder.K,
      contentHash32: contentHash32,
      payload: encodeManifestBody({
        originalSize: originalSize,
        compressedSize: compressedSize,
        contentHash: digest,
        chunkSize: encoder.symbolSize,
        k: encoder.K,
        name: name
      })
    });

    return {
      manifest: manifest,
      transferId: transferId,
      transferIdHex: transferIdHex(transferId),
      contentHash: digest,
      K: encoder.K,
      symbolSize: encoder.symbolSize,
      symbolFrame: function (esi) {
        var sym = encoder.symbol(esi);
        return encodeFrame({
          mode: MODE_FOUNTAIN, codecId: codecId, dictId: dictId,
          transferId: transferId,
          index: sym.esi === undefined ? esi : sym.esi,
          total: encoder.K,
          contentHash32: contentHash32,
          payload: sym.bytes || sym.data || sym
        });
      }
    };
  }

  function clampChunk(chunk) {
    chunk = Math.floor(Number(chunk) || core.DEFAULT_CHUNK);
    if (chunk < core.MIN_CHUNK) chunk = core.MIN_CHUNK;
    if (chunk > MAX_PAYLOAD_BYTES) chunk = MAX_PAYLOAD_BYTES;
    return chunk;
  }

  // --- parsing ---------------------------------------------------------------

  function fail(reason) {
    return { ok: false, reason: reason };
  }

  /**
   * Parses one frame. Never throws; returns { ok:false, reason } instead.
   *
   * Accepts the canonical bytes, or an armoured string from a text-only
   * decoder. Every field a caller could act on is bounded here, before it
   * reaches an allocation or a loop, rather than at each use site.
   */
  function parseFrame(input) {
    var bytes;
    if (typeof input === 'string') {
      // A v1 frame arriving at a v2 parser is named, not mistaken for damage.
      if (input.charAt(0) === '{') return fail('v1-frame');
      bytes = fromTransport(input);
      if (!bytes) return fail('bad-transport');
    } else {
      bytes = toBytes(input);
      if (!bytes) return fail('not-a-frame');
      if (bytes.length && bytes[0] === V1_FIRST_BYTE && !hasMagic(bytes)) return fail('v1-frame');
    }

    if (bytes.length < HEADER_BYTES) return fail('truncated-header');
    if (!hasMagic(bytes)) return fail('bad-magic');
    if (bytes[4] !== PROTOCOL_VERSION) return fail('bad-version');

    var mode = bytes[5];
    if (mode !== MODE_INDEXED && mode !== MODE_FOUNTAIN) return fail('unknown-mode');
    var codecId = bytes[6];
    if (codecId >= CODEC_NAMES.length) return fail('unknown-codec');
    var dictId = bytes[7];
    if (dictId >= DICT_NAMES.length) return fail('unknown-dictionary');

    var transferId = readU32(bytes, 8);
    var index = readU24(bytes, 12);
    var total = readU24(bytes, 15);
    var payloadLen = readU16(bytes, 18);
    var contentHash32 = readU32(bytes, 20);
    var transportHash32 = readU32(bytes, 24);

    if (total < 1 || total > MAX_FRAMES) return fail('too-many-frames');
    // Repair symbols legitimately run above K, so the "index below total" rule
    // is an indexed-mode rule only. The absolute ceiling still applies to both.
    if (mode === MODE_INDEXED && index >= total) return fail('bad-index');
    if (index > MAX_U24 || index > MAX_FRAMES) return fail('bad-index');
    if (payloadLen > MAX_PAYLOAD_BYTES) return fail('payload-too-large');

    // The declared length must match the bytes that actually arrived. A frame
    // that disagrees with itself is rejected rather than trimmed to fit: a
    // truncated frame and a frame with a mis-stated length are the same event
    // from here, and neither is repairable.
    if (bytes.length - HEADER_BYTES !== payloadLen) return fail('length-mismatch');

    var payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLen);
    if (hash32(payload) !== transportHash32) return fail('transport-hash-mismatch');

    var frame = {
      kind: index === 0 ? 'manifest' : 'data',
      version: PROTOCOL_VERSION,
      mode: mode,
      modeName: MODE_NAMES[mode],
      codecId: codecId,
      codecName: CODEC_NAMES[codecId],
      dictId: dictId,
      dictName: DICT_NAMES[dictId],
      transferId: transferId,
      transferIdHex: transferIdHex(transferId),
      index: index,
      total: total,
      payloadLen: payloadLen,
      contentHash32: contentHash32,
      transportHash32: transportHash32,
      payload: payload
    };

    if (index !== 0) return { ok: true, frame: frame };
    return parseManifestBody(frame, payload);
  }

  function parseManifestBody(frame, body) {
    if (body.length < MANIFEST_FIXED_BYTES) return fail('truncated-manifest');
    var originalSize = readU32(body, 0);
    var compressedSize = readU32(body, 4);
    var contentHash = body.subarray(8, 40);
    var chunkSize = readU16(body, 40);
    var k = readU32(body, 42);
    var nameLen = body[46];

    if (originalSize > MAX_ARTIFACT_BYTES) return fail('artifact-too-large');
    if (compressedSize > MAX_ARTIFACT_BYTES) return fail('artifact-too-large');
    if (chunkSize < 1 || chunkSize > MAX_RECEIVE_CHUNK) return fail('bad-chunk');
    if (nameLen < 1 || nameLen > MAX_NAME_LENGTH) return fail('bad-name');
    if (body.length !== MANIFEST_FIXED_BYTES + nameLen) return fail('bad-name-length');

    // The header's prefix and the full digest have to be the same hash, or the
    // per-frame binding means nothing.
    if (readU32(contentHash, 0) !== frame.contentHash32) return fail('content-hash-mismatch');

    if (frame.mode === MODE_FOUNTAIN) {
      if (k < 1 || k > MAX_FRAMES) return fail('bad-symbol-count');
      if (k !== frame.total) return fail('frame-count-mismatch');
      // K has to follow from the stream size and the symbol size, or sender and
      // receiver disagree about the object before a symbol has arrived.
      if (Math.ceil(compressedSize / chunkSize) !== k) return fail('symbol-count-mismatch');
    } else {
      if (k !== 0) return fail('bad-symbol-count');
      if (frameCount(compressedSize, chunkSize) !== frame.total) return fail('frame-count-mismatch');
    }
    // Without a codec the two sizes describe the same bytes, so a manifest that
    // states different ones has already contradicted itself.
    if (frame.codecId === CODEC_NONE && originalSize !== compressedSize) {
      return fail('size-mismatch');
    }

    frame.manifest = {
      originalSize: originalSize,
      compressedSize: compressedSize,
      contentHash: contentHash,
      sha256: core.toHex(contentHash),
      chunkSize: chunkSize,
      k: k,
      name: utf8Decode(body.subarray(MANIFEST_FIXED_BYTES))
    };
    return { ok: true, frame: frame };
  }

  // --- receiver --------------------------------------------------------------
  // Deliberately the same shape as core.createReceiver so the two can sit
  // behind one UI, but it is a separate state machine: sharing one would mean
  // one protocol's bug is both protocols' bug.

  function createReceiver() {
    return {
      status: 'IDLE',
      transferId: null,
      contentHash32: null,
      total: 0,
      manifest: null,
      mode: MODE_INDEXED,
      codecId: CODEC_NONE,
      dictId: DICT_NONE,
      chunks: Object.create(null),
      received: 0,
      duplicates: 0,
      rejected: 0,
      codec: null,
      decodable: false,
      result: null
    };
  }

  /** Supplies the erasure-code decoder a fountain transfer needs. */
  function useCodec(state, codec) {
    state.codec = codec || null;
    return state;
  }

  function adoptTransfer(state, f) {
    state.status = 'COLLECTING';
    state.transferId = f.transferId;
    state.contentHash32 = f.contentHash32;
    state.total = f.total;
    state.mode = f.mode;
    state.codecId = f.codecId;
    state.dictId = f.dictId;
    state.manifest = null;
    state.chunks = Object.create(null);
    state.received = 0;
    state.duplicates = 0;
    state.decodable = false;
    state.result = null;
  }

  function isComplete(state) {
    if (!state.manifest || !state.total) return false;
    if (state.mode === MODE_FOUNTAIN) return !!state.decodable;
    for (var i = 1; i < state.total; i++) if (!(i in state.chunks)) return false;
    return true;
  }

  /**
   * Feeds one frame (bytes, armoured string, or a pre-parsed frame) into a
   * receiver. Returns { accepted, reason, complete } and mutates in place.
   */
  function ingest(state, input) {
    var parsed = input && input.kind ? { ok: true, frame: input } : parseFrame(input);
    if (!parsed.ok) {
      state.rejected++;
      return { accepted: false, reason: parsed.reason, complete: false };
    }
    var f = parsed.frame;

    if (state.status === 'IDLE') {
      adoptTransfer(state, f);
    } else if (f.transferId !== state.transferId) {
      state.rejected++;
      return { accepted: false, reason: 'other-transfer', complete: isComplete(state) };
    } else if (f.mode !== state.mode) {
      state.rejected++;
      return { accepted: false, reason: 'mode-mismatch', complete: isComplete(state) };
    } else if (f.codecId !== state.codecId || f.dictId !== state.dictId) {
      // Two frames of one transfer disagreeing about how to read the bytes is
      // not something a receiver can average out.
      state.rejected++;
      return { accepted: false, reason: 'codec-mismatch', complete: isComplete(state) };
    } else if (f.contentHash32 !== state.contentHash32 || f.total !== state.total) {
      state.rejected++;
      return { accepted: false, reason: 'inconsistent-frame', complete: isComplete(state) };
    }

    if (f.kind === 'manifest') {
      if (state.manifest) {
        state.duplicates++;
        return { accepted: false, reason: 'duplicate', complete: isComplete(state) };
      }
      state.manifest = f.manifest;
    } else if (f.index in state.chunks) {
      state.duplicates++;
      return { accepted: false, reason: 'duplicate', complete: isComplete(state) };
    } else {
      state.chunks[f.index] = f.payload;
      state.received++;
      if (state.mode === MODE_FOUNTAIN && state.codec) {
        try {
          state.decodable = state.codec.add({ esi: f.index, bytes: f.payload }) === true;
        } catch (e) {
          state.rejected++;
          return { accepted: false, reason: 'codec-rejected', complete: false };
        }
      }
    }

    var complete = isComplete(state);
    if (complete && state.status === 'COLLECTING') state.status = 'COMPLETE';
    return { accepted: true, reason: null, complete: complete };
  }

  /** Concatenates the collected chunks into the codec's output stream. */
  function assemble(state) {
    var m = state.manifest;
    if (state.mode === MODE_FOUNTAIN) {
      if (!state.codec) throw new Error('no decoder attached for an erasure-coded transfer');
      var decoded = state.codec.decode();
      if (!decoded) throw new Error('not enough symbols to decode yet');
      if (decoded.length < m.compressedSize) throw new Error('decoded stream is short');
      return decoded.length === m.compressedSize ? decoded : decoded.subarray(0, m.compressedSize);
    }
    var out = new Uint8Array(m.compressedSize);
    var offset = 0;
    for (var i = 1; i < state.total; i++) {
      var part = state.chunks[i];
      if (!part) throw new Error('assemble called before the transfer completed');
      if (offset + part.length > m.compressedSize) throw new Error('chunks overrun the declared stream');
      out.set(part, offset);
      offset += part.length;
    }
    if (offset !== m.compressedSize) throw new Error('assembled length mismatch');
    return out;
  }

  /**
   * Assembles, decodes, and verifies. Nothing is handed back as accepted unless
   * the SHA-256 of the reconstructed artifact matches the manifest exactly.
   *
   * opts.decode is called as decode(stream, codecId, dictId) when codecId is
   * not CODEC_NONE. Without it a compressed transfer is refused rather than
   * handed over as though the stream were the artifact.
   */
  function finalize(state, opts) {
    opts = opts || {};
    if (!isComplete(state)) return { ok: false, reason: 'incomplete' };
    var m = state.manifest;
    var stream;
    try {
      stream = assemble(state);
    } catch (e) {
      state.status = 'REJECTED';
      return { ok: false, reason: 'assembly-failed' };
    }
    if (stream.length !== m.compressedSize) {
      state.status = 'REJECTED';
      return { ok: false, reason: 'compressed-size-mismatch' };
    }

    var bytes = stream;
    if (state.codecId !== CODEC_NONE) {
      if (typeof opts.decode !== 'function') {
        state.status = 'REJECTED';
        return { ok: false, reason: 'no-codec' };
      }
      try {
        bytes = opts.decode(stream, state.codecId, state.dictId);
      } catch (e) {
        state.status = 'REJECTED';
        return { ok: false, reason: 'decode-failed' };
      }
      if (!bytes || bytes.length !== m.originalSize) {
        state.status = 'REJECTED';
        return { ok: false, reason: 'original-size-mismatch' };
      }
    } else if (bytes.length !== m.originalSize) {
      state.status = 'REJECTED';
      return { ok: false, reason: 'original-size-mismatch' };
    }

    var digest = (opts.hashFn || digestOf)(bytes);
    var actual = core.toHex(digest);
    if (actual !== m.sha256) {
      state.status = 'REJECTED';
      state.result = { ok: false, reason: 'hash-mismatch', expected: m.sha256, actual: actual };
      return state.result;
    }
    state.status = 'VERIFIED';
    // The name is the one sender-controlled field the content hash does not
    // cover, so it is stripped and clamped here rather than trusted downstream.
    state.result = {
      ok: true,
      bytes: bytes,
      sha256: actual,
      name: core.sanitizeName(m.name),
      declaredName: m.name
    };
    return state.result;
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    MAGIC: MAGIC,
    HEADER_BYTES: HEADER_BYTES,
    MANIFEST_FIXED_BYTES: MANIFEST_FIXED_BYTES,
    MODE_INDEXED: MODE_INDEXED,
    MODE_FOUNTAIN: MODE_FOUNTAIN,
    MODE_NAMES: MODE_NAMES,
    CODEC_NONE: CODEC_NONE,
    CODEC_SCF1: CODEC_SCF1,
    CODEC_DEFLATE_RAW: CODEC_DEFLATE_RAW,
    CODEC_BROTLI: CODEC_BROTLI,
    CODEC_NAMES: CODEC_NAMES,
    DICT_NONE: DICT_NONE,
    DICT_NAMES: DICT_NAMES,
    MAX_FRAMES: MAX_FRAMES,
    MAX_RECEIVE_CHUNK: MAX_RECEIVE_CHUNK,
    MAX_ARTIFACT_BYTES: MAX_ARTIFACT_BYTES,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    toTransport: toTransport,
    fromTransport: fromTransport,
    identify: identify,
    clampChunk: clampChunk,
    frameCount: frameCount,
    randomTransferId: randomTransferId,
    transferIdHex: transferIdHex,
    encodeFrame: encodeFrame,
    encodeManifestBody: encodeManifestBody,
    buildFrames: buildFrames,
    buildFountainStream: buildFountainStream,
    parseFrame: parseFrame,
    createReceiver: createReceiver,
    useCodec: useCodec,
    ingest: ingest,
    isComplete: isComplete,
    assemble: assemble,
    finalize: finalize
  };
});
