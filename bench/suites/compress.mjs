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
 * ---------------------------------------------------------------------------
 * SUITE 7b — THE DECISION MODULE, artifacts/compress.js
 * ---------------------------------------------------------------------------
 *
 * Everything above is a codec grid: this harness compresses with node:zlib and
 * applies the gate itself. That measures the CODECS. It does not measure the
 * module that ships the decision, and since `artifacts/compress.js` landed
 * there is a second question — not "how much does brotli save" but "what does
 * the sender actually decide, and does it decide it for the right reason".
 *
 * So the second half of this file drives `artifacts/compress.js` end to end
 * (`runDecisionSuite`, `runSampledPath`, `runGateBand`) and nothing in the
 * first half changed: the grid, the envelope model, `verifyEnvelopeModel` and
 * `runBreakEvenSweep` are byte-for-byte what they were, and the two halves
 * share `loadCorpus` so their rows are directly comparable.
 *
 * THREE THINGS ABOUT THE SECOND HALF ARE WORTH STATING BEFORE THE NUMBERS.
 *
 * 1. THE MODULE'S UNIT TESTS PROVE NOTHING ABOUT RATIOS, by design. Most of
 *    `compress.test.js` injects stub codecs that return a fixed size, so the
 *    verdicts there are arithmetic a reader can check by hand and are
 *    independent of what this machine has installed. This suite injects the
 *    REAL node:zlib codecs, so every ratio, gain, frame count and millisecond
 *    below came out of a codec that actually ran.
 *
 * 2. THE LEVEL BELONGS TO THE CALLER, NOT TO THE MODULE. `compressArtifact`
 *    takes its codecs as an injected map keyed by codec NAME, and has no
 *    parameter that could turn brotli-11 into brotli-4. Every level this suite
 *    injects is therefore part of the measurement and is printed with it.
 *
 * 3. THE DIFFERENCE BETWEEN THE TWO GAINS IS THE WHOLE POINT, so both are
 *    reported in every row, passing or failing, and the gate's own arithmetic
 *    is exercised at the boundary rather than only where the answer is obvious.
 *    A gate that only ever says yes is not a gate.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../lib/transports.mjs';
import { loadProto2, armouredBytes } from './proto.mjs';
import { percentile } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

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

// =============================================================================
// Suite 7b — the shipped decision module, artifacts/compress.js
// =============================================================================

export function loadCompressModule() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'compress.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

/**
 * The levels this suite injects, and they are a measurement input rather than
 * a property of the module: `compressArtifact` receives its codecs as a map
 * keyed by codec NAME and cannot change what level they run at.
 *
 * These are Node's own defaults for brotli (quality 11) and zstd (level 3),
 * plus deflate at 9. ADR-003 §2.1 names brotli the maximum-ratio option and
 * zstd the default, so injecting brotli at its maximum and zstd at its default
 * is the configuration §2.1 describes — and it is the one where the two codecs
 * are furthest apart, which is what makes the decision visible at all.
 */
export const CODEC_LEVELS = { brotli: 11, zstd: 3, 'deflate-raw': 9 };

/** The fast levels for the >8 MB prefix estimate ADR-003 §2.3 asks for. */
export const SAMPLE_CODEC_LEVELS = { brotli: 4, zstd: 1, 'deflate-raw': 1 };

function brotliAt(quality) {
  return {
    compress: (bytes) =>
      zlib.brotliCompressSync(bytes, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length
        }
      }),
    decompress: (bytes) => zlib.brotliDecompressSync(bytes)
  };
}

function zstdAt(level) {
  return {
    compress: (bytes) =>
      zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }),
    decompress: (bytes) => zlib.zstdDecompressSync(bytes)
  };
}

function deflateAt(level) {
  return {
    compress: (bytes) => zlib.deflateRawSync(bytes, { level }),
    decompress: (bytes) => zlib.inflateRawSync(bytes)
  };
}

/**
 * The injected codec map, keyed by codec NAME because that is the key
 * `compressWith` looks up — a map keyed by numeric id fails with
 * `codec-unavailable`, which is a real trap and is why this is one function
 * rather than an object literal repeated at each call site.
 *
 * A codec absent from node:zlib is absent from the map rather than stubbed, so
 * a platform without zstd measures a two-codec decision and says so.
 */
export function nodeCodecs(levels = CODEC_LEVELS) {
  const out = {};
  if (typeof zlib.brotliCompressSync === 'function') out.brotli = brotliAt(levels.brotli);
  if (typeof zlib.zstdCompressSync === 'function') out.zstd = zstdAt(levels.zstd);
  if (typeof zlib.deflateRawSync === 'function') out['deflate-raw'] = deflateAt(levels['deflate-raw']);
  return out;
}

/**
 * The platform handed to `detectCodecs`, with the real globals rather than a
 * fabricated pair.
 *
 * `CompressionStream` is passed through deliberately even though this suite
 * never uses it: Node accepts `new CompressionStream('brotli')` and no browser
 * does, and the module's refusal to promote that probe into a browser
 * capability is only observable if the probe actually runs.
 */
export function platformEnv() {
  return {
    zlib,
    CompressionStream: typeof CompressionStream === 'function' ? CompressionStream : null,
    DecompressionStream: typeof DecompressionStream === 'function' ? DecompressionStream : null
  };
}

/**
 * Deterministic bytes with no structure for a codec to find.
 *
 * The corpus above has no artifact a codec loses on — every real file in this
 * repository compresses — so the decline case would be unmeasurable without
 * one. This is a mulberry32 stream taken a byte at a time from the harness
 * seed, so it reproduces exactly; whether it is genuinely incompressible is
 * not asserted here, it is the measurement in the table below.
 */
export function incompressibleBytes(n, seed) {
  const out = new Uint8Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

/**
 * The corpus above plus the one case it cannot contain.
 *
 * `loadCorpus` is left exactly as it was, so the codec grid and the break-even
 * sweep still report the rows the previous revision of this document reported;
 * the incompressible block is appended here and appears only in the decision
 * tables.
 */
export function decisionCorpus({ seed = 20260802, randomBytes = 40000 } = {}) {
  const items = loadCorpus({ seed });
  // The manifest frame carries the artifact's name, so the name's length is a
  // term in the envelope. A generated artifact has no name on disk, so it is
  // given a plausible one here rather than being left to a default — the
  // envelope has to be computed against something and a made-up 12 would be a
  // number nothing produced.
  for (const item of items) {
    if (item.path === '(generated)') item.filename = 'vectors.f32';
  }
  items.push({
    name: 'incompressible random bytes',
    path: '(generated)',
    filename: 'random.bin',
    synthetic: true,
    bytes: incompressibleBytes(randomBytes, (seed ^ 0x5bf03635) >>> 0)
  });
  return items;
}

function basenameFor(item) {
  if (item.filename) return item.filename;
  return item.path === '(generated)' ? 'generated.bin' : path.basename(item.path);
}

/**
 * A verdict label derived from the margin, not a second gate.
 *
 * "Marginal" is this report's word for a pass with less than two points of
 * envelope gain in hand, and it exists so a reader can tell a decision that
 * was never close from one that turned on the threshold. The module knows
 * nothing about it: it passes or it does not.
 */
const MARGINAL_BAND = 0.02;

function verdictFor(compress, margin) {
  if (!compress) return 'declined';
  return margin < MARGINAL_BAND ? 'marginal pass' : 'pass';
}

/**
 * What the sender decides, per artifact, with the real codecs behind it.
 *
 * Timings are taken HERE and not by the module, which times nothing on
 * purpose: a decision that read a clock would not be reproducible. So the
 * columns divide cleanly — the verdict is the module's, the milliseconds are
 * the harness's, and the two are never mixed in one number.
 *
 * The round trip is not decoration either. A ratio without a verified round
 * trip is a claim about a byte count, so every codec that produced a stream is
 * decompressed and compared against the original bytes, and the encode is
 * re-run to confirm it reproduces the length the module decided on.
 */
export function runDecisionSuite({
  corpus,
  chunk = null,
  armour = true,
  reps = 3,
  gate = null
} = {}) {
  const loaded = loadCompressModule();
  if (!loaded) return { available: false, reason: 'artifacts/compress.js not present' };
  const C = loaded.module;

  const codecs = nodeCodecs();
  const injected = Object.keys(codecs);
  if (!injected.length) {
    return { available: false, reason: 'node:zlib exposes no synchronous codec on this platform' };
  }

  const env = platformEnv();
  const detection = C.detectCodecs(env);
  const useChunk = chunk === null ? C.DEFAULT_CHUNK_BYTES : chunk;
  const useGate = gate === null ? C.ENVELOPE_GAIN_GATE : gate;

  const rows = [];
  for (const item of corpus) {
    const src = Buffer.from(item.bytes);
    const base = basenameFor(item);
    const nameLen = Buffer.byteLength(base, 'utf8');

    let decision;
    try {
      decision = C.compressArtifact(src, {
        env,
        codecs,
        chunk: useChunk,
        armour,
        nameLen,
        gate: useGate
      });
    } catch (err) {
      rows.push({ name: item.name, bytes: src.length, error: String(err.reason || err.message || err) });
      continue;
    }

    // Timings and the round trip, per codec the module actually considered.
    const cells = decision.considered.map((cell) => {
      const impl = codecs[cell.codecName];
      const enc = timed(() => impl.compress(src), reps);
      const dec = timed(() => impl.decompress(enc.out), reps);
      return {
        codecId: cell.codecId,
        codec: cell.codecName,
        level: CODEC_LEVELS[cell.codecName],
        compressedBytes: cell.compressedBytes,
        ratio: cell.ratio,
        payloadGain: cell.payloadGain,
        envelopeBefore: cell.envelopeBefore,
        envelopeAfter: cell.envelopeAfter,
        envelopeGain: cell.envelopeGain,
        framesBefore: cell.framesBefore,
        framesAfter: cell.framesAfter,
        framesSaved: cell.framesSaved,
        margin: cell.margin,
        passesGate: cell.passesGate,
        encodeMs: enc.ms,
        decodeMs: dec.ms,
        roundTripExact: bytesEqual(new Uint8Array(dec.out), item.bytes),
        // The module decided on a length; re-encoding must reproduce it, or the
        // codec is not deterministic and no row here means anything.
        reproducesDecisionLength: enc.out.length === cell.compressedBytes,
        wire: C.wireCompatible(cell.codecId)
      };
    });

    // When the decision declines there is no winner, so the best of what was
    // considered is reported instead — flagged, because "the best codec" and
    // "the chosen codec" are different facts and a declined row has only the
    // first.
    const chosen = decision.best
      ? cells.find((c) => c.codecId === decision.best.codecId)
      : null;
    const bestOffered = cells.length
      ? cells.reduce((a, b) => (b.envelopeGain > a.envelopeGain ? b : a))
      : null;
    const reported = chosen || bestOffered;

    rows.push({
      name: item.name,
      path: item.path,
      synthetic: !!item.synthetic,
      bytes: src.length,
      nameLen,
      kind: C.classifyArtifact(src),
      preference: C.preferenceOrder(src, detection, {}).map((id) => C.codecById(id).name),

      compress: decision.compress,
      codecId: decision.codecId,
      codecName: decision.codecName,
      dictId: decision.dictId,
      streamBytes: decision.streamBytes,

      // Both gains, always, whichever way the verdict went.
      payloadGain: reported ? reported.payloadGain : 0,
      envelopeGain: reported ? reported.envelopeGain : 0,
      ratio: reported ? reported.ratio : 1,
      margin: reported ? reported.margin : -useGate,
      envelopeBefore: reported ? reported.envelopeBefore : decision.envelopeBytes,
      envelopeAfter: decision.compress ? decision.envelopeBytes : (reported ? reported.envelopeAfter : decision.envelopeBytes),
      framesBefore: reported ? reported.framesBefore : decision.frames,
      framesAfter: decision.compress ? decision.frames : (reported ? reported.framesAfter : decision.frames),
      baselineEnvelopeBytes: reported ? reported.envelopeBefore : decision.envelopeBytes,
      baselineFrames: reported ? reported.framesBefore : decision.frames,

      verdict: verdictFor(decision.compress, reported ? reported.margin : -useGate),
      reportedCodec: reported ? reported.codec : null,
      reportedIsChosen: !!chosen,
      wire: decision.wire,
      decoder: decision.decoder.description,
      reason: decision.reason,
      allRoundTripped: cells.every((c) => c.roundTripExact),
      allLengthsReproduced: cells.every((c) => c.reproducesDecisionLength),
      cells
    });
  }

  return {
    available: true,
    path: loaded.path,
    chunk: useChunk,
    armour,
    gate: useGate,
    reps,
    marginalBand: MARGINAL_BAND,
    levels: CODEC_LEVELS,
    injected,
    detection: {
      available: detection.available.map((c) => ({ id: c.id, name: c.name, via: c.via })),
      unavailable: detection.codecs
        .filter((c) => !c.available)
        .map((c) => ({ id: c.id, name: c.name, reason: c.reason })),
      streamFormats: detection.streamFormats,
      nonStandardStreamFormats: detection.nonStandardStreamFormats,
      hasCompressionStreams: detection.hasCompressionStreams
    },
    divergence: C.describeWireDivergence(),
    rows
  };
}

/**
 * The >8 MB branch, run below 8 MB because nothing here is 8 MB.
 *
 * ADR-003 §2.3 estimates on a bounded prefix above the threshold, and this
 * repository ships no artifact that reaches it — so the branch would go
 * unmeasured entirely unless the threshold moves. It is moved here, and that
 * is the one thing about this table that is not the shipped configuration:
 * `sampleAbove` and `samplePrefix` are arguments, everything else is what a
 * sender would do.
 *
 * The question it answers is the one §2.3's flow makes load-bearing: a prefix
 * that DECLINES is final for that codec, so a codec whose first bytes compress
 * differently from its body is refused without ever being measured. The
 * unsampled decision is run alongside, and the two are compared.
 */
export function runSampledPath({
  corpus,
  sampleAbove = 32 * 1024,
  samplePrefix = 16 * 1024,
  chunk = null,
  armour = true
} = {}) {
  const loaded = loadCompressModule();
  if (!loaded) return { available: false, reason: 'artifacts/compress.js not present' };
  const C = loaded.module;
  const codecs = nodeCodecs();
  const sampleCodecs = nodeCodecs(SAMPLE_CODEC_LEVELS);
  if (!Object.keys(codecs).length) {
    return { available: false, reason: 'node:zlib exposes no synchronous codec on this platform' };
  }
  const env = platformEnv();
  const useChunk = chunk === null ? C.DEFAULT_CHUNK_BYTES : chunk;

  const rows = [];
  for (const item of corpus) {
    if (item.bytes.length <= sampleAbove) continue;
    const src = Buffer.from(item.bytes);
    const nameLen = Buffer.byteLength(basenameFor(item), 'utf8');
    const common = { env, codecs, chunk: useChunk, armour, nameLen };

    const whole = C.compressArtifact(src, common);
    const sampled = C.compressArtifact(src, {
      ...common,
      sampleCodecs,
      sampleAbove,
      samplePrefix
    });

    rows.push({
      name: item.name,
      bytes: src.length,
      prefixBytes: sampled.samplePrefixBytes,
      sampled: sampled.sampled,
      sampleCodecsDistinct: sampled.sampleCodecsDistinct,

      wholeCodec: whole.codecName,
      wholeStreamBytes: whole.streamBytes,
      wholeGain: whole.best ? whole.best.envelopeGain : 0,

      sampledCodec: sampled.codecName,
      sampledStreamBytes: sampled.streamBytes,
      sampledGain: sampled.best ? sampled.best.envelopeGain : 0,

      sameDecision: whole.codecId === sampled.codecId && whole.streamBytes === sampled.streamBytes,
      declined: sampled.declined.map((d) => ({
        codec: d.codecName,
        estimateGain: d.estimate.envelopeGain,
        estimatePayloadGain: d.estimate.payloadGain
      })),
      overturned: sampled.overturned.map((o) => ({
        codecId: o.codecId,
        estimateGain: o.estimateGain,
        measuredGain: o.measuredGain
      })),
      // What the declined codecs would have measured on the WHOLE artifact, so
      // the cost of a prefix's "no" is a number rather than a worry.
      declinedCost: sampled.declined.map((d) => {
        const full = whole.considered.find((c) => c.codecId === d.codecId);
        return {
          codec: d.codecName,
          estimateGain: d.estimate.envelopeGain,
          fullGain: full ? full.envelopeGain : null,
          fullPassed: full ? full.passesGate : null
        };
      })
    });
  }

  return {
    available: true,
    sampleAbove,
    samplePrefix,
    chunk: useChunk,
    armour,
    fastLevels: SAMPLE_CODEC_LEVELS,
    fullLevels: CODEC_LEVELS,
    rows
  };
}

/**
 * The band the module exists for: payload clears the gate, envelope does not.
 *
 * `compress.js`'s docblock publishes six size pairs said to land in that band.
 * Those are arithmetic, not measurements, so they are re-derived here through
 * the module's own `evaluate()` and printed beside what the docblock claims —
 * a divergence would mean the module's documentation and its code disagree.
 *
 * Then the same question is asked of real bytes, which is a different question
 * and can have a different answer: prefixes of every corpus artifact are
 * compressed for real and every point where the two figures fall on opposite
 * sides of the gate is collected. Text and WASM clear both by a mile; the band
 * lives where the ratio is poor, which is where the float vectors are.
 */
export const DOCBLOCK_BAND = [
  { original: 600, compressed: 543, claimPayload: '9.50%', claimEnvelope: '7.95%', claimFrames: '2 → 2' },
  { original: 764, compressed: 694, claimPayload: '9.16%', claimEnvelope: '7.95%', claimFrames: '2 → 2' },
  { original: 1000, compressed: 909, claimPayload: '9.10%', claimEnvelope: '7.95%', claimFrames: '3 → 3' },
  { original: 1528, compressed: 1395, claimPayload: '8.70%', claimEnvelope: '7.95%', claimFrames: '3 → 3' },
  { original: 3000, compressed: 2745, claimPayload: '8.50%', claimEnvelope: '7.98%', claimFrames: '5 → 5' },
  { original: 10000, compressed: 9190, claimPayload: '8.10%', claimEnvelope: '7.99%', claimFrames: '15 → 14' }
];

export function runGateBand({
  corpus,
  // Deliberately dense between 1.5 KB and 4 KB: that is where the float-vector
  // rows cross the gate, and a sparse ladder would step straight over the band
  // and report it absent.
  sizes = [
    512, 764, 1024, 1280, 1528, 1792, 2048, 2304, 2560, 2816,
    3072, 3328, 3584, 4096, 6144, 8192, 12288, 16384, 24576, 32768
  ],
  chunk = null,
  armour = true
} = {}) {
  const loaded = loadCompressModule();
  if (!loaded) return { available: false, reason: 'artifacts/compress.js not present' };
  const C = loaded.module;
  const codecs = nodeCodecs();
  if (!codecs.brotli) return { available: false, reason: 'node:zlib has no synchronous brotli here' };
  const useChunk = chunk === null ? C.DEFAULT_CHUNK_BYTES : chunk;

  // The docblock's own table, re-derived through the module.
  const claimed = DOCBLOCK_BAND.map((row) => {
    const cell = C.evaluate({
      originalBytes: row.original,
      compressedBytes: row.compressed,
      codecId: C.CODEC_BROTLI,
      chunk: C.DEFAULT_CHUNK_BYTES,
      armour: true,
      nameLen: 12
    });
    const frames = `${cell.framesBefore} → ${cell.framesAfter}`;
    return {
      ...row,
      payloadGain: cell.payloadGain,
      envelopeGain: cell.envelopeGain,
      frames,
      inBand: cell.payloadGain >= cell.gate && cell.envelopeGain < cell.gate,
      agrees:
        pctText(cell.payloadGain) === row.claimPayload &&
        pctText(cell.envelopeGain) === row.claimEnvelope &&
        frames === row.claimFrames
    };
  });

  // The same question on real bytes.
  const rows = [];
  for (const item of corpus) {
    const points = [];
    for (const size of sizes) {
      if (size > item.bytes.length) continue;
      const prefix = Buffer.from(item.bytes.subarray(0, size));
      const compressed = codecs.brotli.compress(prefix);
      const cell = C.evaluate({
        originalBytes: size,
        compressedBytes: compressed.length,
        codecId: C.CODEC_BROTLI,
        chunk: useChunk,
        armour,
        nameLen: 12
      });
      points.push({
        size,
        compressedBytes: compressed.length,
        payloadGain: cell.payloadGain,
        envelopeGain: cell.envelopeGain,
        framesBefore: cell.framesBefore,
        framesAfter: cell.framesAfter,
        framesSaved: cell.framesSaved,
        passesGate: cell.passesGate,
        // The gap runs both ways, and both ways matter. A payload rule turns
        // compression ON in the first case and OFF in the second, and it is
        // wrong both times.
        inBand: cell.payloadGain >= cell.gate && cell.envelopeGain < cell.gate,
        inReverseBand: cell.envelopeGain >= cell.gate && cell.payloadGain < cell.gate,
        envelopeGrew: cell.envelopeGain < 0
      });
    }
    // Whether the verdict is monotone in size. It is easy to assume it must be
    // — bigger artifact, better ratio, more headroom — and the frame count is a
    // step function, so it is not.
    let flips = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].passesGate !== points[i - 1].passesGate) flips++;
    }
    rows.push({
      name: item.name,
      bytes: item.bytes.length,
      points,
      band: points.filter((p) => p.inBand),
      reverseBand: points.filter((p) => p.inReverseBand),
      grew: points.filter((p) => p.envelopeGrew),
      verdictFlips: flips,
      monotone: flips <= 1
    });
  }

  return {
    available: true,
    codec: `brotli-${CODEC_LEVELS.brotli}`,
    chunk: useChunk,
    armour,
    gate: C.ENVELOPE_GAIN_GATE,
    sizes,
    claimed,
    rows
  };
}

function pctText(fraction) {
  return (fraction * 100).toFixed(2) + '%';
}

/**
 * ADR-003 §2.3 quotes `standalone.html` at 503,216 B compressing 3.535× under
 * Brotli in 8.38 ms. The file is no longer that size. Both figures are
 * re-measured here against whatever the file is now, and the DIFFERENCE is
 * reported rather than either number being quietly replaced: the ADR's figures
 * were true of the file it measured, and a decision record whose evidence
 * silently updates itself stops being a record.
 */
// --- The browser, which has neither codec ADR-003 chose -----------------------

/**
 * The WHATWG Compression Streams format list, and the whole of it.
 *
 * This is the constraint that decides what the shipped web app can actually do,
 * and it is not a detail: `br`, `brotli` and `zstd` are not on it. ADR-003 §2.1
 * makes Zstd the default and Brotli the maximum-ratio option, and **a browser
 * can run neither**. Every Brotli and Zstd figure in this file is therefore a
 * Node measurement of a codec no user of the web app will execute.
 *
 * Confirmed outside this harness against a real Chromium 140, where `gzip`,
 * `deflate` and `deflate-raw` construct and `br`, `brotli` and `zstd` throw.
 * That probe is not this harness's measurement and is not reported as one; what
 * this harness measures is the consequence, below.
 */
export const BROWSER_STREAM_FORMATS = ['gzip', 'deflate', 'deflate-raw'];

/**
 * A browser-shaped platform: the stream CONSTRUCTORS and no zlib.
 *
 * Two things here are easy to get wrong and both silently produce a wrong
 * answer rather than an error.
 *
 * `detectCodecs` probes with `new CS(format)`, so it needs the constructors
 * themselves. Handing it a `streamFormats: [...]` array instead reports every
 * codec unavailable, because nothing constructs.
 *
 * And `probeFormats` is restricted to the WHATWG list on purpose. Node accepts
 * `new CompressionStream('brotli')` — measured, and reported in the Node
 * detection row above — while no browser does. Probing the full list here would
 * measure the platform this harness runs on rather than the one being modelled,
 * and would hand the browser row a brotli it cannot have.
 */
export function browserEnv() {
  return {
    CompressionStream: typeof CompressionStream === 'function' ? CompressionStream : null,
    DecompressionStream: typeof DecompressionStream === 'function' ? DecompressionStream : null,
    probeFormats: BROWSER_STREAM_FORMATS
  };
}

async function streamThrough(Ctor, format, bytes) {
  const stream = new Ctor(format);
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function timedAsync(fn, reps) {
  await fn();
  const samples = [];
  let out = null;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    out = await fn();
    samples.push(performance.now() - t0);
  }
  return { ms: percentile(samples, 0.5), out };
}

/**
 * What the shipped web app can actually do, measured through the real codec.
 *
 * `CompressionStream('deflate-raw')` is asynchronous and `compressArtifact` is
 * synchronous, so the browser's codec cannot be injected into it at all. That
 * is not worked around here. The stream is run for real, its OUTPUT LENGTH is
 * measured, and the length is put through the module's `choose()` — which takes
 * measured sizes rather than codecs precisely so that a codec the sync path
 * cannot call can still be judged by the same arithmetic. The verdict is the
 * module's; only the bytes came from somewhere it could not reach.
 *
 * Three further things are checked rather than assumed:
 *
 *   - the stream's output against `deflateRawSync` at level 6, because the
 *     synchronous stand-in used elsewhere is only legitimate if it produces the
 *     same bytes, and because a browser exposes no level parameter at all;
 *   - the round trip through a real `DecompressionStream`;
 *   - what happens when an asynchronous codec IS injected into the sync path,
 *     because "it cannot be done" and "it fails safely" are different claims.
 */
export async function runBrowserSuite({
  corpus,
  nodeRows = [],
  chunk = null,
  armour = true,
  reps = 3,
  gate = null
} = {}) {
  const loaded = loadCompressModule();
  if (!loaded) return { available: false, reason: 'artifacts/compress.js not present' };
  const C = loaded.module;
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    return { available: false, reason: 'no CompressionStream on this platform, so the browser codec cannot be run' };
  }

  const env = browserEnv();
  const detection = C.detectCodecs(env);
  const useChunk = chunk === null ? C.DEFAULT_CHUNK_BYTES : chunk;
  const useGate = gate === null ? C.ENVELOPE_GAIN_GATE : gate;

  // Does the sync path fail closed on an async codec, or corrupt the output?
  // Asked once, on real bytes, rather than reasoned about.
  let asyncInjection;
  try {
    C.compressArtifact(Buffer.from(corpus[0].bytes), {
      env,
      codecs: { 'deflate-raw': { compress: (b) => Promise.resolve(b) } },
      chunk: useChunk,
      armour
    });
    asyncInjection = { threw: false, reason: null, note: 'the sync path accepted a Promise, which it must not' };
  } catch (err) {
    asyncInjection = {
      threw: true,
      reason: err.reason || null,
      name: err.name || null,
      message: String(err.message || err)
    };
  }

  const rows = [];
  for (const item of corpus) {
    const src = Buffer.from(item.bytes);
    const nameLen = Buffer.byteLength(basenameFor(item), 'utf8');

    const enc = await timedAsync(() => streamThrough(CompressionStream, 'deflate-raw', src), reps);
    const compressed = enc.out;
    const dec = await timedAsync(() => streamThrough(DecompressionStream, 'deflate-raw', compressed), reps);

    // The module's own decision, over the real browser codec's byte count.
    const decision = C.choose({
      originalBytes: src.length,
      candidates: [{ codecId: C.CODEC_DEFLATE_RAW, compressedBytes: compressed.length }],
      chunk: useChunk,
      armour,
      nameLen,
      gate: useGate
    });
    const cell = decision.considered[0];

    // The synchronous stand-in, and whether it is one.
    let sync6 = null;
    let syncIdentical = null;
    if (typeof zlib.deflateRawSync === 'function') {
      sync6 = zlib.deflateRawSync(src, { level: 6 });
      syncIdentical = bytesEqual(new Uint8Array(sync6), compressed);
    }

    const node = nodeRows.find((r) => r.name === item.name) || null;

    rows.push({
      name: item.name,
      synthetic: !!item.synthetic,
      bytes: src.length,

      browserCodec: 'deflate-raw (CompressionStream)',
      browserBytes: compressed.length,
      browserRatio: cell.ratio,
      browserPayloadGain: cell.payloadGain,
      browserEnvelopeGain: cell.envelopeGain,
      browserFramesBefore: cell.framesBefore,
      browserFramesAfter: cell.framesAfter,
      browserPasses: cell.passesGate,
      browserCompress: decision.compress,
      browserEncodeMs: enc.ms,
      browserDecodeMs: dec.ms,
      browserRoundTripExact: bytesEqual(new Uint8Array(dec.out), item.bytes),

      syncStandInBytes: sync6 ? sync6.length : null,
      syncStandInIdentical: syncIdentical,

      nodeCodec: node ? node.codecName : null,
      nodeBytes: node ? node.streamBytes : null,
      nodeEnvelopeGain: node ? node.envelopeGain : null,
      nodeFramesAfter: node ? node.framesAfter : null,
      nodeCompress: node ? node.compress : null,
      // Brotli's advantage over what a browser can actually run, in points of
      // envelope gain and in frames the receiver still has to watch.
      edgePoints: node ? node.envelopeGain - cell.envelopeGain : null,
      edgeFrames: node ? cell.framesAfter - node.framesAfter : null
    });
  }

  return {
    available: true,
    chunk: useChunk,
    armour,
    gate: useGate,
    reps,
    streamFormats: detection.streamFormats,
    detected: detection.available.map((c) => ({
      id: c.id,
      name: c.name,
      via: c.via,
      supportsDictionary: c.supportsDictionary
    })),
    refused: detection.codecs
      .filter((c) => !c.available && (c.name === 'brotli' || c.name === 'zstd'))
      .map((c) => ({ name: c.name, reason: c.reason })),
    asyncInjection,
    rows
  };
}

export const ADR003_STANDALONE = { bytes: 503216, ratio: 3.535, brotli6EncodeMs: 8.38, quality: 6 };

export function runAdr003Recheck({ reps = 5 } = {}) {
  const abs = path.join(REPO_ROOT, 'standalone.html');
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(abs));
  } catch {
    return { available: false, reason: 'standalone.html is not present in this checkout' };
  }
  if (typeof zlib.brotliCompressSync !== 'function') {
    return { available: false, reason: 'node:zlib has no synchronous brotli here' };
  }
  const src = Buffer.from(bytes);
  const measured = [6, 11].map((quality) => {
    const codec = brotliAt(quality);
    const enc = timed(() => codec.compress(src), reps);
    const dec = timed(() => codec.decompress(enc.out), reps);
    return {
      quality,
      compressedBytes: enc.out.length,
      ratio: src.length / enc.out.length,
      encodeMs: enc.ms,
      decodeMs: dec.ms,
      roundTripExact: bytesEqual(new Uint8Array(dec.out), bytes),
      encodeMBps: src.length / 1024 / 1024 / (enc.ms / 1000)
    };
  });
  const q6 = measured.find((m) => m.quality === ADR003_STANDALONE.quality);
  return {
    available: true,
    path: 'standalone.html',
    bytes: src.length,
    adr: ADR003_STANDALONE,
    bytesDelta: src.length - ADR003_STANDALONE.bytes,
    bytesGrowth: src.length / ADR003_STANDALONE.bytes,
    ratioDelta: q6 ? q6.ratio - ADR003_STANDALONE.ratio : null,
    measured
  };
}
