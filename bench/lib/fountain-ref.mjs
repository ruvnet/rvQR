/*!
 * Reference fountain codecs for the rvQR benchmark harness.
 *
 * WHAT THIS IS AND IS NOT
 * ----------------------------------------------------------------------------
 * rvQR's roadmap calls for a RaptorQ (RFC 6330) fountain layer in
 * artifacts/fountain.js. At the time these benchmarks were written that file
 * did not exist, so the harness carries its own codecs. They are NOT RaptorQ
 * and the report must never claim they are. What they are is two well-understood
 * points that bracket RaptorQ's reception-overhead behaviour from both sides:
 *
 *   `lt`      Luby Transform codes with the robust soliton distribution and a
 *             peeling (belief-propagation) decoder — Luby, "LT Codes", FOCS
 *             2002. Linear-time decoding, but poor overhead at the small block
 *             sizes rvQR actually uses. This is a PESSIMISTIC proxy: a real
 *             RaptorQ layer will do better.
 *
 *   `rlf`     Random linear fountain over GF(2) with online Gaussian
 *             elimination. Reception overhead of ~1.6 symbols regardless of K,
 *             which is essentially the information-theoretic floor for a
 *             rateless erasure code. Decoding is O(K^3/word) rather than
 *             RaptorQ's O(K), so it is not a proxy for RaptorQ's *speed*, only
 *             for its *overhead*. This is an OPTIMISTIC proxy: RaptorQ is
 *             designed to approach this and does not beat it.
 *
 *   `rlf-sys` The same code made systematic: encoding symbol IDs 0..K-1 are the
 *             source symbols themselves, and repair symbols begin at K. RaptorQ
 *             is systematic, so this is the closest of the three to what rvQR
 *             would actually ship, and the only one that costs nothing on a
 *             clean channel.
 *
 * A real RaptorQ implementation should land between `lt` and `rlf` on overhead
 * and above both on decode speed. When artifacts/fountain.js exists, the
 * harness measures it instead and these become the reference points it is
 * scored against.
 *
 * Both codecs derive a symbol's neighbour set deterministically from its
 * encoding symbol ID, exactly as LT and RaptorQ do, so the receiver never needs
 * the sender to describe the combination — the ID is enough.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { mulberry32 } from './rng.mjs';

/** Mixes a stream seed and an encoding symbol ID into a per-symbol seed. */
function symbolSeed(streamSeed, esi) {
  let h = (streamSeed ^ 0x9e3779b9) >>> 0;
  h = (Math.imul(h ^ esi, 0x85ebca6b) ^ (esi >>> 3)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0) || 1;
  return h >>> 0;
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

// --- Degree distributions ----------------------------------------------------

/**
 * Robust soliton distribution (Luby 2002). c and delta are the usual tuning
 * knobs; c = 0.1 and delta = 0.05 are the values most commonly reported for
 * practical LT implementations and are what we use unless a suite overrides
 * them. Returns a cumulative distribution over degrees 1..K.
 */
export function robustSolitonCdf(K, c = 0.1, delta = 0.05) {
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));

  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const tau = new Float64Array(K + 1);
  const pivot = Math.floor(K / R);
  for (let d = 1; d < pivot; d++) tau[d] = R / (d * K);
  if (pivot >= 1 && pivot <= K) tau[pivot] = (R * Math.log(R / delta)) / K;

  let beta = 0;
  for (let d = 1; d <= K; d++) beta += rho[d] + tau[d];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += (rho[d] + tau[d]) / beta;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  return cdf;
}

function sampleDegree(cdf, K, u) {
  // Linear scan: K is at most a few thousand here and this runs once per
  // symbol, so a binary search would be optimising the wrong thing.
  for (let d = 1; d <= K; d++) if (u <= cdf[d]) return d;
  return K;
}

/** d distinct indices in [0, K), sampled without replacement. */
function distinctIndices(rand, K, d) {
  if (d >= K) {
    const all = new Array(K);
    for (let i = 0; i < K; i++) all[i] = i;
    return all;
  }
  const seen = new Set();
  const out = [];
  while (out.length < d) {
    const i = Math.floor(rand() * K) % K;
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

// --- Source block partitioning ----------------------------------------------

/**
 * Splits a payload into K symbols of exactly T bytes, zero-padding the last.
 * The true byte length travels in the manifest, so padding is unambiguous.
 */
export function partition(source, T) {
  const K = Math.max(1, Math.ceil(source.length / T));
  const symbols = new Array(K);
  for (let i = 0; i < K; i++) {
    const s = new Uint8Array(T);
    s.set(source.subarray(i * T, Math.min((i + 1) * T, source.length)));
    symbols[i] = s;
  }
  return { K, T, symbols };
}

// --- Encoders ----------------------------------------------------------------

/**
 * Neighbour set for one encoding symbol ID under the chosen scheme. Pure and
 * deterministic: both ends compute it from the ESI alone.
 */
export function neighbours(scheme, esi, K, streamSeed, cdf) {
  if (scheme === 'rlf-sys' && esi < K) return [esi];
  const rand = mulberry32(symbolSeed(streamSeed, esi));
  if (scheme === 'lt') {
    const d = sampleDegree(cdf, K, rand());
    return distinctIndices(rand, K, d);
  }
  // Random linear fountain: each source symbol joins independently with
  // probability 1/2, which is the uniform distribution over non-empty subsets
  // once the degenerate empty draw is repaired.
  const out = [];
  for (let i = 0; i < K; i++) if (rand() < 0.5) out.push(i);
  if (!out.length) out.push(Math.floor(rand() * K) % K);
  return out;
}

export function createEncoder({ source, symbolSize, scheme, seed }) {
  const { K, T, symbols } = partition(source, symbolSize);
  const cdf = scheme === 'lt' ? robustSolitonCdf(K) : null;
  return {
    K,
    T,
    scheme,
    seed,
    /** The encoding symbol with the given ID. Deterministic. */
    symbol(esi) {
      const nb = neighbours(scheme, esi, K, seed, cdf);
      const out = new Uint8Array(T);
      for (const i of nb) xorInto(out, symbols[i]);
      return out;
    }
  };
}

// --- Decoders ----------------------------------------------------------------

/**
 * Peeling decoder for LT codes. Maintains, for each unresolved source index,
 * the list of received symbols still depending on it; resolving an index
 * cascades through that list. Linear in the number of edges.
 */
function createPeelingDecoder(K, T, seed, scheme) {
  const cdf = scheme === 'lt' ? robustSolitonCdf(K) : null;
  const resolved = new Array(K).fill(null);
  const byIndex = Array.from({ length: K }, () => []);
  let solved = 0;
  let received = 0;

  function resolve(index, sym) {
    if (resolved[index]) return;
    resolved[index] = sym;
    solved++;
    const queue = [index];
    while (queue.length) {
      const j = queue.pop();
      const entries = byIndex[j];
      byIndex[j] = [];
      for (const entry of entries) {
        if (!entry.rem.has(j)) continue;
        xorInto(entry.sym, resolved[j]);
        entry.rem.delete(j);
        if (entry.rem.size === 1) {
          const k = entry.rem.values().next().value;
          if (!resolved[k]) {
            resolved[k] = entry.sym;
            solved++;
            queue.push(k);
          }
          entry.rem.clear();
        }
      }
    }
  }

  return {
    get rank() {
      return solved;
    },
    get received() {
      return received;
    },
    add(esi, bytes) {
      received++;
      if (solved >= K) return true;
      const nb = neighbours(scheme, esi, K, seed, cdf);
      const sym = bytes.slice();
      const rem = new Set();
      for (const i of nb) {
        if (resolved[i]) xorInto(sym, resolved[i]);
        else rem.add(i);
      }
      if (rem.size === 0) return solved >= K; // fully redundant
      if (rem.size === 1) {
        resolve(rem.values().next().value, sym);
      } else {
        const entry = { rem, sym };
        for (const i of rem) byIndex[i].push(entry);
      }
      return solved >= K;
    },
    recover() {
      if (solved < K) return null;
      const out = new Uint8Array(K * T);
      for (let i = 0; i < K; i++) out.set(resolved[i], i * T);
      return out;
    }
  };
}

/**
 * Online Gaussian elimination over GF(2) for the random linear fountain. Each
 * arriving symbol is reduced against the pivots already held; if anything is
 * left it becomes a new pivot. When K pivots exist the system is solved and one
 * back-substitution pass recovers the source block.
 *
 * Coefficient rows are bitsets in Uint32Array words, so a row reduction is a
 * handful of word XORs whatever K is.
 */
function createGaussianDecoder(K, T, seed, scheme) {
  const words = (K + 31) >>> 5;
  const pivots = new Array(K).fill(null);
  let rank = 0;
  let received = 0;

  const bit = (row, i) => (row[i >>> 5] >>> (i & 31)) & 1;
  const clearBit = (row, i) => {
    row[i >>> 5] &= ~(1 << (i & 31));
  };
  const xorRow = (dst, src) => {
    for (let w = 0; w < words; w++) dst[w] ^= src[w];
  };

  return {
    get rank() {
      return rank;
    },
    get received() {
      return received;
    },
    add(esi, bytes) {
      received++;
      if (rank >= K) return true;
      const coef = new Uint32Array(words);
      for (const i of neighbours(scheme, esi, K, seed, null)) {
        coef[i >>> 5] ^= 1 << (i & 31);
      }
      const sym = bytes.slice();
      for (let p = 0; p < K; p++) {
        if (!bit(coef, p)) continue;
        if (pivots[p]) {
          xorRow(coef, pivots[p].coef);
          xorInto(sym, pivots[p].sym);
        } else {
          pivots[p] = { coef, sym };
          rank++;
          return rank >= K;
        }
      }
      return rank >= K; // linearly dependent, contributed nothing
    },
    recover() {
      if (rank < K) return null;
      for (let p = K - 1; p >= 0; p--) {
        for (let q = 0; q < p; q++) {
          if (bit(pivots[q].coef, p)) {
            xorInto(pivots[q].sym, pivots[p].sym);
            clearBit(pivots[q].coef, p);
          }
        }
      }
      const out = new Uint8Array(K * T);
      for (let i = 0; i < K; i++) out.set(pivots[i].sym, i * T);
      return out;
    }
  };
}

export function createDecoder({ K, symbolSize, scheme, seed }) {
  if (scheme === 'lt') return createPeelingDecoder(K, symbolSize, seed, scheme);
  return createGaussianDecoder(K, symbolSize, seed, scheme);
}

export const SCHEMES = ['lt', 'rlf', 'rlf-sys'];

export const SCHEME_NOTES = {
  lt: 'LT code, robust soliton (c=0.1, delta=0.05), peeling decoder. Pessimistic proxy for RaptorQ.',
  rlf: 'Random linear fountain over GF(2), Gaussian elimination. Near-optimal overhead, non-systematic.',
  'rlf-sys': 'Systematic random linear fountain: ESI 0..K-1 are the source symbols. Closest model of RaptorQ.'
};
