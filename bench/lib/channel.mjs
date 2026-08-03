/*!
 * Lossy-channel models for the rvQR benchmark harness.
 *
 * The optical link is a slot machine: the sender paints one QR symbol per frame
 * period, and the receiver's camera either decodes that symbol or it does not.
 * There is no partial delivery and no corruption — a QR symbol that fails its
 * own Reed-Solomon check simply does not decode, so the frame is lost, not
 * wrong. That makes an erasure channel the right abstraction, and it is why a
 * fountain code is the natural fit.
 *
 * Two models are provided because real camera loss is not independent:
 *
 *   - `iid`      Each slot is dropped independently with probability p. The
 *                textbook erasure channel, and the one whose behaviour has a
 *                closed form we can check our simulation against.
 *   - `gilbert`  A two-state Gilbert model: losses arrive in bursts, which is
 *                what actually happens when a hand shakes, the autofocus hunts,
 *                or the phone is moved between screens.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import { mulberry32 } from './rng.mjs';

/**
 * Independent per-slot erasures.
 * Returns a function slot() -> true if the frame in this slot was received.
 */
export function iidChannel(lossRate, seed) {
  const rand = mulberry32(seed);
  return function slot() {
    return rand() >= lossRate;
  };
}

/**
 * Two-state Gilbert channel. In the GOOD state every frame decodes; in the BAD
 * state none do. Parameterised by the target average loss rate and the mean
 * burst length in frames, which is the way a camera failure is actually
 * described ("about half a second of blur at 5 fps" = a burst of 2-3).
 *
 * With pBG = 1/meanBurst the mean BAD run is meanBurst slots, and choosing
 * pGB = lossRate * pBG / (1 - lossRate) makes the stationary probability of
 * being in BAD exactly lossRate — so the long-run loss rate matches the iid
 * model and only the clustering differs.
 */
export function gilbertChannel(lossRate, meanBurst, seed) {
  const rand = mulberry32(seed);
  if (lossRate <= 0) return () => true;
  if (lossRate >= 1) return () => false;
  const pBG = 1 / Math.max(1, meanBurst); // BAD -> GOOD
  const pGB = (lossRate * pBG) / (1 - lossRate); // GOOD -> BAD
  let bad = rand() < lossRate; // start in the stationary distribution
  return function slot() {
    const received = !bad;
    if (bad) {
      if (rand() < pBG) bad = false;
    } else if (rand() < pGB) {
      bad = true;
    }
    return received;
  };
}

export function makeChannel(kind, lossRate, seed, opts = {}) {
  if (kind === 'gilbert') {
    return gilbertChannel(lossRate, opts.meanBurst ?? 3, seed);
  }
  return iidChannel(lossRate, seed);
}

/**
 * Closed-form expectations we can hold the simulation to. Both are for a sender
 * that cycles through n fixed frames forever on an iid erasure channel.
 *
 * `expectedBaselineSlots` is n * E[passes], where the number of passes is the
 * maximum of K independent Geometric(1-p) variables — each distinct frame has
 * to survive at least one pass. E[max of K geometrics] has no tidy closed form;
 * ln(K)/ln(1/p) + 1/2 + gamma/ln(1/p) is the standard asymptotic, and it is
 * accurate to a few percent for the K values in this report. Reported only as a
 * sanity check against the measured value, never in place of it.
 *
 * `couponCollectorDraws` is the classic K*H_K result for the *randomly ordered*
 * variant: if the sender emitted a uniformly random frame index each slot
 * instead of cycling, the receiver would need K*H_K deliveries. Cited in the
 * report as the reason a fixed-index scheme cannot escape a log-K penalty.
 * See Motwani & Raghavan, "Randomized Algorithms" (1995), §3.6.
 */
export function expectedBaselineSlots(n, lossRate) {
  const K = n; // every frame index, manifest included, must arrive at least once
  if (lossRate <= 0) return n;
  const EULER = 0.5772156649015329;
  const passes = Math.log(K) / Math.log(1 / lossRate) + 0.5 + EULER / Math.log(1 / lossRate);
  return n * passes;
}

export function couponCollectorDraws(K) {
  let h = 0;
  for (let i = 1; i <= K; i++) h += 1 / i;
  return K * h;
}
