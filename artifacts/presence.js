/*!
 * rvQR physical presence fusion — three measurements as EVIDENCE, and the
 * separate gate that decides.
 *
 * Per ADR-023. rvQR's authentication story has always been physical: the human
 * aiming the camera is the authentication. That is a real property and a weak
 * one, because it is asserted rather than measured — nothing in the protocol
 * records how far away the peer was, or whether the thing that answered was in
 * the room at all. Three independent signals each measure something different:
 * optical line-of-sight, an ultrasonic challenge-response, and radio ranging.
 *
 * ---------------------------------------------------------------------------
 * NO SINGLE CHANNEL MAY INDEPENDENTLY AUTHORIZE ACTIVATION — ADR-023 §2.2
 * ---------------------------------------------------------------------------
 *
 * This is the decision, and it is the one thing in this file that is enforced
 * by shape rather than by a number:
 *
 *   - Ranging says a device is 0.4 m away. It does not say it is the device on
 *     the screen.
 *   - Ultrasound says something answered. A speaker in the room answers.
 *   - Optical says a screen was seen. Substitution is exactly that.
 *
 * So corroboration is a **pair relation over distinct channels**, never a count
 * compared against a threshold. `CORROBORATING_PAIRS` is built once from the
 * closed channel vocabulary by taking every combination of two distinct indices
 * — three pairs for three channels — and a presence claim exists only when some
 * pair has BOTH members passing, for the same session and the same challenge.
 *
 * There is no `minChannels`, no `threshold` and no quorum size anywhere in this
 * module or in the policy it reads, because a number that can be set to 2 can
 * be set to 1, and ADR-023 §2.2 does not have a setting. A channel cannot pair
 * with itself: the pair list is generated from i < j, so a self-pair is not a
 * value this module can hold. `normalizePolicy` drops any numeric field a
 * caller invents, so a policy cannot smuggle a threshold back in either.
 *
 * ---------------------------------------------------------------------------
 * PRESENCE IS EVIDENCE, NOT AUTHORIZATION — the same invariant as ADR-021 §2.2
 * ---------------------------------------------------------------------------
 *
 * Fusion raises the cost of an attack; it does not turn proximity into
 * permission. A device that is definitely in the room is still not necessarily
 * a device that may receive a credential. So this file has the same two-part
 * shape as attest.js, and the barrier between the parts is the design rather
 * than the calling order:
 *
 *   verifyPresence(report, expected, opts) -> VERDICT
 *       Which channels were declared available, which were actually attempted,
 *       and which passed — each bound to THIS session and THIS challenge.
 *       Nothing else. It is NEVER handed the sender's policy, so it has nothing
 *       to decide with, and its result carries no `admit`, no `allow` and no
 *       boolean anything a caller could mistake for permission.
 *
 *   admitActivation(policy, verdict, request) -> { admit, code, reason }
 *       May this artifact be activated on this peer? It is NEVER handed the raw
 *       report, only the verdict, so it cannot be talked into anything the
 *       verifier did not establish. Exactly one `admit: true` exists in it and
 *       it sits after `capabilityDecision` — including on the path where the
 *       sender did not require presence at all, because a sender that does not
 *       ask for presence has relaxed its evidence bar, not its authority model.
 *
 * The corroborating pairs are published on the verdict ONLY when the state is
 * `corroborated`; on every other state the list is empty. The gate reads that
 * list and never recomputes it from the channel outcomes, so a hand-built
 * verdict asserting `corroborated` with nothing behind it fails the
 * corroboration rule instead of clearing the bar on a string.
 *
 * ---------------------------------------------------------------------------
 * NO CHANNEL IS IMPLEMENTED HERE. NOT ONE.
 * ---------------------------------------------------------------------------
 *
 * This module implements the fusion rule, the binding, and the transcript
 * format. It implements no optical presence reader, no ultrasonic modem and no
 * ranging stack, and nothing in this repository has ever measured a physical
 * presence signal:
 *
 *   - **Ranging.** No browser exposes a UWB API at all. There is no ranging
 *     code here and no platform surface to build one on from a web page.
 *   - **Acoustic.** There is no acoustic code in this repository — no
 *     AudioContext, no oscillator, no encoder and no decoder. ADR-007 records
 *     the design; nothing implements it.
 *   - **Optical.** rvQR's optical transport exists and measures nothing about
 *     presence. A photograph of a screen is exactly the substitution ADR-023
 *     §2.2 names, and no reader here can tell one from a screen.
 *
 * The consequence is deliberate and load-bearing: **every channel takes its
 * answer from an injected reader, and there are none.** `opts.readers[channel]`
 * is supplied by a caller that actually has that hardware; with no such
 * function the channel is `unread`, which cannot pass and therefore cannot
 * corroborate. It is the rule attest.js applies to `verifyChain` and
 * provenance.js applies to `sha256` — a check that cannot run reports that it
 * could not run, and never degrades into a pass. So on this platform, today,
 * `corroborated` is unreachable, and **a caller supplying a reader is supplying
 * a simulation.** `describeChannels()` says so from inside the running system.
 *
 * **The relay attack is reasoned about here and has not been measured.**
 * ADR-023 §4.4 asks for two devices, two rooms and a relay in between, and a
 * report of which channels it defeats. That needs hardware and two rooms.
 * `describeRelayRequirement()` states which channels a relay would have to
 * defeat simultaneously as a property of the fusion rule, and labels itself
 * `reasoning` rather than `measurement`, because nothing here has observed a
 * relay and saying otherwise would be the over-claim ADR-023 §3 warns about.
 *
 * ---------------------------------------------------------------------------
 * AVAILABLE, ATTEMPTED AND PASSED ARE THREE DIFFERENT THINGS — ADR-023 §2.3
 * ---------------------------------------------------------------------------
 *
 * Most device pairs will have one or two of the three, so the transcript
 * carries all three channels on every state, each with three separate booleans:
 *
 *   available   the pair DECLARED this channel exists on both ends. A claim by
 *               the device, recorded and never decided on.
 *   attempted   a signal actually arrived on this channel this session.
 *   passed      it was readable, bound, fresh, and a reader said yes.
 *
 * They are not derived from one another in the direction that would be
 * convenient. An available channel that was never attempted is not a pass; a
 * channel attempted on a pair that never declared it is recorded as exactly
 * that discrepancy rather than being quietly upgraded to available; and an
 * absent channel is absent, never assumed-good — the rule ADR-020 §2 and
 * ADR-021 §2.3 both state. Because the requirement check reads `passed` and
 * never `available`, a report that lies about its availability gains nothing.
 *
 * ---------------------------------------------------------------------------
 * REPLAY — ADR-023 §2.1, the rule ADR-007 §2.4 gives for control frames
 * ---------------------------------------------------------------------------
 *
 * A recording of a physical signal is a perfectly valid physical signal. A
 * photographed QR, a recorded acoustic response and a recorded ranging exchange
 * are all genuine, and all three are refused the same way: every signal names
 * the session id and echoes a challenge issued for THAT CHANNEL in THAT
 * session, and a challenge already spent on a channel is refused a second time.
 * Per-channel challenges rather than one shared challenge, so a recording
 * captured off one channel cannot be presented as another — and a signal that
 * names a different channel from the one it arrived on is refused outright.
 *
 * A refusing outcome on ANY channel refuses the whole fusion, rather than
 * merely failing to contribute a pair. Someone presenting a recording into a
 * live session is an attack in progress, not a missing channel, and treating it
 * as a shrug would let an attacker replay one channel for free. The cost is
 * stated in `describeLimits()`: it hands a jammer a denial of activation, which
 * is the trade ADR-007 §2.4 already accepts for the acoustic channel.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network, no audio, no camera and no clock — the session id, the per-channel
 * challenges, the spent lists and the readers are all passed in, so the tests
 * are deterministic and a verdict reached twice from the same report is the
 * same verdict. Trust asymmetry follows provenance.js and attest.js:
 * `parseReport()` never throws, because its input arrived from whatever is on
 * the other end of the link.
 *
 * Browser: load this file; it needs nothing else.
 * Node:    require('./presence.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRPresence = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- The three channels ----------------------------------------------------
  // ADR-023 §1's three, as FORMAT values only. See the docblock: none of them is
  // implemented here and none has ever measured anything.

  var CHANNEL_OPTICAL = 'optical';
  var CHANNEL_ACOUSTIC = 'acoustic';
  var CHANNEL_RANGING = 'ranging';
  var CHANNELS = [CHANNEL_OPTICAL, CHANNEL_ACOUSTIC, CHANNEL_RANGING];

  var CHANNEL_LABELS = {
    'optical': 'optical line-of-sight',
    'acoustic': 'ultrasonic challenge-response',
    'ranging': 'radio ranging'
  };

  /** What each channel measures, and what it does not — ADR-023 §2.2. */
  var CHANNEL_ALONE = {
    'optical': 'a screen was seen, which is exactly what substitution arranges',
    'acoustic': 'something acoustically present answered, and a speaker in the room answers',
    'ranging': 'something is at a measured distance, which is not the device on the screen'
  };

  // --- Corroboration is a pair relation, not a count -------------------------
  // Built from every combination of two DISTINCT channels. There is no number
  // here to tune: a self-pair is not constructible from i < j, and nothing in
  // this module compares a tally against a bound.

  var CORROBORATING_PAIRS = (function () {
    var pairs = [];
    for (var i = 0; i < CHANNELS.length; i++) {
      for (var j = i + 1; j < CHANNELS.length; j++) {
        pairs.push([CHANNELS[i], CHANNELS[j]]);
      }
    }
    return pairs;
  })();

  // --- Per-channel outcomes --------------------------------------------------
  // Closed. What happened on one channel, and only one of these can pass.

  /** Readable, bound to this session and this challenge, and a reader said yes. */
  var OUTCOME_PASSED = 'passed';

  /** No signal arrived on this channel. Absent is absent — ADR-023 §2.3. */
  var OUTCOME_ABSENT = 'absent';

  /** A signal arrived and could not be read as a signal. */
  var OUTCOME_MALFORMED = 'malformed';

  /** Readable, but not bound to this session, this challenge and this channel. */
  var OUTCOME_UNBOUND = 'unbound';

  /** Bound to a challenge already spent on this channel. A recording. */
  var OUTCOME_REPLAYED = 'replayed';

  /** No reader was supplied for this channel, or it could not reach an answer. */
  var OUTCOME_UNREAD = 'unread';

  /** A reader ran and said the signal was not genuine. */
  var OUTCOME_FORGED = 'forged';

  var OUTCOMES = [
    OUTCOME_PASSED, OUTCOME_ABSENT, OUTCOME_MALFORMED, OUTCOME_UNBOUND,
    OUTCOME_REPLAYED, OUTCOME_UNREAD, OUTCOME_FORGED
  ];

  // --- The fused verdict vocabulary ------------------------------------------
  // Closed, and the gate switches over it exhaustively. A state outside this
  // list is refused as unknown rather than falling through — ADR-035 §2.1's
  // rule, as ADR-021 §4.2 applies it one module over.

  /** Some pair of distinct channels both passed. The only presence claim. */
  var STATE_CORROBORATED = 'corroborated';

  /** Something passed, but no pair did. What one perfect channel reaches. */
  var STATE_UNCORROBORATED = 'uncorroborated';

  /** Nothing was attempted at all. A state, not a failure. */
  var STATE_ABSENT = 'absent';

  var STATE_MALFORMED = 'malformed';
  var STATE_UNBOUND = 'unbound';
  var STATE_REPLAYED = 'replayed';
  var STATE_FORGED = 'forged';

  var STATES = [
    STATE_CORROBORATED, STATE_UNCORROBORATED, STATE_ABSENT, STATE_MALFORMED,
    STATE_UNBOUND, STATE_REPLAYED, STATE_FORGED
  ];

  /**
   * Which refusing outcome becomes the fused headline when several channels
   * fail differently. Precedence is for the HEADLINE ONLY — the transcript
   * carries every channel's own outcome, so nothing is hidden by this order.
   *
   * `unread` and `absent` are deliberately not in this list: neither is an
   * attack signal, and on this platform every channel is `unread`, so treating
   * it as a refusal would turn the ordinary state into an alarm.
   */
  var REFUSING_PRECEDENCE = [OUTCOME_REPLAYED, OUTCOME_FORGED, OUTCOME_UNBOUND, OUTCOME_MALFORMED];

  var OUTCOME_TO_STATE = {};
  OUTCOME_TO_STATE[OUTCOME_REPLAYED] = STATE_REPLAYED;
  OUTCOME_TO_STATE[OUTCOME_FORGED] = STATE_FORGED;
  OUTCOME_TO_STATE[OUTCOME_UNBOUND] = STATE_UNBOUND;
  OUTCOME_TO_STATE[OUTCOME_MALFORMED] = STATE_MALFORMED;

  // --- Decision codes --------------------------------------------------------

  var CODE_PENDING = 'pending';
  var CODE_POLICY_UNDECLARED = 'policy-undeclared';
  var CODE_POLICY_INCOHERENT = 'policy-incoherent';
  var CODE_UNKNOWN_STATE = 'unknown-presence-state';
  var CODE_ABSENT_REFUSED = 'absent-refused';
  var CODE_UNCORROBORATED_REFUSED = 'uncorroborated-refused';
  var CODE_MALFORMED = 'malformed-signal';
  var CODE_UNBOUND = 'unbound-signal';
  var CODE_REPLAYED = 'replayed-signal';
  var CODE_FORGED = 'forged-signal';
  var CODE_MISSING_CORROBORATION = 'missing-corroboration';
  var CODE_CHANNEL_REQUIRED = 'required-channel-did-not-pass';
  var CODE_CAPABILITY_REFUSED = 'capability-refused';
  var CODE_CORROBORATED_AND_APPROVED = 'corroborated-and-approved';
  var CODE_PRESENCE_NOT_REQUIRED = 'presence-not-required';

  // --- Rules -----------------------------------------------------------------

  var RULE_CORROBORATION = 'corroboration';
  var RULE_CHANNEL = 'required-channel';

  /** Kept apart from the two above because it is the authoritative one. */
  var RULE_CAPABILITY = 'capability';

  // --- Artifact classes ------------------------------------------------------
  // The same closed vocabulary attest.js uses, restated rather than imported:
  // this module depends on nothing, and a shared list would be a dependency
  // between two files that must both stand alone in a browser. The two agree by
  // construction and a test asserts the list.

  var CLASS_AGENT = 'agent';
  var CLASS_CREDENTIAL = 'credential';
  var CLASS_MODEL = 'model';
  var CLASS_CONTAINER = 'container';
  var CLASS_GENERIC = 'generic';
  var ARTIFACT_CLASSES = [CLASS_AGENT, CLASS_CREDENTIAL, CLASS_MODEL, CLASS_CONTAINER, CLASS_GENERIC];

  // --- Hostile-input ceilings ------------------------------------------------
  // A presence report arrives from the device this whole mechanism exists to be
  // unsure about. Every value below bounds something that device controls.

  var LIMITS = {
    identifier: 256,
    sessionId: 64,
    challenge: 128,
    declaredChannels: 8,
    spentChallenges: 4096,
    grants: 1024
  };

  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

  function isString(v) {
    return typeof v === 'string';
  }

  function isIdentifier(v, max) {
    return isString(v) && v.length > 0 && v.length <= max && ID_RE.test(v);
  }

  function isChannel(v) {
    return CHANNELS.indexOf(v) >= 0;
  }

  // ---------------------------------------------------------------------------
  // The report — reading it, and refusing it without throwing
  // ---------------------------------------------------------------------------

  /**
   * Reads one channel's signal. Returns { ok, signal, reason } and never
   * throws.
   *
   * `key` is the channel the signal arrived under and `input.channel` is the
   * channel it claims to be. They must agree: a recorded acoustic response
   * presented on the optical channel is a recording moved between channels, and
   * it is refused where it is read rather than being handed to the wrong reader.
   */
  function parseSignal(key, input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no signal was supplied' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'the signal is not an object' };
    }
    if (!isChannel(input.channel)) {
      return {
        ok: false,
        reason: 'the signal names channel ' + JSON.stringify(String(input.channel).slice(0, 40)) +
          ', which is not one of ' + CHANNELS.join(', ')
      };
    }
    if (input.channel !== key) {
      return {
        ok: false,
        reason: 'the signal names channel ' + JSON.stringify(input.channel) + ' and arrived on ' +
          JSON.stringify(key) + '; a recording moved between channels is refused where it is read'
      };
    }
    if (!isIdentifier(input.sessionId, LIMITS.sessionId)) {
      return { ok: false, reason: 'sessionId is missing or is not an identifier' };
    }
    if (!isIdentifier(input.challenge, LIMITS.challenge)) {
      return { ok: false, reason: 'challenge is missing or is not an identifier' };
    }
    return {
      ok: true,
      signal: {
        channel: input.channel,
        sessionId: input.sessionId,
        challenge: input.challenge
      }
    };
  }

  /**
   * Reads the container: what the pair DECLARES it can do, and what it actually
   * sent. The per-channel signals are left to `parseSignal` so that one broken
   * signal does not erase the other two from the transcript.
   *
   * `available` is a claim by the device and is treated as one. It is recorded
   * and never decided on: nothing downstream reads it, because a report that
   * lies about its availability must gain nothing by it.
   */
  function parseReport(input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no presence report was supplied' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'the presence report is not an object' };
    }

    var declared = input.available;
    if (declared !== undefined && declared !== null && !Array.isArray(declared)) {
      return { ok: false, reason: 'available must be an array, even an empty one' };
    }
    var list = Array.isArray(declared) ? declared : [];
    if (list.length > LIMITS.declaredChannels) {
      return {
        ok: false,
        reason: 'available declares ' + list.length + ' channels, over the limit of ' + LIMITS.declaredChannels
      };
    }
    var available = [];
    for (var i = 0; i < list.length; i++) {
      if (!isChannel(list[i])) {
        return {
          ok: false,
          reason: 'available names channel ' + JSON.stringify(String(list[i]).slice(0, 40)) +
            ', which is not one of ' + CHANNELS.join(', ')
        };
      }
      if (available.indexOf(list[i]) < 0) available.push(list[i]);
    }

    var offered = input.signals;
    if (offered !== undefined && offered !== null &&
        (typeof offered !== 'object' || Array.isArray(offered))) {
      return { ok: false, reason: 'signals must be an object keyed by channel' };
    }
    var signals = {};
    if (offered) {
      var keys = Object.keys(offered);
      if (keys.length > LIMITS.declaredChannels) {
        return { ok: false, reason: 'signals carries ' + keys.length + ' keys, over the limit of ' + LIMITS.declaredChannels };
      }
      for (var k = 0; k < keys.length; k++) {
        if (!isChannel(keys[k])) {
          return {
            ok: false,
            reason: 'signals carries a channel ' + JSON.stringify(String(keys[k]).slice(0, 40)) +
              ' that is not one of ' + CHANNELS.join(', ')
          };
        }
        signals[keys[k]] = offered[keys[k]];
      }
    }

    // A set, so two pairs declaring the same channels in different orders
    // produce the same report.
    available.sort();
    return { ok: true, report: { available: available, signals: signals } };
  }

  // ---------------------------------------------------------------------------
  // The verifier — a verdict, and nothing that resembles a permission
  // ---------------------------------------------------------------------------

  function channelRecord(channel, over) {
    var o = over || {};
    return {
      channel: channel,
      // Three separate facts. None is derived from another in the direction
      // that would be convenient — ADR-023 §2.3.
      available: o.available === true,
      attempted: o.attempted === true,
      passed: o.outcome === OUTCOME_PASSED,
      outcome: o.outcome,
      reason: o.reason || '',
      binding: o.binding || {
        sessionMatched: false, challengeMatched: false, spent: false, spentOverflow: false
      },
      read: o.read === undefined ? null : o.read
    };
  }

  /** Whether the sender's spent list for a channel can answer the question. */
  function spentListFor(expected, channel) {
    var spent = expected && expected.spent;
    if (!spent || typeof spent !== 'object' || Array.isArray(spent)) return [];
    var list = spent[channel];
    return Array.isArray(list) ? list : [];
  }

  /**
   * One channel, start to finish: was it declared, did anything arrive, was it
   * readable, was it bound to this session and this challenge, was the challenge
   * already spent, and did a reader say yes.
   */
  function verifyChannel(channel, report, expected, readers) {
    var available = report.available.indexOf(channel) >= 0;
    var raw = report.signals[channel];

    if (raw === undefined || raw === null) {
      return channelRecord(channel, {
        available: available, attempted: false, outcome: OUTCOME_ABSENT,
        reason: available
          ? 'This pair declared ' + CHANNEL_LABELS[channel] + ' and offered nothing on it. ' +
            'A declared channel that was never attempted is not a channel that passed.'
          : 'Nothing was offered on ' + CHANNEL_LABELS[channel] + ', and the pair did not declare it. ' +
            'Absent is absent, never assumed-good.'
      });
    }

    var parsed = parseSignal(channel, raw);
    if (!parsed.ok) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_MALFORMED,
        reason: 'A signal arrived on ' + CHANNEL_LABELS[channel] + ' and could not be read: ' + parsed.reason + '.'
      });
    }
    var signal = parsed.signal;

    var sessionMatched = isIdentifier(expected.sessionId, LIMITS.sessionId) &&
      expected.sessionId === signal.sessionId;
    var wanted = expected.challenges && typeof expected.challenges === 'object' &&
      !Array.isArray(expected.challenges) ? expected.challenges[channel] : null;
    var challengeMatched = isIdentifier(wanted, LIMITS.challenge) && wanted === signal.challenge;

    var spentList = spentListFor(expected, channel);
    // The same rule attest.js reaches for the consumed-nonce list: a list too
    // long to search cannot answer the question, and reporting a pass would be
    // reporting the absence of a search as the absence of a replay.
    var spentOverflow = spentList.length > LIMITS.spentChallenges;
    var spent = !spentOverflow && spentList.indexOf(signal.challenge) >= 0;

    var binding = {
      sessionMatched: sessionMatched,
      challengeMatched: challengeMatched,
      spent: spent,
      spentOverflow: spentOverflow
    };

    if (!sessionMatched || !challengeMatched) {
      var why = [];
      if (!sessionMatched) {
        why.push('it names session ' + JSON.stringify(signal.sessionId) + ' where this activation is ' +
          JSON.stringify(isIdentifier(expected.sessionId, LIMITS.sessionId) ? expected.sessionId : null));
      }
      if (!challengeMatched) {
        why.push('it echoes challenge ' + JSON.stringify(signal.challenge) + ' where this channel issued ' +
          JSON.stringify(isIdentifier(wanted, LIMITS.challenge) ? wanted : null));
      }
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_UNBOUND, binding: binding,
        reason: 'This ' + CHANNEL_LABELS[channel] + ' signal is not bound to this activation: ' +
          why.join(', ') + '. A recording of a physical signal is a perfectly valid physical signal, ' +
          'so binding is the check that matters.'
      });
    }

    if (spentOverflow) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_REPLAYED, binding: binding,
        reason: 'This sender has recorded ' + spentList.length + ' spent challenges on ' +
          CHANNEL_LABELS[channel] + ', past the ' + LIMITS.spentChallenges + ' this module will search, ' +
          'so whether challenge ' + JSON.stringify(signal.challenge) + ' was already spent CANNOT BE ' +
          'DETERMINED. An undetermined replay check is refused rather than passed.'
      });
    }

    if (spent) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_REPLAYED, binding: binding,
        reason: 'Challenge ' + JSON.stringify(signal.challenge) + ' has already been spent on ' +
          CHANNEL_LABELS[channel] + ', so this is a second presentation of a signal that was answered once.'
      });
    }

    var reader = readers && typeof readers[channel] === 'function' ? readers[channel] : null;
    if (!reader) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_UNREAD, binding: binding, read: null,
        reason: 'No reader was supplied for ' + CHANNEL_LABELS[channel] + ', so nothing checked whether ' +
          'this signal was genuine. Nothing in rvQR implements any of the three channels; a check that ' +
          'cannot run says it could not run.'
      });
    }

    var read;
    try {
      read = reader(signal);
    } catch (err) {
      // Deliberately NOT mapped onto a pass and NOT onto the channel's absent
      // state. A reader that failed is a check that did not happen.
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_UNREAD, binding: binding, read: null,
        reason: 'The ' + CHANNEL_LABELS[channel] + ' reader failed: ' +
          (err && err.message ? err.message : String(err)) + '.'
      });
    }

    if (read === true) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_PASSED, binding: binding, read: true,
        reason: 'The ' + CHANNEL_LABELS[channel] + ' reader accepted this signal, bound to this session ' +
          'and this challenge. Alone that means only that ' + CHANNEL_ALONE[channel] + '.'
      });
    }
    if (read === false) {
      return channelRecord(channel, {
        available: available, attempted: true, outcome: OUTCOME_FORGED, binding: binding, read: false,
        reason: 'The ' + CHANNEL_LABELS[channel] + ' reader rejected this signal.'
      });
    }
    return channelRecord(channel, {
      available: available, attempted: true, outcome: OUTCOME_UNREAD, binding: binding, read: null,
      reason: 'The ' + CHANNEL_LABELS[channel] + ' reader returned ' + JSON.stringify(read) +
        ' rather than a verdict, so nothing was established.'
    });
  }

  /**
   * Every pair of DISTINCT channels that both passed.
   *
   * This is the whole of ADR-023 §2.2. It is a filter over a fixed pair list and
   * not a tally against a bound, so there is nothing here to set to one.
   */
  function passingPairs(channels) {
    var passed = {};
    channels.forEach(function (c) { if (c.passed) passed[c.channel] = true; });
    return CORROBORATING_PAIRS.filter(function (pair) {
      return passed[pair[0]] === true && passed[pair[1]] === true;
    });
  }

  /**
   * The verdict object. Note what is absent: there is no `admit`, no `allow`,
   * no `ok` and no `present` — nothing a caller could read as permission.
   * `state` is the whole answer and the gate is the only thing entitled to act
   * on it.
   *
   * `pairs` is published ONLY on `corroborated`. The gate reads that list rather
   * than recomputing corroboration from the channel records, so a hand-built
   * verdict claiming the state without the pairs behind it is refused on the
   * corroboration rule instead of clearing the bar on a string.
   */
  function verdictFor(state, reason, facts) {
    var f = facts || {};
    return {
      state: state,
      reason: reason,
      sessionId: f.sessionId === undefined ? null : f.sessionId,
      reportPresented: f.reportPresented === true,
      channels: f.channels || CHANNELS.map(function (c) {
        return channelRecord(c, { outcome: OUTCOME_ABSENT, reason: 'nothing was offered on this channel' });
      }),
      pairs: state === STATE_CORROBORATED ? (f.pairs || []) : []
    };
  }

  /**
   * Reads a presence report into a verdict.
   *
   * `expected` is the sender's side of the binding — { sessionId, challenges,
   * spent } — and is the only outside data this function takes. There is no
   * policy in this argument list, by construction: the verifier has nothing to
   * decide with and therefore cannot decide.
   *
   * `opts.readers[channel](signal) -> true | false | null` is the physical
   * check, supplied by a caller that has that hardware. There are none, so with
   * no readers every channel is `unread`, nothing passes, no pair forms, and
   * `corroborated` is unreachable.
   */
  function verifyPresence(report, expected, opts) {
    var e = expected && typeof expected === 'object' && !Array.isArray(expected) ? expected : {};
    var options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    var readers = options.readers && typeof options.readers === 'object' &&
      !Array.isArray(options.readers) ? options.readers : null;
    var sessionId = isIdentifier(e.sessionId, LIMITS.sessionId) ? e.sessionId : null;

    if (report === null || report === undefined) {
      return verdictFor(STATE_ABSENT,
        'No presence report was offered. This pair measured nothing it can show, which is the ordinary ' +
        'case for two web pages. Whether that is acceptable is the sender’s policy, not a property of ' +
        'this verdict.',
        { sessionId: sessionId, reportPresented: false });
    }

    var parsed = parseReport(report);
    if (!parsed.ok) {
      return verdictFor(STATE_MALFORMED,
        'A presence report was offered and could not be read: ' + parsed.reason + '.',
        {
          sessionId: sessionId, reportPresented: true,
          channels: CHANNELS.map(function (c) {
            return channelRecord(c, {
              outcome: OUTCOME_MALFORMED,
              reason: 'the report carrying this channel could not be read: ' + parsed.reason
            });
          })
        }
      );
    }

    var channels = CHANNELS.map(function (c) {
      return verifyChannel(c, parsed.report, e, readers);
    });

    // A refusing outcome anywhere refuses the fusion. Someone presenting a
    // recording, a forgery or a signal for another session into a live
    // activation is an attack in progress, not a missing channel.
    for (var i = 0; i < REFUSING_PRECEDENCE.length; i++) {
      var outcome = REFUSING_PRECEDENCE[i];
      var offenders = channels.filter(function (c) { return c.outcome === outcome; });
      if (!offenders.length) continue;
      return verdictFor(OUTCOME_TO_STATE[outcome],
        offenders.map(function (c) { return c.reason; }).join(' ') +
        ' A refusing outcome on one channel refuses the fusion rather than merely failing to ' +
        'corroborate, so a recording cannot be presented for free alongside genuine channels.',
        { sessionId: sessionId, reportPresented: true, channels: channels });
    }

    var pairs = passingPairs(channels);
    if (pairs.length) {
      return verdictFor(STATE_CORROBORATED,
        pairs.map(function (p) {
          return CHANNEL_LABELS[p[0]] + ' and ' + CHANNEL_LABELS[p[1]];
        }).join('; ') + ' each passed for this session and their own challenge. That is three ' +
        'correlated measurements at most, each individually spoofable — it is not permission to ' +
        'activate anything.',
        { sessionId: sessionId, reportPresented: true, channels: channels, pairs: pairs });
    }

    var attempted = channels.filter(function (c) { return c.attempted; });
    if (!attempted.length) {
      return verdictFor(STATE_ABSENT,
        'A presence report was offered and nothing was attempted on any of the three channels. ' +
        'Whether that is acceptable is the sender’s policy.',
        { sessionId: sessionId, reportPresented: true, channels: channels });
    }

    var passed = channels.filter(function (c) { return c.passed; });
    return verdictFor(STATE_UNCORROBORATED,
      passed.length
        ? passed.map(function (c) { return CHANNEL_LABELS[c.channel]; }).join(' and ') +
          ' passed and no second channel corroborated it. One channel alone says only that ' +
          passed.map(function (c) { return CHANNEL_ALONE[c.channel]; }).join(', and that ') +
          ', which is a measurement an attacker can arrange.'
        : 'Channels were attempted and none of them passed, so nothing corroborates anything.',
      { sessionId: sessionId, reportPresented: true, channels: channels });
  }

  // ---------------------------------------------------------------------------
  // The policy — the sender's, and it has no threshold to set
  // ---------------------------------------------------------------------------

  /**
   * Normalises a sender policy.
   *
   * `requirePresence` is the field with no default at all. ADR-023 §2.3 says
   * the sender's policy states what it requires, so a policy that has not said
   * is reported as undeclared and refused, rather than being handed an answer
   * nobody chose — the same rule attest.js applies to `requireAttestation`.
   *
   * Every other field defaults to refusing: no grants grants nothing. And every
   * field a caller invents is DROPPED rather than carried, which is what stops
   * a `minChannels: 1` from ever reaching the fusion rule: this function returns
   * a fixed set of keys and none of them is a number.
   */
  function normalizePolicy(policy) {
    var p = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
    var out = {
      declared: p.requirePresence === true || p.requirePresence === false,
      requirePresence: p.requirePresence === true,
      requiredChannels: [],
      grants: []
    };

    var required = Array.isArray(p.requiredChannels) ? p.requiredChannels : [];
    for (var i = 0; i < required.length && out.requiredChannels.length < CHANNELS.length; i++) {
      if (isChannel(required[i]) && out.requiredChannels.indexOf(required[i]) < 0) {
        out.requiredChannels.push(required[i]);
      }
    }
    out.requiredChannels.sort();

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

  function normalizeRequest(request) {
    var r = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
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
      corroboratedBy: e.corroboratedBy || []
    };
  }

  /**
   * Stage one: what the fused state alone permits. Total over the vocabulary,
   * and an unrecognised state fails closed.
   *
   * `uncorroborated` never clears the bar under a sender that requires
   * presence, and that is ADR-023 §2.2 in one line: the state one perfect
   * channel reaches is the state that refuses. Under a sender that does NOT
   * require presence it clears the bar exactly as `absent` does — because the
   * sender is not relying on presence at all, and a partial report must not be
   * treated as worse than no report, which would only teach devices to send
   * nothing. The two are still told apart in the receipt.
   *
   * `pass` here means only "the evidence bar is clear". It is not an admission;
   * two more stages follow and one of them is never skipped.
   */
  function presenceGate(policy, state) {
    switch (state) {
      case STATE_CORROBORATED:
        return { pass: true };
      case STATE_UNCORROBORATED:
        if (policy.requirePresence) {
          return {
            pass: false, code: CODE_UNCORROBORATED_REFUSED,
            reason: 'No two channels corroborate one another. One channel alone is a measurement an ' +
              'attacker can arrange, and ADR-023 §2.2 does not have a setting that would accept it.'
          };
        }
        return { pass: true };
      case STATE_ABSENT:
        if (policy.requirePresence) {
          return {
            pass: false, code: CODE_ABSENT_REFUSED,
            reason: 'This sender requires corroborated presence and this pair measured nothing.'
          };
        }
        return { pass: true };
      case STATE_MALFORMED:
        return {
          pass: false, code: CODE_MALFORMED,
          reason: 'A presence signal was offered and could not be read. Unreadable evidence is refused, ' +
            'not treated as the absence of evidence — a pair that tried and failed is not a pair that never tried.'
        };
      case STATE_UNBOUND:
        return {
          pass: false, code: CODE_UNBOUND,
          reason: 'A presence signal is not bound to this session, this challenge and this channel.'
        };
      case STATE_REPLAYED:
        return {
          pass: false, code: CODE_REPLAYED,
          reason: 'A challenge presented here has already been spent, or could not be checked against the spent list.'
        };
      case STATE_FORGED:
        return {
          pass: false, code: CODE_FORGED,
          reason: 'A reader rejected a presence signal.'
        };
      default:
        return {
          pass: false, code: CODE_UNKNOWN_STATE,
          reason: 'Unrecognised presence state: ' + JSON.stringify(state) +
            '. A presence state this build does not know is refused rather than interpreted.'
        };
    }
  }

  /**
   * Stage two, on `corroborated` only: the corroboration the verdict actually
   * carries, and the channels this sender named.
   *
   * The corroboration rule reads `verdict.pairs` — the list the verifier
   * published — and checks that both members of some pair are distinct channels
   * that the verdict records as passed. A verdict that says `corroborated` and
   * carries nothing behind it fails here, so the state string is not enough on
   * its own.
   *
   * The channel rule reads `passed` and never `available`, so a report that
   * declares three channels and attempts one gains nothing by the declaration.
   */
  function unmetRequirements(policy, verdict) {
    var unmet = [];
    var records = Array.isArray(verdict.channels) ? verdict.channels : [];
    var passed = {};
    records.forEach(function (c) {
      if (c && c.passed === true && isChannel(c.channel)) passed[c.channel] = true;
    });

    var pairs = Array.isArray(verdict.pairs) ? verdict.pairs : [];
    var good = pairs.filter(function (pair) {
      return Array.isArray(pair) && pair.length === 2 &&
        isChannel(pair[0]) && isChannel(pair[1]) && pair[0] !== pair[1] &&
        passed[pair[0]] === true && passed[pair[1]] === true;
    });
    if (!good.length) {
      unmet.push({
        rule: RULE_CORROBORATION,
        reason: 'this verdict names no pair of distinct channels that both passed, so nothing corroborates ' +
          'anything — and no single channel may authorize activation on its own'
      });
    }

    policy.requiredChannels.forEach(function (channel) {
      if (passed[channel] === true) return;
      var record = null;
      records.forEach(function (c) { if (c && c.channel === channel) record = c; });
      unmet.push({
        rule: RULE_CHANNEL,
        channel: channel,
        reason: record
          ? 'this sender requires ' + CHANNEL_LABELS[channel] + ' and it is ' + record.outcome +
            ' on this pair (declared available: ' + record.available + ', attempted: ' + record.attempted + ')'
          : 'this sender requires ' + CHANNEL_LABELS[channel] + ' and this verdict records nothing about it'
      });
    });

    return unmet;
  }

  /**
   * Stage three: the authoritative one.
   *
   * This is the check ADR-023 §2.2 says presence is an input to and never a
   * substitute for. It runs on EVERY path that can admit, corroborated or not:
   * a sender that does not require presence has relaxed its evidence bar, not
   * its authority model, and a grant table that the not-required path could
   * skip would make "no presence" the widest permission in the system.
   *
   * The subject is the pinned peer of ADR-035 and never anything the presence
   * report claimed. Presence measures where something is; it establishes no
   * identity at all, so there is nothing on a verdict that could name a subject.
   */
  function capabilityDecision(policy, request) {
    if (request.artifactClass === null) {
      return {
        allow: false, subject: request.peerId,
        reason: 'this activation names no artifact class, and no grant covers an unnamed class'
      };
    }
    if (request.peerId === null) {
      return {
        allow: false, subject: null,
        reason: 'no identity was established for this peer — presence measures where something is and ' +
          'never who it is — and a grant is made to an identity rather than to a room'
      };
    }
    for (var i = 0; i < policy.grants.length; i++) {
      if (policy.grants[i].device !== request.peerId) continue;
      if (policy.grants[i].classes.indexOf(request.artifactClass) >= 0) {
        return {
          allow: true, subject: request.peerId,
          reason: request.peerId + ' is granted artifacts of class ' + request.artifactClass
        };
      }
      return {
        allow: false, subject: request.peerId,
        reason: request.peerId + ' holds a grant, but not for an artifact of class ' + request.artifactClass
      };
    }
    return {
      allow: false, subject: request.peerId,
      reason: 'no capability grant names ' + request.peerId +
        '. A device may be measurably, corroboratedly in the room and still be the wrong device to activate this on'
    };
  }

  /**
   * May this artifact be activated on this peer?
   *
   * Same shape as `attest.admitTransfer` and `core.admitArtifact` — a policy and
   * a verdict in, an { admit, code, reason } out — pure and total for the same
   * reason: so the rule can be tested exhaustively and no other path can reach
   * around it.
   *
   * The argument list carries no report, only the verdict, so this function
   * cannot be told anything the verifier did not establish. And there is exactly
   * one `admit: true` in it, at the bottom, after `capabilityDecision`.
   */
  function admitActivation(policy, verdict, request) {
    var p = normalizePolicy(policy);
    var req = normalizeRequest(request);

    if (!p.declared) {
      return refusal(CODE_POLICY_UNDECLARED,
        'This policy has not stated whether it requires physical presence. What a sender requires is ' +
        'the sender’s decision — there is no default to fall back on.');
    }

    // Two statements that contradict each other. Letting one silently win would
    // mean a stated channel requirement was quietly ignored, which is the
    // failure mode a security setting must never have.
    if (p.requiredChannels.length && !p.requirePresence) {
      return refusal(CODE_POLICY_INCOHERENT,
        'This policy names ' + p.requiredChannels.join(', ') + ' as required while stating that presence ' +
        'is not required. Those are two different answers to the same question, and neither is allowed ' +
        'to silently win.');
    }

    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) || !verdict.state) {
      return refusal(CODE_PENDING, 'The presence check has not completed yet.');
    }

    var gate = presenceGate(p, verdict.state);
    if (!gate.pass) return refusal(gate.code, gate.reason);

    var unmet = [];
    if (verdict.state === STATE_CORROBORATED) {
      unmet = unmetRequirements(p, verdict);
    }
    if (unmet.length) {
      return refusal(
        unmet[0].rule === RULE_CORROBORATION ? CODE_MISSING_CORROBORATION : CODE_CHANNEL_REQUIRED,
        unmet[0].reason, { unmet: unmet });
    }

    var capability = capabilityDecision(p, req);
    if (!capability.allow) {
      return refusal(CODE_CAPABILITY_REFUSED, capability.reason, {
        unmet: [{ rule: RULE_CAPABILITY, reason: capability.reason }],
        subject: capability.subject
      });
    }

    var corroboratedBy = verdict.state === STATE_CORROBORATED && Array.isArray(verdict.pairs)
      ? verdict.pairs.map(function (pair) { return pair.slice(); })
      : [];

    return {
      admit: true,
      code: verdict.state === STATE_CORROBORATED ? CODE_CORROBORATED_AND_APPROVED : CODE_PRESENCE_NOT_REQUIRED,
      reason: verdict.state === STATE_CORROBORATED
        ? 'Two channels corroborate one another, this sender’s required channels passed, and the ' +
          'capability policy grants it: ' + capability.reason + '.'
        : 'This sender does not require physical presence, and the capability policy grants it anyway: ' +
          capability.reason + '.',
      unmet: [],
      subject: capability.subject,
      corroboratedBy: corroboratedBy
    };
  }

  // ---------------------------------------------------------------------------
  // The transcript and the receipt — ADR-023 §2.1 and §2.3
  // ---------------------------------------------------------------------------

  /**
   * What the session transcript of ADR-012 commits to about presence.
   *
   * All three channels appear on every state, whatever happened — an absent
   * channel is a row saying it was absent, never a row that is missing. Each
   * carries `available`, `attempted` and `passed` as three separate booleans,
   * because they are three different claims and an auditor reading this later
   * has to be able to tell them apart.
   *
   * The over-claiming caveat of ADR-023 §3 is part of the record rather than
   * part of the UI, so it cannot be dropped by whatever renders it.
   */
  function presenceTranscript(verdict) {
    var v = verdict && typeof verdict === 'object' && !Array.isArray(verdict) ? verdict : {};
    var records = Array.isArray(v.channels) ? v.channels : [];
    return {
      sessionId: isString(v.sessionId) ? v.sessionId : null,
      state: isString(v.state) ? v.state : null,
      channels: CHANNELS.map(function (channel) {
        var found = null;
        records.forEach(function (c) { if (c && c.channel === channel) found = c; });
        return {
          channel: channel,
          label: CHANNEL_LABELS[channel],
          available: !!(found && found.available === true),
          attempted: !!(found && found.attempted === true),
          passed: !!(found && found.passed === true),
          outcome: found && isString(found.outcome) ? found.outcome : OUTCOME_ABSENT
        };
      }),
      corroboratedBy: (v.state === STATE_CORROBORATED && Array.isArray(v.pairs) ? v.pairs : [])
        .filter(function (pair) { return Array.isArray(pair) && pair.length === 2; })
        .map(function (pair) { return pair.slice(); }),
      caveat: 'At most three correlated measurements, each individually spoofable. This is not verified ' +
        'physical presence and a determined relay with equipment in both rooms is still possible.'
    };
  }

  /**
   * What ADR-016 §2.3's witness record carries about presence.
   *
   * The one thing this must never do is conflate "corroborated and approved"
   * with "nobody asked". Both can end in an activation proceeding and they are
   * entirely different claims, so they are carried in separate named fields and
   * the summary is built from all of them rather than from the outcome.
   */
  function presenceReceipt(verdict, decision, policy) {
    var p = normalizePolicy(policy);
    var v = verdict && typeof verdict === 'object' && !Array.isArray(verdict) ? verdict : {};
    var d = decision && typeof decision === 'object' && !Array.isArray(decision) ? decision : {};
    var transcript = presenceTranscript(v);

    var receipt = {
      presence: isString(v.state) ? v.state : null,
      reportPresented: v.reportPresented === true,
      senderRequiredPresence: p.declared ? p.requirePresence : null,
      senderRequiredChannels: p.requiredChannels.slice(),
      sessionId: transcript.sessionId,
      channels: transcript.channels,
      corroboratedBy: transcript.corroboratedBy,
      capabilitySubject: d.subject === undefined ? null : d.subject,
      decision: d.code === undefined ? null : d.code,
      admitted: d.admit === true,
      unmet: Array.isArray(d.unmet) ? d.unmet.map(function (u) { return u.rule; }) : [],
      caveat: transcript.caveat,
      summary: ''
    };

    receipt.summary = summarise(receipt);
    return receipt;
  }

  function summarise(r) {
    var passed = r.channels.filter(function (c) { return c.passed; })
      .map(function (c) { return c.channel; });
    var head;
    if (r.presence === STATE_CORROBORATED) {
      head = 'Corroborated: ' + passed.join(' and ') + ' each passed, corroborating one another';
    } else if (r.presence === STATE_UNCORROBORATED) {
      head = passed.length
        ? 'Uncorroborated: ' + passed.join(' and ') + ' passed and no second channel corroborated it'
        : 'Uncorroborated: channels were attempted and none passed';
    } else if (r.presence === STATE_ABSENT) {
      head = r.senderRequiredPresence === false
        ? 'Nobody asked: this sender does not require presence and none was measured'
        : 'Absent: no presence was measured';
    } else if (r.presence === null) {
      head = 'No presence verdict was recorded';
    } else {
      head = 'Presence ' + r.presence + ': a signal was offered and did not stand';
    }
    var tail = r.admitted
      ? 'the activation proceeded (' + r.decision + ')'
      : 'the activation was refused (' + r.decision + ')';
    return head + '; ' + tail + '.';
  }

  // ---------------------------------------------------------------------------
  // Honesty
  // ---------------------------------------------------------------------------

  /**
   * The three channels ADR-023 §1 names, and what this build has actually done
   * with each of them: nothing.
   *
   * The equivalent of `attest.describeRoots()`, and for the same reason — the
   * claim belongs inside the running system rather than only in a report nobody
   * re-reads.
   */
  function describeChannels() {
    var notes = {
      'optical': 'rvQR’s optical transport exists and measures nothing about presence. No optical ' +
        'presence reader is wired to a camera in this repository, and a photograph of a screen is ' +
        'exactly the substitution ADR-023 §2.2 names.',
      'acoustic': 'There is no acoustic code in this repository at all — no AudioContext, no ' +
        'oscillator, no encoder and no decoder. ADR-007 records the design and nothing implements it.',
      'ranging': 'No browser exposes a UWB API. There is no ranging implementation here and no ' +
        'platform surface to build one on from a web page.'
    };
    return CHANNELS.map(function (id) {
      return {
        id: id,
        label: CHANNEL_LABELS[id],
        status: 'unimplemented',
        readerSupplied: false,
        aloneEstablishes: CHANNEL_ALONE[id],
        note: notes[id] + ' Every channel takes its answer from an injected reader, so a caller ' +
          'supplying one for ' + CHANNEL_LABELS[id] + ' is supplying a simulation.'
      };
    });
  }

  /**
   * Which channels a relay would have to defeat simultaneously, as a property
   * of the fusion rule.
   *
   * This is REASONING and not MEASUREMENT, and it says so in a field. ADR-023
   * §4.4 asks for two devices, two rooms and a relay in between, and a report of
   * which channels it defeats. Nothing here has built one, so nothing here may
   * report which channels a relay defeats — only which ones it would have to,
   * for a claim to exist at all under this rule.
   */
  function describeRelayRequirement() {
    return {
      evidence: 'reasoning',
      measured: false,
      note: 'No relay has been built, run or observed by this repository. ADR-023 §4.4 asks for a ' +
        'measurement — two devices, two rooms, a relay in between — and this is not one. What follows ' +
        'is what the fusion rule implies, which is a different kind of claim.',
      pairs: CORROBORATING_PAIRS.map(function (pair) {
        return {
          pair: pair.slice(),
          mustDefeatSimultaneously: [CHANNEL_LABELS[pair[0]], CHANNEL_LABELS[pair[1]]],
          note: 'For this pair to corroborate under a relay, the relay must defeat ' +
            CHANNEL_LABELS[pair[0]] + ' and ' + CHANNEL_LABELS[pair[1]] +
            ' at the same moment, for the same session, each against its own fresh challenge.'
        };
      }),
      residual: 'A determined relay with equipment in both rooms remains possible. Fusion raises the ' +
        'cost of the attack; it does not close it, and saying otherwise would be the over-claim ' +
        'ADR-023 §3 warns about.'
    };
  }

  /**
   * Whether an environment even exposes the primitives a reader would need.
   * PRESENCE, never a demonstration, and deliberately wired into no decision.
   *
   * The environment is passed in rather than reached for, so this is testable
   * and so a page that throws on a lookup degrades to absent instead of
   * crashing a boot path.
   */
  function channelAvailability(env) {
    var out = {
      optical: { apiPresent: false, exercised: false, note: '' },
      acoustic: { apiPresent: false, exercised: false, note: '' },
      ranging: { apiPresent: false, exercised: false, note: '' }
    };
    var g = null;
    try {
      g = env || (typeof globalThis !== 'undefined' ? globalThis : null);
    } catch (e) {
      g = null;
    }
    try {
      out.optical.apiPresent = !!(g && g.navigator && g.navigator.mediaDevices);
    } catch (e2) {
      out.optical.apiPresent = false;
    }
    try {
      out.acoustic.apiPresent = !!(g && (typeof g.AudioContext !== 'undefined' ||
        typeof g.webkitAudioContext !== 'undefined'));
    } catch (e3) {
      out.acoustic.apiPresent = false;
    }

    out.optical.note = out.optical.apiPresent
      ? 'This environment exposes a camera API. That is an API being present, not a presence having ' +
        'been measured: nothing here reads a camera and nothing reads this result.'
      : 'This environment exposes no camera API, so an optical presence reader could not be built here at all.';
    out.acoustic.note = out.acoustic.apiPresent
      ? 'This environment exposes Web Audio, which could in principle carry an ultrasonic challenge and ' +
        'does not here. No tone has been emitted or decoded by this repository.'
      : 'This environment exposes no Web Audio, so an ultrasonic reader could not be built here at all.';
    out.ranging.note = 'No browser exposes any UWB or ranging API, so there is no name to look for. ' +
      'This is false by construction rather than by detection.';
    return out;
  }

  /**
   * Which of ADR-023 §4's acceptance criteria this module can carry, and which
   * it cannot — stated here rather than left to a reader to infer from what is
   * missing.
   */
  function describeAcceptance() {
    return [
      {
        criterion: 1, status: 'covered',
        note: 'No channel authorizes alone. Corroboration is a pair relation over distinct channels ' +
          'with no threshold to set, and three tests supply a perfect signal on one channel and nothing ' +
          'on the others.'
      },
      {
        criterion: 2, status: 'covered',
        note: 'Every signal is bound to the session id and to a challenge issued for that channel, and ' +
          'a spent challenge is refused a second time. One test per channel, plus one for a recording ' +
          'moved between channels.'
      },
      {
        criterion: 3, status: 'covered',
        note: 'All three channels appear in the transcript and the receipt on every state, with ' +
          'available, attempted and passed as three separate booleans.'
      },
      {
        criterion: 4, status: 'unmet',
        note: 'A relay attempt has NOT been measured. It needs two devices, two rooms and a relay in ' +
          'between, which is hardware this repository does not have. describeRelayRequirement() states ' +
          'which channels a relay would have to defeat simultaneously and labels itself reasoning.'
      },
      {
        criterion: 5, status: 'covered',
        note: 'Degradation is tested on pairs missing one channel and missing two, and a policy that ' +
          'has not stated its requirement is refused rather than defaulted.'
      },
      {
        criterion: 6, status: 'unmet',
        note: 'No UI is wired to this module, so there is no wording to review against the over-claiming ' +
          'risk. The transcript carries the caveat itself so that whatever is eventually written cannot ' +
          'quietly drop it.'
      }
    ];
  }

  /**
   * What this module is not entitled to claim, kept here so the wording in the
   * UI cannot drift from what the code does.
   */
  function describeLimits() {
    return [
      'Presence is evidence, never authorization. verifyPresence returns a verdict and admitActivation decides; the capability policy is authoritative and every admission passes through it, including the path where the sender did not require presence.',
      'No single channel may authorize alone, and that is enforced as a pair relation over distinct channels rather than as a count. There is no threshold in this module or in the policy it reads, because a number that can be set to 2 can be set to 1.',
      'None of the three channels — optical presence, ultrasonic challenge-response, radio ranging — is implemented. No browser exposes a UWB API, no acoustic code exists in this repository, and the optical transport measures nothing about presence.',
      'Every channel takes its answer from an injected reader and there are none, so on this platform corroborated is unreachable and a caller supplying a reader is supplying a simulation.',
      'A relay attempt has not been measured. Nothing here has built two rooms and a relay, so nothing here reports which channels a relay defeats — only which ones it would have to defeat simultaneously, which is reasoning and is labelled as such.',
      'A determined relay with equipment in both rooms remains possible. Fusion raises the cost of the attack and does not close it, and three correlated measurements, each individually spoofable, must never be rendered as verified physical presence.',
      'A refusing outcome on any one channel refuses the whole fusion, which hands a jammer or a replay attacker a denial of activation. That trade is deliberate — a recording presented into a live session is an attack in progress rather than a missing channel — and it is the same trade ADR-007 §2.4 accepts for the acoustic channel.',
      'Availability is a claim by the device pair. It is recorded and never decided on: the requirement check reads passed and never available, so a report that declares three channels and attempts one gains nothing.',
      'No distance and no direction is measured or recorded here, so ADR-023 §3’s ranging privacy cost is not yet incurred — it will be the moment a real ranging reader supplies a value, and that belongs in the same privacy discussion as ADR-021.',
      'Presence establishes no identity. It measures where something is and never who it is, so the capability subject is the pinned peer key of ADR-035, which still lives in localStorage and is a weak binding.',
      'Binding is checked here as a plain field comparison. In a real channel the challenge is inside the measurement — a tone that answers, a ranging exchange that completes — so binding and reading would be one check and not two, and that is exactly the part no reader implements.',
      'The UI wording of ADR-023 §4.6 has not been reviewed, because nothing is wired to a UI. The transcript carries the caveat itself so that whatever is eventually written cannot quietly drop it.'
    ];
  }

  return {
    // the three channels — names in a format, not implementations
    CHANNEL_OPTICAL: CHANNEL_OPTICAL,
    CHANNEL_ACOUSTIC: CHANNEL_ACOUSTIC,
    CHANNEL_RANGING: CHANNEL_RANGING,
    CHANNELS: CHANNELS,
    CHANNEL_LABELS: CHANNEL_LABELS,
    CHANNEL_ALONE: CHANNEL_ALONE,

    // the fusion rule, as data
    CORROBORATING_PAIRS: CORROBORATING_PAIRS,

    // per-channel outcomes
    OUTCOME_PASSED: OUTCOME_PASSED,
    OUTCOME_ABSENT: OUTCOME_ABSENT,
    OUTCOME_MALFORMED: OUTCOME_MALFORMED,
    OUTCOME_UNBOUND: OUTCOME_UNBOUND,
    OUTCOME_REPLAYED: OUTCOME_REPLAYED,
    OUTCOME_UNREAD: OUTCOME_UNREAD,
    OUTCOME_FORGED: OUTCOME_FORGED,
    OUTCOMES: OUTCOMES,

    // the fused verdict vocabulary
    STATE_CORROBORATED: STATE_CORROBORATED,
    STATE_UNCORROBORATED: STATE_UNCORROBORATED,
    STATE_ABSENT: STATE_ABSENT,
    STATE_MALFORMED: STATE_MALFORMED,
    STATE_UNBOUND: STATE_UNBOUND,
    STATE_REPLAYED: STATE_REPLAYED,
    STATE_FORGED: STATE_FORGED,
    STATES: STATES,

    // decision codes
    CODE_PENDING: CODE_PENDING,
    CODE_POLICY_UNDECLARED: CODE_POLICY_UNDECLARED,
    CODE_POLICY_INCOHERENT: CODE_POLICY_INCOHERENT,
    CODE_UNKNOWN_STATE: CODE_UNKNOWN_STATE,
    CODE_ABSENT_REFUSED: CODE_ABSENT_REFUSED,
    CODE_UNCORROBORATED_REFUSED: CODE_UNCORROBORATED_REFUSED,
    CODE_MALFORMED: CODE_MALFORMED,
    CODE_UNBOUND: CODE_UNBOUND,
    CODE_REPLAYED: CODE_REPLAYED,
    CODE_FORGED: CODE_FORGED,
    CODE_MISSING_CORROBORATION: CODE_MISSING_CORROBORATION,
    CODE_CHANNEL_REQUIRED: CODE_CHANNEL_REQUIRED,
    CODE_CAPABILITY_REFUSED: CODE_CAPABILITY_REFUSED,
    CODE_CORROBORATED_AND_APPROVED: CODE_CORROBORATED_AND_APPROVED,
    CODE_PRESENCE_NOT_REQUIRED: CODE_PRESENCE_NOT_REQUIRED,

    // rules
    RULE_CORROBORATION: RULE_CORROBORATION,
    RULE_CHANNEL: RULE_CHANNEL,
    RULE_CAPABILITY: RULE_CAPABILITY,

    ARTIFACT_CLASSES: ARTIFACT_CLASSES,
    LIMITS: LIMITS,

    // the pipeline, in the order it runs
    parseSignal: parseSignal,
    parseReport: parseReport,
    verifyChannel: verifyChannel,
    passingPairs: passingPairs,
    verifyPresence: verifyPresence,
    normalizePolicy: normalizePolicy,
    presenceGate: presenceGate,
    unmetRequirements: unmetRequirements,
    capabilityDecision: capabilityDecision,
    admitActivation: admitActivation,
    presenceTranscript: presenceTranscript,
    presenceReceipt: presenceReceipt,

    // honesty
    describeChannels: describeChannels,
    describeRelayRequirement: describeRelayRequirement,
    channelAvailability: channelAvailability,
    describeAcceptance: describeAcceptance,
    describeLimits: describeLimits
  };
});
