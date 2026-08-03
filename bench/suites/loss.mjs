/*!
 * Suite 1 — baseline versus fountain under frame loss.
 *
 * THE QUESTION. rvQR v1 sends a fixed set of indexed chunks and loops. The
 * receiver needs every distinct index, so a frame it misses can only be
 * replaced by the *same* frame coming round again — one specific symbol out of
 * the whole cycle. A fountain stream sends symbols that are all
 * interchangeable: any K plus a small excess reconstruct the object, and it
 * does not matter which K. This suite measures what that difference is worth.
 *
 * THE METRIC. Slots. One slot is one frame period — one QR symbol painted on
 * the sender's screen, whether or not the receiver's camera got it. Slots are
 * what the user experiences, because slots times the frame period is how long
 * they have to hold the phone still. Frames *delivered* is reported alongside,
 * because that is what shows the coding overhead.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { baselineTransport, fountainTransport, runTrial } from '../lib/transports.mjs';
import { makeChannel, expectedBaselineSlots } from '../lib/channel.mjs';
import { deriveSeed } from '../lib/rng.mjs';
import { summarize } from '../lib/stats.mjs';

export const LOSS_RATES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];

// Re-exported so the entry point can build a manifest sweep without reaching
// into the transports module itself.
export { fountainTransport };

/**
 * One cell of the results grid: `trials` independent transfers of the same
 * payload over the same codec at the same loss rate, each with its own channel
 * realisation derived from the base seed.
 */
function runCell(transport, { lossRate, channelKind, trials, baseSeed, meanBurst }) {
  const slots = [];
  const delivered = [];
  const overhead = [];
  const codingOverhead = [];
  const decodeMs = [];
  let failures = 0;
  let unverified = 0;

  const maxSlots = Math.max(20000, transport.distinct * 600);

  for (let t = 0; t < trials; t++) {
    const seed = deriveSeed(baseSeed, `${channelKind}:${lossRate}:${t}`);
    const channel = makeChannel(channelKind, lossRate, seed, { meanBurst });
    const r = runTrial(transport, channel, { maxSlots });
    if (!r.complete) {
      failures++;
      continue;
    }
    if (!r.verified) unverified++;
    slots.push(r.slots);
    delivered.push(r.delivered);
    overhead.push(r.overhead);
    if (Number.isFinite(r.codingOverhead)) codingOverhead.push(r.codingOverhead);
    decodeMs.push(r.decodeMs);
  }

  // The distribution of the excess matters more than its mean. A code that
  // needs zero extra symbols 99 times in 100 and one extra symbol otherwise
  // has the same mean as one that always needs 0.01, and they are not the same
  // code. RFC 6330 states RaptorQ's guarantee in exactly this shape.
  const overheadHistogram = {};
  for (const o of overhead) overheadHistogram[o] = (overheadHistogram[o] || 0) + 1;
  const codingOverheadHistogram = {};
  for (const o of codingOverhead) codingOverheadHistogram[o] = (codingOverheadHistogram[o] || 0) + 1;

  return {
    lossRate,
    channelKind,
    trials,
    failures,
    unverified,
    slots: summarize(slots),
    delivered: summarize(delivered),
    overhead: summarize(overhead),
    overheadHistogram,
    codingOverhead: summarize(codingOverhead),
    codingOverheadHistogram,
    decodeMs: summarize(decodeMs),
    // Fraction of delivered payload frames that were coding excess.
    overheadPct: summarize(overhead).mean / transport.distinct
  };
}

/**
 * How much the manifest repaint interval costs.
 *
 * A fountain stream still has one frame nobody can substitute for: the manifest
 * that names the object and carries its hash. If it is repainted every M slots
 * and the receiver misses it, the receiver waits — and that wait is invisible
 * in any analysis that only counts source symbols. On a small object the wait
 * can dominate the entire transfer, which is why this sweep exists.
 */
export function runManifestSweep({
  bytes,
  payloadName,
  chunk = 512,
  trials = 200,
  baseSeed = 20260802,
  intervals = [4, 8, 16, 20, 32],
  lossRates = [0, 0.2, 0.4, 0.6]
} = {}) {
  const rows = [];
  for (const manifestEvery of intervals) {
    const t = fountainTransport(bytes, {
      symbolSize: chunk,
      name: payloadName,
      scheme: 'shipped',
      seed: baseSeed,
      manifestEvery
    });
    if (!t) return { available: false };
    rows.push({
      manifestEvery,
      K: t.K,
      cells: lossRates.map((lossRate) =>
        runCell(t, { lossRate, channelKind: 'iid', trials, baseSeed, meanBurst: 3 })
      )
    });
  }
  return { available: true, payload: payloadName, payloadBytes: bytes.length, chunk, trials, lossRates, rows };
}

export function runLossSuite({
  bytes,
  payloadName,
  chunk = 512,
  trials = 200,
  baseSeed = 20260802,
  channelKind = 'iid',
  meanBurst = 3,
  schemes = ['shipped', 'rlf-sys', 'rlf', 'lt']
} = {}) {
  const transports = [];

  const base = baselineTransport(bytes, { chunk, name: payloadName });
  transports.push(base);

  for (const scheme of schemes) {
    const f = fountainTransport(bytes, { symbolSize: chunk, name: payloadName, scheme, seed: baseSeed });
    if (f) transports.push(f);
  }

  const results = [];
  for (const transport of transports) {
    const cells = [];
    for (const lossRate of LOSS_RATES) {
      cells.push(runCell(transport, { lossRate, channelKind, trials, baseSeed, meanBurst }));
    }
    results.push({
      label: transport.label,
      kind: transport.kind,
      scheme: transport.scheme || null,
      provenance: transport.provenance || 'artifacts/core.js (shipped v1 path)',
      distinct: transport.distinct,
      frames: transport.n ?? null,
      K: transport.K ?? null,
      symbolSize: transport.symbolSize,
      manifestEvery: transport.manifestEvery ?? null,
      cells
    });
  }

  // Closed-form expectation for the baseline, printed next to the measurement
  // as a check that the simulator is simulating what we think it is.
  const analytic = LOSS_RATES.map((p) => ({
    lossRate: p,
    expectedSlots: expectedBaselineSlots(base.n, p)
  }));

  return {
    payload: payloadName,
    payloadBytes: bytes.length,
    chunk,
    trials,
    baseSeed,
    channelKind,
    meanBurst: channelKind === 'gilbert' ? meanBurst : null,
    lossRates: LOSS_RATES,
    analyticBaseline: analytic,
    transports: results
  };
}
