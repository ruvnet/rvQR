/*!
 * rvQR device attestation test suite — standalone.
 *
 * Node:    `node artifacts/attest.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after attest.js, then call RVQRAttestTests.runAll(RVQRAttest).
 *
 * Nothing here reads a clock, a file, a network or a piece of hardware. The
 * session id, the challenge and the consumed-nonce list are all passed in, so a
 * verdict reached twice from the same evidence is asserted to be the same
 * verdict.
 *
 * Three groups carry most of the weight.
 *
 * The SEPARATION group proves ADR-021 §2.2 structurally rather than by
 * observation. It shows the verifier has no policy in its argument list and
 * therefore cannot decide; that a verdict carries no field a caller could read
 * as permission; that the measured facts exist on the object only when the
 * state is `attested`, so a device's raw claims cannot reach a policy
 * comparison through any ordering mistake; and that every admission — including
 * the unattested one — passes through the capability check.
 *
 * The FAIL-CLOSED group walks the whole verdict vocabulary and then one state
 * that does not exist, mirroring ADR-035 §4.1.
 *
 * The HONESTY group asserts the things this build is NOT entitled to claim:
 * that no root of trust is exercised, that `attested` is unreachable without an
 * injected verifier this repository does not have, and that the signing key has
 * not left localStorage so ADR-035 is not superseded.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var attest = require('./attest.js');
      var results = api.runAll(attest);
      results.forEach(function (r) {
        console.log(
          (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : '')
        );
      });
      var summary = api.summarize(results);
      console.log(
        '\n' + summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed'
      );
      if (typeof process !== 'undefined') process.exit(summary.failed ? 1 : 0);
    }
  } else {
    root.RVQRAttestTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A plausible RVM measurement and the fleet it belongs to. Values, not
  // secrets: nothing here is a key and nothing here was produced by hardware.
  var MEASURE_APPROVED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  var MEASURE_OTHER = '00112233445566778899aabbccddeeff';
  var DEVICE = 'seed-0042';
  var PEER = 'peer-key-9f3c';
  var SESSION = 'sess-7c1a';
  var NONCE = 'chal-2b8e';

  function runAll(A) {
    var results = [];

    function test(name, fn) {
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || '' });
      } catch (err) {
        results.push({ name: name, ok: false, detail: err && err.message ? err.message : String(err) });
      }
    }

    function assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }

    function eq(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
      }
    }

    function merge(base, extra) {
      if (extra === undefined) return base;
      if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra;
      var out = {};
      Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }

    /** Well-formed evidence from a device running the approved measurement. */
    function evidence(over) {
      return merge({
        root: A.ROOT_DICE,
        deviceId: DEVICE,
        sessionId: SESSION,
        nonce: NONCE,
        measurement: MEASURE_APPROVED,
        policyEpoch: 12,
        signerSetId: 'fleet-signers-v3',
        storageClasses: ['credential', 'agent'],
        chain: [{ layer: 0 }, { layer: 1 }, { layer: 2 }]
      }, over);
    }

    /** The sender's side of the binding for this transfer. */
    function expected(over) {
      return merge({ sessionId: SESSION, nonce: NONCE, consumedNonces: [] }, over);
    }

    /**
     * A sender policy that is satisfied by the evidence above and grants the
     * device credentials. Every field is stated: absence is refusal here, so a
     * "default" policy would prove nothing.
     */
    function policy(over) {
      return merge({
        requireAttestation: true,
        trustedSignerSets: ['fleet-signers-v3'],
        minPolicyEpoch: 12,
        approvedMeasurements: [MEASURE_APPROVED],
        grants: [{ device: DEVICE, classes: ['credential', 'agent'] }]
      }, over);
    }

    function request(over) {
      return merge({ artifactClass: 'credential', peerId: PEER, name: 'fleet.cred' }, over);
    }

    /** A root of trust this repository does not have, standing in for one. */
    function chainOk() { return true; }
    function chainNo() { return false; }

    /** The whole pipeline in one call, the way a caller would run it. */
    function run(over) {
      var o = over || {};
      var verdict = A.verifyAttestation(
        o.evidence === undefined ? evidence() : o.evidence,
        o.expected === undefined ? expected() : o.expected,
        o.opts === undefined ? { verifyChain: chainOk } : o.opts
      );
      var decision = A.admitTransfer(
        o.policy === undefined ? policy() : o.policy,
        verdict,
        o.request === undefined ? request() : o.request
      );
      return {
        verdict: verdict,
        decision: decision,
        receipt: A.attestationReceipt(verdict, decision, o.policy === undefined ? policy() : o.policy)
      };
    }

    // --- The evidence format -------------------------------------------------

    test('evidence: a well-formed blob reads back as the facts it carries', function () {
      var p = A.parseEvidence(evidence());
      assert(p.ok, 'well-formed evidence should parse: ' + p.reason);
      eq(p.evidence.root, A.ROOT_DICE, 'root');
      eq(p.evidence.deviceId, DEVICE, 'device id');
      eq(p.evidence.measurement, MEASURE_APPROVED, 'measurement');
      eq(p.evidence.policyEpoch, 12, 'policy epoch');
      eq(p.evidence.signerSetId, 'fleet-signers-v3', 'signer set');
      eq(p.evidence.storageClasses.join(','), 'agent,credential', 'storage classes, sorted');
      eq(p.evidence.chainLayers, 3, 'the chain is counted, not interpreted');
      eq(p.evidence.chain, undefined, 'the raw chain must not be carried through');
      return 'the format is read; none of the protocol behind it is';
    });

    test('evidence: storage classes are a set, so declaration order cannot change them', function () {
      var a = A.parseEvidence(evidence({ storageClasses: ['agent', 'credential'] }));
      var b = A.parseEvidence(evidence({ storageClasses: ['credential', 'agent', 'credential'] }));
      eq(a.evidence.storageClasses.join(','), b.evidence.storageClasses.join(','),
        'two orderings of the same permissions should read identically');
      eq(b.evidence.storageClasses.length, 2, 'the duplicate is dropped');
      return 'agent,credential either way round';
    });

    test('evidence: an unknown root of trust is refused rather than carried', function () {
      var p = A.parseEvidence(evidence({ root: 'quantum-notary' }));
      eq(p.ok, false, 'a root nobody defined must not parse');
      assert(/root of trust/.test(p.reason), 'the reason should name the field: ' + p.reason);
      A.ROOTS.forEach(function (r) {
        assert(A.parseEvidence(evidence({ root: r })).ok, r + ' should be a readable format value');
      });
      return A.ROOTS.length + ' root names recognised, everything else refused';
    });

    test('evidence: a storage class that does not exist yet fails closed', function () {
      // The same rule as an unrecognised verdict state, one layer down: a class
      // nobody has defined must not be carried as an opaque string that later
      // compares equal to a grant.
      var p = A.parseEvidence(evidence({ storageClasses: ['credential', 'neural-weights-2099'] }));
      eq(p.ok, false, 'a future artifact class must not parse');
      assert(/storage class/.test(p.reason), 'the reason should name it: ' + p.reason);
      return 'an unknown class is refused where it is read';
    });

    test('evidence: hostile fields are bounded, and none of them throws', function () {
      var hostile = [
        ['null', null],
        ['a string', 'not evidence'],
        ['an array', []],
        ['no device id', evidence({ deviceId: '' })],
        ['a device id past the ceiling', evidence({ deviceId: new Array(400).join('a') })],
        ['a device id with a path separator', evidence({ deviceId: '../../etc/passwd' })],
        ['a non-hex measurement', evidence({ measurement: 'zzzz' })],
        ['an odd-length measurement', evidence({ measurement: 'abc' })],
        ['a measurement past the ceiling', evidence({ measurement: new Array(600).join('ab') })],
        ['a negative epoch', evidence({ policyEpoch: -1 })],
        ['a fractional epoch', evidence({ policyEpoch: 1.5 })],
        ['an enormous epoch', evidence({ policyEpoch: 1e12 })],
        ['storage classes that are not an array', evidence({ storageClasses: 'credential' })],
        ['too many storage classes', evidence({ storageClasses: new Array(40).fill('agent') })],
        ['a chain of 9999 layers', evidence({ chain: new Array(9999).fill({}) })],
        ['a chain that is not an array', evidence({ chain: 7 })],
        ['a missing nonce', evidence({ nonce: undefined })],
        ['a missing session id', evidence({ sessionId: null })]
      ];
      hostile.forEach(function (row) {
        var p = A.parseEvidence(row[1]);
        eq(p.ok, false, row[0] + ' should be refused');
        assert(typeof p.reason === 'string' && p.reason.length > 5,
          row[0] + ' should be refused with a reason');
      });
      return hostile.length + ' hostile inputs refused, none of them by throwing';
    });

    // --- The verdict is not a decision ---------------------------------------

    test('separation: a verdict carries no field a caller could read as permission', function () {
      var forbidden = ['admit', 'allow', 'allowed', 'authorized', 'authorised', 'ok', 'pass',
        'permitted', 'trusted', 'approved', 'granted'];
      var states = [];
      [
        run({}),
        run({ evidence: null }),
        run({ evidence: { root: 'nope' } }),
        run({ expected: expected({ sessionId: 'sess-other' }) }),
        run({ expected: expected({ consumedNonces: [NONCE] }) }),
        run({ opts: {} }),
        run({ opts: { verifyChain: chainNo } })
      ].forEach(function (r) {
        states.push(r.verdict.state);
        forbidden.forEach(function (key) {
          eq(r.verdict[key], undefined, 'a verdict must not carry "' + key + '": ' + r.verdict.state);
        });
        Object.keys(r.verdict).forEach(function (key) {
          if (key === 'evidencePresented') return; // a fact about what arrived
          assert(typeof r.verdict[key] !== 'boolean' || key === 'chainVerified',
            'unexpected boolean "' + key + '" on a verdict — verdicts state facts, not outcomes');
        });
      });
      eq(states.length, 7, 'seven verdicts inspected');
      return states.join(', ');
    });

    test('separation: the verifier is never handed a policy, so it cannot decide', function () {
      // Two policies that could not differ more: one grants everything, one
      // grants nothing. Neither reaches the verifier through any argument.
      var open = policy();
      var closed = policy({ trustedSignerSets: [], approvedMeasurements: [], grants: [] });
      var base = A.verifyAttestation(evidence(), expected(), { verifyChain: chainOk });
      var withOpen = A.verifyAttestation(evidence(), merge(expected(), open), { verifyChain: chainOk, policy: open });
      var withClosed = A.verifyAttestation(evidence(), merge(expected(), closed), { verifyChain: chainOk, policy: closed });
      eq(withOpen.state, base.state, 'a permissive policy smuggled in must change nothing');
      eq(withClosed.state, base.state, 'nor a refusing one');
      eq(JSON.stringify(withOpen), JSON.stringify(base), 'the whole verdict is unchanged');
      eq(JSON.stringify(withClosed), JSON.stringify(base), 'the whole verdict is unchanged');
      // And the same evidence, verified once, is admitted under one policy and
      // refused under the other — so the decision lives entirely in the gate.
      var v = base;
      eq(A.admitTransfer(open, v, request()).admit, true, 'the open policy admits');
      eq(A.admitTransfer(closed, v, request()).admit, false, 'the closed policy refuses the same verdict');
      return 'one verdict, two opposite decisions';
    });

    test('separation: the measured facts exist only on an attested verdict', function () {
      // The evidence below carries an APPROVED measurement and a TRUSTED signer
      // set. If a non-attested verdict published them, a gate that checked the
      // preconditions before the state would let forged bytes through.
      var facts = ['root', 'deviceId', 'measurement', 'policyEpoch', 'signerSetId', 'storageClasses', 'chainLayers'];
      var cases = [
        ['unattested', A.verifyAttestation(null, expected(), { verifyChain: chainOk })],
        ['malformed', A.verifyAttestation(evidence({ measurement: 'zz' }), expected(), { verifyChain: chainOk })],
        ['unbound', A.verifyAttestation(evidence(), expected({ nonce: 'chal-other' }), { verifyChain: chainOk })],
        ['replayed', A.verifyAttestation(evidence(), expected({ consumedNonces: [NONCE] }), { verifyChain: chainOk })],
        ['unverified', A.verifyAttestation(evidence(), expected(), {})],
        ['forged', A.verifyAttestation(evidence(), expected(), { verifyChain: chainNo })]
      ];
      cases.forEach(function (row) {
        eq(row[1].state, row[0], 'state');
        facts.forEach(function (f) {
          eq(row[1][f], null, row[0] + ' must publish no ' + f);
        });
      });
      var attested = A.verifyAttestation(evidence(), expected(), { verifyChain: chainOk });
      eq(attested.state, A.STATE_ATTESTED, 'and the attested one does publish them');
      facts.forEach(function (f) {
        assert(attested[f] !== null, 'attested should publish ' + f);
      });
      return cases.length + ' non-attested verdicts, none of them carrying a measurement';
    });

    test('separation: a hand-built verdict claiming attested cannot smuggle facts past the gate', function () {
      // The gate is never handed evidence, only a verdict. A caller forging a
      // verdict object is already inside the trust boundary — but even then the
      // capability check is unreachable without passing the preconditions, and
      // an attested state with no facts fails all of them.
      var hollow = { state: A.STATE_ATTESTED };
      var d = A.admitTransfer(policy(), hollow, request());
      eq(d.admit, false, 'an attested state with no facts must not admit');
      eq(d.code, A.CODE_UNTRUSTED_SIGNERS, 'and it fails the first precondition it reaches');
      assert(d.unmet.length >= 4, 'with the rest of the unmet rules reported: ' + d.unmet.length);

      // The epoch rule specifically. `undefined < 12` is false in JavaScript,
      // so a rule written as a bare comparison would be SATISFIED by a verdict
      // carrying no epoch — the one place where the natural expression fails
      // open rather than closed.
      var noEpoch = {
        state: A.STATE_ATTESTED, signerSetId: 'fleet-signers-v3',
        measurement: MEASURE_APPROVED, storageClasses: ['credential'], deviceId: DEVICE
      };
      var unmet = A.unmetPreconditions(A.normalizePolicy(policy()), noEpoch);
      eq(unmet.length, 1, 'exactly the epoch rule should be unmet: ' + JSON.stringify(unmet));
      eq(unmet[0].rule, A.RULE_EPOCH, 'a missing epoch is not a current one');
      eq(A.admitTransfer(policy(), noEpoch, request()).code, A.CODE_STALE_EPOCH, 'and the gate refuses it');
      return d.unmet.map(function (u) { return u.rule; }).join(', ');
    });

    // --- ADR-021 §4.1: the verdict is separate from the decision --------------

    test('criterion 1: a valid attestation for a device the policy refuses does not transfer', function () {
      // Everything about this device is right. It is attested by a root of
      // trust, its signer set is trusted, its epoch is current, its RVM
      // measurement is approved, and its storage policy admits credentials.
      // The capability policy does not name it, and that settles it.
      var refusing = policy({ grants: [{ device: 'some-other-seed', classes: ['credential'] }] });
      var r = run({ policy: refusing });

      eq(r.verdict.state, A.STATE_ATTESTED, 'the attestation itself is valid');
      eq(r.verdict.measurement, MEASURE_APPROVED, 'and it measures what the policy approves');
      eq(A.unmetPreconditions(A.normalizePolicy(refusing), r.verdict).length, 0,
        'all four ADR-021 §2.1 preconditions are met');

      eq(r.decision.admit, false, 'and the transfer still does not proceed');
      eq(r.decision.code, A.CODE_CAPABILITY_REFUSED, 'refused on capability');
      eq(r.decision.unmet[0].rule, A.RULE_CAPABILITY, 'naming the rule');
      assert(/wrong device/.test(r.decision.reason),
        'the reason should say what happened: ' + r.decision.reason);

      // The same verdict, with the grant restored, does transfer — so the test
      // is about the capability policy and not about some other refusal.
      eq(A.admitTransfer(policy(), r.verdict, request()).admit, true,
        'granting the device admits the identical verdict');
      return 'attested, approved, current, and refused';
    });

    test('criterion 1: every admission passes through the capability check, unattested too', function () {
      var open = { requireAttestation: false, trustedSignerSets: ['fleet-signers-v3'], minPolicyEpoch: 12, approvedMeasurements: [MEASURE_APPROVED] };

      // No grants at all: nothing may be admitted on any path.
      var noGrants = merge(open, { grants: [] });
      eq(run({ policy: noGrants, evidence: null }).decision.code, A.CODE_CAPABILITY_REFUSED,
        'unattested must not bypass the grant table');
      eq(run({ policy: noGrants }).decision.code, A.CODE_CAPABILITY_REFUSED,
        'nor may attested');

      // A grant to the peer, which is the identity an unattested device has.
      var peerGrant = merge(open, { grants: [{ device: PEER, classes: ['credential'] }] });
      var un = run({ policy: peerGrant, evidence: null });
      eq(un.decision.admit, true, 'an unattested device with a grant may be sent to');
      eq(un.decision.code, A.CODE_UNATTESTED_PERMITTED, 'and it is recorded as that, not as approval');
      eq(un.decision.identitySource, 'peer', 'matched on the weaker identity, and it says so');

      // The attested device is not matched against the peer name it did not
      // attest to, so the same grant does not cover it.
      var at = run({ policy: peerGrant });
      eq(at.decision.admit, false, 'an attested device is matched on its attested id');
      eq(at.decision.subject, DEVICE, 'which is the id the evidence carried');
      return 'no path reaches admit without the capability check';
    });

    test('criterion 1: the gate reaches exactly one admit, and only after capability', function () {
      // Walked as a property rather than asserted about the source: over the
      // whole cross product of verdict states, policies and requests, an
      // admission implies the capability decision allowed it.
      var policies = [policy(), policy({ requireAttestation: false }),
        policy({ grants: [] }), policy({ grants: [{ device: PEER, classes: ['credential'] }] })];
      var requests = [request(), request({ peerId: null }), request({ artifactClass: 'model' }), request({ artifactClass: null })];
      var verdicts = A.STATES.map(function (state) {
        if (state === A.STATE_ATTESTED) return A.verifyAttestation(evidence(), expected(), { verifyChain: chainOk });
        if (state === A.STATE_UNATTESTED) return A.verifyAttestation(null, expected(), { verifyChain: chainOk });
        if (state === A.STATE_MALFORMED) return A.verifyAttestation({ root: 'x' }, expected(), { verifyChain: chainOk });
        if (state === A.STATE_UNBOUND) return A.verifyAttestation(evidence(), expected({ sessionId: 'other' }), { verifyChain: chainOk });
        if (state === A.STATE_REPLAYED) return A.verifyAttestation(evidence(), expected({ consumedNonces: [NONCE] }), { verifyChain: chainOk });
        if (state === A.STATE_UNVERIFIED) return A.verifyAttestation(evidence(), expected(), {});
        return A.verifyAttestation(evidence(), expected(), { verifyChain: chainNo });
      });

      var admits = 0, checked = 0;
      policies.forEach(function (p) {
        requests.forEach(function (req) {
          verdicts.forEach(function (v) {
            var d = A.admitTransfer(p, v, req);
            checked++;
            if (!d.admit) return;
            admits++;
            var cap = A.capabilityDecision(A.normalizePolicy(p), v, { artifactClass: req.artifactClass, peerId: req.peerId, name: null });
            eq(cap.allow, true, 'admitted without the capability check allowing it: ' + v.state + ' / ' + d.code);
            assert(d.code === A.CODE_ATTESTED_AND_APPROVED || d.code === A.CODE_UNATTESTED_PERMITTED,
              'an admission carries one of the two admitting codes, not ' + d.code);
          });
        });
      });
      assert(admits > 0, 'this sweep should admit something, or it proves nothing');
      return checked + ' decisions, ' + admits + ' admissions, every one through capability';
    });

    // --- ADR-021 §4.2: unrecognised states fail closed -----------------------

    test('criterion 2: a state that does not exist yet is refused, not interpreted', function () {
      var futures = ['attested-v2', 'remotely-attested', 'ATTESTED', 'attested ', '', 0, null, undefined, {}];
      futures.forEach(function (s) {
        var d = A.admitTransfer(policy(), { state: s }, request());
        eq(d.admit, false, JSON.stringify(s) + ' must not admit');
        assert(d.code === A.CODE_UNKNOWN_STATE || d.code === A.CODE_PENDING,
          JSON.stringify(s) + ' should be unknown or pending, got ' + d.code);
      });
      var explicit = A.admitTransfer(policy(), { state: 'attested-v2' }, request());
      eq(explicit.code, A.CODE_UNKNOWN_STATE, 'a named future state is unknown, not pending');
      assert(/Unrecognised/.test(explicit.reason), 'and it says so: ' + explicit.reason);
      return futures.length + ' states nobody has defined, all refused';
    });

    test('criterion 2: the whole verdict vocabulary has a stated outcome, and no other', function () {
      var expectedCodes = {};
      expectedCodes[A.STATE_ATTESTED] = A.CODE_ATTESTED_AND_APPROVED;
      expectedCodes[A.STATE_UNATTESTED] = A.CODE_UNATTESTED_REFUSED;
      expectedCodes[A.STATE_MALFORMED] = A.CODE_MALFORMED;
      expectedCodes[A.STATE_UNBOUND] = A.CODE_UNBOUND;
      expectedCodes[A.STATE_REPLAYED] = A.CODE_REPLAYED;
      expectedCodes[A.STATE_UNVERIFIED] = A.CODE_UNVERIFIED;
      expectedCodes[A.STATE_FORGED] = A.CODE_FORGED;
      eq(A.STATES.length, 7, 'the vocabulary is seven states');
      A.STATES.forEach(function (state) {
        var gate = A.attestationGate(A.normalizePolicy(policy()), state);
        if (state === A.STATE_ATTESTED) {
          eq(gate.pass, true, 'attested clears the evidence bar');
        } else {
          eq(gate.pass, false, state + ' should not clear the evidence bar under a requiring policy');
          eq(gate.code, expectedCodes[state], state + ' code');
        }
      });
      var relaxed = A.attestationGate(A.normalizePolicy(policy({ requireAttestation: false })), A.STATE_UNATTESTED);
      eq(relaxed.pass, true, 'a sender that does not require attestation clears unattested');
      return '7 states, each with a stated outcome, plus a default that refuses';
    });

    test('criterion 2: a verdict that has not landed never admits', function () {
      // The same race ADR-035 §2.1 closes one layer up: the check resolves
      // asynchronously, so the absence of a verdict must refuse rather than
      // being read as the absence of a problem.
      [null, undefined, {}, { reason: 'still working' }].forEach(function (v) {
        var d = A.admitTransfer(policy(), v, request());
        eq(d.admit, false, 'a pending check must not admit');
        eq(d.code, A.CODE_PENDING, 'and it is pending, not unattested');
      });
      return 'pending never admits, and is never mistaken for unattested';
    });

    // --- ADR-021 §2.3: unattested is a state, not a failure ------------------

    test('criterion 3: no evidence is unattested, and unattested is not an error', function () {
      var v = A.verifyAttestation(null, expected(), { verifyChain: chainOk });
      eq(v.state, A.STATE_UNATTESTED, 'no evidence is unattested');
      eq(v.evidencePresented, false, 'and nothing was presented');
      assert(!/error|invalid|fail/i.test(v.reason), 'the reason must not read as a failure: ' + v.reason);
      assert(/policy/.test(v.reason), 'and should say whose decision it is: ' + v.reason);

      // Unreadable evidence is a different state. A device that tried and
      // failed is not a device that never tried.
      var m = A.verifyAttestation({ root: 'dice' }, expected(), { verifyChain: chainOk });
      eq(m.state, A.STATE_MALFORMED, 'broken evidence is malformed');
      eq(m.evidencePresented, true, 'and something was presented');
      return 'absent and unreadable are two states, not one';
    });

    test('criterion 3: whether unattested is acceptable has no default at all', function () {
      var undeclared = { trustedSignerSets: ['fleet-signers-v3'], minPolicyEpoch: 12, approvedMeasurements: [MEASURE_APPROVED], grants: [{ device: PEER, classes: ['credential'] }] };
      var v = A.verifyAttestation(null, expected(), { verifyChain: chainOk });
      var d = A.admitTransfer(undeclared, v, request());
      eq(d.admit, false, 'an undeclared policy must not admit');
      eq(d.code, A.CODE_POLICY_UNDECLARED, 'and it says the decision was never made');
      assert(/no default/.test(d.reason), 'the reason should say so outright: ' + d.reason);

      eq(A.admitTransfer(merge(undeclared, { requireAttestation: true }), v, request()).code,
        A.CODE_UNATTESTED_REFUSED, 'a sender that requires attestation refuses');
      eq(A.admitTransfer(merge(undeclared, { requireAttestation: false }), v, request()).admit,
        true, 'a sender that does not, proceeds');
      // Also true when the policy has stated it and everything else is absent.
      eq(A.normalizePolicy({}).declared, false, 'an empty policy has declared nothing');
      eq(A.normalizePolicy({ requireAttestation: false }).declared, true, 'saying no is still saying');
      return 'the sender decides, and a sender that has not decided is refused';
    });

    test('criterion 3: the receipt never conflates attested-and-approved with nobody-asked', function () {
      var approved = run({}).receipt;
      var nobodyAsked = run({
        evidence: null,
        policy: policy({ requireAttestation: false, grants: [{ device: PEER, classes: ['credential'] }] })
      }).receipt;

      eq(approved.admitted, true, 'both transfers proceeded');
      eq(nobodyAsked.admitted, true, 'both transfers proceeded');

      // And yet an auditor can tell them apart on three named fields.
      eq(approved.attestation, A.STATE_ATTESTED, 'one is attested');
      eq(nobodyAsked.attestation, A.STATE_UNATTESTED, 'the other is not');
      eq(approved.evidencePresented, true, 'one presented evidence');
      eq(nobodyAsked.evidencePresented, false, 'the other presented none');
      eq(approved.senderRequiredAttestation, true, 'one sender asked');
      eq(nobodyAsked.senderRequiredAttestation, false, 'the other did not');
      eq(approved.decision, A.CODE_ATTESTED_AND_APPROVED, 'and the codes differ');
      eq(nobodyAsked.decision, A.CODE_UNATTESTED_PERMITTED, 'and the codes differ');
      assert(/Nobody asked/.test(nobodyAsked.summary), 'the summary should say it plainly: ' + nobodyAsked.summary);
      assert(/Attested/.test(approved.summary), 'and so should the other: ' + approved.summary);
      assert(approved.summary !== nobodyAsked.summary, 'two different outcomes must not read the same');
      eq(nobodyAsked.measurement, null, 'nothing was measured, so nothing is recorded as measured');
      eq(nobodyAsked.root, null, 'and no root of trust is named');
      return 'admitted alone says nothing, which is why it is never recorded alone';
    });

    test('criterion 3: a receipt reports the refusal it got, and which rules were unmet', function () {
      var r = run({ policy: policy({ minPolicyEpoch: 99, approvedMeasurements: [MEASURE_OTHER] }) });
      eq(r.decision.admit, false, 'this device is behind and mismeasured');
      eq(r.receipt.admitted, false, 'the receipt says so');
      eq(r.receipt.attestation, A.STATE_ATTESTED, 'while still recording that it did attest');
      assert(r.receipt.unmet.indexOf(A.RULE_EPOCH) >= 0, 'the stale epoch is named: ' + r.receipt.unmet);
      assert(r.receipt.unmet.indexOf(A.RULE_MEASUREMENT) >= 0, 'and the measurement: ' + r.receipt.unmet);
      assert(/refused/.test(r.receipt.summary), 'the summary should say refused: ' + r.receipt.summary);
      return r.receipt.unmet.join(', ');
    });

    // --- ADR-021 §4.5: replay is refused -------------------------------------

    test('criterion 5: a recorded attestation replayed into a new session is refused', function () {
      // The recording: perfectly genuine evidence, captured off a completed
      // transfer. It verifies — that is the point — and it is still refused.
      var recorded = evidence();
      var freshSession = expected({ sessionId: 'sess-9f20', nonce: 'chal-5d71' });

      var v = A.verifyAttestation(recorded, freshSession, { verifyChain: chainOk });
      eq(v.state, A.STATE_UNBOUND, 'a recording is not bound to the new transfer');
      eq(v.binding.sessionMatched, false, 'the session id is the old one');
      eq(v.binding.nonceMatched, false, 'and so is the challenge');
      eq(v.measurement, null, 'and it publishes no measurement to be checked against');

      var d = A.admitTransfer(policy(), v, request());
      eq(d.admit, false, 'so the transfer does not proceed');
      eq(d.code, A.CODE_UNBOUND, 'refused on the binding');

      // The identical bytes against the session they were made for still work,
      // so this is a test of the binding and not of something else being wrong.
      eq(A.verifyAttestation(recorded, expected(), { verifyChain: chainOk }).state, A.STATE_ATTESTED,
        'the same evidence in its own session is fine');
      return 'the same bytes: attested in their session, unbound in the next';
    });

    test('criterion 5: half a binding is no binding', function () {
      var sessionOnly = A.verifyAttestation(evidence(), expected({ nonce: 'chal-other' }), { verifyChain: chainOk });
      eq(sessionOnly.state, A.STATE_UNBOUND, 'right session, wrong challenge');
      eq(sessionOnly.binding.sessionMatched, true, 'the session did match');
      eq(sessionOnly.binding.nonceMatched, false, 'the challenge did not');
      assert(/challenge/.test(sessionOnly.reason), 'and the reason names it: ' + sessionOnly.reason);

      var nonceOnly = A.verifyAttestation(evidence(), expected({ sessionId: 'sess-other' }), { verifyChain: chainOk });
      eq(nonceOnly.state, A.STATE_UNBOUND, 'right challenge, wrong session');
      eq(nonceOnly.binding.nonceMatched, true, 'the challenge did match');
      assert(/session/.test(nonceOnly.reason), 'and the reason names it: ' + nonceOnly.reason);

      var neither = A.verifyAttestation(evidence(), { sessionId: null, nonce: null }, { verifyChain: chainOk });
      eq(neither.state, A.STATE_UNBOUND, 'a sender that issued nothing binds nothing');
      return 'both halves are required, and each is reported on its own';
    });

    test('criterion 5: a challenge already consumed is refused a second time', function () {
      var first = A.verifyAttestation(evidence(), expected(), { verifyChain: chainOk });
      eq(first.state, A.STATE_ATTESTED, 'the first presentation stands');

      var second = A.verifyAttestation(evidence(), expected({ consumedNonces: [NONCE] }), { verifyChain: chainOk });
      eq(second.state, A.STATE_REPLAYED, 'the second is a replay inside the same session');
      eq(second.binding.sessionMatched, true, 'bound to the right session');
      eq(second.binding.nonceMatched, true, 'and echoing the right challenge');
      eq(second.binding.consumed, true, 'which is exactly the problem');
      eq(A.admitTransfer(policy(), second, request()).code, A.CODE_REPLAYED, 'and the gate refuses it');

      var unrelated = A.verifyAttestation(evidence(), expected({ consumedNonces: ['chal-aaaa', 'chal-bbbb'] }), { verifyChain: chainOk });
      eq(unrelated.state, A.STATE_ATTESTED, 'other spent challenges are not this one');
      return 'a challenge is answered once';
    });

    // --- ADR-021 §2.1: the four sender preconditions -------------------------

    test('preconditions: each of ADR-021 §2.1’s four is enforced and named', function () {
      var cases = [
        [A.RULE_SIGNERS, A.CODE_UNTRUSTED_SIGNERS, policy({ trustedSignerSets: ['some-other-fleet'] })],
        [A.RULE_EPOCH, A.CODE_STALE_EPOCH, policy({ minPolicyEpoch: 13 })],
        [A.RULE_MEASUREMENT, A.CODE_UNAPPROVED_MEASUREMENT, policy({ approvedMeasurements: [MEASURE_OTHER] })],
        [A.RULE_STORAGE, A.CODE_STORAGE_REFUSED, policy({ grants: [{ device: DEVICE, classes: ['model'] }] })]
      ];
      var lines = [];
      cases.forEach(function (row) {
        var req = row[0] === A.RULE_STORAGE ? request({ artifactClass: 'model' }) : request();
        var r = run({ policy: row[2], request: req });
        eq(r.verdict.state, A.STATE_ATTESTED, 'the device attests in every one of these');
        eq(r.decision.admit, false, row[0] + ' should refuse');
        eq(r.decision.code, row[1], row[0] + ' code');
        eq(r.decision.unmet[0].rule, row[0], row[0] + ' rule');
        assert(r.decision.reason.length > 20, row[0] + ' needs a reason for a person');
        lines.push(row[0]);
      });
      return lines.join(', ') + ' — all four enforced';
    });

    test('preconditions: the policy epoch is current at or ahead of the sender’s, stale below', function () {
      eq(run({ policy: policy({ minPolicyEpoch: 12 }) }).decision.admit, true, 'level is current');
      eq(run({ policy: policy({ minPolicyEpoch: 11 }) }).decision.admit, true, 'ahead is current');
      eq(run({ policy: policy({ minPolicyEpoch: 13 }) }).decision.code, A.CODE_STALE_EPOCH, 'behind is stale');
      var unstated = policy({ minPolicyEpoch: undefined });
      eq(run({ policy: unstated }).decision.code, A.CODE_STALE_EPOCH,
        'a sender with no stated epoch cannot find one current');
      assert(/has not stated/.test(run({ policy: unstated }).decision.reason),
        'and the reason should say that is the sender’s gap, not the receiver’s');
      return 'current means at least as new, and an unstated epoch refuses';
    });

    test('preconditions: several unmet are all reported, not just the first', function () {
      var bad = policy({ trustedSignerSets: ['nope'], minPolicyEpoch: 99, approvedMeasurements: [MEASURE_OTHER] });
      var r = run({ policy: bad, request: request({ artifactClass: 'model' }) });
      var rules = r.decision.unmet.map(function (u) { return u.rule; });
      eq(rules.length, 4, 'all four should be reported: ' + rules.join(','));
      [A.RULE_SIGNERS, A.RULE_EPOCH, A.RULE_MEASUREMENT, A.RULE_STORAGE].forEach(function (rule) {
        assert(rules.indexOf(rule) >= 0, rule + ' is missing from ' + rules.join(','));
      });
      eq(r.decision.code, 'untrusted-signers', 'the headline is the first unmet rule');
      r.decision.unmet.forEach(function (u) {
        assert(u.rule && u.reason && u.reason.length > 10, 'each unmet rule needs a reason');
      });
      return rules.join(', ');
    });

    test('preconditions: every policy field defaults to refusing', function () {
      var empty = { requireAttestation: true };
      var v = A.verifyAttestation(evidence(), expected(), { verifyChain: chainOk });
      var d = A.admitTransfer(empty, v, request());
      eq(d.admit, false, 'a policy that states only its attestation bar grants nothing');
      var rules = d.unmet.map(function (u) { return u.rule; });
      [A.RULE_SIGNERS, A.RULE_EPOCH, A.RULE_MEASUREMENT].forEach(function (rule) {
        assert(rules.indexOf(rule) >= 0, rule + ' should be unmet by silence: ' + rules.join(','));
      });
      var p = A.normalizePolicy({});
      eq(p.trustedSignerSets.length, 0, 'no signer sets');
      eq(p.approvedMeasurements.length, 0, 'no approved measurements');
      eq(p.minPolicyEpoch, null, 'no epoch');
      eq(p.grants.length, 0, 'no grants');
      // And junk in a policy is dropped rather than accepted.
      var junk = A.normalizePolicy({
        trustedSignerSets: [null, 42, 'ok-set'],
        approvedMeasurements: ['zzz', MEASURE_APPROVED],
        grants: [null, { device: '' }, { device: DEVICE, classes: ['agent', 'invented'] }]
      });
      eq(junk.trustedSignerSets.join(','), 'ok-set', 'only identifiers survive');
      eq(junk.approvedMeasurements.join(','), MEASURE_APPROVED, 'only hex survives');
      eq(junk.grants.length, 1, 'only well-formed grants survive');
      eq(junk.grants[0].classes.join(','), 'agent', 'and an invented class is not granted');
      return 'silence grants nothing, and malformed policy grants nothing either';
    });

    // --- The chain verifier is injected, and absent ---------------------------

    test('verifier: with no chain verifier nothing is ever attested', function () {
      [{}, undefined, { verifyChain: null }, { verifyChain: 'yes' }].forEach(function (opts) {
        var v = A.verifyAttestation(evidence(), expected(), opts);
        eq(v.state, A.STATE_UNVERIFIED, 'no verifier means unverified');
        eq(v.chainVerified, null, 'and nothing was established');
        assert(/four roots of trust/.test(v.reason), 'and it says why: ' + v.reason);
        eq(A.admitTransfer(policy(), v, request()).code, A.CODE_UNVERIFIED, 'which the gate refuses');
      });
      return 'attested is unreachable on this platform, and that is the honest state';
    });

    test('verifier: a chain verifier that throws yields unverified, never a pass and never unattested', function () {
      // ADR-035 §2.2: a catch that maps an error onto a security feature's
      // disabled state is a defect. The error maps onto a REFUSING state here.
      var boom = { verifyChain: function () { throw new Error('TPM unreachable'); } };
      var v = A.verifyAttestation(evidence(), expected(), boom);
      eq(v.state, A.STATE_UNVERIFIED, 'a broken verifier is not a passing one');
      assert(v.state !== A.STATE_UNATTESTED, 'nor is it the absence of evidence');
      assert(v.state !== A.STATE_ATTESTED, 'and certainly not a pass');
      assert(/TPM unreachable/.test(v.reason), 'the failure is surfaced, not swallowed: ' + v.reason);
      eq(A.admitTransfer(policy(), v, request()).admit, false, 'and the transfer does not proceed');

      // Anything that is not exactly true or false establishes nothing.
      [null, undefined, 1, 'true', {}].forEach(function (answer) {
        var w = A.verifyAttestation(evidence(), expected(), { verifyChain: function () { return answer; } });
        eq(w.state, A.STATE_UNVERIFIED, JSON.stringify(answer) + ' is not a verdict');
      });
      return 'an error is a check that did not happen, not a feature that is off';
    });

    test('verifier: a chain verifier that says no yields forged, and forged never admits', function () {
      var v = A.verifyAttestation(evidence(), expected(), { verifyChain: chainNo });
      eq(v.state, A.STATE_FORGED, 'a rejected chain is forged');
      eq(v.chainVerified, false, 'and the answer is recorded');
      eq(v.measurement, null, 'while publishing nothing the policy could match');
      [policy(), policy({ requireAttestation: false })].forEach(function (p) {
        eq(A.admitTransfer(p, v, request()).code, A.CODE_FORGED,
          'forged is refused whether or not the sender requires attestation');
      });
      return 'a device that presents evidence it cannot back is not an unattested device';
    });

    test('verifier: the chain verifier sees the parsed evidence and no more', function () {
      var seen = null;
      A.verifyAttestation(evidence(), expected(), {
        verifyChain: function (e) { seen = e; return true; }
      });
      assert(seen, 'the verifier should be called');
      eq(seen.deviceId, DEVICE, 'with the device id');
      eq(seen.chainLayers, 3, 'and the layer count');
      eq(seen.chain, undefined, 'the raw chain array is not handed on');
      // The verifier is not called at all when the binding has already failed,
      // so a recording cannot be used to make a root of trust do work.
      var called = 0;
      A.verifyAttestation(evidence(), expected({ sessionId: 'other' }), {
        verifyChain: function () { called++; return true; }
      });
      eq(called, 0, 'an unbound recording must not reach the root of trust at all');
      return 'binding is checked before anything expensive runs';
    });

    // --- Honesty: ADR-021 §4.4 and §4.6 --------------------------------------

    test('honesty: all four roots of trust are reported unexercised', function () {
      var roots = A.describeRoots();
      eq(roots.length, 4, 'ADR-021 §2.1 names four');
      var ids = roots.map(function (r) { return r.id; }).sort().join(',');
      eq(ids, 'android-key,dice,secure-enclave,tpm2', 'DICE, TPM 2.0, Secure Enclave, Android keys');
      roots.forEach(function (r) {
        eq(r.status, 'unexercised', r.id + ' must not claim to be exercised');
        assert(r.label && r.label.length > 5, r.id + ' has no readable label');
        assert(/produced or checked by this repository/.test(r.note), r.id + ' note: ' + r.note);
        assert(/implements none of the protocol/.test(r.note), r.id + ' note: ' + r.note);
      });
      assert(!roots.some(function (r) { return r.status === 'supported' || r.status === 'verified'; }),
        'nothing here may claim support for a root of trust');
      return '4 roots named, 0 exercised';
    });

    test('honesty: the signing key has not left localStorage, and ADR-035 is not superseded', function () {
      var custody = A.describeKeyCustody();
      eq(custody.store, 'localStorage', 'the key is where ADR-035 §2.4 left it');
      eq(custody.hardwareBacked, false, 'no hardware holds it');
      eq(custody.privateKeyReadableByPageScript, true, 'and page script can still read it');
      eq(custody.demonstrated, false, 'the hardware-key path is undemonstrated');
      eq(custody.adr035Superseded, false, 'so ADR-035 stands');
      assert(/not superseded/.test(custody.note), 'and it says so: ' + custody.note);
      return 'ADR-021 §4.6 is unmet, and the code says which part';
    });

    test('honesty: WebAuthn detection reports presence and never a demonstration', function () {
      var absent = A.hardwareKeyAvailability({});
      eq(absent.webAuthnPresent, false, 'an environment with no WebAuthn');
      eq(absent.exercised, false, 'and nothing exercised');

      var present = A.hardwareKeyAvailability({
        PublicKeyCredential: function () {},
        navigator: { credentials: {} }
      });
      eq(present.webAuthnPresent, true, 'an environment that exposes it');
      eq(present.credentialsApiPresent, true, 'and the credentials API');
      eq(present.exercised, false, 'and still nothing exercised');
      assert(/not a key having signed/.test(present.note), 'the note must not overclaim: ' + present.note);

      // An environment that throws on the lookup degrades rather than crashes.
      var hostile = {};
      Object.defineProperty(hostile, 'PublicKeyCredential', {
        get: function () { throw new Error('blocked'); }
      });
      eq(A.hardwareKeyAvailability(hostile).webAuthnPresent, false, 'a throwing lookup reads as absent');
      return 'an API being present is not a key having signed anything';
    });

    test('honesty: the stated limits name every claim this cannot make', function () {
      var limits = A.describeLimits();
      assert(Array.isArray(limits) && limits.length >= 8, 'expected at least eight caveats');
      var joined = limits.join(' ').toLowerCase();
      assert(joined.indexOf('evidence, never authorization') >= 0, 'does not state ADR-021 §2.2');
      assert(joined.indexOf('no root of trust') >= 0 || joined.indexOf('is exercised') >= 0,
        'does not disclaim the roots of trust');
      assert(joined.indexOf('dice') >= 0 && joined.indexOf('tpm 2.0') >= 0 &&
        joined.indexOf('secure enclave') >= 0 && joined.indexOf('android') >= 0,
        'does not name all four roots');
      assert(joined.indexOf('localstorage') >= 0, 'does not disclaim the key custody');
      assert(joined.indexOf('not superseded') >= 0, 'does not say ADR-035 still stands');
      assert(joined.indexOf('weak claim about now') >= 0, 'does not disclaim boot-time evidence');
      assert(joined.indexOf('identifies a device') >= 0, 'does not state the privacy trade');
      assert(joined.indexOf('bricked device') >= 0, 'does not state the lock-out cost');
      return limits.length + ' caveats';
    });

    test('totality: junk in every argument position refuses, and never throws', function () {
      // ADR-035 §2.1 makes admitArtifact pure and total so the rule has no
      // untested branch. The same claim is made here, and this is the cheapest
      // way to hold it up: sweep the cross product and assert that nothing
      // throws, nothing admits and nothing reaches attested.
      var junk = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'a', {}, [], [1, 2], true, false,
        { state: A.STATE_ATTESTED },
        { state: A.STATE_ATTESTED, measurement: {}, policyEpoch: '12', signerSetId: [], storageClasses: 'x', deviceId: {} },
        function () {}];
      var checked = 0;
      junk.forEach(function (p) {
        junk.forEach(function (v) {
          junk.forEach(function (r) {
            checked++;
            var d = A.admitTransfer(p, v, r);
            eq(typeof d.admit, 'boolean', 'a decision always has a boolean admit');
            eq(typeof d.code, 'string', 'and a stable code');
            eq(d.admit, false, 'junk must never admit: ' + d.code);
            var w = A.verifyAttestation(p, v, r);
            eq(typeof w.state, 'string', 'a verdict always has a state');
            assert(w.state !== A.STATE_ATTESTED, 'junk must never reach attested');
            A.attestationReceipt(p, v, r);
          });
        });
      });
      return checked + ' argument triples over three functions, none of them throwing or admitting';
    });

    // --- Purity --------------------------------------------------------------

    test('purity: verifying and admitting mutate nothing they were given', function () {
      var ev = evidence();
      var exp = expected();
      var pol = policy();
      var req = request();
      var before = JSON.stringify([ev, exp, pol, req]);
      var v = A.verifyAttestation(ev, exp, { verifyChain: chainOk });
      A.admitTransfer(pol, v, req);
      A.attestationReceipt(v, A.admitTransfer(pol, v, req), pol);
      eq(JSON.stringify([ev, exp, pol, req]), before, 'a caller’s objects came back changed');
      return 'evidence, expectation, policy and request are all read, never written';
    });

    test('purity: the same evidence gives the same verdict and the same decision', function () {
      var a = run({});
      var b = run({});
      eq(JSON.stringify(a.verdict), JSON.stringify(b.verdict), 'the verdict moved');
      eq(JSON.stringify(a.decision), JSON.stringify(b.decision), 'the decision moved');
      eq(a.receipt.summary, b.receipt.summary, 'the receipt moved');
      // Nothing here reads a clock: there is no timestamp anywhere in a verdict.
      Object.keys(a.verdict).forEach(function (k) {
        assert(!/time|date|now|at$/i.test(k), 'a verdict should carry no clock reading: ' + k);
      });
      return 'deterministic: the session id, the challenge and the spent list are all passed in';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
