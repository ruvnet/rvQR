/*!
 * rvQR semantic delta test suite.
 *
 * Node only, because these tests need the real RVF microkernel wasm and the
 * real demo container off disk: `node artifacts/semdelta.test.js`. One line per
 * test, non-zero exit on any failure — same shape as artifacts/tests.js and
 * artifacts/delta.test.js.
 *
 * Three things are deliberately real rather than mocked. The vector tests run
 * against artifacts/demo/ruvnet-demo.rvf parsed by
 * artifacts/demo/rvf_wasm_bg.wasm, so the record boundaries under test are the
 * ones the shipped parser and rvf.js actually agree on. The WASM tests embed
 * that same microkernel as the payload of a Wasm segment, so the section and
 * function boundaries are a real module's, not a hand-rolled fixture's. And the
 * encrypted-inventory tests run a real crypto.js handshake and seal under the
 * session it produces, so what is being tested is the AEAD this app ships.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var nodeCrypto = require('crypto');
var core = require('./core.js');
var delta = require('./delta.js');
var semdelta = require('./semdelta.js');
var crypto = require('./crypto.js');

var DEMO_DIR = path.join(__dirname, 'demo');
var DEMO_RVF = path.join(DEMO_DIR, 'ruvnet-demo.rvf');
var DEMO_WASM = path.join(DEMO_DIR, 'rvf_wasm_bg.wasm');

// --- Harness ----------------------------------------------------------------

var results = [];
var queue = [];

function test(name, fn) {
  queue.push({ name: name, fn: fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
  }
}

function assertThrows(reason, fn, msg) {
  var caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert(caught, (msg || 'expected a rejection') + ', nothing was thrown');
  assertEqual(caught.reason, reason, msg || 'rejection reason');
  return caught;
}

function assertRejects(reason, promise, msg) {
  return promise.then(
    function () { throw new Error((msg || 'expected a rejection') + ', it resolved'); },
    function (e) {
      assertEqual(e.reason, reason, msg || 'rejection reason');
      return e;
    }
  );
}

/**
 * Reconstruction is asserted with node:crypto rather than with core.sha256Hex,
 * so a bug in the hashing this module depends on cannot make a wrong
 * reconstruction look right.
 */
function sha256(bytes) {
  return nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function skip(reason) {
  return { __skip: reason };
}

// --- Container construction -------------------------------------------------
// A 64-byte segment header per ADR-009: little-endian magic 53 46 56 52,
// version 1, type, then the segment id and payload length as u64s.

function segmentHeader(type, segId, payloadLength) {
  var h = new Uint8Array(64);
  h.set([0x53, 0x46, 0x56, 0x52], 0);
  h[4] = 1;
  h[5] = type;
  h[8] = segId & 0xff;
  h[9] = (segId >>> 8) & 0xff;
  h[16] = payloadLength & 0xff;
  h[17] = (payloadLength >>> 8) & 0xff;
  h[18] = (payloadLength >>> 16) & 0xff;
  h[19] = (payloadLength >>> 24) & 0xff;
  return h;
}

/** specs: [{ type, payload }] -> a container both parsers enumerate. */
function makeContainer(specs) {
  var total = specs.reduce(function (n, s) { return n + 64 + s.payload.length; }, 0);
  var out = new Uint8Array(total);
  var at = 0;
  for (var i = 0; i < specs.length; i++) {
    out.set(segmentHeader(specs[i].type, i + 1, specs[i].payload.length), at);
    out.set(specs[i].payload, at + 64);
    at += 64 + specs[i].payload.length;
  }
  return out;
}

// Deterministic pseudo-random bytes so failures are reproducible.
var seed = 0x2b7f19c;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 16) & 0xff;
}
function rndBytes(n) {
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = rnd();
  return out;
}

/** A Vec payload: u16 dim | u16 count | u16 flags | count × { u64 id, dim × f32 }. */
function vecPayload(dim, records, flags) {
  var stride = 8 + dim * 4;
  var out = new Uint8Array(6 + stride * records.length);
  out[0] = dim & 0xff; out[1] = (dim >>> 8) & 0xff;
  out[2] = records.length & 0xff; out[3] = (records.length >>> 8) & 0xff;
  out[4] = (flags || 0) & 0xff; out[5] = ((flags || 0) >>> 8) & 0xff;
  for (var i = 0; i < records.length; i++) out.set(records[i], 6 + i * stride);
  return out;
}

function vecRecord(id, dim, fill) {
  var r = new Uint8Array(8 + dim * 4);
  r[0] = id & 0xff; r[1] = (id >>> 8) & 0xff;
  r[2] = (id >>> 16) & 0xff; r[3] = (id >>> 24) & 0xff;
  for (var i = 8; i < r.length; i++) r[i] = (fill + i * 7) & 0xff;
  return r;
}

/**
 * Rewrites a container's first Vec segment through `fn(records, slab)`,
 * fixing up the segment header's payload length and perturbing its content_hash
 * field the way any real rewrite would. Everything after the segment shifts,
 * which is exactly the case hash-based matching has to survive.
 */
function rewriteVec(bytes, fn) {
  var spans = delta.spanPlan(bytes);
  var span = null;
  for (var i = 0; i < spans.length; i++) {
    if (spans[i].type === semdelta.TYPE_VEC) { span = spans[i]; break; }
  }
  assert(span, 'container has no Vec segment');
  var slab = semdelta.readVectorSlab(bytes, span);
  assert(slab, 'Vec segment did not parse');

  var records = [];
  for (var r = 0; r < slab.count; r++) {
    records.push(bytes.slice(slab.records[r].offset, slab.records[r].offset + slab.stride));
  }
  var next = fn(records, slab) || records;
  var payload = vecPayload(slab.dim, next, slab.flags);

  var head = bytes.slice(span.offset, span.offset + 64);
  head[16] = payload.length & 0xff;
  head[17] = (payload.length >>> 8) & 0xff;
  head[18] = (payload.length >>> 16) & 0xff;
  head[19] = (payload.length >>> 24) & 0xff;
  // content_hash[16] at 0x28 moves whenever the payload does.
  for (var h = 0x28; h < 0x38; h++) head[h] = (head[h] + 1) & 0xff;

  var out = new Uint8Array(bytes.length - span.length + 64 + payload.length);
  out.set(bytes.subarray(0, span.offset), 0);
  out.set(head, span.offset);
  out.set(payload, span.offset + 64);
  out.set(bytes.subarray(span.offset + span.length), span.offset + 64 + payload.length);
  return out;
}

/** A CowMap payload: header(64) | trailer(17) | parent path | flat-array map. */
function cowMapPayload(clusters, parentPath, localSet) {
  var parent = Buffer.from(parentPath, 'utf8');
  var mapLen = 5 + clusters * 9;
  var out = new Uint8Array(81 + parent.length + mapLen);
  out.set([0x4d, 0x43, 0x56, 0x52], 0); // COWMAP_MAGIC little-endian
  out[4] = 1;   // version
  out[6] = 0;   // map_format = FlatArray
  writeU32(out, 0x08, 4096);           // cluster_size_bytes
  writeU32(out, 0x0c, 64);             // vectors_per_cluster
  writeU32(out, 0x40, 64);             // bytes_per_vector
  writeU32(out, 0x45, 1);              // snapshot_epoch (unaligned, per store.rs)
  writeU32(out, 0x49, parent.length);
  writeU32(out, 0x4d, mapLen);
  out.set(parent, 0x51);
  var m = 0x51 + parent.length;
  out[m] = 0;
  writeU32(out, m + 1, clusters);
  for (var i = 0; i < clusters; i++) {
    var at = m + 5 + i * 9;
    if (localSet && localSet[i]) {
      out[at] = 2; // LocalOffset
      writeU32(out, at + 1, 4096 * i);
    } else {
      out[at] = 1; // ParentRef — shares the parent's slab
    }
  }
  return out;
}

/** A Membership payload: header(96) | dense little-endian u64 bitmap. */
function membershipPayload(vectorCount, clearIds) {
  var words = Math.ceil(vectorCount / 64);
  var filterSize = words * 8;
  var out = new Uint8Array(96 + filterSize);
  out.set([0x42, 0x4d, 0x56, 0x52], 0); // MEMBERSHIP_MAGIC little-endian
  out[4] = 1;   // version
  out[6] = 0;   // filter_type = Bitmap
  out[7] = 0;   // filter_mode = Include
  writeU32(out, 0x08, vectorCount);
  writeU32(out, 0x10, vectorCount);
  writeU32(out, 0x18, 96);              // filter_offset
  writeU32(out, 0x20, filterSize);
  for (var i = 96; i < out.length; i++) out[i] = 0xff;
  (clearIds || []).forEach(function (id) {
    var byteAt = 96 + (id >>> 3);
    if (byteAt < out.length) out[byteAt] &= ~(1 << (id & 7));
  });
  return out;
}

function writeU32(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >>> 8) & 0xff;
  bytes[off + 2] = (value >>> 16) & 0xff;
  bytes[off + 3] = (value >>> 24) & 0xff;
}

/**
 * Walks a WASM module's sections independently of semdelta.js, so the
 * decomposition can be checked against a second reading rather than against
 * itself. Returns [{ id, at, size, contentsAt }].
 */
function walkWasmSections(bytes, from, end) {
  var out = [];
  var at = from + 8;
  while (at < end) {
    var id = bytes[at];
    var shift = 0, value = 0, len = 0;
    for (var i = 0; i < 5; i++) {
      var b = bytes[at + 1 + i];
      value += (b & 0x7f) * Math.pow(2, shift);
      len++;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    var contentsAt = at + 1 + len;
    if (contentsAt + value > end) break;
    out.push({ id: id, at: at, size: value, contentsAt: contentsAt });
    at = contentsAt + value;
  }
  return out;
}

function coversExactly(units, size, label) {
  var at = 0;
  for (var i = 0; i < units.length; i++) {
    assertEqual(units[i].offset, at, (label || 'unit') + ' ' + i + ' starts where the previous one ended');
    assert(units[i].length > 0, (label || 'unit') + ' ' + i + ' is empty');
    at += units[i].length;
  }
  assertEqual(at, size, (label || 'unit') + ' total coverage');
}

// --- Session pair -----------------------------------------------------------

/** A real crypto.js handshake, returning both ends of the session. */
function makeSessionPair() {
  return crypto.sessionInvite({}).then(function (state) {
    return crypto.sessionAccept(state.bootstrap, {}).then(function (accepted) {
      assert(accepted.ok, 'responder accepted the invite');
      return crypto.sessionConfirm(state, accepted.bootstrap, {}).then(function (confirmed) {
        assert(confirmed.ok, 'initiator confirmed the reply: ' + confirmed.reason);
        return { initiator: confirmed.session, responder: accepted.session };
      });
    });
  });
}

// --- Tests ------------------------------------------------------------------

function registerTests(ctx) {
  var demo = ctx.demo;
  var parser = ctx.parser;
  var report = ctx.report;

  // --- plan and decomposition ---------------------------------------------

  test('the demo container decomposes its Vec segment into one unit per vector record', function () {
    var rows = semdelta.decompositionReport(demo, { parser: parser });
    var vec = rows.filter(function (r) { return r.typeName === 'VEC'; })[0];
    assert(vec, 'the demo container has a VEC segment');
    assert(vec.decomposed, 'VEC was not decomposed: ' + vec.reason);
    var span = delta.spanPlan(demo, { parser: parser }).filter(function (s) {
      return s.type === semdelta.TYPE_VEC;
    })[0];
    var slab = semdelta.readVectorSlab(demo, span);
    assertEqual(slab.dim, 16, 'demo dimensions');
    assertEqual(slab.count, 24, 'demo vector count');
    assertEqual(slab.stride, 8 + 16 * 4, 'record stride');
    assertEqual(slab.trailing, 0, 'the records account for the payload exactly');
    // head + one unit per record, no tail.
    assertEqual(vec.units, slab.count + 1, 'units for the VEC segment');
    return slab.count + ' records of ' + slab.stride + ' bytes, dim ' + slab.dim +
      ', slab ' + span.length + ' bytes → ' + vec.units + ' units';
  });

  test('the semantic plan covers every byte of the demo container exactly once', function () {
    var units = semdelta.semanticPlan(demo, { parser: parser });
    coversExactly(units, demo.length, 'unit');
    var spans = delta.spanPlan(demo, { parser: parser });
    assert(units.length > spans.length, 'semantic plan should be finer than the span plan');
    return units.length + ' units over ' + spans.length + ' spans, ' + demo.length + ' bytes';
  });

  test('segments with no published payload layout stay whole, and say why', function () {
    var rows = semdelta.decompositionReport(demo, { parser: parser });
    var opaque = rows.filter(function (r) { return !r.decomposed; });
    assert(opaque.length >= 3, 'expected the manifests and witness to stay whole');
    opaque.forEach(function (r) {
      assertEqual(r.units, 1, r.typeName + ' stayed one unit');
      assert(r.reason.length > 0, r.typeName + ' gave a reason');
    });
    return opaque.map(function (r) { return r.typeName; }).join(', ') + ' left opaque';
  });

  test('the JS scanner and the wasm microkernel produce the same semantic plan', function () {
    var w = semdelta.semanticPlan(demo, { parser: parser });
    var j = semdelta.semanticPlan(demo);
    assertEqual(j.length, w.length, 'unit count');
    for (var i = 0; i < w.length; i++) {
      assertEqual(j[i].offset, w[i].offset, 'unit ' + i + ' offset');
      assertEqual(j[i].length, w[i].length, 'unit ' + i + ' length');
      assertEqual(j[i].kind, w[i].kind, 'unit ' + i + ' kind');
      assertEqual(j[i].hash, w[i].hash, 'unit ' + i + ' hash');
    }
    return w.length + ' units identical';
  });

  // --- record-level vector diff -------------------------------------------

  test('record-level diff of the real demo container names the ids added, removed and changed', function () {
    var target = ctx.demoEdited;
    var vd = semdelta.vectorDiff(demo, target, { parser: parser });
    assertEqual(vd.added.length, 3, 'ids added');
    assertEqual(vd.removed.length, 1, 'ids removed');
    assertEqual(vd.changed.length, 1, 'ids changed');
    assertEqual(vd.unchanged, 22, 'ids untouched');
    assertEqual(vd.removed[0], 8, 'the removed id');
    assertEqual(vd.changed[0], 4, 'the changed id');
    assert(!vd.dimChanged, 'dimensions did not move');
    return 'added ' + vd.added.join(',') + '; removed ' + vd.removed.join(',') +
      '; changed ' + vd.changed.join(',') + '; ' + vd.unchanged + ' unchanged';
  });

  test('a small edit to the real demo container sends records, not the whole slab', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);

    var slabBytes = delta.spanPlan(target, { parser: parser }).filter(function (s) {
      return s.type === semdelta.TYPE_VEC;
    })[0].length;
    assert(d.bytesToSend < slabBytes,
      'sent ' + d.bytesToSend + ' bytes, the whole slab is ' + slabBytes);

    // Three added records, one modified record, and the head (the vector count
    // and the segment's payload length both moved). Nothing else.
    var carried = d.missing.map(function (i) { return units[i]; });
    var records = carried.filter(function (u) { return u.kind === semdelta.UNIT_RECORD; });
    var heads = carried.filter(function (u) { return u.kind === semdelta.UNIT_HEAD; });
    assertEqual(records.length, 4, 'records carried (3 added + 1 modified)');
    assertEqual(heads.length, 1, 'head units carried');
    assertEqual(carried.length, 5, 'units carried in total');

    report.demoRecords = {
      slabBytes: slabBytes,
      recordBytes: d.bytesToSend,
      records: records.length
    };
    return d.bytesToSend + ' bytes for ' + records.length + ' records + head, against a ' +
      slabBytes + '-byte slab (' + (slabBytes / d.bytesToSend).toFixed(1) + '× less)';
  });

  // --- byte-exact reconstruction ------------------------------------------

  test('reconstruction from a semantic delta is byte-exact, verified with node:crypto', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    var payload = semdelta.buildSemanticPayload(target, d.missing, {
      parser: parser, base: inv, units: units
    });
    var applied = semdelta.applySemanticDelta(demo, payload, { parser: parser });
    assertEqual(applied.bytes.length, target.length, 'reconstructed length');
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');
    assertEqual(applied.fromDelta + applied.fromBase, target.length, 'accounting adds up');
    return target.length + ' bytes rebuilt, ' + applied.fromDelta + ' from the delta and ' +
      applied.fromBase + ' from the base; sha256 ' + sha256(target).slice(0, 16) + '…';
  });

  test('reconstruction survives every segment after the Vec slab moving', function () {
    // Adding records grows the Vec segment, so the Witness and trailing
    // Manifest sit at different offsets in the target than in the base. They
    // must still be recognised, which they only are because matching is by
    // content hash rather than by position.
    var target = ctx.demoEdited;
    var baseSpans = delta.spanPlan(demo, { parser: parser });
    var targetSpans = delta.spanPlan(target, { parser: parser });
    assert(targetSpans[2].offset !== baseSpans[2].offset, 'the witness segment moved');

    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    var moved = units.filter(function (u, i) {
      return u.type === 0x0a && d.present.indexOf(i) >= 0;
    });
    assertEqual(moved.length, 1, 'the moved witness segment was matched, not resent');
    var applied = semdelta.applySemanticDelta(demo, semdelta.buildSemanticPayload(
      target, d.missing, { parser: parser, base: inv, units: units }), { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');
    return 'witness moved ' + baseSpans[2].offset + ' → ' + targetSpans[2].offset +
      ' and was taken from the base';
  });

  test('a delta whose units the base cannot supply is refused rather than half-applied', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    // Carry one fewer unit than the diff says is missing, and leave the delta
    // unbound so the base check does not fire first.
    var payload = semdelta.buildSemanticPayload(target, d.missing.slice(1), {
      parser: parser, hashBytes: inv.hashBytes, units: units
    });
    assertThrows('missing-unit', function () {
      semdelta.applySemanticDelta(demo, payload, { parser: parser });
    }, 'an unsatisfiable delta');
    return 'refused before allocating the output';
  });

  // --- base binding --------------------------------------------------------

  test('a delta bound to another base is refused before the base is even scanned', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    var payload = semdelta.buildSemanticPayload(target, d.missing, {
      parser: parser, base: inv, units: units
    });
    assertEqual(semdelta.parseSemanticPayload(payload).baseRoot, inv.root, 'delta is bound to the base');

    // A parser that throws if it is ever called. If the base check runs first —
    // as it must, before any scan, hash index or output allocation — this
    // parser is never reached, and the rejection is base-mismatch rather than
    // the parser's own error.
    var wrongBase = new Uint8Array(demo.length);
    wrongBase.set(demo);
    wrongBase[wrongBase.length - 1] ^= 0xff;
    var poisoned = { name: 'poisoned', scan: function () { throw new Error('the base was scanned'); } };
    var err = assertThrows('base-mismatch', function () {
      semdelta.applySemanticDelta(wrongBase, payload, { parser: poisoned });
    }, 'a mismatched base');
    assert(/computed against/.test(err.message), 'the message names both digests');
    return err.message;
  });

  test('an unbound delta applies to any base that can supply its units', function () {
    var target = ctx.demoEdited;
    var units = semdelta.semanticPlan(target, { parser: parser });
    // Every unit carried: a full transfer expressed as an unbound delta.
    var all = units.map(function (_, i) { return i; });
    var payload = semdelta.buildSemanticPayload(target, all, { parser: parser, units: units });
    assertEqual(semdelta.parseSemanticPayload(payload).baseRoot, null, 'unbound');
    var applied = semdelta.applySemanticDelta(null, payload, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed from nothing');
    assertEqual(applied.fromBase, 0, 'nothing came from a base');
    return 'cold start: ' + payload.length + ' bytes carried the whole ' + target.length + '-byte container';
  });

  // --- inventory encoding ---------------------------------------------------

  test('a semantic inventory round-trips through its binary encoding', function () {
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var encoded = core.b64uEncode(semdelta.encodeSemanticInventory(inv));
    var back = semdelta.decodeSemanticInventory(encoded);
    assertEqual(back.size, inv.size, 'size');
    assertEqual(back.root, inv.root, 'root');
    assertEqual(back.hashBytes, inv.hashBytes, 'hash width');
    assertEqual(back.units.length, inv.units.length, 'unit count');
    assertEqual(back.spans.length, inv.spans.length, 'span count');
    for (var i = 0; i < inv.units.length; i++) {
      assertEqual(back.units[i].hash, inv.units[i].hash, 'unit ' + i + ' hash');
      assertEqual(back.units[i].length, inv.units[i].length, 'unit ' + i + ' length');
      assertEqual(back.units[i].kind, inv.units[i].kind, 'unit ' + i + ' kind');
    }
    coversExactly(back.units, back.size, 'decoded unit');
    report.demoInventoryBytes = encoded.length;
    report.demoUnits = inv.units.length;
    return inv.units.length + ' units + ' + inv.spans.length + ' spans → ' +
      encoded.length + ' base64url characters';
  });

  test('a semantic inventory is also a valid delta.js span inventory', function () {
    // This is what makes the span-versus-semantic comparison honest: a receiver
    // publishing units still publishes whole-segment hashes, so a span delta
    // against it is a real span delta and not a disguised full transfer.
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var spans = delta.spanPlan(demo, { parser: parser });
    var d = delta.diff({ spans: spans }, inv);
    assertEqual(d.missing.length, 0, 'the receiver holds every span of its own container');
    return d.present.length + ' spans matched through the semantic inventory';
  });

  // --- encrypted inventory --------------------------------------------------

  test('a sealed inventory round-trips under a real crypto.js session', function () {
    return makeSessionPair().then(function (pair) {
      var inv = semdelta.semanticInventory(demo, { parser: parser });
      return semdelta.sealInventory(inv, pair.initiator, { context: 'rvqr/inventory' })
        .then(function (sealed) {
          assert(typeof sealed === 'string', 'sealed to text');
          var plain = core.b64uEncode(semdelta.encodeSemanticInventory(inv));
          // The plaintext must not be recoverable from the ciphertext by eye.
          assert(sealed.indexOf(plain.slice(0, 24)) < 0, 'the plaintext is not visible in the ciphertext');
          return semdelta.openInventory(sealed, pair.responder, { context: 'rvqr/inventory' })
            .then(function (back) {
              assertEqual(back.root, inv.root, 'root survived');
              assertEqual(back.units.length, inv.units.length, 'unit count survived');
              assertEqual(back.units[3].hash, inv.units[3].hash, 'a unit hash survived');
              return 'inventory of ' + inv.units.length + ' units sealed to ' +
                sealed.length + ' characters and opened intact';
            });
        });
    });
  });

  test('a tampered ciphertext is rejected', function () {
    return makeSessionPair().then(function (pair) {
      var inv = semdelta.semanticInventory(demo, { parser: parser });
      return semdelta.sealInventory(inv, pair.initiator, { context: 'rvqr/inventory' })
        .then(function (sealed) {
          var bytes = core.b64uDecode(sealed);
          // Flip a bit well inside the ciphertext, past the counter prefix.
          bytes[40] ^= 0x01;
          return assertRejects('inventory-auth-failed',
            semdelta.openInventory(core.b64uEncode(bytes), pair.responder, { context: 'rvqr/inventory' }),
            'a flipped ciphertext bit'
          ).then(function (e) { return e.message; });
        });
    });
  });

  test('a tampered authenticated-data context is rejected', function () {
    return makeSessionPair().then(function (pair) {
      var inv = semdelta.semanticInventory(demo, { parser: parser });
      return semdelta.sealInventory(inv, pair.initiator, { context: 'rvqr/inventory' })
        .then(function (sealed) {
          // Byte-identical ciphertext, opened in a position that expects a
          // different kind of message. The AEAD binds that context, so this is
          // a rejection rather than a silently misinterpreted inventory.
          return assertRejects('inventory-auth-failed',
            semdelta.openInventory(sealed, pair.responder, { context: 'rvqr/manifest' }),
            'a mismatched AAD context'
          ).then(function (e) { return e.message; });
        });
    });
  });

  test('a truncated sealed inventory is rejected without throwing out of the promise', function () {
    return makeSessionPair().then(function (pair) {
      var inv = semdelta.semanticInventory(demo, { parser: parser });
      return semdelta.sealInventory(inv, pair.initiator, { context: 'c' }).then(function (sealed) {
        var bytes = core.b64uDecode(sealed).subarray(0, 20);
        return assertRejects('inventory-auth-failed',
          semdelta.openInventory(core.b64uEncode(bytes), pair.responder, { context: 'c' }),
          'a truncated record'
        ).then(function () { return 'truncated to 20 bytes, refused cleanly'; });
      });
    });
  });

  test('padding coarsens the size an observer sees, and the true length still round-trips', function () {
    return makeSessionPair().then(function (pair) {
      var inv = semdelta.semanticInventory(demo, { parser: parser });
      return Promise.all([
        semdelta.sealInventory(inv, pair.initiator, { context: 'p' }),
        semdelta.sealInventory(inv, pair.initiator, { context: 'p', pad: 4096 })
      ]).then(function (both) {
        var bare = core.b64uDecode(both[0]).length;
        var padded = core.b64uDecode(both[1]).length;
        assert(padded > bare, 'padding costs bytes: ' + padded + ' vs ' + bare);
        assertEqual((padded - 8 - 16) % 4096, 0, 'the padded plaintext is a multiple of the bucket');
        return semdelta.openInventory(both[1], pair.responder, { context: 'p' }).then(function (back) {
          assertEqual(back.units.length, inv.units.length, 'the true length survived padding');
          return bare + ' bytes bare, ' + padded + ' bytes padded to a 4096-byte bucket';
        });
      });
    });
  });

  // --- the span-versus-semantic choice --------------------------------------

  test('the semantic delta is chosen when it is smaller, and the figures are reported', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var choice = semdelta.chooseDelta(target, inv, { parser: parser });
    assertEqual(choice.chosen, 'semantic', 'chosen delta');
    assert(choice.semanticBytes < choice.spanBytes,
      'semantic ' + choice.semanticBytes + ' should beat span ' + choice.spanBytes);
    assertEqual(choice.bytes, choice.semanticBytes, 'the reported size is the chosen one');
    assertEqual(choice.payload, choice.semanticPayload, 'the returned payload is the chosen one');
    assert(choice.reason.indexOf('smaller') >= 0, 'the reason says which won');
    var applied = semdelta.applyChosen(demo, choice, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'the chosen payload reconstructs');

    report.demoChoice = choice;
    return choice.chosen + ': ' + choice.semanticBytes + ' semantic vs ' + choice.spanBytes +
      ' span vs ' + choice.fullBytes + ' full';
  });

  test('the span delta is chosen when the unit table costs more than it saves', function () {
    // Halving the dimension rewrites every record, so a semantic delta carries
    // the whole slab *and* a table describing it record by record. A span delta
    // carries the same bytes with a four-row table. The span delta wins, and
    // this module has to notice rather than reaching for the finer tool.
    var narrowRecords = [];
    for (var i = 0; i < 24; i++) narrowRecords.push(vecRecord(i + 1, 8, i));
    var narrow = replaceVecPayload(demo, vecPayload(8, narrowRecords, 0));

    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var choice = semdelta.chooseDelta(narrow, inv, { parser: parser });
    assertEqual(choice.chosen, 'span', 'chosen delta');
    assert(choice.spanBytes < choice.semanticBytes,
      'span ' + choice.spanBytes + ' should beat semantic ' + choice.semanticBytes);
    assertEqual(choice.payload, choice.spanPayload, 'the returned payload is the span one');
    assert(/table costs/.test(choice.reason), 'the reason explains the table cost: ' + choice.reason);
    var applied = semdelta.applyChosen(demo, choice, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(narrow), 'the chosen payload reconstructs');
    return 'span ' + choice.spanBytes + ' < semantic ' + choice.semanticBytes +
      ' (' + choice.unitCount + '-unit table costs ' + choice.tableBytes + ' bytes)';
  });

  test('a cold start picks the span delta, because a unit table buys nothing when everything is sent', function () {
    var choice = semdelta.chooseDelta(demo, null, { parser: parser });
    assertEqual(choice.chosen, 'span', 'chosen delta');
    assertEqual(choice.spanDiff.missing.length, choice.spanCount, 'every span is missing');
    assertEqual(choice.unitDiff.missing.length, choice.unitCount, 'every unit is missing');
    var applied = semdelta.applyChosen(null, choice, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(demo), 'the cold-start payload reconstructs');
    return 'span ' + choice.spanBytes + ' vs semantic ' + choice.semanticBytes + ' for a full transfer';
  });

  test('applyChosen dispatches on the payload magic, not on the label', function () {
    var target = ctx.demoEdited;
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var choice = semdelta.chooseDelta(target, inv, { parser: parser });
    // A result whose label says one thing and whose payload is the other. The
    // payload is what gets read, so the reconstruction is still correct.
    var mislabelled = { chosen: 'span', payload: choice.semanticPayload };
    var a = semdelta.applyChosen(demo, mislabelled, { parser: parser });
    assertEqual(sha256(a.bytes), sha256(target), 'semantic payload read as semantic');
    var b = semdelta.applyChosen(demo, choice.spanPayload, { parser: parser });
    assertEqual(sha256(b.bytes), sha256(target), 'span payload read as span');
    assertThrows('bad-delta-magic', function () {
      semdelta.applyChosen(demo, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { parser: parser });
    }, 'a payload of neither kind');
    return 'both payload kinds read correctly from an identical call';
  });

  // --- WASM section and function boundaries --------------------------------

  test('a WASM segment decomposes on section boundaries and inside the Code section', function () {
    var container = ctx.wasmContainer;
    var rows = semdelta.decompositionReport(container, { parser: parser });
    var wasm = rows.filter(function (r) { return r.typeName === 'WASM'; })[0];
    assert(wasm && wasm.decomposed, 'the WASM segment was not decomposed: ' + (wasm && wasm.reason));

    var sections = walkWasmSections(container, 64, container.length);
    assert(sections.length >= 8, 'expected a real module, saw ' + sections.length + ' sections');
    var code = sections.filter(function (s) { return s.id === 10; })[0];
    assert(code, 'the module has a Code section');
    // More units than sections is the whole point: the Code section is split
    // into function bodies rather than carried whole.
    assert(wasm.units > sections.length,
      wasm.units + ' units should exceed ' + sections.length + ' sections');

    var units = semdelta.semanticPlan(container, { parser: parser });
    coversExactly(units, container.length, 'unit');
    return sections.length + ' sections, Code is ' + code.size + ' of ' +
      ctx.wasmModule.length + ' module bytes → ' + wasm.units + ' units';
  });

  test('one changed WASM function body invalidates that body, not the module', function () {
    var base = ctx.wasmContainer;
    var sections = walkWasmSections(base, 64, base.length);
    var code = sections.filter(function (s) { return s.id === 10; })[0];
    // Flip a byte deep inside the Code section. Lengths do not move, so the
    // module stays structurally identical and only one body's bytes differ.
    var target = new Uint8Array(base);
    target[code.contentsAt + Math.floor(code.size / 2)] ^= 0xff;

    var inv = semdelta.semanticInventory(base, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    assert(d.bytesToSend < code.size / 4,
      'sent ' + d.bytesToSend + ' bytes for a one-byte change in a ' + code.size + '-byte Code section');

    var payload = semdelta.buildSemanticPayload(target, d.missing, {
      parser: parser, base: inv, units: units
    });
    var applied = semdelta.applySemanticDelta(base, payload, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');

    var spanChoice = semdelta.chooseDelta(target, inv, { parser: parser });
    report.wasm = {
      module: ctx.wasmModule.length,
      codeSection: code.size,
      units: units.length,
      sent: d.bytesToSend,
      semantic: spanChoice.semanticBytes,
      span: spanChoice.spanBytes,
      full: target.length
    };
    return d.missing.length + ' units (' + d.bytesToSend + ' bytes) for a byte flipped in a ' +
      code.size + '-byte Code section; whole delta ' + spanChoice.semanticBytes +
      ' vs ' + spanChoice.spanBytes + ' span';
  });

  // --- RVCOW / agenticow ----------------------------------------------------

  test('a COW branch sends the cluster-map entries that flipped, not the map', function () {
    // RVCOW (in-tree) and agenticow (the published npm surface) are the same
    // mechanism. A child starts with every cluster as ParentRef and flips
    // entries to LocalOffset as it writes; a delta between two branches should
    // move the flipped entries.
    var parentMap = cowMapPayload(2000, '../parent.rvf', {});
    var childLocal = {};
    // Clusters 17 and 18 share a block, 900 and 901 share another, 1500 is a
    // third: five writes that touch three of the map's 125 blocks.
    [17, 18, 900, 901, 1500].forEach(function (i) { childLocal[i] = true; });
    var childMap = cowMapPayload(2000, '../parent.rvf', childLocal);

    var base = makeContainer([{ type: semdelta.TYPE_COWMAP, payload: parentMap }]);
    var target = makeContainer([{ type: semdelta.TYPE_COWMAP, payload: childMap }]);
    assertEqual(base.length, target.length, 'branching does not resize the map');

    var rows = semdelta.decompositionReport(base, { parser: parser });
    assert(rows[0].decomposed, 'the CowMap did not decompose: ' + rows[0].reason);

    var inv = semdelta.semanticInventory(base, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    assertEqual(d.missing.length, 3, 'blocks carried');
    assertEqual(d.bytesToSend, 3 * semdelta.COW_BLOCK_ENTRIES * 9, 'bytes carried');
    assert(d.bytesToSend < target.length / 20,
      'sent ' + d.bytesToSend + ' of ' + target.length + ' bytes');

    var payload = semdelta.buildSemanticPayload(target, d.missing, {
      parser: parser, base: inv, units: units
    });
    var applied = semdelta.applySemanticDelta(base, payload, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');

    report.cow = { size: target.length, units: units.length, sent: d.bytesToSend, payload: payload.length };
    return '5 of 2000 clusters flipped → ' + d.missing.length + ' blocks, ' + d.bytesToSend +
      ' bytes of a ' + target.length + '-byte map (delta ' + payload.length + ' bytes)';
  });

  test('a membership bitmap sends the blocks whose bits moved', function () {
    var base = makeContainer([{ type: semdelta.TYPE_MEMBERSHIP, payload: membershipPayload(40000, []) }]);
    var target = makeContainer([{
      type: semdelta.TYPE_MEMBERSHIP, payload: membershipPayload(40000, [11, 12, 30000])
    }]);
    assertEqual(base.length, target.length, 'clearing bits does not resize the bitmap');

    var inv = semdelta.semanticInventory(base, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    assertEqual(d.missing.length, 2, 'blocks carried (ids 11 and 12 share a block, 30000 is elsewhere)');
    assertEqual(d.bytesToSend, 2 * semdelta.MEMBERSHIP_BLOCK_BYTES, 'bytes carried');

    var payload = semdelta.buildSemanticPayload(target, d.missing, {
      parser: parser, base: inv, units: units
    });
    assertEqual(sha256(semdelta.applySemanticDelta(base, payload, { parser: parser }).bytes),
      sha256(target), 'reconstructed digest');
    return '3 of 40000 membership bits moved → ' + d.bytesToSend + ' bytes of a ' +
      target.length + '-byte segment';
  });

  test('Refcount segments are left opaque, deliberately', function () {
    // rvf-runtime never reads type 0x21, and the two rvf-cli writers disagree
    // with each other about its layout. A decomposer built on that would be
    // built on nothing.
    var container = makeContainer([{ type: 0x21, payload: rndBytes(2048) }]);
    var rows = semdelta.decompositionReport(container, { parser: parser });
    assertEqual(rows.length, 1, 'one segment');
    assert(!rows[0].decomposed, 'REFCOUNT should stay whole');
    assertEqual(rows[0].units, 1, 'one unit');
    return rows[0].typeName + ': ' + rows[0].reason;
  });

  // --- hostile input --------------------------------------------------------

  test('hostile segment interiors degrade to whole spans instead of throwing', function () {
    var cases = [
      // A Vec header claiming 65535 records of 16 dimensions in 200 bytes.
      { name: 'absurd vector count', bytes: makeContainer([{
        type: semdelta.TYPE_VEC, payload: absurdVec(16, 65535, 200) }]) },
      // dim × count whose product overflows any real segment: 65535 × 65535
      // records of 262148 bytes each is about 1.7e10 bytes.
      { name: 'dim/count product past the segment', bytes: makeContainer([{
        type: semdelta.TYPE_VEC, payload: absurdVec(65535, 65535, 4096) }]) },
      // A well-formed header whose records are cut off halfway.
      { name: 'truncated slab', bytes: truncatedSlab() },
      // A Vec segment with no payload at all beyond its six-byte header.
      { name: 'empty slab', bytes: makeContainer([{
        type: semdelta.TYPE_VEC, payload: absurdVec(16, 4, 6) }]) },
      // A CowMap whose parent path claims the whole address space.
      { name: 'cowmap parent length', bytes: makeContainer([{
        type: semdelta.TYPE_COWMAP, payload: hostileCowMap(0xffffffff, 100) }]) },
      // A CowMap whose map length disagrees with its payload.
      { name: 'cowmap map length', bytes: makeContainer([{
        type: semdelta.TYPE_COWMAP, payload: hostileCowMap(8, 0xfffffff) }]) },
      // A Membership header whose filter runs past the payload.
      { name: 'membership filter size', bytes: makeContainer([{
        type: semdelta.TYPE_MEMBERSHIP, payload: hostileMembership(0xffffff) }]) },
      // A WASM preamble followed by a section whose size is a six-byte LEB.
      { name: 'wasm varuint overrun', bytes: makeContainer([{
        type: semdelta.TYPE_WASM, payload: hostileWasm() }]) },
      // Random bytes claiming to be each decomposable type.
      { name: 'random Vec payload', bytes: makeContainer([{ type: semdelta.TYPE_VEC, payload: rndBytes(512) }]) },
      { name: 'random Wasm payload', bytes: makeContainer([{ type: semdelta.TYPE_WASM, payload: rndBytes(512) }]) },
      { name: 'random CowMap payload', bytes: makeContainer([{ type: semdelta.TYPE_COWMAP, payload: rndBytes(512) }]) },
      { name: 'random Membership payload', bytes: makeContainer([{ type: semdelta.TYPE_MEMBERSHIP, payload: rndBytes(512) }]) }
    ];

    cases.forEach(function (c) {
      var units, rows;
      try {
        units = semdelta.semanticPlan(c.bytes);
        rows = semdelta.decompositionReport(c.bytes);
      } catch (e) {
        throw new Error(c.name + ' threw: ' + e.message);
      }
      coversExactly(units, c.bytes.length, c.name + ' unit');
      var spans = delta.spanPlan(c.bytes);
      assertEqual(units.length, spans.length, c.name + ' fell back to whole spans');
      rows.forEach(function (r) {
        assert(!r.decomposed, c.name + ' should not have decomposed ' + r.typeName);
      });
      // A round trip still has to be byte-exact over a hostile container: the
      // fallback is a real transfer path, not a diagnostic.
      var all = units.map(function (_, i) { return i; });
      var applied = semdelta.applySemanticDelta(null,
        semdelta.buildSemanticPayload(c.bytes, all, { units: units }));
      assertEqual(sha256(applied.bytes), sha256(c.bytes), c.name + ' round trip');
    });
    return cases.length + ' hostile interiors declined cleanly and still round-tripped';
  });

  test('a hostile semantic delta payload is refused before it allocates', function () {
    var units = semdelta.semanticPlan(demo, { parser: parser });
    var good = semdelta.buildSemanticPayload(demo, [0], { parser: parser, units: units });

    assertThrows('bad-delta', function () {
      semdelta.parseSemanticPayload(good.subarray(0, 40));
    }, 'shorter than the header');

    var wrongMagic = new Uint8Array(good);
    wrongMagic[0] ^= 0xff;
    assertThrows('bad-delta-magic', function () {
      semdelta.parseSemanticPayload(wrongMagic);
    }, 'wrong magic');

    var wrongVersion = new Uint8Array(good);
    wrongVersion[4] = 9;
    assertThrows('bad-delta-version', function () {
      semdelta.parseSemanticPayload(wrongVersion);
    }, 'unknown version');

    // A ninety-byte payload declaring a quarter of a million units. The table
    // is bounded against the bytes present before anything is indexed.
    var huge = new Uint8Array(semdelta.SEM_DELTA_HEADER + 2);
    huge.set(semdelta.SEM_DELTA_MAGIC, 0);
    huge[4] = 1; huge[5] = 8;
    writeU32(huge, 8, 200000);
    writeU32(huge, 12, 1024);
    assertThrows('bad-delta', function () { semdelta.parseSemanticPayload(huge); }, 'huge unit count');

    // Past the ceiling entirely.
    var pastCeiling = new Uint8Array(semdelta.SEM_DELTA_HEADER + 2);
    pastCeiling.set(semdelta.SEM_DELTA_MAGIC, 0);
    pastCeiling[4] = 1; pastCeiling[5] = 8;
    writeU32(pastCeiling, 8, semdelta.MAX_UNITS + 1);
    writeU32(pastCeiling, 12, 1024);
    assertThrows('too-many-units', function () {
      semdelta.parseSemanticPayload(pastCeiling);
    }, 'unit count past the ceiling');

    // A container size past the ceiling.
    var hugeSize = new Uint8Array(good);
    writeU32(hugeSize, 12, 0xffffffff);
    assertThrows('container-too-large', function () {
      semdelta.parseSemanticPayload(hugeSize);
    }, 'declared container size');

    // A unit table that does not cover the declared size.
    var shortCover = new Uint8Array(good);
    writeU32(shortCover, 12, demo.length + 64);
    assertThrows('bad-delta', function () {
      semdelta.parseSemanticPayload(shortCover);
    }, 'units that do not cover the container');

    return '7 malformed payloads refused with a reason each';
  });

  test('a hostile semantic inventory is refused before it allocates', function () {
    var inv = semdelta.semanticInventory(demo, { parser: parser });
    var encoded = semdelta.encodeSemanticInventory(inv);

    assertThrows('bad-inventory-encoding', function () {
      semdelta.decodeSemanticInventory('not base64!!!');
    }, 'invalid encoding');

    assertThrows('bad-inventory', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(encoded.subarray(0, 30)));
    }, 'shorter than the header');

    var wrongMagic = new Uint8Array(encoded);
    wrongMagic[0] ^= 0xff;
    assertThrows('bad-inventory-magic', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(wrongMagic));
    }, 'wrong magic');

    var wrongVersion = new Uint8Array(encoded);
    wrongVersion[4] = 7;
    assertThrows('bad-inventory-version', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(wrongVersion));
    }, 'unknown version');

    var lyingCount = new Uint8Array(encoded);
    writeU32(lyingCount, 8, 100000);
    assertThrows('bad-inventory', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(lyingCount));
    }, 'a unit count the bytes do not support');

    var pastCeiling = new Uint8Array(encoded);
    writeU32(pastCeiling, 8, semdelta.MAX_UNITS + 1);
    assertThrows('too-many-units', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(pastCeiling));
    }, 'a unit count past the ceiling');

    var wrongSize = new Uint8Array(encoded);
    writeU32(wrongSize, 12, demo.length + 1);
    assertThrows('bad-inventory', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(wrongSize));
    }, 'a size the tables do not cover');

    var badHashWidth = new Uint8Array(encoded);
    badHashWidth[5] = 200;
    assertThrows('bad-inventory', function () {
      semdelta.decodeSemanticInventory(core.b64uEncode(badHashWidth));
    }, 'an impossible hash width');

    return '8 malformed inventories refused with a reason each';
  });

  test('a delta computed with a poisoned unit index is refused at build time', function () {
    var units = semdelta.semanticPlan(demo, { parser: parser });
    assertThrows('bad-unit-index', function () {
      semdelta.buildSemanticPayload(demo, [units.length + 5], { parser: parser, units: units });
    }, 'an out-of-range unit index');
    assertThrows('bad-unit-index', function () {
      semdelta.buildSemanticPayload(demo, [-1], { parser: parser, units: units });
    }, 'a negative unit index');
    assertThrows('bad-unit-index', function () {
      semdelta.buildSemanticPayload(demo, [1.5], { parser: parser, units: units });
    }, 'a non-integer unit index');
    return '3 poisoned indices refused';
  });

  // --- large synthetic container -------------------------------------------

  test('a megabyte-scale container with eight changed vectors sends kilobytes', function () {
    var base = ctx.large;
    var target = ctx.largeEdited;
    var inv = semdelta.semanticInventory(base, { parser: parser });
    var choice = semdelta.chooseDelta(target, inv, { parser: parser });
    assertEqual(choice.chosen, 'semantic', 'chosen delta');

    var applied = semdelta.applyChosen(base, choice, { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');

    report.large = {
      size: target.length,
      units: choice.unitCount,
      spans: choice.spanCount,
      semantic: choice.semanticBytes,
      span: choice.spanBytes,
      full: choice.fullBytes,
      tableBytes: choice.tableBytes,
      payloadBytes: choice.unitDiff.bytesToSend,
      inventoryBytes: core.b64uEncode(semdelta.encodeSemanticInventory(inv)).length
    };
    return choice.semanticBytes + ' semantic vs ' + choice.spanBytes + ' span vs ' +
      choice.fullBytes + ' full (' + (choice.spanBytes / choice.semanticBytes).toFixed(1) +
      '× less than span, ' + (choice.fullBytes / choice.semanticBytes).toFixed(1) + '× less than full)';
  });

  test('the large container reconstructs byte-exactly across every changed segment type', function () {
    var base = ctx.large;
    var target = ctx.largeEdited;
    var vd = semdelta.vectorDiff(base, target, { parser: parser });
    assertEqual(vd.changed.length, 8, 'vector records changed');
    assertEqual(vd.added.length, 0, 'none added');
    assertEqual(vd.removed.length, 0, 'none removed');

    var inv = semdelta.semanticInventory(base, { parser: parser });
    var units = semdelta.semanticPlan(target, { parser: parser });
    var d = semdelta.diffUnits({ units: units }, inv);
    var kinds = Object.keys(d.byKind).filter(function (k) { return d.byKind[k].sent > 0; });
    assert(kinds.indexOf('RECORD') >= 0, 'records were carried');
    assert(kinds.indexOf('BLOCK') >= 0, 'cow/membership blocks were carried');
    assert(kinds.indexOf('SECTION') >= 0, 'a wasm section was carried');

    var applied = semdelta.applySemanticDelta(base, semdelta.buildSemanticPayload(
      target, d.missing, { parser: parser, base: inv, units: units }), { parser: parser });
    assertEqual(sha256(applied.bytes), sha256(target), 'reconstructed digest');
    return kinds.sort().join(', ') + ' carried; ' + d.missing.length + ' of ' +
      units.length + ' units, ' + d.bytesToSend + ' bytes';
  });

  test('a sealed inventory for the large container still opens, and its size still leaks its scale', function () {
    return makeSessionPair().then(function (pair) {
      var small = semdelta.semanticInventory(demo, { parser: parser });
      var big = semdelta.semanticInventory(ctx.large, { parser: parser });
      return Promise.all([
        semdelta.sealInventory(small, pair.initiator, { context: 'scale' }),
        semdelta.sealInventory(big, pair.initiator, { context: 'scale' })
      ]).then(function (sealed) {
        var smallBytes = core.b64uDecode(sealed[0]).length;
        var bigBytes = core.b64uDecode(sealed[1]).length;
        // This is the leak the docblock warns about, asserted rather than
        // asserted away: encryption hides what a device holds, not how much.
        assert(bigBytes > smallBytes * 10,
          'the sealed sizes should differ by scale: ' + smallBytes + ' vs ' + bigBytes);
        return semdelta.openInventory(sealed[1], pair.responder, { context: 'scale' })
          .then(function (back) {
            assertEqual(back.root, big.root, 'the large inventory opened intact');
            report.sealed = { small: smallBytes, large: bigBytes };
            return 'a ' + small.units.length + '-unit inventory seals to ' + smallBytes +
              ' bytes, a ' + big.units.length + '-unit one to ' + bigBytes +
              ' — the content is hidden, the scale is not';
          });
      });
    });
  });
}

// --- Hostile fixtures --------------------------------------------------------

/** A Vec payload whose header lies about how many records follow it. */
function absurdVec(dim, count, payloadBytes) {
  var out = new Uint8Array(Math.max(payloadBytes, 6));
  out[0] = dim & 0xff; out[1] = (dim >>> 8) & 0xff;
  out[2] = count & 0xff; out[3] = (count >>> 8) & 0xff;
  for (var i = 6; i < out.length; i++) out[i] = (i * 13) & 0xff;
  return out;
}

/** A well-formed slab whose last record is cut in half. */
function truncatedSlab() {
  var dim = 16, stride = 8 + dim * 4;
  var records = [];
  for (var i = 0; i < 8; i++) records.push(vecRecord(i + 1, dim, i));
  var full = vecPayload(dim, records, 0);
  // Claim eight records, supply seven and a half.
  return makeContainer([{ type: 0x01, payload: full.subarray(0, full.length - stride / 2) }]);
}

function hostileCowMap(parentLen, mapLen) {
  var out = new Uint8Array(200);
  out.set([0x4d, 0x43, 0x56, 0x52], 0);
  out[4] = 1;
  out[6] = 0;
  writeU32(out, 0x49, parentLen);
  writeU32(out, 0x4d, mapLen);
  return out;
}

function hostileMembership(filterSize) {
  var out = new Uint8Array(96 + 1024);
  out.set([0x42, 0x4d, 0x56, 0x52], 0);
  out[4] = 1;
  out[6] = 0;
  writeU32(out, 0x18, 96);
  writeU32(out, 0x20, filterSize);
  return out;
}

/** A WASM preamble followed by a section size encoded in six continuation bytes. */
function hostileWasm() {
  var out = new Uint8Array(64);
  out.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], 0);
  out[8] = 10; // Code section
  for (var i = 9; i < 20; i++) out[i] = 0x80; // continuation forever
  return out;
}

/** Swaps a container's first Vec segment payload for another, fixing the header. */
function replaceVecPayload(bytes, payload) {
  var span = delta.spanPlan(bytes).filter(function (s) { return s.type === 0x01; })[0];
  var head = bytes.slice(span.offset, span.offset + 64);
  writeU32(head, 16, payload.length);
  head[20] = 0; head[21] = 0; head[22] = 0; head[23] = 0;
  for (var h = 0x28; h < 0x38; h++) head[h] = (head[h] + 1) & 0xff;
  var out = new Uint8Array(bytes.length - span.length + 64 + payload.length);
  out.set(bytes.subarray(0, span.offset), 0);
  out.set(head, span.offset);
  out.set(payload, span.offset + 64);
  out.set(bytes.subarray(span.offset + span.length), span.offset + 64 + payload.length);
  return out;
}

// --- Fixtures ----------------------------------------------------------------

/**
 * The realistic case: a container with everything this module knows how to look
 * inside. A 2000-vector slab at 128 dimensions, the real microkernel as a WASM
 * component, a COW cluster map, a membership bitmap, and manifests either side.
 */
function buildLargeContainer(wasmModule) {
  var dim = 128;
  var records = [];
  for (var i = 0; i < 2000; i++) records.push(vecRecord(i + 1, dim, i));
  return makeContainer([
    { type: 0x05, payload: rndBytes(98) },                       // Manifest
    { type: 0x01, payload: vecPayload(dim, records, 0) },        // Vec
    { type: 0x10, payload: wasmModule },                         // Wasm
    { type: 0x20, payload: cowMapPayload(4000, '../base.rvf', {}) }, // CowMap
    { type: 0x22, payload: membershipPayload(64000, []) },       // Membership
    { type: 0x0a, payload: rndBytes(68) },                       // Witness
    { type: 0x05, payload: rndBytes(148) }                       // Manifest
  ]);
}

/** Eight changed vectors, one flipped COW cluster, three membership bits, one wasm byte. */
function editLargeContainer(base) {
  var out = new Uint8Array(base);
  var spans = delta.spanPlan(out);
  var vecSpan = spans.filter(function (s) { return s.type === 0x01; })[0];
  var slab = semdelta.readVectorSlab(out, vecSpan);
  [3, 400, 401, 402, 900, 1500, 1501, 1999].forEach(function (i) {
    var at = slab.records[i].offset;
    for (var b = 8; b < slab.stride; b += 7) out[at + b] ^= 0xa5;
  });

  var cowSpan = spans.filter(function (s) { return s.type === 0x20; })[0];
  // Flip one cluster entry from ParentRef to LocalOffset.
  var mapAt = cowSpan.offset + 64 + 81 + '../base.rvf'.length + 5;
  out[mapAt + 300 * 9] = 2;

  var memSpan = spans.filter(function (s) { return s.type === 0x22; })[0];
  out[memSpan.offset + 64 + 96 + 500] &= ~0x07;

  var wasmSpan = spans.filter(function (s) { return s.type === 0x10; })[0];
  out[wasmSpan.offset + 64 + Math.floor((wasmSpan.length - 64) / 2)] ^= 0xff;
  return out;
}

// --- Runner ------------------------------------------------------------------

function runQueue() {
  return queue.reduce(function (chain, entry) {
    return chain.then(function () {
      var started = Date.now();
      return Promise.resolve()
        .then(entry.fn)
        .then(function (detail) {
          if (detail && detail.__skip) {
            results.push({ name: entry.name, skipped: true, detail: detail.__skip, ms: Date.now() - started });
            return;
          }
          results.push({ name: entry.name, ok: true, detail: detail || '', ms: Date.now() - started });
        }, function (e) {
          results.push({
            name: entry.name, ok: false,
            detail: (e && e.message ? e.message : String(e)), ms: Date.now() - started
          });
        });
    });
  }, Promise.resolve());
}

function main() {
  var report = {};
  var wasmBytes = fs.readFileSync(DEMO_WASM);
  var wasmModule = new Uint8Array(wasmBytes);
  var demo = new Uint8Array(fs.readFileSync(DEMO_RVF));

  return WebAssembly.compile(wasmBytes).then(function (mod) {
    return WebAssembly.instantiate(mod, {});
  }).then(function (instance) {
    var large = buildLargeContainer(wasmModule);
    var ctx = {
      demo: demo,
      // The edit under test: one vector modified, one removed, three added.
      demoEdited: rewriteVec(demo, function (records, slab) {
        records[3] = records[3].slice();
        records[3][10] ^= 0xff;          // id 4 changes
        records.splice(7, 1);            // id 8 disappears
        for (var n = 0; n < 3; n++) {
          records.push(vecRecord(100 + n, slab.dim, 40 + n));
        }
        return records;
      }),
      wasmModule: wasmModule,
      wasmContainer: makeContainer([{ type: 0x10, payload: wasmModule }]),
      large: large,
      largeEdited: editLargeContainer(large),
      parser: delta.wasmParser(instance.exports),
      report: report
    };
    registerTests(ctx);
    return runQueue();
  }).then(function () {
    results.forEach(function (r) {
      var tag = r.skipped ? 'skip ' : (r.ok ? 'ok   ' : 'FAIL ');
      console.log(tag + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    });
    var failed = results.filter(function (r) { return !r.ok && !r.skipped; }).length;
    var skipped = results.filter(function (r) { return r.skipped; }).length;
    console.log('\n' + (results.length - failed - skipped) + '/' + results.length +
      ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));

    printMeasurements(report, demo);
    process.exit(failed ? 1 : 0);
  });
}

function printMeasurements(report, demo) {
  var lines = [];
  if (report.demoChoice) {
    var c = report.demoChoice;
    lines.push(
      'demo container (' + demo.length + ' bytes, ' + report.demoUnits + ' units): 1 vector modified, ' +
      '1 removed, 3 added → semantic ' + c.semanticBytes + ' B, span ' + c.spanBytes + ' B, full ' +
      c.fullBytes + ' B  (' + (c.spanBytes / c.semanticBytes).toFixed(2) + '× less than span, ' +
      (c.fullBytes / c.semanticBytes).toFixed(2) + '× less than full)'
    );
  }
  if (report.demoRecords) {
    var r = report.demoRecords;
    lines.push(
      '  record payload alone: ' + r.recordBytes + ' B against a ' + r.slabBytes +
      '-byte slab (' + (r.slabBytes / r.recordBytes).toFixed(2) + '× less)'
    );
  }
  if (report.demoInventoryBytes) {
    lines.push('  receiver inventory: ' + report.demoInventoryBytes + ' base64url characters');
  }
  if (report.large) {
    var l = report.large;
    lines.push(
      'large container (' + l.size + ' bytes, ' + l.spans + ' segments, ' + l.units +
      ' units): 8 vectors, 1 COW cluster, 3 membership bits and 1 wasm byte changed → semantic ' +
      l.semantic + ' B, span ' + l.span + ' B, full ' + l.full + ' B  (' +
      (l.span / l.semantic).toFixed(1) + '× less than span, ' +
      (l.full / l.semantic).toFixed(1) + '× less than full)'
    );
    lines.push(
      '  of that semantic delta: ' + l.payloadBytes + ' B of changed content and ' +
      l.tableBytes + ' B of unit table; receiver inventory ' + l.inventoryBytes + ' characters'
    );
  }
  if (report.wasm) {
    var w = report.wasm;
    lines.push(
      'wasm component (' + w.module + '-byte module, ' + w.codeSection + '-byte Code section, ' +
      w.units + ' units): one function body changed → ' + w.sent + ' B of content, semantic ' +
      w.semantic + ' B, span ' + w.span + ' B, full ' + w.full + ' B  (' +
      (w.span / w.semantic).toFixed(1) + '× less than span)'
    );
  }
  if (report.cow) {
    var cw = report.cow;
    lines.push(
      'RVCOW / agenticow branch (' + cw.size + '-byte cluster map, ' + cw.units +
      ' units): 5 of 2000 clusters flipped → ' + cw.sent + ' B of content, ' + cw.payload +
      ' B delta (' + (cw.size / cw.payload).toFixed(1) + '× less than full)'
    );
  }
  if (report.sealed) {
    lines.push(
      'sealed inventories: ' + report.sealed.small + ' B and ' + report.sealed.large +
      ' B — the content is hidden, the scale is not'
    );
  }
  if (lines.length) console.log('\n' + lines.join('\n'));
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('FAIL harness  [' + (e && e.stack ? e.stack : e) + ']');
    process.exit(1);
  });
}

module.exports = { main: main };
