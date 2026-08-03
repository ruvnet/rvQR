#!/usr/bin/env node
/*!
 * Memory probe — runs the real send and receive paths on the largest artifact
 * in the repository and reports what they cost.
 *
 * Run under `--expose-gc`, in its own process, because both of those matter:
 *
 *   - Without a forced collection, `heapUsed` is whatever the collector has not
 *     got round to yet, and a "retained bytes" figure taken from it is noise.
 *   - In the benchmark's own process, RSS would already carry every frame,
 *     symbol and QR matrix the other suites allocated, and the peak would be
 *     theirs rather than the stage's.
 *
 * bench/suites/memory.mjs spawns this and reads the JSON on stdout. It is also
 * runnable by hand:
 *
 *   node --expose-gc bench/lib/memprobe.mjs
 *
 * TWO NUMBERS PER STAGE, AND THEY ARE DIFFERENT THINGS.
 *
 *   retained   heapUsed after a forced collection, with the stage's output
 *              still referenced, minus the same measurement before the stage.
 *              This is what the stage COSTS TO HOLD, and dividing it by the
 *              artifact size gives the copy count directly.
 *   peak RSS   the highest resident set observed while the stage ran, sampled
 *              inside its loops. This is what the stage costs to RUN, transient
 *              garbage included, and it is the number a 128 MiB budget is
 *              about.
 *
 * A copy count derived from retained bytes is a measurement of live payload
 * multiples, not an allocator trace. It cannot see a buffer that was allocated
 * and freed inside one stage; the peak-RSS column is what catches those, and
 * where the two disagree the report says so.
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

const MIB = 1024 * 1024;

function gc() {
  if (typeof global.gc === 'function') {
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

function run() {
  const candidates = ['standalone.html', 'artifacts/demo/rvf_wasm_bg.wasm', 'artifacts/demo/ruvnet-demo.rvf'];
  let chosen = null;
  for (const rel of candidates) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, rel)));
      if (!chosen || bytes.length > chosen.bytes.length) chosen = { rel, bytes };
    } catch {
      /* absent */
    }
  }
  if (!chosen) return { available: false, reason: 'no corpus artifact found' };

  const artifact = chosen.bytes;
  const N = artifact.length;
  const chunk = 512;
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

    const v2Chunk = 665; // the armoured payload that fills a version 19-L symbol
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

process.stdout.write(JSON.stringify(run()));
