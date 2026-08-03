/*!
 * Suite 9 — one screen, N receivers, content-addressed peer exchange.
 *
 * The claim under test is a site claim: a hundred devices in one room taking a
 * 1 GB image should cost the source something on the order of a few gigabytes,
 * not a hundred. This suite simulates that and reports the curve.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A MODEL. It is not a measurement of anything optical or wireless.
 * ---------------------------------------------------------------------------
 *
 * WHAT IT CAPTURES
 *   - A rateless code, so any K distinct symbols reconstruct. The reception
 *     overhead applied is the one the overhead suite MEASURED on
 *     artifacts/fountain.js, not an assumption of ideality.
 *   - Broadcast: one painted symbol is offered to every receiver in the same
 *     slot. This is the property that does the work, and it is a property of
 *     the medium, not of any code.
 *   - Independent per-receiver erasure. Receiver i misses a given painted
 *     symbol with probability p, independently of receiver j.
 *   - Content addressing: a symbol is identified by its ESI, so a receiver that
 *     holds it can serve it to a peer and two peers holding the same symbol are
 *     not counted twice.
 *   - The real symbol size and the real QR capacity, so "source traffic" is
 *     bytes actually painted, not payload bytes.
 *
 * WHAT IT DOES NOT CAPTURE — and any of these could dominate in practice
 *   - Whether the peer channel exists at all. artifacts/p2p.js needs WebRTC
 *     signalling; on an air-gapped site that signalling has to happen over the
 *     optical channel too, and that cost is NOT counted here.
 *   - Peer link capacity, contention, range, battery, or the O(N²) discovery
 *     problem. Peer traffic is reported as a byte total and nothing else.
 *   - Correlated loss across receivers. Devices in one room share a glare
 *     source, a refresh beat and a person walking in front of the screen. The
 *     independence assumption is the single most optimistic thing in this file,
 *     and the correlated variant below quantifies how much it matters.
 *   - Any scheduling smarter than "paint the next symbol".
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { mulberry32, deriveSeed } from '../lib/rng.mjs';
import { summarize } from '../lib/stats.mjs';

/**
 * One realisation.
 *
 * The source paints distinct symbols one per slot. Two stopping rules are
 * evaluated on the same realisation, so the comparison is paired:
 *
 *   union     stop when the symbols held SOMEWHERE on the site number K. Every
 *             receiver can then be completed by peer exchange. This is the
 *             swarm case.
 *   broadcast stop when EVERY receiver individually holds K. No peer exchange
 *             at all. This is the control, and it is the number that says how
 *             much of the win is peer exchange and how much is just broadcast.
 *
 * `sharedLoss` folds in correlated loss: with probability `sharedLoss` a slot
 * is lost by everyone at once (someone walked in front of the screen), and
 * otherwise each receiver draws independently at `p`. sharedLoss = 0 is the
 * fully independent case.
 */
function oneTrial({ K, N, p, sharedLoss, seed, maxSlots }) {
  const rand = mulberry32(seed);
  const held = new Int32Array(N);
  let heldAtUnion = null;
  let unionCovered = 0;
  let slots = 0;
  let unionSlots = -1;
  let broadcastSlots = -1;
  let completeReceivers = 0;

  while (slots < maxSlots && (unionSlots < 0 || broadcastSlots < 0)) {
    slots++;
    const blackout = sharedLoss > 0 && rand() < sharedLoss;
    let anyGot = false;
    for (let i = 0; i < N; i++) {
      if (blackout) continue;
      if (rand() < p) continue;
      anyGot = true;
      if (held[i] < K) {
        held[i]++;
        if (held[i] === K) completeReceivers++;
      }
    }
    if (anyGot && unionCovered < K) unionCovered++;
    if (unionSlots < 0 && unionCovered >= K) {
      unionSlots = slots;
      // Snapshot: peer traffic is what the receivers were short of at the
      // moment the SOURCE stopped, not at the end of the simulation loop.
      heldAtUnion = Int32Array.from(held);
    }
    if (broadcastSlots < 0 && completeReceivers === N) broadcastSlots = slots;
  }
  if (!heldAtUnion) heldAtUnion = Int32Array.from(held);

  // Peer traffic under the union rule: every receiver still short pulls exactly
  // the symbols it lacks, once each, from whichever peer has them. A lower
  // bound — no duplicate pulls, no request overhead, no failed peers.
  let peerSymbols = 0;
  let short = 0;
  for (let i = 0; i < N; i++) {
    const missing = Math.max(0, K - heldAtUnion[i]);
    peerSymbols += missing;
    if (missing > 0) short++;
  }

  return {
    unionSlots: unionSlots < 0 ? NaN : unionSlots,
    broadcastSlots: broadcastSlots < 0 ? NaN : broadcastSlots,
    peerSymbols,
    shortReceivers: short
  };
}

/**
 * The fleet curve.
 *
 * `symbolPayloadBytes` and `symbolPaintedBytes` come from the protocol suite —
 * the payload a frame carries and the QR capacity it occupies. Source traffic
 * is reported in painted bytes, because that is what the screen actually spends
 * and it is the honest denominator for a "× artifact size" figure.
 */
export function runFleetSuite({
  artifactBytes = 1024 * 1024 * 1024,
  symbolPayloadBytes = 665,
  symbolPaintedBytes = 792,
  codingOverheadRatio = 1,
  // K is simulated at a tractable size and the resulting MULTIPLIERS are
  // applied to the real artifact. `runFleetScaleCheck` measures whether that
  // substitution is legitimate.
  simulatedK = 2000,
  fleetSizes = [1, 2, 5, 10, 25, 50, 100],
  lossRates = [0.1, 0.3, 0.5],
  sharedLoss = 0,
  trials = 12,
  baseSeed = 20260802,
  fps = 5
} = {}) {
  const realK = Math.ceil((artifactBytes / symbolPayloadBytes) * codingOverheadRatio);
  const rows = [];

  for (const p of lossRates) {
    for (const N of fleetSizes) {
      const union = [];
      const broadcast = [];
      const peer = [];
      for (let t = 0; t < trials; t++) {
        const r = oneTrial({
          K: simulatedK,
          N,
          p,
          sharedLoss,
          seed: deriveSeed(baseSeed, `fleet:${p}:${N}:${t}`),
          maxSlots: simulatedK * 200 + 1000
        });
        union.push(r.unionSlots);
        broadcast.push(r.broadcastSlots);
        peer.push(r.peerSymbols);
      }
      const u = summarize(union);
      const b = summarize(broadcast);
      const pr = summarize(peer);
      // Multipliers are per simulated symbol, so they carry over to any K.
      const unionMult = u.mean / simulatedK;
      const broadcastMult = b.mean / simulatedK;
      const paintPerPayload = symbolPaintedBytes / symbolPayloadBytes;

      rows.push({
        lossRate: p,
        N,
        simulatedK,
        unionSlots: u,
        broadcastSlots: b,
        peerSymbols: pr,
        unionMultiplier: unionMult,
        broadcastMultiplier: broadcastMult,
        // Source traffic as a multiple of the artifact, painted bytes over
        // artifact bytes. The envelope is in here: at v19-L a 665-byte payload
        // occupies a 792-byte symbol, so 1.19× is the floor before any loss.
        sourceTrafficPeer: unionMult * paintPerPayload,
        sourceTrafficBroadcastOnly: broadcastMult * paintPerPayload,
        naiveMultiplier: N,
        peerBytesPerReceiver: (pr.mean / N) * symbolPayloadBytes,
        // Projected onto the real artifact. Arithmetic on a measured multiplier.
        realK,
        projectedSourceBytesPeer: unionMult * realK * symbolPaintedBytes,
        projectedSourceBytesBroadcast: broadcastMult * realK * symbolPaintedBytes,
        projectedNaiveBytes: N * artifactBytes,
        projectedSecondsPeer: (unionMult * realK) / fps
      });
    }
  }

  return {
    available: true,
    model: true,
    artifactBytes,
    symbolPayloadBytes,
    symbolPaintedBytes,
    codingOverheadRatio,
    simulatedK,
    realK,
    fleetSizes,
    lossRates,
    sharedLoss,
    trials,
    baseSeed,
    fps,
    rows
  };
}

/**
 * Is the multiplier really independent of K?
 *
 * The headline number projects a multiplier measured at K=2,000 onto a K of
 * 1.6 million. That is only legitimate if the multiplier is flat in K, which is
 * a claim, so it gets measured at several K rather than asserted.
 */
export function runFleetScaleCheck({
  kValues = [81, 500, 2000, 8000],
  N = 100,
  p = 0.3,
  sharedLoss = 0,
  trials = 8,
  baseSeed = 20260802
} = {}) {
  const rows = kValues.map((K) => {
    const union = [];
    const broadcast = [];
    for (let t = 0; t < trials; t++) {
      const r = oneTrial({
        K,
        N,
        p,
        sharedLoss,
        seed: deriveSeed(baseSeed, `scale:${K}:${t}`),
        maxSlots: K * 200 + 1000
      });
      union.push(r.unionSlots);
      broadcast.push(r.broadcastSlots);
    }
    const u = summarize(union);
    const b = summarize(broadcast);
    return {
      K,
      unionMultiplier: u.mean / K,
      broadcastMultiplier: b.mean / K,
      unionSlots: u,
      broadcastSlots: b
    };
  });
  return { available: true, N, p, sharedLoss, trials, rows };
}
