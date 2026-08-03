/*!
 * Deterministic pseudo-random number generation for the rvQR benchmark harness.
 *
 * Every random decision in this harness — which frames the channel drops, which
 * source symbols a fountain symbol XORs together, which bytes a delta test
 * mutates — comes from one of these generators, seeded from an integer that is
 * printed alongside every result. Re-running with the same seed reproduces the
 * same numbers exactly.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

/**
 * mulberry32: a 32-bit generator with a 2^32 period, good statistical quality
 * for simulation work, and — the property that matters here — a two-line
 * definition that anyone can reimplement to check our results.
 *
 * Source: Tommy Ettinger's mulberry32, public domain.
 * https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randInt(rand, n) {
  return Math.floor(rand() * n) % n;
}

/**
 * Derives a distinct child seed from a base seed and a label, so that (for
 * example) the channel and the codec inside the same trial do not share a
 * stream and accidentally correlate. FNV-1a over the label, mixed with the seed.
 */
export function deriveSeed(baseSeed, label) {
  let h = 0x811c9dc5 ^ (baseSeed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic pseudo-random bytes, for synthetic payloads. */
export function randomBytes(rand, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256) & 255;
  return out;
}
