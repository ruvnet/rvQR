/*!
 * Suite 2 — the two real payloads.
 *
 * artifacts/demo/ruvnet-demo.rvf (2304 B) is a genuine RVF container: four
 * spans, a vector segment, a witness segment and two manifests.
 * artifacts/demo/rvf_wasm_bg.wasm (40989 B) is the @ruvector/rvf-wasm 0.1.9
 * runtime binary, carried as cargo.
 *
 * What gets measured: how many frames each becomes, what QR version each frame
 * needs, how many bytes actually cross the channel once the JSON envelope and
 * base64url expansion are paid for, and what that works out to in wall-clock
 * seconds at the two rates the app really runs at.
 *
 * The two rates are the app's own: 512 B per frame at 5 fps (the default) and
 * 1024 B per frame at 10 fps (the ceiling). Those are 2.5 KB/s and 10 KB/s of
 * *payload*, which is where the README's figures come from; the goodput
 * computed here is lower, because the manifest frame and the per-frame envelope
 * are real and have to be sent.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { core, qrcode, baselineTransport, fountainTransport } from '../lib/transports.mjs';

/** The two operating points the app exposes. */
export const RATES = [
  { name: 'default', chunk: 512, fps: 5 },
  { name: 'ceiling', chunk: 1024, fps: 10 }
];

/** Smallest QR version that fits `text` at the given error-correction level. */
function versionFor(text, ecl) {
  const bytes = Buffer.from(text, 'utf8');
  for (let v = qrcode.MIN_VERSION; v <= qrcode.MAX_VERSION; v++) {
    if (bytes.length <= qrcode.byteCapacity(v, ecl)) return v;
  }
  return null;
}

function histogram(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
}

/**
 * ECC level L is the app's default (artifacts/app.js, `send.ecl = 'L'`), so it
 * is the level every headline figure uses. M is reported alongside because it
 * is the level a user picks when the scan is unreliable, and it costs symbol
 * versions.
 */
export function analysePayload(bytes, name, { eccLevel = 'L' } = {}) {
  const ecl = qrcode.ECC[eccLevel];
  const rows = [];

  for (const rate of RATES) {
    const t = baselineTransport(bytes, { chunk: rate.chunk, name });
    const send = t.sender();
    const versions = t.wireBytes.map((_, i) => versionFor(send(i), ecl));
    const versionsM = t.wireBytes.map((_, i) => versionFor(send(i), qrcode.ECC.M));
    const seconds = t.n / rate.fps;

    // A fountain stream of the same object, for the frame-count comparison on a
    // clean channel. It is systematic, so it needs K symbols plus whatever
    // manifest repaints the design calls for.
    const f = fountainTransport(bytes, { symbolSize: rate.chunk, name, scheme: 'shipped' });

    rows.push({
      rate: rate.name,
      chunk: rate.chunk,
      fps: rate.fps,
      frames: t.n,
      dataFrames: t.n - 1,
      fountainK: f ? f.K : null,
      fountainCleanFrames: f ? f.K + Math.ceil(f.K / f.manifestEvery) : null,
      qrVersionMin: Math.min(...versions),
      qrVersionMax: Math.max(...versions),
      qrVersions: histogram(versions),
      qrVersionMinM: Math.min(...versionsM),
      qrVersionMaxM: Math.max(...versionsM),
      manifestVersion: versions[0],
      wireBytes: t.totalWireBytes,
      // Payload bytes divided by bytes actually painted: the cost of the JSON
      // envelope plus base64url's 4-bytes-per-3 expansion.
      wireEfficiency: bytes.length / t.totalWireBytes,
      seconds,
      // What the user actually gets: file size over elapsed time, envelope and
      // manifest frame included.
      goodputBytesPerSec: bytes.length / seconds,
      // The nominal figure: chunk * fps, ignoring every overhead.
      nominalBytesPerSec: rate.chunk * rate.fps
    });
  }

  return { name, bytes: bytes.length, type: core.detectArtifactType(bytes), eccLevel, rows };
}

/**
 * Projects a transfer time for an arbitrary size at the app's real rates. Used
 * for the container sizes that are too large to actually run through the
 * harness, and labelled as a projection everywhere it appears.
 */
export function projectTransfer(sizeBytes, chunk, fps) {
  const frames = core.frameCount(sizeBytes, chunk);
  const seconds = frames / fps;
  return { frames, seconds, hours: seconds / 3600, goodputBytesPerSec: sizeBytes / seconds };
}

export function runPayloadSuite(payloads, opts = {}) {
  return {
    eccLevel: opts.eccLevel || 'L',
    payloads: payloads.map((p) => analysePayload(p.bytes, p.name, opts))
  };
}
