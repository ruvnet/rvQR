/*!
 * Suite 16 — fleet swarm distribution, artifacts/swarm.js.
 *
 * ---------------------------------------------------------------------------
 * EVERY TIMING BELOW IS A SIMULATION TICK. READ THIS FIRST.
 * ---------------------------------------------------------------------------
 *
 * `simulateSwarm()` is a deterministic simulation and says so from inside
 * itself: `simulation: true`, `wallClockMeasured: false`, `physicalDevices: 0`,
 * `timingUnit: 'ticks'`. This suite carries those four fields into every table
 * it prints, because the distinction they encode is the only thing standing
 * between an honest report and a fabricated fleet result:
 *
 *   - The BYTE COUNTS and CHUNK COUNTS are real measurements OF THE SIMULATION.
 *     Real bytes went through the real verification pipeline on every simulated
 *     receiver, so `sourceBytesMeasured`, `chunksRejected` and
 *     `wrongChunksStored` say what this scheduling policy does.
 *   - The TICK COUNTS MEASURE NOTHING ABOUT ANY FLEET. A tick is a unit
 *     `swarm.js` defines. Nothing in this repository has calibrated one against
 *     a device, a radio or a clock, and a simulated 135 is not 135 of anything.
 *
 * ADR-024 §4.1's Fleet-10 and §4.2's Fleet-100 require TEN and ONE HUNDRED
 * PHYSICAL DEVICES against wall-clock gates of 3 s and 60 s.
 * `describeCriteria()` marks both `requires-device-fleet` and `met: false`, and
 * this suite reports them the same way. Running one hundred simulated receivers
 * is not Fleet-100 and is not presented as an approach to it: heterogeneity —
 * different radios, different thermal limits, different older roots — is most of
 * what that criterion tests and is exactly what a simulation cannot supply.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURES ARE THE TEST FILE'S FIXTURES, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * `swarm.js` takes `digest`, `sign` and `verifySignature` as injected functions
 * and refuses without them. The digest must return LOWERCASE HEX — a receiver
 * compares `options.digest(bytes).toLowerCase()` against a manifest entry — so a
 * digest that returns bytes rather than hex fails every comparison, every chunk
 * is refused, and the run completes nothing while reporting perfectly
 * well-formed zeroes. That failure is silent and it looks like a result.
 *
 * So the injected checks here are the ones `artifacts/swarm.test.js` uses: its
 * FNV-based `digestOf`, its `fakeSign`, and its `SIGNER` constant, reproduced
 * below. They are NOT CRYPTOGRAPHY and nothing here claims they are. What makes
 * that acceptable is `crossCheck` below, which runs one whole configuration a
 * second time with `crypto.sha256` and `crypto.signSync`/`verifySync` wired in
 * and requires the byte counts, the chunk counts and the tick counts to be
 * IDENTICAL. They are. The scheduling result does not depend on which digest is
 * injected, so the cheap one is used for the sweeps and the real one is used to
 * show that the choice does not move a number.
 *
 * The helpers are copied rather than imported because `swarm.test.js` exports
 * only `runAll` and `summarize`; the test file is not modified to widen that.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED
 * ---------------------------------------------------------------------------
 *
 * 1. SOURCE TRAFFIC AGAINST ADR-024 §2.1'S TARGET. The ADR wants under 3× the
 *    artifact off the source link for 100 devices, against up to 100×
 *    point-to-point. Measured at 2, 10, 25, 50 and 100 simulated devices, with
 *    the meter `swarm.js` writes on the line the bytes leave the source —
 *    criterion 6's "measured directly, not inferred". What chunk accounting
 *    WOULD have claimed is carried beside it, because the gap between them is
 *    roughly the fleet size and is the whole quantity in question.
 *
 * 2. THE THREE MALICIOUS BEHAVIOURS — advertise-and-withhold, slow-drip,
 *    corrupt-chunk — each against a no-adversary baseline AND against a BENIGN
 *    CONTROL: the identical run with one extra HONEST peer in the same slot.
 *    The control exists because adding any peer at all reshuffles a rarest-first
 *    schedule, and at fleet sizes of 25 and above that reshuffle is larger than
 *    two of the three attacks. A cost measured only against the no-peer baseline
 *    would be reporting scheduling noise as an attack.
 *
 * 3. THE COST OF THE DEFENCE. Deprioritising a peer costs the attempts spent
 *    discovering it should be deprioritised. How many attempts a failing peer
 *    gets is re-derived from the exported `peerScore`/`rankProviders` rather
 *    than inferred from the simulation, and what those attempts cost is then
 *    read off the run: timeouts, rejected chunks, bytes that crossed a peer link
 *    and were discarded, extra source bytes, extra ticks. The measured
 *    no-deprioritisation contrast is slow-drip, on which the floor never fires
 *    at all.
 *
 * 4. CONTENT-ADDRESSED SAVING. ADR-024 §2.1's claim is that a chunk a peer
 *    already holds is a chunk the source never sends. The peer tier cannot be
 *    switched off by configuration — a device advertises what it has verified,
 *    and there is no flag — so the without-peers arm is a MEASURED SINGLE-DEVICE
 *    RUN multiplied by the fleet size, which is what point-to-point means. The
 *    multiplication is arithmetic over a measured figure and is labelled as such
 *    everywhere it appears.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE DOES NOT ESTABLISH
 * ---------------------------------------------------------------------------
 *
 *   - **No wall clock, anywhere.** No seconds are quoted, no 3 s gate is
 *     evaluated, no 60 s gate is evaluated.
 *   - **No broadcast tier.** ADR-024 §2.1's third mechanism is
 *     RaptorQ-STRUCTURED and explicitly NOT RFC 6330 conformant; `swarm.js`
 *     names it through one constant and this suite reproduces that constant
 *     verbatim wherever the tier appears. Nothing here encodes or decodes a
 *     fountain symbol.
 *   - **No BitChat, no chunk store, no custody receipts.** The peer set arrives
 *     as data. `describeUnimplemented()` is read out of the running module into
 *     the report rather than restated here.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../lib/transports.mjs';

const require = createRequire(import.meta.url);

export function loadSwarm() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'swarm.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

export function loadCrypto() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'crypto.js');
  try {
    return { module: require(candidate), path: candidate };
  } catch {
    return null;
  }
}

// --- The injected checks -----------------------------------------------------

/**
 * `artifacts/swarm.test.js`'s signer identity, digest and signer, reproduced
 * exactly.
 *
 * NEITHER IS CRYPTOGRAPHY. `digestOf` is four FNV-1a passes concatenated to 64
 * hex characters — the right SHAPE for a digest, which is all `swarm.js`
 * requires of an injected one, and none of the strength. It is here because the
 * sweeps below run several hundred thousand chunk verifications and because
 * `crossCheck` establishes that swapping it for the real SHA-256 changes no
 * number this suite reports.
 */
const SIGNER = 'fleet-source-v3';

function fnv(bytes, seed) {
  let hi = seed >>> 0;
  let lo = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    lo = Math.imul(lo, 16777619) >>> 0;
    hi = (hi ^ (lo + i)) >>> 0;
    hi = Math.imul(hi, 2246822519) >>> 0;
  }
  return ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8);
}

export function digestOf(bytes) {
  return fnv(bytes, 0x1234) + fnv(bytes, 0x9e37) + fnv(bytes, 0x85eb) + fnv(bytes, 0xc2b2);
}

const encode = (text) => new TextEncoder().encode(text);

export function fakeSign(message) {
  return digestOf(encode(SIGNER + ' ' + message)) + digestOf(encode(message + ' ' + SIGNER));
}

/**
 * The three injected functions, as one object. `sign` is present, so the
 * manifest is signed and every simulated receiver anchors on a verified
 * signature rather than on `acceptUnsignedManifest`. Without it the policy the
 * simulation builds accepts an unsigned manifest, which is a different and
 * weaker configuration than the one ADR-024 describes.
 */
export function standInChecks() {
  return {
    digest: digestOf,
    sign: fakeSign,
    verifySignature: (desc) => desc.signature === fakeSign(desc.message)
  };
}

/**
 * The same three functions built from `artifacts/crypto.js`: real SHA-256, real
 * Ed25519. Half of ADR-012's hybrid scheme and no more — there is no ML-DSA-65
 * in this repository and none is projected here.
 *
 * The seed is fixed so the signature bytes are the same on every run.
 */
export function realChecks(K) {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 13) & 0xff;
  const publicKey = K.publicKeyFromSeed(seed);
  return {
    digest: (bytes) => K.toHex(K.sha256(bytes)),
    sign: (message) => K.toHex(K.signSync(seed, encode(message))),
    verifySignature: (desc) => K.verifySync(publicKey, encode(desc.message), K.fromHex(desc.signature))
  };
}

// --- The cost model, passed rather than assumed ------------------------------

/**
 * What a tick costs, stated by this suite instead of inherited.
 *
 * `simulateSwarm`'s defaults are these values, but `SIM_DEFAULTS` is not
 * exported and a tick column that cannot be read against the numbers which
 * produced it is a column nobody can check. So every configuration below passes
 * them explicitly: the timeout column is `timeoutTicks` per timeout because this
 * file set `timeoutTicks`, not because a default was assumed to still be 8.
 *
 * The slot counts are passed for the same reason and are all 1: one outstanding
 * request per receiver, one concurrent response per provider. That is the
 * pessimistic end of the scale and the concurrency sweep shows what relaxing it
 * does in both directions.
 */
export const COST_MODEL = {
  chunkTicks: 1,
  timeoutTicks: 8,
  slowTicks: 6,
  deviceSlots: 1,
  sourceSlots: 1,
  peerSlots: 1
};

function baseConfig({ devices, chunkSize, chunkCount, seed, overrides = {} }) {
  return {
    deviceCount: devices,
    chunkSize,
    chunkCount,
    seed,
    ...COST_MODEL,
    ...overrides
  };
}

// --- One run, reduced to the fields the report uses --------------------------

/**
 * Everything this suite reads out of one simulation report, in one shape.
 *
 * `chunksFromSource` and `chunksFromPeers` are summed over receivers rather
 * than taken from the source meter, because they answer a different question:
 * the meter says what the LINK carried, these say where each admitted chunk
 * came from. The two are related by the fleet size and the relationship is the
 * mechanism ADR-024 §2.1 is about, so both are reported.
 */
export function summarizeRun(report, { pointToPointPerDeviceBytes = null } = {}) {
  const fromSource = report.receivers.reduce((n, r) => n + r.acceptedFromSource, 0);
  const fromPeers = report.receivers.reduce((n, r) => n + r.acceptedFromPeers, 0);
  const devices = report.fleetSizeSimulated;
  const p2p = pointToPointPerDeviceBytes === null ? null : pointToPointPerDeviceBytes * devices;
  return {
    devices,
    completed: report.completed,
    artifactBytes: report.artifactBytes,
    chunkSize: report.chunkSize,
    chunkCount: report.chunkCount,

    // measurements OF THE SIMULATION
    sourceBytesMeasured: report.source.bytesMeasured,
    sourceResponses: report.source.responsesMeasured,
    ratioToArtifact: report.source.ratioToArtifact,
    withinThreeTimesTarget: report.source.ratioToArtifact !== null && report.source.ratioToArtifact < 3,
    bytesInferredFromChunkAccounting: report.source.bytesInferredFromChunkAccounting,
    inferenceUnderstatesByBytes: report.source.inferenceUnderstatesByBytes,

    chunksFromSource: fromSource,
    chunksFromPeers: fromPeers,
    peerShare: fromSource + fromPeers ? fromPeers / (fromSource + fromPeers) : NaN,

    // point-to-point: arithmetic over a MEASURED one-device run
    pointToPointBytesProjected: p2p,
    savingVsPointToPoint: p2p ? p2p / report.source.bytesMeasured : null,

    // SIMULATION TICKS. Not seconds. Not a fleet measurement.
    ticksToComplete: report.ticksToComplete,
    ticksToFirstDeviceComplete: report.ticksToFirstDeviceComplete,

    chunksRejected: report.chunksRejected,
    chunksTimedOut: report.chunksTimedOut,
    adversarialBytesAccepted: report.adversarial.bytesAccepted,
    wrongChunksStored: report.audit.wrongChunksStored,
    chunksAudited: report.audit.chunksAudited,
    reassembledCorrectly: report.audit.receiversReassembledCorrectly,
    reassembledWrong: report.audit.receiversReassembledWrong,

    // carried, not restated
    simulation: report.simulation,
    wallClockMeasured: report.wallClockMeasured,
    physicalDevices: report.physicalDevices,
    timingUnit: report.timingUnit
  };
}

// --- 1 and 4: source traffic, and what peer exchange saves -------------------

/**
 * The source-traffic ladder, and the without-peers arm beside it.
 *
 * The without-peers arm is a ONE-DEVICE run, measured, multiplied by the fleet
 * size. That is what point-to-point is: a device with no peer to ask fetches
 * every chunk from the source, and n of them fetch n × the artifact. The
 * multiplication is arithmetic and is labelled `Projected` in the field name so
 * it cannot be read as an n-device measurement.
 *
 * The peer tier cannot be disabled by configuration — `advertise()` is derived
 * from the store and every device that has verified a chunk holds it — so the
 * one-device run is the only honest "peers off" arm available. It is also the
 * exact quantity ADR-024 §1 quotes ("a 100-device site taking a 1 GB image is up
 * to 100 GB of source traffic"), which is what makes it the right comparison
 * rather than merely the available one.
 */
export function runSourceLadder(S, checks, { deviceCounts, chunkSize, chunkCount, seed }) {
  const solo = S.simulateSwarm(baseConfig({ devices: 1, chunkSize, chunkCount, seed }), checks);
  const perDevice = solo.source.bytesMeasured;

  const rows = deviceCounts.map((devices) => {
    const report = S.simulateSwarm(baseConfig({ devices, chunkSize, chunkCount, seed }), checks);
    return summarizeRun(report, { pointToPointPerDeviceBytes: perDevice });
  });

  return {
    rows,
    solo: summarizeRun(solo, { pointToPointPerDeviceBytes: perDevice }),
    // A one-device run that served more than the artifact would mean the source
    // was re-serving chunks to a single receiver, and every saving figure below
    // would be measured against a padded baseline. It is checked rather than
    // assumed.
    soloServedExactlyTheArtifact: perDevice === solo.artifactBytes,
    pointToPointPerDeviceBytesMeasured: perDevice,
    chunkSize,
    chunkCount,
    seed
  };
}

/**
 * The same ladder's top row under several seeds.
 *
 * A single-seed number presented as the answer would be one draw of a
 * rarest-first schedule reported as a property of the design. The spread is
 * small — which is itself worth showing rather than asserting.
 */
export function runSeedSpread(S, checks, { devices, chunkSize, chunkCount, seeds }) {
  const rows = seeds.map((seed) => {
    const report = S.simulateSwarm(baseConfig({ devices, chunkSize, chunkCount, seed }), checks);
    return { seed, ...summarizeRun(report) };
  });
  const ratios = rows.map((r) => r.ratioToArtifact).filter((n) => Number.isFinite(n));
  const ticks = rows.map((r) => r.ticksToComplete).filter((n) => Number.isFinite(n));
  return {
    devices,
    rows,
    minRatio: ratios.length ? Math.min(...ratios) : NaN,
    maxRatio: ratios.length ? Math.max(...ratios) : NaN,
    minTicks: ticks.length ? Math.min(...ticks) : NaN,
    maxTicks: ticks.length ? Math.max(...ticks) : NaN,
    allWithinTarget: rows.every((r) => r.withinThreeTimesTarget)
  };
}

/**
 * How the ratio moves with chunk granularity, at a fixed fleet size.
 *
 * This is the sensitivity that matters for reading the ladder against ADR-024's
 * own example. The ADR's case is 100 devices × 1 GB; the artifacts here are
 * kilobytes. What carries between the two is not the byte size but the CHUNK
 * COUNT, because a swarm trades chunks and a fleet with more of them has more
 * to trade. So the ratio is swept against chunk count and the trend is reported
 * rather than one row being quoted as though size did not matter.
 */
export function runShapeSweep(S, checks, { devices, chunkSize, chunkCounts, seed }) {
  return chunkCounts.map((chunkCount) => {
    const report = S.simulateSwarm(baseConfig({ devices, chunkSize, chunkCount, seed }), checks);
    return summarizeRun(report);
  });
}

/**
 * What concurrency does to the two quantities, which move in opposite
 * directions and are easy to quote one at a time.
 *
 * `deviceSlots` is how many requests a receiver has outstanding; `peerSlots` is
 * how many a device will serve. More receiver concurrency without more serving
 * concurrency finishes sooner AND costs the source more, because a device with
 * two requests in flight finds peers busy and falls back to the source. This is
 * a trade the ADR does not discuss and the report states it as measured rather
 * than recommending a setting.
 */
export function runConcurrencySweep(S, checks, { devices, chunkSize, chunkCount, seed, pairs }) {
  return pairs.map(([deviceSlots, peerSlots]) => {
    const report = S.simulateSwarm(
      baseConfig({ devices, chunkSize, chunkCount, seed, overrides: { deviceSlots, peerSlots } }), checks
    );
    return { deviceSlots, peerSlots, ...summarizeRun(report) };
  });
}

// --- 2: the three behaviours, with a benign control --------------------------

/**
 * `compareBehaviours()` at one fleet size, plus a control it does not run.
 *
 * TWO COMPARATORS, AND THEY ANSWER DIFFERENT QUESTIONS. Neither is "the" cost of
 * an attack and the report gives both rather than choosing.
 *
 *   baseline   what `compareBehaviours` returns: the same swarm with NO extra
 *              peer at all. This difference contains the attack AND the fact
 *              that an extra peer reorders the schedule — a peer changes the
 *              holder counts a rarest-first scheduler sorts on, so the whole
 *              request order moves. At 25 devices and above the reordering is
 *              larger than two of the three attacks, and the difference comes
 *              out NEGATIVE: a swarm that finishes in fewer ticks with an
 *              adversary in it. That is a scheduling artefact, not an attack
 *              that helps, and quoting it without the control would be
 *              reporting one as the other.
 *
 *   control    the identical run with one extra HONEST peer in the same slot,
 *              holding the whole artifact from the start — which is exactly what
 *              each adversary CLAIMS to be. This is not a noise floor: an honest
 *              seed peer really does supply bytes, so it lowers source traffic
 *              and finishes sooner. The difference against it is the OPPORTUNITY
 *              COST — what the fleet lost by that slot being occupied by a liar
 *              rather than by the seeder it advertised itself as.
 */
export function runBehaviourComparison(S, checks, { devices, chunkSize, chunkCount, seed }) {
  const cfg = baseConfig({ devices, chunkSize, chunkCount, seed });
  const cmp = S.compareBehaviours(cfg, checks);

  const control = S.simulateSwarm(
    { ...cfg, peers: [{ id: 'adversary', behaviour: S.BEHAVIOUR_HONEST }] }, checks
  );
  const controlProvider = control.perProvider.find((p) => p.id === 'peer:adversary') || null;

  const rows = cmp.behaviours.map((row) => {
    const provider = row.report.perProvider.find((p) => p.id === 'peer:adversary') || null;
    const chunk = row.report.chunkSize;
    return {
      behaviour: row.behaviour,
      label: row.label,
      completed: row.completed,
      ticksToComplete: row.ticksToComplete,
      extraTicksVsBaseline: row.extraTicksVsBaseline,
      extraTicksVsControl: row.completed && control.completed
        ? row.ticksToComplete - control.ticksToComplete : null,
      sourceBytesMeasured: row.sourceBytesMeasured,
      extraSourceBytesVsBaseline: row.extraSourceBytesVsBaseline,
      extraSourceBytesVsControl: row.sourceBytesMeasured - control.source.bytesMeasured,

      chunksRejected: row.chunksRejected,
      chunksTimedOut: row.chunksTimedOut,

      // The two zeroes, kept apart. `wrongChunksStored` is the security claim
      // and is audited independently of the path that stored the chunks.
      // `adversarialBytesAccepted` is NOT required to be zero and is nonzero for
      // slow-drip by design: its chunks digest to the value the signed manifest
      // commits, so they are admitted because they are the right bytes.
      wrongChunksStored: row.wrongChunksStored,
      adversarialBytesAccepted: row.adversarialBytesAccepted,
      reassembledWrong: row.report.audit.receiversReassembledWrong,
      reassembledCorrectly: row.report.audit.receiversReassembledCorrectly,
      chunksAudited: row.report.audit.chunksAudited,

      // what the adversary itself was asked for and did
      requested: provider ? provider.requested : 0,
      delivered: provider ? provider.delivered : 0,
      accepted: provider ? provider.accepted : 0,
      rejected: provider ? provider.rejected : 0,
      timedOut: provider ? provider.timedOut : 0,
      bytesAcceptedFromAdversary: provider ? provider.bytesAccepted : 0,
      // Bytes that crossed a peer link and were thrown away. Only corruption
      // produces these: a withholder sends nothing at all.
      bytesDiscardedOnArrival: provider ? provider.rejected * chunk : 0,
      // Requests per device — the quantity the score floor bounds.
      attemptsPerDevice: provider && devices ? provider.requested / devices : 0
    };
  });

  return {
    devices,
    chunkSize,
    chunkCount,
    seed,
    baseline: cmp.baseline,
    control: {
      completed: control.completed,
      ticksToComplete: control.ticksToComplete,
      sourceBytesMeasured: control.source.bytesMeasured,
      // Against the no-peer baseline, so the size of the reordering is a number
      // and not an excuse.
      ticksVsBaseline: control.completed && cmp.baseline.completed
        ? control.ticksToComplete - cmp.baseline.ticksToComplete : null,
      sourceBytesVsBaseline: control.source.bytesMeasured - cmp.baseline.sourceBytesMeasured,
      requested: controlProvider ? controlProvider.requested : 0,
      accepted: controlProvider ? controlProvider.accepted : 0,
      bytesAccepted: controlProvider ? controlProvider.bytesAccepted : 0
    },
    rows,
    allWrongChunksZero: rows.every((r) => r.wrongChunksStored === 0),
    allReassembledCorrect: rows.every((r) => r.reassembledWrong === 0),
    allCompleted: rows.every((r) => r.completed),
    // Passed into the configuration above, not inherited from a default, so the
    // tick columns can be read against the numbers that produced them.
    costModel: COST_MODEL,
    simulation: cmp.simulation,
    wallClockMeasured: cmp.wallClockMeasured,
    timingUnit: cmp.timingUnit
  };
}

// --- 3: what the defence costs -----------------------------------------------

/**
 * How many attempts a failing peer gets before the floor drops it, re-derived
 * from the exported scoring functions rather than inferred from a run.
 *
 * `peerScore` is `(accepted − 2 × failures) / requested` and the floor is −0.5,
 * so one failure against one request scores −2 and the peer is ineligible from
 * then on. That is one attempt PER DEVICE — reputation is not shared, so the
 * fleet pays the discovery once per receiver, which is the expensive direction
 * and the one `swarm.js` chose deliberately.
 *
 * Both failure modes are walked, because they cost differently: a timeout costs
 * `timeoutTicks` of a device's only slot and moves no bytes, and a rejection
 * costs one chunk across a peer link and a digest.
 */
export function runFloorTrajectory(S, { steps = 4 }) {
  const walk = (kind) => {
    let ledger = S.newLedger();
    const rows = [];
    for (let i = 1; i <= steps; i++) {
      ledger = S.noteRequest(ledger, 'peer:probe');
      ledger = kind === 'timeout'
        ? S.noteTimeout(ledger, 'peer:probe', 8)
        : S.noteDelivery(ledger, 'peer:probe', { admitted: false, bytes: 64, ticks: 1 });
      const ranked = S.rankProviders(S.measurementsOf(ledger), ['peer:probe'])[0];
      rows.push({ attempts: i, score: ranked.score, eligible: ranked.eligible });
    }
    return rows;
  };

  const timeouts = walk('timeout');
  const rejections = walk('rejection');
  const firstIneligible = (rows) => {
    const hit = rows.find((r) => !r.eligible);
    return hit ? hit.attempts : null;
  };

  // A peer that is never WRONG is never dropped, however slow it is. Walked
  // here so the asymmetry is a measured pair of rows rather than a claim.
  let slow = S.newLedger();
  for (let i = 0; i < steps; i++) {
    slow = S.noteRequest(slow, 'peer:slow');
    slow = S.noteDelivery(slow, 'peer:slow', { admitted: true, bytes: 64, ticks: 6 });
  }
  const slowRank = S.rankProviders(S.measurementsOf(slow), ['peer:slow'])[0];

  return {
    scoreFloor: S.SCORE_FLOOR,
    failureWeight: S.FAILURE_WEIGHT,
    trialScore: S.TRIAL_SCORE,
    timeouts,
    rejections,
    attemptsBeforeDroppedOnTimeout: firstIneligible(timeouts),
    attemptsBeforeDroppedOnRejection: firstIneligible(rejections),
    slowPeer: { score: slowRank.score, eligible: slowRank.eligible, meanTicks: slowRank.meanTicks },
    perDevice: true,
    note: 'These are attempts PER DEVICE. A ledger belongs to one receiver and reputation is never ' +
      'shared, because a reputation arriving from a peer would be a claim and this design does not act ' +
      'on claims.'
  };
}

/**
 * What those attempts actually cost, read off the behaviour runs.
 *
 * The projection column is the counterfactual the code does not have: with no
 * floor, a peer that fails is asked again for the next chunk, so the fleet would
 * spend up to `devices × chunkCount` attempts on it instead of the measured
 * total. It is arithmetic over the measured attempt cost and is labelled a
 * projection in the field name and in the report.
 *
 * The MEASURED no-floor case is slow-drip, on which the floor never fires
 * because the peer is never wrong. Its attempt count is not a projection of
 * anything and is the strongest available evidence for what the floor is worth.
 */
export function summarizeDefenceCost(comparison, floor) {
  const { devices, chunkCount, chunkSize, costModel } = comparison;
  return comparison.rows.map((row) => {
    const dropped = row.behaviour !== 'slow-drip';
    const wastedTickSlots = row.timedOut * costModel.timeoutTicks + row.rejected * costModel.chunkTicks;
    return {
      behaviour: row.behaviour,
      label: row.label,
      floorFires: dropped,
      attemptsMeasured: row.requested,
      attemptsPerDevice: row.attemptsPerDevice,
      attemptsBoundPerDevice: dropped
        ? (row.timedOut ? floor.attemptsBeforeDroppedOnTimeout : floor.attemptsBeforeDroppedOnRejection)
        : null,
      // Device-slot ticks spent on this peer. Not the critical path — a device
      // has other work — which is why it is reported beside the critical-path
      // figure and not instead of it.
      wastedTickSlots,
      criticalPathTicksVsControl: row.extraTicksVsControl,
      bytesDiscardedOnArrival: row.bytesDiscardedOnArrival,
      extraSourceBytesVsControl: row.extraSourceBytesVsControl,
      // PROJECTION, arithmetic: the same per-attempt cost, paid once per chunk
      // per device instead of once per device.
      attemptsWithoutFloorProjected: dropped ? devices * chunkCount : row.requested,
      wastedTickSlotsWithoutFloorProjected: dropped
        ? (row.timedOut ? devices * chunkCount * costModel.timeoutTicks
          : devices * chunkCount * costModel.chunkTicks)
        : wastedTickSlots,
      bytesDiscardedWithoutFloorProjected: row.rejected ? devices * chunkCount * chunkSize : 0,
      projection: dropped
    };
  });
}

// --- The cross-check ----------------------------------------------------------

/**
 * The same configuration twice: once with the stand-in digest and signer, once
 * with `crypto.sha256` and `crypto.signSync`/`verifySync`.
 *
 * If any counted quantity differed, every table in this suite would be a report
 * about FNV rather than about scheduling. The fields compared are the ones the
 * report prints.
 */
export function runCrossCheck(S, K, { devices, chunkSize, chunkCount, seed }) {
  if (!K) return { available: false, reason: 'artifacts/crypto.js is not present' };
  const cfg = baseConfig({ devices, chunkSize, chunkCount, seed });
  const cheap = summarizeRun(S.simulateSwarm(cfg, standInChecks()));
  const real = summarizeRun(S.simulateSwarm(cfg, realChecks(K)));
  const fields = [
    'completed', 'sourceBytesMeasured', 'sourceResponses', 'ratioToArtifact',
    'chunksFromSource', 'chunksFromPeers', 'ticksToComplete', 'ticksToFirstDeviceComplete',
    'chunksRejected', 'chunksTimedOut', 'wrongChunksStored', 'chunksAudited', 'reassembledCorrectly'
  ];
  const disagreements = fields.filter((f) => cheap[f] !== real[f]);
  return {
    available: true,
    devices,
    chunkSize,
    chunkCount,
    seed,
    fields,
    cheap,
    real,
    disagreements,
    identical: disagreements.length === 0,
    digestName: 'SHA-256 (artifacts/crypto.js)',
    signatureName: 'Ed25519 (artifacts/crypto.js, signSync/verifySync)',
    note: 'Ed25519 is HALF of ADR-012’s hybrid scheme. There is no ML-DSA-65 in this repository and no ' +
      'post-quantum signature was produced, verified or timed anywhere in this suite.'
  };
}

// --- The suite ----------------------------------------------------------------

export function runSwarmSuite({
  deviceCounts,
  behaviourAt,
  chunkSize = 64,
  chunkCount = 64,
  seed = 7,
  seeds,
  chunkCounts,
  concurrencyPairs,
  crossCheckDevices = 10
} = {}) {
  const shipped = loadSwarm();
  if (!shipped) return { available: false, reason: 'artifacts/swarm.js not present' };
  const S = shipped.module;
  const loadedCrypto = loadCrypto();

  const checks = standInChecks();
  const counts = deviceCounts || [2, 10, 25, 50, 100];
  const behaviourSizes = behaviourAt || [10, 100];
  const seedList = seeds || [7, 1234, 4321, 20260802, 99];
  const shapeCounts = chunkCounts || [16, 32, 64, 128];
  const pairs = concurrencyPairs || [[1, 1], [2, 1], [1, 2], [4, 4]];

  const ladder = runSourceLadder(S, checks, { deviceCounts: counts, chunkSize, chunkCount, seed });
  const topDevices = counts[counts.length - 1];

  const seedSpread = runSeedSpread(S, checks, { devices: topDevices, chunkSize, chunkCount, seeds: seedList });
  const shapeSweep = runShapeSweep(S, checks, { devices: topDevices, chunkSize, chunkCounts: shapeCounts, seed });
  const concurrency = runConcurrencySweep(S, checks, { devices: topDevices, chunkSize, chunkCount, seed, pairs });

  const floor = runFloorTrajectory(S, { steps: 4 });

  const behaviours = behaviourSizes.map((devices) =>
    runBehaviourComparison(S, checks, { devices, chunkSize, chunkCount, seed })
  );
  const defenceCost = behaviours.map((c) => ({
    devices: c.devices,
    rows: summarizeDefenceCost(c, floor)
  }));

  const crossCheck = runCrossCheck(S, loadedCrypto ? loadedCrypto.module : null, {
    devices: crossCheckDevices, chunkSize, chunkCount, seed
  });

  return {
    available: true,
    path: shipped.path,
    cryptoPath: loadedCrypto ? loadedCrypto.path : null,
    exports: shipped.exports.length,

    // Read out of the running module rather than restated here, for the reason
    // closure.mjs reads `describeUnimplemented()`: a caveat that lives only in a
    // report is a caveat that stops being read.
    broadcastTier: S.describeBroadcastTier(),
    broadcastCodec: S.BROADCAST_CODEC,
    criteria: S.describeCriteria(),
    unimplemented: S.describeUnimplemented(),
    limits: S.describeLimits(),

    constants: {
      scoreFloor: S.SCORE_FLOOR,
      failureWeight: S.FAILURE_WEIGHT,
      trialScore: S.TRIAL_SCORE,
      behaviours: S.BEHAVIOURS,
      behaviourLabels: S.BEHAVIOUR_LABELS,
      simulationDeviceLimit: S.LIMITS.simulationDevices,
      simulationTickLimit: S.LIMITS.simulationTicks
    },

    digestName: 'FNV-based 64-hex stand-in (artifacts/swarm.test.js), NOT cryptography',
    signatureName: 'deterministic stand-in signer (artifacts/swarm.test.js), NOT cryptography',
    costModel: COST_MODEL,
    config: { chunkSize, chunkCount, seed, deviceCounts: counts, behaviourAt: behaviourSizes },

    ladder,
    seedSpread,
    shapeSweep,
    concurrency,
    floor,
    behaviours,
    defenceCost,
    crossCheck,

    // What no amount of running this suite can produce, said here as well as in
    // the module, because this is the file a reader reaches for when they want a
    // fleet number.
    fleetGates: {
      measured: false,
      reason: 'ADR-024 §4.1 Fleet-10 and §4.2 Fleet-100 require TEN and ONE HUNDRED PHYSICAL DEVICES ' +
        'against wall-clock gates of 3 s and 60 s. There is no device fleet, no site and no wall-clock ' +
        'harness in this repository. Every timing in this suite is a SIMULATION TICK; a tick is a unit ' +
        'swarm.js defines and nothing has calibrated one against a device. Running one hundred ' +
        'simulated receivers is not Fleet-100 and is not an approach to it.'
    }
  };
}
