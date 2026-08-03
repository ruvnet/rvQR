/*!
 * Suite 6 — protocol v1 against protocol v2, at matched QR versions.
 *
 * v1 is JSON with a base64url payload. v2 (artifacts/proto2.js) is a 28-byte
 * binary header with the payload carried raw, plus an ASCII-armoured variant
 * that repacks the frame 7 bits at a time so it survives a decoder that can
 * only hand back a string.
 *
 * The question this suite answers is not "how big is a header". It is: given a
 * QR symbol of a fixed version and error-correction level — which is what the
 * optics actually constrain — how many bytes of ARTIFACT does each framing get
 * through it? Everything else (frames, seconds, goodput) follows from that one
 * number, so that one number is measured rather than derived.
 *
 * Three things are measured per cell and none of them is assumed:
 *
 *   1. The largest chunk each framing can carry without overflowing the target
 *      version. Found by binary search over real frames built by the real
 *      builders — core.buildFrames for v1, proto2.buildFrames for v2 — and then
 *      confirmed by encoding the frame and reading back qr.version.
 *   2. The whole-artifact cost: frames, wire bytes, wire efficiency, seconds.
 *   3. Whether the frame survives a round trip through the encoder and the
 *      bundled JS decoder at all. This is the one that decides whether a
 *      density figure is reachable or merely arithmetic.
 *
 * WHAT THIS SUITE DOES NOT MEASURE. Optics. A version-27 symbol carries more
 * bytes than a version-19 one and is also harder to read off a screen; the
 * decode-robustness sweep in the qr suite is the other half of that trade and
 * the two have to be read together.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { core, qrcode, REPO_ROOT } from '../lib/transports.mjs';

const require = createRequire(import.meta.url);

export function loadProto2() {
  try {
    const p = path.join(REPO_ROOT, 'artifacts', 'proto2.js');
    return { module: require(p), path: p };
  } catch {
    return null;
  }
}

function loadDecoder() {
  try {
    return require(path.join(REPO_ROOT, 'artifacts', 'vendor', 'qrdecode.js'));
  } catch {
    return null;
  }
}

/** The app's two operating points, as in the payloads suite. */
export const RATES = [
  { name: 'default', chunk: 512, fps: 5 },
  { name: 'ceiling', chunk: 1024, fps: 10 }
];

/**
 * Bytes a v2 frame occupies once armoured. toTransport emits ceil(n*8/7)
 * characters in 0x00–0x7F, every one of which is a single UTF-8 byte, so the
 * character count and the QR byte count are the same number. Computed rather
 * than measured per frame because the armour is a pure function of length —
 * `verifyArmourLength` below checks that against the real implementation.
 */
export function armouredBytes(frameLen) {
  return Math.ceil((frameLen * 8) / 7);
}

function verifyArmourLength(P) {
  for (const n of [1, 28, 29, 100, 512, 693, 764, 2953]) {
    const frame = new Uint8Array(n);
    if (P.toTransport(frame).length !== armouredBytes(n)) return false;
  }
  return true;
}

// --- per-framing measurement -------------------------------------------------

/**
 * Builds a whole v1 transfer and reports what it costs on the wire.
 *
 * The largest frame is the one that matters for version selection: JSON grows
 * by a byte when the index crosses a power of ten, so a transfer whose early
 * frames fit a version can still have late frames that do not.
 */
function measureV1(bytes, name, chunk) {
  const built = core.buildFrames(bytes, { chunk, name, transferId: 'aaaaaaaa' });
  let maxFrame = 0;
  let maxDataFrame = 0;
  let total = 0;
  for (let i = 0; i < built.frames.length; i++) {
    const n = Buffer.byteLength(built.frames[i], 'utf8');
    total += n;
    if (n > maxFrame) maxFrame = n;
    if (i > 0 && n > maxDataFrame) maxDataFrame = n;
  }
  return {
    mode: 'v1-json',
    requestedChunk: chunk,
    // core.clampChunk caps at MAX_CHUNK; a request above it is silently reduced
    // and the caller has to be told, or the "max chunk" column becomes a lie.
    chunk: built.chunk,
    clamped: built.chunk !== chunk,
    frames: built.frames.length,
    maxFrameBytes: maxFrame,
    maxDataFrameBytes: maxDataFrame,
    totalWireBytes: total,
    sampleFrame: built.frames[1] || built.frames[0]
  };
}

function measureV2(P, bytes, name, chunk, armour) {
  const built = P.buildFrames(bytes, { chunk, name, transferId: 'aaaaaaaa' });
  let maxFrame = 0;
  let maxDataFrame = 0;
  let total = 0;
  for (let i = 0; i < built.frames.length; i++) {
    const raw = built.frames[i].length;
    const n = armour ? armouredBytes(raw) : raw;
    total += n;
    if (n > maxFrame) maxFrame = n;
    if (i > 0 && n > maxDataFrame) maxDataFrame = n;
  }
  return {
    mode: armour ? 'v2-armoured' : 'v2-binary',
    requestedChunk: chunk,
    chunk: built.chunk,
    clamped: built.chunk !== chunk,
    frames: built.frames.length,
    maxFrameBytes: maxFrame,
    maxDataFrameBytes: maxDataFrame,
    totalWireBytes: total,
    sampleFrame: built.frames[1] || built.frames[0]
  };
}

const MEASURERS = {
  'v1-json': (P, bytes, name, chunk) => measureV1(bytes, name, chunk),
  'v2-binary': (P, bytes, name, chunk) => measureV2(P, bytes, name, chunk, false),
  'v2-armoured': (P, bytes, name, chunk) => measureV2(P, bytes, name, chunk, true)
};

/**
 * Largest chunk whose every frame fits `capacity`. Binary search over the real
 * builders; frame size is monotone in chunk for all three framings, which is
 * what makes the search valid.
 *
 * Returns null when even the smallest legal chunk overflows the version.
 */
function maxChunkFor(P, mode, bytes, name, capacity, ceiling) {
  const measure = MEASURERS[mode];
  let lo = core.MIN_CHUNK;
  let hi = ceiling;
  const at = (c) => measure(P, bytes, name, c);
  if (at(lo).maxFrameBytes > capacity) return null;
  let best = at(lo);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = at(mid);
    // A clamped request tells us nothing new about `mid`, but the result it
    // produced is still a legitimate operating point, so it is kept if it fits.
    if (r.maxFrameBytes <= capacity) {
      if (r.chunk >= best.chunk) best = r;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// --- does the frame survive the round trip? ----------------------------------

/**
 * Encodes one frame, decodes it with the bundled JS decoder, and asks whether
 * the bytes came back.
 *
 * This is the difference between a density that can be used and one that can
 * only be quoted. proto2.js's own docblock says the bundled decoder cannot
 * return raw bytes; this checks it rather than repeating it.
 */
function roundTrip(P, D, mode, frame) {
  if (!D) return { attempted: false, reason: 'no JS decoder present' };
  let qr;
  const isText = mode === 'v1-json' || mode === 'v2-armoured';
  const text = mode === 'v2-armoured' ? P.toTransport(frame) : frame;
  try {
    qr = isText ? qrcode.encodeText(text, { ecl: qrcode.ECC.L }) : qrcode.encodeBytes(frame, { ecl: qrcode.ECC.L });
  } catch (err) {
    return { attempted: true, ok: false, stage: 'encode', reason: String(err.message || err) };
  }
  const res = D.decodeMatrix((x, y) => qr.getModule(x, y), qr.size);
  if (!res || !res.ok) return { attempted: true, ok: false, stage: 'decode', version: qr.version };

  if (mode === 'v1-json') {
    let parsed = null;
    try {
      parsed = core.parseFrame(res.text);
    } catch {
      parsed = null;
    }
    const ok = res.text === text && !!(parsed && (parsed.ok === undefined ? parsed : parsed.ok));
    return { attempted: true, ok, stage: ok ? 'complete' : 'parse', version: qr.version, textExact: res.text === text };
  }
  if (mode === 'v2-armoured') {
    const parsed = P.parseFrame(res.text);
    return {
      attempted: true,
      ok: res.text === text && parsed.ok,
      stage: parsed.ok ? 'complete' : 'parse',
      reason: parsed.ok ? null : parsed.reason,
      version: qr.version,
      textExact: res.text === text
    };
  }
  // v2 binary: the decoder only offers a string, so the only way back to bytes
  // is to re-encode that string. Any byte that was not valid UTF-8 is gone.
  const back = new Uint8Array(Buffer.from(res.text, 'utf8'));
  let exact = back.length === frame.length;
  if (exact) for (let i = 0; i < frame.length; i++) if (back[i] !== frame[i]) { exact = false; break; }
  const parsed = P.parseFrame(back);
  return {
    attempted: true,
    ok: exact && parsed.ok,
    stage: exact ? 'parse' : 'bytes-lost',
    reason: parsed.ok ? null : parsed.reason,
    version: qr.version,
    textExact: exact,
    bytesIn: frame.length,
    bytesBack: back.length
  };
}

// --- the suite ---------------------------------------------------------------

export const DEFAULT_VERSIONS = [13, 16, 19, 22, 27, 40];

/**
 * Density at matched QR versions, on one artifact.
 *
 * `artifact` only affects the frame-count columns; the bytes-per-frame result
 * is a property of the framing and the version, and is identical across
 * artifacts up to the digit-width effect in v1's JSON.
 */
export function runProtoDensity({
  bytes,
  name = 'artifact.bin',
  versions = DEFAULT_VERSIONS,
  eccLevels = ['L', 'M'],
  fps = 5
} = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const P = loaded.module;
  const D = loadDecoder();
  const armourExact = verifyArmourLength(P);

  const rows = [];
  for (const eclName of eccLevels) {
    const ecl = qrcode.ECC[eclName];
    for (const version of versions) {
      const capacity = qrcode.byteCapacity(version, ecl);
      const cell = { version, ecl: eclName, capacity, modes: {} };
      for (const mode of ['v1-json', 'v2-binary', 'v2-armoured']) {
        // The ceiling is each protocol's own declared maximum, not a number
        // chosen here: v1 clamps at core.MAX_CHUNK, v2 at MAX_PAYLOAD_BYTES.
        const ceiling = mode === 'v1-json' ? core.MAX_CHUNK : P.MAX_PAYLOAD_BYTES;
        const m = maxChunkFor(P, mode, bytes, name, capacity, ceiling);
        if (!m) {
          cell.modes[mode] = { fits: false };
          continue;
        }
        const confirmed = confirmVersion(P, mode, m.sampleFrame, ecl);
        cell.modes[mode] = {
          fits: true,
          chunk: m.chunk,
          clampedByProtocol: m.chunk === ceiling,
          frameBytes: m.maxDataFrameBytes,
          // Bytes of envelope per byte of payload. The number the v2 design
          // exists to reduce.
          overheadPct: (m.maxDataFrameBytes - m.chunk) / m.chunk,
          fillPct: m.maxDataFrameBytes / capacity,
          frames: m.frames,
          totalWireBytes: m.totalWireBytes,
          wireEfficiency: bytes.length / m.totalWireBytes,
          seconds: m.frames / fps,
          goodputBytesPerSec: bytes.length / (m.frames / fps),
          encodedVersion: confirmed.version,
          versionConfirmed: confirmed.version === version,
          roundTrip: roundTrip(P, D, mode, m.sampleFrame)
        };
      }
      const base = cell.modes['v1-json'];
      for (const mode of ['v2-binary', 'v2-armoured']) {
        const m = cell.modes[mode];
        if (m.fits && base.fits) m.gainOverV1 = m.chunk / base.chunk;
      }
      rows.push(cell);
    }
  }

  return {
    available: true,
    protoPath: loaded.path,
    decoderPresent: !!D,
    armourLengthExact: armourExact,
    payload: name,
    payloadBytes: bytes.length,
    headerBytes: P.HEADER_BYTES,
    manifestFixedBytes: P.MANIFEST_FIXED_BYTES,
    v1MaxChunk: core.MAX_CHUNK,
    v2MaxPayload: P.MAX_PAYLOAD_BYTES,
    fps,
    versions,
    eccLevels,
    rows
  };
}

function confirmVersion(P, mode, frame, ecl) {
  try {
    if (mode === 'v1-json') return { version: qrcode.encodeText(frame, { ecl }).version };
    if (mode === 'v2-armoured') return { version: qrcode.encodeText(P.toTransport(frame), { ecl }).version };
    return { version: qrcode.encodeBytes(frame, { ecl }).version };
  } catch (err) {
    return { version: null, error: String(err.message || err) };
  }
}

/**
 * The app's own operating points rather than matched versions: what a 512-byte
 * and a 1024-byte chunk cost in each framing, and what QR version each lands on.
 *
 * This is where the v1 overhead percentage the repository quotes gets checked.
 */
export function runProtoAtAppRates({ payloads, eccLevel = 'L' } = {}) {
  const loaded = loadProto2();
  if (!loaded) return { available: false, reason: 'artifacts/proto2.js not present' };
  const P = loaded.module;
  const ecl = qrcode.ECC[eccLevel];

  const rows = [];
  for (const p of payloads) {
    for (const rate of RATES) {
      for (const mode of ['v1-json', 'v2-binary', 'v2-armoured']) {
        const m = MEASURERS[mode](P, p.bytes, p.name, rate.chunk);
        const version = confirmVersion(P, mode, m.sampleFrame, ecl).version;
        rows.push({
          payload: p.name,
          payloadBytes: p.bytes.length,
          rate: rate.name,
          fps: rate.fps,
          mode,
          chunk: m.chunk,
          frameBytes: m.maxDataFrameBytes,
          overheadPct: (m.maxDataFrameBytes - m.chunk) / m.chunk,
          frames: m.frames,
          totalWireBytes: m.totalWireBytes,
          wireEfficiency: p.bytes.length / m.totalWireBytes,
          qrVersion: version,
          seconds: m.frames / rate.fps,
          goodputBytesPerSec: p.bytes.length / (m.frames / rate.fps)
        });
      }
    }
  }
  return { available: true, eccLevel, rows };
}

/**
 * The v1 frame-size spread. v1's envelope is not a constant: `i` and `n` are
 * decimal, so a frame costs a byte more once the index passes 9, 99, 999. Any
 * single "v1 frame is N bytes" figure is therefore a figure for one index of
 * one transfer, and this reports the range instead.
 */
export function runV1FrameSpread({ payloads, chunk = 512 } = {}) {
  return {
    chunk,
    rows: payloads.map((p) => {
      const built = core.buildFrames(p.bytes, { chunk, name: p.name, transferId: 'aaaaaaaa' });
      const sizes = built.frames.slice(1).map((f) => Buffer.byteLength(f, 'utf8'));
      const counts = new Map();
      for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
      return {
        payload: p.name,
        payloadBytes: p.bytes.length,
        dataFrames: sizes.length,
        min: Math.min(...sizes),
        max: Math.max(...sizes),
        histogram: [...counts.entries()].sort((a, b) => a[0] - b[0]),
        minOverheadPct: (Math.min(...sizes) - chunk) / chunk,
        maxOverheadPct: (Math.max(...sizes) - chunk) / chunk
      };
    })
  };
}
