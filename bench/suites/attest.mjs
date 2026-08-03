/*!
 * Suite 14 — device attestation, artifacts/attest.js.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE MEASURES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It measures the VERDICT-AND-GATE LOGIC and nothing whatsoever about real
 * hardware attestation. ADR-021 §2.1 names four roots of trust — DICE, TPM 2.0,
 * Secure Enclave and Android hardware-backed keys — and `describeRoots()`
 * reports all four as `unexercised`. This suite runs none of them, because
 * nothing in this repository implements any of them. Wherever a chain verifier
 * is needed it is an INJECTED STUB that returns a fixed answer, and every table
 * built with one says so in the table itself rather than in a note underneath.
 *
 * A reader must not come away from these numbers believing rvQR attests
 * devices. It does not. What it has is a decision procedure over evidence it
 * cannot currently obtain, and that procedure is what is measured here.
 *
 * ---------------------------------------------------------------------------
 * WHY COVERAGE AND COST, RATHER THAN THROUGHPUT
 * ---------------------------------------------------------------------------
 *
 * Every other module in this harness moves bytes, so the interesting quantity
 * is a rate. `attest.js` moves nothing: it is a pure decision procedure over
 * plain data, and a bytes-per-second figure for it would be a category error.
 * The quantities that matter are whether it decides the right way in every
 * state it defines, whether anything can talk it into a wrong yes, and whether
 * it is cheap enough to run per transfer. So:
 *
 * 1. THE STATE MATRIX. Every attestation state the module defines — attested,
 *    unattested, malformed, unbound, replayed, unverified, forged — crossed
 *    against a policy that requires attestation and one that does not. The
 *    resulting decision code and admit flag for each of the fourteen cells is
 *    the result; the table IS the finding. Any cell where a non-attested state
 *    is admitted under a requiring policy is a defect, and this suite reports it
 *    as one rather than adjusting the fixture until the table looks tidy.
 *
 *    Two cells carry more weight than the other twelve. `unattested` under a
 *    permitting policy MUST admit — that is ADR-021 §2.3, unattested is a state
 *    and not a failure. `malformed` under the SAME permitting policy must NOT,
 *    because conflating unreadable evidence with absent evidence would let any
 *    device downgrade itself to the unattested path by sending garbage.
 *
 * 2. THE SEPARATION, QUANTIFIED. ADR-021 §2.2's load-bearing sentence is that
 *    attestation is evidence and never authorization. That is asserted in three
 *    docblocks and one ADR; here it is counted. Every state is crossed with
 *    every policy and three capability-grant shapes — a grant covering the
 *    request, a grant covering a different class, and no grant at all — and the
 *    admitting and refusing combinations are tallied. The claim under test is
 *    that no combination carrying a valid attestation and an absent grant is
 *    ever admitted.
 *
 *    The CONTROL is not optional and is reported in the same table: the
 *    identical attested verdict with the grant restored must admit. Without it
 *    the refusal could have been caused by anything — a typo in the fixture, a
 *    measurement the policy does not approve — and would prove nothing about
 *    the capability rule.
 *
 * 3. FAIL-CLOSED COVERAGE. Absent fields, wrong types, oversized fields, states
 *    that do not exist, verdict objects a caller fabricated, and a policy that
 *    has declared nothing. Reported as the fraction of malformed inputs that
 *    produce a REFUSAL rather than a throw or an admission — three outcomes,
 *    not two, because a security path that throws is as broken as one that
 *    admits, just louder.
 *
 * 4. COST. Median microseconds for `verifyAttestation`, `admitTransfer` and
 *    `attestationReceipt`, which is what a sender pays per transfer. Whether
 *    that is negligible is answered with the measured number against the frame
 *    period at the app's default rate, not asserted.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 *
 * The module is real and is driven end to end: `verifyAttestation`,
 * `admitTransfer` and `attestationReceipt` are the shipped functions, and every
 * verdict in the state matrix is produced by handing real evidence to the real
 * verifier rather than by writing a verdict object by hand. The two exceptions
 * are stated where they occur: the chain verifier is an injected stub, and the
 * fabricated-state group of the fail-closed table necessarily hands
 * `admitTransfer` verdict objects the verifier would never produce — that being
 * the whole point of asking what happens when something does.
 *
 * The fixtures are values and not secrets. `MEASURE_APPROVED` is a run of 'a'
 * characters: a measurement must be an even-length run of LOWERCASE HEX, and
 * anything else is refused as malformed by `parseEvidence`, which is the
 * function to ask when a fixture is being rejected for reasons that are not
 * obvious.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../lib/transports.mjs';
import { summarize } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

export function loadAttest() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'attest.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

// --- Fixtures ----------------------------------------------------------------
// Deliberately verbose. `normalizePolicy` refuses on absence in every field, so
// a policy built from defaults would measure the refusals rather than the rule,
// and a suite whose every cell refused would look like a very strict module
// instead of an untested one.

/** Lowercase hex, even length. A measurement that is neither is malformed. */
const MEASURE_APPROVED = 'a'.repeat(64);
const MEASURE_UNAPPROVED = 'b'.repeat(64);

const DEVICE = 'seed-0042';
const PEER = 'peer-key-9f3c';
const SESSION = 'sess-7c1a';
const NONCE = 'chal-2b8e';
const SIGNER_SET = 'fleet-signers-v3';
const EPOCH = 12;
const CLASS = 'credential';

function merge(base, extra) {
  if (extra === undefined || extra === null) return base;
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

function evidence(A, over) {
  return merge({
    root: A.ROOT_DICE,
    deviceId: DEVICE,
    sessionId: SESSION,
    nonce: NONCE,
    measurement: MEASURE_APPROVED,
    policyEpoch: EPOCH,
    signerSetId: SIGNER_SET,
    storageClasses: [CLASS, 'agent'],
    chain: [{ layer: 0 }, { layer: 1 }, { layer: 2 }]
  }, over);
}

function expected(over) {
  return merge({ sessionId: SESSION, nonce: NONCE, consumedNonces: [] }, over);
}

/**
 * Capability grants, in three shapes.
 *
 * Both identities are granted in the `full` shape and that is not redundancy:
 * `capabilitySubject` matches an ATTESTED verdict against its attested device
 * id and everything else against the pinned peer id, so a grant table naming
 * only one of them would make half the matrix refuse for a reason that has
 * nothing to do with the cell being measured.
 */
const GRANT_SHAPES = [
  {
    id: 'full',
    label: 'grants both identities for this class',
    grants: [
      { device: DEVICE, classes: [CLASS, 'agent'] },
      { device: PEER, classes: [CLASS, 'agent'] }
    ]
  },
  {
    id: 'other-class',
    label: 'grants both identities, but only for class model',
    grants: [
      { device: DEVICE, classes: ['model'] },
      { device: PEER, classes: ['model'] }
    ]
  },
  { id: 'none', label: 'grants nothing to anyone', grants: [] }
];

function policyFor({ requireAttestation, grants }) {
  return {
    requireAttestation,
    trustedSignerSets: [SIGNER_SET],
    minPolicyEpoch: EPOCH,
    approvedMeasurements: [MEASURE_APPROVED],
    grants
  };
}

function request(over) {
  return merge({ artifactClass: CLASS, peerId: PEER, name: 'fleet.cred' }, over);
}

// --- The seven states, each produced by the real verifier ---------------------

/**
 * How each state in the module's closed vocabulary is reached.
 *
 * Every one of these runs the shipped `verifyAttestation`; none writes a verdict
 * object by hand. `stub` records whether an injected chain verifier was involved,
 * and it is carried through into the tables rather than mentioned once here —
 * a table that needed a stub to reach its result should say so where the result
 * is read.
 *
 * Note the verifier is supplied on the malformed, unbound and replayed rows too.
 * Without it those states would also be reachable as `unverified`, and the row
 * would then be measuring the missing verifier rather than the fault it names.
 */
function stateRecipes(A) {
  const ok = () => true;
  const no = () => false;
  return [
    {
      state: A.STATE_ATTESTED,
      how: 'well-formed evidence, bound to this session and challenge, injected stub verifier returns true',
      stub: 'returns true',
      make: () => A.verifyAttestation(evidence(A), expected(), { verifyChain: ok })
    },
    {
      state: A.STATE_UNATTESTED,
      how: 'no evidence offered at all — the ordinary case for a web page',
      stub: null,
      make: () => A.verifyAttestation(null, expected(), {})
    },
    {
      state: A.STATE_MALFORMED,
      how: "evidence whose measurement is 'm-approved' rather than lowercase hex",
      stub: 'returns true',
      make: () => A.verifyAttestation(evidence(A, { measurement: 'm-approved' }), expected(), { verifyChain: ok })
    },
    {
      state: A.STATE_UNBOUND,
      how: 'well-formed evidence naming a different session id',
      stub: 'returns true',
      make: () => A.verifyAttestation(evidence(A, { sessionId: 'sess-elsewhere' }), expected(), { verifyChain: ok })
    },
    {
      state: A.STATE_REPLAYED,
      how: 'well-formed, correctly bound evidence answering a challenge already consumed',
      stub: 'returns true',
      make: () => A.verifyAttestation(evidence(A), expected({ consumedNonces: [NONCE] }), { verifyChain: ok })
    },
    {
      state: A.STATE_UNVERIFIED,
      how: 'well-formed, correctly bound evidence and NO chain verifier — this platform, today',
      stub: null,
      make: () => A.verifyAttestation(evidence(A), expected(), {})
    },
    {
      state: A.STATE_FORGED,
      how: 'well-formed, correctly bound evidence, injected stub verifier returns false',
      stub: 'returns false',
      make: () => A.verifyAttestation(evidence(A), expected(), { verifyChain: no })
    }
  ];
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

// A sink, so V8 cannot delete a call whose result nothing reads. Without it the
// microsecond column would be measuring an empty loop.
let SINK = 0;

/**
 * Median microseconds per call, over `reps` batches of `batch` calls.
 *
 * Batched deliberately: these functions run in the low single-digit microseconds
 * and `hrtime.bigint()` costs tens of nanoseconds to read, so timing one call at
 * a time would fold a few percent of timer overhead into every figure. The
 * quoted number is a per-call mean within a batch and a median across batches,
 * which is stated rather than left to be inferred from the word "median".
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
 * Evidence a hostile or broken device could send.
 *
 * Every case names a ceiling or a type the module states, so this is the module's
 * own threat surface rather than a general fuzz: `LIMITS` bounds nine things a
 * remote device controls and each of them is over-run here at least once.
 *
 * `parseEvidence` is documented never to throw, so the first thing measured is
 * whether that holds; the second is whether the verdict it produces is then
 * refused by the gate under BOTH policies. The second is the one that matters:
 * a malformed blob refused under a requiring policy but admitted under a
 * permitting one would be a downgrade attack, not a strictness setting.
 */
function malformedEvidenceCases(A) {
  const long = (n) => 'x'.repeat(n);
  return [
    { name: 'a string, not an object', what: 'typeof evidence is string', input: 'attested-trust-me' },
    { name: 'an array', what: 'Array.isArray(evidence)', input: [1, 2, 3] },
    { name: 'an empty object', what: 'no fields at all', input: {} },
    { name: 'a number', what: 'typeof evidence is number', input: 42 },
    { name: 'unknown root of trust', what: "root: 'sgx', a name this build does not recognise", input: evidence(A, { root: 'sgx' }) },
    { name: 'root is an object', what: 'root: {} — a type the format never has', input: evidence(A, { root: {} }) },
    { name: 'deviceId absent', what: 'the field is simply missing', input: evidence(A, { deviceId: undefined }) },
    { name: 'deviceId oversized', what: `${A.LIMITS.identifier + 1} chars against a ${A.LIMITS.identifier} ceiling`, input: evidence(A, { deviceId: long(A.LIMITS.identifier + 1) }) },
    { name: 'sessionId oversized', what: `${A.LIMITS.sessionId + 1} chars against a ${A.LIMITS.sessionId} ceiling`, input: evidence(A, { sessionId: long(A.LIMITS.sessionId + 1) }) },
    { name: 'nonce oversized', what: `${A.LIMITS.nonce + 1} chars against a ${A.LIMITS.nonce} ceiling`, input: evidence(A, { nonce: long(A.LIMITS.nonce + 1) }) },
    { name: 'measurement not hex', what: "'m-approved' — the trap that costs a run", input: evidence(A, { measurement: 'm-approved' }) },
    { name: 'measurement uppercase', what: 'uppercase hex is not lowercase hex', input: evidence(A, { measurement: MEASURE_APPROVED.toUpperCase() }) },
    { name: 'measurement odd length', what: 'an odd run of hex is not a run of bytes', input: evidence(A, { measurement: 'abc' }) },
    { name: 'measurement oversized', what: `${A.LIMITS.measurementHex + 2} hex chars against a ${A.LIMITS.measurementHex} ceiling`, input: evidence(A, { measurement: 'a'.repeat(A.LIMITS.measurementHex + 2) }) },
    { name: 'measurement is a number', what: 'a type that has no length to bound', input: evidence(A, { measurement: 12345678 }) },
    { name: 'policyEpoch as a string', what: "'12' compares unlike 12", input: evidence(A, { policyEpoch: '12' }) },
    { name: 'policyEpoch negative', what: '-1, below the floor', input: evidence(A, { policyEpoch: -1 }) },
    { name: 'policyEpoch over the ceiling', what: `${A.LIMITS.policyEpoch + 1}`, input: evidence(A, { policyEpoch: A.LIMITS.policyEpoch + 1 }) },
    { name: 'policyEpoch fractional', what: '12.5 is not an integer epoch', input: evidence(A, { policyEpoch: 12.5 }) },
    { name: 'policyEpoch is Infinity', what: 'a number that satisfies a bare > comparison', input: evidence(A, { policyEpoch: Infinity }) },
    { name: 'signerSetId absent', what: 'the field is missing', input: evidence(A, { signerSetId: undefined }) },
    { name: 'storageClasses not an array', what: "'credential' rather than ['credential']", input: evidence(A, { storageClasses: CLASS }) },
    { name: 'storageClasses unknown member', what: "'root' is not one of the five classes", input: evidence(A, { storageClasses: ['root'] }) },
    { name: 'storageClasses oversized', what: `${A.LIMITS.storageClasses + 1} entries against a ${A.LIMITS.storageClasses} ceiling`, input: evidence(A, { storageClasses: new Array(A.LIMITS.storageClasses + 1).fill(CLASS) }) },
    { name: 'chain not an array', what: 'chain: {} — a shape the format never has', input: evidence(A, { chain: {} }) },
    { name: 'chain oversized', what: `${A.LIMITS.chainLayers + 1} layers against a ${A.LIMITS.chainLayers} ceiling`, input: evidence(A, { chain: new Array(A.LIMITS.chainLayers + 1).fill({ layer: 0 }) }) }
  ];
}

/**
 * Verdict objects the shipped verifier would never produce.
 *
 * This group is the one place in the suite that fabricates a verdict, and it has
 * to: the question is what the gate does when handed a state it does not know,
 * and a state the verifier can produce is by definition one it knows. Three of
 * these are the interesting ones — a fabricated `attested` carrying none of the
 * facts an attested verdict carries, which is exactly what a caller who read the
 * state field and built the rest would produce; a state that differs only in
 * case; and a state from a future build.
 */
function fabricatedVerdictCases(A) {
  return [
    { name: 'a state from a future build', what: "state: 'attested-v2'", verdict: { state: 'attested-v2', evidencePresented: true } },
    { name: 'a state differing only in case', what: "state: 'ATTESTED'", verdict: { state: 'ATTESTED', evidencePresented: true } },
    { name: 'an empty state', what: "state: ''", verdict: { state: '', evidencePresented: true } },
    { name: 'a numeric state', what: 'state: 1', verdict: { state: 1, evidencePresented: true } },
    { name: 'an object state', what: 'state: {}', verdict: { state: {}, evidencePresented: true } },
    { name: 'an array state', what: "state: ['attested']", verdict: { state: ['attested'], evidencePresented: true } },
    { name: 'no verdict at all', what: 'verdict: null', verdict: null },
    { name: 'an empty verdict', what: 'verdict: {} — no state field', verdict: {} },
    {
      name: 'attested, with none of the facts',
      what: "state: 'attested' and nothing else — what a caller who copied the state field would build",
      verdict: { state: A.STATE_ATTESTED, evidencePresented: true }
    },
    {
      name: 'attested, with the facts a device claimed',
      what: 'every measured field present and never verified — the shape a gate fed raw claims would see',
      verdict: {
        state: A.STATE_ATTESTED, evidencePresented: true, root: A.ROOT_DICE, deviceId: DEVICE,
        measurement: MEASURE_APPROVED, policyEpoch: EPOCH, signerSetId: SIGNER_SET,
        storageClasses: [CLASS, 'agent'], chainLayers: 3, chainVerified: null
      }
    }
  ];
}

/**
 * Policies and requests that state nothing, or state it wrongly.
 *
 * The undeclared policy is the load-bearing one: ADR-021 §2.3 says whether an
 * unattested device is acceptable is the sender's decision "not a default", so a
 * policy that has not said must be refused rather than handed an answer. Both
 * truthy-but-not-true spellings are here because that is the shape a policy
 * loaded from JSON or a form field arrives in.
 *
 * `subject` names which verdict each case runs against, and it is not a detail.
 * `capabilitySubject` matches an ATTESTED verdict against its attested device id
 * and ignores `request.peerId` entirely; the peer id is the subject only on the
 * unattested path. A malformed-peer case run against an attested verdict would
 * therefore be admitted — correctly, because the field it corrupted was never
 * read — and would be measuring nothing. The two peer cases run against the
 * unattested verdict, where the peer id is the only identity there is.
 */
function policyShapeCases(A) {
  const full = GRANT_SHAPES[0].grants;
  return [
    { name: 'policy declares nothing', what: 'policy: {}', subject: 'attested', policy: {}, request: request() },
    { name: 'no policy at all', what: 'policy: null', subject: 'attested', policy: null, request: request() },
    { name: "requireAttestation: 'yes'", what: 'truthy, but not the boolean the module requires', subject: 'attested', policy: { requireAttestation: 'yes', grants: full }, request: request() },
    { name: 'requireAttestation: 1', what: 'truthy, but not a declaration', subject: 'attested', policy: { requireAttestation: 1, grants: full }, request: request() },
    { name: 'requireAttestation: undefined', what: 'the field is present in name only', subject: 'attested', policy: { requireAttestation: undefined, grants: full }, request: request() },
    { name: 'everything declared but no grants', what: 'requireAttestation: false and an absent grant table', subject: 'attested', policy: policyFor({ requireAttestation: false, grants: [] }), request: request() },
    { name: 'grants is not an array', what: "grants: 'all'", subject: 'attested', policy: merge(policyFor({ requireAttestation: false, grants: [] }), { grants: 'all' }), request: request() },
    { name: 'a grant naming no device', what: 'grants: [{ classes: [credential] }]', subject: 'attested', policy: merge(policyFor({ requireAttestation: false, grants: [] }), { grants: [{ classes: [CLASS] }] }), request: request() },
    { name: 'a grant for an unknown class', what: "grants: [{ device, classes: ['root'] }]", subject: 'attested', policy: merge(policyFor({ requireAttestation: false, grants: [] }), { grants: [{ device: DEVICE, classes: ['root'] }] }), request: request() },
    { name: 'grants over the ceiling', what: `${A.LIMITS.grants + 1} grants, the useful one last and past the cut`, subject: 'attested', policy: merge(policyFor({ requireAttestation: false, grants: [] }), { grants: new Array(A.LIMITS.grants).fill({ device: 'filler-device', classes: ['model'] }).concat([{ device: DEVICE, classes: [CLASS] }]) }), request: request() },
    { name: 'no request at all', what: 'request: null', subject: 'attested', policy: policyFor({ requireAttestation: false, grants: full }), request: null },
    { name: 'request names no class', what: 'artifactClass absent', subject: 'attested', policy: policyFor({ requireAttestation: false, grants: full }), request: request({ artifactClass: undefined }) },
    { name: 'request names an unknown class', what: "artifactClass: 'root'", subject: 'attested', policy: policyFor({ requireAttestation: false, grants: full }), request: request({ artifactClass: 'root' }) },
    { name: 'request names no peer', what: 'peerId absent, against the UNATTESTED verdict, where it is the only identity', subject: 'unattested', policy: policyFor({ requireAttestation: false, grants: full }), request: request({ peerId: undefined }) },
    { name: 'peerId is not an identifier', what: "peerId: '../../etc', against the UNATTESTED verdict — the shape a path would have", subject: 'unattested', policy: policyFor({ requireAttestation: false, grants: full }), request: request({ peerId: '../../etc' }) }
  ];
}

// --- The suite ---------------------------------------------------------------

export function runAttestSuite({ batch = 2000, reps = 25 } = {}) {
  const shipped = loadAttest();
  if (!shipped) return { available: false, reason: 'artifacts/attest.js not present' };
  const A = shipped.module;

  // The module's own account of what it has never done. Read out of the running
  // module rather than restated here, so this suite cannot claim a support the
  // code does not.
  const roots = A.describeRoots();
  const keyCustody = A.describeKeyCustody();
  const hardwareKeys = A.hardwareKeyAvailability(globalThis);
  const limits = A.describeLimits();

  // --- 1. The state matrix ---------------------------------------------------

  const recipes = stateRecipes(A);
  const verdicts = recipes.map((r) => {
    const v = attempt(r.make);
    return {
      state: r.state,
      how: r.how,
      stub: r.stub,
      threw: v.threw,
      error: v.threw ? v.error : null,
      verdict: v.threw ? null : v.value,
      // The verdict reached the state it was built to reach. A recipe that
      // silently produced a different state would make every cell in its row a
      // measurement of something else.
      reachedIntendedState: !v.threw && v.value.state === r.state,
      // Whether the measured facts are published. They must be, and only be,
      // on `attested`: that is the information barrier, not the calling order.
      publishesFacts: !v.threw && v.value.measurement !== null,
      evidencePresented: !v.threw && v.value.evidencePresented === true,
      chainVerified: v.threw ? null : v.value.chainVerified
    };
  });

  const POLICIES = [
    { id: 'requires', label: 'requires attestation', requireAttestation: true },
    { id: 'permits', label: 'does not require attestation', requireAttestation: false }
  ];

  const matrix = [];
  for (const v of verdicts) {
    const cells = POLICIES.map((p) => {
      const pol = policyFor({ requireAttestation: p.requireAttestation, grants: GRANT_SHAPES[0].grants });
      const d = attempt(() => A.admitTransfer(pol, v.verdict, request()));
      const receipt = d.threw ? null : attempt(() => A.attestationReceipt(v.verdict, d.value, pol));
      return {
        policy: p.id,
        policyLabel: p.label,
        outcome: outcomeOf(d),
        admit: !d.threw && d.value.admit === true,
        code: d.threw ? null : d.value.code,
        reason: d.threw ? d.error : d.value.reason,
        subject: d.threw ? null : d.value.subject,
        identitySource: d.threw ? null : d.value.identitySource,
        receiptSummary: receipt && !receipt.threw ? receipt.value.summary : null,
        // Named separately in the receipt, because "attested and approved" and
        // "nobody asked" both end in a transfer and are entirely different claims.
        receiptSenderRequired: receipt && !receipt.threw ? receipt.value.senderRequiredAttestation : null
      };
    });
    matrix.push({ ...v, cells });
  }

  // The defect condition, evaluated rather than eyeballed: a non-attested state
  // admitted under a policy that requires attestation.
  const wrongAdmissions = [];
  for (const row of matrix) {
    for (const cell of row.cells) {
      if (cell.policy === 'requires' && cell.admit && row.state !== A.STATE_ATTESTED) {
        wrongAdmissions.push({ state: row.state, policy: cell.policy, code: cell.code });
      }
    }
  }

  // The two cells that carry the malformed-versus-absent distinction.
  const permitCell = (state) => {
    const row = matrix.find((r) => r.state === state);
    return row ? row.cells.find((c) => c.policy === 'permits') : null;
  };
  const downgrade = {
    unattestedAdmitted: !!(permitCell(A.STATE_UNATTESTED) || {}).admit,
    malformedAdmitted: !!(permitCell(A.STATE_MALFORMED) || {}).admit,
    malformedCode: (permitCell(A.STATE_MALFORMED) || {}).code || null,
    unattestedCode: (permitCell(A.STATE_UNATTESTED) || {}).code || null
  };
  downgrade.kept = downgrade.unattestedAdmitted && !downgrade.malformedAdmitted;

  // --- 2. The separation, quantified ----------------------------------------

  const combos = [];
  for (const v of verdicts) {
    for (const p of POLICIES) {
      for (const g of GRANT_SHAPES) {
        const pol = policyFor({ requireAttestation: p.requireAttestation, grants: g.grants });
        const d = attempt(() => A.admitTransfer(pol, v.verdict, request()));
        combos.push({
          state: v.state,
          policy: p.id,
          grant: g.id,
          grantLabel: g.label,
          outcome: outcomeOf(d),
          admit: !d.threw && d.value.admit === true,
          code: d.threw ? null : d.value.code,
          identitySource: d.threw ? null : d.value.identitySource
        });
      }
    }
  }

  const admitted = combos.filter((c) => c.admit);
  const refused = combos.filter((c) => c.outcome === 'refused');
  const threw = combos.filter((c) => c.outcome === 'threw');

  // The claim: a valid attestation with no covering grant is never admitted.
  const attestedNoGrant = combos.filter(
    (c) => c.state === A.STATE_ATTESTED && c.grant !== 'full'
  );
  const attestedNoGrantAdmitted = attestedNoGrant.filter((c) => c.admit);
  // And the control, without which the line above proves nothing at all.
  const attestedWithGrant = combos.filter(
    (c) => c.state === A.STATE_ATTESTED && c.grant === 'full'
  );
  const separation = {
    total: combos.length,
    admitted: admitted.length,
    refused: refused.length,
    threw: threw.length,
    attestedUngranted: attestedNoGrant.length,
    attestedUngrantedAdmitted: attestedNoGrantAdmitted.length,
    controlTotal: attestedWithGrant.length,
    controlAdmitted: attestedWithGrant.filter((c) => c.admit).length,
    // Which codes did the ungranted attested combinations refuse with? If any of
    // them refused for a reason OTHER than capability, the control is not
    // isolating the capability rule and the count above means less than it looks.
    ungrantedCodes: Array.from(new Set(attestedNoGrantAdmitted.length ? [] : attestedNoGrant.map((c) => c.code))),
    admittedCombinations: admitted.map((c) => ({ state: c.state, policy: c.policy, grant: c.grant, code: c.code }))
  };

  // --- 3. Fail-closed coverage ----------------------------------------------

  const requiringPolicy = policyFor({ requireAttestation: true, grants: GRANT_SHAPES[0].grants });
  const permittingPolicy = policyFor({ requireAttestation: false, grants: GRANT_SHAPES[0].grants });

  const evidenceRows = malformedEvidenceCases(A).map((c) => {
    const parsed = attempt(() => A.parseEvidence(c.input));
    const v = attempt(() => A.verifyAttestation(c.input, expected(), { verifyChain: () => true }));
    const strict = v.threw ? { threw: true } : attempt(() => A.admitTransfer(requiringPolicy, v.value, request()));
    const lax = v.threw ? { threw: true } : attempt(() => A.admitTransfer(permittingPolicy, v.value, request()));
    return {
      group: 'malformed evidence',
      name: c.name,
      what: c.what,
      parseThrew: parsed.threw,
      parseOk: !parsed.threw && parsed.value.ok === true,
      parseReason: parsed.threw ? parsed.error : (parsed.value.reason || null),
      verifyThrew: v.threw,
      state: v.threw ? null : v.value.state,
      strictOutcome: outcomeOf(strict),
      laxOutcome: outcomeOf(lax),
      strictCode: strict.threw ? null : strict.value.code,
      laxCode: lax.threw ? null : lax.value.code
    };
  });

  const verdictRows = fabricatedVerdictCases(A).map((c) => {
    const strict = attempt(() => A.admitTransfer(requiringPolicy, c.verdict, request()));
    const lax = attempt(() => A.admitTransfer(permittingPolicy, c.verdict, request()));
    return {
      group: 'fabricated verdict',
      name: c.name,
      what: c.what,
      state: c.verdict && c.verdict.state !== undefined ? JSON.stringify(c.verdict.state) : 'absent',
      strictOutcome: outcomeOf(strict),
      laxOutcome: outcomeOf(lax),
      strictCode: strict.threw ? null : strict.value.code,
      laxCode: lax.threw ? null : lax.value.code
    };
  });

  // The verdicts the real verifier produced, so the policy-shape group measures
  // the policy rather than a fault in the evidence.
  const goodVerdict = verdicts.find((v) => v.state === A.STATE_ATTESTED).verdict;
  const bareVerdict = verdicts.find((v) => v.state === A.STATE_UNATTESTED).verdict;
  const policyRows = policyShapeCases(A).map((c) => {
    const v = c.subject === 'unattested' ? bareVerdict : goodVerdict;
    const d = attempt(() => A.admitTransfer(c.policy, v, c.request));
    return {
      group: 'policy or request shape',
      name: c.name,
      what: c.what,
      state: c.subject,
      strictOutcome: outcomeOf(d),
      laxOutcome: outcomeOf(d),
      strictCode: d.threw ? null : d.value.code,
      laxCode: d.threw ? null : d.value.code,
      reason: d.threw ? d.error : d.value.reason
    };
  });

  const failClosed = [...evidenceRows, ...verdictRows, ...policyRows];
  const refusedBoth = failClosed.filter((r) => r.strictOutcome === 'refused' && r.laxOutcome === 'refused');
  const anyThrew = failClosed.filter((r) => r.strictOutcome === 'threw' || r.laxOutcome === 'threw' || r.parseThrew || r.verifyThrew);
  const anyAdmitted = failClosed.filter((r) => r.strictOutcome === 'admitted' || r.laxOutcome === 'admitted');

  const coverage = {
    total: failClosed.length,
    refusedUnderBoth: refusedBoth.length,
    fraction: failClosed.length ? refusedBoth.length / failClosed.length : 0,
    threw: anyThrew.length,
    admitted: anyAdmitted.length,
    admittedNames: anyAdmitted.map((r) => r.name),
    threwNames: anyThrew.map((r) => r.name),
    // parseEvidence is documented never to throw. Measured, not trusted.
    parseNeverThrew: evidenceRows.every((r) => !r.parseThrew),
    parseAlwaysRefused: evidenceRows.every((r) => !r.parseOk),
    // Every malformed blob must land on `malformed`, not on `unattested`.
    allMalformedState: evidenceRows.every((r) => r.state === A.STATE_MALFORMED),
    undeclaredRefused: policyRows
      .filter((r) => r.strictCode === A.CODE_POLICY_UNDECLARED)
      .map((r) => r.name)
  };

  // The one case above that is admitted, isolated so it is read rather than
  // buried in a row: a verdict object nothing verified, carrying every fact an
  // attested verdict carries.
  //
  // This is the boundary of the structural barrier the module's docblock
  // describes, and the barrier is real up to exactly here. The gate cannot be
  // fed raw CLAIMS — the verifier publishes no measurement except on `attested`,
  // so no ordering mistake inside `admitTransfer` can reach one. But the gate
  // also cannot tell a verdict its verifier produced from an object a caller
  // wrote: nothing on a verdict is authenticated and there is no field that
  // could be. `chainVerified: null` beside `state: 'attested'` is a pair the
  // verifier can never emit, and it is admitted, so the pairing is not checked.
  const fabricatedAttested = (() => {
    const withFacts = fabricatedVerdictCases(A).find((c) => c.name === 'attested, with the facts a device claimed');
    const withoutFacts = fabricatedVerdictCases(A).find((c) => c.name === 'attested, with none of the facts');
    const a = attempt(() => A.admitTransfer(requiringPolicy, withFacts.verdict, request()));
    const b = attempt(() => A.admitTransfer(requiringPolicy, withoutFacts.verdict, request()));
    const receipt = a.threw ? null : A.attestationReceipt(withFacts.verdict, a.value, requiringPolicy);
    return {
      withFactsAdmitted: !a.threw && a.value.admit === true,
      withFactsCode: a.threw ? null : a.value.code,
      withoutFactsAdmitted: !b.threw && b.value.admit === true,
      withoutFactsCode: b.threw ? null : b.value.code,
      // The internally inconsistent pair the verifier can never produce.
      chainVerifiedOnAdmittedVerdict: withFacts.verdict.chainVerified,
      // What an auditor would see. If the receipt records the inconsistency, the
      // admission is at least detectable after the fact.
      receiptChainVerified: receipt ? receipt.chainVerified : null,
      receiptSummary: receipt ? receipt.summary : null
    };
  })();

  // The peer id is read only on the unattested path. Measured rather than
  // asserted, because it is the reason two cases in the group above run against
  // the unattested verdict: corrupting a field nobody reads measures nothing.
  const peerIgnoredWhenAttested = (() => {
    const pol = policyFor({ requireAttestation: true, grants: GRANT_SHAPES[0].grants });
    const absent = attempt(() => A.admitTransfer(pol, goodVerdict, request({ peerId: undefined })));
    const hostile = attempt(() => A.admitTransfer(pol, goodVerdict, request({ peerId: '../../etc' })));
    return {
      absentAdmitted: !absent.threw && absent.value.admit === true,
      absentSubject: absent.threw ? null : absent.value.subject,
      absentIdentitySource: absent.threw ? null : absent.value.identitySource,
      hostileAdmitted: !hostile.threw && hostile.value.admit === true,
      hostileSubject: hostile.threw ? null : hostile.value.subject,
      hostileIdentitySource: hostile.threw ? null : hostile.value.identitySource
    };
  })();

  // Which identity each admitting path matched a grant against. ADR-021 §2.3
  // says the two are not equivalent and the receipt names which was used; this
  // reads that field back out rather than trusting the sentence.
  const identity = matrix
    .flatMap((row) => row.cells.filter((c) => c.admit).map((c) => ({
      state: row.state,
      policy: c.policy,
      subject: c.subject,
      identitySource: c.identitySource,
      receiptSenderRequired: c.receiptSenderRequired,
      receiptSummary: c.receiptSummary
    })));

  // A chain verifier that throws is a check that did not happen, and must not be
  // mapped onto the feature's off state. Asked here rather than reasoned about.
  const throwingVerifier = attempt(() =>
    A.verifyAttestation(evidence(A), expected(), {
      verifyChain: () => { throw new Error('the HSM is not reachable'); }
    })
  );
  const verifierFailure = {
    threw: throwingVerifier.threw,
    state: throwingVerifier.threw ? null : throwingVerifier.value.state,
    isRefusingState: !throwingVerifier.threw && throwingVerifier.value.state === A.STATE_UNVERIFIED,
    reason: throwingVerifier.threw ? throwingVerifier.error : throwingVerifier.value.reason
  };

  // A verifier returning something that is neither true nor false — the shape a
  // promise-returning or an undefined-returning verifier has.
  const oddVerifier = ['maybe', null, undefined, 1, {}].map((answer) => {
    const v = attempt(() => A.verifyAttestation(evidence(A), expected(), { verifyChain: () => answer }));
    return {
      answer: answer === undefined ? 'undefined' : JSON.stringify(answer),
      state: v.threw ? null : v.value.state,
      refusing: !v.threw && v.value.state !== A.STATE_ATTESTED
    };
  });

  // A consumed-nonce list past its ceiling. The module slices rather than
  // scanning it all, so the question is what that slice costs correctness: a
  // nonce past the cut is a nonce the replay check will not see.
  const oversizedNonceList = (() => {
    const list = new Array(A.LIMITS.consumedNonces + 1).fill('chal-filler');
    list[A.LIMITS.consumedNonces] = NONCE; // past the cut, on purpose
    const past = attempt(() => A.verifyAttestation(evidence(A), expected({ consumedNonces: list }), { verifyChain: () => true }));
    const inside = list.slice(0, A.LIMITS.consumedNonces - 1).concat([NONCE]);
    const within = attempt(() => A.verifyAttestation(evidence(A), expected({ consumedNonces: inside }), { verifyChain: () => true }));
    return {
      ceiling: A.LIMITS.consumedNonces,
      pastTheCutState: past.threw ? null : past.value.state,
      withinTheCutState: within.threw ? null : within.value.state,
      threw: past.threw || within.threw,
      // If these differ, the ceiling is a correctness boundary and not only a
      // cost one, and that is worth reporting where it can be read.
      cutIsVisible: !past.threw && !within.threw && past.value.state !== within.value.state
    };
  })();

  // --- 4. Cost ---------------------------------------------------------------

  const attestedEvidence = evidence(A);
  const boundExpected = expected();
  const stubOk = () => true;
  const costPolicy = policyFor({ requireAttestation: true, grants: GRANT_SHAPES[0].grants });
  const costRequest = request();
  const costDecision = A.admitTransfer(costPolicy, goodVerdict, costRequest);

  const cost = {
    batch,
    reps,
    verifyAttested: timePerCall(
      () => A.verifyAttestation(attestedEvidence, boundExpected, { verifyChain: stubOk }),
      { batch, reps }
    ),
    verifyUnattested: timePerCall(
      () => A.verifyAttestation(null, boundExpected, {}),
      { batch, reps }
    ),
    parseEvidence: timePerCall(() => A.parseEvidence(attestedEvidence), { batch, reps }),
    admitTransfer: timePerCall(
      () => A.admitTransfer(costPolicy, goodVerdict, costRequest),
      { batch, reps }
    ),
    attestationReceipt: timePerCall(
      () => A.attestationReceipt(goodVerdict, costDecision, costPolicy),
      { batch, reps }
    )
  };

  // What one transfer actually pays: verify once, gate once, receipt once.
  cost.perTransferUs = cost.verifyAttested.p50 + cost.admitTransfer.p50 + cost.attestationReceipt.p50;
  // Against the app's default frame period. 5 fps is a configured constant of
  // this application, not a measurement, and is labelled as such where it prints.
  cost.framePeriodMs = 1000 / 5;
  cost.decisionsPerFramePeriod = (cost.framePeriodMs * 1000) / cost.perTransferUs;
  cost.shareOfOneSecond = cost.perTransferUs / 1e6;

  return {
    available: true,
    path: shipped.path,
    exports: shipped.exports.length,
    states: A.STATES,
    artifactClasses: A.ARTIFACT_CLASSES,
    moduleLimits: A.LIMITS,
    roots,
    keyCustody,
    hardwareKeys,
    limits,
    // Every chain verifier anywhere in this suite is one of these. Carried in the
    // result so a printer cannot forget to say so.
    chainVerifier: 'injected stub — no root of trust is exercised anywhere in this suite',
    verdicts: matrix,
    wrongAdmissions,
    downgrade,
    combos,
    separation,
    failClosed,
    coverage,
    fabricatedAttested,
    peerIgnoredWhenAttested,
    identity,
    verifierFailure,
    oddVerifier,
    oversizedNonceList,
    cost
  };
}
