/*!
 * Suite 13 — the transfer planner, artifacts/planner.js.
 *
 * Every other suite measures a mechanism. This one measures a DECISION: given a
 * situation, `plan()` enumerates concrete strategies, discards the ones the hard
 * rules forbid, ranks what is left by J = 0.45·T + 0.20·E + 0.20·B + 0.15·R and
 * returns the winner. Four things are worth measuring about that, and a fifth
 * that is worth checking rather than assuming.
 *
 * 1. DECISION QUALITY, WHICH IS NOT THE SAME AS THE WINNER'S SCORE. Reporting
 *    that the planner picked the lowest J is circular — J is what it sorts on.
 *    So every row below also reports what the ALTERNATIVES cost: the fastest and
 *    slowest admissible candidate in seconds, the leanest and heaviest in wire
 *    bytes, and where the chosen plan sits between them. A planner that picks
 *    the best available option is only interesting once the spread is visible,
 *    and the spread is the column that shows J trading time against bytes,
 *    energy and risk rather than minimising any one of them.
 *
 * 2. THE COST OF DECIDING. `plan()` builds and scores a candidate set before a
 *    byte moves. Candidate count and planning time are reported per situation,
 *    against the transfer time the decision saves relative to the REFERENCE
 *    strategy — v1 JSON, indexed, 512 B, whole artifact, which is what this app
 *    does today when nobody chooses anything. A planner whose decision costs
 *    more than it saves is a regression; the ratio column says which side of
 *    that line each situation falls on, including the sign.
 *
 * 3. THE HARD RULES UNDER AN ADVERSARIAL ADVISER. The learned component is
 *    injected as `adviser.preference(candidate, situation)`. This suite supplies
 *    one that returns the maximum preference for exactly the candidates a rule
 *    forbids and the minimum for everything else, at an advice weight of 1000 —
 *    which the module clamps, but the request is what an unbounded learned model
 *    would make. For each of the four rules the table reports candidates
 *    admitted, candidates rejected, whether any rejected id appears anywhere in
 *    the ranking, and whether the violator was chosen. Note that the trust rule
 *    rejects EVERY candidate, so its correct outcome is `chosen === null` — no
 *    plan at all — which is a row in the table rather than a crash.
 *
 * 4. THE INVENTORY-GRANULARITY RULE. `chooseInventoryGranularity()` is the
 *    receiver-side decision the semantic-delta suite showed nobody was making:
 *    `semanticInventory()` builds a unit table unconditionally, so a receiver
 *    pays for unit granularity even in transfers where the sender will decline
 *    it. The rule bounds what that table could possibly save, from sizes alone,
 *    knowing nothing about what changed. A rule that only ever says yes is not a
 *    rule, so the shapes below are chosen to produce both verdicts, and the
 *    rewrite-tolerance interval that leaves every verdict unchanged is DERIVED
 *    from the break-even fractions measured here rather than quoted.
 *
 * 5. THE ARITHMETIC AGAINST THE REAL ENCODERS. The granularity rule predicts
 *    inventory sizes with arithmetic — b64(52 + (spans+units)·rec) against
 *    b64(44 + spans·rec) — instead of encoding anything. Predicted and actual
 *    are both reported for every container this suite parses for real, so a
 *    divergence shows up as a row rather than as a wrong verdict nobody checked.
 *
 * WHAT IS REAL HERE. The demo container is artifacts/demo/ruvnet-demo.rvf off
 * disk and the WASM container wraps artifacts/demo/rvf_wasm_bg.wasm, both parsed
 * by the real microkernel through `delta.wasmParser`; their span counts, unit
 * counts and decomposable byte totals come out of `semdelta.decompositionReport`
 * rather than out of a table. The megabyte container is SYNTHETIC — the
 * repository ships nothing at that scale — and is flagged as such wherever it
 * appears. Artifact sizes in the situations are the measured sizes of those same
 * containers.
 *
 * WHAT IS NOT MEASURED HERE, AND CANNOT BE. A plan is a projection: the planner
 * decides from sizes before anything is built, so "seconds" is its own transfer
 * model's output, not a stopwatch reading. This suite measures what the planner
 * decides and what deciding costs. Whether the decision was right is a question
 * about the model, and planner.js's own docblock is explicit that the energy
 * term is calibrated against nothing.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { core, REPO_ROOT, loadShippedDelta } from '../lib/transports.mjs';
import { summarize } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

export function loadPlanner() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'planner.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

function loadSemDelta() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'semdelta.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate };
  } catch {
    return null;
  }
}

// --- Fixtures ----------------------------------------------------------------
// The container builders are the ones bench/suites/semdelta.mjs uses, which in
// turn lifted them from artifacts/semdelta.test.js, so the containers this suite
// derives receiver facts from are the containers that suite measures deltas on.
// A 64-byte segment header per ADR-009.

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

/** A CowMap payload: header(64) | trailer(17) | parent path | flat-array map. */
function cowMapPayload(clusters, parentPath) {
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
  for (let i = 0; i < clusters; i++) out[m + 5 + i * 9] = 1; // ParentRef
  return out;
}

/** A Membership payload: header(96) | dense little-endian u64 bitmap. */
function membershipPayload(vectorCount) {
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
  return out;
}

/**
 * The megabyte case: everything semdelta.js knows how to look inside, at the
 * scale the mechanism exists for. A 2,000-vector slab at 128 dimensions, the
 * real microkernel, a COW cluster map, a membership bitmap, manifests either
 * side — the same shape bench/suites/semdelta.mjs measures deltas on, so the
 * receiver facts this suite derives describe a container that suite has already
 * shown to be decomposable.
 */
function buildLargeContainer(wasmModule, rnd) {
  const dim = 128;
  const records = [];
  for (let i = 0; i < 2000; i++) records.push(vecRecord(i + 1, dim, i));
  return makeContainer([
    { type: 0x05, payload: rndBytes(98, rnd) }, // Manifest
    { type: 0x01, payload: vecPayload(dim, records, 0) }, // Vec
    { type: 0x10, payload: wasmModule }, // Wasm
    { type: 0x20, payload: cowMapPayload(4000, '../base.rvf') }, // CowMap
    { type: 0x22, payload: membershipPayload(64000) }, // Membership
    { type: 0x0a, payload: rndBytes(68, rnd) }, // Witness
    { type: 0x05, payload: rndBytes(148, rnd) } // Manifest
  ]);
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

// --- Receiver facts, read off a real container -------------------------------

/**
 * What a receiver holding this container would publish, measured rather than
 * asserted: spans from `delta.spanPlan`, units from `semdelta.semanticPlan`, and
 * decomposable bytes summed over the spans `decompositionReport` says it
 * actually decomposed. The last one is the number the granularity bound divides
 * by, so taking it from the report rather than from the container length is the
 * difference between measuring the rule and feeding it a guess.
 *
 * Both encoded inventories are also built here, so the rule's arithmetic can be
 * checked against the encoders instead of trusted.
 */
function receiverFacts(bytes, { delta, semdelta, parser, label, synthetic }) {
  const spans = delta.spanPlan(bytes, { parser });
  const units = semdelta.semanticPlan(bytes, { parser });
  const report = semdelta.decompositionReport(bytes, { parser });

  let decomposableBytes = 0;
  let decomposedSpans = 0;
  for (const row of report) {
    if (row.decomposed) {
      decomposableBytes += row.length;
      decomposedSpans++;
    }
  }

  // `delta.encodeInventory` returns base64url text and
  // `semdelta.encodeSemanticInventory` returns the bytes behind it, so the two
  // are brought to the same units here rather than compared as they come. Both
  // columns are what crosses the wire.
  const spanInventory = delta.encodeInventory(delta.inventory(bytes, { parser })).length;
  const unitInventory = core.b64uEncode(
    semdelta.encodeSemanticInventory(semdelta.semanticInventory(bytes, { parser }))
  ).length;

  return {
    label,
    synthetic: !!synthetic,
    containerBytes: bytes.length,
    spanCount: spans.length,
    unitCount: units.length,
    decomposedSpans,
    decomposableBytes,
    actualSpanInventoryBytes: spanInventory,
    actualUnitInventoryBytes: unitInventory
  };
}

// --- Situations --------------------------------------------------------------

/**
 * A situation is deliberately verbose rather than defaulted: the planner fills
 * in what a caller omits, and a benchmark that leaned on those defaults would be
 * measuring the defaults. Every field that moves a result is stated.
 */
function situation(over) {
  const base = {
    artifact: { bytes: 1, name: 'artifact.bin' },
    receiver: { holds: 'none', supportsV2: true },
    link: { lossRate: 0, fps: 5, symbolBytes: 792 },
    device: { role: 'receiver', baselineBytes: 0 },
    policy: { radio: 'any' },
    trust: { verified: true }
  };
  const out = {};
  for (const key of Object.keys(base)) out[key] = { ...base[key], ...((over || {})[key] || {}) };
  return out;
}

/** Receiver half of a situation, from measured container facts. */
function holding(facts, { holds, overlap, baseConfidence = 1, supportsV2 = true }) {
  return {
    holds,
    baseBytes: facts.containerBytes,
    decomposableBytes: facts.decomposableBytes,
    spanCount: facts.spanCount,
    unitCount: facts.unitCount,
    overlap,
    baseConfidence,
    supportsV2
  };
}

/**
 * Plans one situation and measures the spread around the plan.
 *
 * The spread is the point. `bestSeconds` and `worstSeconds` are the extremes
 * over the ADMISSIBLE set — the strategies that could legally have been chosen —
 * evaluated by the planner's own transfer model, so "what the alternatives cost"
 * is a real comparison and not a rhetorical one.
 */
function summarise(raw, { planner, reps }) {
  const planned = timeIt(() => planner.plan(raw), reps);
  const p = planned.value;

  const s = planner.normalizeSituation(raw);
  const rows = p.admissible.map((c) => {
    const terms = planner.costTerms(c, s);
    return { id: c.id, label: c.label, terms, seconds: terms.model.seconds, wireBytes: terms.model.wireBytes };
  });

  const seconds = rows.map((r) => r.seconds);
  const wire = rows.map((r) => r.wireBytes);
  const chosenRow = p.chosen ? rows.filter((r) => r.id === p.chosen.id)[0] : null;
  const reference = rows.length ? rows[0].terms.reference : planner.costTerms(planner.REFERENCE, s).model;
  const fastest = rows.length ? rows[seconds.indexOf(Math.min(...seconds))] : null;
  const leanest = rows.length ? rows[wire.indexOf(Math.min(...wire))] : null;

  return {
    situation: s,
    candidateCount: p.candidateCount,
    admitted: p.admissible.length,
    rejected: p.rejected.length,

    chosenId: p.chosen ? p.chosen.id : null,
    chosenLabel: p.chosen ? p.chosen.label : null,
    chosenTransport: p.chosen ? p.chosen.transport : null,
    J: p.J,
    terms: p.terms ? { T: p.terms.T, E: p.terms.E, B: p.terms.B, R: p.terms.R } : null,
    runnerUpLabel: p.ranked.length > 1 ? p.ranked[1].label : null,
    runnerUpJ: p.ranked.length > 1 ? p.ranked[1].J : null,

    chosenSeconds: chosenRow ? chosenRow.seconds : null,
    bestSeconds: seconds.length ? Math.min(...seconds) : null,
    worstSeconds: seconds.length ? Math.max(...seconds) : null,
    chosenWireBytes: chosenRow ? chosenRow.wireBytes : null,
    bestWireBytes: wire.length ? Math.min(...wire) : null,
    worstWireBytes: wire.length ? Math.max(...wire) : null,
    // Whether J's winner is also a time-minimal and a byte-minimal strategy.
    // Compared on the quantity rather than on identity, so a tie between two
    // candidates that cost the same seconds does not get reported as J giving
    // seconds up — it gave up nothing, the ranking merely broke a tie.
    chosenIsFastest: !!(chosenRow && fastest && chosenRow.seconds <= fastest.seconds + 1e-9),
    chosenIsLeanest: !!(chosenRow && leanest && chosenRow.wireBytes <= leanest.wireBytes + 1e-9),
    fastestLabel: fastest ? fastest.label : null,
    leanestLabel: leanest ? leanest.label : null,

    referenceSeconds: reference.seconds,
    referenceWireBytes: reference.wireBytes,

    planMs: planned.stats,
    // The decision's own cost against what it buys, both in seconds. Negative
    // savings are reported as such rather than clamped.
    savedSeconds: chosenRow ? reference.seconds - chosenRow.seconds : null,
    inventoryVerdict: p.inventory.verdict,
    inventoryGranularity: p.inventory.granularity
  };
}

/**
 * One situation, measured as declared and again with the radio forbidden.
 *
 * The second measurement is not decoration. A peer link moves bytes at a rate no
 * QR symbol can approach, so wherever policy allows one the plan is a foregone
 * conclusion and the optical grid — two framings, two modes, two chunk sizes,
 * two verification depths — never shows through. Forbidding the radio is the
 * only way to read out which optical strategy the planner would pick, and the
 * optical case is the one this application is actually for.
 */
function measureSituation(spec, ctx) {
  const raw = spec.situation;
  const primary = summarise(raw, ctx);
  const offlineRaw = {
    ...raw,
    policy: { ...raw.policy, radio: ctx.planner.RADIO_OFFLINE }
  };
  const offline = raw.policy.radio === ctx.planner.RADIO_OFFLINE ? null : summarise(offlineRaw, ctx);

  return {
    name: spec.name,
    what: spec.what,
    synthetic: !!spec.synthetic,
    artifactBytes: primary.situation.artifact.bytes,
    holds: primary.situation.receiver.holds,
    lossRate: primary.situation.link.lossRate,
    radioPolicy: primary.situation.policy.radio,
    ...primary,
    offline
  };
}

// --- The hard rules, under an adversarial adviser ----------------------------

/**
 * An adviser that maximally favours a named set of candidate ids and maximally
 * disfavours everything else. This is the shape of a learned model that has
 * become confident about exactly the wrong thing.
 */
function adviserFavouring(ids) {
  const set = new Set(ids);
  return {
    name: 'adversarial',
    preference: (candidate) => (set.has(candidate.id) ? 1 : 0)
  };
}

/**
 * Measures one rule under pressure.
 *
 * The rejected set is read from a neutral plan first, so the adviser can be
 * pointed at precisely the candidates that rule forbids — the strongest form of
 * the attack, rather than a generic one that might miss.
 *
 * `chosen === null` is a legitimate outcome and the trust case produces it:
 * every candidate is rejected, so there is no plan at all. That is a row here,
 * not an error.
 */
function measureRule(spec, { planner, adviceWeight }) {
  const raw = spec.situation;
  const neutral = planner.plan(raw);
  const targeted = neutral.rejected.filter((r) => r.rule === spec.rule);
  const attacked = planner.plan(raw, {
    adviser: adviserFavouring(targeted.map((r) => r.id)),
    adviceWeight
  });

  const rejectedIds = new Set(attacked.rejected.map((r) => r.id));
  const rankedViolators = attacked.ranked.filter((r) => rejectedIds.has(r.id));

  return {
    rule: spec.rule,
    name: spec.name,
    what: spec.what,
    candidateCount: attacked.candidateCount,
    admitted: attacked.admissible.length,
    rejectedTotal: attacked.rejected.length,
    rejectedByThisRule: attacked.rejected.filter((r) => r.rule === spec.rule).length,
    favoured: targeted.length,
    adviceWeightAsked: adviceWeight,
    adviceWeightApplied: attacked.adviceWeight,
    // The three ways a rejected candidate could come back: as the choice, as a
    // ranked row, or as an admissible object. All three are checked, because
    // "was it chosen" alone would miss a leak that only shows up on a tie.
    violatorChosen: attacked.chosen ? rejectedIds.has(attacked.chosen.id) : false,
    violatorsRanked: rankedViolators.length,
    violatorsAdmitted: attacked.admissible.filter((c) => rejectedIds.has(c.id)).length,
    chosenLabel: attacked.chosen ? attacked.chosen.label : null,
    reason: attacked.reason,
    exampleReason: targeted.length ? targeted[0].reason : ''
  };
}

// --- The suite ---------------------------------------------------------------

export function runPlannerSuite({ demoBytes, wasmModule, seed = 20260802, reps = 9 } = {}) {
  const shipped = loadPlanner();
  if (!shipped) return { available: false, reason: 'artifacts/planner.js not present' };
  const shippedDelta = loadShippedDelta();
  if (!shippedDelta) return { available: false, reason: 'artifacts/delta.js not present' };
  const shippedSem = loadSemDelta();
  if (!shippedSem) return { available: false, reason: 'artifacts/semdelta.js not present' };

  const planner = shipped.module;
  const delta = shippedDelta.module;
  const semdelta = shippedSem.module;

  // The real microkernel, as in the semantic-delta suite: if it will not
  // instantiate the suite says so rather than silently measuring the JS scanner.
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
  const wasmContainer = makeContainer([{ type: semdelta.TYPE_WASM, payload: wasmModule }]);
  const largeContainer = buildLargeContainer(wasmModule, rnd);
  // Two single-segment containers at the scale their mechanisms exist for. The
  // repository ships neither, so both are synthetic — but both are parsed for
  // real, and single-segment containers are the shape where a unit table has the
  // most to offer, so a granularity rule measured without them would be measured
  // on its easy half.
  const cowContainer = makeContainer([
    { type: semdelta.TYPE_COWMAP, payload: cowMapPayload(2000, '../parent.rvf') }
  ]);
  const membershipContainer = makeContainer([
    { type: semdelta.TYPE_MEMBERSHIP, payload: membershipPayload(40000) }
  ]);

  const demo = receiverFacts(demoBytes, { delta, semdelta, parser, label: 'demo container' });
  const wasm = receiverFacts(wasmContainer, { delta, semdelta, parser, label: 'WASM container' });
  const large = receiverFacts(largeContainer, {
    delta, semdelta, parser, label: 'large container', synthetic: true
  });
  const cow = receiverFacts(cowContainer, {
    delta, semdelta, parser, label: 'RVCOW cluster map', synthetic: true
  });
  const membership = receiverFacts(membershipContainer, {
    delta, semdelta, parser, label: 'membership bitmap', synthetic: true
  });

  // The smallest real segment in the demo container, used as the tiny-artifact
  // situation so that even that row is a size something actually is.
  const demoSpans = delta.spanPlan(demoBytes, { parser });
  const smallestSpan = demoSpans.reduce((a, b) => (b.length < a.length ? b : a));

  // --- Decision quality and the cost of deciding -----------------------------

  const situations = [
    {
      name: 'cold receiver, demo container',
      what: 'receiver holds nothing; only a whole-artifact transfer is possible',
      situation: situation({
        artifact: { bytes: demo.containerBytes, name: 'ruvnet-demo.rvf' },
        receiver: { holds: 'none' },
        link: { lossRate: 0.1 }
      })
    },
    {
      name: 'receiver holds a near-identical copy',
      what: '99% overlap, unit inventory already published',
      situation: situation({
        artifact: { bytes: demo.containerBytes, name: 'ruvnet-demo.rvf' },
        receiver: holding(demo, { holds: 'unit', overlap: 0.99 }),
        link: { lossRate: 0.1 }
      })
    },
    {
      name: 'lossy link, 45% loss',
      what: 'cold receiver, the 40,989 B microkernel, 45% of frames lost',
      situation: situation({
        artifact: { bytes: wasmModule.length, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none' },
        link: { lossRate: 0.45 }
      })
    },
    {
      name: 'tiny artifact',
      what: `the demo container's smallest segment, ${smallestSpan.length} B`,
      situation: situation({
        artifact: { bytes: smallestSpan.length, name: 'segment' },
        receiver: { holds: 'none' },
        link: { lossRate: 0.1 }
      })
    },
    {
      name: 'large container, mostly unchanged',
      what: '99% overlap on a megabyte-scale container',
      synthetic: true,
      situation: situation({
        artifact: { bytes: large.containerBytes, name: 'large.rvf' },
        receiver: holding(large, { holds: 'unit', overlap: 0.99 }),
        link: { lossRate: 0.1 }
      })
    },
    {
      name: 'offline policy',
      what: 'no radio permitted; the peer link is forbidden, not merely costly',
      situation: situation({
        artifact: { bytes: wasmModule.length, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none' },
        link: { lossRate: 0.1, radioBytesPerSecond: 10 * 1000 * 1000 },
        policy: { radio: planner.RADIO_OFFLINE }
      })
    },
    {
      name: 'receiver has not declared v2',
      what: 'v2 framing carries a hazard the receiver has not retired, so risk and time pull apart',
      situation: situation({
        artifact: { bytes: wasmModule.length, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none', supportsV2: false },
        link: { lossRate: 0.1 }
      })
    },
    {
      name: 'committing transfer',
      what: 'the result is written back as the new base, so partial verification is forbidden',
      situation: situation({
        artifact: { bytes: wasmModule.length, name: 'rvf_wasm_bg.wasm' },
        receiver: holding(wasm, { holds: 'span', overlap: 0.9 }),
        link: { lossRate: 0.1 },
        policy: { commit: true }
      })
    }
  ];

  const situationRows = situations.map((spec) => measureSituation(spec, { planner, reps }));
  const opticalRows = situationRows.filter((s) => s.offline).map((s) => ({ name: s.name, ...s.offline }));

  // --- The hard rules under an adversarial adviser ---------------------------

  const MIB = 1024 * 1024;
  const adviceWeight = 1000;
  const ruleSpecs = [
    {
      rule: planner.RULE_TRUST,
      name: 'unverified peer',
      what: 'trust.verified is false',
      situation: situation({
        artifact: { bytes: wasmModule.length },
        receiver: { holds: 'none' },
        trust: { verified: false }
      })
    },
    {
      rule: planner.RULE_MEMORY,
      name: '48 MiB artifact',
      what: 'projected peak working memory against the 128 MiB budget',
      situation: situation({
        artifact: { bytes: 48 * MIB },
        receiver: { holds: 'none' }
      })
    },
    {
      rule: planner.RULE_RADIO,
      name: 'offline policy, fast radio',
      what: 'a 10 MB/s peer link that policy forbids anyway',
      situation: situation({
        artifact: { bytes: wasmModule.length },
        receiver: { holds: 'none' },
        link: { radioBytesPerSecond: 10 * 1000 * 1000 },
        policy: { radio: planner.RADIO_OFFLINE }
      })
    },
    {
      rule: planner.RULE_VERIFICATION,
      name: 'committing transfer',
      what: 'partial verification under a commit',
      situation: situation({
        artifact: { bytes: wasmModule.length },
        receiver: { holds: 'none' },
        policy: { commit: true }
      })
    }
  ];

  const ruleRows = ruleSpecs.map((spec) => measureRule(spec, { planner, adviceWeight }));

  // --- Inventory granularity -------------------------------------------------

  const granularityShapes = [
    { name: 'demo container', facts: demo, real: true },
    { name: 'WASM container', facts: wasm, real: true },
    { name: 'RVCOW cluster map', facts: cow, real: true, synthetic: true },
    { name: 'membership bitmap', facts: membership, real: true, synthetic: true },
    { name: 'large container', facts: large, real: true, synthetic: true },
    {
      name: 'many tiny units',
      what: '40 units over 900 decomposable bytes',
      hypothetical: true,
      facts: { containerBytes: 4096, decomposableBytes: 900, spanCount: 2, unitCount: 40 }
    },
    {
      name: 'opaque container',
      what: 'segments with no payload layout this module can parse',
      hypothetical: true,
      facts: { containerBytes: 8192, decomposableBytes: 0, spanCount: 5, unitCount: 5 }
    },
    {
      name: 'cold receiver',
      what: 'nothing held at all',
      hypothetical: true,
      facts: { containerBytes: 0, decomposableBytes: 0, spanCount: 0, unitCount: 0 }
    }
  ];

  const granularityRows = granularityShapes.map((shape) => {
    const f = shape.facts;
    const timed = timeIt(() => planner.chooseInventoryGranularity({
      containerBytes: f.containerBytes,
      decomposableBytes: f.decomposableBytes,
      spanCount: f.spanCount,
      unitCount: f.unitCount
    }), reps);
    const r = timed.value;
    return {
      name: shape.name,
      hypothetical: !!shape.hypothetical,
      what: shape.what ||
        `${f.spanCount} span${f.spanCount === 1 ? '' : 's'}, ${f.unitCount} units, ` +
        `${f.decomposableBytes.toLocaleString('en-US')} B decomposable`,
      real: !!shape.real,
      synthetic: !!shape.synthetic,
      containerBytes: f.containerBytes,
      spanCount: f.spanCount,
      unitCount: f.unitCount,
      decomposableBytes: f.decomposableBytes,
      recordBytes: r.recordBytes,
      predictedSpanInventoryBytes: r.spanInventoryBytes,
      predictedUnitInventoryBytes: r.unitInventoryBytes,
      actualSpanInventoryBytes: shape.real ? f.actualSpanInventoryBytes : null,
      actualUnitInventoryBytes: shape.real ? f.actualUnitInventoryBytes : null,
      inventoryExtra: r.inventoryExtra,
      payloadExtra: r.payloadExtra,
      doublePaid: r.doublePaid,
      breakEven: r.breakEvenRewriteFraction,
      tolerance: r.rewriteTolerance,
      granularity: r.granularity,
      verdict: r.verdict,
      reason: r.reason,
      chooseMs: timed.stats
    };
  });

  // The interval of rewrite tolerances that leaves every verdict above
  // unchanged, DERIVED from the break-even fractions measured here: it opens
  // above the highest break-even that was declined on the tolerance test and
  // closes at the lowest that was admitted. Shapes refused for a categorical
  // reason — nothing to decompose, a table that cannot pay at any tolerance —
  // are excluded, because no tolerance moves them.
  const tolerant = granularityRows.filter((r) => r.verdict === 'worth-it' || r.verdict === 'marginal');
  const admittedBreakEvens = tolerant.filter((r) => r.granularity === 'unit').map((r) => r.breakEven);
  const declinedBreakEvens = tolerant.filter((r) => r.granularity === 'span').map((r) => r.breakEven);
  const toleranceInterval = {
    open: declinedBreakEvens.length ? Math.max(...declinedBreakEvens) : 0,
    close: admittedBreakEvens.length ? Math.min(...admittedBreakEvens) : 1,
    admitted: admittedBreakEvens.length,
    declined: declinedBreakEvens.length,
    defaultInside: false
  };
  toleranceInterval.defaultInside =
    planner.DEFAULT_REWRITE_TOLERANCE > toleranceInterval.open &&
    planner.DEFAULT_REWRITE_TOLERANCE <= toleranceInterval.close;

  return {
    available: true,
    path: shipped.path,
    parserKind,
    parserReason,
    reps,
    seed,
    weights: {
      T: planner.WEIGHT_TIME,
      E: planner.WEIGHT_ENERGY,
      B: planner.WEIGHT_BYTES,
      R: planner.WEIGHT_RISK,
      sum: planner.WEIGHT_SUM
    },
    reference: planner.REFERENCE.label,
    maxAdviceWeight: planner.MAX_ADVICE_WEIGHT,
    defaultRewriteTolerance: planner.DEFAULT_REWRITE_TOLERANCE,
    memoryBudgetBytes: planner.MEMORY_BUDGET_BYTES,
    containers: [demo, wasm, cow, membership, large],
    situations: situationRows,
    optical: opticalRows,
    rules: ruleRows,
    granularity: granularityRows,
    toleranceInterval
  };
}
