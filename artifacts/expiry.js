/*!
 * rvQR expiry — the arithmetic behind self-destruct, with no storage and no DOM.
 *
 * Deletion itself happens in the vault (app.js). Everything that decides
 * *whether* and *when* to delete lives here, as pure functions over a clock,
 * because a countdown that quietly stops counting is invisible in a browser
 * and obvious in a test.
 *
 * An expiry record is one of:
 *   null                                   — nothing armed
 *   { mode:'burn',  armedAt }              — destroy on first successful export
 *   { mode:'timed', armedAt, expiresAt }   — destroy once the clock passes it
 *
 * What this module deliberately does NOT model: any promise about copies that
 * have already left the device, and any claim about erasure below the storage
 * API. See describeLimits().
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RVQRExpiry = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODE_BURN = 'burn';
  var MODE_TIMED = 'timed';

  var MINUTE = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;

  /** Offered durations. Ordered shortest first; the UI renders them in order. */
  var TTL_PRESETS = [
    { id: '15m', label: '15 minutes', ms: 15 * MINUTE },
    { id: '1h', label: '1 hour', ms: HOUR },
    { id: '24h', label: '24 hours', ms: DAY },
    { id: '7d', label: '7 days', ms: 7 * DAY }
  ];

  /** The window in which a countdown is treated as urgent by the UI. */
  var URGENT_MS = MINUTE;

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function ttlById(id) {
    for (var i = 0; i < TTL_PRESETS.length; i++) {
      if (TTL_PRESETS[i].id === id) return TTL_PRESETS[i];
    }
    return null;
  }

  /**
   * Builds an expiry record, or returns null when nothing should be armed.
   *
   * Returning null for bad input rather than throwing is deliberate: this is
   * fed by a <select> whose value is user-controlled, and the safe failure for
   * a destructive feature is "did not arm", never "armed something unintended".
   */
  function createExpiry(mode, now, ttlMs) {
    if (!isFiniteNumber(now)) return null;
    if (mode === MODE_BURN) {
      return { mode: MODE_BURN, armedAt: now };
    }
    if (mode === MODE_TIMED) {
      if (!isFiniteNumber(ttlMs) || ttlMs <= 0) return null;
      return { mode: MODE_TIMED, armedAt: now, expiresAt: now + ttlMs };
    }
    return null;
  }

  /** True only for a timed record whose moment has arrived. Burn never expires by clock. */
  function isExpired(expiry, now) {
    if (!expiry || expiry.mode !== MODE_TIMED) return false;
    if (!isFiniteNumber(expiry.expiresAt) || !isFiniteNumber(now)) return false;
    return now >= expiry.expiresAt;
  }

  /**
   * Milliseconds left, or null when no clock is running (unarmed, or burn mode).
   * Clamped at zero: a negative remainder is an expired record, and the caller
   * should be asking isExpired() about that rather than rendering a minus sign.
   */
  function msRemaining(expiry, now) {
    if (!expiry || expiry.mode !== MODE_TIMED) return null;
    if (!isFiniteNumber(expiry.expiresAt) || !isFiniteNumber(now)) return null;
    return Math.max(0, expiry.expiresAt - now);
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * A countdown a person can read at a glance and trust at a distance.
   * Under an hour it is MM:SS, because seconds are what matter there; under a
   * day HH:MM:SS; beyond that days and hours, because nobody watches a week
   * tick. Rounds down, so the display never shows time that has already gone.
   */
  function formatCountdown(ms) {
    if (!isFiniteNumber(ms)) return '';
    if (ms <= 0) return '00:00';
    var total = Math.floor(ms / 1000);
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var mins = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (days > 0) return days + 'd ' + pad2(hours) + 'h';
    if (hours > 0) return pad2(hours) + ':' + pad2(mins) + ':' + pad2(secs);
    return pad2(mins) + ':' + pad2(secs);
  }

  /** Whether the countdown has entered its final minute — the UI's cue to escalate. */
  function isUrgent(expiry, now) {
    var left = msRemaining(expiry, now);
    return left !== null && left <= URGENT_MS;
  }

  /** True when exporting the bytes should destroy the record. */
  function consumesOnExport(expiry) {
    return !!(expiry && expiry.mode === MODE_BURN);
  }

  /**
   * A short status line plus a tone the UI maps to a colour. Kept here rather
   * than in the renderer so the wording and the escalation thresholds are
   * covered by tests instead of by looking at a screen.
   */
  function describe(expiry, now) {
    if (!expiry) return { label: 'Not armed', tone: 'idle', countdown: '' };
    if (expiry.mode === MODE_BURN) {
      return { label: 'Burn after export', tone: 'armed', countdown: '' };
    }
    if (expiry.mode === MODE_TIMED) {
      if (isExpired(expiry, now)) {
        return { label: 'Expired', tone: 'expired', countdown: '00:00' };
      }
      var left = msRemaining(expiry, now);
      return {
        label: 'Destroys in',
        tone: isUrgent(expiry, now) ? 'danger' : 'armed',
        countdown: formatCountdown(left)
      };
    }
    return { label: 'Not armed', tone: 'idle', countdown: '' };
  }

  /**
   * Splits vault rows into what survives and what the caller must delete.
   * The vault calls this on every read, so an expired record cannot be handed
   * out even once — including on the first load after the app was closed
   * through the moment of expiry, when no timer was running to catch it.
   */
  function partition(rows, now) {
    var live = [];
    var expired = [];
    (rows || []).forEach(function (row) {
      if (row && isExpired(row.expiry, now)) expired.push(row);
      else live.push(row);
    });
    return { live: live, expired: expired };
  }

  /**
   * The soonest moment any row needs attention, or null if no clock is running.
   * Lets the UI schedule one timer for the whole vault instead of one per row.
   */
  function nextDeadline(rows, now) {
    var soonest = null;
    (rows || []).forEach(function (row) {
      var left = row && msRemaining(row.expiry, now);
      if (left === null) return;
      if (soonest === null || left < soonest) soonest = left;
    });
    return soonest;
  }

  /**
   * The claims this feature is allowed to make, in one place, so the copy in
   * the UI cannot drift away from what the code actually does.
   */
  function describeLimits() {
    return [
      'Deletes this app’s copy on this device, and nothing else.',
      'It cannot recall a file you already exported, or a copy another device received.',
      'Browser storage is not secure erasure: the record leaves IndexedDB, but the bytes may survive on disk until the operating system reuses that space.',
      'A timed expiry is enforced while this page is open, and again the next time you open it — it does not run while the app is closed.'
    ];
  }

  return {
    MODE_BURN: MODE_BURN,
    MODE_TIMED: MODE_TIMED,
    TTL_PRESETS: TTL_PRESETS,
    URGENT_MS: URGENT_MS,
    ttlById: ttlById,
    createExpiry: createExpiry,
    isExpired: isExpired,
    msRemaining: msRemaining,
    formatCountdown: formatCountdown,
    isUrgent: isUrgent,
    consumesOnExport: consumesOnExport,
    describe: describe,
    partition: partition,
    nextDeadline: nextDeadline,
    describeLimits: describeLimits
  };
});
