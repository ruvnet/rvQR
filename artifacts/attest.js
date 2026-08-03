/*!
 * rvQR device attestation — measured boot state as EVIDENCE, and the separate
 * gate that decides.
 *
 * Per ADR-021. [ADR-035](docs/adr/ADR-035-rvqr-signature-admission.md) lets a
 * receiver say which signer it will accept; nothing lets a sender say which
 * receiver it will send to. Shipping a signed agent, a credential or a model
 * into a fleet means caring whether the device on the other side is running an
 * approved RVM, at a current policy epoch, with storage that will not leak what
 * it receives. This module is where the sender gets that say.
 *
 * ---------------------------------------------------------------------------
 * ATTESTATION IS EVIDENCE, NOT AUTHORIZATION — ADR-021 §2.2
 * ---------------------------------------------------------------------------
 *
 * Attestation says what a device measured about itself at boot. It does not say
 * that the device may have this artifact. The failure this file exists to
 * forbid is precise and common: treating a valid attestation as a pass. A
 * device can be genuinely, verifiably running approved firmware and still be
 * the wrong device to send a credential to.
 *
 * So there are two functions and an information barrier between them, and the
 * barrier is the design — not the calling order.
 *
 *   verifyAttestation(evidence, expected, opts) -> VERDICT
 *       Is this evidence readable, bound to THIS session and THIS challenge,
 *       and signed by a root of trust? Nothing else. It is NEVER handed the
 *       sender's policy, so it has nothing to decide with. Its result carries
 *       no `admit`, no `allow`, no boolean anything a caller could mistake for
 *       permission — only a `state` from a closed vocabulary and the facts the
 *       evidence turned out to carry.
 *
 *   admitTransfer(policy, verdict, request) -> { admit, code, reason }
 *       May this artifact go to this device? It is NEVER handed the raw
 *       evidence, only the verdict, so it cannot be talked into anything the
 *       verifier did not certify. Same shape as `core.admitArtifact`, and pure
 *       and total for the same reason: so no other path can reach around it.
 *
 * Three properties make the separation structural rather than procedural:
 *
 *   1. **The verifier cannot decide.** Its argument list contains no policy.
 *      There is no approved-measurement set, no grant table and no capability
 *      anywhere it can see, so the best it can say is "this evidence is
 *      genuine", which is a fact and not a permission.
 *
 *   2. **The gate cannot be fed raw claims.** A verdict publishes `measurement`,
 *      `policyEpoch`, `signerSetId` and `storageClasses` ONLY when the state is
 *      `attested`; on every other state they are null. A device's own claims
 *      therefore never reach a policy comparison unless the verifier first
 *      established that the evidence was readable, bound and signed. A bug in
 *      the gate's ordering cannot approve on a measurement lifted out of
 *      unverified bytes, because there is no such measurement on the object.
 *
 *   3. **Every admission passes through the capability check.** `admitTransfer`
 *      contains exactly one `admit: true`, and it sits after
 *      `capabilityDecision`. That holds on the unattested path too — a sender
 *      that does not require attestation has relaxed its evidence bar, not its
 *      authority model, and letting `unattested` skip the grant table would
 *      make "no attestation" the widest permission in the system.
 *
 * The capability policy remains authoritative, exactly as provenance
 * ([ADR-020](docs/adr/ADR-020-rvqr-embedded-provenance.md)) is an input to a
 * decision and never the decision.
 *
 * ---------------------------------------------------------------------------
 * NO ROOT OF TRUST IS EXERCISED HERE. NOT ONE.
 * ---------------------------------------------------------------------------
 *
 * ADR-021 §2.1 names four roots of trust — **DICE**, **TPM 2.0**, **Secure
 * Enclave** and **Android hardware-backed keys**. This module implements the
 * verdict/gate structure and the evidence FORMAT. It implements none of those
 * four protocols, and nothing in this repository has ever run against the
 * hardware that provides them. `ROOTS` recognises the four names so a malformed
 * blob can be refused; recognising a name is not implementing a protocol, and
 * `describeRoots()` reports every one of them as `unexercised` for exactly that
 * reason. A reader should take no support for any of them from this file.
 *
 * The consequence is deliberate and load-bearing: **chain verification is
 * injected, and absent by default.** `opts.verifyChain(evidence)` is supplied
 * by a caller that actually has a root of trust; with no such function the
 * verifier returns `unverified`, which the gate refuses. It is the same rule
 * provenance.js applies to `sha256` — a check that cannot run reports that it
 * could not run, and never degrades into a pass. So on this platform, today,
 * `attested` is unreachable without a verifier this repository does not have.
 *
 * **The signing identity has not moved.** ADR-021 §2.4 puts rvQR's key in a
 * platform key store and ADR-035 §4.8 says that ADR is superseded, not amended,
 * when the key leaves `localStorage`. It has not left. `describeKeyCustody()`
 * says so in one place so the UI cannot claim otherwise, and
 * `hardwareKeyAvailability()` reports whether an environment even exposes
 * WebAuthn — presence, never a demonstration. Nothing here has signed anything
 * with a hardware-held key, so **ADR-035 stands unsuperseded**.
 *
 * ---------------------------------------------------------------------------
 * UNATTESTED IS A STATE, NOT A FAILURE — ADR-021 §2.3
 * ---------------------------------------------------------------------------
 *
 * Most devices rvQR runs on are a web page in a browser with no attestation
 * available at all. That is reported as `unattested` and it is not an error.
 * Whether it is acceptable is the sender's policy decision, so
 * `policy.requireAttestation` has NO DEFAULT: a policy that has not stated it
 * is refused with `policy-undeclared` rather than being given an answer nobody
 * chose. Every other policy field defaults to refusing for the same reason —
 * an absent grant table grants nothing, an absent measurement set approves
 * nothing.
 *
 * An unattested device still has an identity — the pinned peer key ADR-035
 * already gives a sender — so the capability check has something to match a
 * grant against without attestation. That identity is materially weaker, and
 * `identitySource` names which of the two was used rather than letting an
 * attested device id and a pinned peer read alike.
 *
 * `attestationReceipt()` keeps "attested and approved" and "nobody asked"
 * apart in named fields, because ADR-016 §2.3's receipt is where an auditor
 * later has to tell them apart, and a single "ok" would conflate them forever.
 *
 * ---------------------------------------------------------------------------
 * REPLAY — ADR-021 §4.5, the rule ADR-007 §2.4 applies to control frames
 * ---------------------------------------------------------------------------
 *
 * A recorded attestation is a genuine attestation and verifies perfectly. The
 * mitigation is binding, not cryptographic strength: evidence names the session
 * id of a specific transfer and echoes a nonce the sender issued for it, and a
 * nonce already consumed is refused a second time. A recording replayed into a
 * new session carries the old session id and the old challenge and fails on
 * both.
 *
 * A caveat worth stating rather than discovering: this module checks the
 * binding as a plain field comparison. In a real root of trust the nonce is
 * inside the signed quote, so binding and chain verification are one check and
 * not two — `verifyChain` is where that would be enforced, and it is exactly
 * the part that is unexercised.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network, and no clock — the session id, the nonce and the consumed-nonce list
 * are passed in, so the tests are deterministic and a verdict reached twice
 * from the same evidence is the same verdict. Trust asymmetry follows
 * provenance.js: `parseEvidence()` never throws, because its input arrived from
 * whatever is on the other end of the link.
 *
 * Browser: load this file; it needs nothing else.
 * Node:    require('./attest.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRAttest = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Roots of trust --------------------------------------------------------
  // ADR-021 §2.1's four, as FORMAT values only. See the docblock: none of them
  // is implemented here and none has been exercised on hardware.

  var ROOT_DICE = 'dice';
  var ROOT_TPM2 = 'tpm2';
  var ROOT_SECURE_ENCLAVE = 'secure-enclave';
  var ROOT_ANDROID_KEY = 'android-key';
  var ROOTS = [ROOT_DICE, ROOT_TPM2, ROOT_SECURE_ENCLAVE, ROOT_ANDROID_KEY];

  var ROOT_LABELS = {
    'dice': 'TCG DICE layered measurement',
    'tpm2': 'TPM 2.0 quote',
    'secure-enclave': 'Apple Secure Enclave attestation',
    'android-key': 'Android hardware-backed key attestation'
  };

  // --- The verdict vocabulary ------------------------------------------------
  // Closed, and the gate switches over it exhaustively. A state outside this
  // list is refused as unknown rather than falling through, which is
  // ADR-035 §2.1's rule one layer up and ADR-021 §4.2 here.

  /** The evidence was readable, bound to this session, and its chain verified. */
  var STATE_ATTESTED = 'attested';

  /** No evidence was offered. A state, not a failure — ADR-021 §2.3. */
  var STATE_UNATTESTED = 'unattested';

  /** Evidence arrived and could not be read as evidence. */
  var STATE_MALFORMED = 'malformed';

  /** Readable, but not bound to this session id and this challenge. */
  var STATE_UNBOUND = 'unbound';

  /** Bound to a nonce the sender has already consumed. A recording. */
  var STATE_REPLAYED = 'replayed';

  /** No chain verifier was supplied, or it could not reach an answer. */
  var STATE_UNVERIFIED = 'unverified';

  /** A chain verifier ran and said no. */
  var STATE_FORGED = 'forged';

  var STATES = [
    STATE_ATTESTED, STATE_UNATTESTED, STATE_MALFORMED, STATE_UNBOUND,
    STATE_REPLAYED, STATE_UNVERIFIED, STATE_FORGED
  ];

  // --- Decision codes --------------------------------------------------------
  // Stable strings, matching the convention in delta.js, semdelta.js and
  // planner.js: callers switch on the code, the reason is for people.

  var CODE_PENDING = 'pending';
  var CODE_POLICY_UNDECLARED = 'policy-undeclared';
  var CODE_UNKNOWN_STATE = 'unknown-attestation-state';
  var CODE_UNATTESTED_REFUSED = 'unattested-refused';
  var CODE_MALFORMED = 'malformed-evidence';
  var CODE_UNBOUND = 'unbound-evidence';
  var CODE_REPLAYED = 'replayed-evidence';
  var CODE_UNVERIFIED = 'unverified-evidence';
  var CODE_FORGED = 'forged-evidence';
  var CODE_UNTRUSTED_SIGNERS = 'untrusted-signers';
  var CODE_STALE_EPOCH = 'stale-policy-epoch';
  var CODE_UNAPPROVED_MEASUREMENT = 'unapproved-measurement';
  var CODE_STORAGE_REFUSED = 'storage-refused';
  var CODE_CAPABILITY_REFUSED = 'capability-refused';
  var CODE_ATTESTED_AND_APPROVED = 'attested-and-approved';
  var CODE_UNATTESTED_PERMITTED = 'unattested-permitted';

  // --- The four sender preconditions, ADR-021 §2.1 ---------------------------

  var RULE_SIGNERS = 'signer-set';
  var RULE_EPOCH = 'policy-epoch';
  var RULE_MEASUREMENT = 'rvm-measurement';
  var RULE_STORAGE = 'storage-policy';

  /** Kept apart from the four above because it is the authoritative one. */
  var RULE_CAPABILITY = 'capability';

  var PRECONDITION_CODES = {};
  PRECONDITION_CODES[RULE_SIGNERS] = CODE_UNTRUSTED_SIGNERS;
  PRECONDITION_CODES[RULE_EPOCH] = CODE_STALE_EPOCH;
  PRECONDITION_CODES[RULE_MEASUREMENT] = CODE_UNAPPROVED_MEASUREMENT;
  PRECONDITION_CODES[RULE_STORAGE] = CODE_STORAGE_REFUSED;

  // --- Artifact classes ------------------------------------------------------
  // The classes a storage policy can speak about. Closed on purpose: a class
  // nobody has defined must not match a grant or a storage permission by
  // accident, so an unknown one is refused where it is read rather than carried
  // as an opaque string that later compares equal to something.

  var CLASS_AGENT = 'agent';
  var CLASS_CREDENTIAL = 'credential';
  var CLASS_MODEL = 'model';
  var CLASS_CONTAINER = 'container';
  var CLASS_GENERIC = 'generic';
  var ARTIFACT_CLASSES = [CLASS_AGENT, CLASS_CREDENTIAL, CLASS_MODEL, CLASS_CONTAINER, CLASS_GENERIC];

  // --- Hostile-input ceilings ------------------------------------------------
  // Evidence arrives from the device on the other end of the link, which is the
  // device this whole mechanism exists to be unsure about. Every value below
  // bounds something that device controls, and each is checked before it
  // reaches an allocation, a loop or a comparison.

  var LIMITS = {
    identifier: 256,
    sessionId: 64,
    nonce: 128,
    measurementHex: 256,
    storageClasses: 16,
    chainLayers: 16,
    consumedNonces: 4096,
    policyEpoch: 2147483647,
    grants: 1024,
    approvedMeasurements: 1024,
    trustedSignerSets: 256
  };

  var HEX_RE = /^[0-9a-f]+$/;
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

  // ---------------------------------------------------------------------------
  // Evidence — reading it, and refusing it without throwing
  // ---------------------------------------------------------------------------

  function isString(v) {
    return typeof v === 'string';
  }

  function isIdentifier(v, max) {
    return isString(v) && v.length > 0 && v.length <= max && ID_RE.test(v);
  }

  function isInteger(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  /**
   * Reads a device's attestation evidence. Returns { ok, evidence, reason } and
   * never throws: this input arrived from an unknown device, so a malformed
   * blob is a state to report, not an exception on a security path.
   *
   * `chain` is carried as a layer count and nothing else. The layered
   * measurements DICE produces are meaningful only to a verifier that can check
   * them, and this module is not one — see the docblock. Pretending to parse a
   * structure nobody here can validate would be the more dishonest option.
   */
  function parseEvidence(input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no evidence was supplied' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'evidence is not an object' };
    }

    if (ROOTS.indexOf(input.root) < 0) {
      return {
        ok: false,
        reason: 'root of trust ' + JSON.stringify(String(input.root).slice(0, 40)) +
          ' is not one of ' + ROOTS.join(', ')
      };
    }
    if (!isIdentifier(input.deviceId, LIMITS.identifier)) {
      return { ok: false, reason: 'deviceId is missing or is not an identifier' };
    }
    if (!isIdentifier(input.sessionId, LIMITS.sessionId)) {
      return { ok: false, reason: 'sessionId is missing or is not an identifier' };
    }
    if (!isIdentifier(input.nonce, LIMITS.nonce)) {
      return { ok: false, reason: 'nonce is missing or is not an identifier' };
    }
    if (!isString(input.measurement) || !input.measurement.length ||
        input.measurement.length > LIMITS.measurementHex ||
        !HEX_RE.test(input.measurement) || (input.measurement.length & 1)) {
      return { ok: false, reason: 'measurement is not an even-length run of lowercase hex' };
    }
    if (!isInteger(input.policyEpoch) || input.policyEpoch < 0 || input.policyEpoch > LIMITS.policyEpoch) {
      return { ok: false, reason: 'policyEpoch is not a non-negative integer inside the ceiling' };
    }
    if (!isIdentifier(input.signerSetId, LIMITS.identifier)) {
      return { ok: false, reason: 'signerSetId is missing or is not an identifier' };
    }

    var declared = input.storageClasses;
    if (!Array.isArray(declared)) {
      return { ok: false, reason: 'storageClasses must be an array, even an empty one' };
    }
    if (declared.length > LIMITS.storageClasses) {
      return { ok: false, reason: 'storageClasses declares ' + declared.length + ' entries, over the limit of ' + LIMITS.storageClasses };
    }
    var classes = [];
    for (var i = 0; i < declared.length; i++) {
      if (ARTIFACT_CLASSES.indexOf(declared[i]) < 0) {
        return {
          ok: false,
          reason: 'storage class ' + JSON.stringify(String(declared[i]).slice(0, 40)) +
            ' is not one of ' + ARTIFACT_CLASSES.join(', ')
        };
      }
      if (classes.indexOf(declared[i]) < 0) classes.push(declared[i]);
    }
    // A set, so two devices declaring the same permissions in different orders
    // produce the same evidence.
    classes.sort();

    var layers = 0;
    if (input.chain !== undefined && input.chain !== null) {
      if (!Array.isArray(input.chain)) return { ok: false, reason: 'chain must be an array' };
      if (input.chain.length > LIMITS.chainLayers) {
        return { ok: false, reason: 'chain declares ' + input.chain.length + ' layers, over the limit of ' + LIMITS.chainLayers };
      }
      layers = input.chain.length;
    }

    return {
      ok: true,
      evidence: {
        root: input.root,
        deviceId: input.deviceId,
        sessionId: input.sessionId,
        nonce: input.nonce,
        measurement: input.measurement,
        policyEpoch: input.policyEpoch,
        signerSetId: input.signerSetId,
        storageClasses: classes,
        chainLayers: layers
      }
    };
  }

  // ---------------------------------------------------------------------------
  // The verifier — a verdict, and nothing that resembles a permission
  // ---------------------------------------------------------------------------

  /**
   * The verdict object. Note what is absent: there is no `admit`, no `allow`,
   * no `ok` and no `trusted` — nothing a caller could read as permission.
   * `state` is the whole answer and the gate is the only thing entitled to act
   * on it.
   *
   * The measured facts are published ONLY on `attested`. On every other state
   * they are null, so a device's own claims cannot reach a policy comparison
   * unless the verifier first established the evidence was readable, bound and
   * signed.
   */
  function verdictFor(state, reason, facts) {
    var f = facts || {};
    var attested = state === STATE_ATTESTED;
    return {
      state: state,
      reason: reason,
      evidencePresented: f.evidencePresented === true,
      root: attested ? f.root : null,
      deviceId: attested ? f.deviceId : null,
      measurement: attested ? f.measurement : null,
      policyEpoch: attested ? f.policyEpoch : null,
      signerSetId: attested ? f.signerSetId : null,
      storageClasses: attested ? f.storageClasses : null,
      chainLayers: attested ? f.chainLayers : null,
      binding: f.binding || { sessionMatched: false, nonceMatched: false, consumed: false },
      chainVerified: f.chainVerified === undefined ? null : f.chainVerified
    };
  }

  /**
   * Reads evidence into a verdict.
   *
   * `expected` is the sender's side of the binding — { sessionId, nonce,
   * consumedNonces } — and is the only outside data this function takes. There
   * is no policy in this argument list, by construction: the verifier has
   * nothing to decide with and therefore cannot decide.
   *
   * `opts.verifyChain(evidence) -> true | false | null` is the root-of-trust
   * check, supplied by a caller that has one. With none, the state is
   * `unverified`, which the gate refuses. A verifier that throws also yields
   * `unverified` — an error is mapped onto a REFUSING state, never onto the
   * feature's off state, which is the defect ADR-035 §2.2 records.
   */
  function verifyAttestation(evidence, expected, opts) {
    var e = expected || {};
    var options = opts || {};

    if (evidence === null || evidence === undefined) {
      return verdictFor(STATE_UNATTESTED,
        'No attestation evidence was offered. This device measured nothing it can show, ' +
        'which is the ordinary case for a web page. Whether that is acceptable is the ' +
        'sender’s policy, not a property of this verdict.',
        { evidencePresented: false });
    }

    var parsed = parseEvidence(evidence);
    if (!parsed.ok) {
      return verdictFor(STATE_MALFORMED,
        'Evidence was offered and could not be read: ' + parsed.reason + '.',
        { evidencePresented: true });
    }
    var ev = parsed.evidence;

    // --- binding, ADR-021 §4.5 -----------------------------------------------
    var sessionMatched = isString(e.sessionId) && e.sessionId === ev.sessionId;
    var nonceMatched = isString(e.nonce) && e.nonce === ev.nonce;
    var consumedList = Array.isArray(e.consumedNonces) ? e.consumedNonces : [];
    if (consumedList.length > LIMITS.consumedNonces) {
      consumedList = consumedList.slice(0, LIMITS.consumedNonces);
    }
    var consumed = consumedList.indexOf(ev.nonce) >= 0;
    var binding = { sessionMatched: sessionMatched, nonceMatched: nonceMatched, consumed: consumed };

    if (!sessionMatched || !nonceMatched) {
      var why = [];
      if (!sessionMatched) {
        why.push('it names session ' + JSON.stringify(ev.sessionId) + ' where this transfer is ' +
          JSON.stringify(isString(e.sessionId) ? e.sessionId : null));
      }
      if (!nonceMatched) {
        why.push('it echoes challenge ' + JSON.stringify(ev.nonce) + ' where this transfer issued ' +
          JSON.stringify(isString(e.nonce) ? e.nonce : null));
      }
      return verdictFor(STATE_UNBOUND,
        'This evidence is not bound to this transfer: ' + why.join(', ') +
        '. A recording of a genuine attestation is a genuine attestation, so binding is the check that matters.',
        { evidencePresented: true, binding: binding });
    }

    // Bound correctly and yet the challenge has already been spent: the same
    // evidence arriving twice inside one session.
    if (consumed) {
      return verdictFor(STATE_REPLAYED,
        'Challenge ' + JSON.stringify(ev.nonce) + ' has already been consumed by this sender, ' +
        'so this is a second presentation of evidence that was answered once.',
        { evidencePresented: true, binding: binding });
    }

    // --- root of trust -------------------------------------------------------
    if (typeof options.verifyChain !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No chain verifier was supplied, so the ' + ROOT_LABELS[ev.root] + ' this evidence claims ' +
        'was not checked. Nothing in rvQR implements any of the four roots of trust; a check that ' +
        'cannot run says it could not run.',
        { evidencePresented: true, binding: binding, chainVerified: null });
    }

    var chainVerified;
    try {
      chainVerified = options.verifyChain(ev);
    } catch (err) {
      // Deliberately NOT mapped onto "unattested" or onto a pass. A verifier
      // that failed is a check that did not happen.
      return verdictFor(STATE_UNVERIFIED,
        'The chain verifier failed: ' + (err && err.message ? err.message : String(err)) + '.',
        { evidencePresented: true, binding: binding, chainVerified: null });
    }

    if (chainVerified === true) {
      return verdictFor(STATE_ATTESTED,
        'The ' + ROOT_LABELS[ev.root] + ' verified, bound to this session and this challenge. ' +
        'That is what the device measured about itself — it is not permission to receive anything.',
        {
          evidencePresented: true, binding: binding, chainVerified: true,
          root: ev.root, deviceId: ev.deviceId, measurement: ev.measurement,
          policyEpoch: ev.policyEpoch, signerSetId: ev.signerSetId,
          storageClasses: ev.storageClasses, chainLayers: ev.chainLayers
        });
    }
    if (chainVerified === false) {
      return verdictFor(STATE_FORGED,
        'The chain verifier rejected this evidence. The device presented an attestation it cannot back.',
        { evidencePresented: true, binding: binding, chainVerified: false });
    }
    return verdictFor(STATE_UNVERIFIED,
      'The chain verifier returned ' + JSON.stringify(chainVerified) + ' rather than a verdict, ' +
      'so nothing was established.',
      { evidencePresented: true, binding: binding, chainVerified: null });
  }

  // ---------------------------------------------------------------------------
  // The policy — the sender's, and every field of it defaults to refusing
  // ---------------------------------------------------------------------------

  /**
   * Normalises a sender policy. Absence is never generosity here: no grants
   * grants nothing, no approved measurement approves nothing, no stated epoch
   * makes nothing current.
   *
   * `requireAttestation` is the one field with no default at all. ADR-021 §2.3
   * says whether unattested is acceptable is the sender's decision "not a
   * default", so a policy that has not said is reported as undeclared and
   * refused, rather than being handed an answer nobody chose.
   */
  function normalizePolicy(policy) {
    var p = policy || {};
    var out = {
      declared: p.requireAttestation === true || p.requireAttestation === false,
      requireAttestation: p.requireAttestation === true,
      trustedSignerSets: [],
      minPolicyEpoch: isInteger(p.minPolicyEpoch) && p.minPolicyEpoch >= 0 ? p.minPolicyEpoch : null,
      approvedMeasurements: [],
      grants: []
    };

    var sets = Array.isArray(p.trustedSignerSets) ? p.trustedSignerSets : [];
    for (var i = 0; i < sets.length && out.trustedSignerSets.length < LIMITS.trustedSignerSets; i++) {
      if (isIdentifier(sets[i], LIMITS.identifier)) out.trustedSignerSets.push(sets[i]);
    }

    var ms = Array.isArray(p.approvedMeasurements) ? p.approvedMeasurements : [];
    for (var m = 0; m < ms.length && out.approvedMeasurements.length < LIMITS.approvedMeasurements; m++) {
      if (isString(ms[m]) && HEX_RE.test(ms[m])) out.approvedMeasurements.push(ms[m]);
    }

    var gs = Array.isArray(p.grants) ? p.grants : [];
    for (var g = 0; g < gs.length && out.grants.length < LIMITS.grants; g++) {
      var grant = gs[g];
      if (!grant || typeof grant !== 'object') continue;
      if (!isIdentifier(grant.device, LIMITS.identifier)) continue;
      var classes = [];
      var declared = Array.isArray(grant.classes) ? grant.classes : [];
      for (var c = 0; c < declared.length; c++) {
        if (ARTIFACT_CLASSES.indexOf(declared[c]) >= 0 && classes.indexOf(declared[c]) < 0) {
          classes.push(declared[c]);
        }
      }
      out.grants.push({ device: grant.device, classes: classes.sort() });
    }

    return out;
  }

  /**
   * What is being sent, and who the sender believes it is sending to
   * independently of attestation.
   *
   * `peerId` is the identity ADR-035 already gives a sender — the pinned
   * signing key of the peer — and it exists here because a grant is made to an
   * identity and an unattested device still has one. Without it, `unattested`
   * could never be admitted at all, which would turn ADR-021 §2.3's "the sender
   * proceeds" into "the sender cannot".
   */
  function normalizeRequest(request) {
    var r = request || {};
    return {
      artifactClass: ARTIFACT_CLASSES.indexOf(r.artifactClass) >= 0 ? r.artifactClass : null,
      peerId: isIdentifier(r.peerId, LIMITS.identifier) ? r.peerId : null,
      name: isString(r.name) && r.name.length <= LIMITS.identifier ? r.name : null
    };
  }

  // ---------------------------------------------------------------------------
  // The gate — pure, total, and the only thing here that decides
  // ---------------------------------------------------------------------------

  function refusal(code, reason, extra) {
    var e = extra || {};
    return {
      admit: false,
      code: code,
      reason: reason,
      unmet: e.unmet || [],
      subject: e.subject === undefined ? null : e.subject,
      identitySource: e.identitySource === undefined ? null : e.identitySource
    };
  }

  /**
   * Stage one: what the verdict state alone permits. Total over the vocabulary,
   * and an unrecognised state fails closed — a future attestation state must
   * not become an accidental bypass by falling through a switch, which is
   * ADR-035 §4.1's rule and ADR-021 §4.2's.
   *
   * `pass` here means only "the evidence bar is clear". It is not an admission;
   * two more stages follow and one of them is never skipped.
   */
  function attestationGate(policy, state) {
    switch (state) {
      case STATE_ATTESTED:
        return { pass: true };
      case STATE_UNATTESTED:
        if (policy.requireAttestation) {
          return {
            pass: false, code: CODE_UNATTESTED_REFUSED,
            reason: 'This sender requires attestation and this device offered none.'
          };
        }
        return { pass: true };
      case STATE_MALFORMED:
        return {
          pass: false, code: CODE_MALFORMED,
          reason: 'Evidence was offered and could not be read. Unreadable evidence is refused, ' +
            'not treated as the absence of evidence — a device that tried and failed is not a device that never tried.'
        };
      case STATE_UNBOUND:
        return {
          pass: false, code: CODE_UNBOUND,
          reason: 'The evidence is not bound to this session and this challenge.'
        };
      case STATE_REPLAYED:
        return {
          pass: false, code: CODE_REPLAYED,
          reason: 'The challenge this evidence answers has already been consumed.'
        };
      case STATE_UNVERIFIED:
        return {
          pass: false, code: CODE_UNVERIFIED,
          reason: 'The root of trust behind this evidence was never checked, so nothing was established.'
        };
      case STATE_FORGED:
        return {
          pass: false, code: CODE_FORGED,
          reason: 'The chain verifier rejected this evidence.'
        };
      default:
        return {
          pass: false, code: CODE_UNKNOWN_STATE,
          reason: 'Unrecognised attestation state: ' + JSON.stringify(state) +
            '. An attestation state this build does not know is refused rather than interpreted.'
        };
    }
  }

  /**
   * Stage two: ADR-021 §2.1's four preconditions, enumerated in full rather
   * than short-circuited — a device failing three of them should say so,
   * because fixing one will not be enough.
   *
   * Only meaningful on `attested`: on every other state the verdict carries no
   * measurement, no epoch and no signer set to test, which is the point of
   * publishing them conditionally.
   *
   * Every rule reads a fact that may be absent, and absence is unmet rather
   * than satisfied. That is not defensive noise: `undefined < 12` is false in
   * JavaScript, so an epoch rule written as a bare comparison would be SILENTLY
   * SATISFIED by a verdict carrying no epoch at all. A missing fact is the one
   * case where the natural expression fails open.
   */
  function unmetPreconditions(policy, verdict) {
    var unmet = [];

    if (!policy.trustedSignerSets.length) {
      unmet.push({
        rule: RULE_SIGNERS,
        reason: 'this sender trusts no signer set at all, so no receiver’s can be trusted'
      });
    } else if (!isString(verdict.signerSetId)) {
      unmet.push({
        rule: RULE_SIGNERS,
        reason: 'this verdict names no signer set, so none of them can be the trusted one'
      });
    } else if (policy.trustedSignerSets.indexOf(verdict.signerSetId) < 0) {
      unmet.push({
        rule: RULE_SIGNERS,
        reason: 'the receiver’s signer set ' + JSON.stringify(verdict.signerSetId) + ' is not one this sender trusts'
      });
    }

    if (policy.minPolicyEpoch === null) {
      unmet.push({
        rule: RULE_EPOCH,
        reason: 'this sender has not stated a current policy epoch, so no receiver’s epoch can be current'
      });
    } else if (!isInteger(verdict.policyEpoch)) {
      unmet.push({
        rule: RULE_EPOCH,
        reason: 'this verdict carries no policy epoch, and an absent epoch is not a current one'
      });
    } else if (verdict.policyEpoch < policy.minPolicyEpoch) {
      unmet.push({
        rule: RULE_EPOCH,
        reason: 'the receiver is at policy epoch ' + verdict.policyEpoch + ' and this sender requires at least ' + policy.minPolicyEpoch
      });
    }

    if (!policy.approvedMeasurements.length) {
      unmet.push({
        rule: RULE_MEASUREMENT,
        reason: 'this sender approves no RVM measurement, so no measurement can be approved'
      });
    } else if (!isString(verdict.measurement)) {
      unmet.push({
        rule: RULE_MEASUREMENT,
        reason: 'this verdict carries no RVM measurement, so there is nothing to approve'
      });
    } else if (policy.approvedMeasurements.indexOf(verdict.measurement) < 0) {
      unmet.push({
        rule: RULE_MEASUREMENT,
        reason: 'the receiver’s RVM measures ' + verdict.measurement.slice(0, 16) + '…, which is not an approved measurement'
      });
    }

    return unmet;
  }

  /**
   * Whether the receiver's own storage policy admits this class of artifact.
   * Separated from the loop above only because it needs the request, and kept
   * inside the same stage: it is ADR-021 §2.1's fourth precondition, not the
   * capability check.
   */
  function unmetStorage(verdict, request) {
    if (request.artifactClass === null) {
      return {
        rule: RULE_STORAGE,
        reason: 'this transfer names no artifact class, so no storage policy can permit it'
      };
    }
    if (!verdict.storageClasses || verdict.storageClasses.indexOf(request.artifactClass) < 0) {
      return {
        rule: RULE_STORAGE,
        reason: 'the receiver’s storage policy does not admit an artifact of class ' +
          JSON.stringify(request.artifactClass)
      };
    }
    return null;
  }

  /**
   * Stage three: the authoritative one.
   *
   * This is the check ADR-021 §2.2 says attestation is an input to and never a
   * substitute for. It runs on EVERY path that can admit, attested or not:
   * a sender that does not require attestation has relaxed its evidence bar,
   * not its authority model, and a grant table that `unattested` could skip
   * would make "no attestation" the widest permission in the system.
   *
   * Default-deny, and deliberately data rather than an injected predicate —
   * foreign code in the one function entitled to say yes is the wrong shape,
   * however convenient.
   */
  function capabilitySubject(verdict, request) {
    // An attested device id is the stronger identity and wins wherever it
    // exists. Falling back to the peer id is what makes the unattested path
    // reachable at all, and the two are never mixed: an attested device is
    // never matched against a name it did not attest to.
    if (verdict && verdict.state === STATE_ATTESTED && verdict.deviceId) {
      return { id: verdict.deviceId, source: 'attestation' };
    }
    if (request.peerId) return { id: request.peerId, source: 'peer' };
    return { id: null, source: null };
  }

  function capabilityDecision(policy, verdict, request) {
    var subject = capabilitySubject(verdict, request);
    if (request.artifactClass === null) {
      return {
        allow: false, subject: subject.id, identitySource: subject.source,
        reason: 'this transfer names no artifact class, and no grant covers an unnamed class'
      };
    }
    if (subject.id === null) {
      return {
        allow: false, subject: null, identitySource: null,
        reason: 'no identity was established for this receiver — neither an attested device id nor a ' +
          'pinned peer — and a grant is made to an identity rather than to a link'
      };
    }
    for (var i = 0; i < policy.grants.length; i++) {
      if (policy.grants[i].device !== subject.id) continue;
      if (policy.grants[i].classes.indexOf(request.artifactClass) >= 0) {
        return {
          allow: true, subject: subject.id, identitySource: subject.source,
          reason: subject.id + ' is granted artifacts of class ' + request.artifactClass +
            ' (identified by ' + subject.source + ')'
        };
      }
      return {
        allow: false, subject: subject.id, identitySource: subject.source,
        reason: subject.id + ' holds a grant, but not for an artifact of class ' + request.artifactClass
      };
    }
    return {
      allow: false, subject: subject.id, identitySource: subject.source,
      reason: 'no capability grant names ' + subject.id +
        '. A device may be measured, approved and current and still be the wrong device to send this to'
    };
  }

  /**
   * May this artifact go to this device?
   *
   * Same shape as `core.admitArtifact` — a policy and a verdict in, an
   * { admit, code, reason } out — pure and total for the same reason: so the
   * rule can be tested exhaustively and no other path can reach around it.
   *
   * The argument list carries no evidence, only the verdict, so this function
   * cannot be told anything the verifier did not certify. And there is exactly
   * one `admit: true` in it, at the bottom, after `capabilityDecision`.
   */
  function admitTransfer(policy, verdict, request) {
    var p = normalizePolicy(policy);
    var req = normalizeRequest(request);

    // A policy that has not stated its position on unattested devices has not
    // made the decision ADR-021 §2.3 says is its to make.
    if (!p.declared) {
      return refusal(CODE_POLICY_UNDECLARED,
        'This policy has not stated whether it requires attestation. ' +
        'Unattested is a state, and which way to treat it is the sender’s decision — there is no default to fall back on.');
    }

    // A verdict that has not landed never admits, exactly as a pending
    // signature check never admits in ADR-035 §2.1.
    if (!verdict || !verdict.state) {
      return refusal(CODE_PENDING, 'The attestation check has not completed yet.');
    }

    var gate = attestationGate(p, verdict.state);
    if (!gate.pass) return refusal(gate.code, gate.reason);

    var unmet = [];
    if (verdict.state === STATE_ATTESTED) {
      unmet = unmetPreconditions(p, verdict);
      var storage = unmetStorage(verdict, req);
      if (storage) unmet.push(storage);
    }
    if (unmet.length) {
      return refusal(PRECONDITION_CODES[unmet[0].rule], unmet[0].reason, { unmet: unmet });
    }

    var capability = capabilityDecision(p, verdict, req);
    if (!capability.allow) {
      return refusal(CODE_CAPABILITY_REFUSED, capability.reason, {
        unmet: [{ rule: RULE_CAPABILITY, reason: capability.reason }],
        subject: capability.subject,
        identitySource: capability.identitySource
      });
    }

    return {
      admit: true,
      code: verdict.state === STATE_ATTESTED ? CODE_ATTESTED_AND_APPROVED : CODE_UNATTESTED_PERMITTED,
      reason: verdict.state === STATE_ATTESTED
        ? 'Attested, all four preconditions met, and the capability policy grants it: ' + capability.reason + '.'
        : 'Unattested, which this sender permits, and the capability policy grants it anyway: ' + capability.reason + '.',
      unmet: [],
      subject: capability.subject,
      identitySource: capability.identitySource
    };
  }

  // ---------------------------------------------------------------------------
  // The receipt — ADR-021 §2.3 and §4.3
  // ---------------------------------------------------------------------------

  /**
   * What ADR-016 §2.3's witness record carries about attestation.
   *
   * The one thing this must never do is conflate "attested and approved" with
   * "nobody asked". Both can end in a transfer proceeding and they are entirely
   * different claims, so they are carried in separate named fields —
   * `attestation`, `evidencePresented` and `senderRequiredAttestation` — and
   * the summary sentence is built from all three rather than from the outcome.
   * An auditor reading `admitted: true` alone learns nothing, which is why
   * `admitted` is never the only thing recorded.
   */
  function attestationReceipt(verdict, decision, policy) {
    var p = normalizePolicy(policy);
    var state = verdict && verdict.state ? verdict.state : null;
    var d = decision || {};

    var receipt = {
      attestation: state,
      evidencePresented: !!(verdict && verdict.evidencePresented),
      senderRequiredAttestation: p.declared ? p.requireAttestation : null,
      root: verdict ? verdict.root : null,
      deviceId: verdict ? verdict.deviceId : null,
      measurement: verdict ? verdict.measurement : null,
      policyEpoch: verdict ? verdict.policyEpoch : null,
      signerSetId: verdict ? verdict.signerSetId : null,
      chainVerified: verdict ? verdict.chainVerified : null,
      capabilitySubject: d.subject === undefined ? null : d.subject,
      capabilityIdentitySource: d.identitySource === undefined ? null : d.identitySource,
      decision: d.code === undefined ? null : d.code,
      admitted: d.admit === true,
      unmet: Array.isArray(d.unmet) ? d.unmet.map(function (u) { return u.rule; }) : [],
      summary: ''
    };

    receipt.summary = summarise(receipt);
    return receipt;
  }

  function summarise(r) {
    var head;
    if (r.attestation === STATE_ATTESTED) {
      head = 'Attested: the device presented ' + (ROOT_LABELS[r.root] || 'evidence') +
        ' measuring ' + String(r.measurement).slice(0, 16) + '…, and it verified';
    } else if (r.attestation === STATE_UNATTESTED) {
      head = r.senderRequiredAttestation === false
        ? 'Nobody asked: this sender does not require attestation and none was offered'
        : 'Unattested: no evidence was offered';
    } else if (r.attestation === null) {
      head = 'No attestation verdict was recorded';
    } else {
      head = 'Attestation ' + r.attestation + ': evidence was offered and did not stand';
    }
    var tail = r.admitted
      ? 'the transfer proceeded (' + r.decision + ')'
      : 'the transfer was refused (' + r.decision + ')';
    return head + '; ' + tail + '.';
  }

  // ---------------------------------------------------------------------------
  // Honesty
  // ---------------------------------------------------------------------------

  /**
   * The four roots of trust ADR-021 §2.1 names, and what this build has
   * actually done with each of them: nothing.
   *
   * ADR-021 §4.4 requires each to be exercised on real hardware "or the ones
   * that are not are removed from this document". All four are unexercised, so
   * this function exists to say so from inside the running system rather than
   * only in a report nobody re-reads.
   */
  function describeRoots() {
    return ROOTS.map(function (id) {
      return {
        id: id,
        label: ROOT_LABELS[id],
        status: 'unexercised',
        note: 'This build recognises ' + JSON.stringify(id) + ' as a value in the evidence format ' +
          'and implements none of the protocol behind it. No ' + ROOT_LABELS[id] +
          ' has ever been produced or checked by this repository, on hardware or otherwise.'
      };
    });
  }

  /**
   * Where rvQR's signing key lives, in one place, so the UI cannot claim
   * otherwise. ADR-021 §2.4 moves it into a platform key store and ADR-035 §4.8
   * says that ADR is superseded when it does. It has not.
   */
  function describeKeyCustody() {
    return {
      store: 'localStorage',
      key: 'rvqr.identity.v1',
      privateKeyReadableByPageScript: true,
      hardwareBacked: false,
      demonstrated: false,
      adr035Superseded: false,
      note: 'The signing key is still generated in page script and written to localStorage in ' +
        'plaintext hex, exactly as ADR-035 §2.4 describes. Nothing here has signed anything with a ' +
        'key held outside the page, so ADR-035 is not superseded and the identity is still a ' +
        'demonstration of the mechanism rather than a key management system.'
    };
  }

  /**
   * Whether an environment even exposes WebAuthn. PRESENCE, never a
   * demonstration: a constructor existing is not a key that signed anything,
   * and this function is deliberately wired into no decision anywhere.
   *
   * The environment is passed in rather than reached for, so this is testable
   * and so a page that throws on the lookup degrades to "unknown" instead of
   * crashing a boot path.
   */
  function hardwareKeyAvailability(env) {
    var out = {
      webAuthnPresent: false,
      credentialsApiPresent: false,
      exercised: false,
      note: ''
    };
    try {
      var g = env || (typeof globalThis !== 'undefined' ? globalThis : null);
      if (g) {
        out.webAuthnPresent = typeof g.PublicKeyCredential !== 'undefined';
        out.credentialsApiPresent = !!(g.navigator && g.navigator.credentials);
      }
    } catch (e) {
      out.webAuthnPresent = false;
      out.credentialsApiPresent = false;
    }
    out.note = out.webAuthnPresent
      ? 'This environment exposes WebAuthn. That is an API being present, not a key having signed ' +
        'anything: no hardware-backed signature has been produced or verified here, and nothing ' +
        'reads this result.'
      : 'This environment exposes no WebAuthn, so the hardware-key path of ADR-021 §2.4 is not ' +
        'available at all here.';
    return out;
  }

  /**
   * What this module is not entitled to claim, kept here so the wording in the
   * UI cannot drift from what the code does.
   */
  function describeLimits() {
    return [
      'Attestation is evidence, never authorization. verifyAttestation returns a verdict and admitTransfer decides; the capability policy is authoritative and every admission passes through it.',
      'None of the four roots of trust — DICE, TPM 2.0, Secure Enclave, Android hardware-backed keys — is exercised. This build implements the evidence format and recognises their names; it implements no root of trust and has run against no hardware.',
      'Chain verification is injected and absent by default, so on this platform the attested state is unreachable. A check that cannot run reports unverified and never degrades into a pass.',
      'The signing key has not moved out of localStorage. The hardware-key path is undemonstrated and ADR-035 is not superseded.',
      'Attestation is a strong claim about boot and a weak claim about now. A device correctly attested at boot can be compromised afterwards, and this evidence does not expire on its own.',
      'Attestation evidence identifies a device, often durably. A protocol that avoids associating devices on a network now has a mechanism that identifies them cryptographically, and that is a trade a user should see before it is enabled.',
      'A policy requiring an approved RVM measurement refuses devices with legitimate modifications, and that failure reads to their owner as a bricked device.',
      'Binding is checked here as a field comparison. In a real root of trust the nonce is inside the signed quote, so binding and chain verification are one check — and that is the unexercised part.',
      'A grant matched against a peer id rests on ADR-035’s pinned key, which still lives in localStorage, and is a weaker binding than one matched against an attested device id. The receipt records which of the two was used rather than leaving them to look alike.',
      'Nothing here checks that an attested device id and the pinned peer id describe the same party. A peer that signs the session and a device that attests to its boot could be two things, and detecting that is not a rule ADR-021 states.'
    ];
  }

  return {
    // roots of trust — names in a format, not implementations
    ROOT_DICE: ROOT_DICE,
    ROOT_TPM2: ROOT_TPM2,
    ROOT_SECURE_ENCLAVE: ROOT_SECURE_ENCLAVE,
    ROOT_ANDROID_KEY: ROOT_ANDROID_KEY,
    ROOTS: ROOTS,
    ROOT_LABELS: ROOT_LABELS,

    // the verdict vocabulary
    STATE_ATTESTED: STATE_ATTESTED,
    STATE_UNATTESTED: STATE_UNATTESTED,
    STATE_MALFORMED: STATE_MALFORMED,
    STATE_UNBOUND: STATE_UNBOUND,
    STATE_REPLAYED: STATE_REPLAYED,
    STATE_UNVERIFIED: STATE_UNVERIFIED,
    STATE_FORGED: STATE_FORGED,
    STATES: STATES,

    // decision codes
    CODE_PENDING: CODE_PENDING,
    CODE_POLICY_UNDECLARED: CODE_POLICY_UNDECLARED,
    CODE_UNKNOWN_STATE: CODE_UNKNOWN_STATE,
    CODE_UNATTESTED_REFUSED: CODE_UNATTESTED_REFUSED,
    CODE_MALFORMED: CODE_MALFORMED,
    CODE_UNBOUND: CODE_UNBOUND,
    CODE_REPLAYED: CODE_REPLAYED,
    CODE_UNVERIFIED: CODE_UNVERIFIED,
    CODE_FORGED: CODE_FORGED,
    CODE_UNTRUSTED_SIGNERS: CODE_UNTRUSTED_SIGNERS,
    CODE_STALE_EPOCH: CODE_STALE_EPOCH,
    CODE_UNAPPROVED_MEASUREMENT: CODE_UNAPPROVED_MEASUREMENT,
    CODE_STORAGE_REFUSED: CODE_STORAGE_REFUSED,
    CODE_CAPABILITY_REFUSED: CODE_CAPABILITY_REFUSED,
    CODE_ATTESTED_AND_APPROVED: CODE_ATTESTED_AND_APPROVED,
    CODE_UNATTESTED_PERMITTED: CODE_UNATTESTED_PERMITTED,

    // the four preconditions, and the authoritative fifth check
    RULE_SIGNERS: RULE_SIGNERS,
    RULE_EPOCH: RULE_EPOCH,
    RULE_MEASUREMENT: RULE_MEASUREMENT,
    RULE_STORAGE: RULE_STORAGE,
    RULE_CAPABILITY: RULE_CAPABILITY,

    ARTIFACT_CLASSES: ARTIFACT_CLASSES,
    LIMITS: LIMITS,

    // the pipeline, in the order it runs
    parseEvidence: parseEvidence,
    verifyAttestation: verifyAttestation,
    normalizePolicy: normalizePolicy,
    attestationGate: attestationGate,
    unmetPreconditions: unmetPreconditions,
    capabilitySubject: capabilitySubject,
    capabilityDecision: capabilityDecision,
    admitTransfer: admitTransfer,
    attestationReceipt: attestationReceipt,

    // honesty
    describeRoots: describeRoots,
    describeKeyCustody: describeKeyCustody,
    hardwareKeyAvailability: hardwareKeyAvailability,
    describeLimits: describeLimits
  };
});
