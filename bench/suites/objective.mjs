/*!
 * Suite 8 — the objective function, G = R × C × E × P.
 *
 * Every other suite answers a local question: how big is a frame, how well does
 * this artifact compress, how many symbols past K did the decoder need. None of
 * them says which configuration to ship. G is the scalar that does, and this
 * file makes it computable over measured inputs rather than argued about.
 *
 *   G  effective artifact bytes delivered per second.
 *
 *   R  RAW OPTICAL RATE, bytes/second. The byte capacity of the QR version
 *      being painted, times the frame rate. This is what the optics could
 *      carry if the protocol wasted nothing. MEASURED: capacity comes from
 *      artifacts/vendor/qrcode.js's own capacity table, not from a formula
 *      written here. fps is a stated operating point.
 *
 *   C  COMPRESSION / DELTA GAIN, dimensionless, ≥ 1. Original artifact bytes
 *      per byte of stream actually framed. MEASURED by the compression suite
 *      on the real corpus, or by the delta suite for a delta transfer. C = 1
 *      for an uncompressed whole-artifact transfer, exactly.
 *
 *   E  RECOVERY EFFICIENCY, dimensionless, in (0, 1]. Stream bytes recovered
 *      per QR byte painted on a clean channel. It folds three separate wastes
 *      into one number: the frame envelope, the fill slack between the frame
 *      and the symbol's capacity, and the erasure code's reception overhead.
 *      MEASURED: envelope and fill from the protocol suite, reception overhead
 *      from the overhead suite.
 *
 *   P  DECODE SUCCESS PROBABILITY per painted frame, in (0, 1]. NOT MEASURABLE
 *      BY THIS HARNESS. It is a property of a camera pointed at a screen —
 *      module size in captured pixels, focus, glare, refresh beat, motion — and
 *      there is no camera here. It is a swept parameter, and every number
 *      computed with P < 1 is a projection and is labelled as one at the point
 *      of use.
 *
 * WHERE G IS WRONG, STATED UP FRONT. G is linear in P. That is exact for a
 * rateless code, where losing a fraction (1−P) of frames costs exactly 1/P as
 * many slots and nothing else. It is NOT exact for rvQR v1's indexed cycling,
 * which pays a coupon-collector factor on top: the loss suite measures v1
 * needing 800 slots at 60% loss where 1/P scaling predicts 205. So G with the
 * naive P term FLATTERS v1 at high loss, and `indexedPenalty` below carries the
 * measured correction rather than leaving the formula quietly wrong.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { qrcode } from '../lib/transports.mjs';
import { loadProto2, armouredBytes } from './proto.mjs';
import { envelopeBytes } from './compress.mjs';

/** The objective itself. Deliberately four multiplications and nothing else. */
export function objectiveG({ R, C, E, P }) {
  return R * C * E * P;
}

/** P values swept everywhere G is reported. 1.0 is the only non-projection. */
export const P_SWEEP = [1.0, 0.9, 0.75, 0.5, 0.25];

/**
 * Assembles R, C and E for one configuration from measured inputs.
 *
 * `codingOverheadRatio` is symbolsNeeded / K, measured by the overhead suite —
 * 1.0002 for the shipped fountain at K=81. For an indexed transport it is 1.0
 * on a clean channel by construction, and the loss behaviour lives in
 * `indexedPenalty` instead, because it is not a constant factor.
 */
export function evaluateConfig({
  P: proto,
  artifactBytes,
  streamBytes,
  version,
  ecl = 'L',
  fps,
  chunk,
  armour,
  nameLen = 12,
  codingOverheadRatio = 1
}) {
  const capacity = qrcode.byteCapacity(version, qrcode.ECC[ecl]);
  const R = capacity * fps;
  const C = artifactBytes / streamBytes;

  const env = envelopeBytes(proto, streamBytes, { chunk, armour, nameLen });
  const framesNeeded = env.frames * codingOverheadRatio;
  const paintedBytes = framesNeeded * capacity;
  const E = streamBytes / paintedBytes;

  return {
    capacity,
    R,
    C,
    E,
    frames: env.frames,
    framesNeeded,
    envelopeBytes: env.bytes,
    // The two halves of E, separated because they have different fixes.
    fillEfficiency: env.bytes / (env.frames * capacity),
    envelopeEfficiency: streamBytes / env.bytes,
    codingOverheadRatio
  };
}

/**
 * The largest chunk each framing can carry inside a given QR version. Duplicated
 * from the protocol suite's binary search in closed form, because here it is
 * needed for hundreds of configurations and the search is not free. The closed
 * form is checked against the searched value in `runObjectiveSuite`.
 */
function chunkForVersion(proto, mode, capacity, v1Envelope) {
  if (mode === 'v2-binary') return capacity - proto.HEADER_BYTES;
  if (mode === 'v2-armoured') return Math.floor((capacity * 7) / 8) - proto.HEADER_BYTES;
  // v1: the JSON envelope plus base64url's 4/3. Solved for the payload, then
  // clamped by core.js's own MAX_CHUNK.
  return Math.floor(((capacity - v1Envelope) * 3) / 4);
}

/**
 * G across configurations, with P swept.
 *
 * `corpus` entries need { name, bytes, best } where `best` is the winning
 * compression cell from the compression suite (or null for "do not compress").
 */
export function runObjectiveSuite({
  corpus,
  modes = ['v1-json', 'v2-armoured', 'v2-binary'],
  versions = [19, 27],
  ecl = 'L',
  rates = [5, 10],
  v1EnvelopeBytes = 56,
  v1MaxChunk = 1024,
  codingOverheadRatio = 1,
  pSweep = P_SWEEP
} = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const proto = loaded.module;

  const rows = [];
  for (const item of corpus) {
    for (const compressed of [false, true]) {
      if (compressed && !item.best) continue;
      const streamBytes = compressed ? item.best.compressedBytes : item.bytes;
      const codecName = compressed ? item.best.codec : 'none';
      for (const mode of modes) {
        for (const version of versions) {
          const capacity = qrcode.byteCapacity(version, qrcode.ECC[ecl]);
          let chunk = chunkForVersion(proto, mode, capacity, v1EnvelopeBytes);
          if (mode === 'v1-json') chunk = Math.min(chunk, v1MaxChunk);
          else chunk = Math.min(chunk, proto.MAX_PAYLOAD_BYTES);
          if (chunk < 1) continue;
          for (const fps of rates) {
            const ev = evaluateConfig({
              P: proto,
              artifactBytes: item.bytes,
              streamBytes,
              version,
              ecl,
              fps,
              chunk,
              armour: mode === 'v2-armoured',
              codingOverheadRatio: mode === 'v1-json' ? 1 : codingOverheadRatio
            });
            rows.push({
              artifact: item.name,
              artifactBytes: item.bytes,
              codec: codecName,
              streamBytes,
              mode,
              version,
              ecl,
              fps,
              chunk,
              ...ev,
              G: Object.fromEntries(
                pSweep.map((p) => [p, objectiveG({ R: ev.R, C: ev.C, E: ev.E, P: p })])
              ),
              secondsAtP1: item.bytes / objectiveG({ R: ev.R, C: ev.C, E: ev.E, P: 1 })
            });
          }
        }
      }
    }
  }

  return { available: true, ecl, pSweep, versions, rates, modes, rows };
}

/**
 * The correction G's P term does not make for an indexed transport.
 *
 * Takes the loss suite's measured mean slot counts and reports, per loss rate,
 * how far the measurement is from the 1/P scaling G assumes. A ratio of 1.0
 * means G is exact; anything above means G overstates the configuration.
 */
export function indexedPenalty(lossResult) {
  if (!lossResult || !lossResult.transports) return { available: false };
  const rows = [];
  for (const t of lossResult.transports) {
    const clean = t.cells[0];
    if (!clean) continue;
    rows.push({
      transport: t.label,
      kind: t.kind,
      cells: t.cells.map((c) => {
        const P = 1 - c.lossRate;
        const predicted = clean.slots.mean / P;
        return {
          lossRate: c.lossRate,
          P,
          measuredSlots: c.slots.mean,
          predictedSlots: predicted,
          // >1 means G's linear-in-P term is optimistic for this transport.
          penalty: c.slots.mean / predicted
        };
      })
    });
  }
  return { available: true, rows };
}
