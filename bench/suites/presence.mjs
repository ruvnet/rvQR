/*!
 * Suite 17 — physical presence fusion, artifacts/presence.js.
 *
 * ---------------------------------------------------------------------------
 * ALL THREE CHANNELS ARE UNIMPLEMENTED. READ THIS FIRST.
 * ---------------------------------------------------------------------------
 *
 * ADR-023 §1 names three presence channels — optical line-of-sight, an
 * ultrasonic challenge-response, and radio ranging — and this repository
 * implements NONE of them. There is no ultrasonic code anywhere here: no
 * AudioContext, no oscillator, no encoder and no decoder. There is no ranging
 * code, and no browser exposes a UWB API at all, so there is not even a platform
 * surface to build one on. The optical transport exists and measures nothing
 * about presence — a photograph of a screen is exactly the substitution ADR-023
 * §2.2 names. `describeChannels()` reports every channel `status:
 * "unimplemented"`, `readerSupplied: false`, and this suite reads that out of
 * the running module rather than restating it.
 *
 * So this suite measures the FUSION RULE and nothing whatsoever about physical
 * presence. **rvQR does not sense proximity.** Every channel takes its answer
 * from `opts.readers[channel]`, an injected function supplied by a caller that
 * has hardware; there is no such caller, so every signal in every table below is
 * a SIMULATION OF A SIGNAL and never a signal. Where a table says a channel
 * passed, what passed was a stub returning `true`.
 *
 * ---------------------------------------------------------------------------
 * WHAT ADR-023 §4 ASKS FOR THAT THIS CANNOT SUPPLY
 * ---------------------------------------------------------------------------
 *
 * Criterion 4 requires a relay attempt to be MEASURED — two devices, two rooms,
 * a relay in between, and a report of which channels it defeats. That is
 * hardware and it is NOT MET. Nothing here simulates a relay and nothing here
 * reports which channels one defeats. What this suite does report is which
 * channels a relay would have to defeat SIMULTANEOUSLY for a claim to exist at
 * all under the pair relation, which is a property of the rule; it is labelled
 * `reasoning` in the module and is labelled reasoning here.
 *
 * Criterion 6 requires the UI wording to be reviewed against §3's over-claiming
 * risk. Nothing is wired to a UI, so there is no wording to review, and it is
 * NOT MET either. `describeAcceptance()` marks both `unmet` from inside the
 * running module.
 *
 * ---------------------------------------------------------------------------
 * WHY COVERAGE AND COST, RATHER THAN THROUGHPUT
 * ---------------------------------------------------------------------------
 *
 * `presence.js` moves no bytes. Like `attest.js` it is a pure decision procedure
 * over plain data, so a bytes-per-second figure would be a category error. The
 * quantities that matter are whether it decides the right way in every state it
 * defines, whether anything can talk it into a wrong yes, and whether it is
 * cheap enough to run per transfer:
 *
 * 1. THE FULL DECISION MATRIX. Every one of the seven per-channel outcomes on
 *    every one of the three channels, crossed against six policy shapes — and
 *    then the whole 7×7×7 product of per-channel outcomes, all 343 of them,
 *    every one driven through the shipped `verifyPresence`. THE TABLE IS THE
 *    RESULT. Any cell where a SINGLE passing channel corroborates is a defect
 *    and is reported as one rather than adjusted away.
 *
 * 2. THE PAIR RELATION IS NOT A COUNT. `presence.js` enumerates
 *    `CORROBORATING_PAIRS` rather than thresholding, specifically so that a
 *    threshold cannot be tuned to 1. That is demonstrated rather than asserted:
 *    440 policy inputs — including invented `minChannels`, `threshold`, `quorum`
 *    and `minCorroboratingPairs` fields — are put through `normalizePolicy` and
 *    then through the gate against a one-perfect-channel verdict, and the
 *    dropped fields are named individually. The counterfactual is reported
 *    beside it: whether adding one perfect channel ever changes `admit` from
 *    what the EMPTY report would have got under the identical policy. If it
 *    never does, that channel authorized nothing.
 *
 * 3. FAIL-CLOSED COVERAGE. Outcomes and states that do not exist, absent
 *    fields, wrong types, oversized fields, cross-channel recordings, and a
 *    policy that has declared nothing. Reported as the fraction producing a
 *    REFUSAL rather than a throw or an authorization — three outcomes and not
 *    two, because a security path that throws is as broken as one that admits,
 *    just louder.
 *
 * 4. COST. Median microseconds for a fusion decision and for building the
 *    transcript and the receipt. Whether that is negligible against a transfer
 *    measured in seconds is answered with the measured number rather than
 *    asserted.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURES ARE THE TEST FILE'S FIXTURES, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * The session id, the peer id and — critically — the three PER-CHANNEL
 * challenges below are `artifacts/presence.test.js`'s, reproduced exactly.
 * `presence.js` issues a separate challenge for each channel precisely so a
 * recording captured off one cannot be presented as another, so a fixture that
 * used one shared challenge would leave two of three channels `unbound` on
 * every row, and the matrix would report a very strict module instead of an
 * untested one. That failure is silent and it looks like a result.
 *
 * The helpers are copied rather than imported because `presence.test.js` exports
 * only `runAll` and `summarize`; the test file is not modified to widen that.
 * What makes the copy trustworthy is `testSuite` in the result, which RUNS the
 * shipped test file against the shipped module in this same process and carries
 * its pass count into the report — and `fixtureCheck`, which asserts that the
 * baseline recipes actually reach the states they are built to reach before any
 * table is built on them.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../lib/transports.mjs';
import { summarize } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

export function loadPresence() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'presence.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

export function loadPresenceTests() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'presence.test.js');
  try {
    return { module: require(candidate), path: candidate };
  } catch {
    return null;
  }
}

// --- Fixtures ----------------------------------------------------------------
// `artifacts/presence.test.js`'s, verbatim. See the docblock: the per-channel
// challenges are the part that cannot be simplified without silently zeroing
// every table.

const SESSION = 'sess-7c1a';
const PEER = 'peer-key-9f3c';

/** One challenge PER CHANNEL. A recording off one channel is not another's. */
const CHALLENGE = {
  optical: 'chal-opt-2b8e',
  acoustic: 'chal-aco-5d71',
  ranging: 'chal-rng-9f20'
};

const CLASS = 'credential';

function merge(base, extra) {
  if (extra === undefined) return base;
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra;
  const out = {};
  for (const k of Object.keys(base || {})) out[k] = base[k];
  for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

/** A well-formed signal on one channel, for this session. */
function sig(channel, over) {
  return merge({ channel, sessionId: SESSION, challenge: CHALLENGE[channel] }, over);
}

/** The sender's side of the binding for this activation. */
function expected(over) {
  return merge({
    sessionId: SESSION,
    challenges: { optical: CHALLENGE.optical, acoustic: CHALLENGE.acoustic, ranging: CHALLENGE.ranging },
    spent: { optical: [], acoustic: [], ranging: [] }
  }, over);
}

/**
 * A pair that has exactly these channels and attempts all of them.
 *
 * Readers this repository does not have: `yes` and `no` are the whole of what
 * stands where an ultrasonic modem or a ranging stack would be.
 */
function withChannels(P, list) {
  const signals = {};
  list.forEach((c) => { signals[c] = sig(c); });
  return { available: list.slice(), signals };
}

function fullReport(P) {
  return { available: P.CHANNELS.slice(), signals: { optical: sig('optical'), acoustic: sig('acoustic'), ranging: sig('ranging') } };
}

function onlyChannel(channel) {
  const signals = {};
  signals[channel] = sig(channel);
  return { available: [channel], signals };
}

const yes = () => true;
const no = () => false;

function request(over) {
  return merge({ artifactClass: CLASS, peerId: PEER, name: 'fleet.cred' }, over);
}

const FULL_GRANTS = [{ device: PEER, classes: [CLASS, 'agent'] }];

// --- The six policy shapes ---------------------------------------------------
//
// Both admitting shapes grant this peer this class, and that is not redundancy:
// `capabilityDecision` matches the PINNED PEER and nothing the presence report
// claimed, so a shape that named no grant would make every cell refuse on
// capability and the matrix would measure the grant table rather than the fusion
// rule. `no-grants` is here so the capability stage is visible too.

function policyShapes() {
  return [
    {
      id: 'requires',
      label: 'requires presence; grants this peer this class',
      policy: { requirePresence: true, requiredChannels: [], grants: FULL_GRANTS }
    },
    {
      id: 'permits',
      label: 'does NOT require presence; grants this peer this class',
      policy: { requirePresence: false, requiredChannels: [], grants: FULL_GRANTS }
    },
    {
      id: 'requires+optical',
      label: 'requires presence AND names optical as a required channel',
      policy: { requirePresence: true, requiredChannels: ['optical'], grants: FULL_GRANTS }
    },
    {
      id: 'requires,no-grant',
      label: 'requires presence; grants nothing to anyone',
      policy: { requirePresence: true, requiredChannels: [], grants: [] }
    },
    {
      id: 'undeclared',
      label: 'has not stated whether it requires presence',
      policy: { requiredChannels: [], grants: FULL_GRANTS }
    },
    {
      id: 'incoherent',
      label: 'names a required channel while saying presence is not required',
      policy: { requirePresence: false, requiredChannels: ['optical'], grants: FULL_GRANTS }
    }
  ];
}

// --- Driving one channel to one outcome --------------------------------------
//
// Seven recipes, each independent per channel: the spent list is keyed by
// channel and so is the reader map, so any combination of the three channels'
// outcomes is constructible and the whole 7×7×7 product below is reachable
// through the SHIPPED verifier rather than through hand-built records.

const OUTCOME_RECIPES = {
  passed: { how: 'a well-formed signal bound to this session and this channel’s challenge, and an injected stub reader returning true', reader: yes, signal: (c) => sig(c), spent: () => [] },
  absent: { how: 'nothing offered on this channel at all', reader: yes, signal: () => undefined, spent: () => [] },
  malformed: { how: 'a signal arrived with no challenge field, so it cannot be read as a signal', reader: yes, signal: (c) => sig(c, { challenge: undefined }), spent: () => [] },
  unbound: { how: 'a well-formed signal naming a different session id', reader: yes, signal: (c) => sig(c, { sessionId: 'sess-elsewhere' }), spent: () => [] },
  replayed: { how: 'a well-formed, correctly bound signal echoing a challenge already spent on this channel', reader: yes, signal: (c) => sig(c), spent: (c) => [CHALLENGE[c]] },
  unread: { how: 'a well-formed, correctly bound signal and NO reader for this channel — this platform, today, on all three', reader: null, signal: (c) => sig(c), spent: () => [] },
  forged: { how: 'a well-formed, correctly bound signal and an injected stub reader returning false', reader: no, signal: (c) => sig(c), spent: () => [] }
};

/**
 * Builds the (report, expected, opts) triple that drives each channel to the
 * outcome named for it. `wanted` is keyed by channel.
 */
function driveTo(P, wanted) {
  const signals = {};
  const spent = {};
  const readers = {};
  const available = [];
  P.CHANNELS.forEach((c) => {
    const recipe = OUTCOME_RECIPES[wanted[c]];
    const s = recipe.signal(c);
    if (s !== undefined) {
      signals[c] = s;
      available.push(c);
    }
    spent[c] = recipe.spent(c);
    if (recipe.reader) readers[c] = recipe.reader;
  });
  return {
    report: { available, signals },
    expected: expected({ spent }),
    opts: { readers }
  };
}

/**
 * What the module's own documented precedence says the fused state should be,
 * computed here independently so the 343-cell sweep has something to disagree
 * with. A mismatch is reported; it is not silently accepted.
 */
function predictState(P, wanted) {
  const outcomes = P.CHANNELS.map((c) => wanted[c]);
  for (const refusing of [P.OUTCOME_REPLAYED, P.OUTCOME_FORGED, P.OUTCOME_UNBOUND, P.OUTCOME_MALFORMED]) {
    if (outcomes.indexOf(refusing) >= 0) {
      return { replayed: P.STATE_REPLAYED, forged: P.STATE_FORGED, unbound: P.STATE_UNBOUND, malformed: P.STATE_MALFORMED }[refusing];
    }
  }
  const passing = outcomes.filter((o) => o === P.OUTCOME_PASSED).length;
  if (passing >= 2) return P.STATE_CORROBORATED;
  // `unread` was attempted; `absent` was not. That distinction is the whole
  // difference between the absent state and the uncorroborated one here.
  const attempted = outcomes.filter((o) => o !== P.OUTCOME_ABSENT).length;
  if (!attempted) return P.STATE_ABSENT;
  return P.STATE_UNCORROBORATED;
}

function attempt(fn) {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: String(err && err.message ? err.message : err) };
  }
}

/** refused | admitted | threw. Three outcomes, because a throw is not a refusal. */
function outcomeOf(res) {
  if (res.threw) return 'threw';
  return res.value && res.value.admit === true ? 'admitted' : 'refused';
}

// --- Timing ------------------------------------------------------------------

// A sink, so V8 cannot delete a call whose result nothing reads.
let SINK = 0;

/**
 * Median microseconds per call, over `reps` batches of `batch` calls. Batched
 * for the same reason the attestation suite batches: these functions run in the
 * low single-digit microseconds and reading `hrtime.bigint()` costs tens of
 * nanoseconds, so timing one call at a time would fold timer overhead into
 * every figure. The quoted number is a per-call mean within a batch and a
 * median across batches.
 */
function timePerCall(fn, { batch, reps }) {
  for (let i = 0; i < batch; i++) SINK += fn() ? 1 : 0;
  const us = [];
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) SINK += fn() ? 1 : 0;
    const t1 = process.hrtime.bigint();
    us.push(Number(t1 - t0) / 1000 / batch);
  }
  return summarize(us);
}

// --- Malformed inputs --------------------------------------------------------

/**
 * Reports and signals a hostile or broken device could send. Every case names a
 * ceiling or a type the module states, so this is `presence.js`'s own threat
 * surface rather than a general fuzz: `LIMITS` bounds six things a remote device
 * controls and each is over-run here.
 *
 * `parseReport` and `parseSignal` are documented never to throw, so the first
 * thing measured is whether that holds; the second is whether the verdict they
 * produce is then refused by the gate under BOTH an asking and a not-asking
 * policy. The second is the one that matters: a malformed report refused under a
 * requiring policy and admitted under a permitting one would be a downgrade
 * attack rather than a strictness setting.
 */
function malformedReportCases(P) {
  const long = (n) => 'x'.repeat(n);
  return [
    { name: 'a string, not a report', what: 'typeof report is string', input: 'presence-trust-me' },
    { name: 'an array', what: 'Array.isArray(report)', input: [1, 2, 3] },
    { name: 'a number', what: 'typeof report is number', input: 42 },
    { name: 'a function', what: 'a callable where an object belongs', input: function () {} },
    { name: 'an empty object', what: 'no available, no signals', input: {} },
    { name: 'available as a string', what: "available: 'optical' rather than ['optical']", input: { available: 'optical', signals: {} } },
    { name: 'available as an object', what: 'available: { optical: true }', input: { available: { optical: true }, signals: {} } },
    { name: 'available names a channel nobody defined', what: "available: ['optical', 'lidar']", input: { available: ['optical', 'lidar'], signals: {} } },
    { name: 'available over the ceiling', what: `${P.LIMITS.declaredChannels + 1} declared against a ${P.LIMITS.declaredChannels} ceiling`, input: { available: new Array(P.LIMITS.declaredChannels + 1).fill('optical'), signals: {} } },
    { name: 'signals as an array', what: 'signals: [] — a shape the format never has', input: { available: [], signals: [] } },
    { name: 'signals keyed by an invented channel', what: "signals: { lidar: {...} }", input: { available: [], signals: { lidar: { channel: 'lidar' } } } },
    { name: 'signals over the ceiling', what: `${P.LIMITS.declaredChannels + 1} keys against a ${P.LIMITS.declaredChannels} ceiling`, input: { available: [], signals: (() => { const s = {}; for (let i = 0; i < P.LIMITS.declaredChannels + 1; i++) s['ch' + i] = {}; return s; })() } },
    { name: 'a signal that is null', what: 'signals.optical: null', input: { available: ['optical'], signals: { optical: null } } },
    { name: 'a signal that is a string', what: "signals.optical: 'beep'", input: { available: ['optical'], signals: { optical: 'beep' } } },
    { name: 'a signal that is an array', what: 'signals.optical: []', input: { available: ['optical'], signals: { optical: [] } } },
    { name: 'a signal naming no channel', what: 'channel absent', input: { available: ['optical'], signals: { optical: sig('optical', { channel: undefined }) } } },
    { name: 'a signal naming an invented channel', what: "channel: 'lidar'", input: { available: ['optical'], signals: { optical: sig('optical', { channel: 'lidar' }) } } },
    { name: 'a recording moved between channels', what: 'an acoustic signal presented on the optical channel', input: { available: ['optical'], signals: { optical: { channel: 'acoustic', sessionId: SESSION, challenge: CHALLENGE.acoustic } } } },
    { name: 'a recording relabelled to the channel it arrived on', what: "channel: 'optical' carrying the ACOUSTIC challenge", input: { available: ['optical'], signals: { optical: { channel: 'optical', sessionId: SESSION, challenge: CHALLENGE.acoustic } } } },
    { name: 'a signal with no session id', what: "sessionId: ''", input: { available: ['optical'], signals: { optical: sig('optical', { sessionId: '' }) } } },
    { name: 'a session id over the ceiling', what: `${P.LIMITS.sessionId + 1} chars against a ${P.LIMITS.sessionId} ceiling`, input: { available: ['optical'], signals: { optical: sig('optical', { sessionId: long(P.LIMITS.sessionId + 1) }) } } },
    { name: 'a session id carrying a path', what: "sessionId: '../../etc/passwd'", input: { available: ['optical'], signals: { optical: sig('optical', { sessionId: '../../etc/passwd' }) } } },
    { name: 'a session id that is a number', what: 'a type that has no length to bound', input: { available: ['optical'], signals: { optical: sig('optical', { sessionId: 12345 }) } } },
    { name: 'a signal with no challenge', what: 'challenge: null', input: { available: ['optical'], signals: { optical: sig('optical', { challenge: null }) } } },
    { name: 'a challenge over the ceiling', what: `${P.LIMITS.challenge + 1} chars against a ${P.LIMITS.challenge} ceiling`, input: { available: ['optical'], signals: { optical: sig('optical', { challenge: long(P.LIMITS.challenge + 1) }) } } },
    { name: 'a challenge that is an object', what: 'challenge: {}', input: { available: ['optical'], signals: { optical: sig('optical', { challenge: {} }) } } },
    { name: 'every channel malformed at once', what: 'three unreadable signals', input: { available: P.CHANNELS.slice(), signals: { optical: 'a', acoustic: 'b', ranging: 'c' } } }
  ];
}

/**
 * Verdict objects the shipped verifier would never produce.
 *
 * This is the one group that fabricates a verdict and it has to: the question is
 * what the gate does when handed a state it does not know, and a state the
 * verifier can produce is by definition one it knows. The load-bearing ones are
 * the three `corroborated` fabrications — a bare state string, a pair list over
 * channels that did not pass, and a self-pair — because those are exactly what a
 * caller who read the state field and built the rest would produce.
 */
function fabricatedVerdictCases(P) {
  return [
    { name: 'a state from a future build', what: "state: 'corroborated-v2'", verdict: { state: 'corroborated-v2' } },
    { name: 'a state differing only in case', what: "state: 'CORROBORATED'", verdict: { state: 'CORROBORATED' } },
    { name: 'a state with a trailing space', what: "state: 'corroborated '", verdict: { state: 'corroborated ' } },
    { name: 'an outcome name used as a state', what: "state: 'passed' — a per-channel outcome, not a fused state", verdict: { state: 'passed' } },
    { name: 'an empty state', what: "state: ''", verdict: { state: '' } },
    { name: 'a numeric state', what: 'state: 1', verdict: { state: 1 } },
    { name: 'an object state', what: 'state: {}', verdict: { state: {} } },
    { name: 'an array state', what: "state: ['corroborated']", verdict: { state: ['corroborated'] } },
    { name: 'no verdict at all', what: 'verdict: null', verdict: null },
    { name: 'an empty verdict', what: 'verdict: {} — no state field', verdict: {} },
    { name: 'a verdict that is a string', what: "verdict: 'corroborated'", verdict: 'corroborated' },
    { name: 'a verdict that is an array', what: 'verdict: []', verdict: [] },
    {
      name: 'corroborated, with nothing behind it',
      what: "state: 'corroborated' and no pairs — what a caller who copied the state field would build",
      verdict: { state: 'corroborated' }
    },
    {
      name: 'corroborated, with a pair over channels that did not pass',
      what: 'an invented pair list beside channel records that all say passed: false',
      verdict: {
        state: 'corroborated',
        pairs: [['optical', 'acoustic']],
        channels: [{ channel: 'optical', passed: false }, { channel: 'acoustic', passed: false }, { channel: 'ranging', passed: false }]
      }
    },
    {
      name: 'corroborated, with one channel corroborating itself',
      what: "pairs: [['optical', 'optical']] beside a genuinely passing optical record — the one-channel attack in its most direct form",
      verdict: {
        state: 'corroborated',
        pairs: [['optical', 'optical']],
        channels: [{ channel: 'optical', passed: true }, { channel: 'acoustic', passed: false }, { channel: 'ranging', passed: false }]
      }
    },
    {
      name: 'corroborated, with a three-member pair',
      what: "pairs: [['optical', 'optical', 'acoustic']] — a pair that is not a pair",
      verdict: {
        state: 'corroborated',
        pairs: [['optical', 'optical', 'acoustic']],
        channels: [{ channel: 'optical', passed: true }, { channel: 'acoustic', passed: false }, { channel: 'ranging', passed: false }]
      }
    },
    {
      name: 'corroborated, with a pair naming invented channels',
      what: "pairs: [['lidar', 'thermal']] beside records claiming they passed",
      verdict: {
        state: 'corroborated',
        pairs: [['lidar', 'thermal']],
        channels: [{ channel: 'lidar', passed: true }, { channel: 'thermal', passed: true }]
      }
    },
    {
      name: 'corroborated, with channels that is not an array',
      what: "channels: 'all three passed'",
      verdict: { state: 'corroborated', pairs: [['optical', 'acoustic']], channels: 'all three passed' }
    },
    {
      name: 'uncorroborated, dressed with a pair list',
      what: 'the honest one-channel state, with a pair list bolted on',
      verdict: {
        state: 'uncorroborated',
        pairs: [['optical', 'acoustic']],
        channels: [{ channel: 'optical', passed: true }, { channel: 'acoustic', passed: true }, { channel: 'ranging', passed: false }]
      }
    }
  ];
}

// --- The suite ---------------------------------------------------------------

export function runPresenceSuite({ batch = 2000, reps = 25 } = {}) {
  const shipped = loadPresence();
  if (!shipped) return { available: false, reason: 'artifacts/presence.js not present' };
  const P = shipped.module;

  // The module's own account of what it has never done, read out of the running
  // module rather than restated, so this suite cannot claim a channel the code
  // does not.
  const channels = P.describeChannels();
  const relay = P.describeRelayRequirement();
  const acceptance = P.describeAcceptance();
  const limits = P.describeLimits();
  const availability = P.channelAvailability(globalThis);

  // --- 0. The shipped test file, run against the shipped module --------------
  //
  // The fixtures below are copied from `presence.test.js` and a copy can drift.
  // Running the test file here is what stops that being discovered by a reader
  // instead of by the harness.
  const tests = loadPresenceTests();
  let testSuite = { available: false, reason: 'artifacts/presence.test.js not present' };
  if (tests) {
    const run = attempt(() => tests.module.runAll(P));
    if (run.threw) {
      testSuite = { available: false, reason: run.error };
    } else {
      const summary = tests.module.summarize(run.value);
      testSuite = {
        available: true,
        path: tests.path,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        failures: run.value.filter((r) => !r.ok).map((r) => r.name)
      };
    }
  }

  // --- Fixture self-check ----------------------------------------------------
  //
  // Before any table is built on these fixtures: do they reach the states they
  // are built to reach? A wrong per-channel challenge would leave every row
  // `unbound` and the whole matrix would report perfectly well-formed refusals.
  const fixtureCheck = (() => {
    const corroborated = P.verifyPresence(withChannels(P, ['optical', 'acoustic']), expected(), { readers: { optical: yes, acoustic: yes, ranging: yes } });
    const single = P.verifyPresence(onlyChannel('optical'), expected(), { readers: { optical: yes } });
    const asShipped = P.verifyPresence(fullReport(P), expected(), undefined);
    const admitted = P.admitActivation({ requirePresence: true, requiredChannels: [], grants: FULL_GRANTS }, corroborated, request());
    return {
      corroboratedState: corroborated.state,
      corroboratedReached: corroborated.state === P.STATE_CORROBORATED,
      corroboratedPairs: corroborated.pairs.length,
      singleState: single.state,
      singlePassed: single.channels.filter((c) => c.passed).length,
      // The whole point: with no reader anywhere — which is this repository —
      // a perfect report on all three channels passes nothing.
      asShippedState: asShipped.state,
      asShippedPasses: asShipped.channels.filter((c) => c.passed).length,
      asShippedOutcomes: asShipped.channels.map((c) => c.outcome),
      controlAdmitted: admitted.admit === true,
      controlCode: admitted.code
    };
  })();

  // --- 1. The decision matrix, one channel at a time -------------------------
  //
  // Each of the three channels driven to each of the seven outcomes with the
  // other two ABSENT, so the row measures that channel in that outcome and not
  // a mixture. Crossed against all six policy shapes.

  const SHAPES = policyShapes();

  const isolation = [];
  for (const channel of P.CHANNELS) {
    for (const outcome of P.OUTCOMES) {
      const wanted = {};
      P.CHANNELS.forEach((c) => { wanted[c] = c === channel ? outcome : P.OUTCOME_ABSENT; });
      const drive = driveTo(P, wanted);
      const v = attempt(() => P.verifyPresence(drive.report, drive.expected, drive.opts));
      const record = v.threw ? null : v.value.channels.find((c) => c.channel === channel);
      const cells = SHAPES.map((shape) => {
        const d = attempt(() => P.admitActivation(shape.policy, v.threw ? null : v.value, request()));
        return {
          policy: shape.id,
          outcome: outcomeOf(d),
          admit: !d.threw && d.value.admit === true,
          code: d.threw ? null : d.value.code
        };
      });
      isolation.push({
        channel,
        outcome,
        how: OUTCOME_RECIPES[outcome].how,
        threw: v.threw,
        // Did the recipe actually reach the outcome it names? A recipe that
        // silently produced something else would make its whole row a
        // measurement of something else.
        reachedIntendedOutcome: !v.threw && !!record && record.outcome === outcome,
        actualOutcome: record ? record.outcome : null,
        fusedState: v.threw ? null : v.value.state,
        pairs: v.threw ? 0 : v.value.pairs.length,
        passed: v.threw ? 0 : v.value.channels.filter((c) => c.passed).length,
        cells
      });
    }
  }

  // --- The exhaustive product ------------------------------------------------
  //
  // All 7×7×7 combinations of per-channel outcomes, every one driven through the
  // shipped `verifyPresence` and then through the gate under every policy shape.
  // 343 verdicts, 2,058 decisions.

  const sweep = {
    total: 0,
    byState: {},
    mismatches: [],
    threw: 0,
    admissions: 0,
    // The defect condition, evaluated rather than eyeballed.
    singlePassCorroborated: [],
    singlePassAdmittedOnPresence: [],
    zeroPassCorroborated: [],
    pairsOnRefusingState: []
  };
  const perShapeAdmissions = {};
  SHAPES.forEach((s) => { perShapeAdmissions[s.id] = { admitted: 0, byCode: {} }; });

  for (const a of P.OUTCOMES) {
    for (const b of P.OUTCOMES) {
      for (const c of P.OUTCOMES) {
        const wanted = { optical: a, acoustic: b, ranging: c };
        const drive = driveTo(P, wanted);
        const v = attempt(() => P.verifyPresence(drive.report, drive.expected, drive.opts));
        sweep.total++;
        if (v.threw) {
          sweep.threw++;
          continue;
        }
        const verdict = v.value;
        sweep.byState[verdict.state] = (sweep.byState[verdict.state] || 0) + 1;
        const predicted = predictState(P, wanted);
        if (verdict.state !== predicted) {
          sweep.mismatches.push({ outcomes: [a, b, c], got: verdict.state, predicted });
        }
        const passing = verdict.channels.filter((r) => r.passed).length;
        if (passing < 2 && verdict.state === P.STATE_CORROBORATED) {
          sweep.singlePassCorroborated.push({ outcomes: [a, b, c], passing });
        }
        if (passing === 0 && verdict.pairs.length) {
          sweep.zeroPassCorroborated.push({ outcomes: [a, b, c] });
        }
        if (verdict.state !== P.STATE_CORROBORATED && verdict.pairs.length) {
          sweep.pairsOnRefusingState.push({ outcomes: [a, b, c], state: verdict.state, pairs: verdict.pairs.length });
        }
        for (const shape of SHAPES) {
          const d = attempt(() => P.admitActivation(shape.policy, verdict, request()));
          if (d.threw) { sweep.threw++; continue; }
          if (d.value.admit !== true) continue;
          sweep.admissions++;
          perShapeAdmissions[shape.id].admitted++;
          const code = d.value.code;
          perShapeAdmissions[shape.id].byCode[code] = (perShapeAdmissions[shape.id].byCode[code] || 0) + 1;
          if (passing <= 1 && code === P.CODE_CORROBORATED_AND_APPROVED) {
            sweep.singlePassAdmittedOnPresence.push({ outcomes: [a, b, c], policy: shape.id, passing, code });
          }
        }
      }
    }
  }
  sweep.decisions = sweep.total * SHAPES.length;
  sweep.perShape = perShapeAdmissions;

  // --- 2. The pair relation is not a count -----------------------------------

  // 2a. What `normalizePolicy` keeps, field by field. Every invented knob is
  // offered individually so the report can name which ones were dropped rather
  // than reporting that "extra fields" were.
  const inventedFields = [
    { field: 'minChannels', value: 1 },
    { field: 'minChannels', value: 0 },
    { field: 'threshold', value: 1 },
    { field: 'quorum', value: 1 },
    { field: 'minCorroboratingPairs', value: 0 },
    { field: 'maxChannels', value: 1 },
    { field: 'requiredPairs', value: 0 },
    { field: 'corroborationCount', value: 1 },
    { field: 'channelsRequired', value: 1 },
    { field: 'pairs', value: [['optical', 'optical']] },
    { field: 'CORROBORATING_PAIRS', value: [['optical', 'optical']] },
    { field: 'allowSingleChannel', value: true },
    { field: 'requireCorroboration', value: false }
  ];
  const baseKeys = Object.keys(P.normalizePolicy({ requirePresence: true })).sort();
  const droppedRows = inventedFields.map((f) => {
    const offered = { requirePresence: true, requiredChannels: [], grants: FULL_GRANTS };
    offered[f.field] = f.value;
    const normalized = P.normalizePolicy(offered);
    const keys = Object.keys(normalized).sort();
    return {
      field: f.field,
      value: JSON.stringify(f.value),
      survived: keys.indexOf(f.field) >= 0,
      keysAfter: keys.join(','),
      keysUnchanged: keys.join(',') === baseKeys.join(',')
    };
  });
  const normalizedShape = {
    keys: baseKeys,
    numericFields: baseKeys.filter((k) => typeof P.normalizePolicy({ requirePresence: true })[k] === 'number'),
    knobNamedFields: baseKeys.filter((k) => /min|max|threshold|quorum|count|pairs/i.test(k)),
    droppedRows,
    allDropped: droppedRows.every((r) => !r.survived && r.keysUnchanged)
  };

  // 2b. The exhaustive policy-input search. 440 policy inputs × 4 verdicts.
  // The question is whether ANY of them authorizes on one channel.
  const REQUIRE_VALUES = [true, false, undefined, 'yes', 1];
  const REQUIRED_SETS = [[], ['optical'], ['optical', 'acoustic'], ['optical', 'acoustic', 'ranging']];
  const GRANT_SETS = [FULL_GRANTS, []];
  const INVENTED_SHAPES = [
    {},
    { minChannels: 1 },
    { threshold: 1 },
    { quorum: 1 },
    { minCorroboratingPairs: 0 },
    { minChannels: 0, threshold: 0 },
    { requiredPairs: 0 },
    { allowSingleChannel: true },
    { pairs: [['optical', 'optical']] },
    { CORROBORATING_PAIRS: [['optical', 'optical']] },
    { minChannels: 1, threshold: 1, quorum: 1, minCorroboratingPairs: 0, allowSingleChannel: true }
  ];

  const singleVerdicts = P.CHANNELS.map((c) => ({
    label: c + ' alone, perfect',
    verdict: P.verifyPresence(onlyChannel(c), expected(), { readers: { [c]: yes } })
  }));
  const absentVerdict = P.verifyPresence(null, expected(), { readers: { optical: yes, acoustic: yes, ranging: yes } });
  const REQUESTS = [
    { label: 'granted peer, granted class', request: request() },
    { label: 'no peer id', request: request({ peerId: null }) },
    { label: 'a class this peer is not granted', request: request({ artifactClass: 'model' }) },
    { label: 'no artifact class', request: request({ artifactClass: null }) }
  ];

  const threshold = {
    requireValues: REQUIRE_VALUES.length,
    requiredSets: REQUIRED_SETS.length,
    grantSets: GRANT_SETS.length,
    inventedShapes: INVENTED_SHAPES.length,
    policyInputs: 0,
    decisions: 0,
    admissions: 0,
    presenceCodedAdmissions: 0,
    fromOneChannel: [],
    // The counterfactual: does adding one perfect channel ever change `admit`
    // from what the EMPTY report gets under the identical policy and request?
    comparisons: 0,
    flips: [],
    baselineAdmissions: 0
  };
  for (const rp of REQUIRE_VALUES) {
    for (const rc of REQUIRED_SETS) {
      for (const gr of GRANT_SETS) {
        for (const inv of INVENTED_SHAPES) {
          const pol = merge({ requirePresence: rp, requiredChannels: rc, grants: gr }, inv);
          threshold.policyInputs++;
          for (const req of REQUESTS) {
            const base = attempt(() => P.admitActivation(pol, absentVerdict, req.request));
            const baseAdmit = !base.threw && base.value.admit === true;
            if (baseAdmit) threshold.baselineAdmissions++;
            for (const sv of singleVerdicts) {
              const d = attempt(() => P.admitActivation(pol, sv.verdict, req.request));
              threshold.decisions++;
              threshold.comparisons++;
              const admit = !d.threw && d.value.admit === true;
              if (admit) {
                threshold.admissions++;
                if (d.value.code === P.CODE_CORROBORATED_AND_APPROVED) {
                  threshold.presenceCodedAdmissions++;
                  threshold.fromOneChannel.push({ verdict: sv.label, requirePresence: String(rp), invented: JSON.stringify(inv), code: d.value.code });
                }
              }
              if (admit !== baseAdmit) {
                threshold.flips.push({
                  verdict: sv.label, requirePresence: String(rp), requiredChannels: rc.join('+') || 'none',
                  invented: JSON.stringify(inv), request: req.label,
                  baseAdmit, admit, code: d.threw ? null : d.value.code
                });
              }
            }
          }
        }
      }
    }
  }

  // 2c. `passingPairs` over the whole outcome product, read off the shipped
  // function rather than reasoned about: is a pair produced exactly when two
  // DISTINCT channels passed?
  const pairRelation = { combos: 0, disagreements: [], selfPairs: 0 };
  for (const a of P.OUTCOMES) {
    for (const b of P.OUTCOMES) {
      for (const c of P.OUTCOMES) {
        const records = [a, b, c].map((outcome, i) => ({ channel: P.CHANNELS[i], outcome, passed: outcome === P.OUTCOME_PASSED }));
        const passing = records.filter((r) => r.passed).length;
        const pairs = P.passingPairs(records);
        pairRelation.combos++;
        if ((pairs.length > 0) !== (passing >= 2)) {
          pairRelation.disagreements.push({ outcomes: [a, b, c], passing, pairs: pairs.length });
        }
        pairs.forEach((pair) => { if (pair[0] === pair[1]) pairRelation.selfPairs++; });
      }
    }
  }
  pairRelation.declaredPairs = P.CORROBORATING_PAIRS.map((p) => p.slice());
  pairRelation.declaredSelfPairs = P.CORROBORATING_PAIRS.filter((p) => p[0] === p[1]).length;

  // 2d. The pair list is EXPORTED BY REFERENCE and is not frozen, so a page
  // script sharing the module can push a self-pair into the fusion rule itself.
  // That is not hypothetical and it is measured here — mutated, exercised, and
  // restored, with the restoration verified. It is the strongest available form
  // of the question "can one channel authorize": corrupt the rule and ask again.
  const mutatedRule = (() => {
    const frozen = Object.isFrozen(P.CORROBORATING_PAIRS);
    const saved = P.CORROBORATING_PAIRS.map((p) => p.slice());
    P.CORROBORATING_PAIRS.push(['optical', 'optical']);
    const v = attempt(() => P.verifyPresence(onlyChannel('optical'), expected(), { readers: { optical: yes } }));
    const d = v.threw ? { threw: true } : attempt(() => P.admitActivation(SHAPES[0].policy, v.value, request()));
    // Restore before anything else runs.
    P.CORROBORATING_PAIRS.length = 0;
    saved.forEach((p) => P.CORROBORATING_PAIRS.push(p));
    const restored = JSON.stringify(P.CORROBORATING_PAIRS) === JSON.stringify(saved);
    return {
      frozen,
      restored,
      pairsBefore: saved.length,
      // What the corrupted rule let the VERIFIER conclude.
      verifierState: v.threw ? null : v.value.state,
      verifierPairs: v.threw ? 0 : v.value.pairs.length,
      // And what the GATE did with it, which is the answer that matters.
      admitted: !d.threw && d.value && d.value.admit === true,
      code: d.threw ? null : (d.value ? d.value.code : null),
      unmet: d.threw || !d.value ? [] : (d.value.unmet || []).map((u) => u.rule)
    };
  })();

  // --- 3. Fail-closed coverage ----------------------------------------------

  const strictPolicy = SHAPES[0].policy;
  const laxPolicy = SHAPES[1].policy;

  const reportRows = malformedReportCases(P).map((c) => {
    const parsed = attempt(() => P.parseReport(c.input));
    const v = attempt(() => P.verifyPresence(c.input, expected(), { readers: { optical: yes, acoustic: yes, ranging: yes } }));
    const strict = v.threw ? { threw: true } : attempt(() => P.admitActivation(strictPolicy, v.value, request()));
    const lax = v.threw ? { threw: true } : attempt(() => P.admitActivation(laxPolicy, v.value, request()));
    return {
      group: 'malformed report',
      name: c.name,
      what: c.what,
      parseThrew: parsed.threw,
      parseOk: !parsed.threw && parsed.value.ok === true,
      verifyThrew: v.threw,
      state: v.threw ? null : v.value.state,
      strictOutcome: outcomeOf(strict),
      laxOutcome: outcomeOf(lax),
      strictCode: strict.threw ? null : strict.value.code,
      laxCode: lax.threw ? null : lax.value.code
    };
  });

  const verdictRows = fabricatedVerdictCases(P).map((c) => {
    const strict = attempt(() => P.admitActivation(strictPolicy, c.verdict, request()));
    const lax = attempt(() => P.admitActivation(laxPolicy, c.verdict, request()));
    return {
      group: 'fabricated verdict',
      name: c.name,
      what: c.what,
      state: c.verdict && typeof c.verdict === 'object' && c.verdict.state !== undefined ? JSON.stringify(c.verdict.state) : 'absent',
      strictOutcome: outcomeOf(strict),
      laxOutcome: outcomeOf(lax),
      strictCode: strict.threw ? null : strict.value.code,
      laxCode: lax.threw ? null : lax.value.code
    };
  });

  // The verdicts the real verifier produced, so this group measures the policy
  // rather than a fault in the report.
  const corroboratedVerdict = P.verifyPresence(withChannels(P, ['optical', 'acoustic']), expected(), { readers: { optical: yes, acoustic: yes } });
  const policyRows = [
    { name: 'policy declares nothing', what: 'policy: {}', policy: {}, verdict: corroboratedVerdict, request: request() },
    { name: 'no policy at all', what: 'policy: null', policy: null, verdict: corroboratedVerdict, request: request() },
    { name: 'policy is a string', what: "policy: 'require'", policy: 'require', verdict: corroboratedVerdict, request: request() },
    { name: 'policy is an array', what: 'policy: []', policy: [], verdict: corroboratedVerdict, request: request() },
    { name: "requirePresence: 'yes'", what: 'truthy, but not the boolean the module requires', policy: { requirePresence: 'yes', grants: FULL_GRANTS }, verdict: corroboratedVerdict, request: request() },
    { name: 'requirePresence: 1', what: 'truthy, but not a declaration', policy: { requirePresence: 1, grants: FULL_GRANTS }, verdict: corroboratedVerdict, request: request() },
    { name: 'requirePresence: undefined', what: 'the field is present in name only', policy: { requirePresence: undefined, grants: FULL_GRANTS }, verdict: corroboratedVerdict, request: request() },
    { name: 'requires a channel while not requiring presence', what: 'two answers to the same question', policy: { requirePresence: false, requiredChannels: ['optical'], grants: FULL_GRANTS }, verdict: corroboratedVerdict, request: request() },
    { name: 'everything declared but no grants', what: 'requirePresence: true and an empty grant table', policy: { requirePresence: true, requiredChannels: [], grants: [] }, verdict: corroboratedVerdict, request: request() },
    { name: 'grants is not an array', what: "grants: 'all'", policy: { requirePresence: true, grants: 'all' }, verdict: corroboratedVerdict, request: request() },
    { name: 'a grant naming no device', what: 'grants: [{ classes: [credential] }]', policy: { requirePresence: true, grants: [{ classes: [CLASS] }] }, verdict: corroboratedVerdict, request: request() },
    { name: 'a grant for an unknown class', what: "grants: [{ device, classes: ['root'] }]", policy: { requirePresence: true, grants: [{ device: PEER, classes: ['root'] }] }, verdict: corroboratedVerdict, request: request() },
    { name: 'grants over the ceiling', what: `${P.LIMITS.grants + 1} grants, the useful one last and past the cut`, policy: { requirePresence: true, grants: new Array(P.LIMITS.grants).fill({ device: 'filler-device', classes: ['model'] }).concat([{ device: PEER, classes: [CLASS] }]) }, verdict: corroboratedVerdict, request: request() },
    { name: 'requiredChannels names an invented channel', what: "requiredChannels: ['lidar']", policy: { requirePresence: true, requiredChannels: ['lidar'], grants: FULL_GRANTS }, verdict: corroboratedVerdict, request: request() },
    { name: 'no request at all', what: 'request: null', policy: strictPolicy, verdict: corroboratedVerdict, request: null },
    { name: 'request names no class', what: 'artifactClass absent', policy: strictPolicy, verdict: corroboratedVerdict, request: request({ artifactClass: undefined }) },
    { name: 'request names an unknown class', what: "artifactClass: 'root'", policy: strictPolicy, verdict: corroboratedVerdict, request: request({ artifactClass: 'root' }) },
    { name: 'request names no peer', what: 'peerId absent — presence establishes no identity, so there is nothing else to match', policy: strictPolicy, verdict: corroboratedVerdict, request: request({ peerId: undefined }) },
    { name: 'peerId is not an identifier', what: "peerId: '../../etc' — the shape a path would have", policy: strictPolicy, verdict: corroboratedVerdict, request: request({ peerId: '../../etc' }) }
  ].map((c) => {
    const d = attempt(() => P.admitActivation(c.policy, c.verdict, c.request));
    return {
      group: 'policy or request shape',
      name: c.name,
      what: c.what,
      state: c.verdict.state,
      strictOutcome: outcomeOf(d),
      laxOutcome: outcomeOf(d),
      strictCode: d.threw ? null : d.value.code,
      laxCode: d.threw ? null : d.value.code
    };
  });

  const failClosed = [...reportRows, ...verdictRows, ...policyRows];
  const refusedBoth = failClosed.filter((r) => r.strictOutcome === 'refused' && r.laxOutcome === 'refused');
  const anyThrew = failClosed.filter((r) => r.strictOutcome === 'threw' || r.laxOutcome === 'threw' || r.parseThrew || r.verifyThrew);
  const anyAdmitted = failClosed.filter((r) => r.strictOutcome === 'admitted' || r.laxOutcome === 'admitted');

  const coverage = {
    total: failClosed.length,
    refusedUnderBoth: refusedBoth.length,
    fraction: failClosed.length ? refusedBoth.length / failClosed.length : 0,
    threw: anyThrew.length,
    admitted: anyAdmitted.length,
    admittedNames: anyAdmitted.map((r) => ({ name: r.name, strict: r.strictCode, lax: r.laxCode })),
    threwNames: anyThrew.map((r) => r.name),
    // Documented never to throw. Measured, not trusted.
    parseNeverThrew: reportRows.every((r) => !r.parseThrew),
    parseRefused: reportRows.filter((r) => !r.parseOk).length,
    // `parseReport` reads the CONTAINER and `parseSignal` reads each signal, so
    // a report whose container is well-formed and whose signals are garbage
    // parses and is then refused per channel. That split is deliberate — one
    // broken signal must not erase the other two from the transcript — so the
    // accepted rows are separated by where they were caught rather than counted
    // as parser misses.
    parseAccepted: reportRows.filter((r) => r.parseOk).map((r) => ({ name: r.name, state: r.state })),
    parseAcceptedThenRefused: reportRows.filter((r) => r.parseOk && r.state !== P.STATE_ABSENT)
      .map((r) => ({ name: r.name, state: r.state })),
    parseAcceptedAsAbsent: reportRows.filter((r) => r.parseOk && r.state === P.STATE_ABSENT)
      .map((r) => ({ name: r.name, state: r.state })),
    // Every report the parser DID refuse must land on `malformed`, never on
    // `absent`: conflating unreadable evidence with absent evidence would let
    // any pair downgrade itself to the absent path by sending garbage.
    refusedParseReachesMalformed: reportRows.filter((r) => !r.parseOk).every((r) => r.state === P.STATE_MALFORMED),
    malformedStates: Array.from(new Set(reportRows.map((r) => r.state))),
    undeclaredRefused: policyRows.filter((r) => r.strictCode === P.CODE_POLICY_UNDECLARED).map((r) => r.name)
  };

  // The downgrade pair, isolated so it is read rather than inferred: under the
  // SAME permitting policy, `absent` must admit and `malformed` must not.
  const downgrade = (() => {
    const absent = attempt(() => P.admitActivation(laxPolicy, P.verifyPresence(null, expected(), {}), request()));
    const malformed = attempt(() => P.admitActivation(laxPolicy, P.verifyPresence('garbage', expected(), {}), request()));
    const uncorroborated = attempt(() => P.admitActivation(laxPolicy, P.verifyPresence(onlyChannel('optical'), expected(), { readers: { optical: yes } }), request()));
    return {
      absentAdmitted: !absent.threw && absent.value.admit === true,
      absentCode: absent.threw ? null : absent.value.code,
      malformedAdmitted: !malformed.threw && malformed.value.admit === true,
      malformedCode: malformed.threw ? null : malformed.value.code,
      uncorroboratedAdmitted: !uncorroborated.threw && uncorroborated.value.admit === true,
      uncorroboratedCode: uncorroborated.threw ? null : uncorroborated.value.code,
      kept: (!absent.threw && absent.value.admit === true) && !(!malformed.threw && malformed.value.admit === true)
    };
  })();

  // --- A stated channel requirement that is silently dropped ----------------
  //
  // `normalizePolicy` filters `requiredChannels` through `isChannel` and keeps
  // what survives. A name that is not one of the three is therefore DISCARDED
  // and the policy proceeds as though the sender had asked for nothing — which
  // is the same failure mode the `policy-incoherent` refusal exists to prevent
  // one step earlier. Measured here rather than reasoned about, against a
  // corroborated verdict that has optical and acoustic and no ranging.
  const requiredChannelDrop = (() => {
    const verdict = P.verifyPresence(withChannels(P, ['optical', 'acoustic']), expected(), { readers: { optical: yes, acoustic: yes } });
    const cases = [
      { asked: ['optical'], what: 'a channel this pair has' },
      { asked: ['ranging'], what: 'a channel this pair does not have' },
      { asked: ['lidar'], what: 'a channel nobody has ever defined' },
      { asked: ['ultrasonic'], what: "ADR-023's own word for the acoustic channel, which is not the module's id" },
      { asked: ['optical', 'lidar'], what: 'one real name and one invented one' },
      { asked: ['ranging', 'lidar'], what: 'one unmet real name and one invented one' },
      { asked: ['Optical'], what: 'the right channel in the wrong case' },
      { asked: ['optical '], what: 'the right channel with a trailing space' },
      { asked: 'optical', what: 'a string where an array belongs' }
    ];
    return cases.map((c) => {
      const policy = { requirePresence: true, requiredChannels: c.asked, grants: FULL_GRANTS };
      const kept = P.normalizePolicy(policy).requiredChannels;
      const d = attempt(() => P.admitActivation(policy, verdict, request()));
      const askedList = Array.isArray(c.asked) ? c.asked : [c.asked];
      return {
        asked: askedList,
        what: c.what,
        kept,
        dropped: askedList.filter((n) => kept.indexOf(n) < 0),
        silentlyDropped: askedList.some((n) => kept.indexOf(n) < 0),
        admitted: !d.threw && d.value.admit === true,
        code: d.threw ? null : d.value.code
      };
    });
  })();
  const silentDrops = requiredChannelDrop.filter((r) => r.silentlyDropped && r.admitted);

  // Junk in every argument position. Not the test file's 18³ — a wider set of
  // shapes over the four public entry points, asking only whether anything
  // throws or admits.
  const JUNK = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'a', 'corroborated', {}, [], [1, 2], true, false,
    { state: 'corroborated' }, { state: 'corroborated', pairs: [['optical', 'optical']], channels: 'x' },
    { available: 'optical' }, { requirePresence: 'yes' }, function () {}];
  const junkSweep = { shapes: JUNK.length, triples: 0, threw: 0, admitted: 0, corroborated: 0, throwSites: [] };
  for (const p of JUNK) {
    for (const v of JUNK) {
      for (const r of JUNK) {
        junkSweep.triples++;
        const d = attempt(() => P.admitActivation(p, v, r));
        if (d.threw) { junkSweep.threw++; junkSweep.throwSites.push('admitActivation'); }
        else if (d.value.admit === true) junkSweep.admitted++;
        const w = attempt(() => P.verifyPresence(p, v, r));
        if (w.threw) { junkSweep.threw++; junkSweep.throwSites.push('verifyPresence'); }
        else if (w.value.state === P.STATE_CORROBORATED) junkSweep.corroborated++;
        const t = attempt(() => P.presenceTranscript(v));
        if (t.threw) { junkSweep.threw++; junkSweep.throwSites.push('presenceTranscript'); }
        const rc = attempt(() => P.presenceReceipt(v, d.threw ? null : d.value, p));
        if (rc.threw) { junkSweep.threw++; junkSweep.throwSites.push('presenceReceipt'); }
      }
    }
  }
  junkSweep.calls = junkSweep.triples * 4;
  junkSweep.throwSites = Array.from(new Set(junkSweep.throwSites));

  // --- The receipt: two admissions that must never read the same -------------
  const receipts = (() => {
    const corroborated = P.verifyPresence(withChannels(P, ['optical', 'ranging']), expected(), { readers: { optical: yes, ranging: yes } });
    const dCorr = P.admitActivation(strictPolicy, corroborated, request());
    const rCorr = P.presenceReceipt(corroborated, dCorr, strictPolicy);
    const nobody = P.verifyPresence(null, expected(), {});
    const dNobody = P.admitActivation(laxPolicy, nobody, request());
    const rNobody = P.presenceReceipt(nobody, dNobody, laxPolicy);
    return {
      corroborated: { presence: rCorr.presence, code: rCorr.decision, admitted: rCorr.admitted, requiredPresence: rCorr.senderRequiredPresence, reportPresented: rCorr.reportPresented, pairs: rCorr.corroboratedBy.length, summary: rCorr.summary },
      nobodyAsked: { presence: rNobody.presence, code: rNobody.decision, admitted: rNobody.admitted, requiredPresence: rNobody.senderRequiredPresence, reportPresented: rNobody.reportPresented, pairs: rNobody.corroboratedBy.length, summary: rNobody.summary },
      distinguished: rCorr.summary !== rNobody.summary && rCorr.decision !== rNobody.decision
    };
  })();

  // --- 4. Cost ---------------------------------------------------------------

  const costReport = withChannels(P, ['optical', 'acoustic']);
  const costExpected = expected();
  const costReaders = { readers: { optical: yes, acoustic: yes, ranging: yes } };
  const costVerdict = P.verifyPresence(costReport, costExpected, costReaders);
  const costDecision = P.admitActivation(strictPolicy, costVerdict, request());
  const costRequest = request();
  const shippedReport = fullReport(P);

  const cost = {
    batch,
    reps,
    verifyCorroborated: timePerCall(() => P.verifyPresence(costReport, costExpected, costReaders), { batch, reps }),
    // What this platform actually runs: three channels offered, no reader
    // anywhere, every one unread.
    verifyAsShipped: timePerCall(() => P.verifyPresence(shippedReport, costExpected, undefined), { batch, reps }),
    verifyAbsent: timePerCall(() => P.verifyPresence(null, costExpected, {}), { batch, reps }),
    parseReport: timePerCall(() => P.parseReport(costReport), { batch, reps }),
    admitActivation: timePerCall(() => P.admitActivation(strictPolicy, costVerdict, costRequest), { batch, reps }),
    presenceTranscript: timePerCall(() => P.presenceTranscript(costVerdict), { batch, reps }),
    presenceReceipt: timePerCall(() => P.presenceReceipt(costVerdict, costDecision, strictPolicy), { batch, reps })
  };

  // What one activation actually pays: verify once, gate once, transcript once,
  // receipt once.
  cost.perActivationUs = cost.verifyCorroborated.p50 + cost.admitActivation.p50 +
    cost.presenceTranscript.p50 + cost.presenceReceipt.p50;
  cost.transcriptAndReceiptUs = cost.presenceTranscript.p50 + cost.presenceReceipt.p50;
  cost.fusionDecisionUs = cost.verifyCorroborated.p50 + cost.admitActivation.p50;
  cost.shareOfOneSecond = cost.perActivationUs / 1e6;
  // Against the app's default frame period. 5 fps is a configured constant of
  // this application, not a measurement, and is labelled as such where it prints.
  cost.framePeriodMs = 1000 / 5;
  cost.shareOfFramePeriod = cost.perActivationUs / (cost.framePeriodMs * 1000);
  cost.decisionsPerFramePeriod = (cost.framePeriodMs * 1000) / cost.perActivationUs;

  return {
    available: true,
    path: shipped.path,
    exports: shipped.exports.length,
    channelNames: P.CHANNELS,
    states: P.STATES,
    outcomes: P.OUTCOMES,
    artifactClasses: P.ARTIFACT_CLASSES,
    moduleLimits: P.LIMITS,
    // The module's own honesty surface, carried so a printer cannot forget it.
    channels,
    relay,
    acceptance,
    limits,
    availability,
    reader: 'injected stub — no presence channel is implemented and nothing physical is exercised anywhere in this suite',
    testSuite,
    fixtureCheck,
    policyShapes: SHAPES.map((s) => ({ id: s.id, label: s.label })),
    isolation,
    sweep,
    normalizedShape,
    threshold,
    pairRelation,
    mutatedRule,
    failClosed,
    coverage,
    downgrade,
    requiredChannelDrop,
    silentDrops,
    junkSweep,
    receipts,
    cost
  };
}
