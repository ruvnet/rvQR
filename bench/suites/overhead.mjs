/*!
 * Suite 5 — reception overhead of the shipped codec, measured at the codec.
 *
 * This suite deliberately bypasses the frame envelope, the manifest schedule
 * and everything else the transport does. It hands encoding symbols straight to
 * a decoder across a lossy channel and asks one question: how many symbols past
 * K did it need? That is the code's reception overhead and nothing else.
 *
 * It exists because the loss suite's headline overhead figure is *not* that.
 * There, a receiver holding every symbol still cannot finish until a manifest
 * arrives, and symbols that land during that wait get counted. The two numbers
 * measure different things and the report keeps them apart.
 *
 * The configuration mirrors the one artifacts/fountain.js's author reports, so
 * the two are directly comparable: K from 4 to 800, 45% independent loss, every
 * decode verified against SHA-256 of the source. This is an independent
 * reproduction, not a restatement — the numbers here are what this harness
 * measured, and where they disagree with the author's the report says so.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { core, loadShippedFountain } from '../lib/transports.mjs';
import { mulberry32, randomBytes, deriveSeed } from '../lib/rng.mjs';
import { summarize } from '../lib/stats.mjs';

export const DEFAULT_K_VALUES = [4, 8, 16, 32, 64, 81, 128, 200, 320, 500, 800];

/**
 * One decode: stream symbols from ESI 0 upward, drop each with probability
 * `lossRate`, stop when the decoder says it can reconstruct, then verify.
 */
function oneDecode(F, source, symbolSize, lossRate, seed, maxSymbols) {
  const enc = F.encoder(source, symbolSize);
  const dec = F.decoder(enc.K, symbolSize, source.length);
  const rand = mulberry32(seed);

  let consumed = 0;
  let esi = 0;
  const t0 = performance.now();
  while (esi < maxSymbols) {
    const sym = enc.symbol(esi++);
    if (rand() < lossRate) continue;
    consumed++;
    if (dec.add(sym)) break;
  }
  const out = dec.decode();
  const decodeMs = performance.now() - t0;

  const verified = out !== null && core.sha256Hex(out) === core.sha256Hex(source);
  return { K: enc.K, consumed, overhead: consumed - enc.K, verified, decodeMs };
}

/**
 * Decode cost alone, with no channel: hand the decoder exactly the symbols it
 * needs and time the reconstruction. Two variants, because they differ a lot:
 * the systematic case (ESIs 0..K-1, no repair) is nearly free, and the
 * repair-only case (ESIs K..2K-1) is the worst case a lossy channel produces.
 */
function decodeCost(F, source, symbolSize, { repairOnly, reps = 3 }) {
  const setup0 = performance.now();
  const enc = F.encoder(source, symbolSize);
  const setupMs = performance.now() - setup0;

  const symbols = [];
  const base = repairOnly ? enc.K : 0;
  for (let i = 0; i < enc.K; i++) symbols.push(enc.symbol(base + i));

  // One untimed pass first. Without it the first configuration measured in a
  // process carries the JIT's warm-up cost and reads slower than a larger one
  // measured afterwards, which is how a sweep ends up non-monotonic in a way
  // the code is not.
  const run = () => {
    const dec = F.decoder(enc.K, symbolSize, source.length);
    for (const s of symbols) dec.add(s);
    return dec.decode();
  };
  run();

  const times = [];
  let out = null;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    out = run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);

  return {
    K: enc.K,
    symbolSize,
    setupMs,
    decodeMs: times[Math.floor(times.length / 2)],
    verified: out !== null && core.sha256Hex(out) === core.sha256Hex(source)
  };
}

export function runOverheadSuite({
  kValues = DEFAULT_K_VALUES,
  symbolSize = 512,
  lossRate = 0.45,
  decodesPerK = 200,
  baseSeed = 20260802
} = {}) {
  const shipped = loadShippedFountain();
  if (!shipped) return { available: false, reason: 'artifacts/fountain.js not present' };
  const F = shipped.module;

  const rows = [];
  const allOverheads = [];
  let unverified = 0;

  for (const K of kValues) {
    const rand = mulberry32(deriveSeed(baseSeed, `payload:${K}`));
    // A payload sized so the encoder derives exactly this K.
    const source = randomBytes(rand, K * symbolSize);
    const overheads = [];
    const times = [];
    let bad = 0;

    for (let t = 0; t < decodesPerK; t++) {
      const r = oneDecode(
        F,
        source,
        symbolSize,
        lossRate,
        deriveSeed(baseSeed, `decode:${K}:${t}`),
        K * 40 + 200
      );
      if (r.K !== K) throw new Error(`expected K=${K}, encoder derived ${r.K}`);
      if (!r.verified) bad++;
      overheads.push(r.overhead);
      times.push(r.decodeMs);
      allOverheads.push(r.overhead);
    }
    unverified += bad;

    const hist = {};
    for (const o of overheads) hist[o] = (hist[o] || 0) + 1;

    rows.push({
      K,
      decodes: decodesPerK,
      unverified: bad,
      overhead: summarize(overheads),
      histogram: hist,
      atZero: (hist[0] || 0) / decodesPerK,
      byOne: ((hist[0] || 0) + (hist[1] || 0)) / decodesPerK,
      byTwo: ((hist[0] || 0) + (hist[1] || 0) + (hist[2] || 0)) / decodesPerK,
      decodeMs: summarize(times)
    });
  }

  const aggHist = {};
  for (const o of allOverheads) aggHist[o] = (aggHist[o] || 0) + 1;
  const n = allOverheads.length;

  return {
    available: true,
    symbolSize,
    lossRate,
    kValues,
    totalDecodes: n,
    unverified,
    aggregate: {
      histogram: aggHist,
      mean: allOverheads.reduce((a, b) => a + b, 0) / n,
      max: Math.max(...allOverheads),
      atZero: (aggHist[0] || 0) / n,
      byOne: ((aggHist[0] || 0) + (aggHist[1] || 0)) / n,
      byTwo: ((aggHist[0] || 0) + (aggHist[1] || 0) + (aggHist[2] || 0)) / n
    },
    rows
  };
}

/**
 * Decode cost against symbol size on a fixed payload, which is the trade the
 * app's chunk-size slider actually makes: smaller symbols mean more of them,
 * and decoding grows faster than linearly in K.
 */
export function runSymbolSizeSweep({ bytes, symbolSizes = [1024, 512, 256, 128, 64] } = {}) {
  const shipped = loadShippedFountain();
  if (!shipped) return { available: false };
  const F = shipped.module;
  return {
    available: true,
    payloadBytes: bytes.length,
    rows: symbolSizes.map((T) => ({
      symbolSize: T,
      systematic: decodeCost(F, bytes, T, { repairOnly: false }),
      repairOnly: decodeCost(F, bytes, T, { repairOnly: true })
    }))
  };
}
