#!/usr/bin/env node
/*!
 * Memory probe — runs the real send and receive paths on the artifacts in this
 * repository and reports what they cost.
 *
 * Run under `--expose-gc`, in its own process, because both of those matter:
 *
 *   - Without a forced collection, `heapUsed` is whatever the collector has not
 *     got round to yet, and a "retained bytes" figure taken from it is noise.
 *   - In the benchmark's own process, RSS would already carry every frame,
 *     symbol and QR matrix the other suites allocated, and the peak would be
 *     theirs rather than the stage's.
 *
 * bench/suites/memory.mjs spawns this once per mode and reads the JSON on
 * stdout. Every mode is also runnable by hand:
 *
 *   node --expose-gc bench/lib/memprobe.mjs --mode stages
 *   node --expose-gc bench/lib/memprobe.mjs --mode ledger
 *   node --expose-gc bench/lib/memprobe.mjs --mode cell --artifact standalone.html --proto v1 --path streaming
 *   node --expose-gc bench/lib/memprobe.mjs --mode throughput
 *
 * ---------------------------------------------------------------------------
 * FOUR MODES, BECAUSE FOUR DIFFERENT QUANTITIES NEED FOUR DIFFERENT PROCESSES
 * ---------------------------------------------------------------------------
 *
 *   stages      The send and receive pipelines broken into stages, on the
 *               largest artifact. This is the original probe and it is where
 *               the sender-side numbers and the `toTransport` rope come from.
 *   ledger      Exact byte accounting from `artifacts/pipeline.js`'s own copy
 *               ledger, over every artifact, both protocols, both receivers,
 *               plus the crossover scan. Deterministic arithmetic: it makes no
 *               RSS claim, so it does not need a process to itself.
 *   cell        ONE receiver on ONE artifact under ONE protocol, alone in a
 *               process. This is the only mode entitled to report peak RSS,
 *               because RSS is a high-water mark that never comes back down:
 *               measure two receivers in one process and the second inherits
 *               the first's peak. Twelve of these are spawned.
 *   throughput  Wall time for the same twelve cells, median of repeats, in a
 *               process of its own so the memory modes' forced collections are
 *               not in the timings.
 *
 * ---------------------------------------------------------------------------
 * THREE WAYS TO COUNT A COPY, AND THE ONE THE BUDGET IS ABOUT
 * ---------------------------------------------------------------------------
 *
 * ADR-025 §2.2 bounds "full payload copies" at fewer than two, and criterion 1
 * asks for a count that "fails the test above 2". Three numbers in this file
 * answer that question and they do not agree, so each is named for what it
 * actually counts:
 *
 *   ledger peak       The PEAK of live receiver-held bytes over the whole
 *                     transfer, in exact payload byte lengths, from
 *                     pipeline.js's ledger. It sees a buffer that is allocated
 *                     and freed inside one call. It does not see per-object
 *                     allocator overhead, because it counts what the code asked
 *                     for rather than what the allocator handed back.
 *   ledger handover   The same ledger restricted to what is still live when the
 *                     artifact is handed over. Strictly smaller than the peak.
 *   retained          heapUsed + external after a forced collection, with the
 *                     result still referenced, minus the same measurement
 *                     before the transfer. Real bytes, allocator overhead
 *                     included — and blind to anything freed before the
 *                     collection, which is exactly the transient copy the peak
 *                     is there to catch.
 *
 * The budget is about copies that COEXIST, so the peak is the number it bounds
 * and `retained` is a corroboration of the part of the peak that survives to
 * the end. Reporting `retained` alone understates the receiver, which is what
 * this file did until 2026-08-03. See `hashPadding` in the `ledger` mode: the
 * missing copy is not modelled there, it is weighed, by sampling live bytes
 * either side of the one-shot hash with no collection in between.
 *
 * `external` is not optional in any of this. V8 keeps ArrayBuffer backing
 * stores OUTSIDE the JS heap, so a receiver holding a megabyte of Uint8Array
 * chunks shows up as a few hundred kilobytes of heapUsed, and every payload in
 * this pipeline is a typed array.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const core = require(path.join(REPO_ROOT, 'artifacts', 'core.js'));
let proto2 = null;
try {
  proto2 = require(path.join(REPO_ROOT, 'artifacts', 'proto2.js'));
} catch {
  /* reported as absent */
}
let pipeline = null;
try {
  pipeline = require(path.join(REPO_ROOT, 'artifacts', 'pipeline.js'));
} catch {
  /* reported as absent */
}

const MIB = 1024 * 1024;

function gc() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
    global.gc();
    return true;
  }
  return false;
}

/**
 * Live bytes = heapUsed + external.
 *
 * `heapUsed` alone is the wrong number here and it took a wrong answer to
 * notice: V8 keeps ArrayBuffer backing stores OUTSIDE the JS heap, so a
 * receiver holding a megabyte of Uint8Array chunks shows up as a few hundred
 * kilobytes of heapUsed. `external` is where that megabyte actually is, and
 * every payload in this pipeline is a typed array.
 */
function liveBytes() {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

/**
 * The same total, split. Strings (frames, armour) land in heapUsed; typed-array
 * payloads land in external. Keeping them apart is what lets a copy count be
 * attributed to a line of code instead of just reported.
 */
function liveSplit() {
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external };
}

// --- The corpus and the two protocols ---------------------------------------

/**
 * Every artifact this repository actually contains, smallest first. The
 * smallest one is not filler: the receiver's fixed overhead does not shrink
 * with the payload, so the worst copy ratio in the whole report is on 2,304
 * bytes and quoting only the megabyte figure would flatter the result.
 */
const CORPUS = [
  { label: 'ruvnet-demo.rvf', rel: 'artifacts/demo/ruvnet-demo.rvf' },
  { label: 'rvf_wasm_bg.wasm', rel: 'artifacts/demo/rvf_wasm_bg.wasm' },
  { label: 'standalone.html', rel: 'standalone.html' }
];

function loadCorpus() {
  const out = [];
  for (const c of CORPUS) {
    try {
      out.push({ ...c, bytes: new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, c.rel))) });
    } catch {
      /* absent — a build output may not be present */
    }
  }
  return out;
}

function loadOne(label) {
  const entry = CORPUS.find((c) => c.label === label);
  if (!entry) return null;
  try {
    return { ...entry, bytes: new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, entry.rel))) };
  } catch {
    return null;
  }
}

// The same chunk sizes artifacts/pipeline.test.js uses, so the bench and the
// test are measuring the same transfer: 512 B for v1, and for v2 the 665-byte
// payload that fills a version 19-L symbol. Both are stated because the
// receiver's overhead is dominated by ONE in-flight frame payload, so the copy
// ratio on a small artifact is mostly a statement about the chunk size.
const V1_CHUNK = 512;
const V2_CHUNK = 665;

const PROTOCOLS = {
  v1: {
    name: 'v1',
    chunk: V1_CHUNK,
    available: () => true,
    adapter: () => pipeline.V1,
    build: (bytes) =>
      core.buildFrames(bytes, { chunk: V1_CHUNK, name: 'artifact.bin', transferId: 'aaaaaaaa' }).frames,
    shipped: {
      create: () => core.createReceiver(),
      ingest: (st, f) => core.ingest(st, f),
      finalize: (st) => core.finalize(st),
      // core.finalize takes a hex-returning hash function, which is the hook
      // the transient-copy weighing needs.
      finalizeWithHash: (st, hexFn) => core.finalize(st, hexFn),
      heldBytes: (st) => {
        let n = 0;
        for (const k in st.chunks) n += st.chunks[k].length;
        return n;
      }
    }
  },
  v2: {
    name: 'v2',
    chunk: V2_CHUNK,
    available: () => !!proto2,
    adapter: () => pipeline.V2,
    build: (bytes) =>
      proto2.buildFrames(bytes, { chunk: V2_CHUNK, name: 'artifact.bin', transferId: 0x11223344 }).frames,
    shipped: {
      create: () => proto2.createReceiver(),
      ingest: (st, f) => proto2.ingest(st, f),
      finalize: (st) => proto2.finalize(st),
      // proto2.finalize takes a digest-BYTES-returning hash function.
      finalizeWithHash: (st, hexFn) =>
        proto2.finalize(st, {
          hashFn: (b) => {
            const hex = hexFn(b);
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
            return out;
          }
        }),
      heldBytes: (st) => {
        let n = 0;
        for (let i = 1; i < st.total; i++) if (st.chunks[i]) n += st.chunks[i].length;
        return n;
      }
    }
  }
};

// v2 frames are fed as BINARY on both paths — no armour anywhere in the
// receiver comparison. `toTransport` is a sender-side cost and it is measured
// as one, in the `stages` mode; putting it in the middle of a receiver
// comparison would charge the receiver for the sender's string handling.

/**
 * Runs one receiver over a frame list, draining the list as it goes.
 *
 * The drain is the whole reason this is a shared function. A real receiver's
 * camera hands it one frame at a time and it never holds the list; a harness
 * that keeps the list charges the receiver for the sender's memory, which is
 * how a copy count first came out negative here.
 */
function driveShipped(proto, frames, tick) {
  const st = proto.shipped.create();
  for (let i = 0; i < frames.length; i++) {
    proto.shipped.ingest(st, frames[i]);
    frames[i] = null;
    if (tick && (i & 63) === 0) tick();
  }
  const res = proto.shipped.finalize(st);
  if (tick) tick();
  return { state: st, result: res };
}

function driveStreaming(proto, frames, tick) {
  const st = pipeline.createReceiver(proto.adapter());
  for (let i = 0; i < frames.length; i++) {
    pipeline.ingest(st, frames[i]);
    frames[i] = null;
    if (tick && (i & 63) === 0) tick();
  }
  const res = pipeline.finalize(st);
  if (tick) tick();
  return { state: st, result: res };
}

const RECEIVERS = {
  shipped: { name: 'shipped', drive: driveShipped },
  streaming: { name: 'streaming', drive: driveStreaming }
};

// =============================================================================
// MODE: stages — the original probe, unchanged in method
// =============================================================================

let originLive = 0;

/**
 * Runs one stage with a peak-RSS sampler the stage itself drives: `tick()` is
 * called from inside the stage's loops, which is the only way to observe a
 * transient peak without a sampling thread.
 */
function stage(name, fn) {
  gc();
  const beforeLive = liveBytes();
  const beforeSplit = liveSplit();
  const beforeRss = process.memoryUsage.rss();
  let peakRss = beforeRss;
  const tick = () => {
    const r = process.memoryUsage.rss();
    if (r > peakRss) peakRss = r;
  };
  const t0 = performance.now();
  const out = fn(tick);
  const ms = performance.now() - t0;
  tick();
  gc();
  const afterLive = liveBytes();
  const afterSplit = liveSplit();
  return {
    result: out,
    record: {
      name,
      ms,
      retainedBytes: afterLive - beforeLive,
      retainedHeapBytes: afterSplit.heap - beforeSplit.heap,
      retainedExternalBytes: afterSplit.external - beforeSplit.external,
      // Everything alive at the end of this stage, above where the pipeline
      // started. Monotone in the sense that matters: its MAXIMUM is the
      // pipeline's real live-memory cost, where a sum of per-stage deltas is
      // not, because a stage that frees what a previous one allocated
      // contributes a negative.
      cumulativeLiveBytes: afterLive - originLive,
      peakRssBytes: peakRss,
      rssDeltaBytes: peakRss - beforeRss
    }
  };
}

function runStages() {
  const corpus = loadCorpus();
  if (!corpus.length) return { available: false, reason: 'no corpus artifact found' };
  const chosen = corpus[corpus.length - 1];

  const artifact = chosen.bytes;
  const N = artifact.length;
  const chunk = V1_CHUNK;
  const stages = [];
  const push = (r) =>
    stages.push({
      ...r.record,
      copies: r.record.retainedBytes / N,
      liveCopies: r.record.cumulativeLiveBytes / N
    });

  gc();
  originLive = liveBytes();
  const baselineRss = process.memoryUsage.rss();

  // Sender and receiver are measured as SEPARATE pipelines, because they are
  // separate devices. Holding the whole frame list is something this harness
  // does and a receiver never does — its camera hands it one frame at a time —
  // so the receiver stages drain the list as they consume it, and the
  // "receiver" copy counts below exclude the sender's frames entirely.
  const drain = (list, i) => {
    list[i] = null;
  };

  // --- v1 sender -------------------------------------------------------------
  let v1Frames = null;
  const v1Build = stage('v1 sender: buildFrames', (tick) => {
    const built = core.buildFrames(artifact, { chunk, name: 'artifact.bin', transferId: 'aaaaaaaa' });
    tick();
    return built;
  });
  push(v1Build);
  v1Frames = v1Build.result.frames;
  const v1SenderCopies = v1Build.record.cumulativeLiveBytes / N;
  const v1FrameCount = v1Frames.length;

  // --- v1 receiver -----------------------------------------------------------
  // The frame list is dropped as it is consumed, so what remains at the end of
  // the stage is the receiver's own state and nothing else.
  const v1Ingest = stage('v1 receiver: ingest (frames drained)', (tick) => {
    const state = core.createReceiver();
    for (let i = 0; i < v1Frames.length; i++) {
      core.ingest(state, v1Frames[i]);
      drain(v1Frames, i);
      if ((i & 63) === 0) tick();
    }
    return state;
  });
  push(v1Ingest);
  const v1ReceiverHeld = v1Ingest.record.cumulativeLiveBytes / N;

  const v1Final = stage('v1 receiver: finalize (assemble + SHA-256)', (tick) => {
    const res = core.finalize(v1Ingest.result);
    tick();
    return res;
  });
  push(v1Final);
  const v1Ok = !!(v1Final.result && v1Final.result.ok && v1Final.result.bytes.length === N);
  const v1ReceiverPeak = v1Final.record.cumulativeLiveBytes / N;

  // Release the v1 pipeline before measuring v2, or v2's stages inherit its RSS.
  v1Build.result.frames.length = 0;
  v1Ingest.result.chunks = null;
  v1Final.result.bytes = null;
  gc();

  const v2 = { available: !!proto2 };
  if (proto2) {
    // The v2 pipeline is measured from its own origin, so its copy counts are
    // not inflated by whatever the v1 pipeline failed to release.
    gc();
    originLive = liveBytes();

    const v2Chunk = V2_CHUNK;
    const v2Build = stage('v2 sender: buildFrames', (tick) => {
      const built = proto2.buildFrames(artifact, { chunk: v2Chunk, name: 'artifact.bin', transferId: 'aaaaaaaa' });
      tick();
      return built;
    });
    push(v2Build);
    const v2Frames = v2Build.result.frames;
    v2.senderFrameCopies = v2Build.record.cumulativeLiveBytes / N;

    // One frame's armour, measured with only that one frame held. This is what
    // a sender painting one symbol per frame period actually costs; the
    // whole-list stage that follows is a harness necessity, in the same way the
    // v1 frame list is, and its figure should not be read as a sender cost.
    const oneArmour = stage('v2 sender: armour, one frame retained', (tick) => {
      let s = null;
      for (let i = 0; i < v2Frames.length; i++) {
        s = proto2.toTransport(v2Frames[i]);
        if ((i & 63) === 0) tick();
      }
      return s;
    });
    push(oneArmour);
    v2.senderCopiesOneFrame = oneArmour.record.cumulativeLiveBytes / N;

    const v2Armour = stage('v2 harness: armour every frame, all retained', (tick) => {
      const out = new Array(v2Frames.length);
      for (let i = 0; i < v2Frames.length; i++) {
        out[i] = proto2.toTransport(v2Frames[i]);
        if ((i & 63) === 0) tick();
      }
      return out;
    });
    push(v2Armour);
    v2.allArmouredCopies = v2Armour.record.cumulativeLiveBytes / N;

    const v2Ingest = stage('v2 receiver: ingest (frames drained)', (tick) => {
      const state = proto2.createReceiver();
      const armoured = v2Armour.result;
      for (let i = 0; i < armoured.length; i++) {
        proto2.ingest(state, armoured[i]);
        drain(armoured, i);
        drain(v2Frames, i);
        if ((i & 63) === 0) tick();
      }
      return state;
    });
    push(v2Ingest);
    v2.receiverHeldCopies = v2Ingest.record.cumulativeLiveBytes / N;

    const v2Final = stage('v2 receiver: finalize (assemble + SHA-256)', (tick) => {
      const res = proto2.finalize(v2Ingest.result);
      tick();
      return res;
    });
    push(v2Final);
    v2.verified = !!(v2Final.result && v2Final.result.ok && v2Final.result.bytes.length === N);
    v2.chunk = v2Chunk;
    v2.frames = v2Frames.length;
    v2.receiverPeakCopies = v2Final.record.cumulativeLiveBytes / N;
  }

  const peak = Math.max(...stages.map((s) => s.peakRssBytes));
  const v1Stages = stages.filter((s) => s.name.startsWith('v1'));
  const v2Stages = stages.filter((s) => s.name.startsWith('v2'));
  // The budget is about copies that COEXIST, so it is the maximum of the live
  // measurement, never the sum of the per-stage deltas.
  const peakLive = (rows) => (rows.length ? Math.max(...rows.map((s) => s.liveCopies)) : NaN);

  return {
    available: true,
    gcAvailable: typeof global.gc === 'function',
    artifact: chosen.rel,
    artifactBytes: N,
    chunk,
    baselineRssBytes: baselineRss,
    peakRssBytes: peak,
    peakRssMiB: peak / MIB,
    peakRssAboveBaselineMiB: (peak - baselineRss) / MIB,
    budgetMiB: 128,
    withinBudget: peak <= 128 * MIB,
    copyBudget: 2,
    v1Verified: v1Ok,
    v1: {
      frames: v1FrameCount,
      senderCopies: v1SenderCopies,
      receiverHeldCopies: v1ReceiverHeld,
      receiverPeakCopies: v1ReceiverPeak
    },
    v2,
    stages,
    peakLiveCopiesV1: peakLive(v1Stages),
    peakLiveCopiesV2: peakLive(v2Stages),
    peakLiveCopies: peakLive(stages),
    withinCopyBudgetV1Receiver: v1ReceiverPeak < 2,
    withinCopyBudgetV2Receiver: proto2 ? v2.receiverPeakCopies < 2 : null
  };
}

// =============================================================================
// MODE: ledger — exact byte accounting, both receivers, every artifact
// =============================================================================

/**
 * The transient copy the retained measurement cannot see, WEIGHED rather than
 * modelled.
 *
 * `core.sha256Bytes` allocates `new Uint8Array(total)` where total is the
 * 64-byte-aligned padded length of its input, copies the whole message into it,
 * and drops it on return. pipeline.js's ledger charges that allocation from
 * what the source demonstrably does — a model, and pipeline.js says so. This
 * function measures it instead: live bytes are sampled immediately before and
 * immediately after the one-shot hash, with NO collection in between, so the
 * padded buffer is still uncollected when the second sample is taken and shows
 * up in `external` at its real size.
 *
 * The delta is compared against the modelled padded length. If the two agree,
 * the ledger's third copy is not an assumption.
 */
function weighHashPadding(proto, bytes) {
  const N = bytes.length;
  const frames = proto.build(bytes);
  const st = proto.shipped.create();
  for (let i = 0; i < frames.length; i++) {
    proto.shipped.ingest(st, frames[i]);
    frames[i] = null;
  }
  let before = 0;
  let after = 0;
  const res = proto.shipped.finalizeWithHash(st, (b) => {
    // The floor is taken with the chunk list and the assembled output both
    // live, which is what makes the delta attributable to the hash alone.
    gc();
    before = liveBytes();
    const hex = core.sha256Hex(b);
    after = liveBytes();
    return hex;
  });
  const observed = after - before;
  const modelled = pipeline.paddedLength(N);
  return {
    protocol: proto.name,
    artifactBytes: N,
    verified: !!(res && res.ok),
    observedBytes: observed,
    observedCopies: observed / N,
    modelledBytes: modelled,
    modelledCopies: modelled / N,
    // A ratio near 1 means the ledger's modelled third copy is the real one.
    observedOverModelled: observed / modelled
  };
}

/** Smallest N at which the streaming receiver's ledger peak drops under a ratio. */
function crossover(proto, threshold, maxN) {
  const measure = (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 255;
    const frames = proto.build(bytes);
    const run = driveStreaming(proto, frames, null);
    if (!run.result.ok) return { n, copies: NaN, ok: false };
    return { n, copies: run.result.copies.copies, ok: true };
  };
  // The curve is 1 + (fixed overhead)/N with a sawtooth from the frame count,
  // so it is decreasing but not strictly. Bisect, then verify by scanning.
  let lo = 1;
  let hi = maxN;
  if (measure(hi).copies >= threshold) return { threshold, bytes: null, reason: 'never below within the scan range' };
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (measure(mid).copies < threshold) hi = mid;
    else lo = mid;
  }
  // Verify the answer is a true crossing and not a sawtooth tooth: every
  // sampled size above it must also be below the threshold.
  const checks = [];
  let monotone = true;
  for (let k = 0; k < 24; k++) {
    const n = Math.min(maxN, hi + Math.round((maxN - hi) * (k / 23)));
    const m = measure(n);
    checks.push(m);
    if (!(m.copies < threshold)) monotone = false;
  }
  const at = measure(hi);
  const oneSmaller = measure(hi - 1);
  return {
    threshold,
    // The smallest artifact at which the streaming receiver's peak is under
    // the threshold, found by bisection over REAL transfers rather than by
    // evaluating the overhead formula.
    bytes: hi,
    copiesAtCrossover: at.copies,
    // One byte smaller, which must still be at or above the threshold, or the
    // bisection found a tooth rather than the crossing.
    copiesOneByteSmaller: oneSmaller.copies,
    isTrueCrossing: at.copies < threshold && oneSmaller.copies >= threshold,
    verifiedMonotoneAbove: monotone,
    samplesChecked: checks.length
  };
}

function runLedger() {
  if (!pipeline) return { available: false, reason: 'artifacts/pipeline.js not found' };
  const corpus = loadCorpus();
  if (!corpus.length) return { available: false, reason: 'no corpus artifact found' };

  const cells = [];
  for (const art of corpus) {
    for (const pname of ['v1', 'v2']) {
      const proto = PROTOCOLS[pname];
      if (!proto.available()) continue;
      const N = art.bytes.length;

      // --- the shipped receiver, under pipeline.js's own ledger --------------
      let framesA = proto.build(art.bytes);
      const buffered = pipeline.measureBuffered(proto.adapter(), framesA);
      framesA = null;
      const k = buffered.report.byKind;
      // What is still live at handover, taken from the ledger's own records
      // rather than restated: the chunk list is never cleared by either shipped
      // receiver, and the assembled output is the result.
      const handoverBytes = (k['chunk-list'] || 0) + (k['assemble-output'] || 0);

      // --- the streaming receiver --------------------------------------------
      let framesB = proto.build(art.bytes);
      const streamed = driveStreaming(proto, framesB, null);
      framesB = null;
      const srep = streamed.result.ok ? streamed.result.copies : null;
      const streamHandover = streamed.state.ledger.live;

      cells.push({
        artifact: art.label,
        artifactBytes: N,
        protocol: pname,
        chunk: proto.chunk,
        frames: proto.build(art.bytes).length,
        shipped: {
          verified: !!buffered.result.ok,
          peakBytes: buffered.report.peakLiveBytes,
          peakCopies: buffered.report.copies,
          handoverBytes,
          handoverCopies: handoverBytes / N,
          writePasses: buffered.report.writePasses,
          hashPasses: buffered.report.hashPasses,
          withinBudget: buffered.report.withinBudget,
          byKind: buffered.report.byKind
        },
        streaming: {
          verified: !!streamed.result.ok,
          peakBytes: srep ? srep.peakLiveBytes : NaN,
          peakCopies: srep ? srep.copies : NaN,
          handoverBytes: streamHandover,
          handoverCopies: streamHandover / N,
          writePasses: srep ? srep.writePasses : NaN,
          hashPasses: srep ? srep.hashPasses : NaN,
          withinBudget: srep ? srep.withinBudget : false,
          byKind: srep ? srep.byKind : null,
          // The fixed overhead, itemised, because it is the whole of the
          // small-artifact story: it does not shrink with the payload.
          overheadBytes: streamHandover - N + proto.chunk,
          openHandles: srep ? srep.openHandles : NaN
        }
      });
    }
  }

  // The transient third copy, weighed on the largest artifact available.
  const biggest = corpus[corpus.length - 1];
  const hashPadding = [];
  for (const pname of ['v1', 'v2']) {
    if (!PROTOCOLS[pname].available()) continue;
    hashPadding.push(weighHashPadding(PROTOCOLS[pname], biggest.bytes));
  }

  // Where the fixed overhead stops mattering.
  const crossovers = [];
  for (const pname of ['v1', 'v2']) {
    const proto = PROTOCOLS[pname];
    if (!proto.available()) continue;
    for (const threshold of [1.1, 1.05, 1.01]) {
      crossovers.push({ protocol: pname, chunk: proto.chunk, ...crossover(proto, threshold, 4 * 1024 * 1024) });
    }
  }

  // The ladder the crossover sits on, so the shape is visible rather than
  // asserted. Real transfers at every size, not a formula evaluated.
  const ladderSizes = [1024, 2304, 4096, 8192, 16384, 40989, 65536, 262144, 1048576, 1183759];
  const ladder = [];
  for (const n of ladderSizes) {
    const row = { bytes: n };
    for (const pname of ['v1', 'v2']) {
      const proto = PROTOCOLS[pname];
      if (!proto.available()) continue;
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 255;
      const run = driveStreaming(proto, proto.build(bytes), null);
      row[pname] = run.result.ok ? run.result.copies.copies : NaN;
    }
    ladder.push(row);
  }

  return {
    available: true,
    copyBudget: pipeline.COPY_BUDGET,
    blockBytes: pipeline.BLOCK_BYTES,
    chunks: { v1: V1_CHUNK, v2: V2_CHUNK },
    cells,
    hashPadding,
    crossovers,
    ladder,
    criteria: pipeline.ADR025_CRITERIA
  };
}

// =============================================================================
// MODE: cell — one receiver, one artifact, one protocol, alone in a process
// =============================================================================

/**
 * TWO MEASUREMENTS, TWO METHODS, AND THEY CANNOT SHARE A PROCESS.
 *
 *   retained  needs the one-time costs paid before the origin is taken. The
 *             first transfer in a fresh process compiles the parser, the
 *             receiver and the digest and grows V8's structures to fit them,
 *             and that residue does not come back on a forced collection: the
 *             very first measured transfer of the 2,304-byte demo container
 *             reports 93 COPIES, which is the interpreter warming up and
 *             nothing whatever about the receiver. So: warm-up transfers
 *             first, discarded, then five measured cycles, and the SPREAD of
 *             those five is reported next to the median as the method's own
 *             error bar.
 *   rss       needs the opposite. Peak RSS is a high-water mark that never
 *             comes back down, so a warm-up would put the warm-up's peak into
 *             the answer. It is measured COLD, on the first and only transfer
 *             in the process, which is also the honest shape: a real receiver
 *             process pays its start-up costs inside its own peak.
 *
 * Running both in one process would make one of them wrong, so the mode takes
 * `--measure` and bench/suites/memory.mjs spawns each cell twice.
 *
 * WHAT THE RETAINED METHOD CANNOT DO, MEASURED RATHER THAN ASSERTED. A control
 * cycle — the identical transfer, with the result DISCARDED before the
 * collection — should retain nothing, and instead lands anywhere in a band tens
 * of kilobytes wide, run to run. That band is measured here and reported as
 * `controlBandBytes`. On a 1.18 MB artifact it is under 2% and the retained
 * figure means something; on a 2,304-byte artifact it is several times the
 * artifact and the retained figure means nothing at all. This is the reason
 * `artifacts/pipeline.js`'s exact-byte ledger is the primary instrument here
 * and the heap is the corroboration, rather than the other way round.
 */
function runCell(artifactLabel, protoName, pathName, measure) {
  if (!pipeline) return { available: false, reason: 'artifacts/pipeline.js not found' };
  const art = loadOne(artifactLabel);
  if (!art) return { available: false, reason: `artifact ${artifactLabel} not found` };
  const proto = PROTOCOLS[protoName];
  if (!proto || !proto.available()) return { available: false, reason: `protocol ${protoName} unavailable` };
  const recv = RECEIVERS[pathName];
  if (!recv) return { available: false, reason: `unknown receiver path ${pathName}` };

  const N = art.bytes.length;
  const baselineRss = process.memoryUsage.rss();
  let frameCount = 0;
  let verified = false;
  let ms = 0;
  let ledger = null;

  const captureLedger = (run) => {
    if (pathName !== 'streaming' || !run.result.ok) return;
    ledger = {
      peakBytes: run.result.copies.peakLiveBytes,
      peakCopies: run.result.copies.copies,
      handoverBytes: run.state.ledger.live,
      handoverCopies: run.state.ledger.live / N
    };
  };

  // --- the RSS half: cold, one transfer, sampled from inside the loop --------
  if (measure === 'rss') {
    let peakRss = baselineRss;
    const tick = () => {
      const r = process.memoryUsage.rss();
      if (r > peakRss) peakRss = r;
    };
    const frames = proto.build(art.bytes);
    frameCount = frames.length;
    const t0 = performance.now();
    const run = recv.drive(proto, frames, tick);
    ms = performance.now() - t0;
    tick();
    verified = !!(run.result && run.result.ok && run.result.bytes && run.result.bytes.length === N);
    captureLedger(run);
    return {
      available: true,
      gcAvailable: typeof global.gc === 'function',
      artifact: art.label,
      artifactBytes: N,
      protocol: protoName,
      path: pathName,
      measure,
      chunk: proto.chunk,
      frames: frameCount,
      verified,
      ms,
      baselineRssBytes: baselineRss,
      peakRssBytes: peakRss,
      peakRssMiB: peakRss / MIB,
      peakRssAboveBaselineMiB: (peakRss - baselineRss) / MIB,
      budgetMiB: 128,
      withinBudget: peakRss <= 128 * MIB,
      ledger
    };
  }

  // --- the retained half: warmed, repeated, with its own error bar -----------
  const WARM_UPS = 3;
  const CYCLES = 5;
  for (let w = 0; w < WARM_UPS; w++) recv.drive(proto, proto.build(art.bytes), null);

  // The control. Identical work, result dropped before the collection, so a
  // perfect method would report zero and the spread of what it does report is
  // the resolution of everything below.
  const control = [];
  for (let c = 0; c < CYCLES; c++) {
    gc();
    const o = liveBytes();
    let run = recv.drive(proto, proto.build(art.bytes), null);
    run = null;
    gc();
    control.push(liveBytes() - o);
  }
  const controlBand = Math.max(...control.map(Math.abs));

  const samples = [];
  const heapSamples = [];
  const externalSamples = [];
  // `hold` is the ONLY reference kept across the origin, and it is cleared
  // before the next one is taken. A per-iteration `const` is not good enough:
  // the previous cycle's result stayed reachable from its stack slot, which put
  // it into the next cycle's ORIGIN and made every cycle after the first report
  // roughly zero — a receiver that appeared to retain nothing at all.
  let hold = null;
  // One extra cycle, and the first is discarded. Three warm-ups and five
  // control cycles are still not enough to stop the first MEASURED cycle
  // carrying tens of kilobytes of compaction residue — on the demo container
  // it comes out at 83 copies against a steady state of 5. Discarding it is
  // stated here rather than left as an unexplained outlier in the spread.
  for (let c = 0; c < CYCLES + 1; c++) {
    hold = null;
    gc();
    const o = liveBytes();
    const oSplit = liveSplit();
    // The frame list is built AFTER the origin and drained as it is consumed,
    // so the receiver is charged for its own memory and nothing else.
    // Measuring from after the build instead charges the receiver a NEGATIVE
    // for releasing the sender's memory.
    const frames = proto.build(art.bytes);
    frameCount = frames.length;
    const t0 = performance.now();
    hold = recv.drive(proto, frames, null);
    ms = performance.now() - t0;
    gc();
    const aSplit = liveSplit();
    if (c > 0) {
      samples.push(liveBytes() - o);
      heapSamples.push(aSplit.heap - oSplit.heap);
      externalSamples.push(aSplit.external - oSplit.external);
    }
    verified = !!(hold.result && hold.result.ok && hold.result.bytes && hold.result.bytes.length === N);
    if (!ledger) captureLedger(hold);
  }
  hold = null;

  const retained = median(samples);
  return {
    available: true,
    gcAvailable: typeof global.gc === 'function',
    artifact: art.label,
    artifactBytes: N,
    protocol: protoName,
    path: pathName,
    measure,
    warmUps: WARM_UPS,
    cycles: CYCLES,
    cyclesDiscarded: 1,
    chunk: proto.chunk,
    frames: frameCount,
    verified,
    ms,
    retainedBytes: retained,
    retainedCopies: retained / N,
    retainedMinCopies: Math.min(...samples) / N,
    retainedMaxCopies: Math.max(...samples) / N,
    retainedHeapBytes: median(heapSamples),
    retainedExternalBytes: median(externalSamples),
    controlBandBytes: controlBand,
    controlBandCopies: controlBand / N,
    controlSamples: control,
    // The rule this file applies to its own output: a retained figure whose
    // error bar is a sizeable fraction of the answer is not reported as a
    // measurement of the receiver.
    retainedResolvable: controlBand * 4 < Math.abs(retained),
    ledger
  };
}

// =============================================================================
// MODE: throughput — wall time for the same twelve cells
// =============================================================================

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function runThroughput() {
  if (!pipeline) return { available: false, reason: 'artifacts/pipeline.js not found' };
  const corpus = loadCorpus();
  if (!corpus.length) return { available: false, reason: 'no corpus artifact found' };

  const rows = [];
  for (const art of corpus) {
    const N = art.bytes.length;
    // Enough repeats that the median is not one scheduling accident, and more
    // of them on the small artifacts where a single run is a few hundred
    // microseconds.
    const reps = N > 512 * 1024 ? 11 : N > 16 * 1024 ? 31 : 61;
    for (const pname of ['v1', 'v2']) {
      const proto = PROTOCOLS[pname];
      if (!proto.available()) continue;
      for (const pathName of ['shipped', 'streaming']) {
        const recv = RECEIVERS[pathName];
        const samples = [];
        let verified = true;
        // Two untimed warm-ups, so the first sample is not paying for JIT.
        for (let w = 0; w < 2; w++) recv.drive(proto, proto.build(art.bytes), null);
        for (let r = 0; r < reps; r++) {
          const frames = proto.build(art.bytes);
          const t0 = performance.now();
          const run = recv.drive(proto, frames, null);
          samples.push(performance.now() - t0);
          if (!(run.result && run.result.ok)) verified = false;
        }
        const med = median(samples);
        rows.push({
          artifact: art.label,
          artifactBytes: N,
          protocol: pname,
          path: pathName,
          reps,
          verified,
          medianMs: med,
          minMs: Math.min(...samples),
          maxMs: Math.max(...samples),
          bytesPerSec: (N / med) * 1000,
          mibPerSec: (N / med) * 1000 / MIB
        });
      }
    }
  }

  // Frame-building is the sender's cost and is excluded from every timing
  // above; it is reported separately so the exclusion is visible.
  const senderRows = [];
  for (const art of corpus) {
    for (const pname of ['v1', 'v2']) {
      const proto = PROTOCOLS[pname];
      if (!proto.available()) continue;
      const reps = art.bytes.length > 512 * 1024 ? 11 : 31;
      const samples = [];
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now();
        proto.build(art.bytes);
        samples.push(performance.now() - t0);
      }
      senderRows.push({
        artifact: art.label,
        artifactBytes: art.bytes.length,
        protocol: pname,
        reps,
        medianMs: median(samples)
      });
    }
  }

  return { available: true, rows, senderRows };
}

// =============================================================================

function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const MODE = argOf('mode', 'stages');
let out;
switch (MODE) {
  case 'ledger':
    out = runLedger();
    break;
  case 'cell':
    out = runCell(
      argOf('artifact', 'standalone.html'),
      argOf('proto', 'v1'),
      argOf('path', 'streaming'),
      argOf('measure', 'retained')
    );
    break;
  case 'throughput':
    out = runThroughput();
    break;
  case 'stages':
  default:
    out = runStages();
    break;
}
out.mode = MODE;
process.stdout.write(JSON.stringify(out));
