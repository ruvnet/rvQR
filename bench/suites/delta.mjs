/*!
 * Suite 3 — delta transfer.
 *
 * The premise: the receiver already holds an older copy of a container. It
 * shows the sender an inventory of what it has; the sender diffs against it and
 * transmits only the spans that changed. artifacts/delta.js implements this,
 * and this suite drives the real code end to end — inventory, diff, payload
 * build, apply — and checks the result is byte-identical to the sender's
 * container rather than merely the right length.
 *
 * A NOTE ON THE HEADLINE NUMBER. rvQR's README projects "~100x less data for a
 * 1 GB container with 1% changed". That is arithmetic about a large container,
 * and this suite cannot measure it: the demo container is 2304 bytes and its
 * smallest span is 132 bytes, so changing one segment already touches a large
 * fraction of it. What is measured here is the small case, honestly, and the
 * large case is computed separately and labelled as a projection.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { core, loadShippedDelta } from '../lib/transports.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { RATES } from './payloads.mjs';

/**
 * Flips bytes inside one span, leaving its length and the container's overall
 * shape alone. That is the "one segment was edited" case; a length change would
 * shift every following offset and is a different (and less favourable)
 * experiment.
 */
function mutateSpan(bytes, span, seed) {
  const out = bytes.slice();
  const rand = mulberry32(seed);
  // Skip the span's own header so the scanner still recognises it.
  const start = span.offset + Math.min(32, span.length);
  for (let i = start; i < span.offset + span.length; i++) {
    out[i] = Math.floor(rand() * 256) & 255;
  }
  return out;
}

export function runDeltaSuite({ bytes, name, seed = 20260802 } = {}) {
  const shipped = loadShippedDelta();
  if (!shipped) {
    return { available: false, reason: 'artifacts/delta.js not present' };
  }
  const D = shipped.module;

  const receiverInv = D.inventory(bytes);
  const cases = [];

  for (const span of receiverInv.spans) {
    if (span.length <= 40) continue; // nothing left to change after the header
    const modified = mutateSpan(bytes, span, seed + span.index);
    const senderInv = D.inventory(modified);
    const d = D.diff(senderInv, receiverInv);

    // The payload that actually crosses the optical channel.
    const payload = D.buildDeltaPayload(modified, d.missing, { base: receiverInv });
    const payloadBytes = payload.length !== undefined ? payload.length : payload.bytes.length;
    const payloadArray = payload.length !== undefined ? payload : payload.bytes;

    // And the inventory the receiver has to show the sender first.
    const invText = D.encodeInventory(receiverInv);
    const invBytes = Buffer.byteLength(invText, 'utf8');

    let applied = null;
    let applyError = null;
    try {
      applied = D.applyDelta(bytes, payloadArray, {});
    } catch (err) {
      applyError = String(err && err.message ? err.message : err);
    }
    const appliedBytes = applied && applied.bytes ? applied.bytes : applied;
    const exact =
      appliedBytes instanceof Uint8Array && core.sha256Hex(appliedBytes) === core.sha256Hex(modified);

    // A delta transfer is two optical hops, not one: the receiver shows its
    // inventory, then the sender streams the delta. Both are counted.
    const frames = RATES.map((r) => {
      const fullFrames = core.frameCount(modified.length, r.chunk);
      const inventoryFrames = core.frameCount(invBytes, r.chunk);
      const deltaFrames = core.frameCount(payloadBytes, r.chunk);
      const totalDeltaFrames = inventoryFrames + deltaFrames;
      return {
        rate: r.name,
        chunk: r.chunk,
        fps: r.fps,
        fullFrames,
        inventoryFrames,
        deltaFrames,
        totalDeltaFrames,
        fullSeconds: fullFrames / r.fps,
        deltaSeconds: totalDeltaFrames / r.fps,
        frameRatio: fullFrames / totalDeltaFrames
      };
    });

    cases.push({
      spanIndex: span.index,
      spanType: span.typeName,
      spanLength: span.length,
      containerBytes: bytes.length,
      changedBytes: Math.max(0, span.length - Math.min(32, span.length)),
      missingSpans: d.missing.length,
      totalSpans: receiverInv.spans.length,
      // delta.js's own accounting: raw span bytes that must be sent.
      diffBytesToSend: d.bytesToSend,
      diffRatio: d.ratio,
      // What the wire actually carries once the delta framing is added.
      deltaPayloadBytes: payloadBytes,
      inventoryBytes: invBytes,
      wireRatio: bytes.length / payloadBytes,
      wireRatioWithInventory: bytes.length / (payloadBytes + invBytes),
      reconstructedExactly: exact,
      applyError,
      frames
    });
  }

  return { available: true, path: shipped.path, container: name, containerBytes: bytes.length, cases };
}

/**
 * The 1 GB case. This is ARITHMETIC, NOT A MEASUREMENT, and the report says so
 * wherever it appears. It assumes the changed fraction lands on whole spans and
 * that the inventory for a container with that many spans still fits the
 * channel — neither is free, and both are called out as threats to validity.
 */
export function projectLargeContainer({
  containerBytes = 1024 * 1024 * 1024,
  changedFraction = 0.01,
  spanBytes = 4 * 1024 * 1024,
  hashBytesPerSpan = 8,
  spanRecordBytes = 20
} = {}) {
  const spans = Math.ceil(containerBytes / spanBytes);
  const changedSpans = Math.max(1, Math.round(spans * changedFraction));
  const deltaBytes = changedSpans * spanBytes;
  const inventoryBytes = spans * spanRecordBytes;

  return RATES.map((r) => {
    const fullFrames = core.frameCount(containerBytes, r.chunk);
    const deltaFrames = core.frameCount(deltaBytes, r.chunk) + core.frameCount(inventoryBytes, r.chunk);
    return {
      rate: r.name,
      chunk: r.chunk,
      fps: r.fps,
      spans,
      changedSpans,
      hashBytesPerSpan,
      inventoryBytes,
      deltaBytes,
      fullFrames,
      deltaFrames,
      fullHours: fullFrames / r.fps / 3600,
      deltaHours: deltaFrames / r.fps / 3600,
      deltaMinutes: deltaFrames / r.fps / 60,
      ratio: fullFrames / deltaFrames
    };
  });
}
