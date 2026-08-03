/*!
 * Suite 12 — semantic delta, inside RVF segments.
 *
 * Suite 3 measures artifacts/delta.js, which diffs a container at SPAN
 * granularity: a segment that changed at all is a segment resent whole. This
 * suite measures artifacts/semdelta.js, which goes one level down and diffs
 * UNITS — vector records, WASM sections and function bodies, COW cluster-map
 * blocks, membership-bitmap blocks — inside the spans it can parse safely.
 *
 * WHAT IS MEASURED, AND WHY THREE NUMBERS RATHER THAN ONE. For every scenario
 * the harness builds all three payloads and reports all three sizes:
 *
 *   full        the whole container, what a cold receiver pays.
 *   span        delta.js's payload, segment granularity.
 *   semantic    semdelta.js's payload, unit granularity.
 *
 * and then reports WHICH ONE `chooseDelta` ACTUALLY PICKED. That last column is
 * the point of the suite. A finer diff is not free: every unit costs a row in a
 * table the payload has to carry, so on a container whose units all changed the
 * semantic payload is the span payload plus a table. `chooseDelta` builds both
 * and returns the smaller, and a benchmark that only exhibited the cases where
 * the fine tool wins would be advertising rather than measurement. Two of the
 * scenarios below are cases where the span delta legitimately wins and the
 * chooser is expected to decline the semantic one.
 *
 * THE SEMANTIC INVENTORY IS NOT FREE EITHER, and it is reported next to the
 * payloads rather than left out. A delta transfer is two optical hops: the
 * receiver shows an inventory, then the sender streams the delta. semdelta.js's
 * inventory carries a unit table *in addition to* the span table delta.js
 * sends, so the receiver's hop gets bigger in exactly the cases the sender's
 * hop gets smaller. Both columns are in the table; neither nets the other out.
 *
 * WHAT IS REAL HERE. The demo, WASM and large-container scenarios use
 * artifacts/demo/ruvnet-demo.rvf and artifacts/demo/rvf_wasm_bg.wasm off disk —
 * the real container and the real microkernel — and every plan is produced by
 * that microkernel through `delta.wasmParser`, not by the JS fallback scanner.
 * The COW, membership and span-wins scenarios need containers the repository
 * does not contain (a 2,000-cluster COW map, a 40,000-bit membership filter),
 * so those are SYNTHETIC and flagged as such in the table.
 *
 * Every scenario's chosen payload is applied to the base and the result is
 * SHA-256 checked against the sender's container. A size that does not
 * reconstruct is not a saving, so the exactness column is reported beside the
 * ratio rather than assumed.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { core, REPO_ROOT, loadShippedDelta } from '../lib/transports.mjs';
import { summarize } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

export function loadSemDelta() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'semdelta.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

// --- Fixtures ----------------------------------------------------------------
// Lifted from artifacts/semdelta.test.js so the benchmark measures the same
// containers the test suite asserts on. A 64-byte segment header per ADR-009:
// little-endian magic 53 46 56 52, version 1, type, then the segment id and the
// payload length.

function segmentHeader(type, segId, payloadLength) {
  const h = new Uint8Array(64);
  h.set([0x53, 0x46, 0x56, 0x52], 0);
  h[4] = 1;
  h[5] = type;
  h[8] = segId & 0xff;
  h[9] = (segId >>> 8) & 0xff;
  writeU32(h, 16, payloadLength);
  return h;
}

function writeU32(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >>> 8) & 0xff;
  bytes[off + 2] = (value >>> 16) & 0xff;
  bytes[off + 3] = (value >>> 24) & 0xff;
}

/** specs: [{ type, payload }] -> a container both parsers enumerate. */
function makeContainer(specs) {
  const total = specs.reduce((n, s) => n + 64 + s.payload.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < specs.length; i++) {
    out.set(segmentHeader(specs[i].type, i + 1, specs[i].payload.length), at);
    out.set(specs[i].payload, at + 64);
    at += 64 + specs[i].payload.length;
  }
  return out;
}

/** Deterministic filler, seeded so a rerun builds byte-identical containers. */
function makeRnd(seed) {
  let s = seed >>> 0;
  return function rnd() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 16) & 0xff;
  };
}

function rndBytes(n, rnd) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd();
  return out;
}

/** A Vec payload: u16 dim | u16 count | u16 flags | count × { u64 id, dim × f32 }. */
function vecPayload(dim, records, flags) {
  const stride = 8 + dim * 4;
  const out = new Uint8Array(6 + stride * records.length);
  out[0] = dim & 0xff;
  out[1] = (dim >>> 8) & 0xff;
  out[2] = records.length & 0xff;
  out[3] = (records.length >>> 8) & 0xff;
  out[4] = (flags || 0) & 0xff;
  out[5] = ((flags || 0) >>> 8) & 0xff;
  for (let i = 0; i < records.length; i++) out.set(records[i], 6 + i * stride);
  return out;
}

function vecRecord(id, dim, fill) {
  const r = new Uint8Array(8 + dim * 4);
  r[0] = id & 0xff;
  r[1] = (id >>> 8) & 0xff;
  r[2] = (id >>> 16) & 0xff;
  r[3] = (id >>> 24) & 0xff;
  for (let i = 8; i < r.length; i++) r[i] = (fill + i * 7) & 0xff;
  return r;
}

/**
 * Rewrites a container's first Vec segment through `fn(records, slab)`, fixing
 * the header's payload length and perturbing its content_hash the way a real
 * rewrite would. Everything after the segment shifts, which is the case
 * hash-based matching has to survive.
 */
function rewriteVec(bytes, delta, semdelta, parser, fn) {
  const spans = delta.spanPlan(bytes, { parser });
  const span = spans.filter((s) => s.type === semdelta.TYPE_VEC)[0];
  const slab = semdelta.readVectorSlab(bytes, span);

  const records = [];
  for (let r = 0; r < slab.count; r++) {
    records.push(bytes.slice(slab.records[r].offset, slab.records[r].offset + slab.stride));
  }
  const next = fn(records, slab) || records;
  return spliceVecPayload(bytes, span, vecPayload(slab.dim, next, slab.flags));
}

/** Swaps a Vec segment's payload for another, fixing the header. */
function spliceVecPayload(bytes, span, payload) {
  const head = bytes.slice(span.offset, span.offset + 64);
  writeU32(head, 16, payload.length);
  // content_hash[16] at 0x28 moves whenever the payload does.
  for (let h = 0x28; h < 0x38; h++) head[h] = (head[h] + 1) & 0xff;
  const out = new Uint8Array(bytes.length - span.length + 64 + payload.length);
  out.set(bytes.subarray(0, span.offset), 0);
  out.set(head, span.offset);
  out.set(payload, span.offset + 64);
  out.set(bytes.subarray(span.offset + span.length), span.offset + 64 + payload.length);
  return out;
}

function replaceVecPayload(bytes, delta, semdelta, parser, payload) {
  const span = delta.spanPlan(bytes, { parser }).filter((s) => s.type === semdelta.TYPE_VEC)[0];
  const out = spliceVecPayload(bytes, span, payload);
  // replaceVecPayload also clears the uncompressed-length field, because the
  // slab it installs is a different shape rather than an edit of the old one.
  const head = out.subarray(span.offset, span.offset + 64);
  head[20] = 0; head[21] = 0; head[22] = 0; head[23] = 0;
  return out;
}

/** A CowMap payload: header(64) | trailer(17) | parent path | flat-array map. */
function cowMapPayload(clusters, parentPath, localSet) {
  const parent = Buffer.from(parentPath, 'utf8');
  const mapLen = 5 + clusters * 9;
  const out = new Uint8Array(81 + parent.length + mapLen);
  out.set([0x4d, 0x43, 0x56, 0x52], 0); // COWMAP_MAGIC little-endian
  out[4] = 1; // version
  out[6] = 0; // map_format = FlatArray
  writeU32(out, 0x08, 4096); // cluster_size_bytes
  writeU32(out, 0x0c, 64); // vectors_per_cluster
  writeU32(out, 0x40, 64); // bytes_per_vector
  writeU32(out, 0x45, 1); // snapshot_epoch (unaligned, per store.rs)
  writeU32(out, 0x49, parent.length);
  writeU32(out, 0x4d, mapLen);
  out.set(parent, 0x51);
  const m = 0x51 + parent.length;
  out[m] = 0;
  writeU32(out, m + 1, clusters);
  for (let i = 0; i < clusters; i++) {
    const at = m + 5 + i * 9;
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
  const words = Math.ceil(vectorCount / 64);
  const filterSize = words * 8;
  const out = new Uint8Array(96 + filterSize);
  out.set([0x42, 0x4d, 0x56, 0x52], 0); // MEMBERSHIP_MAGIC little-endian
  out[4] = 1; // version
  out[6] = 0; // filter_type = Bitmap
  out[7] = 0; // filter_mode = Include
  writeU32(out, 0x08, vectorCount);
  writeU32(out, 0x10, vectorCount);
  writeU32(out, 0x18, 96); // filter_offset
  writeU32(out, 0x20, filterSize);
  for (let i = 96; i < out.length; i++) out[i] = 0xff;
  (clearIds || []).forEach((id) => {
    const byteAt = 96 + (id >>> 3);
    if (byteAt < out.length) out[byteAt] &= ~(1 << (id & 7));
  });
  return out;
}

/**
 * Walks a WASM module's sections independently of semdelta.js, so the byte the
 * benchmark flips is known to be inside the Code section rather than assumed to
 * be. Returns [{ id, at, size, contentsAt }].
 */
function walkWasmSections(bytes, from, end) {
  const out = [];
  let at = from + 8;
  while (at < end) {
    const id = bytes[at];
    let shift = 0;
    let value = 0;
    let len = 0;
    for (let i = 0; i < 5; i++) {
      const b = bytes[at + 1 + i];
      value += (b & 0x7f) * Math.pow(2, shift);
      len++;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const contentsAt = at + 1 + len;
    if (contentsAt + value > end) break;
    out.push({ id, at, size: value, contentsAt });
    at = contentsAt + value;
  }
  return out;
}

/**
 * The realistic large case: a container with everything semdelta.js knows how
 * to look inside. A 2,000-vector slab at 128 dimensions, the real microkernel
 * as a WASM component, a COW cluster map, a membership bitmap, manifests either
 * side.
 */
function buildLargeContainer(wasmModule, rnd) {
  const dim = 128;
  const records = [];
  for (let i = 0; i < 2000; i++) records.push(vecRecord(i + 1, dim, i));
  return makeContainer([
    { type: 0x05, payload: rndBytes(98, rnd) }, // Manifest
    { type: 0x01, payload: vecPayload(dim, records, 0) }, // Vec
    { type: 0x10, payload: wasmModule }, // Wasm
    { type: 0x20, payload: cowMapPayload(4000, '../base.rvf', {}) }, // CowMap
    { type: 0x22, payload: membershipPayload(64000, []) }, // Membership
    { type: 0x0a, payload: rndBytes(68, rnd) }, // Witness
    { type: 0x05, payload: rndBytes(148, rnd) } // Manifest
  ]);
}

/** Eight changed vectors, one flipped COW cluster, three membership bits, one wasm byte. */
function editLargeContainer(base, delta, semdelta, parser) {
  const out = new Uint8Array(base);
  const spans = delta.spanPlan(out, { parser });
  const vecSpan = spans.filter((s) => s.type === 0x01)[0];
  const slab = semdelta.readVectorSlab(out, vecSpan);
  [3, 400, 401, 402, 900, 1500, 1501, 1999].forEach((i) => {
    const at = slab.records[i].offset;
    for (let b = 8; b < slab.stride; b += 7) out[at + b] ^= 0xa5;
  });

  const cowSpan = spans.filter((s) => s.type === 0x20)[0];
  // Flip one cluster entry from ParentRef to LocalOffset.
  const mapAt = cowSpan.offset + 64 + 81 + '../base.rvf'.length + 5;
  out[mapAt + 300 * 9] = 2;

  const memSpan = spans.filter((s) => s.type === 0x22)[0];
  out[memSpan.offset + 64 + 96 + 500] &= ~0x07;

  const wasmSpan = spans.filter((s) => s.type === 0x10)[0];
  out[wasmSpan.offset + 64 + Math.floor((wasmSpan.length - 64) / 2)] ^= 0xff;
  return out;
}

// --- Timing ------------------------------------------------------------------

function timeIt(fn, reps) {
  const ms = [];
  let last = null;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    last = fn();
    const t1 = process.hrtime.bigint();
    ms.push(Number(t1 - t0) / 1e6);
  }
  return { stats: summarize(ms), value: last };
}

// --- One scenario ------------------------------------------------------------

/**
 * Measures one base→target pair end to end: plan, inventory, choose, apply. The
 * sizes come out of `chooseDelta`, which builds BOTH payloads for real, so the
 * span and semantic columns are two payloads that both exist rather than one
 * payload and an estimate of the other.
 */
function measureScenario(spec, { semdelta, delta, parser, reps }) {
  const { base, target } = spec;

  const planned = timeIt(() => semdelta.semanticPlan(target, { parser }), reps);
  const inventoried = timeIt(() => semdelta.semanticInventory(base, { parser }), reps);
  const inv = inventoried.value;

  const chosen = timeIt(() => semdelta.chooseDelta(target, inv, { parser }), reps);
  const choice = chosen.value;

  const applied = timeIt(() => semdelta.applyChosen(base, choice, { parser }), reps);
  const rebuilt = applied.value && applied.value.bytes ? applied.value.bytes : applied.value;
  const exact = rebuilt instanceof Uint8Array && core.sha256Hex(rebuilt) === core.sha256Hex(target);

  // Both inventories, because the semantic path pays for its unit table on the
  // receiver's hop and the span path does not.
  const semInvBytes = core.b64uEncode(semdelta.encodeSemanticInventory(inv)).length;
  const spanInvBytes = Buffer.byteLength(
    delta.encodeInventory(delta.inventory(base, { parser })),
    'utf8'
  );

  return {
    name: spec.name,
    what: spec.what,
    synthetic: !!spec.synthetic,
    expectation: spec.expectation,

    baseBytes: base.length,
    fullBytes: choice.fullBytes,
    spanBytes: choice.spanBytes,
    semanticBytes: choice.semanticBytes,
    chosen: choice.chosen,
    chosenBytes: choice.bytes,
    reason: choice.reason,

    spanCount: choice.spanCount,
    unitCount: choice.unitCount,
    tableBytes: choice.tableBytes,
    spansMissing: choice.spanDiff.missing.length,
    unitsMissing: choice.unitDiff.missing.length,
    spanPayloadBytes: choice.spanDiff.bytesToSend,
    unitPayloadBytes: choice.unitDiff.bytesToSend,

    semanticInventoryBytes: semInvBytes,
    spanInventoryBytes: spanInvBytes,

    // Ratios are against the semantic payload throughout, so a figure below 1×
    // is a case where the semantic delta lost. That is the reading direction
    // the span-wins scenarios need.
    spanOverSemantic: choice.spanBytes / choice.semanticBytes,
    fullOverSemantic: choice.fullBytes / choice.semanticBytes,
    fullOverChosen: choice.fullBytes / choice.bytes,

    reconstructedExactly: exact,
    planMs: planned.stats,
    inventoryMs: inventoried.stats,
    chooseMs: chosen.stats,
    applyMs: applied.stats
  };
}

// --- The suite ---------------------------------------------------------------

export function runSemDeltaSuite({ demoBytes, wasmModule, seed = 20260802, reps = 5 } = {}) {
  const shipped = loadSemDelta();
  if (!shipped) {
    return { available: false, reason: 'artifacts/semdelta.js not present' };
  }
  const shippedDelta = loadShippedDelta();
  if (!shippedDelta) {
    return { available: false, reason: 'artifacts/delta.js not present' };
  }
  const semdelta = shipped.module;
  const delta = shippedDelta.module;

  // The real microkernel, instantiated synchronously so the harness's
  // top-level flow stays synchronous like every other suite. If it will not
  // instantiate the suite says so and falls back to the JS scanner rather than
  // silently measuring a different parser.
  let parser = null;
  let parserKind = 'JS scanner (fallback)';
  let parserReason = null;
  try {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmModule), {});
    parser = delta.wasmParser(instance.exports);
    parserKind = 'rvf_wasm_bg.wasm microkernel';
  } catch (err) {
    parserReason = String(err && err.message ? err.message : err);
  }

  const rnd = makeRnd(seed);
  const scenarios = [];

  // 1. The real demo container, small edit. One vector modified, one removed,
  //    three added — the case a vector store is in most of the time.
  const demoEdited = rewriteVec(demoBytes, delta, semdelta, parser, (records, slab) => {
    records[3] = records[3].slice();
    records[3][10] ^= 0xff; // id 4 changes
    records.splice(7, 1); // id 8 disappears
    for (let n = 0; n < 3; n++) records.push(vecRecord(100 + n, slab.dim, 40 + n));
    return records;
  });
  scenarios.push({
    name: 'demo container, small edit',
    what: '1 vector record changed, 1 removed, 3 added',
    expectation: 'semantic',
    base: demoBytes,
    target: demoEdited
  });

  // 2. The megabyte-scale container: a handful of units changed across four
  //    different decomposable segment types at once.
  const large = buildLargeContainer(wasmModule, rnd);
  const largeEdited = editLargeContainer(large, delta, semdelta, parser);
  scenarios.push({
    name: 'large container, scattered edits',
    what: '8 vector records, 1 COW cluster, 3 membership bits, 1 WASM byte',
    expectation: 'semantic',
    base: large,
    target: largeEdited,
    synthetic: true
  });

  // 3. One WASM function body changed. Lengths do not move, so the module stays
  //    structurally identical and exactly one body's bytes differ — the case
  //    Code-section unit alignment exists for.
  const wasmContainer = makeContainer([{ type: semdelta.TYPE_WASM, payload: wasmModule }]);
  const wasmSections = walkWasmSections(wasmContainer, 64, wasmContainer.length);
  const codeSection = wasmSections.filter((s) => s.id === 10)[0];
  const wasmEdited = new Uint8Array(wasmContainer);
  if (codeSection) {
    wasmEdited[codeSection.contentsAt + Math.floor(codeSection.size / 2)] ^= 0xff;
  }
  scenarios.push({
    name: 'WASM module, one function body',
    what: `1 byte flipped inside the ${codeSection ? codeSection.size : 0}-byte Code section`,
    expectation: 'semantic',
    base: wasmContainer,
    target: wasmEdited
  });

  // 4. RVCOW / agenticow: a child branch flips cluster-map entries from
  //    ParentRef to LocalOffset as it writes. Five writes touching three of the
  //    map's blocks.
  const cowLocal = {};
  [17, 18, 900, 901, 1500].forEach((i) => {
    cowLocal[i] = true;
  });
  scenarios.push({
    name: 'RVCOW branch, cluster map',
    what: '5 of 2,000 clusters flipped to LocalOffset',
    expectation: 'semantic',
    synthetic: true,
    base: makeContainer([
      { type: semdelta.TYPE_COWMAP, payload: cowMapPayload(2000, '../parent.rvf', {}) }
    ]),
    target: makeContainer([
      { type: semdelta.TYPE_COWMAP, payload: cowMapPayload(2000, '../parent.rvf', cowLocal) }
    ])
  });

  // 5. A membership bitmap: three bits cleared, two of them sharing a block.
  scenarios.push({
    name: 'membership bitmap, bits cleared',
    what: '3 of 40,000 membership bits cleared',
    expectation: 'semantic',
    synthetic: true,
    base: makeContainer([
      { type: semdelta.TYPE_MEMBERSHIP, payload: membershipPayload(40000, []) }
    ]),
    target: makeContainer([
      { type: semdelta.TYPE_MEMBERSHIP, payload: membershipPayload(40000, [11, 12, 30000]) }
    ])
  });

  // 6. THE SPAN DELTA SHOULD WIN HERE. Halving the dimension rewrites every
  //    record, so a semantic delta carries the whole slab AND a table describing
  //    it record by record; a span delta carries the same bytes under a
  //    four-row table. The chooser has to decline the finer tool.
  const narrowRecords = [];
  for (let i = 0; i < 24; i++) narrowRecords.push(vecRecord(i + 1, 8, i));
  scenarios.push({
    name: 'demo container, every record rewritten',
    what: 'vector dimension halved, 16 → 8: no unit survives',
    expectation: 'span',
    base: demoBytes,
    target: replaceVecPayload(demoBytes, delta, semdelta, parser, vecPayload(8, narrowRecords, 0))
  });

  // 7. AND HERE. A cold receiver holds nothing, so every unit is missing and
  //    the unit table describes bytes that were all going to be sent anyway.
  //    A different reason for the same verdict, which is why both are kept.
  scenarios.push({
    name: 'demo container, cold receiver',
    what: 'receiver holds nothing: every span and every unit is missing',
    expectation: 'span',
    base: null,
    target: demoBytes,
    coldStart: true
  });

  const rows = [];
  for (const spec of scenarios) {
    if (spec.coldStart) {
      rows.push(measureColdStart(spec, { semdelta, delta, parser, reps }));
    } else {
      rows.push(measureScenario(spec, { semdelta, delta, parser, reps }));
    }
  }

  return {
    available: true,
    path: shipped.path,
    parserKind,
    parserReason,
    reps,
    seed,
    demoBytes: demoBytes.length,
    wasmModuleBytes: wasmModule.length,
    codeSectionBytes: codeSection ? codeSection.size : null,
    wasmSectionCount: wasmSections.length,
    scenarios: rows
  };
}

/**
 * The cold-start case has no base inventory at all, so it takes a separate path
 * rather than a null-guarded version of the main one: there is nothing to
 * inventory and nothing to apply a delta to.
 */
function measureColdStart(spec, { semdelta, delta, parser, reps }) {
  const target = spec.target;
  const planned = timeIt(() => semdelta.semanticPlan(target, { parser }), reps);
  const chosen = timeIt(() => semdelta.chooseDelta(target, null, { parser }), reps);
  const choice = chosen.value;
  const applied = timeIt(() => semdelta.applyChosen(null, choice, { parser }), reps);
  const rebuilt = applied.value && applied.value.bytes ? applied.value.bytes : applied.value;
  const exact = rebuilt instanceof Uint8Array && core.sha256Hex(rebuilt) === core.sha256Hex(target);

  return {
    name: spec.name,
    what: spec.what,
    synthetic: !!spec.synthetic,
    expectation: spec.expectation,

    baseBytes: 0,
    fullBytes: choice.fullBytes,
    spanBytes: choice.spanBytes,
    semanticBytes: choice.semanticBytes,
    chosen: choice.chosen,
    chosenBytes: choice.bytes,
    reason: choice.reason,

    spanCount: choice.spanCount,
    unitCount: choice.unitCount,
    tableBytes: choice.tableBytes,
    spansMissing: choice.spanDiff.missing.length,
    unitsMissing: choice.unitDiff.missing.length,
    spanPayloadBytes: choice.spanDiff.bytesToSend,
    unitPayloadBytes: choice.unitDiff.bytesToSend,

    // No inventory hop at all: a cold receiver has nothing to describe.
    semanticInventoryBytes: 0,
    spanInventoryBytes: 0,

    spanOverSemantic: choice.spanBytes / choice.semanticBytes,
    fullOverSemantic: choice.fullBytes / choice.semanticBytes,
    fullOverChosen: choice.fullBytes / choice.bytes,

    reconstructedExactly: exact,
    planMs: planned.stats,
    inventoryMs: summarize([0]),
    chooseMs: chosen.stats,
    applyMs: applied.stats
  };
}
