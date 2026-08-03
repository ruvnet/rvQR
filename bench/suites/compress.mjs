/*!
 * Suite 7 — adaptive compression, judged on the whole envelope.
 *
 * A compression ratio is not a reason to compress. What decides it is whether
 * the COMPLETE transport envelope gets smaller: compressed payload, plus the
 * v2 header on every frame, plus the manifest frame, plus the armour if the
 * channel needs it. Compression removes payload bytes and leaves the per-frame
 * cost alone, so on a small artifact a good ratio can still lose — fewer bytes
 * spread over almost the same number of frames.
 *
 * So every cell here reports two things that are easy to confuse:
 *
 *   ratio          originalBytes / compressedBytes. The codec's number.
 *   envelopeGain   1 − envelope(compressed) / envelope(original). The
 *                  transport's number, and the only one that should gate a
 *                  decision to turn compression on.
 *
 * The gate is envelopeGain ≥ 8%: below that the saving does not pay for the
 * decode latency, the extra failure mode, and the codec-id negotiation. That
 * threshold is a policy choice, stated here rather than buried; the measured
 * break-even sizes below are reported against it and can be re-read against a
 * different one from the raw JSON.
 *
 * WHAT IS MEASURED. Zstd at several levels and Brotli at several qualities,
 * from node:zlib — the same algorithms proto2.js declares as codecId 3
 * (brotli), on the real corpus in this repository. Encode and decode
 * milliseconds are wall-clock on this machine, median of repeated runs.
 *
 * WHAT IS NOT. proto2.js declares CODEC_SCF1 (the zero-dependency LZ77 codec
 * from the RVF runtime) and CODEC_DEFLATE_RAW. SCF-1 has no JavaScript
 * implementation in this repository, so it cannot be measured here and is
 * absent from every table rather than estimated. Node's zstd and brotli are
 * also not the same builds a browser would run: a browser has DecompressionStream
 * for deflate and gzip only, so the brotli and zstd decode timings below are a
 * Node measurement standing in for a decoder the browser does not currently
 * expose. That is stated in the report next to the numbers.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT } from '../lib/transports.mjs';
import { loadProto2, armouredBytes } from './proto.mjs';
import { percentile } from '../lib/stats.mjs';

/** The gate: an envelope that does not shrink by this much is not worth it. */
export const ENVELOPE_GAIN_GATE = 0.08;

export const ZSTD_LEVELS = [1, 3, 6, 9, 12, 19];
export const BROTLI_QUALITIES = [4, 6, 9, 11];

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';

// --- codecs ------------------------------------------------------------------

function zstdCodec(level) {
  return {
    name: `zstd-${level}`,
    family: 'zstd',
    level,
    available: HAS_ZSTD,
    compress: (buf) =>
      zlib.zstdCompressSync(buf, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: level }
      }),
    decompress: (buf) => zlib.zstdDecompressSync(buf)
  };
}

function brotliCodec(quality) {
  return {
    name: `brotli-${quality}`,
    family: 'brotli',
    level: quality,
    available: true,
    compress: (buf) =>
      zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
        }
      }),
    decompress: (buf) => zlib.brotliDecompressSync(buf)
  };
}

export function defaultCodecs() {
  return [...ZSTD_LEVELS.map(zstdCodec), ...BROTLI_QUALITIES.map(brotliCodec)];
}

// --- the envelope ------------------------------------------------------------

/**
 * Total bytes painted for a v2 indexed transfer of a `streamBytes`-long stream.
 *
 * Every frame pays the 28-byte header. Frame zero carries the manifest body
 * (47 bytes plus the name) instead of payload, so it is a whole extra frame
 * that carries no artifact at all. Armouring multiplies each frame by 8/7,
 * rounded up per frame — not once at the end, because each frame is armoured
 * separately and each rounds up separately.
 *
 * This is arithmetic over measured constants (HEADER_BYTES, MANIFEST_FIXED_BYTES
 * from proto2.js), not a measurement, and it is checked against the real
 * builder in `verifyEnvelopeModel` below.
 */
export function envelopeBytes(P, streamBytes, { chunk = 512, armour = false, nameLen = 12 } = {}) {
  const dataFrames = Math.ceil(streamBytes / chunk);
  const per = (n) => (armour ? armouredBytes(n) : n);
  const manifestBody = P.MANIFEST_FIXED_BYTES + nameLen;
  let total = per(P.HEADER_BYTES + manifestBody);
  const full = Math.floor(streamBytes / chunk);
  const tail = streamBytes - full * chunk;
  total += full * per(P.HEADER_BYTES + chunk);
  if (tail > 0) total += per(P.HEADER_BYTES + tail);
  return { bytes: total, frames: 1 + dataFrames };
}

/** Confirms the arithmetic above against frames the real builder produced. */
function verifyEnvelopeModel(P) {
  const checks = [];
  for (const size of [1, 500, 512, 2304, 40989]) {
    for (const chunk of [256, 512, 764]) {
      const bytes = new Uint8Array(size);
      const built = P.buildFrames(bytes, { chunk, name: 'artifact.bin', transferId: 'aaaaaaaa' });
      let raw = 0;
      let arm = 0;
      for (const f of built.frames) {
        raw += f.length;
        arm += armouredBytes(f.length);
      }
      const modelRaw = envelopeBytes(P, size, { chunk, armour: false, nameLen: 12 });
      const modelArm = envelopeBytes(P, size, { chunk, armour: true, nameLen: 12 });
      checks.push({
        size,
        chunk,
        rawOk: modelRaw.bytes === raw && modelRaw.frames === built.frames.length,
        armourOk: modelArm.bytes === arm
      });
    }
  }
  return { ok: checks.every((c) => c.rawOk && c.armourOk), checks };
}

// --- timing ------------------------------------------------------------------

function timed(fn, reps) {
  fn(); // one untimed pass, so the first codec measured does not carry warm-up
  const samples = [];
  let out = null;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    out = fn();
    samples.push(performance.now() - t0);
  }
  return { ms: percentile(samples, 0.5), out, reps };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- the corpus --------------------------------------------------------------

/**
 * Every artifact in this repository big enough to be worth compressing, plus
 * one synthetic block of float32 vectors.
 *
 * The synthetic one is here because it is the case the RVF container is made
 * of and the case compression is worst at: IEEE-754 mantissas are close to
 * incompressible, and a corpus of only source code and WASM would flatter the
 * codecs. It is generated from the harness seed and is reproducible.
 */
export function loadCorpus({ seed = 20260802 } = {}) {
  const items = [];
  const add = (rel, label) => {
    const abs = path.join(REPO_ROOT, rel);
    try {
      items.push({ name: label || rel, path: rel, bytes: new Uint8Array(fs.readFileSync(abs)) });
    } catch {
      /* absent; the report lists what was found */
    }
  };
  add('artifacts/demo/ruvnet-demo.rvf');
  add('artifacts/demo/rvf_wasm_bg.wasm');
  add('artifacts/core.js');
  add('artifacts/app.js');
  add('standalone.html');

  // float32 vectors, deterministic, in the shape an RVF VEC span carries.
  const n = 4096;
  const vec = new Float32Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    vec[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  items.push({
    name: 'synthetic float32 vectors',
    path: '(generated)',
    synthetic: true,
    bytes: new Uint8Array(vec.buffer.slice(0))
  });
  return items;
}

// --- the suite ---------------------------------------------------------------

export function runCompressionSuite({
  corpus,
  codecs = defaultCodecs(),
  chunk = 512,
  armour = true,
  reps = 3
} = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const P = loaded.module;
  const envelopeCheck = verifyEnvelopeModel(P);

  const rows = [];
  for (const item of corpus) {
    const src = Buffer.from(item.bytes);
    const nameLen = Buffer.byteLength(path.basename(item.path === '(generated)' ? item.name : item.path), 'utf8');
    const baseline = envelopeBytes(P, src.length, { chunk, armour, nameLen });
    const cells = [];

    for (const codec of codecs) {
      if (!codec.available) {
        cells.push({ codec: codec.name, available: false });
        continue;
      }
      let enc;
      try {
        enc = timed(() => codec.compress(src), reps);
      } catch (err) {
        cells.push({ codec: codec.name, available: false, error: String(err.message || err) });
        continue;
      }
      const compressed = enc.out;
      const dec = timed(() => codec.decompress(compressed), reps);
      const exact = bytesEqual(new Uint8Array(dec.out), item.bytes);
      const env = envelopeBytes(P, compressed.length, { chunk, armour, nameLen });
      const gain = 1 - env.bytes / baseline.bytes;
      cells.push({
        codec: codec.name,
        family: codec.family,
        level: codec.level,
        available: true,
        compressedBytes: compressed.length,
        ratio: src.length / compressed.length,
        encodeMs: enc.ms,
        decodeMs: dec.ms,
        roundTripExact: exact,
        envelopeBytes: env.bytes,
        envelopeFrames: env.frames,
        framesSaved: baseline.frames - env.frames,
        envelopeGain: gain,
        passesGate: gain >= ENVELOPE_GAIN_GATE
      });
    }

    const usable = cells.filter((c) => c.available);
    const best = usable.length
      ? usable.reduce((a, b) => (b.envelopeGain > a.envelopeGain ? b : a))
      : null;
    rows.push({
      name: item.name,
      path: item.path,
      synthetic: !!item.synthetic,
      bytes: src.length,
      baselineEnvelopeBytes: baseline.bytes,
      baselineFrames: baseline.frames,
      cells,
      best
    });
  }

  return {
    available: true,
    zstdAvailable: HAS_ZSTD,
    chunk,
    armour,
    gate: ENVELOPE_GAIN_GATE,
    envelopeModelVerified: envelopeCheck.ok,
    headerBytes: P.HEADER_BYTES,
    reps,
    rows
  };
}

/**
 * The break-even: below what artifact size does compression stop paying?
 *
 * Prefixes of each corpus artifact are compressed for real at every size, so
 * the ratio at each point is measured rather than extrapolated from the whole
 * file's ratio. A prefix is not a smaller artifact of the same kind — the first
 * 512 bytes of a WASM module are its header, which compresses differently from
 * its code — and that caveat travels with the number.
 *
 * Two break-evens are reported and they are different questions:
 *
 *   gainBreakEven   smallest prefix whose envelope gain reaches the gate.
 *   lossBreakEven   largest prefix at which the envelope gets BIGGER. Below
 *                   this, turning compression on actively costs bytes.
 */
export function runBreakEvenSweep({
  corpus,
  codec = brotliCodec(6),
  chunk = 512,
  armour = true,
  sizes = [64, 128, 256, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 16384, 32768, 65536]
} = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const P = loaded.module;

  const rows = [];
  for (const item of corpus) {
    const nameLen = 12;
    const points = [];
    for (const size of sizes) {
      if (size > item.bytes.length) continue;
      const prefix = Buffer.from(item.bytes.subarray(0, size));
      let compressed;
      try {
        compressed = codec.compress(prefix);
      } catch {
        continue;
      }
      const base = envelopeBytes(P, size, { chunk, armour, nameLen });
      const env = envelopeBytes(P, compressed.length, { chunk, armour, nameLen });
      points.push({
        size,
        compressedBytes: compressed.length,
        ratio: size / compressed.length,
        baselineEnvelope: base.bytes,
        envelope: env.bytes,
        envelopeGain: 1 - env.bytes / base.bytes,
        frames: env.frames,
        baselineFrames: base.frames
      });
    }
    const gainPoint = points.find((p) => p.envelopeGain >= ENVELOPE_GAIN_GATE) || null;
    const losing = points.filter((p) => p.envelopeGain <= 0);
    rows.push({
      name: item.name,
      bytes: item.bytes.length,
      points,
      gainBreakEven: gainPoint ? gainPoint.size : null,
      lossBreakEven: losing.length ? Math.max(...losing.map((p) => p.size)) : null
    });
  }
  return { available: true, codec: codec.name, chunk, armour, gate: ENVELOPE_GAIN_GATE, sizes, rows };
}
