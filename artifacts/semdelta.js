/*!
 * rvQR semantic delta — differential transfer *inside* RVF segments.
 *
 * artifacts/delta.js diffs a container at SPAN granularity: every segment is an
 * opaque byte run, and a segment that changed at all is a segment that gets
 * resent whole. That is the right trade when whole segments turn over. It is
 * the wrong trade for the case a vector store is actually in most of the time:
 * one large Vec segment that gained three records out of twenty-four, or a WASM
 * component whose sections are unchanged except for one function body.
 *
 * This module goes inside those segments. It reuses delta.js's span plan as its
 * skeleton and then decomposes the spans it can parse safely into UNITS — the
 * same idea as a span, one level down. Units are diffed, transferred and
 * reassembled exactly the way spans are, so the guarantees carry over: the plan
 * covers every byte of the container exactly once, matching is by content hash
 * rather than by offset, a delta is bound to the base it was computed against,
 * and the reconstruction is checked against the sender's SHA-256 before a
 * single byte is handed back.
 *
 * WHAT CAN BE DECOMPOSED, AND WHY ONLY THESE
 *
 *   Vec (0x01)         Record granularity. The payload is
 *                      `u16 dim | u16 count | u16 flags | count × {u64 id,
 *                      dim × f32}`, confirmed byte-exactly against the shipped
 *                      demo container and read the same way by rvf.js.
 *
 *   Wasm (0x10)        Section granularity, and function granularity inside the
 *                      Code section. This is the published WebAssembly binary
 *                      format, not an RVF-specific guess: 8-byte preamble, then
 *                      `id u8 | size varuint32 | contents`, and a Code section
 *                      that is `count varuint32 | count × (size varuint32 |
 *                      body)`. A changed function body invalidates one body,
 *                      not the module.
 *
 *   CowMap (0x20)      Cluster-map block granularity — see the RVCOW note below.
 *   Membership (0x22)  Membership-bitmap block granularity.
 *
 * Everything else stays a whole span. That is a deliberate limit, not an
 * omission: the RVF microkernel this app bundles exposes `rvf_segment_count`
 * and `rvf_segment_info` and nothing at all about what is inside a segment, and
 * rvf.js only ever reads Vec payloads. Splitting a segment on a layout nobody
 * published would produce a delta that reconstructs wrongly on the first
 * container that disagreed, which is worse than not splitting it.
 *
 * TENSOR BOUNDARIES ARE NOT SUPPORTED, and cannot be with what the format
 * exposes. RVF's segment-type table has no tensor-bearing type with a
 * discoverable payload shape: Quant (0x06) and AggregateWeights (0x36) carry no
 * layout the kernel or rvf.js will describe, and there is no shape, dtype or
 * stride field anywhere a reader can reach. Aligning a diff to tensor
 * boundaries would mean inventing the boundaries. The WASM decomposition above
 * is the part of that requirement the format genuinely supports, so that is the
 * part implemented here.
 *
 * RVCOW AND agenticow ARE THE SAME MECHANISM UNDER TWO NAMES. RVCOW is the
 * in-tree name — crates/rvf tests/rvf-integration/tests/cow_branching.rs,
 * SegmentType::CowMap, `rvf-cli rebuild_refcounts`. agenticow is the published
 * npm surface for it (v0.2.4, "Copy-On-Write vector branching"). One format,
 * one set of segments; if you have read about either, you have read about both.
 * A COW child shares slabs with its parent by entry rather than by copy — every
 * cluster starts as ParentRef and flips to LocalOffset only when written — so a
 * delta between two branches should move the entries that flipped and the
 * membership bits that moved, not the slabs they point at. That is what the
 * block decomposition of CowMap and Membership buys. Refcount (0x21) is
 * deliberately left opaque: the runtime never reads it, the two CLI writers
 * disagree with each other about its layout, and building transfer semantics on
 * a segment nothing agrees about would be building on nothing.
 *
 * NEVER SEND A SEMANTIC DELTA WHEN A SPAN DELTA IS SMALLER. Unit tables cost
 * `6 + hashBytes` per unit, and a container full of small records can spend more
 * on describing itself than a span delta spends on resending a segment.
 * chooseDelta() builds both payloads, measures both, and returns the smaller
 * one together with both figures and the reason — the caller can always see
 * which was used and why, because a transfer size nobody can explain is a
 * transfer size nobody can trust.
 *
 * THE RECEIVER INVENTORY IS ENCRYPTED. See sealInventory() for exactly what
 * that hides and — more importantly — what it does not.
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network. Same contract as core.js and delta.js.
 *
 * Browser: load core.js, delta.js and crypto.js before this file.
 * Node:    require('./semdelta.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./delta.js'), require('./crypto.js'));
  } else {
    root.RVQRSemDelta = factory(root.RVQRCore, root.RVQRDelta, root.RVQRCrypto);
  }
})(typeof self !== 'undefined' ? self : this, function (core, delta, crypto) {
  'use strict';

  // --- Wire constants --------------------------------------------------------

  var SEM_INVENTORY_MAGIC = [0x52, 0x56, 0x53, 0x49]; // 'RVSI'
  var SEM_DELTA_MAGIC = [0x52, 0x56, 0x53, 0x44]; // 'RVSD'
  var SEALED_MAGIC = [0x52, 0x56, 0x53, 0x58]; // 'RVSX'
  var SEM_INVENTORY_VERSION = 1;
  var SEM_DELTA_VERSION = 1;
  var SEALED_VERSION = 1;
  var SEM_INVENTORY_HEADER = 52; // magic..root inclusive
  var SEM_DELTA_HEADER = 88; // magic..baseRoot inclusive

  // Segment types this module knows how to look inside.
  var TYPE_VEC = 0x01;
  var TYPE_WASM = 0x10;
  var TYPE_COWMAP = 0x20;
  var TYPE_MEMBERSHIP = 0x22;

  // --- Unit kinds ------------------------------------------------------------
  // A unit is a contiguous byte range with a hash: the same currency delta.js
  // trades in, one level finer. The kind is carried on the wire so a receiver
  // can label a delta without re-deriving the decomposition, and so a
  // reconstruction can be described in terms a human recognises.

  var UNIT_SPAN = 0;    // a whole span, not decomposed (gap, or opaque segment)
  var UNIT_HEAD = 1;    // the fixed header region at the front of a decomposed segment
  var UNIT_RECORD = 2;  // one vector record
  var UNIT_SECTION = 3; // one WASM section, or one function body inside Code
  var UNIT_BLOCK = 4;   // a fixed run of cluster-map entries or membership words
  var UNIT_TAIL = 5;    // bytes inside a decomposed segment nothing else claimed

  var UNIT_KIND_NAMES = {
    0: 'SPAN', 1: 'HEAD', 2: 'RECORD', 3: 'SECTION', 4: 'BLOCK', 5: 'TAIL'
  };

  function unitKindName(kind) {
    return UNIT_KIND_NAMES[kind] || ('KIND_' + kind);
  }

  function isUnitKind(kind) {
    return kind >= UNIT_SPAN && kind <= UNIT_TAIL;
  }

  // --- Hostile-input ceilings ------------------------------------------------
  // Same discipline as delta.js and core.js: a delta payload and an inventory
  // both arrive over an unauthenticated optical channel, and a container may be
  // whatever was pointed at the camera. Every count and length either one
  // declares is bounded here, before it reaches an allocation or a loop.

  // Units a plan or payload may carry. Each costs 6 + hashBytes on the wire, so
  // this bounds a unit table at about 3.7 MB at the default hash width — large,
  // bounded, and reachable in one allocation the runtime can refuse.
  var MAX_UNITS = 262144;

  // A unit smaller than its own table record is a unit that costs more to
  // describe than to resend. 32 bytes is a little over twice the 14-byte record
  // at the default hash width; below it, decomposition is declined and the
  // segment stays whole.
  var MIN_UNIT_BYTES = 32;

  // Vec header fields are u16, so these are the format's own ceilings rather
  // than ours. They are restated because `6 + (8 + dim*4) * count` must be
  // computed before it is compared against a payload length, and a reader
  // should be able to see that the product cannot leave the exact range of a
  // JS number: 65535 * 262148 is about 1.7e10, well inside 2^53.
  var MAX_VEC_DIM = 65535;
  var MAX_VEC_COUNT = 65535;

  // A varuint32 is at most five bytes; a sixth continuation byte is a malformed
  // module, not a large number.
  var MAX_LEB_BYTES = 5;

  // WASM sections in one module, and function bodies in one Code section.
  // Both are generous against real modules and cheap to enforce.
  var MAX_WASM_SECTIONS = 4096;
  var MAX_WASM_FUNCTIONS = 65536;

  // Cluster-map entries per block, and membership bitmap bytes per block. Both
  // are chosen so a block comfortably clears MIN_UNIT_BYTES: 16 entries is 144
  // bytes, and a 256-byte bitmap block covers 2048 vector ids.
  var COW_BLOCK_ENTRIES = 16;
  var COW_ENTRY_BYTES = 9; // tag u8 | offset u64 LE
  var MEMBERSHIP_BLOCK_BYTES = 256;

  // Fixed shapes taken from the in-tree definitions, restated so the parsers
  // below read as arithmetic rather than as magic numbers.
  var COWMAP_HEADER_BYTES = 64;  // rvf-types CowMapHeader
  var COWMAP_TRAILER_BYTES = 17; // rvf-runtime store.rs COW-state trailer
  var COWMAP_FIXED_BYTES = COWMAP_HEADER_BYTES + COWMAP_TRAILER_BYTES; // 81
  var MEMBERSHIP_HEADER_BYTES = 96; // rvf-types MembershipHeader
  var VEC_HEADER_BYTES = 6;
  var WASM_PREAMBLE_BYTES = 8;

  // Largest inventory this module will seal or open. An inventory is bounded by
  // MAX_UNITS above; this is the belt to that pair of braces, and it bounds the
  // single allocation in openInventory() against a hostile sealed blob.
  var MAX_SEALED_PLAINTEXT = 8 * 1024 * 1024;

  var SEGMENT_HEADER_SIZE = delta.SEGMENT_HEADER_SIZE; // 64
  var MAX_CONTAINER_BYTES = delta.MAX_CONTAINER_BYTES;
  var MAX_HASH_BYTES = delta.MAX_HASH_BYTES;
  var DEFAULT_HASH_BYTES = delta.DEFAULT_HASH_BYTES;
  var KIND_GAP = delta.KIND_GAP;

  /**
   * Every rejection from this module is a SemDeltaError with a stable `reason`
   * string, matching delta.js. Callers switch on the reason; the message is for
   * humans. Errors thrown out of delta.js keep their own DeltaError reasons and
   * pass through unchanged — a base-mismatch is a base-mismatch whichever layer
   * noticed it.
   */
  function SemDeltaError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'SemDeltaError';
    err.reason = reason;
    return err;
  }

  function fail(reason, message) {
    throw SemDeltaError(reason, message);
  }

  // --- Byte helpers ----------------------------------------------------------
  // Local rather than imported for the same reason delta.js keeps its own: this
  // module must not depend on which of core.js's internals happen to be public.

  function matchesAt(bytes, magic, offset) {
    if (offset < 0 || offset + magic.length > bytes.length) return false;
    for (var i = 0; i < magic.length; i++) {
      if (bytes[offset + i] !== magic[i]) return false;
    }
    return true;
  }

  function readU16(bytes, off) {
    return bytes[off] + bytes[off + 1] * 0x100;
  }

  function readU32(bytes, off) {
    return (
      bytes[off] +
      bytes[off + 1] * 0x100 +
      bytes[off + 2] * 0x10000 +
      bytes[off + 3] * 0x1000000
    );
  }

  /**
   * A u64 read as a JS number. Values past 2^53 cannot be represented exactly,
   * and every caller here compares the result against a length that is already
   * bounded well below that, so a too-large value is reported as Infinity
   * rather than as a plausible-looking wrong number.
   */
  function readU64(bytes, off) {
    var hi = readU32(bytes, off + 4);
    if (hi > 0x1fffff) return Infinity;
    return hi * 0x100000000 + readU32(bytes, off);
  }

  function writeU16(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
    bytes[off + 2] = (value >>> 16) & 0xff;
    bytes[off + 3] = (value >>> 24) & 0xff;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length >>> 1);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function hashRange(bytes, offset, length, hashBytes) {
    var digest = core.sha256Bytes(bytes.subarray(offset, offset + length));
    return core.toHex(digest.subarray(0, hashBytes));
  }

  function clampHashBytes(n) {
    n = Math.floor(Number(n) || DEFAULT_HASH_BYTES);
    if (n < 4) n = 4;
    if (n > MAX_HASH_BYTES) n = MAX_HASH_BYTES;
    return n;
  }

  /**
   * Decodes a varuint32 (LEB128) at `off`, bounded to five bytes.
   *
   * Returns null rather than throwing on anything malformed, because every
   * caller is walking a payload from an untrusted container and wants to stop
   * decomposing rather than to reject the container: a WASM segment this
   * module cannot read is a WASM segment that stays a whole span.
   */
  function readLeb(bytes, off, end) {
    var result = 0;
    var shift = 0;
    for (var i = 0; i < MAX_LEB_BYTES; i++) {
      if (off + i >= end) return null;
      var b = bytes[off + i];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) {
        // A five-byte encoding may still describe more than 2^32-1; that is out
        // of range for a varuint32 and is refused rather than truncated.
        if (result > 0xffffffff) return null;
        return { value: result, length: i + 1 };
      }
      shift += 7;
    }
    return null;
  }

  // --- Vector slab reader ----------------------------------------------------

  /**
   * Reads a Vec segment's record layout: dimensions, count, flags, the record
   * stride, and one entry per record with its id and byte range within the
   * container.
   *
   * `span` is a delta.js span (or anything with `offset` and `length`) whose
   * first 64 bytes are the segment header. Returns null — never throws — when
   * the payload does not describe a well-formed slab, so a caller walking a
   * hostile container degrades to span granularity instead of failing.
   *
   * This is the same layout rvf.js reads, restated here because rvf.js returns
   * decoded Float32Arrays and this module needs byte ranges. Ids are reported
   * the way rvf.js reports them: a number when exact, a hex string past 2^53,
   * so a diff never claims two distinct ids are the same because both rounded.
   */
  function readVectorSlab(bytes, span) {
    if (!span || span.length < SEGMENT_HEADER_SIZE + VEC_HEADER_BYTES) return null;
    var payloadOffset = span.offset + SEGMENT_HEADER_SIZE;
    var payloadLength = span.length - SEGMENT_HEADER_SIZE;
    if (payloadOffset + payloadLength > bytes.length) return null;

    var dim = readU16(bytes, payloadOffset);
    var count = readU16(bytes, payloadOffset + 2);
    var flags = readU16(bytes, payloadOffset + 4);
    if (!dim || !count) return null;
    if (dim > MAX_VEC_DIM || count > MAX_VEC_COUNT) return null;

    // Bounded before it is used: stride is at most 262148 and count at most
    // 65535, so `needed` stays exact in a JS number and is compared against a
    // payload length that is itself at most MAX_CONTAINER_BYTES.
    var stride = 8 + dim * 4;
    var needed = VEC_HEADER_BYTES + stride * count;
    if (needed > payloadLength) return null;

    var records = new Array(count);
    for (var i = 0; i < count; i++) {
      var at = payloadOffset + VEC_HEADER_BYTES + i * stride;
      var lo = readU32(bytes, at);
      var hi = readU32(bytes, at + 4);
      var id;
      if (hi === 0) id = lo;
      else if (hi > 0x1fffff) id = '0x' + hi.toString(16) + ('00000000' + lo.toString(16)).slice(-8);
      else id = hi * 0x100000000 + lo;
      records[i] = { index: i, id: id, offset: at, length: stride };
    }

    return {
      dim: dim,
      count: count,
      flags: flags,
      stride: stride,
      payloadOffset: payloadOffset,
      payloadLength: payloadLength,
      headBytes: SEGMENT_HEADER_SIZE + VEC_HEADER_BYTES,
      trailing: payloadLength - needed,
      records: records
    };
  }

  /**
   * The record-level story of what changed between two containers, told in
   * vector ids rather than in byte offsets: which ids the target gained, which
   * it lost, and which kept their id but changed their bytes.
   *
   * This is a reporting surface, not the transfer mechanism — the transfer
   * matches units by content hash, which handles all three cases and
   * reordering besides, without ever needing to know what an id is. It exists
   * because "three vectors were added" is a sentence somebody can check, and
   * "unit 7 changed" is not.
   *
   * Slabs are paired by position: the nth Vec segment of the base against the
   * nth Vec segment of the target. A container whose Vec segments were
   * reordered wholesale reports as a large change, which is honest — nothing
   * here claims to track a slab's identity across a rewrite.
   */
  function vectorDiff(baseBytes, targetBytes, opts) {
    opts = opts || {};
    var baseSlabs = vectorSlabs(baseBytes, opts);
    var targetSlabs = vectorSlabs(targetBytes, opts);
    var added = [], removed = [], changed = [], unchanged = 0;
    var slabs = [];

    var pairs = Math.max(baseSlabs.length, targetSlabs.length);
    for (var p = 0; p < pairs; p++) {
      var b = baseSlabs[p] || null;
      var t = targetSlabs[p] || null;
      var report = {
        index: p,
        base: b ? { dim: b.slab.dim, count: b.slab.count } : null,
        target: t ? { dim: t.slab.dim, count: t.slab.count } : null,
        added: [], removed: [], changed: [], unchanged: 0
      };

      var baseById = Object.create(null);
      if (b) {
        for (var i = 0; i < b.slab.records.length; i++) {
          var br = b.slab.records[i];
          baseById[String(br.id)] = hashRange(baseBytes, br.offset, br.length, MAX_HASH_BYTES);
        }
      }
      var seen = Object.create(null);
      if (t) {
        for (var j = 0; j < t.slab.records.length; j++) {
          var tr = t.slab.records[j];
          var key = String(tr.id);
          seen[key] = true;
          var was = baseById[key];
          if (was === undefined) {
            report.added.push(tr.id);
          } else if (was !== hashRange(targetBytes, tr.offset, tr.length, MAX_HASH_BYTES)) {
            report.changed.push(tr.id);
          } else {
            report.unchanged++;
          }
        }
      }
      for (var k in baseById) {
        if (!seen[k]) report.removed.push(numericIfPossible(k));
      }

      added = added.concat(report.added);
      removed = removed.concat(report.removed);
      changed = changed.concat(report.changed);
      unchanged += report.unchanged;
      slabs.push(report);
    }

    return {
      added: added, removed: removed, changed: changed, unchanged: unchanged,
      slabs: slabs,
      // A slab whose dim changed cannot be diffed record by record at all: every
      // record's stride moved, so every record reads as changed. Surfaced so a
      // caller can say why a "small" edit produced a large delta.
      dimChanged: slabs.some(function (s) {
        return s.base && s.target && s.base.dim !== s.target.dim;
      })
    };
  }

  function numericIfPossible(key) {
    if (/^\d+$/.test(key)) {
      var n = Number(key);
      if (String(n) === key) return n;
    }
    return key;
  }

  /** Every Vec segment of a container, with its span and its parsed slab. */
  function vectorSlabs(bytes, opts) {
    opts = opts || {};
    var spans = delta.spanPlan(bytes, { parser: opts.parser, hashBytes: clampHashBytes(opts.hashBytes) });
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].kind === KIND_GAP || spans[i].type !== TYPE_VEC) continue;
      var slab = readVectorSlab(bytes, spans[i]);
      if (slab) out.push({ span: spans[i], slab: slab });
    }
    return out;
  }

  // --- Decomposers -----------------------------------------------------------
  // Each takes the container and one span and returns a list of
  // { kind, length } pieces that cover exactly span.length bytes, or null to
  // decline. Declining is always safe: the span stays whole.
  //
  // Every one of them treats the span's bytes as adversarial. Nothing is
  // allocated in proportion to a declared count until that count has been
  // multiplied out and compared against the bytes actually present, and a
  // structure that does not add up exactly is declined rather than
  // approximated — a decomposition that guessed would reconstruct wrongly, and
  // reconstructing wrongly is the one failure mode this module exists to avoid.

  function decomposeVec(bytes, span, budget) {
    var slab = readVectorSlab(bytes, span);
    if (!slab) return null;
    if (slab.stride < MIN_UNIT_BYTES) return null;
    // head + records + optional tail
    if (slab.count + 2 > budget) return null;

    var pieces = [{ kind: UNIT_HEAD, length: slab.headBytes }];
    for (var i = 0; i < slab.count; i++) {
      pieces.push({ kind: UNIT_RECORD, length: slab.stride });
    }
    if (slab.trailing > 0) pieces.push({ kind: UNIT_TAIL, length: slab.trailing });
    return pieces;
  }

  /**
   * WASM module → one unit per section, with the Code section split further
   * into one unit per function body.
   *
   * Sections smaller than MIN_UNIT_BYTES are merged forward into the piece
   * being built rather than emitted alone, so a module of eight tiny sections
   * and one large Code section does not spend more on its table than it saves.
   */
  function decomposeWasm(bytes, span, budget) {
    var payloadOffset = span.offset + SEGMENT_HEADER_SIZE;
    var end = span.offset + span.length;
    if (payloadOffset + WASM_PREAMBLE_BYTES > end) return null;
    if (bytes[payloadOffset] !== 0x00 || bytes[payloadOffset + 1] !== 0x61 ||
        bytes[payloadOffset + 2] !== 0x73 || bytes[payloadOffset + 3] !== 0x6d) {
      return null;
    }

    var pieces = [];
    var pending = SEGMENT_HEADER_SIZE + WASM_PREAMBLE_BYTES; // segment header + preamble
    var at = payloadOffset + WASM_PREAMBLE_BYTES;
    var sections = 0;

    function flush(kind) {
      if (pending > 0) {
        pieces.push({ kind: kind, length: pending });
        pending = 0;
      }
    }

    while (at < end) {
      if (sections++ > MAX_WASM_SECTIONS) return null;
      var id = bytes[at];
      var size = readLeb(bytes, at + 1, end);
      if (!size) return null;
      var contentsAt = at + 1 + size.length;
      // The declared size is checked against the bytes actually left before it
      // is used to advance anything.
      if (size.value > end - contentsAt) return null;
      var whole = 1 + size.length + size.value;

      if (id === 10 && size.value > MIN_UNIT_BYTES * 2) {
        var split = splitCodeSection(bytes, contentsAt, contentsAt + size.value, budget - pieces.length);
        if (split) {
          // The section id, its length prefix, and the function count go with
          // whatever came before; each body is its own unit.
          pending += 1 + size.length + split.headBytes;
          flush(pieces.length ? UNIT_SECTION : UNIT_HEAD);
          for (var s = 0; s < split.bodies.length; s++) {
            pieces.push({ kind: UNIT_SECTION, length: split.bodies[s] });
          }
          if (split.trailing > 0) pieces.push({ kind: UNIT_SECTION, length: split.trailing });
          at += whole;
          continue;
        }
      }

      pending += whole;
      if (pending >= MIN_UNIT_BYTES) flush(pieces.length ? UNIT_SECTION : UNIT_HEAD);
      at += whole;
      if (pieces.length > budget) return null;
    }

    flush(pieces.length ? UNIT_TAIL : UNIT_HEAD);
    if (pieces.length < 2) return null; // nothing was gained
    if (pieces.length > budget) return null;
    return pieces;
  }

  /** Code section contents: `count varuint32 | count × (size varuint32 | body)`. */
  function splitCodeSection(bytes, at, end, budget) {
    var count = readLeb(bytes, at, end);
    if (!count) return null;
    if (count.value > MAX_WASM_FUNCTIONS) return null;
    if (count.value + 2 > budget) return null;
    // A body is at least its own length prefix, so a count that could not fit
    // even one byte per body is rejected before the loop runs.
    if (count.value > end - (at + count.length)) return null;

    var bodies = [];
    var cursor = at + count.length;
    for (var i = 0; i < count.value; i++) {
      var size = readLeb(bytes, cursor, end);
      if (!size) return null;
      var bodyAt = cursor + size.length;
      if (size.value > end - bodyAt) return null;
      bodies.push(size.length + size.value);
      cursor = bodyAt + size.value;
    }
    if (!bodies.length) return null;
    return { headBytes: count.length, bodies: bodies, trailing: end - cursor };
  }

  /**
   * CowMap payload: `CowMapHeader(64) | COW-state trailer(17) | parent path |
   * flat-array map`, where the map is `format u8 | cluster_count u32 |
   * cluster_count × (tag u8 | offset u64 LE)`.
   *
   * The 17-byte trailer is a runtime convention with no magic and no version of
   * its own — it exists only in rvf-runtime's store, and ADR-031 documents
   * different fields at those offsets that were never implemented. It is
   * therefore only trusted when the CowMapHeader in front of it validates:
   * magic, version 1, and a payload length that the trailer's own lengths
   * account for exactly. Anything else declines.
   *
   * Only map_format 0 (FlatArray) has an encoder anywhere; ArtTree and
   * ExtentList are enum values with no bytes behind them, so a map claiming to
   * be either is declined rather than guessed at.
   */
  function decomposeCowMap(bytes, span, budget) {
    var payloadOffset = span.offset + SEGMENT_HEADER_SIZE;
    var payloadLength = span.length - SEGMENT_HEADER_SIZE;
    if (payloadLength < COWMAP_FIXED_BYTES) return null;
    // COWMAP_MAGIC 0x5256434D, little-endian on the wire.
    if (bytes[payloadOffset] !== 0x4d || bytes[payloadOffset + 1] !== 0x43 ||
        bytes[payloadOffset + 2] !== 0x56 || bytes[payloadOffset + 3] !== 0x52) {
      return null;
    }
    if (readU16(bytes, payloadOffset + 4) !== 1) return null;
    var mapFormat = bytes[payloadOffset + 6];
    if (mapFormat !== 0) return null;

    var trailer = payloadOffset + COWMAP_HEADER_BYTES;
    var parentLen = readU32(bytes, trailer + 9);
    var mapLen = readU32(bytes, trailer + 13);
    if (parentLen < 1) return null;
    // Checked against the payload before either is used as an offset.
    if (parentLen > payloadLength - COWMAP_FIXED_BYTES) return null;
    if (mapLen !== payloadLength - COWMAP_FIXED_BYTES - parentLen) return null;
    if (mapLen < 5) return null;

    var mapAt = payloadOffset + COWMAP_FIXED_BYTES + parentLen;
    if (bytes[mapAt] !== mapFormat) return null;
    var clusters = readU32(bytes, mapAt + 1);
    // 4294967295 * 9 stays exact in a JS number, so this comparison is safe
    // before any allocation.
    if (5 + clusters * COW_ENTRY_BYTES > mapLen) return null;

    var blocks = Math.ceil(clusters / COW_BLOCK_ENTRIES);
    if (blocks + 2 > budget) return null;
    if (blocks < 2) return null; // one block is just the whole segment again

    var pieces = [{
      kind: UNIT_HEAD,
      length: SEGMENT_HEADER_SIZE + COWMAP_FIXED_BYTES + parentLen + 5
    }];
    var remaining = clusters;
    for (var b = 0; b < blocks; b++) {
      var n = Math.min(COW_BLOCK_ENTRIES, remaining);
      pieces.push({ kind: UNIT_BLOCK, length: n * COW_ENTRY_BYTES });
      remaining -= n;
    }
    var covered = pieces.reduce(function (t, p) { return t + p.length; }, 0);
    if (covered < span.length) pieces.push({ kind: UNIT_TAIL, length: span.length - covered });
    return pieces;
  }

  /**
   * Membership payload: `MembershipHeader(96) | bitmap`, the bitmap being
   * ceil(vector_count / 64) little-endian u64 words with bit `id % 64` of word
   * `id / 64` set for a member.
   *
   * Only filter_type 0 (Bitmap) is ever produced by the runtime; RoaringBitmap
   * is an enum value with no encoder, so it declines.
   */
  function decomposeMembership(bytes, span, budget) {
    var payloadOffset = span.offset + SEGMENT_HEADER_SIZE;
    var payloadLength = span.length - SEGMENT_HEADER_SIZE;
    if (payloadLength < MEMBERSHIP_HEADER_BYTES) return null;
    // MEMBERSHIP_MAGIC 0x52564D42, little-endian on the wire.
    if (bytes[payloadOffset] !== 0x42 || bytes[payloadOffset + 1] !== 0x4d ||
        bytes[payloadOffset + 2] !== 0x56 || bytes[payloadOffset + 3] !== 0x52) {
      return null;
    }
    if (readU16(bytes, payloadOffset + 4) !== 1) return null;
    if (bytes[payloadOffset + 6] !== 0) return null; // Bitmap only

    var filterOffset = readU64(bytes, payloadOffset + 0x18);
    var filterSize = readU32(bytes, payloadOffset + 0x20);
    if (filterOffset !== MEMBERSHIP_HEADER_BYTES) return null;
    if (filterOffset + filterSize !== payloadLength) return null;
    if (filterSize < MEMBERSHIP_BLOCK_BYTES * 2) return null;

    var blocks = Math.ceil(filterSize / MEMBERSHIP_BLOCK_BYTES);
    if (blocks + 1 > budget) return null;

    var pieces = [{ kind: UNIT_HEAD, length: SEGMENT_HEADER_SIZE + MEMBERSHIP_HEADER_BYTES }];
    var remaining = filterSize;
    for (var b = 0; b < blocks; b++) {
      var n = Math.min(MEMBERSHIP_BLOCK_BYTES, remaining);
      pieces.push({ kind: UNIT_BLOCK, length: n });
      remaining -= n;
    }
    return pieces;
  }

  var DECOMPOSERS = {};
  DECOMPOSERS[TYPE_VEC] = decomposeVec;
  DECOMPOSERS[TYPE_WASM] = decomposeWasm;
  DECOMPOSERS[TYPE_COWMAP] = decomposeCowMap;
  DECOMPOSERS[TYPE_MEMBERSHIP] = decomposeMembership;

  // --- Semantic plan ---------------------------------------------------------

  /**
   * The ordered, contiguous list of units that make up a container: delta.js's
   * span plan, with every span this module can look inside replaced by the
   * pieces it decomposes into.
   *
   * Coverage is the invariant everything else rests on — the units are
   * contiguous, in order, and sum to exactly bytes.length — so a reconstruction
   * is a concatenation and nothing can be silently dropped.
   *
   * opts: { parser, hashBytes, decompose } — `decompose:false` returns the span
   * plan unchanged as UNIT_SPAN units, which is what makes a span delta and a
   * semantic delta comparable through one code path.
   */
  function semanticPlan(bytes, opts) {
    opts = opts || {};
    var hashBytes = clampHashBytes(opts.hashBytes);
    var spans = delta.spanPlan(bytes, { parser: opts.parser, hashBytes: hashBytes });
    var units = [];
    var decompose = opts.decompose !== false;

    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      var pieces = null;
      if (decompose && span.kind !== KIND_GAP && DECOMPOSERS[span.type]) {
        var budget = MAX_UNITS - units.length - (spans.length - i);
        if (budget > 2) {
          pieces = DECOMPOSERS[span.type](bytes, span, budget);
          // A decomposition that does not cover the span exactly is a bug in
          // this file, not in the container. It is checked rather than trusted
          // because the cost of being wrong is a container that reconstructs to
          // the wrong bytes.
          if (pieces && sumLengths(pieces) !== span.length) pieces = null;
        }
      }

      if (!pieces) {
        units.push(makeUnit(bytes, units.length, UNIT_SPAN, span.type, span.offset, span.length, hashBytes, span.index));
        continue;
      }
      var at = span.offset;
      for (var p = 0; p < pieces.length; p++) {
        units.push(makeUnit(bytes, units.length, pieces[p].kind, span.type, at, pieces[p].length, hashBytes, span.index));
        at += pieces[p].length;
      }
    }

    if (units.length > MAX_UNITS) fail('too-many-units', units.length + ' units exceeds the ' + MAX_UNITS + ' ceiling');
    return units;
  }

  function makeUnit(bytes, index, kind, type, offset, length, hashBytes, spanIndex) {
    return {
      kind: kind,
      kindName: unitKindName(kind),
      index: index,
      spanIndex: spanIndex,
      type: type,
      typeName: type ? delta.segmentTypeName(type) : 'GAP',
      offset: offset,
      length: length,
      hash: hashRange(bytes, offset, length, hashBytes)
    };
  }

  function sumLengths(pieces) {
    var n = 0;
    for (var i = 0; i < pieces.length; i++) n += pieces[i].length;
    return n;
  }

  /**
   * Which segments were decomposed, into how many units, and — for the ones
   * that were not — why not. This is the surface that answers "the format does
   * not expose enough to split this" for a specific container rather than in
   * the abstract.
   */
  function decompositionReport(bytes, opts) {
    opts = opts || {};
    var hashBytes = clampHashBytes(opts.hashBytes);
    var spans = delta.spanPlan(bytes, { parser: opts.parser, hashBytes: hashBytes });
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      var row = {
        spanIndex: span.index,
        type: span.type,
        typeName: span.kind === KIND_GAP ? 'GAP' : delta.segmentTypeName(span.type),
        length: span.length,
        decomposed: false,
        units: 1,
        reason: ''
      };
      if (span.kind === KIND_GAP) {
        row.reason = 'inter-segment bytes carry no structure to split on';
      } else if (!DECOMPOSERS[span.type]) {
        row.reason = 'no published payload layout this module can parse safely';
      } else {
        var pieces = DECOMPOSERS[span.type](bytes, span, MAX_UNITS);
        if (pieces && sumLengths(pieces) === span.length) {
          row.decomposed = true;
          row.units = pieces.length;
          row.reason = 'decomposed into ' + pieces.length + ' units';
        } else {
          row.reason = 'payload did not parse as a well-formed ' +
            delta.segmentTypeName(span.type) + ' body, or splitting it would not pay for its table';
        }
      }
      out.push(row);
    }
    return out;
  }

  // --- Inventory -------------------------------------------------------------

  /**
   * What a holder has, at unit granularity.
   *
   * It carries the span table as well as the unit table, and the extra cost is
   * real but small: a container has orders of magnitude fewer segments than
   * records. The spans are what let a sender compare a span delta against a
   * semantic delta at all — a receiver that published only units would have no
   * whole-segment hashes to match, so every span delta against it would look
   * like a full transfer and the comparison in chooseDelta() would be rigged.
   * An inventory shaped this way is also a valid delta.js inventory, so
   * delta.diff() consumes it unchanged.
   */
  function semanticInventory(bytes, opts) {
    opts = opts || {};
    if (bytes.length > MAX_CONTAINER_BYTES) {
      fail('container-too-large', bytes.length + ' bytes exceeds the ' + MAX_CONTAINER_BYTES + '-byte ceiling');
    }
    var hashBytes = clampHashBytes(opts.hashBytes);
    var spans = delta.spanPlan(bytes, { parser: opts.parser, hashBytes: hashBytes });
    var units = semanticPlan(bytes, { parser: opts.parser, hashBytes: hashBytes, decompose: opts.decompose });
    return {
      v: SEM_INVENTORY_VERSION,
      size: bytes.length,
      hashBytes: hashBytes,
      root: core.sha256Hex(bytes),
      spans: spans.map(function (s) {
        return {
          kind: s.kind, index: s.index, type: s.type, typeName: s.typeName,
          offset: s.offset, length: s.length, hash: s.hash
        };
      }),
      units: units.map(function (u) {
        return {
          kind: u.kind, kindName: u.kindName, index: u.index, type: u.type,
          typeName: u.typeName, offset: u.offset, length: u.length, hash: u.hash
        };
      })
    };
  }

  /** Serializes a semantic inventory to its compact binary form. */
  function encodeSemanticInventory(inv) {
    var hashBytes = clampHashBytes(inv.hashBytes);
    var spans = inv.spans || [];
    var units = inv.units || [];
    if (spans.length > delta.MAX_SPANS) fail('too-many-spans', 'inventory has ' + spans.length + ' spans');
    if (units.length > MAX_UNITS) fail('too-many-units', 'inventory has ' + units.length + ' units');
    var recordSize = 6 + hashBytes;
    var out = new Uint8Array(SEM_INVENTORY_HEADER + (spans.length + units.length) * recordSize);
    out.set(SEM_INVENTORY_MAGIC, 0);
    out[4] = SEM_INVENTORY_VERSION;
    out[5] = hashBytes;
    writeU16(out, 6, spans.length);
    writeU32(out, 8, units.length);
    writeU32(out, 12, inv.size);
    writeU32(out, 16, 0);
    out.set(hexToBytes(inv.root), 20);

    var at = SEM_INVENTORY_HEADER;
    at = writeRecords(out, at, spans, hashBytes);
    writeRecords(out, at, units, hashBytes);
    return out;
  }

  function writeRecords(out, at, list, hashBytes) {
    for (var i = 0; i < list.length; i++) {
      out[at] = list[i].kind;
      out[at + 1] = list[i].type;
      writeU32(out, at + 2, list[i].length);
      out.set(hexToBytes(list[i].hash).subarray(0, hashBytes), at + 6);
      at += 6 + hashBytes;
    }
    return at;
  }

  /**
   * Parses an encoded semantic inventory.
   *
   * Bounds every declared count against the bytes actually present before
   * indexing anything, and rejects a table whose lengths do not add up to the
   * declared size. Both tables must cover the container exactly: an inventory
   * that does not describe a whole container cannot drive a reconstruction, and
   * one whose two tables disagree about the container's size describes two
   * different containers.
   */
  function decodeSemanticInventory(source) {
    var bytes = toInventoryBytes(source);
    if (bytes.length < SEM_INVENTORY_HEADER) fail('bad-inventory', 'shorter than the header');
    if (!matchesAt(bytes, SEM_INVENTORY_MAGIC, 0)) fail('bad-inventory-magic', 'not an rvQR semantic inventory');
    if (bytes[4] !== SEM_INVENTORY_VERSION) fail('bad-inventory-version', 'version ' + bytes[4]);
    var hashBytes = bytes[5];
    if (hashBytes < 4 || hashBytes > MAX_HASH_BYTES) fail('bad-inventory', 'hash width ' + hashBytes);
    var spanCount = readU16(bytes, 6);
    var unitCount = readU32(bytes, 8);
    var size = readU32(bytes, 12);
    if (size > MAX_CONTAINER_BYTES) fail('container-too-large', size + ' bytes declared');
    if (unitCount > MAX_UNITS) fail('too-many-units', unitCount + ' units declared');
    var recordSize = 6 + hashBytes;
    if (bytes.length !== SEM_INVENTORY_HEADER + (spanCount + unitCount) * recordSize) {
      fail('bad-inventory', 'table length disagrees with the declared counts');
    }
    var root = core.toHex(bytes.subarray(20, 52));
    var spans = readRecords(bytes, SEM_INVENTORY_HEADER, spanCount, hashBytes, size, 'span', false);
    var units = readRecords(bytes, spans.end, unitCount, hashBytes, size, 'unit', true);
    return {
      v: SEM_INVENTORY_VERSION, size: size, hashBytes: hashBytes, root: root,
      spans: spans.list, units: units.list
    };
  }

  function toInventoryBytes(source) {
    if (source && typeof source !== 'string') {
      if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      fail('bad-inventory-encoding', 'expected base64url text or bytes');
    }
    try {
      return core.b64uDecode(String(source));
    } catch (e) {
      fail('bad-inventory-encoding', 'not valid base64url');
    }
  }

  function readRecords(bytes, at, count, hashBytes, size, label, isUnit) {
    var list = [];
    var total = 0;
    var recordSize = 6 + hashBytes;
    for (var i = 0; i < count; i++) {
      var kind = bytes[at];
      if (isUnit) {
        if (!isUnitKind(kind)) fail('bad-inventory', label + ' ' + i + ' kind ' + kind);
      } else if (kind !== delta.KIND_GAP && kind !== delta.KIND_SEGMENT) {
        fail('bad-inventory', label + ' ' + i + ' kind ' + kind);
      }
      var length = readU32(bytes, at + 2);
      if (length < 1) fail('bad-inventory', label + ' ' + i + ' is empty');
      total += length;
      if (total > size) fail('bad-inventory', label + 's overrun the declared size');
      list.push({
        kind: kind,
        kindName: isUnit ? unitKindName(kind) : (kind === delta.KIND_GAP ? 'GAP' : 'SEGMENT'),
        index: i,
        type: bytes[at + 1],
        typeName: bytes[at + 1] ? delta.segmentTypeName(bytes[at + 1]) : 'GAP',
        offset: total - length,
        length: length,
        hash: core.toHex(bytes.subarray(at + 6, at + 6 + hashBytes))
      });
      at += recordSize;
    }
    if (count && total !== size) {
      fail('bad-inventory', label + 's cover ' + total + ' of ' + size + ' bytes');
    }
    return { list: list, end: at };
  }

  // --- Encrypted inventory ---------------------------------------------------

  /**
   * Seals an inventory under a session key.
   *
   * delta.js's inventory travels in the clear, and an inventory is not
   * innocuous metadata: it is a list of what a device holds. Segment types name
   * the kind of thing (a Vec slab, a WASM component, a COW branch map), content
   * hashes identify the exact artifact and the exact version of it, and the
   * root digest identifies the container outright. Anyone who can watch the
   * channel and holds a copy of a published model, agent memory or firmware
   * image can confirm this device has that exact build by hashing their own
   * copy. That is the metadata an observer wants, and it is cheaper for them
   * than the payload.
   *
   * WHAT SEALING HIDES: the segment types, every content hash, the root digest,
   * the per-unit lengths, the container size, and therefore which artifacts and
   * which versions this device holds. crypto.js's AEAD binds its associated
   * data — this passes a context string that names what the ciphertext is for,
   * so an inventory cannot be replayed into a position that expects something
   * else, and the session layer binds the session id and record counter besides.
   *
   * WHAT SEALING DOES NOT HIDE: the SIZE of the sealed blob, which is the
   * padded plaintext plus a fixed 24 bytes (an 8-byte record counter and a
   * 16-byte tag), and whose plaintext is linear in the number of units — so an
   * observer still learns roughly how many units, and therefore
   * roughly how much, the device holds. A device with four segments and one
   * with four thousand do not look alike no matter what key is used. It also
   * does not hide that an inventory was sent, or when, or to whom; traffic
   * analysis is not in scope for an AEAD. `opts.pad` rounds the plaintext up to
   * a multiple, which coarsens the size signal into buckets at the cost of the
   * padding — it blunts the leak, it does not remove it, and a caller who needs
   * it gone needs constant-size inventories, not padding.
   *
   * `session` is a crypto.js session from sessionAccept/sessionConfirm.
   */
  function sealInventory(inv, session, opts) {
    opts = opts || {};
    if (!crypto || typeof crypto.seal !== 'function') {
      return Promise.reject(SemDeltaError('crypto-unavailable', 'crypto.js is not loaded'));
    }
    if (!session || !session.sendKey) {
      return Promise.reject(SemDeltaError('bad-session', 'not a crypto.js session'));
    }
    var body;
    try {
      body = (inv && typeof inv === 'object' && !ArrayBuffer.isView(inv))
        ? encodeSemanticInventory(inv)
        : toInventoryBytes(inv);
    } catch (e) {
      return Promise.reject(e);
    }
    if (body.length > MAX_SEALED_PLAINTEXT) {
      return Promise.reject(SemDeltaError('inventory-too-large', body.length + ' bytes exceeds the sealing ceiling'));
    }

    var pad = Math.floor(Number(opts.pad) || 0);
    var padded = pad > 1 ? Math.ceil((4 + body.length) / pad) * pad : 4 + body.length;
    if (padded > MAX_SEALED_PLAINTEXT) {
      return Promise.reject(SemDeltaError('inventory-too-large', 'padded plaintext exceeds the sealing ceiling'));
    }
    // The true length is carried inside the ciphertext so padding is
    // indistinguishable from content to anyone without the key.
    var plaintext = new Uint8Array(padded);
    writeU32(plaintext, 0, body.length);
    plaintext.set(body, 4);

    return crypto.seal(session, plaintext, sealAad(opts.context))
      .then(function (record) { return core.b64uEncode(record); });
  }

  /**
   * Opens a sealed inventory. Rejects — rather than returning a partial
   * answer — on a tampered ciphertext, a tampered or mismatched context, a
   * replayed record, or a plaintext whose declared length does not fit.
   */
  function openInventory(text, session, opts) {
    opts = opts || {};
    if (!crypto || typeof crypto.open !== 'function') {
      return Promise.reject(SemDeltaError('crypto-unavailable', 'crypto.js is not loaded'));
    }
    if (!session || !session.recvKey) {
      return Promise.reject(SemDeltaError('bad-session', 'not a crypto.js session'));
    }
    var record;
    try {
      record = typeof text === 'string' ? core.b64uDecode(text) : toInventoryBytes(text);
    } catch (e) {
      return Promise.reject(SemDeltaError('bad-sealed-encoding', 'not valid base64url'));
    }
    return crypto.open(session, record, sealAad(opts.context)).then(function (result) {
      if (!result.ok) {
        fail('inventory-auth-failed', 'sealed inventory rejected: ' + result.reason);
      }
      var pt = result.plaintext;
      if (pt.length < 4) fail('bad-sealed-inventory', 'plaintext shorter than its length prefix');
      var length = readU32(pt, 0);
      if (length > pt.length - 4) {
        fail('bad-sealed-inventory', 'declared ' + length + ' bytes, ' + (pt.length - 4) + ' present');
      }
      return decodeSemanticInventory(pt.subarray(4, 4 + length));
    });
  }

  /**
   * The associated data every sealed inventory binds: the magic, the version,
   * and a caller-supplied context string. crypto.js concatenates this after the
   * session id and record counter it binds itself, so a record cannot be
   * replayed across sessions, across positions in a session, or into a slot
   * that expected a different kind of message.
   */
  function sealAad(context) {
    var ctx = context === undefined || context === null ? '' : String(context);
    var ctxBytes = utf8Bytes(ctx);
    var out = new Uint8Array(5 + ctxBytes.length);
    out.set(SEALED_MAGIC, 0);
    out[4] = SEALED_VERSION;
    out.set(ctxBytes, 5);
    return out;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  // --- Diff ------------------------------------------------------------------

  /**
   * Which of the sender's units the receiver does not already hold.
   *
   * The held set is built from the receiver's units AND its spans, because a
   * unit the sender did not decompose is exactly a span, and a receiver that
   * happens to hold it as a span holds it. Matching is by (hash, length), never
   * by offset — that is what lets a record survive its slab being reordered or
   * its segment moving because something upstream of it grew.
   *
   * A receiver of null is a cold start: everything is missing and the ratio
   * is 1.
   */
  function diffUnits(sender, receiver) {
    var senderUnits = unitsOf(sender);
    var held = Object.create(null);
    if (receiver) {
      addHeld(held, receiver.units);
      addHeld(held, receiver.spans);
      if (Array.isArray(receiver)) addHeld(held, receiver);
    }

    var missing = [], present = [];
    var bytesToSend = 0, bytesTotal = 0;
    var byKind = {};
    for (var i = 0; i < senderUnits.length; i++) {
      var u = senderUnits[i];
      bytesTotal += u.length;
      var row = byKind[unitKindName(u.kind)] || (byKind[unitKindName(u.kind)] = { units: 0, sent: 0, bytes: 0 });
      row.units++;
      if (held[u.hash + ':' + u.length]) {
        present.push(i);
      } else {
        missing.push(i);
        bytesToSend += u.length;
        row.sent++;
        row.bytes += u.length;
      }
    }

    return {
      missing: missing,
      present: present,
      bytesToSend: bytesToSend,
      bytesTotal: bytesTotal,
      bytesSaved: bytesTotal - bytesToSend,
      savedFraction: bytesTotal ? (bytesTotal - bytesToSend) / bytesTotal : 0,
      ratio: bytesToSend ? bytesTotal / bytesToSend : Infinity,
      byKind: byKind,
      sameRoot: !!(sender && receiver && sender.root && sender.root === receiver.root)
    };
  }

  function addHeld(held, list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      held[list[i].hash + ':' + list[i].length] = true;
    }
  }

  function unitsOf(side) {
    if (!side) return [];
    if (Array.isArray(side)) return side;
    if (Array.isArray(side.units)) return side.units;
    fail('bad-diff-input', 'expected a semantic inventory or a unit array');
  }

  // --- Semantic delta payload ------------------------------------------------

  /**
   * Builds the payload the sender transmits: the whole unit plan (so the
   * receiver knows the shape of the result), the bytes of the missing units,
   * the digest of the sender's container, and the digest of the base the delta
   * was computed against.
   *
   * That last field is what makes it safe to apply. Without it, a delta
   * computed against one container could be applied to another and produce a
   * file that is neither, with no error anywhere — and at unit granularity that
   * failure would be subtler still, because a container assembled from another
   * container's records would look structurally valid.
   *
   * opts: { parser, hashBytes, base, units } — `base` is the receiver inventory
   * this delta is for; omitting it produces an unbound delta. `units` reuses an
   * already-computed plan rather than recomputing it.
   */
  function buildSemanticPayload(bytes, missingIndices, opts) {
    opts = opts || {};
    if (bytes.length > MAX_CONTAINER_BYTES) {
      fail('container-too-large', bytes.length + ' bytes exceeds the ceiling');
    }
    var hashBytes = clampHashBytes(
      opts.hashBytes !== undefined ? opts.hashBytes : (opts.base && opts.base.hashBytes)
    );
    var units = opts.units || semanticPlan(bytes, {
      parser: opts.parser, hashBytes: hashBytes, decompose: opts.decompose
    });
    if (units.length > MAX_UNITS) fail('too-many-units', units.length + ' units exceeds the ceiling');

    var included = new Uint8Array(units.length);
    var list = missingIndices || [];
    var includedBytes = 0;
    var includedCount = 0;
    for (var i = 0; i < list.length; i++) {
      var idx = list[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= units.length) {
        fail('bad-unit-index', 'unit index ' + idx + ' is not in 0..' + (units.length - 1));
      }
      if (!included[idx]) {
        included[idx] = 1;
        includedCount++;
        includedBytes += units[idx].length;
      }
    }

    var recordSize = 6 + hashBytes;
    var out = new Uint8Array(SEM_DELTA_HEADER + units.length * recordSize + includedBytes);
    out.set(SEM_DELTA_MAGIC, 0);
    out[4] = SEM_DELTA_VERSION;
    out[5] = hashBytes;
    writeU16(out, 6, 0);
    writeU32(out, 8, units.length);
    writeU32(out, 12, bytes.length);
    writeU32(out, 16, includedCount);
    writeU32(out, 20, includedBytes);
    out.set(hexToBytes(core.sha256Hex(bytes)), 24);
    if (opts.base && opts.base.root) out.set(hexToBytes(opts.base.root), 56);

    var at = SEM_DELTA_HEADER;
    for (var u = 0; u < units.length; u++) {
      out[at] = units[u].kind | (included[u] ? 0x80 : 0);
      out[at + 1] = units[u].type;
      writeU32(out, at + 2, units[u].length);
      out.set(hexToBytes(units[u].hash).subarray(0, hashBytes), at + 6);
      at += recordSize;
    }
    for (var p = 0; p < units.length; p++) {
      if (!included[p]) continue;
      out.set(bytes.subarray(units[p].offset, units[p].offset + units[p].length), at);
      at += units[p].length;
    }
    return out;
  }

  /**
   * Reads a semantic delta's header and unit table without applying it.
   *
   * Every declared count is checked against the bytes actually present before
   * anything is indexed, so a payload claiming a quarter of a million units in
   * ninety bytes is a clean rejection rather than an out-of-memory.
   */
  function parseSemanticPayload(payload) {
    if (!payload || payload.length < SEM_DELTA_HEADER) fail('bad-delta', 'shorter than the header');
    if (!matchesAt(payload, SEM_DELTA_MAGIC, 0)) fail('bad-delta-magic', 'not an rvQR semantic delta payload');
    if (payload[4] !== SEM_DELTA_VERSION) fail('bad-delta-version', 'version ' + payload[4]);
    var hashBytes = payload[5];
    if (hashBytes < 4 || hashBytes > MAX_HASH_BYTES) fail('bad-delta', 'hash width ' + hashBytes);
    var unitCount = readU32(payload, 8);
    var size = readU32(payload, 12);
    var includedCount = readU32(payload, 16);
    var includedBytes = readU32(payload, 20);
    if (size > MAX_CONTAINER_BYTES) fail('container-too-large', size + ' bytes declared');
    if (unitCount > MAX_UNITS) fail('too-many-units', unitCount + ' units declared');
    if (includedCount > unitCount) fail('bad-delta', 'more included units than units');

    var recordSize = 6 + hashBytes;
    // unitCount is bounded above, so this product cannot overflow into a
    // small number and let a short payload look like it has a long table.
    var tableEnd = SEM_DELTA_HEADER + unitCount * recordSize;
    if (tableEnd > payload.length) fail('bad-delta', 'unit table runs past the end of the payload');
    if (payload.length - tableEnd !== includedBytes) {
      fail('bad-delta', 'payload body is ' + (payload.length - tableEnd) + ' bytes, header declares ' + includedBytes);
    }

    var senderRoot = core.toHex(payload.subarray(24, 56));
    var baseRootBytes = payload.subarray(56, 88);
    var bound = false;
    for (var b = 0; b < 32; b++) if (baseRootBytes[b] !== 0) { bound = true; break; }

    var units = [];
    var total = 0, carried = 0, seenIncluded = 0;
    var at = SEM_DELTA_HEADER;
    for (var i = 0; i < unitCount; i++) {
      var flags = payload[at];
      var isIncluded = (flags & 0x80) !== 0;
      var kind = flags & 0x7f;
      if (!isUnitKind(kind)) fail('bad-delta', 'unit ' + i + ' kind ' + kind);
      var length = readU32(payload, at + 2);
      if (length < 1) fail('bad-delta', 'unit ' + i + ' is empty');
      total += length;
      if (total > size) fail('bad-delta', 'units overrun the declared size');
      if (isIncluded) {
        seenIncluded++;
        carried += length;
        if (carried > includedBytes) fail('bad-delta', 'carried units overrun the payload body');
      }
      units.push({
        kind: kind,
        kindName: unitKindName(kind),
        index: i,
        included: isIncluded,
        type: payload[at + 1],
        typeName: payload[at + 1] ? delta.segmentTypeName(payload[at + 1]) : 'GAP',
        offset: total - length,
        length: length,
        hash: core.toHex(payload.subarray(at + 6, at + 6 + hashBytes))
      });
      at += recordSize;
    }
    if (total !== size) fail('bad-delta', 'units cover ' + total + ' of ' + size + ' bytes');
    if (carried !== includedBytes) fail('bad-delta', 'carried units cover ' + carried + ' of ' + includedBytes + ' body bytes');
    if (seenIncluded !== includedCount) fail('bad-delta', 'included-unit count disagrees with the table');

    return {
      v: SEM_DELTA_VERSION, size: size, hashBytes: hashBytes,
      root: senderRoot, baseRoot: bound ? core.toHex(baseRootBytes) : null,
      units: units, includedCount: includedCount, includedBytes: includedBytes,
      bodyOffset: tableEnd
    };
  }

  /**
   * Reconstructs the sender's container from the receiver's base plus a
   * semantic delta.
   *
   * The base check happens first — before the base is scanned, before its plan
   * is computed, before the output is allocated. A delta bound to a container
   * the receiver does not hold is refused while the only thing that has been
   * touched is the payload's own header.
   *
   * Units the delta does not carry are taken from the base by content hash
   * rather than by offset, so a base whose records sit at different offsets
   * still reconstructs, and the whole result is verified against the sender's
   * SHA-256 before it is returned. Nothing partial is ever handed back.
   */
  function applySemanticDelta(receiverBytes, payload, opts) {
    opts = opts || {};
    var d = parseSemanticPayload(payload);
    var base = receiverBytes || new Uint8Array(0);

    if (d.baseRoot) {
      var baseRoot = core.sha256Hex(base);
      if (baseRoot !== d.baseRoot) {
        fail(
          'base-mismatch',
          'delta was computed against ' + d.baseRoot.slice(0, 16) +
            '…, the receiver holds ' + baseRoot.slice(0, 16) + '…'
        );
      }
    }

    // Index the base by content hash, at both granularities: a unit the sender
    // decomposed may be held by the base as a span and vice versa, and indexing
    // both costs one extra pass of hashing over bytes already in memory.
    var byHash = Object.create(null);
    if (base.length) {
      var baseUnits = semanticPlan(base, { parser: opts.parser, hashBytes: d.hashBytes });
      indexByHash(byHash, baseUnits);
      indexByHash(byHash, delta.spanPlan(base, { parser: opts.parser, hashBytes: d.hashBytes }));
    }

    // Resolve every unit before writing a byte: a delta that turns out to be
    // unsatisfiable halfway through must not leave a half-built container.
    var sources = new Array(d.units.length);
    var bodyAt = d.bodyOffset;
    for (var i = 0; i < d.units.length; i++) {
      var unit = d.units[i];
      if (unit.included) {
        sources[i] = { from: 'delta', offset: bodyAt };
        bodyAt += unit.length;
        continue;
      }
      var at = byHash[unit.hash + ':' + unit.length];
      if (at === undefined) {
        fail(
          'missing-unit',
          'unit ' + i + ' (' + unit.kindName + ' of ' + unit.typeName + ', ' + unit.length +
            ' bytes) is neither carried by the delta nor present in the base'
        );
      }
      sources[i] = { from: 'base', offset: at };
    }

    var out = new Uint8Array(d.size);
    var cursor = 0;
    for (var j = 0; j < d.units.length; j++) {
      var u = d.units[j];
      var src = sources[j];
      var from = src.from === 'delta' ? payload : base;
      out.set(from.subarray(src.offset, src.offset + u.length), cursor);
      cursor += u.length;
    }

    var digest = core.sha256Hex(out);
    if (digest !== d.root) {
      fail('reconstruction-mismatch', 'rebuilt container hashes to ' + digest.slice(0, 16) +
        '…, delta declares ' + d.root.slice(0, 16) + '…');
    }
    return {
      bytes: out, sha256: digest,
      fromDelta: d.includedBytes, fromBase: d.size - d.includedBytes,
      units: d.units.length, unitsCarried: d.includedCount
    };
  }

  function indexByHash(map, list) {
    for (var i = 0; i < list.length; i++) {
      var key = list[i].hash + ':' + list[i].length;
      if (!(key in map)) map[key] = list[i].offset;
    }
  }

  // --- The choice ------------------------------------------------------------

  /**
   * Builds both deltas, measures both, and returns the smaller one.
   *
   * This is not an estimate. Both payloads are constructed and their real byte
   * lengths compared, because the two are close enough often enough that a
   * heuristic would pick wrong: a semantic delta pays `6 + hashBytes` per unit
   * for a table that describes the entire container, and a container of many
   * small records can spend more on describing itself than a span delta spends
   * on resending a whole segment. Ties go to the span delta — it is the simpler
   * artifact and any receiver that can read a delta at all can read it.
   *
   * Returns the chosen payload together with both figures, the full-transfer
   * size, and a sentence saying why — a caller that cannot explain a transfer
   * size to a user has no business quoting one.
   */
  function chooseDelta(senderBytes, receiverInventory, opts) {
    opts = opts || {};
    var hashBytes = clampHashBytes(
      opts.hashBytes !== undefined ? opts.hashBytes
        : (receiverInventory && receiverInventory.hashBytes)
    );
    var planOpts = { parser: opts.parser, hashBytes: hashBytes };

    var spans = delta.spanPlan(senderBytes, planOpts);
    var spanDiff = delta.diff({ spans: spans, root: core.sha256Hex(senderBytes) }, receiverInventory);
    var spanPayload = delta.buildDeltaPayload(senderBytes, spanDiff.missing, {
      parser: opts.parser, hashBytes: hashBytes, base: receiverInventory
    });

    var units = semanticPlan(senderBytes, planOpts);
    var unitDiff = diffUnits({ units: units, root: core.sha256Hex(senderBytes) }, receiverInventory);
    var semPayload = buildSemanticPayload(senderBytes, unitDiff.missing, {
      parser: opts.parser, hashBytes: hashBytes, base: receiverInventory, units: units
    });

    var semanticWins = semPayload.length < spanPayload.length;
    var chosen = semanticWins ? 'semantic' : 'span';
    var reason = semanticWins
      ? 'semantic delta is ' + (spanPayload.length - semPayload.length) + ' bytes smaller: ' +
        unitDiff.missing.length + ' of ' + units.length + ' units carried (' +
        unitDiff.bytesToSend + ' payload bytes) against ' + spanDiff.missing.length + ' of ' +
        spans.length + ' spans (' + spanDiff.bytesToSend + ' payload bytes)'
      : 'span delta is ' + (semPayload.length - spanPayload.length) + ' bytes smaller: the ' +
        units.length + '-unit table costs ' + (units.length * (6 + hashBytes)) +
        ' bytes, more than the ' + (spanDiff.bytesToSend - unitDiff.bytesToSend) +
        ' bytes of payload it saves';

    return {
      chosen: chosen,
      payload: semanticWins ? semPayload : spanPayload,
      bytes: semanticWins ? semPayload.length : spanPayload.length,
      spanBytes: spanPayload.length,
      semanticBytes: semPayload.length,
      fullBytes: senderBytes.length,
      spanPayload: spanPayload,
      semanticPayload: semPayload,
      spanDiff: spanDiff,
      unitDiff: unitDiff,
      spanCount: spans.length,
      unitCount: units.length,
      tableBytes: units.length * (6 + hashBytes),
      reason: reason
    };
  }

  /**
   * Applies whatever chooseDelta() picked, without the caller having to know
   * which. Dispatches on the payload's own magic rather than on the `chosen`
   * label, so a mislabelled result cannot be applied by the wrong reader.
   */
  function applyChosen(baseBytes, chosen, opts) {
    var payload = chosen && chosen.payload ? chosen.payload : chosen;
    if (!payload || payload.length < 4) fail('bad-delta', 'not a delta payload');
    if (matchesAt(payload, SEM_DELTA_MAGIC, 0)) return applySemanticDelta(baseBytes, payload, opts);
    if (matchesAt(payload, [0x52, 0x56, 0x51, 0x44], 0)) return delta.applyDelta(baseBytes, payload, opts);
    fail('bad-delta-magic', 'not an rvQR delta payload of either kind');
  }

  return {
    // wire constants
    SEM_INVENTORY_MAGIC: SEM_INVENTORY_MAGIC,
    SEM_DELTA_MAGIC: SEM_DELTA_MAGIC,
    SEM_INVENTORY_HEADER: SEM_INVENTORY_HEADER,
    SEM_DELTA_HEADER: SEM_DELTA_HEADER,

    // unit kinds
    UNIT_SPAN: UNIT_SPAN,
    UNIT_HEAD: UNIT_HEAD,
    UNIT_RECORD: UNIT_RECORD,
    UNIT_SECTION: UNIT_SECTION,
    UNIT_BLOCK: UNIT_BLOCK,
    UNIT_TAIL: UNIT_TAIL,
    unitKindName: unitKindName,

    // ceilings
    MAX_UNITS: MAX_UNITS,
    MIN_UNIT_BYTES: MIN_UNIT_BYTES,
    MAX_SEALED_PLAINTEXT: MAX_SEALED_PLAINTEXT,
    COW_BLOCK_ENTRIES: COW_BLOCK_ENTRIES,
    MEMBERSHIP_BLOCK_BYTES: MEMBERSHIP_BLOCK_BYTES,

    // segment types with a decomposer
    TYPE_VEC: TYPE_VEC,
    TYPE_WASM: TYPE_WASM,
    TYPE_COWMAP: TYPE_COWMAP,
    TYPE_MEMBERSHIP: TYPE_MEMBERSHIP,

    SemDeltaError: SemDeltaError,

    // vector semantics
    readVectorSlab: readVectorSlab,
    vectorSlabs: vectorSlabs,
    vectorDiff: vectorDiff,

    // planning
    semanticPlan: semanticPlan,
    decompositionReport: decompositionReport,

    // inventory
    semanticInventory: semanticInventory,
    encodeSemanticInventory: encodeSemanticInventory,
    decodeSemanticInventory: decodeSemanticInventory,
    sealInventory: sealInventory,
    openInventory: openInventory,

    // transfer
    diffUnits: diffUnits,
    buildSemanticPayload: buildSemanticPayload,
    parseSemanticPayload: parseSemanticPayload,
    applySemanticDelta: applySemanticDelta,
    chooseDelta: chooseDelta,
    applyChosen: applyChosen
  };
});
