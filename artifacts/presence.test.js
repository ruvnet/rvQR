/*!
 * rvQR physical presence fusion test suite — standalone.
 *
 * Node:    `node artifacts/presence.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after presence.js, then call RVQRPresenceTests.runAll(RVQRPresence).
 *
 * Nothing here reads a clock, a file, a network, a camera, a microphone or a
 * radio. The session id, the per-channel challenges, the spent lists and the
 * readers are all passed in, so a verdict reached twice from the same report is
 * asserted to be the same verdict.
 *
 * **Every reader in this file is a simulation.** There is no optical presence
 * reader, no ultrasonic modem and no ranging stack in this repository, and no
 * browser exposes a UWB API at all. A test that supplies `function () { return
 * true; }` for a channel is supplying the answer that hardware would otherwise
 * have to earn, and it is testing the FUSION RULE rather than the channel. That
 * is the whole of what this suite can honestly claim.
 *
 * Four groups carry most of the weight.
 *
 * The NO-SINGLE-CHANNEL group is ADR-023 §2.2. Three tests supply a perfect
 * signal on one channel and nothing on the other two, one test walks every
 * combination of per-channel outcomes and asserts corroboration is exactly the
 * distinct-pair relation, and one shows the property that matters: a single
 * perfect channel never flips an admission that the empty report would not have
 * got anyway.
 *
 * The REPLAY group refuses a recording on each of the three channels, refuses a
 * recording moved between channels, and refuses a spent list too long to search.
 *
 * The DISTINCTION group holds `available`, `attempted` and `passed` apart, in
 * the verdict, in the transcript and in the receipt.
 *
 * The HONESTY group asserts what this build is NOT entitled to claim: that no
 * channel is implemented, that `corroborated` is unreachable without an injected
 * simulation, that no relay has been measured, and that acceptance criteria 4
 * and 6 are unmet.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var presence = require('./presence.js');
      var results = api.runAll(presence);
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
    root.RVQRPresenceTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSION = 'sess-7c1a';
  var PEER = 'peer-key-9f3c';

  // One challenge PER CHANNEL, which is why a recording captured off one
  // channel cannot be presented as another.
  var CHALLENGE = {
    optical: 'chal-opt-2b8e',
    acoustic: 'chal-aco-5d71',
    ranging: 'chal-rng-9f20'
  };

  function runAll(P) {
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

    function eq(actual, expectedValue, msg) {
      if (actual !== expectedValue) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expectedValue);
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

    /** A well-formed signal on one channel, for this session. */
    function sig(channel, over) {
      return merge({ channel: channel, sessionId: SESSION, challenge: CHALLENGE[channel] }, over);
    }

    /** A pair with all three channels, all of them exercised. */
    function report(over) {
      return merge({
        available: P.CHANNELS.slice(),
        signals: { optical: sig('optical'), acoustic: sig('acoustic'), ranging: sig('ranging') }
      }, over);
    }

    /**
     * A pair that has ONE channel and attempts it perfectly, and nothing at all
     * on the other two. This is ADR-023 §4.1's shape.
     */
    function onlyChannel(channel) {
      var signals = {};
      signals[channel] = sig(channel);
      return { available: [channel], signals: signals };
    }

    /** A pair that has exactly these channels and attempts all of them. */
    function withChannels(list) {
      var signals = {};
      list.forEach(function (c) { signals[c] = sig(c); });
      return { available: list.slice(), signals: signals };
    }

    /** The sender's side of the binding for this activation. */
    function expected(over) {
      return merge({
        sessionId: SESSION,
        challenges: {
          optical: CHALLENGE.optical, acoustic: CHALLENGE.acoustic, ranging: CHALLENGE.ranging
        },
        spent: { optical: [], acoustic: [], ranging: [] }
      }, over);
    }

    /**
     * Readers this repository does not have. Every one of these is a
     * simulation: no channel is implemented, so a caller supplying a reader is
     * supplying the answer hardware would otherwise have to earn.
     */
    function yes() { return true; }
    function no() { return false; }

    function readers(over) {
      return merge({ optical: yes, acoustic: yes, ranging: yes }, over);
    }

    function opts(over) {
      return { readers: over === undefined ? readers() : over };
    }

    /** A sender policy satisfied by the report above. Every field is stated. */
    function policy(over) {
      return merge({
        requirePresence: true,
        requiredChannels: [],
        grants: [{ device: PEER, classes: ['credential', 'agent'] }]
      }, over);
    }

    function request(over) {
      return merge({ artifactClass: 'credential', peerId: PEER, name: 'fleet.cred' }, over);
    }

    /** The whole pipeline in one call, the way a caller would run it. */
    function run(over) {
      var o = over || {};
      var verdict = P.verifyPresence(
        o.report === undefined ? report() : o.report,
        o.expected === undefined ? expected() : o.expected,
        o.opts === undefined ? opts() : o.opts
      );
      var pol = o.policy === undefined ? policy() : o.policy;
      var decision = P.admitActivation(pol, verdict, o.request === undefined ? request() : o.request);
      return {
        verdict: verdict,
        decision: decision,
        transcript: P.presenceTranscript(verdict),
        receipt: P.presenceReceipt(verdict, decision, pol)
      };
    }

    /** One verdict per fused state, built the way a caller would reach it. */
    function verdictOf(state) {
      if (state === P.STATE_CORROBORATED) {
        return P.verifyPresence(withChannels(['optical', 'acoustic']), expected(), opts());
      }
      if (state === P.STATE_UNCORROBORATED) {
        return P.verifyPresence(onlyChannel('optical'), expected(), opts());
      }
      if (state === P.STATE_ABSENT) {
        return P.verifyPresence(null, expected(), opts());
      }
      if (state === P.STATE_MALFORMED) {
        return P.verifyPresence(report({
          signals: { optical: sig('optical', { challenge: undefined }), acoustic: sig('acoustic') }
        }), expected(), opts());
      }
      if (state === P.STATE_UNBOUND) {
        return P.verifyPresence(report({
          signals: { optical: sig('optical', { sessionId: 'sess-other' }), acoustic: sig('acoustic') }
        }), expected(), opts());
      }
      if (state === P.STATE_REPLAYED) {
        return P.verifyPresence(report(), expected({
          spent: { optical: [CHALLENGE.optical], acoustic: [], ranging: [] }
        }), opts());
      }
      return P.verifyPresence(report(), expected(), opts(readers({ optical: no })));
    }

    // --- The report format ---------------------------------------------------

    test('report: a well-formed report reads back the three channels it carries', function () {
      var p = P.parseReport(report());
      assert(p.ok, 'a well-formed report should parse: ' + p.reason);
      eq(p.report.available.join(','), 'acoustic,optical,ranging', 'available, sorted');
      eq(Object.keys(p.report.signals).sort().join(','), 'acoustic,optical,ranging', 'signals');
      var s = P.parseSignal('optical', sig('optical'));
      assert(s.ok, 'a well-formed signal should parse: ' + s.reason);
      eq(s.signal.channel, 'optical', 'channel');
      eq(s.signal.sessionId, SESSION, 'session id');
      eq(s.signal.challenge, CHALLENGE.optical, 'the challenge issued for this channel');
      return 'three channels named, and no protocol behind any of them';
    });

    test('report: a channel nobody defined is refused where it is read', function () {
      var invented = P.parseReport({ available: ['optical', 'lidar'], signals: {} });
      eq(invented.ok, false, 'a channel nobody defined must not parse');
      assert(/lidar/.test(invented.reason), 'the reason should name it: ' + invented.reason);

      var offered = P.parseReport({ available: [], signals: { lidar: { channel: 'lidar' } } });
      eq(offered.ok, false, 'nor as a signal key');

      P.CHANNELS.forEach(function (c) {
        assert(P.parseReport(withChannels([c])).ok, c + ' should be a readable channel name');
      });
      eq(P.CHANNELS.length, 3, 'ADR-023 §1 names three');
      return P.CHANNELS.join(', ') + ' recognised, everything else refused';
    });

    test('report: availability is a set, so declaration order cannot change it', function () {
      var a = P.parseReport({ available: ['ranging', 'optical'], signals: {} });
      var b = P.parseReport({ available: ['optical', 'ranging', 'optical'], signals: {} });
      eq(a.report.available.join(','), b.report.available.join(','), 'two orderings should read identically');
      eq(b.report.available.length, 2, 'the duplicate is dropped');
      return 'optical,ranging either way round';
    });

    test('report: hostile fields are bounded, and none of them throws', function () {
      var hostile = [
        ['a string', 'not a report'],
        ['an array', []],
        ['available as a string', { available: 'optical' }],
        ['too many declared channels', { available: new Array(40).fill('optical') }],
        ['signals as an array', { available: [], signals: [] }],
        ['too many signal keys', { available: [], signals: (function () {
          var s = {}; for (var i = 0; i < 40; i++) s['ch' + i] = {}; return s;
        })() }]
      ];
      hostile.forEach(function (row) {
        var p = P.parseReport(row[1]);
        eq(p.ok, false, row[0] + ' should be refused');
        assert(typeof p.reason === 'string' && p.reason.length > 5, row[0] + ' needs a reason');
      });

      var badSignals = [
        ['null', null],
        ['a string', 'beep'],
        ['an array', []],
        ['no channel', sig('optical', { channel: undefined })],
        ['an invented channel', sig('optical', { channel: 'lidar' })],
        ['no session id', sig('optical', { sessionId: '' })],
        ['a session id past the ceiling', sig('optical', { sessionId: new Array(200).join('a') })],
        ['a session id with a path separator', sig('optical', { sessionId: '../../etc/passwd' })],
        ['no challenge', sig('optical', { challenge: null })],
        ['a challenge past the ceiling', sig('optical', { challenge: new Array(400).join('a') })]
      ];
      badSignals.forEach(function (row) {
        var s = P.parseSignal('optical', row[1]);
        eq(s.ok, false, row[0] + ' should be refused');
        assert(typeof s.reason === 'string' && s.reason.length > 5, row[0] + ' needs a reason');
      });
      return (hostile.length + badSignals.length) + ' hostile inputs refused, none of them by throwing';
    });

    // --- ADR-023 §2.2: no single channel may authorize alone ------------------

    test('criterion 1: a perfect optical signal alone authorizes nothing', function () {
      // Line-of-sight, read by a reader that says yes, bound to this session and
      // this channel's challenge. Alone it says a screen was seen, and
      // substitution is exactly that.
      var r = run({ report: onlyChannel('optical') });
      eq(r.verdict.channels[0].passed, true, 'the optical channel did pass');
      eq(r.verdict.state, P.STATE_UNCORROBORATED, 'and one channel corroborates nothing');
      eq(r.verdict.pairs.length, 0, 'no pair formed');
      eq(r.decision.admit, false, 'so nothing is authorized');
      eq(r.decision.code, P.CODE_UNCORROBORATED_REFUSED, 'refused for want of corroboration');
      assert(/attacker can arrange/.test(r.verdict.reason), 'the reason says why: ' + r.verdict.reason);
      return 'optical alone: passed, and authorized nothing';
    });

    test('criterion 1: a perfect acoustic signal alone authorizes nothing', function () {
      // Something acoustically present answered a fresh challenge. A speaker in
      // the room answers.
      var r = run({ report: onlyChannel('acoustic') });
      eq(r.transcript.channels[1].passed, true, 'the acoustic channel did pass');
      eq(r.verdict.state, P.STATE_UNCORROBORATED, 'and one channel corroborates nothing');
      eq(r.decision.admit, false, 'so nothing is authorized');
      eq(r.decision.code, P.CODE_UNCORROBORATED_REFUSED, 'refused for want of corroboration');
      assert(/speaker in the room/.test(r.verdict.reason), 'the reason says why: ' + r.verdict.reason);
      return 'acoustic alone: passed, and authorized nothing';
    });

    test('criterion 1: a perfect ranging signal alone authorizes nothing', function () {
      // A device at a measured distance. It is not necessarily the device on
      // the screen.
      var r = run({ report: onlyChannel('ranging') });
      eq(r.transcript.channels[2].passed, true, 'the ranging channel did pass');
      eq(r.verdict.state, P.STATE_UNCORROBORATED, 'and one channel corroborates nothing');
      eq(r.decision.admit, false, 'so nothing is authorized');
      eq(r.decision.code, P.CODE_UNCORROBORATED_REFUSED, 'refused for want of corroboration');
      assert(/not the device on the screen/.test(r.verdict.reason), 'the reason says why: ' + r.verdict.reason);
      return 'ranging alone: passed, and authorized nothing';
    });

    test('criterion 1: a single perfect channel never flips a decision the empty report would not get', function () {
      // The strongest form of "no channel authorizes alone", and the one that
      // survives a policy that does not require presence at all: adding one
      // perfect channel to a session must never turn a refusal into an
      // admission. If it never changes `admit`, it never authorized anything.
      var policies = [
        policy(), policy({ requirePresence: false }), policy({ grants: [] }),
        policy({ requiredChannels: ['optical'] }), policy({ requiredChannels: ['optical', 'acoustic'] }),
        { grants: [{ device: PEER, classes: ['credential'] }] }
      ];
      var requests = [request(), request({ peerId: null }), request({ artifactClass: 'model' }),
        request({ artifactClass: null })];
      var absent = P.verifyPresence(null, expected(), opts());
      var singles = P.CHANNELS.map(function (c) {
        return P.verifyPresence(onlyChannel(c), expected(), opts());
      });

      var checked = 0, admits = 0;
      policies.forEach(function (p) {
        requests.forEach(function (req) {
          var base = P.admitActivation(p, absent, req);
          singles.forEach(function (v, i) {
            var one = P.admitActivation(p, v, req);
            checked++;
            eq(one.admit, base.admit,
              P.CHANNELS[i] + ' alone changed the decision under ' + JSON.stringify(p.requirePresence));
            if (one.admit) {
              admits++;
              eq(one.code, P.CODE_PRESENCE_NOT_REQUIRED,
                'an admission alongside one channel must never be a presence-based one');
            }
          });
        });
      });
      assert(admits > 0, 'this sweep should admit something, or it proves nothing');
      return checked + ' comparisons, ' + admits + ' admissions, none of them attributable to one channel';
    });

    test('criterion 1: corroboration is a pair relation over distinct channels, not a count', function () {
      // There is no threshold in this module to tune down to one. The rule is a
      // fixed list of unordered pairs of DISTINCT channels, and a self-pair is
      // not a value the list can hold.
      eq(P.CORROBORATING_PAIRS.length, 3, 'three channels give three pairs, n(n-1)/2');
      P.CORROBORATING_PAIRS.forEach(function (pair) {
        eq(pair.length, 2, 'a pair is two channels');
        assert(pair[0] !== pair[1], 'a channel may not corroborate itself: ' + pair.join(','));
        assert(P.CHANNELS.indexOf(pair[0]) >= 0 && P.CHANNELS.indexOf(pair[1]) >= 0, 'both are channels');
      });
      var seen = {};
      P.CORROBORATING_PAIRS.forEach(function (pair) { seen[pair.slice().sort().join('+')] = true; });
      eq(Object.keys(seen).length, 3, 'and the three are distinct');

      // Walked over every combination of per-channel outcomes: corroboration
      // holds exactly when two DIFFERENT channels passed, and never otherwise.
      var combos = 0;
      P.OUTCOMES.forEach(function (a) {
        P.OUTCOMES.forEach(function (b) {
          P.OUTCOMES.forEach(function (c) {
            var records = [a, b, c].map(function (outcome, i) {
              return { channel: P.CHANNELS[i], outcome: outcome, passed: outcome === P.OUTCOME_PASSED };
            });
            var passedCount = records.filter(function (r) { return r.passed; }).length;
            var pairs = P.passingPairs(records);
            combos++;
            eq(pairs.length > 0, passedCount >= 2,
              [a, b, c].join('/') + ' gave ' + pairs.length + ' pairs on ' + passedCount + ' passing');
          });
        });
      });
      eq(combos, 343, 'every combination of seven outcomes over three channels');
      return '3 distinct pairs, ' + combos + ' outcome combinations, no threshold anywhere';
    });

    test('criterion 1: the policy has no threshold to set, and an invented one is dropped', function () {
      // A count could be tuned to 1 by a policy. There is no count, and a
      // policy that tries to add one does not get a field to put it in.
      var p = P.normalizePolicy({
        requirePresence: true, minChannels: 1, threshold: 1, quorum: 1,
        minCorroboratingPairs: 0, requiredChannels: ['optical']
      });
      var keys = Object.keys(p).sort();
      eq(keys.join(','), 'declared,grants,requirePresence,requiredChannels', 'the policy has four fields');
      keys.forEach(function (k) {
        assert(typeof p[k] !== 'number', 'a policy field must not be a number: ' + k + '=' + p[k]);
        assert(!/min|max|threshold|quorum|count/i.test(k), 'a policy field must not read as a knob: ' + k);
      });
      // And two channels still corroborate while one still does not, whatever
      // the policy tried to say.
      eq(P.verifyPresence(withChannels(['optical', 'ranging']), expected(), opts()).state,
        P.STATE_CORROBORATED, 'two channels corroborate');
      eq(P.verifyPresence(onlyChannel('optical'), expected(), opts()).state,
        P.STATE_UNCORROBORATED, 'one does not, and no policy can change that');
      return 'four policy fields, none of them a number';
    });

    // --- Evidence, not authorization -----------------------------------------

    test('separation: a verdict carries no field a caller could read as permission', function () {
      var forbidden = ['admit', 'allow', 'allowed', 'authorized', 'authorised', 'ok', 'pass',
        'permitted', 'trusted', 'approved', 'granted', 'present', 'proven', 'verified'];
      var states = [];
      P.STATES.forEach(function (state) {
        var v = verdictOf(state);
        states.push(v.state);
        eq(v.state, state, 'the helper should reach ' + state);
        forbidden.forEach(function (key) {
          eq(v[key], undefined, 'a verdict must not carry "' + key + '": ' + v.state);
        });
        Object.keys(v).forEach(function (key) {
          if (key === 'reportPresented') return; // a fact about what arrived
          assert(typeof v[key] !== 'boolean',
            'unexpected boolean "' + key + '" on a verdict — verdicts state facts, not outcomes');
        });
      });
      eq(states.length, 7, 'seven verdicts inspected');
      return states.join(', ');
    });

    test('separation: the verifier is never handed a policy, so it cannot decide', function () {
      var open = policy();
      var closed = policy({ grants: [] });
      var base = P.verifyPresence(report(), expected(), opts());
      var withOpen = P.verifyPresence(report(), merge(expected(), open), merge(opts(), { policy: open }));
      var withClosed = P.verifyPresence(report(), merge(expected(), closed), merge(opts(), { policy: closed }));
      eq(JSON.stringify(withOpen), JSON.stringify(base), 'a permissive policy smuggled in changes nothing');
      eq(JSON.stringify(withClosed), JSON.stringify(base), 'nor a refusing one');
      // And the same verdict is admitted under one policy and refused under the
      // other, so the decision lives entirely in the gate.
      eq(P.admitActivation(open, base, request()).admit, true, 'the open policy admits');
      eq(P.admitActivation(closed, base, request()).admit, false, 'the closed policy refuses the same verdict');
      return 'one verdict, two opposite decisions';
    });

    test('separation: a hand-built verdict claiming corroborated carries no corroboration', function () {
      // The gate reads the pair list the verifier published rather than
      // recomputing it, so the state string alone is not enough.
      var hollow = { state: P.STATE_CORROBORATED };
      var d = P.admitActivation(policy(), hollow, request());
      eq(d.admit, false, 'a corroborated state with no pairs must not admit');
      eq(d.code, P.CODE_MISSING_CORROBORATION, 'and it fails on corroboration');
      eq(d.unmet[0].rule, P.RULE_CORROBORATION, 'naming the rule');

      // A forged pair list is checked against the channel records too, so a
      // caller cannot invent a pair for channels that did not pass.
      var invented = {
        state: P.STATE_CORROBORATED,
        pairs: [['optical', 'acoustic']],
        channels: [{ channel: 'optical', passed: false }, { channel: 'acoustic', passed: false }]
      };
      eq(P.admitActivation(policy(), invented, request()).code, P.CODE_MISSING_CORROBORATION,
        'a pair naming channels that did not pass is no pair');

      var selfPair = {
        state: P.STATE_CORROBORATED,
        pairs: [['optical', 'optical']],
        channels: [{ channel: 'optical', passed: true }]
      };
      eq(P.admitActivation(policy(), selfPair, request()).code, P.CODE_MISSING_CORROBORATION,
        'and a channel may not corroborate itself even in a hand-built verdict');
      return 'the state string is not the claim; the pairs are';
    });

    test('separation: every admission passes through the capability check', function () {
      var noGrants = policy({ grants: [] });
      eq(run({ policy: noGrants, report: withChannels(['optical', 'acoustic']) }).decision.code,
        P.CODE_CAPABILITY_REFUSED, 'corroborated must not bypass the grant table');
      eq(run({ policy: merge(noGrants, { requirePresence: false }), report: null }).decision.code,
        P.CODE_CAPABILITY_REFUSED, 'nor may the path where presence was not required');

      var granted = run({ report: withChannels(['optical', 'acoustic']) });
      eq(granted.decision.admit, true, 'a granted peer with two corroborating channels may be activated');
      eq(granted.decision.code, P.CODE_CORROBORATED_AND_APPROVED, 'and it is recorded as that');
      eq(granted.decision.subject, PEER, 'matched on the pinned peer, which is the only identity there is');

      // Presence establishes no identity, so no grant can be matched against
      // anything the report claimed.
      var anonymous = run({ report: withChannels(['optical', 'acoustic']), request: request({ peerId: null }) });
      eq(anonymous.decision.admit, false, 'a corroborated room with no identity activates nothing');
      assert(/never who it is/.test(anonymous.decision.reason), 'and it says so: ' + anonymous.decision.reason);
      return 'no path reaches admit without the capability check';
    });

    test('separation: the gate reaches exactly one admit, and only after capability', function () {
      var policies = [policy(), policy({ requirePresence: false }), policy({ grants: [] }),
        policy({ requiredChannels: ['ranging'] })];
      var requests = [request(), request({ peerId: null }), request({ artifactClass: 'model' }),
        request({ artifactClass: null })];
      var verdicts = P.STATES.map(verdictOf);

      var admits = 0, checked = 0;
      policies.forEach(function (p) {
        requests.forEach(function (req) {
          verdicts.forEach(function (v) {
            var d = P.admitActivation(p, v, req);
            checked++;
            if (!d.admit) return;
            admits++;
            var cap = P.capabilityDecision(P.normalizePolicy(p),
              { artifactClass: req.artifactClass, peerId: req.peerId, name: null });
            eq(cap.allow, true, 'admitted without the capability check allowing it: ' + v.state + ' / ' + d.code);
            assert(d.code === P.CODE_CORROBORATED_AND_APPROVED || d.code === P.CODE_PRESENCE_NOT_REQUIRED,
              'an admission carries one of the two admitting codes, not ' + d.code);
          });
        });
      });
      assert(admits > 0, 'this sweep should admit something, or it proves nothing');
      return checked + ' decisions, ' + admits + ' admissions, every one through capability';
    });

    // --- ADR-023 §2.1 and §4.2: replay is refused on every channel ------------

    test('criterion 2: a photographed QR replayed into a new session is refused', function () {
      var recorded = onlyChannel('optical');
      var fresh = expected({
        sessionId: 'sess-9f20',
        challenges: { optical: 'chal-opt-new', acoustic: 'chal-aco-new', ranging: 'chal-rng-new' }
      });
      var v = P.verifyPresence(recorded, fresh, opts());
      eq(v.state, P.STATE_UNBOUND, 'a recording is not bound to the new activation');
      eq(v.channels[0].binding.sessionMatched, false, 'the session id is the old one');
      eq(v.channels[0].binding.challengeMatched, false, 'and so is the challenge');
      eq(P.admitActivation(policy(), v, request()).code, P.CODE_UNBOUND, 'and the gate refuses it');
      // The identical bytes against the session they were made for still read
      // as a pass, so this is a test of the binding and nothing else.
      eq(P.verifyPresence(recorded, expected(), opts()).channels[0].passed, true,
        'the same signal in its own session passes');
      return 'the same photograph: passing in its session, unbound in the next';
    });

    test('criterion 2: a recorded acoustic response replayed into a new session is refused', function () {
      var recorded = onlyChannel('acoustic');
      var fresh = expected({
        sessionId: 'sess-9f20',
        challenges: { optical: 'chal-o2', acoustic: 'chal-a2', ranging: 'chal-r2' }
      });
      var v = P.verifyPresence(recorded, fresh, opts());
      eq(v.state, P.STATE_UNBOUND, 'a recording of a tone is not bound to the new activation');
      eq(v.channels[1].outcome, P.OUTCOME_UNBOUND, 'on the acoustic channel');
      assert(/perfectly valid physical signal/.test(v.channels[1].reason),
        'the reason states the rule: ' + v.channels[1].reason);
      eq(P.admitActivation(policy(), v, request()).admit, false, 'and nothing is activated');
      return 'a recording of a physical signal is a perfectly valid physical signal, and it is refused';
    });

    test('criterion 2: a recorded ranging exchange replayed into a new session is refused', function () {
      var recorded = onlyChannel('ranging');
      var fresh = expected({ sessionId: 'sess-9f20' });
      var v = P.verifyPresence(recorded, fresh, opts());
      eq(v.state, P.STATE_UNBOUND, 'a recorded exchange is not bound to the new activation');
      eq(v.channels[2].binding.sessionMatched, false, 'the session id is the old one');
      eq(v.channels[2].binding.challengeMatched, true, 'though this sender happened to reuse the challenge');
      assert(/session/.test(v.channels[2].reason), 'and the reason names the session: ' + v.channels[2].reason);
      eq(P.admitActivation(policy(), v, request()).code, P.CODE_UNBOUND, 'and the gate refuses it');
      return 'session binding refuses a recording even when a sender reuses a challenge';
    });

    test('criterion 2: a challenge already spent on a channel is refused a second time', function () {
      P.CHANNELS.forEach(function (channel, i) {
        var first = P.verifyPresence(onlyChannel(channel), expected(), opts());
        eq(first.channels[i].passed, true, channel + ': the first presentation stands');

        var spent = { optical: [], acoustic: [], ranging: [] };
        spent[channel] = [CHALLENGE[channel]];
        var second = P.verifyPresence(onlyChannel(channel), expected({ spent: spent }), opts());
        eq(second.state, P.STATE_REPLAYED, channel + ': the second is a replay inside the same session');
        eq(second.channels[i].binding.sessionMatched, true, channel + ': bound to the right session');
        eq(second.channels[i].binding.challengeMatched, true, channel + ': echoing the right challenge');
        eq(second.channels[i].binding.spent, true, channel + ': which is exactly the problem');
        eq(P.admitActivation(policy(), second, request()).code, P.CODE_REPLAYED, channel + ': and the gate refuses it');

        // A challenge spent on another channel is not this one.
        var elsewhere = { optical: ['chal-x'], acoustic: ['chal-y'], ranging: ['chal-z'] };
        eq(P.verifyPresence(onlyChannel(channel), expected({ spent: elsewhere }), opts()).channels[i].passed,
          true, channel + ': other spent challenges are not this one');
      });
      return 'a challenge is answered once, on each of the three channels';
    });

    test('criterion 2: a recording moved to another channel is refused', function () {
      // A recorded acoustic response presented on the optical channel. Two
      // things refuse it independently, and both are asserted.
      var moved = {
        available: ['optical'],
        signals: { optical: { channel: 'acoustic', sessionId: SESSION, challenge: CHALLENGE.acoustic } }
      };
      var v = P.verifyPresence(moved, expected(), opts());
      eq(v.state, P.STATE_MALFORMED, 'a signal naming another channel is refused where it is read');
      assert(/moved between channels/.test(v.channels[0].reason), 'and it says why: ' + v.channels[0].reason);

      // And even relabelled, the challenge belongs to the other channel, so the
      // binding refuses it a second time.
      var relabelled = {
        available: ['optical'],
        signals: { optical: { channel: 'optical', sessionId: SESSION, challenge: CHALLENGE.acoustic } }
      };
      var w = P.verifyPresence(relabelled, expected(), opts());
      eq(w.state, P.STATE_UNBOUND, 'a relabelled recording still echoes the other channel’s challenge');
      eq(w.channels[0].binding.challengeMatched, false, 'which is not this channel’s');
      return 'per-channel challenges, so a recording cannot be presented as another channel';
    });

    test('criterion 2: half a binding is no binding', function () {
      var sessionOnly = P.verifyPresence(onlyChannel('optical'),
        expected({ challenges: { optical: 'chal-other' } }), opts());
      eq(sessionOnly.state, P.STATE_UNBOUND, 'right session, wrong challenge');
      eq(sessionOnly.channels[0].binding.sessionMatched, true, 'the session did match');
      eq(sessionOnly.channels[0].binding.challengeMatched, false, 'the challenge did not');

      var challengeOnly = P.verifyPresence(onlyChannel('optical'),
        expected({ sessionId: 'sess-other' }), opts());
      eq(challengeOnly.state, P.STATE_UNBOUND, 'right challenge, wrong session');
      eq(challengeOnly.channels[0].binding.challengeMatched, true, 'the challenge did match');

      var neither = P.verifyPresence(onlyChannel('optical'),
        { sessionId: null, challenges: null, spent: null }, opts());
      eq(neither.state, P.STATE_UNBOUND, 'a sender that issued nothing binds nothing');
      return 'both halves are required, and each is reported on its own';
    });

    test('criterion 2: a spent list too long to search is refused, not passed', function () {
      // The same defect attest.js records: a list silently truncated stops
      // detecting replays of everything consumed early, without any signal that
      // it has. An undetermined replay check is refused.
      var over = [];
      for (var i = 0; i < P.LIMITS.spentChallenges + 100; i++) over.push('spent-' + i);
      over.push(CHALLENGE.optical);

      var v = P.verifyPresence(onlyChannel('optical'),
        expected({ spent: { optical: over, acoustic: [], ranging: [] } }), opts());
      eq(v.state, P.STATE_REPLAYED, 'an unsearchable list must refuse, never report a pass');
      eq(v.channels[0].binding.spentOverflow, true, 'and say why it refused');
      assert(/cannot be determined/i.test(v.channels[0].reason),
        'the reason must name the undetermined check: ' + v.channels[0].reason);
      eq(P.admitActivation(policy(), v, request()).admit, false, 'and no activation proceeds');

      var atCap = [];
      for (var j = 0; j < P.LIMITS.spentChallenges; j++) atCap.push('other-' + j);
      eq(P.verifyPresence(onlyChannel('optical'),
        expected({ spent: { optical: atCap, acoustic: [], ranging: [] } }), opts()).channels[0].passed,
        true, 'a full-but-searchable list is still searched');
      return 'an undetermined replay check refuses';
    });

    test('criterion 2: a replay on one channel refuses the fusion, even beside two genuine ones', function () {
      // Someone presenting a recording into a live session is an attack in
      // progress, not a missing channel. Two genuine channels do not buy it a
      // free pass, and the cost — a jammer gets a denial of activation — is
      // stated in describeLimits() rather than discovered.
      var v = P.verifyPresence(report(), expected({
        spent: { optical: [], acoustic: [], ranging: [CHALLENGE.ranging] }
      }), opts());
      eq(v.state, P.STATE_REPLAYED, 'the fusion refuses');
      eq(v.channels[0].passed, true, 'even though optical passed');
      eq(v.channels[1].passed, true, 'and acoustic passed');
      eq(v.pairs.length, 0, 'and no pair is published on a refusing state');
      eq(P.admitActivation(policy(), v, request()).code, P.CODE_REPLAYED, 'and the gate refuses');
      assert(P.describeLimits().join(' ').indexOf('denial of activation') >= 0,
        'the cost of this choice must be stated');
      return 'a recording beside two genuine channels refuses the whole claim';
    });

    // --- ADR-023 §2.3: available, attempted and passed are three things -------

    test('criterion 3: all three channels appear in the transcript on every state', function () {
      var lines = [];
      P.STATES.forEach(function (state) {
        var t = P.presenceTranscript(verdictOf(state));
        eq(t.state, state, 'the transcript records the state');
        eq(t.channels.length, 3, state + ': all three channels appear');
        eq(t.channels.map(function (c) { return c.channel; }).join(','),
          P.CHANNELS.join(','), state + ': in a stable order');
        t.channels.forEach(function (c) {
          eq(typeof c.available, 'boolean', state + '/' + c.channel + ': available is a boolean');
          eq(typeof c.attempted, 'boolean', state + '/' + c.channel + ': attempted is a boolean');
          eq(typeof c.passed, 'boolean', state + '/' + c.channel + ': passed is a boolean');
          assert(P.OUTCOMES.indexOf(c.outcome) >= 0, state + '/' + c.channel + ': a known outcome');
        });
        lines.push(state);
      });
      // And the receipt carries the same three rows.
      var r = run({});
      eq(r.receipt.channels.length, 3, 'the receipt carries all three too');
      assert(/individually spoofable/.test(r.receipt.caveat), 'and the caveat travels with it');
      assert(/not verified physical presence/.test(r.transcript.caveat),
        'which says outright what this is not: ' + r.transcript.caveat);
      return lines.length + ' states, three channels in each';
    });

    test('criterion 3: available, attempted and passed are three different things', function () {
      // A pair that declares all three, attempts two, and passes one.
      var mixed = {
        available: ['optical', 'acoustic', 'ranging'],
        signals: { optical: sig('optical'), acoustic: sig('acoustic') }
      };
      var t = P.presenceTranscript(
        P.verifyPresence(mixed, expected(), opts(readers({ acoustic: no }))));

      eq(t.channels[0].available + '/' + t.channels[0].attempted + '/' + t.channels[0].passed,
        'true/true/true', 'optical: declared, attempted, passed');
      eq(t.channels[1].available + '/' + t.channels[1].attempted + '/' + t.channels[1].passed,
        'true/true/false', 'acoustic: declared and attempted, and it did not pass');
      eq(t.channels[2].available + '/' + t.channels[2].attempted + '/' + t.channels[2].passed,
        'true/false/false', 'ranging: declared, never attempted, and that is not a pass');

      // The implication that DOES hold, over every state.
      P.STATES.forEach(function (state) {
        P.presenceTranscript(verdictOf(state)).channels.forEach(function (c) {
          if (c.passed) eq(c.attempted, true, state + '/' + c.channel + ': passed implies attempted');
        });
      });
      return 'declared is not attempted, and attempted is not passed';
    });

    test('criterion 3: an absent channel is absent, never assumed-good', function () {
      var v = P.verifyPresence(withChannels(['optical', 'acoustic']), expected(), opts());
      eq(v.state, P.STATE_CORROBORATED, 'the two channels present do corroborate');
      eq(v.channels[2].outcome, P.OUTCOME_ABSENT, 'and the third is absent');
      eq(v.channels[2].passed, false, 'not passed');
      eq(v.channels[2].available, false, 'not available');
      assert(/never assumed-good/.test(v.channels[2].reason), 'and it says so: ' + v.channels[2].reason);

      // A declared channel that was never exercised is a different sentence and
      // is still not a pass.
      var declaredNotSent = P.verifyPresence({
        available: P.CHANNELS.slice(),
        signals: { optical: sig('optical'), acoustic: sig('acoustic') }
      }, expected(), opts());
      eq(declaredNotSent.channels[2].available, true, 'declared');
      eq(declaredNotSent.channels[2].attempted, false, 'never attempted');
      eq(declaredNotSent.channels[2].passed, false, 'and still not a pass');
      assert(/never attempted is not a channel that passed/.test(declaredNotSent.channels[2].reason),
        'and it says so: ' + declaredNotSent.channels[2].reason);
      return 'absent and declared-but-unattempted are two sentences, and neither is a pass';
    });

    test('criterion 3: a report that lies about availability gains nothing by it', function () {
      // Availability is a claim by the device pair, recorded and never decided
      // on. The requirement check reads `passed`.
      var boastful = { available: P.CHANNELS.slice(), signals: { optical: sig('optical') } };
      var r = run({ report: boastful, policy: policy({ requiredChannels: ['acoustic'] }) });
      eq(r.verdict.channels[1].available, true, 'the pair declared acoustic');
      eq(r.verdict.channels[1].attempted, false, 'and attempted nothing on it');
      eq(r.decision.admit, false, 'so the declaration buys nothing');
      eq(r.verdict.state, P.STATE_UNCORROBORATED, 'one channel still corroborates nothing');

      // A signal on a channel the pair never declared is recorded as exactly
      // that discrepancy rather than quietly upgraded to available.
      var undeclared = P.verifyPresence({ available: [], signals: { optical: sig('optical') } },
        expected(), opts());
      eq(undeclared.channels[0].available, false, 'never declared');
      eq(undeclared.channels[0].attempted, true, 'and yet attempted');
      eq(undeclared.channels[0].passed, true, 'and it passed on its own terms');
      return 'availability is recorded, never decided on';
    });

    test('criterion 3: the receipt never conflates corroborated-and-approved with nobody-asked', function () {
      var corroborated = run({ report: withChannels(['optical', 'ranging']) }).receipt;
      var nobodyAsked = run({ report: null, policy: policy({ requirePresence: false }) }).receipt;

      eq(corroborated.admitted, true, 'both activations proceeded');
      eq(nobodyAsked.admitted, true, 'both activations proceeded');

      eq(corroborated.presence, P.STATE_CORROBORATED, 'one is corroborated');
      eq(nobodyAsked.presence, P.STATE_ABSENT, 'the other measured nothing');
      eq(corroborated.reportPresented, true, 'one presented a report');
      eq(nobodyAsked.reportPresented, false, 'the other presented none');
      eq(corroborated.senderRequiredPresence, true, 'one sender asked');
      eq(nobodyAsked.senderRequiredPresence, false, 'the other did not');
      eq(corroborated.decision, P.CODE_CORROBORATED_AND_APPROVED, 'and the codes differ');
      eq(nobodyAsked.decision, P.CODE_PRESENCE_NOT_REQUIRED, 'and the codes differ');
      eq(corroborated.corroboratedBy.length, 1, 'one records which pair corroborated');
      eq(nobodyAsked.corroboratedBy.length, 0, 'the other records no pair');
      assert(/Nobody asked/.test(nobodyAsked.summary), 'the summary says it plainly: ' + nobodyAsked.summary);
      assert(/Corroborated/.test(corroborated.summary), 'and so does the other: ' + corroborated.summary);
      assert(corroborated.summary !== nobodyAsked.summary, 'two different outcomes must not read the same');
      return 'admitted alone says nothing, which is why it is never recorded alone';
    });

    test('criterion 3: a receipt reports the refusal it got, and which rules were unmet', function () {
      var r = run({
        report: withChannels(['optical', 'acoustic']),
        policy: policy({ requiredChannels: ['ranging'] })
      });
      eq(r.decision.admit, false, 'this pair has no ranging');
      eq(r.receipt.admitted, false, 'the receipt says so');
      eq(r.receipt.presence, P.STATE_CORROBORATED, 'while still recording that two channels corroborated');
      assert(r.receipt.unmet.indexOf(P.RULE_CHANNEL) >= 0, 'the required channel is named: ' + r.receipt.unmet);
      eq(r.receipt.senderRequiredChannels.join(','), 'ranging', 'and what the sender asked for');
      assert(/refused/.test(r.receipt.summary), 'the summary says refused: ' + r.receipt.summary);
      assert(/ranging/.test(r.decision.reason), 'and the reason names the channel: ' + r.decision.reason);
      return r.receipt.unmet.join(', ');
    });

    test('criterion 3: the transcript is deterministic and carries no clock', function () {
      var a = P.presenceTranscript(verdictOf(P.STATE_CORROBORATED));
      var b = P.presenceTranscript(verdictOf(P.STATE_CORROBORATED));
      eq(JSON.stringify(a), JSON.stringify(b), 'the transcript moved between two identical reports');
      JSON.stringify(a).split(/[",:{}\[\]]+/).forEach(function (token) {
        assert(!/^\d{10,}$/.test(token), 'a transcript should carry no timestamp: ' + token);
      });
      Object.keys(a).forEach(function (k) {
        assert(!/time|date|clock|^now$|At$/.test(k), 'a transcript should carry no clock reading: ' + k);
      });
      return 'the same report commits to the same transcript bytes';
    });

    // --- ADR-023 §2.3 and §4.5: degradation ----------------------------------

    test('criterion 5: a pair missing one channel still corroborates on the other two', function () {
      var pairs = [['optical', 'acoustic'], ['optical', 'ranging'], ['acoustic', 'ranging']];
      var lines = [];
      pairs.forEach(function (list) {
        var r = run({ report: withChannels(list) });
        eq(r.verdict.state, P.STATE_CORROBORATED, list.join('+') + ' should corroborate');
        eq(r.verdict.pairs.length, 1, list.join('+') + ': exactly the one pair');
        eq(r.verdict.pairs[0].slice().sort().join('+'), list.slice().sort().join('+'), 'and it is that pair');
        eq(r.decision.admit, true, list.join('+') + ': and the activation proceeds');
        // The missing third is recorded as missing, not as fine.
        var missing = r.transcript.channels.filter(function (c) { return list.indexOf(c.channel) < 0; })[0];
        eq(missing.available, false, 'the missing channel is not available');
        eq(missing.passed, false, 'and did not pass');
        lines.push(list.join('+'));
      });
      return lines.join(', ') + ' — each of the three pairs corroborates on its own';
    });

    test('criterion 5: a pair missing two channels cannot corroborate at all', function () {
      var lines = [];
      P.CHANNELS.forEach(function (channel) {
        var r = run({ report: onlyChannel(channel) });
        eq(r.verdict.state, P.STATE_UNCORROBORATED, channel + ' alone cannot corroborate');
        eq(r.decision.admit, false, channel + ': and nothing is activated');
        eq(r.transcript.channels.filter(function (c) { return c.passed; }).length, 1,
          channel + ': exactly one channel passed');
        eq(r.transcript.corroboratedBy.length, 0, channel + ': and nothing corroborated it');
        lines.push(channel);
      });
      // A pair with nothing at all is a different state again, and it is not an error.
      var none = run({ report: { available: [], signals: {} } });
      eq(none.verdict.state, P.STATE_ABSENT, 'a pair with no channels at all is absent');
      assert(!/error|invalid|fail/i.test(none.verdict.reason),
        'and absent must not read as a failure: ' + none.verdict.reason);
      return lines.join(', ') + ' — one channel is never enough, and none is a state of its own';
    });

    test('criterion 5: a policy that has not stated its requirement is refused, never defaulted', function () {
      var undeclared = { requiredChannels: [], grants: [{ device: PEER, classes: ['credential'] }] };
      var v = P.verifyPresence(withChannels(['optical', 'acoustic']), expected(), opts());
      var d = P.admitActivation(undeclared, v, request());
      eq(d.admit, false, 'an undeclared policy must not admit, even on a corroborated verdict');
      eq(d.code, P.CODE_POLICY_UNDECLARED, 'and it says the decision was never made');
      assert(/no default/.test(d.reason), 'the reason should say so outright: ' + d.reason);

      eq(P.admitActivation(merge(undeclared, { requirePresence: true }), v, request()).admit, true,
        'a sender that requires presence and gets it, proceeds');
      eq(P.admitActivation(merge(undeclared, { requirePresence: false }), v, request()).admit, true,
        'a sender that does not require it, proceeds too — for a different reason');
      eq(P.normalizePolicy({}).declared, false, 'an empty policy has declared nothing');
      eq(P.normalizePolicy({ requirePresence: false }).declared, true, 'saying no is still saying');
      return 'the sender decides, and a sender that has not decided is refused';
    });

    test('criterion 5: a policy requiring a channel the pair does not have is refused, naming it', function () {
      var r = run({
        report: withChannels(['optical', 'acoustic']),
        policy: policy({ requiredChannels: ['optical', 'ranging'] })
      });
      eq(r.verdict.state, P.STATE_CORROBORATED, 'two channels did corroborate');
      eq(r.decision.admit, false, 'and the sender wanted one this pair does not have');
      eq(r.decision.code, P.CODE_CHANNEL_REQUIRED, 'refused on the required channel');
      eq(r.decision.unmet.length, 1, 'exactly one requirement is unmet');
      eq(r.decision.unmet[0].channel, 'ranging', 'and it names which');
      assert(/absent/.test(r.decision.unmet[0].reason), 'reporting what happened on it: ' + r.decision.unmet[0].reason);

      // Relaxing the requirement admits the identical verdict, so this is a
      // test of the channel rule and not of something else being wrong.
      eq(P.admitActivation(policy({ requiredChannels: ['optical'] }), r.verdict, request()).admit, true,
        'requiring only what the pair has admits the identical verdict');
      return 'a required channel is required, and the refusal names it';
    });

    test('criterion 5: a policy that requires channels while saying presence is not required is refused', function () {
      // Two answers to the same question. Letting one silently win would mean a
      // stated channel requirement was quietly ignored.
      var incoherent = policy({ requirePresence: false, requiredChannels: ['optical'] });
      [verdictOf(P.STATE_CORROBORATED), verdictOf(P.STATE_ABSENT)].forEach(function (v) {
        var d = P.admitActivation(incoherent, v, request());
        eq(d.admit, false, 'an incoherent policy must not admit on ' + v.state);
        eq(d.code, P.CODE_POLICY_INCOHERENT, 'and it says which two statements collide');
        assert(/neither is allowed to silently win/.test(d.reason), 'plainly: ' + d.reason);
      });
      eq(P.admitActivation(policy({ requirePresence: false }), verdictOf(P.STATE_ABSENT), request()).admit,
        true, 'the same policy without the requirement is coherent and admits');
      return 'a silently ignored security setting is the failure this refusal exists to prevent';
    });

    // --- Fail-closed ---------------------------------------------------------

    test('fail-closed: a state that does not exist yet is refused, not interpreted', function () {
      var futures = ['corroborated-v2', 'CORROBORATED', 'corroborated ', 'fused', '', 0, null, undefined, {}];
      futures.forEach(function (s) {
        var d = P.admitActivation(policy(), { state: s }, request());
        eq(d.admit, false, JSON.stringify(s) + ' must not admit');
        assert(d.code === P.CODE_UNKNOWN_STATE || d.code === P.CODE_PENDING,
          JSON.stringify(s) + ' should be unknown or pending, got ' + d.code);
      });
      var explicit = P.admitActivation(policy(), { state: 'corroborated-v2' }, request());
      eq(explicit.code, P.CODE_UNKNOWN_STATE, 'a named future state is unknown, not pending');
      assert(/Unrecognised/.test(explicit.reason), 'and it says so: ' + explicit.reason);
      return futures.length + ' states nobody has defined, all refused';
    });

    test('fail-closed: the whole state vocabulary has a stated outcome, and no other', function () {
      var expectedCodes = {};
      expectedCodes[P.STATE_UNCORROBORATED] = P.CODE_UNCORROBORATED_REFUSED;
      expectedCodes[P.STATE_ABSENT] = P.CODE_ABSENT_REFUSED;
      expectedCodes[P.STATE_MALFORMED] = P.CODE_MALFORMED;
      expectedCodes[P.STATE_UNBOUND] = P.CODE_UNBOUND;
      expectedCodes[P.STATE_REPLAYED] = P.CODE_REPLAYED;
      expectedCodes[P.STATE_FORGED] = P.CODE_FORGED;
      eq(P.STATES.length, 7, 'the vocabulary is seven states');
      var required = P.normalizePolicy(policy());
      P.STATES.forEach(function (state) {
        var gate = P.presenceGate(required, state);
        if (state === P.STATE_CORROBORATED) {
          eq(gate.pass, true, 'corroborated clears the evidence bar');
        } else {
          eq(gate.pass, false, state + ' should not clear the bar under a requiring policy');
          eq(gate.code, expectedCodes[state], state + ' code');
        }
      });
      var relaxed = P.normalizePolicy(policy({ requirePresence: false }));
      eq(P.presenceGate(relaxed, P.STATE_ABSENT).pass, true, 'a sender not requiring presence clears absent');
      eq(P.presenceGate(relaxed, P.STATE_UNCORROBORATED).pass, true, 'and clears uncorroborated the same way');
      eq(P.presenceGate(relaxed, P.STATE_REPLAYED).pass, false, 'but never a replay');
      eq(P.presenceGate(relaxed, P.STATE_FORGED).pass, false, 'and never a forgery');
      return '7 states, each with a stated outcome, plus a default that refuses';
    });

    test('fail-closed: a verdict that has not landed never admits', function () {
      [null, undefined, {}, { reason: 'still listening' }, [], 'corroborated'].forEach(function (v) {
        var d = P.admitActivation(policy(), v, request());
        eq(d.admit, false, 'a pending check must not admit');
        eq(d.code, P.CODE_PENDING, 'and it is pending, not absent');
      });
      return 'pending never admits, and is never mistaken for absent';
    });

    // --- The readers are injected, and there are none -------------------------

    test('readers: with no reader nothing ever passes, so corroborated is unreachable', function () {
      [undefined, {}, { readers: null }, { readers: {} }, { readers: { optical: 'yes' } },
        { readers: [] }].forEach(function (o) {
        var v = P.verifyPresence(report(), expected(), o);
        eq(v.state, P.STATE_UNCORROBORATED, 'no readers means nothing passes');
        v.channels.forEach(function (c) {
          eq(c.outcome, P.OUTCOME_UNREAD, c.channel + ' should be unread');
          eq(c.passed, false, c.channel + ' must not pass unread');
          eq(c.read, null, c.channel + ': nothing was established');
          eq(c.attempted, true, c.channel + ': and yet it was attempted, which is recorded separately');
        });
        eq(P.admitActivation(policy(), v, request()).admit, false, 'and the gate refuses');
      });
      // A reader for one channel only leaves the other two unread, so a caller
      // cannot reach corroboration by supplying one simulation.
      var one = P.verifyPresence(report(), expected(), opts({ optical: yes }));
      eq(one.state, P.STATE_UNCORROBORATED, 'one reader is one channel');
      return 'corroborated is unreachable on this platform, and that is the honest state';
    });

    test('readers: a reader that throws yields unread, never a pass', function () {
      var boom = opts(readers({ acoustic: function () { throw new Error('microphone busy'); } }));
      var v = P.verifyPresence(report(), expected(), boom);
      eq(v.channels[1].outcome, P.OUTCOME_UNREAD, 'a broken reader is not a passing one');
      assert(v.channels[1].outcome !== P.OUTCOME_ABSENT, 'nor is it the absence of a signal');
      assert(/microphone busy/.test(v.channels[1].reason), 'the failure is surfaced: ' + v.channels[1].reason);
      eq(v.state, P.STATE_CORROBORATED, 'and the other two still corroborate each other');

      // Anything that is not exactly true or false establishes nothing.
      [null, undefined, 1, 'true', {}, 0.99].forEach(function (answer) {
        var w = P.verifyPresence(onlyChannel('optical'), expected(),
          opts({ optical: function () { return answer; } }));
        eq(w.channels[0].outcome, P.OUTCOME_UNREAD, JSON.stringify(answer) + ' is not a verdict');
      });
      return 'an error is a check that did not happen, not a channel that is off';
    });

    test('readers: a reader that says no yields forged, and forged never admits', function () {
      var v = P.verifyPresence(report(), expected(), opts(readers({ ranging: no })));
      eq(v.state, P.STATE_FORGED, 'a rejected signal forges the whole fusion');
      eq(v.channels[2].outcome, P.OUTCOME_FORGED, 'on the channel that rejected');
      eq(v.channels[2].read, false, 'and the answer is recorded');
      eq(v.pairs.length, 0, 'while publishing no pair the policy could match');
      [policy(), policy({ requirePresence: false })].forEach(function (p) {
        eq(P.admitActivation(p, v, request()).code, P.CODE_FORGED,
          'forged is refused whether or not the sender requires presence');
      });
      return 'a pair that presents a signal it cannot back is not a pair that presented nothing';
    });

    test('readers: a reader sees only its own parsed signal, and not until the binding holds', function () {
      var seen = {};
      P.verifyPresence(report(), expected(), opts({
        optical: function (s) { seen.optical = s; return true; },
        acoustic: function (s) { seen.acoustic = s; return true; },
        ranging: function (s) { seen.ranging = s; return true; }
      }));
      P.CHANNELS.forEach(function (c) {
        assert(seen[c], c + ': the reader should be called');
        eq(seen[c].channel, c, c + ': with its own channel and no other');
        eq(seen[c].sessionId, SESSION, c + ': and the session id');
        eq(Object.keys(seen[c]).sort().join(','), 'challenge,channel,sessionId', c + ': and nothing else');
      });

      // A recording that fails its binding must not be able to make a reader do
      // work, so nothing expensive runs before the cheap check.
      var called = 0;
      P.verifyPresence(onlyChannel('optical'), expected({ sessionId: 'other' }),
        opts({ optical: function () { called++; return true; } }));
      eq(called, 0, 'an unbound recording must not reach a reader at all');

      // Nor may a spent challenge.
      P.verifyPresence(onlyChannel('optical'),
        expected({ spent: { optical: [CHALLENGE.optical], acoustic: [], ranging: [] } }),
        opts({ optical: function () { called++; return true; } }));
      eq(called, 0, 'nor may a replay');
      return 'binding is checked before anything physical would run';
    });

    // --- Honesty -------------------------------------------------------------

    test('honesty: all three channels are reported unimplemented', function () {
      var channels = P.describeChannels();
      eq(channels.length, 3, 'ADR-023 §1 names three');
      eq(channels.map(function (c) { return c.id; }).sort().join(','), 'acoustic,optical,ranging',
        'optical, acoustic, ranging');
      channels.forEach(function (c) {
        eq(c.status, 'unimplemented', c.id + ' must not claim to be implemented');
        eq(c.readerSupplied, false, c.id + ' has no reader');
        assert(c.aloneEstablishes && c.aloneEstablishes.length > 10, c.id + ': what it alone establishes');
        assert(/supplying a simulation/.test(c.note), c.id + ' note: ' + c.note);
      });
      assert(!channels.some(function (c) { return c.status === 'supported' || c.status === 'verified'; }),
        'nothing here may claim support for a channel');
      assert(/no browser exposes a uwb api/i.test(
        channels.filter(function (c) { return c.id === 'ranging'; })[0].note),
        'the ranging note must say there is no API at all');
      assert(/no acoustic code/i.test(
        channels.filter(function (c) { return c.id === 'acoustic'; })[0].note),
        'the acoustic note must say nothing implements ADR-007');

      // And the claim is tied to behaviour rather than to a string: run the
      // whole pipeline the way this platform actually can — a perfect report on
      // all three channels and no reader anywhere — and nothing passes.
      var asShipped = P.verifyPresence(report(), expected(), undefined);
      eq(asShipped.state, P.STATE_UNCORROBORATED, 'with no reader implemented, nothing corroborates');
      asShipped.channels.forEach(function (c) {
        eq(c.passed, false, c.channel + ' cannot pass when nothing reads it');
      });
      eq(P.admitActivation(policy(), asShipped, request()).admit, false,
        'so no presence-based activation is reachable as this repository stands');
      return '3 channels named, 0 implemented, 0 reachable passes';
    });

    test('honesty: the relay property is labelled reasoning and never measurement', function () {
      var relay = P.describeRelayRequirement();
      eq(relay.evidence, 'reasoning', 'this is reasoning');
      eq(relay.measured, false, 'and nothing was measured');
      assert(/two devices, two rooms/.test(relay.note), 'it names what a measurement would need: ' + relay.note);
      assert(/No relay has been built, run or observed/.test(relay.note), 'and says none was: ' + relay.note);
      eq(relay.pairs.length, 3, 'one entry per corroborating pair');
      relay.pairs.forEach(function (entry) {
        eq(entry.mustDefeatSimultaneously.length, 2, 'a relay must defeat both members of a pair');
        assert(/at the same moment, for the same session/.test(entry.note), 'simultaneity is the property: ' + entry.note);
      });
      assert(/remains possible/.test(relay.residual), 'and the attack is not claimed closed: ' + relay.residual);
      assert(!/defeats/.test(relay.note), 'nothing here may report which channels a relay DOES defeat');
      return 'which channels a relay would have to defeat, stated as reasoning';
    });

    test('honesty: acceptance criteria 4 and 6 are reported unmet', function () {
      var acceptance = P.describeAcceptance();
      eq(acceptance.length, 6, 'ADR-023 §4 lists six criteria');
      var byNumber = {};
      acceptance.forEach(function (a) { byNumber[a.criterion] = a; });
      [1, 2, 3, 5].forEach(function (n) {
        eq(byNumber[n].status, 'covered', 'criterion ' + n + ' is covered by this suite');
      });
      eq(byNumber[4].status, 'unmet', 'criterion 4 needs hardware this repository does not have');
      assert(/has NOT been measured/.test(byNumber[4].note), 'and says so: ' + byNumber[4].note);
      eq(byNumber[6].status, 'unmet', 'criterion 6 needs a UI nobody has wired');
      assert(/no wording to review/.test(byNumber[6].note), 'and says so: ' + byNumber[6].note);
      return '4 covered, 2 unmet, and the two are named';
    });

    test('honesty: channel availability reports API presence and never a demonstration', function () {
      var absent = P.channelAvailability({});
      P.CHANNELS.forEach(function (c) {
        eq(absent[c].apiPresent, false, c + ': an environment with nothing');
        eq(absent[c].exercised, false, c + ': and nothing exercised');
      });

      var present = P.channelAvailability({
        navigator: { mediaDevices: {} },
        AudioContext: function () {}
      });
      eq(present.optical.apiPresent, true, 'a camera API being present');
      eq(present.acoustic.apiPresent, true, 'and Web Audio');
      eq(present.ranging.apiPresent, false, 'and never ranging, because there is no API to look for');
      assert(/false by construction rather than by detection/.test(present.ranging.note),
        'the ranging note must say why: ' + present.ranging.note);
      assert(/does not here/.test(present.acoustic.note), 'the acoustic note must not overclaim: ' + present.acoustic.note);
      P.CHANNELS.forEach(function (c) {
        eq(present[c].exercised, false, c + ': an API being present is not a measurement');
      });

      var hostile = {};
      Object.defineProperty(hostile, 'AudioContext', { get: function () { throw new Error('blocked'); } });
      eq(P.channelAvailability(hostile).acoustic.apiPresent, false, 'a throwing lookup reads as absent');
      return 'an API being present is not a presence having been measured';
    });

    test('honesty: the stated limits name every claim this cannot make', function () {
      var limits = P.describeLimits();
      assert(Array.isArray(limits) && limits.length >= 10, 'expected at least ten caveats');
      var joined = limits.join(' ').toLowerCase();
      assert(joined.indexOf('evidence, never authorization') >= 0, 'does not state ADR-023 §2.2’s second half');
      assert(joined.indexOf('no single channel may authorize alone') >= 0, 'does not state the decision');
      assert(joined.indexOf('can be set to 2 can be set to 1') >= 0, 'does not say why there is no threshold');
      assert(joined.indexOf('uwb api') >= 0 && joined.indexOf('no acoustic code') >= 0,
        'does not disclaim the two missing channels');
      assert(joined.indexOf('supplying a simulation') >= 0, 'does not disclaim the injected readers');
      assert(joined.indexOf('has not been measured') >= 0, 'does not disclaim the relay measurement');
      assert(joined.indexOf('verified physical presence') >= 0, 'does not name the over-claiming risk');
      assert(joined.indexOf('denial of activation') >= 0, 'does not state the cost of refusing on one channel');
      assert(joined.indexOf('privacy') >= 0, 'does not state the ranging privacy trade');
      assert(joined.indexOf('establishes no identity') >= 0, 'does not say presence is not identity');
      assert(joined.indexOf('has not been reviewed') >= 0, 'does not disclaim the UI wording');
      return limits.length + ' caveats';
    });

    test('honesty: the artifact classes agree with the vocabulary attest.js uses', function () {
      // Restated rather than imported, so this module depends on nothing. The
      // two lists agreeing is a property worth asserting rather than assuming.
      eq(P.ARTIFACT_CLASSES.slice().sort().join(','), 'agent,container,credential,generic,model',
        'the five classes, unchanged');
      eq(P.normalizePolicy({ grants: [{ device: PEER, classes: ['agent', 'invented'] }] })
        .grants[0].classes.join(','), 'agent', 'and an invented class is not granted');
      return P.ARTIFACT_CLASSES.length + ' classes, matching the sibling module';
    });

    // --- Totality and purity -------------------------------------------------

    test('totality: junk in every argument position refuses, and never throws', function () {
      var junk = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'a', {}, [], [1, 2], true, false,
        { state: P.STATE_CORROBORATED },
        { state: P.STATE_CORROBORATED, pairs: [['optical', 'acoustic']], channels: 'x' },
        { available: 'optical' },
        function () {}];
      var checked = 0;
      junk.forEach(function (p) {
        junk.forEach(function (v) {
          junk.forEach(function (r) {
            checked++;
            var d = P.admitActivation(p, v, r);
            eq(typeof d.admit, 'boolean', 'a decision always has a boolean admit');
            eq(typeof d.code, 'string', 'and a stable code');
            eq(d.admit, false, 'junk must never admit: ' + d.code);
            var w = P.verifyPresence(p, v, r);
            eq(typeof w.state, 'string', 'a verdict always has a state');
            assert(w.state !== P.STATE_CORROBORATED, 'junk must never reach corroborated');
            eq(w.channels.length, 3, 'and all three channels are always recorded');
            P.presenceTranscript(v);
            P.presenceReceipt(v, d, p);
          });
        });
      });
      return checked + ' argument triples over four functions, none of them throwing or admitting';
    });

    test('purity: verifying and admitting mutate nothing they were given', function () {
      var rep = report();
      var exp = expected();
      var pol = policy({ requiredChannels: ['optical'] });
      var req = request();
      var before = JSON.stringify([rep, exp, pol, req]);
      var v = P.verifyPresence(rep, exp, opts());
      var d = P.admitActivation(pol, v, req);
      P.presenceTranscript(v);
      P.presenceReceipt(v, d, pol);
      eq(JSON.stringify([rep, exp, pol, req]), before, 'a caller’s objects came back changed');

      // The verdict's own pair list is not handed out by reference either.
      var decision = P.admitActivation(policy(), v, req);
      decision.corroboratedBy.forEach(function (pair) { pair.push('tampered'); });
      eq(v.pairs[0].length, 2, 'a decision must not hand out the verdict’s pairs by reference');
      return 'report, expectation, policy and request are all read, never written';
    });

    test('purity: the same report gives the same verdict and the same decision', function () {
      var a = run({});
      var b = run({});
      eq(JSON.stringify(a.verdict), JSON.stringify(b.verdict), 'the verdict moved');
      eq(JSON.stringify(a.decision), JSON.stringify(b.decision), 'the decision moved');
      eq(a.receipt.summary, b.receipt.summary, 'the receipt moved');
      Object.keys(a.verdict).forEach(function (k) {
        assert(!/time|date|clock|^now$|At$/.test(k), 'a verdict should carry no clock reading: ' + k);
      });
      a.verdict.channels.forEach(function (c) {
        Object.keys(c).forEach(function (k) {
          assert(!/time|date|clock|elapsed|^now$|At$/.test(k),
            'a channel record should carry no clock reading: ' + k);
        });
      });
      return 'deterministic: the session id, the challenges, the spent lists and the readers are all passed in';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
