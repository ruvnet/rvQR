/*!
 * Suite 10 — progressive activation: time to the first trusted closure.
 *
 * A 40-second transfer that is useless for 40 seconds and a 40-second transfer
 * that is doing something after 2 are different products. Splitting an RVF into
 * independently signed closures — manifest and policy, then a minimal runtime,
 * then required code and hot state, then cold indexes and optional assets —
 * lets the receiver verify and start on closure 1 while closure 4 is still
 * crossing the channel.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A MODEL. No such split exists in this repository yet.
 * ---------------------------------------------------------------------------
 *
 * artifacts/rvf.js parses containers and artifacts/delta.js walks their spans,
 * but nothing signs a closure and nothing activates one. So what is computed
 * here is arithmetic over MEASURED inputs — real span sizes from the demo
 * container, the real WASM runtime's size, and the effective byte rates the
 * protocol suite measured — and not an observation of a running system. The
 * arithmetic is the easy part; whether a partially transferred RVF can actually
 * execute is a runtime question this harness cannot answer.
 *
 * What the model does account for: each closure is independently signed, so it
 * pays its own signature and its own manifest frame, and closure boundaries do
 * not align with frame boundaries, so each closure rounds up to a whole number
 * of frames. Both of those make small closures relatively more expensive, which
 * is exactly the effect that decides whether a 3-second first closure is
 * reachable.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { core } from '../lib/transports.mjs';
import { loadProto2 } from './proto.mjs';
import { envelopeBytes } from './compress.mjs';

/** The target the design is aiming at. */
export const FIRST_CLOSURE_TARGET_SECONDS = 3;

/**
 * Ed25519, because that is what a detached signature over a closure costs if
 * the scheme is the obvious one. core.js declares SIGNATURE_SIZE = 16, which is
 * a truncated tag rather than any standard signature; the report notes the
 * discrepancy rather than silently picking one.
 */
export const ED25519_SIGNATURE_BYTES = 64;

/**
 * Closure profiles. Sizes marked `measured` come from real files in this
 * repository; the rest are the model's assumptions and are labelled as such in
 * every table.
 */
export function closureProfiles({ rvfBytes, wasmBytes, appBytes, rvfSpans }) {
  const profiles = [];

  if (rvfSpans && rvfSpans.length) {
    // The demo container, split along its own span boundaries. Every size here
    // is measured by artifacts/delta.js's span plan.
    const manifests = rvfSpans.filter((s) => s.typeName === 'MANIFEST');
    const witness = rvfSpans.filter((s) => s.typeName === 'WITNESS');
    const vec = rvfSpans.filter((s) => s.typeName === 'VEC');
    profiles.push({
      name: 'ruvnet-demo.rvf, split on its own spans',
      measured: true,
      total: rvfBytes,
      closures: [
        { name: 'manifest + policy', bytes: manifests.reduce((a, s) => a + s.length, 0), measured: true },
        { name: 'witness', bytes: witness.reduce((a, s) => a + s.length, 0), measured: true },
        { name: 'vector payload', bytes: vec.reduce((a, s) => a + s.length, 0), measured: true }
      ]
    });
  }

  // An agent-shaped artifact: the real 40 KB RVF WASM runtime as closure 2, a
  // modelled policy header, and modelled code/state and cold segments sized so
  // the whole thing is 1 MiB.
  const hot = 192 * 1024;
  const manifestPolicy = 512;
  const cold = 1024 * 1024 - manifestPolicy - wasmBytes - hot;
  profiles.push({
    name: '1 MiB agent container (modelled split, real runtime size)',
    measured: false,
    total: 1024 * 1024,
    closures: [
      { name: 'manifest + policy', bytes: manifestPolicy, measured: false },
      { name: 'minimal RVM runtime', bytes: wasmBytes, measured: true },
      { name: 'required code + hot state', bytes: hot, measured: false },
      { name: 'cold indexes + optional assets', bytes: cold, measured: false }
    ]
  });

  // The standalone app, which is the largest real artifact in the repository.
  profiles.push({
    name: 'standalone.html (modelled 4-way split, real total)',
    measured: false,
    total: appBytes,
    closures: [
      { name: 'manifest + policy', bytes: 512, measured: false },
      { name: 'minimal RVM runtime', bytes: 32 * 1024, measured: false },
      { name: 'required code + hot state', bytes: 128 * 1024, measured: false },
      { name: 'cold indexes + optional assets', bytes: appBytes - 512 - 32 * 1024 - 128 * 1024, measured: false }
    ]
  });

  return profiles;
}

/**
 * Wire cost of one independently signed closure: its bytes, its signature, and
 * its own manifest frame, rounded up to whole frames.
 */
function closureWire(P, bytes, { chunk, armour, signatureBytes, nameLen = 16 }) {
  const stream = bytes + signatureBytes;
  const env = envelopeBytes(P, stream, { chunk, armour, nameLen });
  return { streamBytes: stream, ...env };
}

/**
 * Time to each closure, and to the whole artifact, at one transport rate.
 *
 * `fps` is slots per second; `capacity` the QR byte capacity of the version
 * being painted. A frame occupies one slot whether or not it is full, so time
 * is frames over fps and the capacity only enters through how many frames the
 * closure needs.
 */
export function activationTimeline({
  P,
  profile,
  chunk,
  armour,
  fps,
  signatureBytes = ED25519_SIGNATURE_BYTES,
  successProbability = 1
}) {
  let cumulativeFrames = 0;
  const steps = profile.closures.map((c) => {
    const w = closureWire(P, c.bytes, { chunk, armour, signatureBytes });
    // A lost frame costs a slot and buys nothing; with a rateless code the slot
    // count scales as 1/P and nothing else. P < 1 makes every row a projection.
    const slots = w.frames / successProbability;
    cumulativeFrames += slots;
    return {
      name: c.name,
      measured: !!c.measured,
      bytes: c.bytes,
      streamBytes: w.streamBytes,
      frames: w.frames,
      slots,
      seconds: slots / fps,
      cumulativeSeconds: cumulativeFrames / fps,
      // The rate at which THIS closure would land inside the three-second
      // target. For closure 1 it is usually trivial; for the runtime closure it
      // is the number that says whether "trusted and useful in 3 seconds" is a
      // design or a wish.
      fpsNeededForTarget: cumulativeFrames / FIRST_CLOSURE_TARGET_SECONDS
    };
  });
  return {
    steps,
    totalSeconds: cumulativeFrames / fps,
    firstClosureSeconds: steps.length ? steps[0].cumulativeSeconds : NaN,
    meetsTarget: steps.length ? steps[0].cumulativeSeconds < FIRST_CLOSURE_TARGET_SECONDS : false
  };
}

/**
 * The number that actually answers the design question: at each transport
 * rate, how big can the first closure be and still land inside three seconds?
 *
 * Solved by walking frame counts rather than by inverting the envelope
 * arithmetic, so the signature, the manifest frame and the round-up to whole
 * frames are all inside the answer.
 */
export function maxFirstClosureBytes({
  P,
  chunk,
  armour,
  fps,
  signatureBytes = ED25519_SIGNATURE_BYTES,
  successProbability = 1,
  target = FIRST_CLOSURE_TARGET_SECONDS
}) {
  const slotBudget = target * fps * successProbability;
  const frameBudget = Math.floor(slotBudget);
  // One frame is the manifest, so the payload gets frameBudget − 1.
  const dataFrames = frameBudget - 1;
  if (dataFrames < 1) return { frameBudget, bytes: 0, feasible: false };
  const bytes = dataFrames * chunk - signatureBytes;
  return { frameBudget, dataFrames, bytes: Math.max(0, bytes), feasible: bytes > 0 };
}

export function runClosureSuite({
  profiles,
  transports,
  signatureBytes = ED25519_SIGNATURE_BYTES,
  successProbabilities = [1, 0.75, 0.5]
} = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const P = loaded.module;

  const timelines = [];
  for (const profile of profiles) {
    for (const t of transports) {
      timelines.push({
        profile: profile.name,
        profileMeasured: profile.measured,
        transport: t.label,
        chunk: t.chunk,
        fps: t.fps,
        ...activationTimeline({
          P,
          profile,
          chunk: t.chunk,
          armour: t.armour,
          fps: t.fps,
          signatureBytes
        })
      });
    }
  }

  const budgets = [];
  for (const t of transports) {
    for (const sp of successProbabilities) {
      budgets.push({
        transport: t.label,
        chunk: t.chunk,
        fps: t.fps,
        successProbability: sp,
        projection: sp < 1,
        ...maxFirstClosureBytes({
          P,
          chunk: t.chunk,
          armour: t.armour,
          fps: t.fps,
          signatureBytes,
          successProbability: sp
        })
      });
    }
  }

  return {
    available: true,
    model: true,
    signatureBytes,
    declaredSignatureSize: core.SIGNATURE_SIZE,
    target: FIRST_CLOSURE_TARGET_SECONDS,
    successProbabilities,
    timelines,
    budgets
  };
}
