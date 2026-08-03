/*!
 * rvQR expiry test suite — standalone.
 *
 * Node:    `node artifacts/expiry.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after expiry.js and call RVQRExpiryTests.runAll(RVQRExpiry).
 *
 * The clock is injected everywhere, so these run in milliseconds and cover the
 * boundaries a real countdown only reaches after hours of watching it.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var expiry = require('./expiry.js');
      var results = api.runAll(expiry);
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
    root.RVQRExpiryTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SECOND = 1000;
  var MINUTE = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;

  function runAll(E) {
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
        throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(expected) +
          ', got ' + JSON.stringify(actual));
      }
    }

    var T0 = 1700000000000; // a fixed, arbitrary epoch — nothing here depends on the real clock

    // --- createExpiry --------------------------------------------------------

    test('expiry: burn mode records only the arming time', function () {
      var e = E.createExpiry(E.MODE_BURN, T0);
      eq(e.mode, 'burn', 'mode');
      eq(e.armedAt, T0, 'armedAt');
      eq(e.expiresAt, undefined, 'burn must carry no clock');
      return 'no expiresAt';
    });

    test('expiry: timed mode adds the ttl to now', function () {
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      eq(e.mode, 'timed', 'mode');
      eq(e.expiresAt, T0 + HOUR, 'expiresAt');
      return 'T0 + 1h';
    });

    test('expiry: unknown, absent and empty modes arm nothing', function () {
      var cases = [undefined, null, '', 'none', 'BURN', 'destroy', 0, {}];
      for (var i = 0; i < cases.length; i++) {
        eq(E.createExpiry(cases[i], T0, HOUR), null, 'mode ' + JSON.stringify(cases[i]));
      }
      return cases.length + ' rejected';
    });

    test('expiry: timed mode refuses a ttl that is not a positive finite number', function () {
      var cases = [undefined, null, 0, -1, -HOUR, NaN, Infinity, -Infinity, '1h', {}];
      for (var i = 0; i < cases.length; i++) {
        eq(E.createExpiry(E.MODE_TIMED, T0, cases[i]), null, 'ttl ' + JSON.stringify(cases[i]));
      }
      return cases.length + ' rejected';
    });

    test('expiry: a broken clock arms nothing rather than something wrong', function () {
      eq(E.createExpiry(E.MODE_BURN, NaN), null, 'burn with NaN now');
      eq(E.createExpiry(E.MODE_TIMED, Infinity, HOUR), null, 'timed with infinite now');
      eq(E.createExpiry(E.MODE_TIMED, undefined, HOUR), null, 'timed with no now');
      return 'fails closed';
    });

    // --- isExpired -----------------------------------------------------------

    test('expiry: nothing armed never expires', function () {
      assert(!E.isExpired(null, T0 + DAY * 365), 'null expired');
      assert(!E.isExpired(undefined, T0), 'undefined expired');
      return 'null and undefined safe';
    });

    test('expiry: burn never expires by clock, however long it sits', function () {
      var e = E.createExpiry(E.MODE_BURN, T0);
      assert(!E.isExpired(e, T0), 'expired at arming');
      assert(!E.isExpired(e, T0 + DAY * 3650), 'expired after ten years');
      return 'clock-independent';
    });

    test('expiry: timed expiry flips exactly at its moment, not before', function () {
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      assert(!E.isExpired(e, T0 + HOUR - 1), 'expired 1ms early');
      assert(E.isExpired(e, T0 + HOUR), 'not expired at the exact moment');
      assert(E.isExpired(e, T0 + HOUR + 1), 'not expired 1ms late');
      return 'boundary inclusive';
    });

    test('expiry: a malformed timed record is treated as not expired', function () {
      assert(!E.isExpired({ mode: 'timed' }, T0), 'missing expiresAt expired');
      assert(!E.isExpired({ mode: 'timed', expiresAt: NaN }, T0), 'NaN expiresAt expired');
      assert(!E.isExpired({ mode: 'timed', expiresAt: T0 }, NaN), 'NaN now expired');
      return 'no deletion on garbage';
    });

    // --- msRemaining ---------------------------------------------------------

    test('expiry: remaining time is null when no clock is running', function () {
      eq(E.msRemaining(null, T0), null, 'unarmed');
      eq(E.msRemaining(E.createExpiry(E.MODE_BURN, T0), T0), null, 'burn');
      return 'burn and unarmed report no countdown';
    });

    test('expiry: remaining time counts down and clamps at zero', function () {
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      eq(E.msRemaining(e, T0), HOUR, 'at arming');
      eq(E.msRemaining(e, T0 + MINUTE * 30), MINUTE * 30, 'halfway');
      eq(E.msRemaining(e, T0 + HOUR), 0, 'at the moment');
      eq(E.msRemaining(e, T0 + DAY), 0, 'long past — must not go negative');
      return 'clamped';
    });

    test('expiry: a clock that jumps backwards does not extend past the ttl', function () {
      // System clock changes and suspend/resume can move `now` backwards.
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      eq(E.msRemaining(e, T0 - DAY), HOUR + DAY, 'remaining grows with the skew');
      assert(!E.isExpired(e, T0 - DAY), 'skewed backwards should not be expired');
      return 'skew is visible, not silently absorbed';
    });

    // --- formatCountdown -----------------------------------------------------

    test('expiry: countdown under a minute shows seconds', function () {
      eq(E.formatCountdown(1), '00:00', 'sub-second rounds down');
      eq(E.formatCountdown(SECOND), '00:01', '1s');
      eq(E.formatCountdown(59 * SECOND), '00:59', '59s');
      eq(E.formatCountdown(59 * SECOND + 999), '00:59', '59.999s rounds down');
      return 'MM:SS';
    });

    test('expiry: countdown crosses into minutes and hours at the right ticks', function () {
      eq(E.formatCountdown(MINUTE), '01:00', '1m');
      eq(E.formatCountdown(HOUR - 1), '59:59', 'one tick under an hour is still MM:SS');
      eq(E.formatCountdown(HOUR), '01:00:00', 'exactly an hour becomes HH:MM:SS');
      eq(E.formatCountdown(HOUR + 61 * SECOND), '01:01:01', 'mixed');
      eq(E.formatCountdown(DAY - 1), '23:59:59', 'one tick under a day');
      return 'MM:SS → HH:MM:SS at 1h';
    });

    test('expiry: countdown beyond a day drops to days and hours', function () {
      eq(E.formatCountdown(DAY), '1d 00h', 'exactly a day');
      eq(E.formatCountdown(DAY + 5 * HOUR), '1d 05h', 'padded hours');
      eq(E.formatCountdown(7 * DAY), '7d 00h', 'a week');
      return 'Nd HHh';
    });

    test('expiry: countdown never renders a negative or unreadable value', function () {
      eq(E.formatCountdown(0), '00:00', 'zero');
      eq(E.formatCountdown(-1), '00:00', 'negative');
      eq(E.formatCountdown(-DAY), '00:00', 'very negative');
      eq(E.formatCountdown(NaN), '', 'NaN');
      eq(E.formatCountdown(Infinity), '', 'Infinity');
      eq(E.formatCountdown(undefined), '', 'undefined');
      eq(E.formatCountdown('600000'), '', 'a string is not a duration');
      return 'no minus signs, no NaN on screen';
    });

    test('expiry: every offered preset formats to something readable', function () {
      assert(E.TTL_PRESETS.length > 0, 'no presets offered');
      E.TTL_PRESETS.forEach(function (p) {
        assert(typeof p.id === 'string' && p.id, 'preset without an id');
        assert(typeof p.label === 'string' && p.label, 'preset ' + p.id + ' without a label');
        assert(p.ms > 0 && isFinite(p.ms), 'preset ' + p.id + ' has no usable duration');
        var text = E.formatCountdown(p.ms);
        assert(text && text !== '00:00', 'preset ' + p.id + ' formats as ' + JSON.stringify(text));
        eq(E.ttlById(p.id), p, 'ttlById(' + p.id + ')');
      });
      eq(E.ttlById('nope'), null, 'unknown id');
      return E.TTL_PRESETS.length + ' presets';
    });

    // --- urgency and export consumption --------------------------------------

    test('expiry: urgency escalates only inside the final minute', function () {
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      assert(!E.isUrgent(e, T0), 'urgent an hour out');
      assert(!E.isUrgent(e, T0 + HOUR - MINUTE - 1), 'urgent just over a minute out');
      assert(E.isUrgent(e, T0 + HOUR - MINUTE), 'not urgent at exactly one minute');
      assert(E.isUrgent(e, T0 + HOUR), 'not urgent at zero');
      assert(!E.isUrgent(null, T0), 'unarmed reported urgent');
      assert(!E.isUrgent(E.createExpiry(E.MODE_BURN, T0), T0), 'burn reported urgent');
      return 'threshold ' + E.URGENT_MS + 'ms';
    });

    test('expiry: only burn mode is consumed by an export', function () {
      assert(E.consumesOnExport(E.createExpiry(E.MODE_BURN, T0)), 'burn not consumed');
      assert(!E.consumesOnExport(E.createExpiry(E.MODE_TIMED, T0, HOUR)), 'timed consumed');
      assert(!E.consumesOnExport(null), 'unarmed consumed');
      assert(!E.consumesOnExport({ mode: 'burnn' }), 'near-miss mode consumed');
      return 'export destroys burn only';
    });

    // --- describe ------------------------------------------------------------

    test('expiry: description carries a tone the UI can colour by', function () {
      eq(E.describe(null, T0).tone, 'idle', 'unarmed tone');
      eq(E.describe(E.createExpiry(E.MODE_BURN, T0), T0).tone, 'armed', 'burn tone');

      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      eq(E.describe(e, T0).tone, 'armed', 'timed tone far out');
      eq(E.describe(e, T0 + HOUR - 30 * SECOND).tone, 'danger', 'final-minute tone');
      eq(E.describe(e, T0 + HOUR).tone, 'expired', 'expired tone');
      return 'idle/armed/danger/expired';
    });

    test('expiry: description of a timed record carries a live countdown', function () {
      var e = E.createExpiry(E.MODE_TIMED, T0, HOUR);
      eq(E.describe(e, T0 + MINUTE * 30).countdown, '30:00', 'halfway');
      eq(E.describe(e, T0 + HOUR).countdown, '00:00', 'expired');
      eq(E.describe(E.createExpiry(E.MODE_BURN, T0), T0).countdown, '', 'burn has no countdown');
      eq(E.describe(null, T0).countdown, '', 'unarmed has no countdown');
      return 'countdown present only where a clock runs';
    });

    // --- partition and scheduling --------------------------------------------

    test('expiry: partition separates exactly the rows that must be deleted', function () {
      var rows = [
        { id: 'a', expiry: null },
        { id: 'b', expiry: E.createExpiry(E.MODE_BURN, T0) },
        { id: 'c', expiry: E.createExpiry(E.MODE_TIMED, T0, HOUR) },
        { id: 'd', expiry: E.createExpiry(E.MODE_TIMED, T0, MINUTE) }
      ];
      var early = E.partition(rows, T0 + SECOND);
      eq(early.expired.length, 0, 'nothing should be expired one second in');
      eq(early.live.length, 4, 'all four should survive');

      var later = E.partition(rows, T0 + MINUTE);
      eq(later.expired.length, 1, 'one row is due');
      eq(later.expired[0].id, 'd', 'the wrong row was selected');
      eq(later.live.length, 3, 'survivors');

      var muchLater = E.partition(rows, T0 + DAY);
      eq(muchLater.expired.length, 2, 'both timed rows are due');
      eq(muchLater.live.length, 2, 'unarmed and burn always survive the clock');
      return 'burn and unarmed rows are never swept';
    });

    test('expiry: partition tolerates an empty, absent or ragged list', function () {
      eq(E.partition([], T0).live.length, 0, 'empty');
      eq(E.partition(null, T0).expired.length, 0, 'null');
      eq(E.partition(undefined, T0).live.length, 0, 'undefined');
      var ragged = E.partition([null, {}, { expiry: 'nonsense' }], T0);
      eq(ragged.expired.length, 0, 'garbage rows must not be deleted');
      eq(ragged.live.length, 3, 'garbage rows are kept');
      return 'nothing deleted on malformed input';
    });

    test('expiry: the next deadline is the soonest running clock', function () {
      var rows = [
        { expiry: null },
        { expiry: E.createExpiry(E.MODE_BURN, T0) },
        { expiry: E.createExpiry(E.MODE_TIMED, T0, HOUR) },
        { expiry: E.createExpiry(E.MODE_TIMED, T0, MINUTE) }
      ];
      eq(E.nextDeadline(rows, T0), MINUTE, 'soonest');
      eq(E.nextDeadline(rows, T0 + MINUTE), 0, 'clamped once due');
      eq(E.nextDeadline([{ expiry: null }], T0), null, 'no clocks running');
      eq(E.nextDeadline([], T0), null, 'empty');
      eq(E.nextDeadline(null, T0), null, 'null');
      return 'one timer serves the whole vault';
    });

    // --- honesty -------------------------------------------------------------

    test('expiry: the stated limits name every promise this cannot keep', function () {
      var limits = E.describeLimits();
      assert(Array.isArray(limits) && limits.length >= 4, 'expected at least four caveats');
      var joined = limits.join(' ').toLowerCase();
      assert(joined.indexOf('this device') >= 0, 'does not scope the deletion to this device');
      assert(joined.indexOf('already exported') >= 0, 'does not disclaim exported copies');
      assert(joined.indexOf('secure erasure') >= 0, 'does not disclaim secure erasure');
      assert(joined.indexOf('closed') >= 0, 'does not say what happens while the app is closed');
      return limits.length + ' caveats';
    });

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
