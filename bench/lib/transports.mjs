/*!
 * Transports under test: the shipped rvQR v1 indexed-chunk scheme, and fountain
 * streams built on the harness's reference codecs.
 *
 * A transport is a pair of factories. `sender(slot)` returns the frame string
 * rvQR would paint in that slot; `receiver()` returns something that swallows
 * frame strings and eventually says "I can reconstruct now". Both sides deal in
 * complete frame strings — the same UTF-8 JSON that goes into a QR symbol — so
 * the wire-byte accounting is real rather than modelled.
 *
 * The baseline transport is not a model of rvQR v1. It IS rvQR v1: it calls
 * artifacts/core.js for frame construction, parsing, reassembly and SHA-256
 * verification. If the app's receiver has a bug, this benchmark inherits it.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEncoder, createDecoder } from './fountain-ref.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const core = require(path.join(REPO_ROOT, 'artifacts', 'core.js'));
export const qrcode = require(path.join(REPO_ROOT, 'artifacts', 'vendor', 'qrcode.js'));

/**
 * Loads artifacts/fountain.js if another agent has landed it, so that this
 * harness measures the real implementation the moment it exists. Returns null
 * otherwise, and every caller is expected to say so in its output rather than
 * quietly substituting the reference codec.
 */
export function loadShippedFountain() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'fountain.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch (err) {
    return null;
  }
}

export function loadShippedDelta() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'delta.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch (err) {
    return null;
  }
}

// --- Baseline: rvQR v1, fixed indexed chunks, cycled forever -----------------

export function baselineTransport(bytes, { chunk = 512, name = 'artifact.bin' } = {}) {
  const built = core.buildFrames(bytes, { chunk, name, transferId: 'aaaaaaaa' });
  const frames = built.frames;
  const n = frames.length;
  const wireBytes = frames.map((f) => Buffer.byteLength(f, 'utf8'));

  return {
    kind: 'baseline',
    label: 'rvQR v1 (indexed chunks)',
    n,
    /** Distinct frames the receiver must collect. Manifest included. */
    distinct: n,
    symbolSize: built.chunk,
    wireBytes,
    totalWireBytes: wireBytes.reduce((a, b) => a + b, 0),
    /** Manifest frames carry no payload, so they are counted separately. */
    isManifest: (text) => text === frames[0],
    sender() {
      // The app paints frames in order and loops. Slot t shows frame t mod n.
      return (slot) => frames[slot % n];
    },
    receiver() {
      const state = core.createReceiver();
      return {
        /** Returns true once the payload can be reconstructed. */
        push(text) {
          const r = core.ingest(state, text);
          return r.complete;
        },
        /** Runs the real verification path; null if it did not verify. */
        finish() {
          const res = core.finalize(state);
          return res.ok ? res.bytes : null;
        },
        /**
         * Whether every payload frame is in hand, regardless of whether the
         * manifest has arrived. Separating this from `push`'s completion signal
         * is what keeps "coding overhead" from being contaminated by time spent
         * waiting for a manifest, which is a framing cost, not a coding one.
         */
        get payloadComplete() {
          return state.total > 0 && state.received === state.total - 1;
        },
        get accepted() {
          return state.received + (state.manifest ? 1 : 0);
        }
      };
    }
  };
}

// --- Fountain: rateless symbols, any K+epsilon suffice -----------------------

/**
 * Frames carry the same JSON envelope shape as rvQR v1 so the per-frame
 * overhead is comparable. `e` is the encoding symbol ID, `k` the source block
 * size; a receiver derives the symbol's neighbour set from `e` alone.
 *
 * A fountain stream still has to deliver the manifest, which the payload hash
 * lives in. It is repainted every `manifestEvery` slots. Those slots are
 * counted against the fountain in every result — a fountain code removes the
 * coupon-collector problem for the payload, not the need to say what the
 * payload is.
 */
/**
 * Wraps the harness's own reference codecs behind the same tiny interface as
 * the shipped one, so a suite can run both without knowing which is which.
 */
function referenceCodec(bytes, symbolSize, scheme, seed) {
  const enc = createEncoder({ source: bytes, symbolSize, scheme, seed });
  return {
    provenance: `bench reference codec (${scheme})`,
    K: enc.K,
    encodeSymbol: (esi) => enc.symbol(esi),
    createDecoder() {
      const dec = createDecoder({ K: enc.K, symbolSize, scheme, seed });
      return {
        add: (esi, sym) => dec.add(esi, sym),
        get rank() {
          return dec.rank;
        },
        get needed() {
          return enc.K - dec.rank;
        },
        recover() {
          const block = dec.recover();
          return block ? block.subarray(0, bytes.length) : null;
        }
      };
    }
  };
}

/**
 * The codec rvQR actually ships, artifacts/fountain.js — a systematic GF(256)
 * fountain built on RaptorQ's structure. Its own header is explicit that it is
 * not RFC 6330 conformant; what this harness measures is its reception
 * overhead and decode cost, not its interoperability.
 */
function shippedCodec(bytes, symbolSize) {
  const shipped = loadShippedFountain();
  if (!shipped) return null;
  const F = shipped.module;
  const enc = F.encoder(bytes, symbolSize);
  return {
    provenance: `artifacts/fountain.js (shipped)`,
    K: enc.K,
    parameters: enc.parameters,
    encodeSymbol: (esi) => enc.symbol(esi).bytes,
    createDecoder() {
      const dec = F.decoder(enc.K, symbolSize, bytes.length);
      return {
        add: (esi, sym) => dec.add({ esi, bytes: sym }),
        get rank() {
          return enc.K - dec.needed;
        },
        get needed() {
          return dec.needed;
        },
        recover: () => dec.decode()
      };
    }
  };
}

/**
 * Builds a fountain codec. `scheme` selects between the shipped implementation
 * and the harness's reference points; the returned transport records which one
 * it used so no result can be mistaken for the other.
 */
export function makeCodec(bytes, symbolSize, scheme, seed) {
  if (scheme === 'shipped') return shippedCodec(bytes, symbolSize);
  return referenceCodec(bytes, symbolSize, scheme, seed);
}

export function fountainTransport(
  bytes,
  { symbolSize = 512, name = 'artifact.bin', scheme = 'shipped', seed = 0x5eed, manifestEvery = 20 } = {}
) {
  const sha256 = core.sha256Hex(bytes);
  const prefix = sha256.slice(0, 8);
  const codec = makeCodec(bytes, symbolSize, scheme, seed);
  if (!codec) return null;
  const K = codec.K;

  const manifestFrame = JSON.stringify({
    v: 1,
    f: 1,
    t: 'aaaaaaaa',
    h: prefix,
    e: -1,
    k: K,
    m: { name, size: bytes.length, sha256, sym: symbolSize }
  });

  // Symbol strings are memoised because a trial replays the same slot pattern
  // twice (once to count, once to time the receiver) and a sender that
  // recomputed the XOR each time would make the two passes disagree in cost
  // without changing any result.
  const cache = new Map();
  function frameFor(esi) {
    let s = cache.get(esi);
    if (s === undefined) {
      s = JSON.stringify({
        v: 1,
        f: 1,
        t: 'aaaaaaaa',
        h: prefix,
        e: esi,
        k: K,
        p: core.b64uEncode(codec.encodeSymbol(esi))
      });
      cache.set(esi, s);
    }
    return s;
  }

  const sampleWire = [];
  for (let i = 0; i < Math.min(K + 4, 64); i++) sampleWire.push(Buffer.byteLength(frameFor(i), 'utf8'));

  return {
    kind: 'fountain',
    label: `fountain (${scheme})`,
    scheme,
    provenance: codec.provenance,
    parameters: codec.parameters || null,
    K,
    symbolSize,
    manifestEvery,
    /** Symbols needed in the absence of any coding overhead. */
    distinct: K,
    isManifest: (text) => text === manifestFrame,
    manifestWireBytes: Buffer.byteLength(manifestFrame, 'utf8'),
    meanSymbolWireBytes: sampleWire.reduce((a, b) => a + b, 0) / sampleWire.length,
    sender() {
      let esi = 0;
      return (slot) => {
        if (slot % manifestEvery === 0) return manifestFrame;
        return frameFor(esi++);
      };
    },
    receiver() {
      const dec = codec.createDecoder();
      let manifest = null;
      return {
        push(text) {
          let obj;
          try {
            obj = JSON.parse(text);
          } catch {
            return false;
          }
          if (obj.v !== 1 || obj.f !== 1) return false;
          if (obj.e === -1) {
            if (!manifest) manifest = obj.m;
            return manifest !== null && dec.needed === 0;
          }
          if (typeof obj.p !== 'string') return false;
          const done = dec.add(obj.e, core.b64uDecode(obj.p));
          return done && manifest !== null;
        },
        finish() {
          if (!manifest || dec.needed > 0) return null;
          const block = dec.recover();
          if (!block) return null;
          const out = block.subarray(0, manifest.size);
          return core.sha256Hex(out) === manifest.sha256 ? out : null;
        },
        /** Full rank reached — decodable, manifest or no manifest. */
        get payloadComplete() {
          return dec.needed === 0;
        },
        get rank() {
          return dec.rank;
        }
      };
    }
  };
}

// --- Trial runner ------------------------------------------------------------

/**
 * Runs one transfer over one realisation of the channel.
 *
 * Two passes on purpose. The first walks the slot pattern to find out how many
 * slots the receiver needed and which frames actually arrived; the second
 * replays only those frames into a fresh receiver with a clock around it. That
 * keeps sender-side work (fountain symbol construction, JSON stringify) out of
 * the decode timing, and keeps per-call timer overhead out of the slot counting.
 */
export function runTrial(transport, channelSlot, { maxSlots = 200000 } = {}) {
  const send = transport.sender();
  const rx = transport.receiver();

  const delivered = [];
  let slots = 0;
  let complete = false;
  let payloadFrames = 0;
  let manifestFrames = 0;
  // Payload frames delivered at the moment the receiver could reconstruct,
  // which may be earlier than the moment it is allowed to finish — a receiver
  // holding every symbol still waits for the manifest that names the object.
  let framesAtPayloadComplete = -1;
  let slotsAtPayloadComplete = -1;

  for (let slot = 0; slot < maxSlots; slot++) {
    slots = slot + 1;
    const frame = send(slot);
    if (!channelSlot()) continue;
    delivered.push(frame);
    if (transport.isManifest(frame)) manifestFrames++;
    else payloadFrames++;
    const done = rx.push(frame);
    if (framesAtPayloadComplete < 0 && rx.payloadComplete) {
      framesAtPayloadComplete = payloadFrames;
      slotsAtPayloadComplete = slots;
    }
    if (done) {
      complete = true;
      break;
    }
  }

  const bytesReceived = delivered.reduce((a, f) => a + Buffer.byteLength(f, 'utf8'), 0);
  const minimum = transport.distinct - (transport.kind === 'baseline' ? 1 : 0);
  const base = {
    slots,
    delivered: delivered.length,
    payloadFrames,
    manifestFrames,
    bytesReceived,
    slotsAtPayloadComplete,
    // Payload frames seen beyond the minimum by the time the transfer FINISHED.
    // Includes any symbols that arrived while waiting for a manifest, so it is
    // a transport cost, not a property of the code.
    overhead: payloadFrames - minimum,
    // Payload frames seen beyond the minimum at the moment the receiver could
    // first reconstruct. This is the code's reception overhead and nothing else.
    codingOverhead: framesAtPayloadComplete < 0 ? NaN : framesAtPayloadComplete - minimum
  };
  if (!complete) return { ...base, complete: false, decodeMs: NaN, verified: false };

  // The receiver is constructed inside the timed region: for the shipped
  // fountain, building a decoder means inserting the LDPC and HDPC constraint
  // rows, which is genuine decode work a phone would pay for.
  const t0 = performance.now();
  const rx2 = transport.receiver();
  for (const frame of delivered) rx2.push(frame);
  const payload = rx2.finish();
  const decodeMs = performance.now() - t0;

  return { ...base, complete: true, decodeMs, verified: payload !== null, payload };
}
