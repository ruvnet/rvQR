/*!
 * rvQR delta — segment-level differential transfer for RVF containers.
 *
 * The receiver shows an inventory of what it already holds; the sender diffs
 * that against its own container and transmits only the segments the receiver
 * is missing. A container whose vectors are unchanged but whose manifest was
 * rewritten moves a manifest, not a gigabyte.
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network. The RVF parser is injected so the browser can pass the real
 * microkernel wasm (the authoritative parser) while Node tests can run either
 * that or the byte-faithful JS scanner in this file.
 *
 * Browser: load core.js before this file (RVQRCore must exist).
 * Node:    require('./delta.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.RVQRDelta = factory(root.RVQRCore);
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  // --- RVF v1 wire constants (ADR-009) ---------------------------------------
  // The magic values are the little-endian serialization of the numeric
  // constants, NOT the ASCII spelling of their mnemonics: SEGMENT_MAGIC is
  // 0x52564653 ("RVFS" read big-endian) and appears on the wire as 53 46 56 52.
  // Comparing against b'RVFS' would reject every real RVF file.

  var SEGMENT_MAGIC = [0x53, 0x46, 0x56, 0x52];
  var ROOT_MANIFEST_MAGIC = [0x30, 0x4d, 0x56, 0x52];
  var SEGMENT_HEADER_SIZE = 64;
  var SEGMENT_ALIGNMENT = 64;
  var ROOT_MANIFEST_SIZE = 4096;
  var SEGMENT_VERSION = 1;

  // --- Hostile-input ceilings ------------------------------------------------
  // A delta payload arrives over the same unauthenticated optical channel as
  // everything else, and an inventory arrives from whatever was pointed at the
  // camera. Every count and length taken from either one is bounded here,
  // before it reaches an allocation or a loop.

  // Segments a container may declare. The demo container has four; a large
  // production container has thousands. 65535 keeps the span table under a
  // megabyte at the default hash width and fits the u16 the wire format uses.
  var MAX_SPANS = 65535;

  // Largest container this module will reconstruct. Bounds the single
  // allocation in applyDelta(). 2 GiB is well past what a browser will hold
  // comfortably and comfortably inside the u32 the wire format uses for sizes.
  var MAX_CONTAINER_BYTES = 2 * 1024 * 1024 * 1024;

  // Bytes of SHA-256 carried per span. Spans are matched by hash, so this is
  // the collision surface *within one container*: 64 bits over a few thousand
  // spans is a birthday probability around 1e-13, and a collision that did
  // occur would be caught by the whole-file digest check at the end of
  // applyDelta rather than producing wrong bytes.
  var DEFAULT_HASH_BYTES = 8;
  var MAX_HASH_BYTES = 32;

  var INVENTORY_MAGIC = [0x52, 0x56, 0x51, 0x49]; // 'RVQI'
  var DELTA_MAGIC = [0x52, 0x56, 0x51, 0x44]; // 'RVQD'
  var INVENTORY_VERSION = 1;
  var DELTA_VERSION = 1;
  var INVENTORY_HEADER = 44; // magic..root inclusive
  var DELTA_HEADER = 88; // magic..baseRoot inclusive

  var KIND_GAP = 0;
  var KIND_SEGMENT = 1;

  /**
   * Every rejection from this module is a DeltaError with a stable `reason`
   * string. Callers switch on the reason; the message is for humans.
   */
  function DeltaError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'DeltaError';
    err.reason = reason;
    return err;
  }

  function fail(reason, message) {
    throw DeltaError(reason, message);
  }

  // --- Segment type names (rvf_types::SegmentType) ---------------------------

  var SEGMENT_TYPE_NAMES = {
    0x00: 'INVALID', 0x01: 'VEC', 0x02: 'INDEX', 0x03: 'OVERLAY',
    0x04: 'JOURNAL', 0x05: 'MANIFEST', 0x06: 'QUANT', 0x07: 'META',
    0x08: 'HOT', 0x09: 'SKETCH', 0x0a: 'WITNESS', 0x0b: 'PROFILE',
    0x0c: 'CRYPTO', 0x0d: 'METAIDX', 0x0e: 'KERNEL', 0x0f: 'EBPF',
    0x10: 'WASM', 0x11: 'DASHBOARD', 0x20: 'COWMAP', 0x21: 'REFCOUNT',
    0x22: 'MEMBERSHIP', 0x23: 'DELTA', 0x30: 'TRANSFER_PRIOR',
    0x31: 'POLICY_KERNEL', 0x32: 'COST_CURVE', 0x33: 'FEDERATED_MANIFEST'
  };

  function segmentTypeName(type) {
    return SEGMENT_TYPE_NAMES[type] || 'TYPE_0x' + type.toString(16);
  }

  // --- Byte helpers ----------------------------------------------------------

  function matchesAt(bytes, magic, offset) {
    if (offset < 0 || offset + magic.length > bytes.length) return false;
    for (var i = 0; i < magic.length; i++) {
      if (bytes[offset + i] !== magic[i]) return false;
    }
    return true;
  }

  function readU32(bytes, off) {
    return (
      bytes[off] +
      bytes[off + 1] * 0x100 +
      bytes[off + 2] * 0x10000 +
      bytes[off + 3] * 0x1000000
    );
  }

  function writeU32(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
    bytes[off + 2] = (value >>> 16) & 0xff;
    bytes[off + 3] = (value >>> 24) & 0xff;
  }

  function readU16(bytes, off) {
    return bytes[off] + bytes[off + 1] * 0x100;
  }

  function writeU16(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function hashSpan(bytes, offset, length, hashBytes) {
    var digest = core.sha256Bytes(bytes.subarray(offset, offset + length));
    return core.toHex(digest.subarray(0, hashBytes));
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length >>> 1);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  // --- Pure-JS segment scanner -----------------------------------------------

  /**
   * Enumerates segments exactly the way the RVF microkernel does.
   *
   * This mirrors `rvf_wasm::segment::parse_segments` byte for byte, including
   * two behaviours that look like bugs and are not: the scan advances one byte
   * at a time until it finds a magic, so bytes between segments are simply
   * skipped rather than rejected; and the skip distance is computed with the
   * declared payload length truncated to 32 bits, because the microkernel is
   * wasm32 and casts the u64 to usize. A scanner that used the full u64 would
   * disagree with the authoritative parser on exactly the hostile inputs where
   * agreement matters, so it truncates too and reports the full value
   * separately.
   *
   * Never throws and never allocates proportionally to a declared length.
   */
  function scanSegments(bytes) {
    var out = [];
    if (!bytes || bytes.length < SEGMENT_HEADER_SIZE) return out;
    var last = bytes.length - SEGMENT_HEADER_SIZE;
    var i = 0;
    while (i <= last) {
      if (matchesAt(bytes, SEGMENT_MAGIC, i)) {
        if (bytes[i + 4] !== SEGMENT_VERSION) {
          i += 1;
          continue;
        }
        var segType = bytes[i + 5];
        var idLo = readU32(bytes, i + 8);
        var idHi = readU32(bytes, i + 12);
        var lenLo = readU32(bytes, i + 16);
        var lenHi = readU32(bytes, i + 20);
        out.push({
          index: out.length,
          segId: idHi * 0x100000000 + idLo,
          type: segType,
          offset: i,
          payloadLength: lenHi * 0x100000000 + lenLo
        });
        if (out.length > MAX_SPANS) return out;
        // Truncated to 32 bits to match the wasm32 `as usize` cast; the +64
        // header keeps this strictly greater than i, so the walk terminates.
        i += SEGMENT_HEADER_SIZE + lenLo;
        continue;
      }
      i += 1;
    }
    return out;
  }

  /** The built-in parser: the JS scanner above, wrapped in the parser shape. */
  var jsParser = {
    name: 'js',
    scan: scanSegments
  };

  /**
   * Wraps the RVF microkernel wasm as a parser. `exports` is the instantiated
   * module's exports object — the module has zero imports, so
   * `WebAssembly.instantiate(bytes, {})` is enough to produce it.
   *
   * The wasm is the authoritative parser: it is the same code that reads these
   * containers everywhere else. Its segment_info record is
   * [seg_id u64][type u8][pad 3][payload_len u64][offset u64] = 28 bytes.
   */
  function wasmParser(exports) {
    if (!exports || typeof exports.rvf_segment_count !== 'function' ||
        typeof exports.rvf_segment_info !== 'function' ||
        typeof exports.rvf_alloc !== 'function' || !exports.memory) {
      fail('bad-wasm-exports', 'not an RVF microkernel instance');
    }
    return {
      name: 'wasm',
      exports: exports,
      scan: function (bytes) {
        var out = [];
        if (!bytes || bytes.length < SEGMENT_HEADER_SIZE) return out;
        var ptr = exports.rvf_alloc(bytes.length);
        var infoPtr = exports.rvf_alloc(32);
        if (!ptr || !infoPtr) fail('wasm-alloc-failed', 'microkernel allocation failed');
        try {
          new Uint8Array(exports.memory.buffer).set(bytes, ptr);
          var count = exports.rvf_segment_count(ptr, bytes.length);
          if (count < 0) fail('wasm-parse-failed', 'segment count returned ' + count);
          if (count > MAX_SPANS) fail('too-many-segments', count + ' segments exceeds ceiling');
          for (var i = 0; i < count; i++) {
            if (exports.rvf_segment_info(ptr, bytes.length, i, infoPtr) !== 0) {
              fail('wasm-parse-failed', 'segment_info failed at index ' + i);
            }
            // The memory may have been grown by an allocation above, so the
            // view is rebuilt rather than cached.
            var rec = new Uint8Array(exports.memory.buffer, infoPtr, 28);
            out.push({
              index: i,
              segId: readU32(rec, 4) * 0x100000000 + readU32(rec, 0),
              type: rec[8],
              offset: readU32(rec, 24) * 0x100000000 + readU32(rec, 20),
              payloadLength: readU32(rec, 16) * 0x100000000 + readU32(rec, 12)
            });
          }
          return out;
        } finally {
          if (typeof exports.rvf_free === 'function') {
            exports.rvf_free(infoPtr, 32);
            exports.rvf_free(ptr, bytes.length);
          }
        }
      }
    };
  }

  function resolveParser(parser) {
    if (!parser) return jsParser;
    if (typeof parser === 'function') return { name: 'custom', scan: parser };
    if (typeof parser.scan === 'function') return parser;
    if (typeof parser.rvf_segment_count === 'function') return wasmParser(parser);
    fail('bad-parser', 'parser must expose scan(bytes)');
  }

  // --- Segment index and span plan -------------------------------------------

  /**
   * Enumerates the segments of a container.
   *
   * Returns [{ index, type, typeName, segId, offset, payloadLength, length,
   * hash }] where `length` is the whole segment including its 64-byte header
   * and `hash` is the full SHA-256 of those bytes.
   */
  function segmentIndex(bytes, opts) {
    opts = opts || {};
    var parser = resolveParser(opts.parser);
    var raw = parser.scan(bytes);
    if (raw.length > MAX_SPANS) fail('too-many-segments', raw.length + ' segments exceeds ceiling');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var seg = raw[i];
      var total = SEGMENT_HEADER_SIZE + seg.payloadLength;
      // A declared payload length is a number in a file, not a promise. If it
      // runs past the end of the buffer the container is malformed, and a
      // delta computed over it would be meaningless.
      if (seg.offset < 0 || seg.offset > bytes.length ||
          total > bytes.length - seg.offset) {
        fail(
          'segment-out-of-bounds',
          'segment ' + i + ' at ' + seg.offset + ' declares ' + seg.payloadLength +
            ' payload bytes, past the end of a ' + bytes.length + '-byte container'
        );
      }
      out.push({
        index: i,
        type: seg.type,
        typeName: segmentTypeName(seg.type),
        segId: seg.segId,
        offset: seg.offset,
        payloadLength: seg.payloadLength,
        length: total,
        hash: hashSpan(bytes, seg.offset, total, 32)
      });
    }
    return out;
  }

  /**
   * The ordered, contiguous list of byte ranges that make up a container:
   * every segment, plus a gap span for any run of bytes between or around them
   * that the parser skipped.
   *
   * Full coverage is what makes byte-identical reconstruction possible. A delta
   * that only knew about segments would silently drop whatever the scanner
   * walked over, and the result would hash differently for reasons nobody
   * could see.
   */
  function spanPlan(bytes, opts) {
    opts = opts || {};
    var hashBytes = clampHashBytes(opts.hashBytes);
    var segs = segmentIndex(bytes, opts);
    var spans = [];
    var cursor = 0;

    function pushGap(end) {
      if (end <= cursor) return;
      spans.push({
        kind: KIND_GAP,
        index: spans.length,
        type: 0,
        typeName: 'GAP',
        segmentIndex: -1,
        offset: cursor,
        length: end - cursor,
        hash: hashSpan(bytes, cursor, end - cursor, hashBytes)
      });
      cursor = end;
    }

    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      pushGap(seg.offset);
      spans.push({
        kind: KIND_SEGMENT,
        index: spans.length,
        type: seg.type,
        typeName: seg.typeName,
        segmentIndex: seg.index,
        offset: seg.offset,
        length: seg.length,
        hash: hashSpan(bytes, seg.offset, seg.length, hashBytes)
      });
      cursor = seg.offset + seg.length;
    }
    pushGap(bytes.length);

    if (spans.length > MAX_SPANS) fail('too-many-spans', spans.length + ' spans exceeds ceiling');
    return spans;
  }

  function clampHashBytes(n) {
    n = Math.floor(Number(n) || DEFAULT_HASH_BYTES);
    if (n < 4) n = 4;
    if (n > MAX_HASH_BYTES) n = MAX_HASH_BYTES;
    return n;
  }

  // --- Inventory -------------------------------------------------------------

  /**
   * What a holder has, in the most compact form that still supports an exact
   * diff: the whole-container digest plus one record per span.
   *
   * The root is a full SHA-256 because it is what a delta binds itself to; the
   * per-span hashes are truncated because they only have to be unique within
   * one container.
   */
  function inventory(bytes, opts) {
    opts = opts || {};
    if (bytes.length > MAX_CONTAINER_BYTES) {
      fail('container-too-large', bytes.length + ' bytes exceeds the ' + MAX_CONTAINER_BYTES + '-byte ceiling');
    }
    var hashBytes = clampHashBytes(opts.hashBytes);
    var spans = spanPlan(bytes, { parser: opts.parser, hashBytes: hashBytes });
    return {
      v: INVENTORY_VERSION,
      size: bytes.length,
      hashBytes: hashBytes,
      root: core.sha256Hex(bytes),
      spans: spans.map(function (s) {
        return {
          kind: s.kind,
          index: s.index,
          type: s.type,
          typeName: s.typeName,
          offset: s.offset,
          length: s.length,
          hash: s.hash
        };
      })
    };
  }

  /** Serializes an inventory to the compact binary form, base64url encoded. */
  function encodeInventory(inv) {
    var hashBytes = clampHashBytes(inv.hashBytes);
    var spans = inv.spans || [];
    if (spans.length > MAX_SPANS) fail('too-many-spans', 'inventory has ' + spans.length + ' spans');
    var recordSize = 6 + hashBytes;
    var out = new Uint8Array(INVENTORY_HEADER + spans.length * recordSize);
    out.set(INVENTORY_MAGIC, 0);
    out[4] = INVENTORY_VERSION;
    out[5] = hashBytes;
    writeU16(out, 6, spans.length);
    writeU32(out, 8, inv.size);
    out.set(hexToBytes(inv.root), 12);
    var at = INVENTORY_HEADER;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      out[at] = s.kind;
      out[at + 1] = s.type;
      writeU32(out, at + 2, s.length);
      out.set(hexToBytes(s.hash).subarray(0, hashBytes), at + 6);
      at += recordSize;
    }
    return core.b64uEncode(out);
  }

  /**
   * Parses an encoded inventory. Bounds every declared count against the bytes
   * actually present before allocating anything, and rejects a span table
   * whose lengths do not add up to the declared size — an inventory that does
   * not describe a whole container cannot drive a reconstruction.
   */
  function decodeInventory(text) {
    var bytes;
    try {
      bytes = core.b64uDecode(String(text));
    } catch (e) {
      fail('bad-inventory-encoding', 'not valid base64url');
    }
    if (bytes.length < INVENTORY_HEADER) fail('bad-inventory', 'shorter than the header');
    if (!matchesAt(bytes, INVENTORY_MAGIC, 0)) fail('bad-inventory-magic', 'not an rvQR inventory');
    if (bytes[4] !== INVENTORY_VERSION) fail('bad-inventory-version', 'version ' + bytes[4]);
    var hashBytes = bytes[5];
    if (hashBytes < 4 || hashBytes > MAX_HASH_BYTES) fail('bad-inventory', 'hash width ' + hashBytes);
    var count = readU16(bytes, 6);
    var size = readU32(bytes, 8);
    if (size > MAX_CONTAINER_BYTES) fail('container-too-large', size + ' bytes declared');
    var recordSize = 6 + hashBytes;
    if (bytes.length !== INVENTORY_HEADER + count * recordSize) {
      fail('bad-inventory', 'span table length disagrees with the declared count');
    }
    var root = core.toHex(bytes.subarray(12, 44));
    var spans = [];
    var total = 0;
    var at = INVENTORY_HEADER;
    for (var i = 0; i < count; i++) {
      var kind = bytes[at];
      if (kind !== KIND_GAP && kind !== KIND_SEGMENT) fail('bad-inventory', 'span ' + i + ' kind ' + kind);
      var length = readU32(bytes, at + 2);
      if (length < 1) fail('bad-inventory', 'span ' + i + ' is empty');
      total += length;
      if (total > size) fail('bad-inventory', 'spans overrun the declared size');
      spans.push({
        kind: kind,
        index: i,
        type: bytes[at + 1],
        typeName: kind === KIND_SEGMENT ? segmentTypeName(bytes[at + 1]) : 'GAP',
        offset: total - length,
        length: length,
        hash: core.toHex(bytes.subarray(at + 6, at + 6 + hashBytes))
      });
      at += recordSize;
    }
    if (total !== size) fail('bad-inventory', 'spans cover ' + total + ' of ' + size + ' bytes');
    return { v: INVENTORY_VERSION, size: size, hashBytes: hashBytes, root: root, spans: spans };
  }

  // --- QR sizing -------------------------------------------------------------
  // Byte-mode capacities from ISO/IEC 18004. Kept here rather than imported so
  // this module stays free of the renderer; delta.test.js checks every entry
  // against the vendored encoder, so the two cannot drift apart silently.

  var QR_BYTE_CAPACITY = {
    L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520,
        586, 644, 718, 792, 858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528,
        1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953],
    M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412,
        450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190,
        1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331],
    Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322,
        364, 394, 442, 482, 509, 565, 611, 661, 715, 751, 805, 868, 908, 982,
        1030, 1112, 1168, 1228, 1283, 1351, 1423, 1499, 1579, 1663],
    H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250,
        280, 310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742,
        790, 842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273]
  };

  function byteCapacity(version, ecl) {
    var table = QR_BYTE_CAPACITY[ecl || 'L'];
    if (!table || version < 1 || version > 40) return 0;
    return table[version - 1];
  }

  /**
   * Smallest QR version that holds `byteLength` bytes at an error correction
   * level, or null if it does not fit in a single symbol at all.
   */
  function qrVersionFor(byteLength, ecl) {
    var level = ecl || 'L';
    var table = QR_BYTE_CAPACITY[level];
    if (!table) fail('bad-ecl', 'unknown error correction level ' + ecl);
    for (var v = 1; v <= 40; v++) {
      if (byteLength <= table[v - 1]) {
        return { version: v, ecl: level, capacity: table[v - 1], bytes: byteLength };
      }
    }
    return null;
  }

  /**
   * Measures an inventory as a QR payload: encoded length, the version it
   * needs, and how many symbols it takes if it needs more than one.
   */
  function inventoryQr(inv, opts) {
    opts = opts || {};
    var text = typeof inv === 'string' ? inv : encodeInventory(inv);
    var ecl = opts.ecl || 'L';
    var fit = qrVersionFor(text.length, ecl);
    if (fit) {
      return {
        bytes: text.length, ecl: ecl, version: fit.version,
        capacity: fit.capacity, chunks: 1, text: text
      };
    }
    var chunks = chunkInventory(text, opts.capacity || byteCapacity(40, ecl));
    return {
      bytes: text.length, ecl: ecl, version: 40,
      capacity: byteCapacity(40, ecl), chunks: chunks.length, text: text
    };
  }

  // --- Chunked inventory -----------------------------------------------------
  // An inventory for a container with thousands of segments does not fit one
  // symbol. Rather than degrade the inventory (a partial inventory would make
  // the sender re-send segments the receiver already has), it is split across a
  // short sequence of symbols with a header that makes each self-locating.

  var CHUNK_PREFIX = 'RVQI1:';

  function chunkInventory(text, capacity) {
    var cap = Math.floor(Number(capacity) || byteCapacity(40, 'L'));
    // The header is 'RVQI1:<8 hex id>:<idx>/<n>:' — 24 characters at the sizes
    // any real inventory reaches. Reserve 32 so the arithmetic has slack.
    var room = cap - 32;
    if (room < 16) fail('bad-capacity', 'capacity ' + cap + ' leaves no room for a chunk header');
    var count = Math.ceil(text.length / room) || 1;
    if (count > 999) fail('inventory-too-large', count + ' chunks would be needed');
    var id = core.sha256Hex(asciiBytes(text)).slice(0, 8);
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(CHUNK_PREFIX + id + ':' + i + '/' + count + ':' + text.substr(i * room, room));
    }
    return out;
  }

  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * Reassembles chunks produced by chunkInventory. Order does not matter;
   * duplicates are tolerated; a missing chunk, a mixed id, or a payload whose
   * digest does not match the id in the header is a rejection.
   */
  function joinInventoryChunks(chunks) {
    if (!chunks || !chunks.length) fail('bad-chunks', 'no chunks');
    var id = null, count = null;
    var parts = [];
    for (var i = 0; i < chunks.length; i++) {
      var text = String(chunks[i]);
      if (text.slice(0, CHUNK_PREFIX.length) !== CHUNK_PREFIX) fail('bad-chunks', 'chunk ' + i + ' is not an inventory chunk');
      var m = /^RVQI1:([0-9a-f]{8}):(\d{1,3})\/(\d{1,3}):([A-Za-z0-9_-]*)$/.exec(text);
      if (!m) fail('bad-chunks', 'chunk ' + i + ' has a malformed header');
      var idx = Number(m[2]);
      var n = Number(m[3]);
      if (id === null) { id = m[1]; count = n; }
      else if (m[1] !== id || n !== count) fail('bad-chunks', 'chunk ' + i + ' belongs to a different inventory');
      if (idx >= count) fail('bad-chunks', 'chunk index ' + idx + ' of ' + count);
      parts[idx] = m[4];
    }
    for (var j = 0; j < count; j++) {
      if (parts[j] === undefined) fail('missing-chunk', 'chunk ' + j + ' of ' + count + ' never arrived');
    }
    var joined = parts.join('');
    if (core.sha256Hex(asciiBytes(joined)).slice(0, 8) !== id) {
      fail('bad-chunks', 'reassembled inventory does not match its id');
    }
    return joined;
  }

  // --- Diff ------------------------------------------------------------------

  function spansOf(side) {
    if (!side) return [];
    if (Array.isArray(side)) return side;
    if (Array.isArray(side.spans)) return side.spans;
    fail('bad-diff-input', 'expected an inventory or a span array');
  }

  /**
   * Which of the sender's spans the receiver does not already hold.
   *
   * Pure: it reads hashes and lengths, never bytes. `missing` indexes the
   * sender's span list. A receiver of null (or an empty inventory) means a
   * cold start, where everything is missing and the ratio is 1.
   */
  function diff(sender, receiver) {
    var senderSpans = spansOf(sender);
    var receiverSpans = spansOf(receiver);

    var held = Object.create(null);
    for (var r = 0; r < receiverSpans.length; r++) {
      var rs = receiverSpans[r];
      held[rs.hash + ':' + rs.length] = true;
    }

    var missing = [];
    var present = [];
    var bytesToSend = 0;
    var bytesTotal = 0;
    for (var i = 0; i < senderSpans.length; i++) {
      var s = senderSpans[i];
      bytesTotal += s.length;
      if (held[s.hash + ':' + s.length]) {
        present.push(i);
      } else {
        missing.push(i);
        bytesToSend += s.length;
      }
    }

    return {
      missing: missing,
      present: present,
      missingSegments: missing.filter(function (i) {
        return senderSpans[i].kind !== KIND_GAP;
      }).map(function (i) {
        return senderSpans[i].segmentIndex === undefined ? i : senderSpans[i].segmentIndex;
      }),
      bytesToSend: bytesToSend,
      bytesTotal: bytesTotal,
      bytesSaved: bytesTotal - bytesToSend,
      savedFraction: bytesTotal ? (bytesTotal - bytesToSend) / bytesTotal : 0,
      // How many times less data than a full transfer. Infinite when the
      // receiver already holds every span, which is a real answer: nothing at
      // all has to cross the channel.
      ratio: bytesToSend ? bytesTotal / bytesToSend : Infinity,
      sameRoot: !!(sender && receiver && sender.root && sender.root === receiver.root)
    };
  }

  // --- Delta payload ---------------------------------------------------------

  /**
   * Builds the payload the sender transmits: the whole span plan (so the
   * receiver knows the shape of the result), the bytes of the missing spans,
   * the digest of the sender's container, and the digest of the base the delta
   * was computed against.
   *
   * That last field is what makes the delta safe. Without it a delta computed
   * against one container could be applied to another and produce a file that
   * is neither, with no error anywhere.
   *
   * opts: { parser, hashBytes, base } — base is the receiver inventory this
   * delta is for; omitting it produces an unbound delta (a full transfer).
   */
  function buildDeltaPayload(bytes, missingIndices, opts) {
    opts = opts || {};
    if (bytes.length > MAX_CONTAINER_BYTES) {
      fail('container-too-large', bytes.length + ' bytes exceeds the ceiling');
    }
    var hashBytes = clampHashBytes(
      opts.hashBytes !== undefined ? opts.hashBytes
        : (opts.base && opts.base.hashBytes)
    );
    var spans = spanPlan(bytes, { parser: opts.parser, hashBytes: hashBytes });

    var included = new Uint8Array(spans.length);
    var list = missingIndices || [];
    var includedBytes = 0;
    for (var i = 0; i < list.length; i++) {
      var idx = list[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= spans.length) {
        fail('bad-span-index', 'span index ' + idx + ' is not in 0..' + (spans.length - 1));
      }
      if (!included[idx]) {
        included[idx] = 1;
        includedBytes += spans[idx].length;
      }
    }

    var recordSize = 6 + hashBytes;
    var out = new Uint8Array(DELTA_HEADER + spans.length * recordSize + includedBytes);
    out.set(DELTA_MAGIC, 0);
    out[4] = DELTA_VERSION;
    out[5] = hashBytes;
    writeU16(out, 6, spans.length);
    writeU32(out, 8, bytes.length);
    writeU32(out, 12, countIncluded(included));
    writeU32(out, 16, includedBytes);
    writeU32(out, 20, 0);
    out.set(hexToBytes(core.sha256Hex(bytes)), 24);
    if (opts.base && opts.base.root) out.set(hexToBytes(opts.base.root), 56);

    var at = DELTA_HEADER;
    for (var s = 0; s < spans.length; s++) {
      out[at] = spans[s].kind | (included[s] ? 0x80 : 0);
      out[at + 1] = spans[s].type;
      writeU32(out, at + 2, spans[s].length);
      out.set(hexToBytes(spans[s].hash).subarray(0, hashBytes), at + 6);
      at += recordSize;
    }
    for (var p = 0; p < spans.length; p++) {
      if (!included[p]) continue;
      out.set(bytes.subarray(spans[p].offset, spans[p].offset + spans[p].length), at);
      at += spans[p].length;
    }
    return out;
  }

  function countIncluded(flags) {
    var n = 0;
    for (var i = 0; i < flags.length; i++) if (flags[i]) n++;
    return n;
  }

  /**
   * Reads a delta payload's header and span table without applying it.
   *
   * Every declared count is checked against the bytes actually present before
   * anything is indexed, so a payload claiming 60000 spans in 90 bytes is a
   * clean rejection rather than an out-of-memory.
   */
  function parseDeltaPayload(payload) {
    if (!payload || payload.length < DELTA_HEADER) fail('bad-delta', 'shorter than the header');
    if (!matchesAt(payload, DELTA_MAGIC, 0)) fail('bad-delta-magic', 'not an rvQR delta payload');
    if (payload[4] !== DELTA_VERSION) fail('bad-delta-version', 'version ' + payload[4]);
    var hashBytes = payload[5];
    if (hashBytes < 4 || hashBytes > MAX_HASH_BYTES) fail('bad-delta', 'hash width ' + hashBytes);
    var spanCount = readU16(payload, 6);
    var size = readU32(payload, 8);
    var includedCount = readU32(payload, 12);
    var includedBytes = readU32(payload, 16);
    if (size > MAX_CONTAINER_BYTES) fail('container-too-large', size + ' bytes declared');
    if (includedCount > spanCount) fail('bad-delta', 'more included spans than spans');

    var recordSize = 6 + hashBytes;
    var tableEnd = DELTA_HEADER + spanCount * recordSize;
    if (tableEnd > payload.length) fail('bad-delta', 'span table runs past the end of the payload');
    if (payload.length - tableEnd !== includedBytes) {
      fail('bad-delta', 'payload body is ' + (payload.length - tableEnd) + ' bytes, header declares ' + includedBytes);
    }

    var senderRoot = core.toHex(payload.subarray(24, 56));
    var baseRootBytes = payload.subarray(56, 88);
    var bound = false;
    for (var b = 0; b < 32; b++) if (baseRootBytes[b] !== 0) { bound = true; break; }

    var spans = [];
    var total = 0;
    var carried = 0;
    var seenIncluded = 0;
    var at = DELTA_HEADER;
    for (var i = 0; i < spanCount; i++) {
      var flags = payload[at];
      var isIncluded = (flags & 0x80) !== 0;
      var kind = flags & 0x7f;
      if (kind !== KIND_GAP && kind !== KIND_SEGMENT) fail('bad-delta', 'span ' + i + ' kind ' + kind);
      var length = readU32(payload, at + 2);
      if (length < 1) fail('bad-delta', 'span ' + i + ' is empty');
      total += length;
      if (total > size) fail('bad-delta', 'spans overrun the declared size');
      if (isIncluded) {
        seenIncluded++;
        carried += length;
        if (carried > includedBytes) fail('bad-delta', 'carried spans overrun the payload body');
      }
      spans.push({
        kind: kind,
        index: i,
        included: isIncluded,
        type: payload[at + 1],
        typeName: kind === KIND_SEGMENT ? segmentTypeName(payload[at + 1]) : 'GAP',
        offset: total - length,
        length: length,
        hash: core.toHex(payload.subarray(at + 6, at + 6 + hashBytes))
      });
      at += recordSize;
    }
    if (total !== size) fail('bad-delta', 'spans cover ' + total + ' of ' + size + ' bytes');
    if (carried !== includedBytes) fail('bad-delta', 'carried spans cover ' + carried + ' of ' + includedBytes + ' body bytes');
    if (seenIncluded !== includedCount) fail('bad-delta', 'included-span count disagrees with the table');

    return {
      v: DELTA_VERSION,
      size: size,
      hashBytes: hashBytes,
      root: senderRoot,
      baseRoot: bound ? core.toHex(baseRootBytes) : null,
      spans: spans,
      includedCount: includedCount,
      includedBytes: includedBytes,
      bodyOffset: tableEnd
    };
  }

  /**
   * Reconstructs the sender's container from the receiver's base plus a delta.
   *
   * Refuses, before allocating the output, if the base is not the container the
   * delta was computed against. Spans the delta does not carry are taken from
   * the base by content hash rather than by offset, so a base whose segments
   * sit at different offsets still reconstructs — and the whole result is
   * verified against the sender's digest before it is returned. Nothing
   * partial is ever handed back.
   */
  function applyDelta(receiverBytes, payload, opts) {
    opts = opts || {};
    var delta = parseDeltaPayload(payload);
    var base = receiverBytes || new Uint8Array(0);

    if (delta.baseRoot) {
      var baseRoot = core.sha256Hex(base);
      if (baseRoot !== delta.baseRoot) {
        fail(
          'base-mismatch',
          'delta was computed against ' + delta.baseRoot.slice(0, 16) +
            '…, the receiver holds ' + baseRoot.slice(0, 16) + '…'
        );
      }
    }

    // Index the base by content hash. Built from the base's own span plan, so
    // it costs one scan and one pass of hashing regardless of how the sender
    // laid its container out.
    var byHash = Object.create(null);
    if (base.length) {
      var baseSpans = spanPlan(base, { parser: opts.parser, hashBytes: delta.hashBytes });
      for (var b = 0; b < baseSpans.length; b++) {
        var bs = baseSpans[b];
        var key = bs.hash + ':' + bs.length;
        if (!(key in byHash)) byHash[key] = bs.offset;
      }
    }

    // Resolve every span before writing a byte: a delta that turns out to be
    // unsatisfiable halfway through must not leave a half-built container.
    var sources = new Array(delta.spans.length);
    var bodyAt = delta.bodyOffset;
    for (var i = 0; i < delta.spans.length; i++) {
      var span = delta.spans[i];
      if (span.included) {
        sources[i] = { from: 'delta', offset: bodyAt };
        bodyAt += span.length;
        continue;
      }
      var at = byHash[span.hash + ':' + span.length];
      if (at === undefined) {
        fail(
          'missing-span',
          'span ' + i + ' (' + span.typeName + ', ' + span.length +
            ' bytes) is neither carried by the delta nor present in the base'
        );
      }
      sources[i] = { from: 'base', offset: at };
    }

    var out = new Uint8Array(delta.size);
    var cursor = 0;
    for (var j = 0; j < delta.spans.length; j++) {
      var s = delta.spans[j];
      var src = sources[j];
      var from = src.from === 'delta' ? payload : base;
      out.set(from.subarray(src.offset, src.offset + s.length), cursor);
      cursor += s.length;
    }

    var digest = core.sha256Hex(out);
    if (digest !== delta.root) {
      fail('reconstruction-mismatch', 'rebuilt container hashes to ' + digest.slice(0, 16) + '…, delta declares ' + delta.root.slice(0, 16) + '…');
    }
    return { bytes: out, sha256: digest, fromDelta: delta.includedBytes, fromBase: delta.size - delta.includedBytes };
  }

  return {
    SEGMENT_MAGIC: SEGMENT_MAGIC,
    ROOT_MANIFEST_MAGIC: ROOT_MANIFEST_MAGIC,
    SEGMENT_HEADER_SIZE: SEGMENT_HEADER_SIZE,
    SEGMENT_ALIGNMENT: SEGMENT_ALIGNMENT,
    ROOT_MANIFEST_SIZE: ROOT_MANIFEST_SIZE,
    MAX_SPANS: MAX_SPANS,
    MAX_CONTAINER_BYTES: MAX_CONTAINER_BYTES,
    DEFAULT_HASH_BYTES: DEFAULT_HASH_BYTES,
    MAX_HASH_BYTES: MAX_HASH_BYTES,
    KIND_GAP: KIND_GAP,
    KIND_SEGMENT: KIND_SEGMENT,
    DeltaError: DeltaError,
    segmentTypeName: segmentTypeName,
    scanSegments: scanSegments,
    jsParser: jsParser,
    wasmParser: wasmParser,
    segmentIndex: segmentIndex,
    spanPlan: spanPlan,
    inventory: inventory,
    encodeInventory: encodeInventory,
    decodeInventory: decodeInventory,
    byteCapacity: byteCapacity,
    qrVersionFor: qrVersionFor,
    inventoryQr: inventoryQr,
    chunkInventory: chunkInventory,
    joinInventoryChunks: joinInventoryChunks,
    diff: diff,
    buildDeltaPayload: buildDeltaPayload,
    parseDeltaPayload: parseDeltaPayload,
    applyDelta: applyDelta
  };
});
