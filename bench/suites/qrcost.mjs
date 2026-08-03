/*!
 * Suite 4 — what a QR frame costs to make and to read.
 *
 * Encoding bounds nothing in practice: the sender has a whole frame period to
 * paint one symbol. Decoding is the interesting half, because it is what
 * decides whether a phone can actually keep up at 10 fps or whether the
 * receiver silently drops every other frame and the transfer takes twice as
 * long as the arithmetic says.
 *
 * Three costs are separated here, because they are three different things:
 *
 *   encode         Building the symbol from the frame string.
 *   decodeMatrix   Reading a symbol whose module grid is already known —
 *                  format decoding, de-interleaving, Reed-Solomon. This is the
 *                  floor, and roughly what a hardware/native decoder does.
 *   decodeImage    The whole pipeline from a greyscale-able image: binarize,
 *                  hunt for finder patterns, fit a perspective transform,
 *                  sample the grid, then decodeMatrix. This is what the JS
 *                  fallback path actually pays per camera frame.
 *
 * The images fed to decodeImage are rendered from the encoder's own module
 * grid: clean, square-on, evenly lit, no motion blur. A real camera frame is
 * harder in every one of those respects, so these decode timings are a LOWER
 * BOUND on the real cost, not an estimate of it.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { core, qrcode, REPO_ROOT, baselineTransport } from '../lib/transports.mjs';
import { percentile, mean } from '../lib/stats.mjs';
import { mulberry32, randomBytes } from '../lib/rng.mjs';

const require = createRequire(import.meta.url);

export function loadDecoder() {
  try {
    const p = path.join(REPO_ROOT, 'artifacts', 'vendor', 'qrdecode.js');
    return { module: require(p), path: p };
  } catch {
    return null;
  }
}

/**
 * Renders a QR symbol into an ImageData-shaped RGBA buffer, centred in a frame
 * of the given size with a white surround. `scale` is chosen so the symbol
 * plus its 4-module quiet zone fills the frame.
 */
function renderSymbol(qr, frameWidth, frameHeight) {
  const quiet = 4;
  const modules = qr.size + quiet * 2;
  const scale = Math.max(1, Math.floor(Math.min(frameWidth, frameHeight) / modules));
  const drawn = modules * scale;
  const ox = Math.floor((frameWidth - drawn) / 2);
  const oy = Math.floor((frameHeight - drawn) / 2);

  const data = new Uint8ClampedArray(frameWidth * frameHeight * 4).fill(255);
  for (let my = 0; my < qr.size; my++) {
    for (let mx = 0; mx < qr.size; mx++) {
      if (!qr.getModule(mx, my)) continue;
      const x0 = ox + (mx + quiet) * scale;
      const y0 = oy + (my + quiet) * scale;
      for (let y = y0; y < y0 + scale; y++) {
        let idx = (y * frameWidth + x0) * 4;
        for (let x = 0; x < scale; x++) {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          idx += 4;
        }
      }
    }
  }
  return { data, width: frameWidth, height: frameHeight, moduleScale: scale };
}

function timeIt(fn, reps) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  return { mean: mean(samples), p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), reps };
}

/**
 * Timings for the frame sizes the app actually uses, on a real payload.
 * `frameSizes` are camera-frame resolutions to render into.
 */
export function runQrCostSuite({
  bytes,
  name = 'artifact.bin',
  chunks = [256, 512, 768, 1024],
  eccLevels = ['L', 'M'],
  encodeReps = 200,
  decodeReps = 30,
  frameSizes = [
    { label: '640x480', width: 640, height: 480 },
    { label: '1280x720', width: 1280, height: 720 }
  ]
} = {}) {
  const decoder = loadDecoder();
  const rows = [];

  for (const chunk of chunks) {
    const t = baselineTransport(bytes, { chunk, name });
    const send = t.sender();
    // Frame 1 is a full data frame; the manifest is a different (smaller) shape
    // and is measured separately below.
    const frameText = send(1);
    const frameBytes = Buffer.byteLength(frameText, 'utf8');

    for (const eclName of eccLevels) {
      const ecl = qrcode.ECC[eclName];
      let qr;
      try {
        qr = qrcode.encodeText(frameText, { ecl });
      } catch (err) {
        rows.push({ chunk, ecl: eclName, error: String(err.message || err) });
        continue;
      }

      const encode = timeIt(() => qrcode.encodeText(frameText, { ecl }), encodeReps);

      const row = {
        chunk,
        ecl: eclName,
        frameBytes,
        qrVersion: qr.version,
        modules: qr.size,
        encodeMs: encode,
        // Payload bytes the sender can push per second if encoding were the
        // only cost. Never the binding constraint, but worth showing.
        encodeFramesPerSec: 1000 / encode.p50,
        decode: null
      };

      if (decoder) {
        const D = decoder.module;
        const matrixMs = timeIt(
          () => D.decodeMatrix((x, y) => qr.getModule(x, y), qr.size),
          decodeReps
        );
        const check = D.decodeMatrix((x, y) => qr.getModule(x, y), qr.size);
        row.decode = {
          matrixMs,
          matrixOk: !!(check && check.ok),
          images: []
        };
        for (const fs of frameSizes) {
          const img = renderSymbol(qr, fs.width, fs.height);
          const results = D.decodeImage(img, { all: false });
          const ok = Array.isArray(results) ? results.length > 0 : !!results;
          const ms = timeIt(() => D.decodeImage(img, { all: false }), decodeReps);
          row.decode.images.push({
            label: fs.label,
            moduleScalePx: img.moduleScale,
            decoded: ok,
            ms,
            maxFps: 1000 / ms.p50
          });
        }
      }

      rows.push(row);
    }
  }

  return {
    decoderAvailable: !!decoder,
    decoderPath: decoder ? decoder.path : null,
    payload: name,
    payloadBytes: bytes.length,
    rows
  };
}

/**
 * Encode cost across the QR version range, driven by synthetic payloads sized
 * to just fill each version. Separates the version-scaling behaviour from the
 * app's particular frame sizes.
 */
export function runVersionSweep({ versions = [5, 10, 15, 20, 25, 30, 35, 40], ecl = 'M', reps = 60, seed = 7 } = {}) {
  const level = qrcode.ECC[ecl];
  const rand = mulberry32(seed);
  const out = [];
  for (const v of versions) {
    const cap = qrcode.byteCapacity(v, level);
    const payload = randomBytes(rand, cap);
    let qr;
    try {
      qr = qrcode.encodeBytes(payload, { ecl: level, minVersion: v, maxVersion: v });
    } catch {
      qr = qrcode.encodeBytes(payload, { ecl: level });
    }
    const t = timeIt(() => qrcode.encodeBytes(payload, { ecl: level }), reps);
    out.push({
      version: v,
      ecl,
      capacityBytes: cap,
      modules: qr.size,
      encodeMs: t,
      bytesPerSecond: (cap * 1000) / t.p50
    });
  }
  return out;
}

export { renderSymbol };
