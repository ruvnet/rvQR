/*!
 * rvQR transfer planner test suite — standalone.
 *
 * Node:    `node artifacts/planner.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after core.js and planner.js, then call
 *          RVQRPlannerTests.runAll(RVQRPlanner).
 *
 * Nothing here reads a clock, a file or a network. The planner is pure
 * arithmetic over a situation object, so these tests are exact rather than
 * tolerant, and a plan made twice is asserted to be the same plan.
 *
 * Two groups carry most of the weight.
 *
 * The INVARIANT group proves that hard rules cannot be outbid, and proves it by
 * construction rather than by observation: the rule-violating candidate is
 * given the best possible learned score AND, separately, is arranged to have
 * the best J in the whole set — so both the learned half and the objective half
 * of the ranking would pick it if either could reach it. It is still not
 * returned, because after the filter runs there is nothing left for either half
 * to reach.
 *
 * The CALIBRATION group checks the model against docs/benchmarks.md rather than
 * against itself: §10's 15.2 and 12.6 second transfers, §3's 193 slots at 10%
 * loss, and §7's 869-byte two-hop loss all fall out of the planner's own
 * arithmetic without being written into it.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var planner = require('./planner.js');
      var results = api.runAll(planner);
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
    root.RVQRPlannerTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIB = 1024 * 1024;

  // The 40,989-byte microkernel at version 19-L and 5 fps: the operating point
  // docs/benchmarks.md §1, §3 and §10 all measure against.
  var WASM_BYTES = 40989;
  var SYMBOL_19L = 792;

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

    function eq(actual, expected, msg) {
      if (actual !== expected) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
      }
    }

    function near(actual, expected, tolerance, msg) {
      if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected +
          ' ± ' + tolerance);
      }
    }

    function throws(reason, fn, msg) {
      var caught = null;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      assert(caught, (msg || 'expected a rejection') + ', nothing was thrown');
      eq(caught.reason, reason, msg || 'rejection reason');
      return caught;
    }

    /** A workable situation: verified peer, healthy link, nothing forbidden. */
    function situation(over) {
      var s = {
        artifact: { bytes: WASM_BYTES, name: 'rvf_wasm_bg.wasm' },
        receiver: { holds: 'none', supportsV2: true },
        link: { lossRate: 0, fps: 5, symbolBytes: SYMBOL_19L },
        device: { role: 'receiver', baselineBytes: 0 },
        policy: { radio: P.RADIO_ANY },
        trust: { verified: true }
      };
      Object.keys(over || {}).forEach(function (key) {
        s[key] = merge(s[key], over[key]);
      });
      return s;
    }

    function merge(base, extra) {
      if (extra === null || typeof extra !== 'object') return extra;
      var out = {};
      Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }

    /** The one candidate matching a spec, from the grid this situation offers. */
    function pick(s, spec) {
      var all = P.candidates(s);
      var hit = all.filter(function (c) {
        return Object.keys(spec).every(function (k) { return c[k] === spec[k]; });
      });
      assert(hit.length === 1, 'expected exactly one candidate for ' +
        JSON.stringify(spec) + ', found ' + hit.length);
      return hit[0];
    }

    /** An adviser that answers from a table of ids, neutral for anything else. */
    function adviserOver(table) {
      return {
        name: 'table',
        preference: function (candidate) {
          return Object.prototype.hasOwnProperty.call(table, candidate.id) ? table[candidate.id] : 0.5;
        }
      };
    }

    // --- The objective, and its normalisation --------------------------------

    test('planner: the four weights sum to exactly one', function () {
      eq(P.WEIGHT_SUM, 1, 'weight sum');
      eq(P.WEIGHT_TIME + P.WEIGHT_ENERGY + P.WEIGHT_BYTES + P.WEIGHT_RISK, 1, 'recomputed sum');
      eq(P.WEIGHT_TIME, 0.45, 'time weight');
      eq(P.WEIGHT_ENERGY, 0.20, 'energy weight');
      eq(P.WEIGHT_BYTES, 0.20, 'bytes weight');
      eq(P.WEIGHT_RISK, 0.15, 'risk weight');
      return 'J is a fraction, not an arbitrary scalar';
    });

    test('planner: the reference strategy scores exactly 1 on all three ratio terms', function () {
      var s = P.normalizeSituation(situation());
      var t = P.costTerms(P.REFERENCE, s);
      eq(t.T, 1, 'T');
      eq(t.E, 1, 'E');
      eq(t.B, 1, 'B');
      eq(t.R, 0, 'R with no hazards');
      near(t.J, 0.85, 1e-12, 'J = 0.45 + 0.20 + 0.20 + 0.15·0');
      return 'the basis is a real candidate evaluated by the same code';
    });

    test('planner: every term of every candidate stays inside [0,1], and so does J', function () {
      var situations = [
        situation(),
        situation({ link: { lossRate: 0.6, contactSeconds: 4 } }),
        situation({ receiver: { holds: 'unit', baseBytes: 41053, spanCount: 1, unitCount: 71, overlap: 0.99, baseConfidence: 0.3 } }),
        situation({ artifact: { bytes: 4 }, link: { lossRate: 0.45 } }),
        situation({ artifact: { bytes: 8 * MIB }, device: { baselineBytes: 8 * MIB } })
      ];
      var seen = 0;
      situations.forEach(function (raw) {
        var s = P.normalizeSituation(raw);
        P.candidates(raw).forEach(function (c) {
          var t = P.costTerms(c, s);
          ['T', 'E', 'B', 'R', 'J'].forEach(function (key) {
            assert(typeof t[key] === 'number' && isFinite(t[key]),
              c.id + ' ' + key + ' is not a finite number: ' + t[key]);
            assert(t[key] >= 0 && t[key] <= 1, c.id + ' ' + key + ' = ' + t[key] + ' left [0,1]');
          });
          seen++;
        });
      });
      return seen + ' candidate scorings, none outside the unit interval';
    });

    test('planner: describeNormalisation states a basis and a source for all four terms', function () {
      var rows = P.describeNormalisation();
      eq(rows.length, 4, 'one row per term');
      var byTerm = {};
      rows.forEach(function (row) {
        byTerm[row.term] = row;
        assert(row.basis && row.basis.length > 20, row.term + ' has no basis stated');
        assert(row.source && row.source.length > 20, row.term + ' has no source stated');
        assert(/MEASURED|MODELLED/.test(row.source), row.term + ' does not say whether it was measured');
      });
      eq(byTerm.T.weight, P.WEIGHT_TIME, 'T weight matches the constant');
      eq(byTerm.E.weight, P.WEIGHT_ENERGY, 'E weight matches the constant');
      eq(byTerm.B.weight, P.WEIGHT_BYTES, 'B weight matches the constant');
      eq(byTerm.R.weight, P.WEIGHT_RISK, 'R weight matches the constant');
      eq(byTerm.R.kind, 'probability', 'R is the term with nothing to normalise');
      assert(/MODELLED/.test(byTerm.E.source), 'the energy term does not admit it is modelled');
      return 'the basis is readable out of a running system';
    });

    test('planner: a delta bigger than the file it replaces clamps B to 1 and says so in bRaw', function () {
      // §7's cold-receiver row: a 2,784-byte semantic delta against a 2,304-byte
      // container, because a receiver holding nothing pays for a table
      // describing bytes that were going to be sent anyway. Here the same shape
      // at the scale of §7's 1.13 MB container — 2,359 units, no overlap.
      var raw = situation({
        receiver: { holds: 'unit', baseBytes: 1125950, spanCount: 7, unitCount: 2359, overlap: 0 }
      });
      var s = P.normalizeSituation(raw);
      var spec = {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        verification: 'complete'
      };
      var full = P.costTerms(pick(raw, merge(spec, { granularity: 'full' })), s);
      var unit = P.costTerms(pick(raw, merge(spec, { granularity: 'unit' })), s);

      assert(unit.bRaw > 1, 'the unit delta should be larger than the reference: bRaw = ' + unit.bRaw);
      eq(unit.B, 1, 'B clamps at the basis');
      eq(full.B, 1, 'the full transfer is the basis');
      eq(full.bRaw, 1, 'and is unclamped there');
      assert(unit.model.wireBytes > full.model.wireBytes,
        'the delta should put more on the wire than resending the file');
      assert(unit.J >= full.J, 'and it should not outscore resending the file');
      return 'bRaw = ' + unit.bRaw.toFixed(4) + ', clamped to B = 1';
    });

    // --- Calibration against docs/benchmarks.md ------------------------------

    test('planner: reproduces §10’s measured 15.2 s v1 and 12.6 s v2 transfers', function () {
      var raw = situation();
      var s = P.normalizeSituation(raw);
      var v1 = P.transferModel(pick(raw, {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 1024,
        granularity: 'full', verification: 'complete'
      }), s);
      var v2 = P.transferModel(pick(raw, {
        transport: 'optical', format: 'v2', mode: 'indexed', chunkBytes: 1024,
        granularity: 'full', verification: 'complete'
      }), s);
      near(v1.payloadPerSymbol, 550, 1, '§1 measured 550 payload bytes per 19-L symbol under v1');
      near(v2.payloadPerSymbol, 665, 1, '§1 measured 665 under v2 armoured');
      near(v1.seconds, 15.2, 0.15, '§10 measured 15.2 s at P = 1');
      near(v2.seconds, 12.6, 0.15, '§10 measured 12.6 s at P = 1');
      return 'v1 ' + v1.seconds.toFixed(1) + ' s, v2 ' + v2.seconds.toFixed(1) + ' s';
    });

    test('planner: reproduces §3’s 193 indexed slots at 10% loss on the same module', function () {
      var raw = situation({ link: { lossRate: 0.1 } });
      var s = P.normalizeSituation(raw);
      var m = P.transferModel(pick(raw, {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), s);
      eq(m.dataSymbols, 81, 'K = 81 at a 512-byte chunk');
      near(m.slots, 193, 2, '§3 measured 193 mean slots over 500 trials');
      return m.slots + ' slots against a measured 193';
    });

    test('planner: reproduces §3’s 86 fountain slots at zero loss, and its flatness under loss', function () {
      var raw = situation();
      var s = P.normalizeSituation(raw);
      var spec = {
        transport: 'optical', format: 'v1', mode: 'fountain', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      };
      var clean = P.transferModel(pick(raw, spec), s);
      near(clean.slots, 86, 2, '§3 measured 86 slots at 0% loss');

      var lossy = P.transferModel(pick(raw, spec), P.normalizeSituation(situation({ link: { lossRate: 0.4 } })));
      var indexedLossy = P.transferModel(pick(raw, {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), P.normalizeSituation(situation({ link: { lossRate: 0.4 } })));
      near(lossy.slots, 142, 12, '§3 measured 142 fountain slots at 40% loss');
      assert(indexedLossy.slots > 3 * lossy.slots,
        'the indexed transport should be more than 3× the fountain at 40% loss, ' +
        'as §3 measured: ' + indexedLossy.slots + ' against ' + lossy.slots);
      return 'fountain ' + clean.slots + ' → ' + lossy.slots + ' slots, indexed ' + indexedLossy.slots;
    });

    test('planner: the v1 inflation table is read exactly at its measured points', function () {
      var expected = { 0: 1.00, 0.1: 2.12, 0.2: 2.64, 0.3: 3.04, 0.4: 3.31, 0.5: 3.63, 0.6: 3.90 };
      P.V1_LOSS_INFLATION.forEach(function (row) {
        eq(row.factor, expected[row.loss], 'inflation at ' + row.loss + ' loss');
      });
      eq(P.FOUNTAIN_RECEPTION_OVERHEAD, 1.000191, '§4 measured 1.000191 over 2,200 decodes');
      return P.V1_LOSS_INFLATION.length + ' measured points, unaltered';
    });

    // --- Hard rules ----------------------------------------------------------

    test('planner: an unverified peer is not a transfer partner at any score', function () {
      var p = P.plan(situation({ trust: { verified: false } }));
      eq(p.chosen, null, 'nothing should be chosen');
      eq(p.admissible.length, 0, 'nothing should be admissible');
      assert(p.rejected.length > 0, 'the rejections should be reported, not swallowed');
      p.rejected.forEach(function (row) {
        eq(row.rule, P.RULE_TRUST, 'every rejection should name the trust rule');
        assert(/not verified/.test(row.reason), 'the reason should say what is wrong: ' + row.reason);
      });
      assert(/no strategy passed/.test(p.reason), 'the plan should explain itself: ' + p.reason);
      return p.rejected.length + ' candidates, all rejected on trust';
    });

    test('planner: a verified peer presenting the wrong pinned key is still not a partner', function () {
      var p = P.plan(situation({ trust: { verified: true, pinnedKeyId: 'aaaa', presentedKeyId: 'bbbb' } }));
      eq(p.chosen, null, 'a mispinned peer must not get a plan');
      eq(p.rejected[0].rule, P.RULE_TRUST, 'rejected on trust');
      assert(/pinned/.test(p.rejected[0].reason), 'the reason should mention the pin: ' + p.rejected[0].reason);

      var ok = P.plan(situation({ trust: { verified: true, pinnedKeyId: 'aaaa', presentedKeyId: 'aaaa' } }));
      assert(ok.chosen, 'the matching pin should admit candidates');
      return 'mismatch rejects, match admits';
    });

    test('planner: an offline policy forbids every networked transport and no other', function () {
      var p = P.plan(situation({ policy: { radio: P.RADIO_OFFLINE } }));
      assert(p.chosen, 'the optical route should survive an offline policy');
      eq(p.chosen.needsRadio, false, 'the chosen route must not need a radio');
      p.admissible.forEach(function (c) {
        eq(c.needsRadio, false, c.id + ' needs a radio and was admitted under an offline policy');
      });
      var radioRejects = p.rejected.filter(function (r) { return r.rule === P.RULE_RADIO; });
      assert(radioRejects.length > 0, 'the peer candidates should be rejected, not absent');
      radioRejects.forEach(function (r) {
        assert(/offline/.test(r.reason), 'the reason should name the policy: ' + r.reason);
      });

      var open = P.plan(situation({ policy: { radio: P.RADIO_ANY } }));
      assert(open.admissible.some(function (c) { return c.needsRadio; }),
        'the same peer candidates should be admissible when policy allows');
      return radioRejects.length + ' networked candidates refused, ' +
        p.admissible.length + ' optical ones kept';
    });

    test('planner: projected peak memory over 128 MiB rejects, and reports the figure', function () {
      eq(P.MEMORY_BUDGET_BYTES, 128 * MIB, 'ADR-025 §2.2');
      // §9 measured 2.78 live copies at the v1 receiver's worst stage, so a
      // 48 MiB artifact projects to about 133 MiB and cannot run.
      var p = P.plan(situation({ artifact: { bytes: 48 * MIB } }));
      var memoryRejects = p.rejected.filter(function (r) { return r.rule === P.RULE_MEMORY; });
      assert(memoryRejects.length > 0, 'a 48 MiB artifact should break the budget somewhere');
      assert(/MiB/.test(memoryRejects[0].reason), 'the reason should quote the projection: ' + memoryRejects[0].reason);

      var small = P.plan(situation({ artifact: { bytes: 1 * MIB } }));
      eq(small.rejected.filter(function (r) { return r.rule === P.RULE_MEMORY; }).length, 0,
        'a 1 MiB artifact should break nothing');

      // The baseline the caller declares is inside the budget, not outside it.
      var crowded = P.plan(situation({ artifact: { bytes: 1 * MIB }, device: { baselineBytes: 127 * MIB } }));
      eq(crowded.admissible.length, 0, 'a device with 1 MiB to spare can run nothing');
      return memoryRejects.length + ' rejected at 48 MiB, none at 1 MiB';
    });

    test('planner: the memory projection follows §9’s measured copy counts', function () {
      var s = P.normalizeSituation(situation({ artifact: { bytes: 10 * MIB }, device: { role: 'receiver' } }));
      var raw = situation({ artifact: { bytes: 10 * MIB } });
      var v1 = P.memoryModel(pick(raw, {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), s);
      var v2 = P.memoryModel(pick(raw, {
        transport: 'optical', format: 'v2', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), s);
      eq(v1.copies, 2.78, '§9 measured 2.78 copies at v1 receiver finalize');
      eq(v2.copies, 2.56, '§9 measured 2.56 at v2 receiver finalize');
      assert(v1.peakBytes > v2.peakBytes, 'v2 should project lower than v1');

      var fountain = P.memoryModel(pick(raw, {
        transport: 'optical', format: 'v1', mode: 'fountain', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), s);
      assert(fountain.peakBytes > v1.peakBytes,
        'a fountain decoder holds its symbols and must project higher');
      return 'v1 ' + (v1.peakBytes / MIB).toFixed(1) + ' MiB, v2 ' +
        (v2.peakBytes / MIB).toFixed(1) + ' MiB, fountain ' + (fountain.peakBytes / MIB).toFixed(1) + ' MiB';
    });

    test('planner: a committing transfer refuses every partial-verification route', function () {
      var p = P.plan(situation({ policy: { commit: true } }));
      assert(p.chosen, 'complete-verification routes should still be available');
      eq(p.chosen.verification, P.VERIFY_COMPLETE, 'the chosen route must verify completely');
      p.admissible.forEach(function (c) {
        eq(c.verification, P.VERIFY_COMPLETE, c.id + ' commits on a partial verification');
      });
      var refused = p.rejected.filter(function (r) { return r.rule === P.RULE_VERIFICATION; });
      assert(refused.length > 0, 'the partial routes should be refused, not absent');
      refused.forEach(function (r) {
        assert(/partial verification/.test(r.reason), 'reason: ' + r.reason);
      });

      var browsing = P.plan(situation({ policy: { commit: false } }));
      assert(browsing.admissible.some(function (c) { return c.verification === P.VERIFY_PARTIAL; }),
        'a non-committing transfer may consider a partial verification');
      return refused.length + ' committing routes refused for verifying partially';
    });

    test('planner: a candidate that breaks several rules reports all of them', function () {
      var p = P.plan(situation({
        artifact: { bytes: 48 * MIB },
        policy: { radio: P.RADIO_OFFLINE, commit: true }
      }));
      var multi = p.rejected.filter(function (r) { return r.broken.length > 1; });
      assert(multi.length > 0, 'some candidate here breaks more than one rule');
      multi.forEach(function (row) {
        eq(row.rule, row.broken[0].rule, 'the headline rule is the first broken one');
        row.broken.forEach(function (b) {
          assert(b.rule && b.label && b.reason, 'each broken rule needs a name and a reason');
        });
      });
      return multi.length + ' candidates rejected with more than one reason each';
    });

    // --- The invariant: rules cannot be outbid -------------------------------

    test('invariant: a perfect learned score cannot resurrect a rule-violating candidate', function () {
      var raw = situation({ policy: { radio: P.RADIO_OFFLINE } });
      var forbidden = pick(raw, {
        transport: 'peer', granularity: 'full', verification: 'complete'
      });
      var allowed = pick(raw, {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      });

      // Best possible advice for the forbidden route, worst possible for the
      // only permitted one, at the largest weight the module will accept.
      var table = {};
      table[forbidden.id] = 1;
      table[allowed.id] = 0;
      var opts = { adviser: adviserOver(table), adviceWeight: 1000 };

      var gate = P.admit([forbidden, allowed], raw);
      eq(gate.admissible.length, 1, 'exactly one candidate should survive the rules');
      eq(gate.admissible[0].id, allowed.id, 'and it should be the permitted one');
      eq(gate.rejected.length, 1, 'the other should be reported');
      eq(gate.rejected[0].id, forbidden.id, 'by id');
      eq(gate.rejected[0].rule, P.RULE_RADIO, 'with the rule that killed it');

      var scored = P.rank(gate.admissible, raw, opts);
      eq(scored.length, 1, 'ranking cannot invent a candidate it was not given');
      eq(scored[0].id, allowed.id, 'the worst-advised permitted route still wins by walkover');

      var p = P.plan(raw, opts);
      assert(p.chosen, 'a plan should still be produced');
      eq(p.chosen.needsRadio, false, 'the chosen route must not need a radio');
      assert(!p.ranked.some(function (r) { return r.candidate.needsRadio; }),
        'no networked route may appear anywhere in the ranking');
      var reported = p.rejected.filter(function (r) { return r.id === forbidden.id; });
      eq(reported.length, 1, 'the forbidden route is reported, not silently dropped');
      assert(reported[0].reason.length > 10, 'and it is reported with its reason');
      return 'advice 1.0 on the forbidden route, 0.0 on the permitted one, weight 1000 → ' +
        'still ' + p.chosen.transport;
    });

    test('invariant: the best J in the set does not win if the rules forbid it', function () {
      // The point of arranging this: it shows the rules are not a penalty term.
      // A penalty would have to be larger than the peer route's advantage, and
      // here the peer route is the objectively best strategy in the set.
      var raw = situation({
        policy: { radio: P.RADIO_OFFLINE },
        link: { radioBytesPerSecond: 10 * 1000 * 1000 }
      });
      var s = P.normalizeSituation(raw);
      var forbidden = pick(raw, { transport: 'peer', granularity: 'full', verification: 'complete' });
      var forbiddenTerms = P.costTerms(forbidden, s);

      var p = P.plan(raw);
      assert(p.chosen, 'the optical route should be chosen');
      assert(forbiddenTerms.J < p.J,
        'this test is only meaningful if the forbidden route scores better: ' +
        forbiddenTerms.J.toFixed(4) + ' against ' + p.J.toFixed(4));
      eq(p.chosen.needsRadio, false, 'and yet it is not chosen');
      assert(!p.admissible.some(function (c) { return c.id === forbidden.id; }),
        'it never reached the admissible set at all');
      return 'forbidden route J = ' + forbiddenTerms.J.toFixed(4) +
        ' beats the winner at ' + p.J.toFixed(4) + ', and still loses';
    });

    test('invariant: a rejection carries no candidate object, so there is nothing to score', function () {
      var p = P.plan(situation({ policy: { radio: P.RADIO_OFFLINE, commit: true } }));
      assert(p.rejected.length > 0, 'this situation should reject something');
      p.rejected.forEach(function (row) {
        var keys = Object.keys(row).sort().join(',');
        eq(keys, 'broken,id,label,reason,rule', 'a rejection row is a report, not a candidate');
        eq(row.candidate, undefined, 'no candidate object hides on the row');
        eq(row.transport, undefined, 'nor any field the cost model reads');
        eq(row.format, undefined, 'nor any field the cost model reads');
        eq(row.granularity, undefined, 'nor any field the cost model reads');
      });
      return p.rejected.length + ' rejections, none of them scoreable';
    });

    test('invariant: ranking returns only ids it was handed', function () {
      var raw = situation();
      var all = P.candidates(raw);
      var subset = [all[0], all[1]];
      var table = {};
      all.forEach(function (c) { table[c.id] = c === all[all.length - 1] ? 1 : 0; });
      var scored = P.rank(subset, raw, { adviser: adviserOver(table), adviceWeight: P.MAX_ADVICE_WEIGHT });
      eq(scored.length, 2, 'two in, two out');
      var given = subset.map(function (c) { return c.id; }).sort().join('|');
      var got = scored.map(function (r) { return r.id; }).sort().join('|');
      eq(got, given, 'an adviser preferring an absent candidate cannot summon it');
      return 'the choice set is the set that was passed in';
    });

    test('invariant: the neutral adviser leaves the J ordering exactly intact', function () {
      var raw = situation({ link: { lossRate: 0.3, contactSeconds: 120 } });
      var gate = P.admit(P.candidates(raw), raw);
      var scored = P.rank(gate.admissible, raw);
      assert(scored.length > 3, 'expected a few admissible candidates');
      for (var i = 1; i < scored.length; i++) {
        assert(scored[i].J >= scored[i - 1].J - 1e-12,
          'ranking diverged from J at position ' + i + ': ' +
          scored[i - 1].J + ' then ' + scored[i].J);
        eq(scored[i].advice, 0.5, 'the default adviser is neutral');
      }
      return scored.length + ' candidates ranked by J alone with no model present';
    });

    test('planner: advice weight is capped however much the caller asks for', function () {
      var raw = situation();
      var gate = P.admit(P.candidates(raw), raw);
      var greedy = P.rank(gate.admissible, raw, { adviser: P.NEUTRAL_ADVISER, adviceWeight: 99 });
      eq(greedy[0].adviceWeight, P.MAX_ADVICE_WEIGHT, 'clamped to the ceiling');
      var negative = P.rank(gate.admissible, raw, { adviser: P.NEUTRAL_ADVISER, adviceWeight: -5 });
      eq(negative[0].adviceWeight, 0, 'clamped at zero');
      assert(P.MAX_ADVICE_WEIGHT < 1, 'the learned component must never own the whole score');
      return 'weight ∈ [0, ' + P.MAX_ADVICE_WEIGHT + ']';
    });

    test('planner: an adviser answering with nonsense is clamped, not propagated', function () {
      var raw = situation();
      var gate = P.admit(P.candidates(raw), raw);
      var junk = { name: 'junk', preference: function () { return NaN; } };
      var huge = { name: 'huge', preference: function () { return 1e9; } };
      var below = { name: 'below', preference: function () { return -1e9; } };

      var a = P.rank(gate.admissible, raw, { adviser: junk });
      a.forEach(function (row) {
        eq(row.advice, 0.5, 'NaN becomes neutral');
        assert(isFinite(row.score), 'a NaN score would order the set arbitrarily');
      });
      eq(P.rank(gate.admissible, raw, { adviser: huge })[0].advice, 1, 'clamped above');
      eq(P.rank(gate.admissible, raw, { adviser: below })[0].advice, 0, 'clamped below');
      return 'NaN → 0.5, ±1e9 → [0,1]';
    });

    test('planner: an adviser that is not an adviser is refused', function () {
      var raw = situation();
      var gate = P.admit(P.candidates(raw), raw);
      throws('bad-adviser', function () {
        P.rank(gate.admissible, raw, { adviser: { name: 'empty' } });
      }, 'an object with no preference() is not an adviser');
      return 'the injection point is checked, not assumed';
    });

    test('planner: a throwing adviser loses the plan and cannot buy a forbidden one', function () {
      var raw = situation({ policy: { radio: P.RADIO_OFFLINE } });
      var broken = {
        name: 'broken',
        preference: function () { throw new Error('model unavailable'); }
      };
      var caught = null;
      try {
        P.plan(raw, { adviser: broken });
      } catch (e) {
        caught = e;
      }
      assert(caught, 'a broken adviser should be loud, not silently neutral');
      eq(caught.message, 'model unavailable', 'the adviser’s own failure surfaces');
      // The safety argument, restated as an assertion: by the time an adviser
      // runs at all, the rules have already removed everything they forbid.
      var gate = P.admit(P.candidates(raw), raw);
      assert(!gate.admissible.some(function (c) { return c.needsRadio; }),
        'nothing an adviser can see needs a radio under this policy');
      return 'a broken model costs a plan, never buys one';
    });

    // --- Inventory granularity ----------------------------------------------

    test('granularity: the demo container’s doubly-paid table is exactly §7’s 869 bytes', function () {
      // §7, two-hop: the semantic path cost 2,177 B against the span path's
      // 1,308 B on the demo container with every record rewritten. The 869-byte
      // difference is the unit table, paid once on the inventory hop
      // (667 − 134 = 533) and once inside the delta payload (1,510 − 1,174 = 336).
      var r = P.chooseInventoryGranularity({
        containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28
      });
      eq(r.spanInventoryBytes, 134, '§7 measured a 134-byte span inventory');
      eq(r.unitInventoryBytes, 667, '§7 measured a 667-byte semantic inventory');
      eq(r.inventoryExtra, 533, 'the inventory hop’s share');
      eq(r.payloadExtra, 336, 'the delta payload’s share');
      eq(r.doublePaid, 869, '2,177 − 1,308, to the byte');
      return 'the model reproduces the measured loss exactly, not approximately';
    });

    test('granularity: the demo container declines unit granularity, and says why', function () {
      var r = P.chooseInventoryGranularity({
        containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28
      });
      eq(r.granularity, P.GRANULARITY_SPAN, 'span only');
      eq(r.verdict, 'marginal', 'possible but not worth betting on');
      near(r.breakEvenRewriteFraction, 0.517, 0.001, 'the tolerance the table buys');
      assert(r.breakEvenRewriteFraction < r.rewriteTolerance, 'below the required tolerance');
      assert(/cannot know/.test(r.reason), 'the reason should name the ignorance: ' + r.reason);
      assert(/869/.test(r.reason), 'and quote the certain cost: ' + r.reason);
      return 'break-even at ' + (r.breakEvenRewriteFraction * 100).toFixed(1) +
        '%, tolerance ' + (r.rewriteTolerance * 100) + '%';
    });

    test('granularity: every scenario §7 measured a unit win on is admitted', function () {
      var scenarios = [
        { name: '1.13 MB container', containerBytes: 1125950, decomposableBytes: 1100000, spanCount: 7, unitCount: 2359 },
        { name: 'wasm module', containerBytes: 41053, decomposableBytes: 40989, spanCount: 1, unitCount: 71 },
        { name: 'RVCOW branch', containerBytes: 18163, decomposableBytes: 18163, spanCount: 1, unitCount: 126 },
        { name: 'membership bitmap', containerBytes: 5160, decomposableBytes: 5160, spanCount: 1, unitCount: 22 }
      ];
      var lines = [];
      scenarios.forEach(function (sc) {
        var r = P.chooseInventoryGranularity(sc);
        eq(r.granularity, P.GRANULARITY_UNIT, sc.name + ' should publish units');
        eq(r.verdict, 'worth-it', sc.name + ' verdict');
        lines.push(sc.name + ' ' + (r.breakEvenRewriteFraction * 100).toFixed(1) + '%');
      });
      return lines.join(', ');
    });

    test('granularity: the RVCOW branch is the binding case from above, at 77.4%', function () {
      // The threshold is pinned between the demo container's 51.7% and this
      // one's 77.4%. Any default inside that interval gives the same verdict on
      // all seven §7 scenarios, and the interval's width is how well seven
      // scenarios pin a threshold down — which is to say, not very.
      var rvcow = P.chooseInventoryGranularity({
        containerBytes: 18163, decomposableBytes: 18163, spanCount: 1, unitCount: 126
      });
      near(rvcow.breakEvenRewriteFraction, 0.774, 0.001, 'the tightest unit win');
      assert(P.DEFAULT_REWRITE_TOLERANCE > 0.517, 'the default must decline the demo container');
      assert(P.DEFAULT_REWRITE_TOLERANCE <= rvcow.breakEvenRewriteFraction,
        'the default must still admit the RVCOW branch');
      eq(P.DEFAULT_REWRITE_TOLERANCE, 0.75, 'a round number inside (0.517, 0.774]');
      return 'the default sits inside a 0.517–0.774 window';
    });

    test('granularity: a tighter tolerance declines more, a looser one declines less', function () {
      var facts = { containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28 };
      eq(P.chooseInventoryGranularity(facts, { rewriteTolerance: 0.4 }).granularity,
        P.GRANULARITY_UNIT, 'a caller willing to bet gets units');
      eq(P.chooseInventoryGranularity(facts, { rewriteTolerance: 0.9 }).granularity,
        P.GRANULARITY_SPAN, 'a caller who is not, does not');
      // Monotone: relaxing the tolerance can only ever turn unit granularity
      // on, never back off. Walked from the tightest tolerance downwards, the
      // verdict must flip at most once.
      var previous = false;
      var flips = 0;
      for (var t = 1; t >= 0; t -= 0.05) {
        var admitted = P.chooseInventoryGranularity(facts, { rewriteTolerance: t }).granularity === P.GRANULARITY_UNIT;
        assert(!(previous && !admitted), 'relaxing the tolerance un-admitted units at ' + t.toFixed(2));
        if (admitted !== previous) flips++;
        previous = admitted;
      }
      eq(flips, 1, 'the verdict should flip exactly once across the whole range');
      return 'the knob is the rewrite tolerance, and it behaves like one';
    });

    test('granularity: a table that cannot possibly pay is refused as impossible, not as marginal', function () {
      // Many tiny units over few decomposable bytes: the table costs more than
      // the content it describes, so no edit whatsoever could save what it costs.
      var r = P.chooseInventoryGranularity({
        containerBytes: 4096, decomposableBytes: 900, spanCount: 2, unitCount: 40
      });
      eq(r.granularity, P.GRANULARITY_SPAN, 'declined');
      eq(r.verdict, 'impossible', 'this is the certain case, not the cautious one');
      assert(r.doublePaid >= r.decomposableBytes, 'the arithmetic behind the verdict');
      assert(/however\s*\n?\s*small|however small/.test(r.reason.replace(/\s+/g, ' ')),
        'the reason should say no change could help: ' + r.reason);
      return r.doublePaid + ' B of table against ' + r.decomposableBytes + ' B of content';
    });

    test('granularity: nothing held, and nothing decomposable, both decline early', function () {
      var cold = P.chooseInventoryGranularity({ containerBytes: 0, decomposableBytes: 0, spanCount: 0, unitCount: 0 });
      eq(cold.granularity, P.GRANULARITY_SPAN, 'a cold receiver publishes no unit table');
      eq(cold.verdict, 'nothing-to-decompose', 'and says so');

      var opaque = P.chooseInventoryGranularity({
        containerBytes: 8192, decomposableBytes: 0, spanCount: 5, unitCount: 5
      });
      eq(opaque.granularity, P.GRANULARITY_SPAN, 'a container of opaque segments too');
      eq(opaque.verdict, 'nothing-to-decompose', 'and says so');
      assert(/parse/.test(opaque.reason), 'the reason should name the cause: ' + opaque.reason);
      return 'both refused before any arithmetic that would divide by zero';
    });

    test('granularity: the decision never reads what changed', function () {
      // §7's two demo rows are the same container edited differently — one where
      // units win by 687 B and one where they lose by 869 B. A receiver cannot
      // tell them apart, and this rule does not pretend to: identical facts must
      // give an identical, and identically-reasoned, answer.
      var facts = { containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28 };
      var a = P.chooseInventoryGranularity(facts);
      var b = P.chooseInventoryGranularity({
        containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28
      });
      eq(a.granularity, b.granularity, 'same verdict');
      eq(a.reason, b.reason, 'same reasoning');
      eq(a.doublePaid, b.doublePaid, 'same arithmetic');

      var assumptions = a.assumptions.join(' ').toLowerCase();
      assert(assumptions.indexOf('nothing at all about what changed') >= 0,
        'the assumptions should say outright that the change is not modelled');
      assert(a.assumptions.length >= 5, 'expected the bound’s assumptions to be enumerated');
      return a.assumptions.length + ' assumptions stated, none of them about the edit';
    });

    test('granularity: a caller shipping the inventory raw gets the raw arithmetic', function () {
      var facts = { containerBytes: 2304, decomposableBytes: 1798, spanCount: 4, unitCount: 28 };
      var raw = P.chooseInventoryGranularity(facts, { inventoryExpansion: 1 });
      eq(raw.spanInventoryBytes, 100, '44-byte header plus four 14-byte records');
      eq(raw.unitInventoryBytes, 500, '52-byte header plus thirty-two 14-byte records');
      eq(raw.inventoryExtra, 400, 'no base64url expansion to pay');
      assert(raw.doublePaid < P.chooseInventoryGranularity(facts).doublePaid,
        'shipping raw should cost less than shipping base64url');
      return 'expansion is a parameter, not an assumption baked into the bound';
    });

    test('granularity: a wider hash widens the table and narrows the case for it', function () {
      var narrow = P.chooseInventoryGranularity({
        containerBytes: 41053, decomposableBytes: 40989, spanCount: 1, unitCount: 71, hashBytes: 8
      });
      var wide = P.chooseInventoryGranularity({
        containerBytes: 41053, decomposableBytes: 40989, spanCount: 1, unitCount: 71, hashBytes: 32
      });
      eq(narrow.recordBytes, 14, 'six bytes plus an eight-byte hash');
      eq(wide.recordBytes, 38, 'six bytes plus a thirty-two-byte hash');
      assert(wide.doublePaid > narrow.doublePaid, 'a wider hash costs more, twice');
      assert(wide.breakEvenRewriteFraction < narrow.breakEvenRewriteFraction,
        'and buys less tolerance');
      return 'break-even ' + (narrow.breakEvenRewriteFraction * 100).toFixed(1) + '% → ' +
        (wide.breakEvenRewriteFraction * 100).toFixed(1) + '%';
    });

    test('granularity: the rule is reachable from plan(), before any inventory is built', function () {
      var p = P.plan(situation({
        receiver: {
          holds: 'span', baseBytes: 41053, decomposableBytes: 40989,
          spanCount: 1, unitCount: 71, overlap: 0.9
        }
      }));
      eq(p.inventory.granularity, P.GRANULARITY_UNIT, 'this receiver should publish units');
      assert(p.inventory.reason.length > 20, 'with its reasoning attached');
      var spanOnly = P.plan(situation({
        receiver: {
          holds: 'span', baseBytes: 2304, decomposableBytes: 1798,
          spanCount: 4, unitCount: 28, overlap: 0.9
        }
      }));
      eq(spanOnly.inventory.granularity, P.GRANULARITY_SPAN, 'and this one should not');
      return 'the receiver’s decision travels with the sender’s plan';
    });

    // --- Candidates ----------------------------------------------------------

    test('planner: granularities on offer are limited by what the receiver published', function () {
      var cold = P.candidates(situation({ receiver: { holds: 'none' } }));
      assert(cold.every(function (c) { return c.granularity === P.GRANULARITY_FULL; }),
        'nothing but a full transfer is possible against a receiver holding nothing');

      var spans = P.candidates(situation({ receiver: { holds: 'span', baseBytes: 2304, spanCount: 4 } }));
      assert(spans.some(function (c) { return c.granularity === P.GRANULARITY_SPAN; }), 'span deltas offered');
      assert(!spans.some(function (c) { return c.granularity === P.GRANULARITY_UNIT; }),
        'a unit delta against a span-only inventory would be planned against a table nobody has');

      var units = P.candidates(situation({ receiver: { holds: 'unit', baseBytes: 2304, spanCount: 4, unitCount: 28 } }));
      assert(units.some(function (c) { return c.granularity === P.GRANULARITY_UNIT; }), 'unit deltas offered');
      return cold.length + ' / ' + spans.length + ' / ' + units.length + ' candidates';
    });

    test('planner: no v2-binary candidate exists, because §1 showed it cannot round-trip', function () {
      var all = P.candidates(situation({ receiver: { holds: 'unit', baseBytes: 2304, spanCount: 4, unitCount: 28 } }));
      all.forEach(function (c) {
        assert(c.format === 'v1' || c.format === 'v2' || c.format === 'raw',
          'unexpected framing ' + c.format);
      });
      eq(P.ENVELOPE.v2, 0.191, 'the armoured envelope, which round-trips');
      assert(P.ENVELOPE.v2 > 0.037, 'binary v2’s 3.7% envelope must not be what is planned against');
      return 'the framing on offer is the framing that survives the shipped decoder';
    });

    test('planner: every candidate id is unique and self-describing', function () {
      var all = P.candidates(situation({ receiver: { holds: 'unit', baseBytes: 2304, spanCount: 4, unitCount: 28 } }));
      var seen = {};
      all.forEach(function (c) {
        assert(!seen[c.id], 'duplicate candidate id ' + c.id);
        seen[c.id] = true;
        assert(c.label && c.label.length > 5, c.id + ' has no readable label');
        assert(c.id.indexOf(c.transport) === 0, c.id + ' does not lead with its transport');
      });
      return all.length + ' distinct strategies';
    });

    // --- Risk ----------------------------------------------------------------

    test('planner: the hazards compose to a probability and are each named', function () {
      var raw = situation({
        receiver: { holds: 'span', baseBytes: WASM_BYTES, spanCount: 4, overlap: 0.5, baseConfidence: 0.4, supportsV2: false },
        link: { lossRate: 0.5, contactSeconds: 5 },
        policy: { allowPartialVerification: true }
      });
      var s = P.normalizeSituation(raw);
      var t = P.costTerms(pick(raw, {
        transport: 'optical', format: 'v2', mode: 'indexed', chunkBytes: 512,
        granularity: 'span', verification: 'partial'
      }), s);
      var names = t.hazards.map(function (h) { return h.name; }).sort();
      eq(names.join(','), 'contact-window,partial-verification,stale-base,unknown-framing',
        'all four hazards should fire here');
      t.hazards.forEach(function (h) {
        assert(h.risk >= 0 && h.risk <= 1, h.name + ' risk left [0,1]');
        assert(h.note && h.note.length > 10, h.name + ' has no explanation');
      });
      assert(t.R > 0.5, 'four live hazards should add up to a lot of risk: ' + t.R);
      eq(t.R <= 1, true, 'and still not exceed one');

      var calm = P.costTerms(pick(situation(), {
        transport: 'optical', format: 'v1', mode: 'indexed', chunkBytes: 512,
        granularity: 'full', verification: 'complete'
      }), P.normalizeSituation(situation()));
      eq(calm.R, 0, 'and a situation with no hazards carries no risk');
      return names.length + ' hazards, R = ' + t.R.toFixed(3);
    });

    // --- Purity --------------------------------------------------------------

    test('planner: planning does not mutate the situation it was given', function () {
      var raw = situation({ receiver: { holds: 'unit', baseBytes: 2304, spanCount: 4, unitCount: 28 } });
      var before = JSON.stringify(raw);
      P.plan(raw);
      P.plan(raw, { adviser: adviserOver({}), adviceWeight: 0.3 });
      eq(JSON.stringify(raw), before, 'the caller’s object came back changed');
      return 'a situation is read, never written';
    });

    test('planner: the same situation gives the same plan, and the clock is not consulted', function () {
      var a = P.plan(situation({ now: 0, link: { lossRate: 0.25 } }));
      var b = P.plan(situation({ now: 1e12, link: { lossRate: 0.25 } }));
      eq(a.chosen.id, b.chosen.id, 'the choice moved with the clock');
      eq(a.J, b.J, 'the score moved with the clock');
      eq(a.reason, b.reason, 'the reasoning moved with the clock');
      eq(a.ranked.length, b.ranked.length, 'the ranking changed size');
      for (var i = 0; i < a.ranked.length; i++) {
        eq(a.ranked[i].id, b.ranked[i].id, 'ranking diverged at ' + i);
      }
      return 'deterministic: nothing here reads a clock';
    });

    test('planner: ties break deterministically rather than by enumeration order', function () {
      var raw = situation();
      var gate = P.admit(P.candidates(raw), raw);
      var forward = P.rank(gate.admissible, raw);
      var backward = P.rank(gate.admissible.slice().reverse(), raw);
      eq(forward.map(function (r) { return r.id; }).join('|'),
        backward.map(function (r) { return r.id; }).join('|'),
        'reversing the input changed the ranking');
      return forward.length + ' candidates, order-independent';
    });

    // --- Rejections ----------------------------------------------------------

    test('planner: a malformed situation is refused with a stable reason', function () {
      throws('bad-artifact-size', function () { P.plan({ artifact: { bytes: 0 } }); }, 'zero bytes');
      throws('bad-artifact-size', function () { P.plan({ artifact: {} }); }, 'no size at all');
      throws('bad-artifact-size', function () { P.plan({ artifact: { bytes: 'lots' } }); }, 'a size that is not a number');
      throws('unknown-radio-policy', function () {
        P.plan(situation({ policy: { radio: 'sometimes' } }));
      }, 'a policy nobody defined');
      throws('too-many-units', function () {
        P.plan(situation({ receiver: { holds: 'unit', unitCount: 1e9 } }));
      }, 'a unit count from a hostile inventory');
      throws('too-many-spans', function () {
        P.plan(situation({ receiver: { holds: 'span', spanCount: 1e9 } }));
      }, 'a span count from a hostile inventory');
      return 'every reason is a stable string, matching delta.js and semdelta.js';
    });

    test('planner: a PlannerError is shaped like the other modules’ errors', function () {
      var caught = throws('bad-artifact-size', function () { P.plan({ artifact: { bytes: -1 } }); });
      eq(caught.name, 'PlannerError', 'error name');
      assert(caught instanceof Error, 'still an Error');
      assert(caught.message.length > 0, 'and carries a message for humans');
      return 'reason for callers, message for people';
    });

    // --- Honesty -------------------------------------------------------------

    test('planner: the stated limits name every claim this cannot make', function () {
      var limits = P.describeLimits();
      assert(Array.isArray(limits) && limits.length >= 6, 'expected at least six caveats');
      var joined = limits.join(' ').toLowerCase();
      assert(joined.indexOf('projection') >= 0, 'does not admit a plan is a projection');
      assert(joined.indexOf('no power measurement') >= 0, 'does not disclaim the energy term');
      assert(joined.indexOf('independent') >= 0, 'does not disclaim the risk composition');
      assert(joined.indexOf('overlap') >= 0, 'does not disclaim the delta size model');
      assert(joined.indexOf('seven scenarios') >= 0, 'does not say how thin the granularity calibration is');
      assert(joined.indexOf('permitted') >= 0, 'does not distinguish permitted from likely to work');
      return limits.length + ' caveats';
    });

    test('planner: the plan explains itself whether or not it found anything', function () {
      var found = P.plan(situation());
      assert(found.reason.indexOf('J = ') >= 0, 'the winner should quote its score: ' + found.reason);
      assert(/T |E |B |R /.test(found.reason), 'and its terms: ' + found.reason);

      var nothing = P.plan(situation({ trust: { verified: false } }));
      assert(nothing.reason.indexOf('no strategy passed') >= 0, 'and a refusal should explain: ' + nothing.reason);
      assert(nothing.reason.indexOf(P.RULE_TRUST) >= 0, 'naming the rule: ' + nothing.reason);
      eq(nothing.chosen, null, 'with nothing chosen');
      assert(nothing.inventory, 'and the granularity decision still reported');
      return 'both outcomes are explainable without rerunning anything';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
