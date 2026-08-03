/*!
 * rvQR app — vault, optical send, optical receive.
 * All protocol logic lives in core.js; this file is UI, storage and devices.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

/*
 * The provenance view model.
 *
 * This sits above the app IIFE, and above the DOM, deliberately. Whether a
 * claim reads as a verified fact or as somebody's word is the whole point of
 * ADR-020, and it is far too easy to get wrong inside a render loop where the
 * mistake shows up as a colour rather than as a wrong value. So the decision —
 * which claim goes in which list, which of the three verdict states it carries,
 * and whether the panel is a pass, a failure, an absence or an unreadable
 * document — is a pure function of what provenance.js returned, testable
 * without a browser and asserted in tests.js.
 *
 * Two rules this module exists to enforce:
 *
 *   1. Nothing on the asserted list is ever given a verdict. `verify()` already
 *      separates checkable from asserted; this keeps them separate all the way
 *      to the screen, in different shapes, so a builder's word about a
 *      reproducible build cannot borrow the tick a recomputed hash earned.
 *   2. A failed hash is the loudest thing in the panel. A component that is not
 *      the component the SBOM describes is a substitution, and a substitution
 *      reported as a warning is a substitution accepted.
 *
 * It reads nothing global and throws nothing: every input arrived, ultimately,
 * in a file from an unknown sender.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRProvenanceView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The four states this panel can be in. They are four rather than two because
  // "no provenance segment", "a provenance segment that will not decode" and
  // "provenance that decoded and failed a check" are three different pieces of
  // news, and collapsing any pair of them loses the one a reader needs.
  var ABSENT = 'absent';       // walked cleanly, no provenance segment present
  var UNREADABLE = 'error';    // the container or its provenance could not be read
  var PRESENT = 'present';     // decoded; see counts and tone for the verdict

  // A checkable claim carries one of these. They are the same three the
  // signature panel uses, plus the honest fourth for a check that could not be
  // made — never folded into a pass.
  var PASS = 'pass', WARN = 'warn', FAIL = 'fail', UNAVAILABLE = 'unavailable';

  // An assertion carries this instead, and it is not one of the four above.
  // Anything that renders a claim has to reach for a different branch, which is
  // the point: there is no code path on which an assertion can pick up a tick.
  var ASSERTED = 'asserted';

  var MARKS = {};
  MARKS[PASS] = '✓';          // ✓
  MARKS[WARN] = '!';
  MARKS[FAIL] = '✗';          // ✗
  MARKS[UNAVAILABLE] = '–';   // –
  // Assertions get a quotation dash rather than any of the marks above: it says
  // "someone said this" and cannot be mistaken for a verdict at a glance.
  MARKS[ASSERTED] = '“';      // “

  var COMPONENT_PREFIX = 'Component hash: ';

  /** A claim's value as text, without ever turning a boolean into a verdict. */
  function claimText(value) {
    if (value === null || value === undefined || value === '') return 'not stated';
    if (value === true) return 'claimed';
    if (value === false) return 'claimed not';
    return String(value);
  }

  /** The label verify() uses for a component, so its check can be found again. */
  function componentLabel(component) {
    if (!component || typeof component !== 'object') return '';
    return String(component.name) + (component.version ? ' ' + component.version : '');
  }

  /**
   * The component-hash checks from a report, indexed by the component they
   * name. Built from the report rather than recomputed, so the table and the
   * check list can never disagree about the same hash.
   */
  function componentChecks(report) {
    var index = {};
    var list = (report && report.checkable) || [];
    for (var i = 0; i < list.length; i++) {
      var name = String(list[i].name || '');
      if (name.indexOf(COMPONENT_PREFIX) === 0) {
        index[name.slice(COMPONENT_PREFIX.length)] = list[i];
      }
    }
    return index;
  }

  function normalizeStatus(status) {
    return status === PASS || status === WARN || status === FAIL ? status : UNAVAILABLE;
  }

  /** Checkable entries, in render order, each with its mark. */
  function checkRows(report) {
    var list = (report && report.checkable) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var status = normalizeStatus(list[i].status);
      out.push({
        name: String(list[i].name),
        status: status,
        mark: MARKS[status],
        detail: String(list[i].detail || ''),
        checkable: true
      });
    }
    return out;
  }

  /**
   * Asserted entries. `status` is ASSERTED for every one of them, with no
   * branch that can produce anything else — an assertion has no verdict to
   * carry, and the absence of that branch is what guarantees it.
   */
  function claimRows(report) {
    var list = (report && report.asserted) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      out.push({
        name: String(a.name),
        status: ASSERTED,
        mark: MARKS[ASSERTED],
        value: claimText(a.value),
        stated: !(a.value === null || a.value === undefined || a.value === ''),
        vouchedBy: a.vouchedBy ? String(a.vouchedBy) : null,
        attribution: a.vouchedBy
          ? 'Claimed by ' + String(a.vouchedBy) + '. Nothing in this container tests it.'
          : 'Claimed by the artifact itself, with nothing behind it but the artifact.',
        detail: String(a.detail || ''),
        checkable: false
      });
    }
    return out;
  }

  /** The SBOM as table rows, each carrying the verdict its own hash earned. */
  function componentRows(provenance, report) {
    var sbom = provenance && provenance.sbom;
    if (!sbom || !sbom.present) return [];
    var index = componentChecks(report);
    var rows = [];
    var components = sbom.components || [];
    for (var i = 0; i < components.length; i++) {
      var c = components[i];
      var label = componentLabel(c);
      var check = index[label] || null;
      // A component that names no segment was never checkable here; that is
      // reported as unavailable, which is what verify() would have said.
      var status = check ? normalizeStatus(check.status) : UNAVAILABLE;
      rows.push({
        name: String(c.name),
        version: c.version ? String(c.version) : null,
        purpose: c.purpose ? String(c.purpose) : null,
        licences: (c.licences || []).slice(),
        segment: (c.segment === null || c.segment === undefined) ? null : c.segment,
        sha256: (c.digest && c.digest.sha256) ? String(c.digest.sha256) : null,
        status: status,
        mark: MARKS[status],
        detail: check ? String(check.detail || '') :
          'This component names no segment in this container, so its digest describes ' +
          'something no receiver here can hold up against it.'
      });
    }
    return rows;
  }

  /**
   * The rest of the document: licences, signer policy, source revision, build
   * identity and vulnerability assertions. Every one of these is an assertion,
   * so they are grouped under one heading that says so once, loudly, rather
   * than repeating a disclaimer per row that a reader would stop seeing.
   */
  function factRows(provenance) {
    var rows = [];
    if (!provenance) return rows;

    var lic = provenance.licences;
    if (lic && lic.present) {
      var declared = (lic.artifact || []).slice();
      if (lic.expression) declared.push(lic.expression);
      rows.push({ label: 'Licences', value: declared.join(', ') || 'none listed', mono: false });
    } else {
      rows.push({ label: 'Licences', value: 'none declared', mono: false, absent: true });
    }

    var policy = provenance.signerPolicy;
    if (policy && policy.present) {
      rows.push({
        label: 'Signer policy',
        value: policy.requiredSigners + ' of ' + (policy.keys || []).length + ' listed keys',
        mono: false
      });
      var keys = policy.keys || [];
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var scopes = (key.maySign || []).join(', ');
        rows.push({
          label: 'Key ' + String(key.id),
          value: String(key.algorithm) +
            (scopes ? ' · may sign ' + scopes : ' · scope unstated') +
            (key.publicKey ? ' · ' + key.publicKey : ' · no key material carried'),
          mono: true
        });
      }
    } else {
      rows.push({ label: 'Signer policy', value: 'none declared', mono: false, absent: true });
    }

    var src = provenance.source;
    if (src && src.present) {
      rows.push({
        label: 'Source revision',
        value: String(src.repository) + '@' + String(src.commit) + (src.ref ? ' (' + src.ref + ')' : ''),
        mono: true
      });
    } else {
      rows.push({ label: 'Source revision', value: 'not stated', mono: false, absent: true });
    }

    var build = provenance.build;
    if (build && build.present) {
      rows.push({ label: 'Builder', value: String(build.builder), mono: true });
      rows.push({ label: 'Build type', value: String(build.buildType), mono: true });
      if (build.invocationId) rows.push({ label: 'Invocation', value: String(build.invocationId), mono: true });
      if (build.startedOn || build.finishedOn) {
        rows.push({
          label: 'Build window',
          value: (build.startedOn || '?') + ' → ' + (build.finishedOn || '?'),
          mono: true
        });
      }
      if (build.reproducible !== null && build.reproducible !== undefined) {
        rows.push({
          label: 'Reproducible',
          // Never "yes". The builder claims it; a receiver on the far side of an
          // air gap cannot rerun the build, so the wording keeps the author in
          // the sentence.
          value: build.reproducible ? 'the builder claims so' : 'the builder claims not',
          mono: false
        });
      }
    } else {
      rows.push({
        label: 'Build identity',
        value: 'not stated — this artifact does not say what produced it',
        mono: false,
        absent: true
      });
    }

    var vulns = provenance.vulnerabilities;
    if (vulns && vulns.present) {
      var list = vulns.assertions || [];
      for (var v = 0; v < list.length; v++) {
        var a = list[v];
        rows.push({
          label: String(a.advisory),
          value: String(a.status) +
            (a.justification ? ' (' + a.justification + ')' : '') +
            (a.component ? ' — ' + a.component : ''),
          mono: false
        });
      }
    } else {
      rows.push({
        label: 'Vulnerability assertions',
        value: 'none present — that is silence, not an all-clear',
        mono: false,
        absent: true
      });
    }

    return rows;
  }

  function counts(report) {
    return {
      passed: (report && report.checksPassed) || 0,
      failed: (report && report.checksFailed) || 0,
      unavailable: (report && report.checksUnavailable) || 0
    };
  }

  /**
   * The panel's overall tone. A single failure outranks any number of passes:
   * there is no arithmetic in which a substituted component is offset by a
   * component that was what it said it was.
   */
  function toneFor(c) {
    if (c.failed > 0) return FAIL;
    if (c.passed > 0) return PASS;
    return UNAVAILABLE;
  }

  function summaryLine(c) {
    var parts = [];
    parts.push(c.passed + ' checked');
    if (c.failed) parts.push(c.failed + ' failed');
    parts.push(c.unavailable + ' not checkable here');
    return parts.join(' · ');
  }

  /**
   * Reader output plus verification report to everything the panel needs.
   * `read` is provenance.js's readContainer(); `report` is its verify().
   * Neither is trusted to be well formed — a caller that caught a throw can
   * hand this a synthesised failure and still get a renderable model back.
   */
  function model(read, report) {
    if (!read || typeof read !== 'object') {
      return {
        state: UNREADABLE,
        tone: FAIL,
        headline: 'Provenance could not be read',
        detail: 'The provenance reader returned nothing for this container.',
        counts: counts(null),
        checks: [], claims: [], components: [], facts: []
      };
    }

    if (!read.ok) {
      // Two ways to get here, and they are different news: a provenance segment
      // that will not decode, versus a container whose segment chain could not
      // be walked at all. Neither is an absence, and neither is a pass.
      return {
        state: UNREADABLE,
        tone: FAIL,
        headline: read.provenanced
          ? 'This container carries provenance that could not be read'
          : 'This container’s segments could not be walked',
        detail: (read.reason ? String(read.reason) : 'no reason was given') +
          '. Nothing is claimed and nothing is confirmed; a document this app ' +
          'cannot parse is not evidence of anything.',
        counts: counts(null),
        checks: [], claims: [], components: [], facts: []
      };
    }

    if (!read.provenanced) {
      return {
        state: ABSENT,
        tone: UNAVAILABLE,
        headline: 'No provenance',
        detail: 'This container carries no provenance segment. Nothing says what built it, ' +
          'what is inside it, or under what licence — and that is a fact about the file, ' +
          'not a gap in this page. Unprovenanced is a state, never a pass.',
        segments: (read.segments || []).length,
        counts: counts(null),
        checks: [], claims: [], components: [], facts: []
      };
    }

    var c = counts(report);
    var tone = toneFor(c);
    return {
      state: PRESENT,
      tone: tone,
      headline: tone === FAIL
        ? 'A claim in this container’s provenance is false'
        : 'Provenance present',
      // The loud part. A failed hash is not a caveat appended to a summary; it
      // is the headline, and the model says so rather than leaving it to
      // whichever renderer happens to read `counts`.
      banner: c.failed > 0
        ? {
          tone: FAIL,
          text: c.failed + (c.failed === 1 ? ' claim was checked here and failed.' : ' claims were checked here and failed.') +
            ' A component in this container is not the component its provenance describes. ' +
            'Treat the rest of this document as unreliable: a document that is wrong about ' +
            'something checkable is not more trustworthy about the things that are not.'
        }
        : null,
      detail: summaryLine(c),
      canonical: read.canonical === true,
      // Reported rather than corrected: a document that does not re-encode to
      // the bytes it arrived as cannot be covered by a hash over those bytes.
      canonicalNote: read.canonical === true
        ? null
        : 'The document does not re-encode to the bytes it arrived as, so a hash over ' +
          'this provenance is not reproducible from what it says.',
      segment: read.segment || null,
      counts: c,
      checks: checkRows(report),
      claims: claimRows(report),
      components: componentRows(read.provenance, report),
      facts: factRows(read.provenance)
    };
  }

  return {
    ABSENT: ABSENT, UNREADABLE: UNREADABLE, PRESENT: PRESENT,
    PASS: PASS, WARN: WARN, FAIL: FAIL, UNAVAILABLE: UNAVAILABLE, ASSERTED: ASSERTED,
    MARKS: MARKS,
    COMPONENT_PREFIX: COMPONENT_PREFIX,
    claimText: claimText,
    componentLabel: componentLabel,
    checkRows: checkRows,
    claimRows: claimRows,
    componentRows: componentRows,
    factRows: factRows,
    toneFor: toneFor,
    model: model
  };
});

/*
 * The delta-choice view model.
 *
 * semdelta.chooseDelta() builds a span delta and a semantic delta, measures
 * both, and returns the smaller one. That is a decision made on the user's
 * behalf about how many bytes cross the link, and a decision made on someone's
 * behalf that they cannot see is a decision they cannot check. So this turns
 * the result into exactly the rows the panel renders: which strategy won, what
 * both strategies would have cost, what the whole container would have cost,
 * and the sentence chooseDelta() already wrote explaining why.
 *
 * It is a pure function for the same reason the provenance view model above is
 * one: the failure mode of getting this wrong is a plausible-looking number
 * rather than an exception, and a plausible-looking number is only catchable by
 * asserting on the text that reaches the screen.
 *
 * It never recomputes the comparison. chooseDelta() owns the choice — including
 * the guard where a unit table costs more than it saves — and a second opinion
 * formed here could disagree with the payload actually sent.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    // tests.js already requires this file for the provenance view model above,
    // so this hangs off that export rather than replacing it.
    module.exports.deltaChoice = api;
  } else {
    root.RVQRDeltaChoiceView = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SEMANTIC = 'semantic';
  var SPAN = 'span';

  var LABELS = {};
  LABELS[SEMANTIC] = 'Semantic delta';
  LABELS[SPAN] = 'Span delta';

  // What the chosen row is suffixed with. It is spelled out rather than shown
  // as a tick because this is a selection, not a verdict — nothing here was
  // checked and found sound, and it must not read as if it had been.
  var CHOSEN_NOTE = 'chosen';

  function plain(n) { return String(n) + ' bytes'; }

  /**
   * @param chosen   the object semdelta.chooseDelta() returned
   * @param opts     { formatBytes } — the same formatter the rest of the page
   *                 uses, so the numbers on this panel read like the numbers
   *                 everywhere else
   */
  function model(chosen, opts) {
    opts = opts || {};
    var fmt = typeof opts.formatBytes === 'function' ? opts.formatBytes : plain;
    if (!chosen || (chosen.chosen !== SEMANTIC && chosen.chosen !== SPAN)) {
      return null;
    }
    var strategy = chosen.chosen;
    var label = LABELS[strategy];
    var saved = Math.max(0, chosen.fullBytes - chosen.bytes);
    var ratio = chosen.bytes > 0 ? chosen.fullBytes / chosen.bytes : 0;
    // The smaller of two deltas can still be bigger than the container. It
    // happens whenever most of a container turned over, and a panel that
    // announced it in the same encouraging tone as a genuine saving would be
    // selling a worse transfer as a better one.
    var worthIt = chosen.bytes < chosen.fullBytes;

    return {
      strategy: strategy,
      label: label,
      // The strategy is named in the headline rather than a footnote: a reader
      // who takes in one line of this panel should take in which one ran.
      headline: label + ': ' + fmt(chosen.bytes) + ' instead of ' + fmt(chosen.fullBytes) + '.',
      summary: (strategy === SEMANTIC
        ? chosen.unitDiff.missing.length + ' of ' + chosen.unitCount + ' units to send'
        : chosen.spanDiff.missing.length + ' of ' + chosen.spanCount + ' segments to send') +
        ', ' + fmt(saved) + ' saved' +
        (ratio >= 1.05 ? ' — ' + ratio.toFixed(1) + '× less data' : '') + '.',
      // Both figures, always, whichever won. A panel that showed only the
      // winner would be unfalsifiable: there would be no way to tell a good
      // choice from a broken comparison.
      rows: [
        row('Span delta', chosen.spanBytes, strategy === SPAN, fmt),
        row('Semantic delta', chosen.semanticBytes, strategy === SEMANTIC, fmt),
        row('Full transfer', chosen.fullBytes, false, fmt)
      ],
      reason: chosen.reason,
      note: worthIt ? null
        : 'Neither delta is smaller than the container itself. Most of it changed, ' +
          'so sending the whole artifact would cost fewer bytes than describing the difference.',
      tone: worthIt ? 'good' : ''
    };
  }

  function row(label, bytes, isChosen, fmt) {
    return {
      label: label,
      bytes: bytes,
      chosen: !!isChosen,
      // `text` is what the definition list actually shows, so a test that
      // asserts on it is asserting on the rendered string rather than on a
      // number that some later formatter might mangle.
      text: fmt(bytes) + (isChosen ? ' — ' + CHOSEN_NOTE : '')
    };
  }

  return {
    SEMANTIC: SEMANTIC,
    SPAN: SPAN,
    LABELS: LABELS,
    CHOSEN_NOTE: CHOSEN_NOTE,
    model: model
  };
});

(function () {
  'use strict';

  // Everything below this line is the user interface, and a user interface needs
  // a document. Under Node — where tests.js requires this file to reach the
  // view model above — there is none, so none of it runs.
  if (typeof document === 'undefined') return;

  var core = window.RVQRCore;
  var qrlib = window.RVQRCode;
  var qrdec = window.RVQRDecode;
  var rvflib = window.RVQRRvf;
  // expiry.js loads eagerly, before this file, because the vault consults it on
  // its very first read. Still read defensively: if it is missing, disposal is
  // simply unavailable rather than half-enforced.
  var expiryLib = window.RVQRExpiry || null;

  // The roadmap modules load with `defer`, so they are not present while app.js
  // is evaluating. Everything reads them through these getters and treats
  // absence as "feature off" rather than as an error — the vault must render
  // whether or not they ever arrive.
  function fountainLib() { return window.RVQRFountain || null; }
  function cryptoLib() { return window.RVQRCrypto || null; }
  function deltaLib() { return window.RVQRDelta || null; }
  function semDeltaLib() { return window.RVQRSemDelta || null; }
  function resumeLib() { return window.RVQRResume || null; }
  function proto2Lib() { return window.RVQRProto2 || null; }
  function provenanceLib() { return window.RVQRProvenance || null; }

  // The view model above, which this file also defines. Read through a getter
  // for the same reason as the rest: a missing panel is better than a broken
  // one, and the vault must render either way.
  function provenanceView() { return window.RVQRProvenanceView || null; }
  function deltaChoiceView() { return window.RVQRDeltaChoiceView || null; }

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ---------------------------------------------------------------------------
  // Hashing — crypto.subtle when the browser offers it, otherwise core's SHA-256.
  // ---------------------------------------------------------------------------

  function hashBytes(bytes) {
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      var copy = bytes.slice();
      return window.crypto.subtle.digest('SHA-256', copy.buffer).then(
        function (buf) { return core.toHex(new Uint8Array(buf)); },
        function () { return core.sha256Hex(bytes); }
      );
    }
    return Promise.resolve(core.sha256Hex(bytes));
  }

  // v1 carries the digest as 64 hex characters; v2 carries the 32 raw bytes.
  // The vault already holds the hex form, so this is the one conversion the
  // two formats need between them. Anything that is not a full digest comes
  // back null, and the caller recomputes rather than sending a short hash.
  function hexToBytes(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return null;
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Vault (IndexedDB)
  // ---------------------------------------------------------------------------

  var DB_NAME = 'rvqr';
  var STORE = 'artifacts';
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable in this browser context'));
        return;
      }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function vaultList() {
    return tx('readonly', function (store) { return store.getAll(); }).then(function (rows) {
      rows = rows || [];
      rows.sort(function (a, b) { return b.addedAt - a.addedAt; });
      return sweepExpired(rows);
    });
  }

  /**
   * The enforcement point for timed disposal.
   *
   * Every read of the vault passes through here, so a record whose moment
   * arrived while the app was closed — when no timer of ours was running — is
   * deleted before anything can list it, open it, send it or export it. The
   * in-page timer below is a convenience that makes the countdown reach zero
   * while you watch; this is what makes the deletion actually happen.
   *
   * A record that fails to delete is still withheld from the caller, and the
   * failure is surfaced rather than swallowed: the app must never quietly show
   * an artifact it has told you is gone, nor quietly claim one is gone when it
   * is not.
   */
  function sweepExpired(rows) {
    if (!expiryLib) return Promise.resolve(rows);
    var split = expiryLib.partition(rows, Date.now());
    if (!split.expired.length) return Promise.resolve(rows);
    return Promise.all(split.expired.map(function (r) {
      return vaultDelete(r.id).then(function () { return null; }, function (err) { return err; });
    })).then(function (errors) {
      var failed = errors.filter(Boolean).length;
      if (failed) {
        toast(failed + ' expired artifact' + (failed === 1 ? '' : 's') + ' could not be deleted');
      } else {
        toast(split.expired.length + ' artifact' +
          (split.expired.length === 1 ? '' : 's') + ' reached expiry and ' +
          (split.expired.length === 1 ? 'was' : 'were') + ' destroyed');
      }
      return split.live;
    });
  }

  function vaultGet(id) {
    return tx('readonly', function (store) { return store.get(id); });
  }

  function vaultDelete(id) {
    return tx('readwrite', function (store) { return store.delete(id); });
  }

  function vaultPut(record) {
    return tx('readwrite', function (store) { return store.put(record); }).then(function () {
      return record;
    });
  }

  // Single door into the vault, so the name clamp cannot be forgotten at a
  // call site. Names from a received manifest are unauthenticated input.
  function storeArtifact(name, bytes, origin) {
    var safeName = core.sanitizeName(name);
    return hashBytes(bytes).then(function (sha256) {
      var type = core.detectArtifactType(bytes);
      var record = {
        id: sha256 + ':' + safeName,
        name: safeName,
        size: bytes.length,
        sha256: sha256,
        kind: type.kind,
        kindLabel: type.label,
        kindDetail: type.detail,
        origin: origin || 'import',
        addedAt: Date.now(),
        data: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer
      };
      return vaultPut(record);
    });
  }

  function recordBytes(record) {
    return new Uint8Array(record.data);
  }

  // ---------------------------------------------------------------------------
  // Vault rendering
  // ---------------------------------------------------------------------------

  var cachedVault = [];

  // Every live countdown currently on screen, as { row, node }. Kept so the
  // ticker can repaint the digits without rebuilding the list a user may be
  // in the middle of reading.
  var countdownNodes = [];
  // The detail sheet's own countdown is tracked separately from the list's,
  // because the two are rebuilt on different schedules: a vault re-render must
  // not silently stop the clock on an open sheet.
  var detailCountdown = null;
  var expiryTimer = null;

  /** Renders one artifact's disposal state as a readout chip, or nothing. */
  function countdownChip(row) {
    if (!expiryLib || !row.expiry) return null;
    var node = el('span', 'countdown');
    paintCountdown(node, row, Date.now());
    countdownNodes.push({ row: row, node: node });
    return node;
  }

  function paintCountdown(node, row, now) {
    var d = expiryLib.describe(row.expiry, now);
    node.className = 'countdown tone-' + d.tone;
    node.textContent = d.countdown || 'burn';
    node.title = d.countdown ? d.label + ' ' + d.countdown : d.label;
  }

  /**
   * One timer for the whole app rather than one per artifact. It repaints
   * running countdowns each second, and once anything is actually due it hands
   * over to renderVault, whose read of the vault performs the deletion.
   */
  function tickExpiry() {
    if (!expiryLib) return;
    var now = Date.now();
    if (expiryLib.partition(cachedVault, now).expired.length) {
      renderVault();
      if (openDetailId) openDetail(openDetailId);
      return;
    }
    countdownNodes.forEach(function (entry) {
      paintCountdown(entry.node, entry.row, now);
    });
    if (detailCountdown) paintCountdown(detailCountdown.node, detailCountdown.row, now);
  }

  function scheduleExpiryTimer() {
    if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
    if (!expiryLib) return;
    // No clock anywhere in the vault means no timer: a burn-on-export record
    // needs no ticking, and neither does an empty vault.
    if (expiryLib.nextDeadline(cachedVault, Date.now()) === null) return;
    expiryTimer = setInterval(tickExpiry, 1000);
  }

  function glyphFor(kind) {
    if (kind === 'rvf') return 'RVF';
    if (kind === 'wasm') return 'WASM';
    return 'BIN';
  }

  function renderVault() {
    return vaultList().then(function (rows) {
      cachedVault = rows;
      countdownNodes = []; // the nodes they pointed at are about to be discarded
      var list = $('vaultList');
      list.textContent = '';
      $('vaultCount').textContent = rows.length ? '(' + rows.length + ')' : '';
      refreshSendPicker();

      scheduleExpiryTimer();

      if (!rows.length) {
        var empty = el('div', 'card empty');
        empty.appendChild(el('p', '', 'No artifacts yet.'));
        empty.appendChild(el('p', 'small', 'Import a file, or load the 40 KB demo WASM module to try a transfer.'));
        list.appendChild(empty);
        return rows;
      }

      rows.forEach(function (row) {
        var btn = el('button', 'card artifact');
        var g = el('div', 'glyph ' + row.kind, glyphFor(row.kind));
        var mid = el('div', 'grow');
        var nameLine = el('div', 'name truncate', row.name);
        var meta = el('div', 'small muted truncate');
        meta.textContent = core.formatBytes(row.size) + ' · ' + row.sha256.slice(0, 12) + '…';
        mid.appendChild(nameLine);
        mid.appendChild(meta);
        var badges = el('div', 'badges');
        if (row.origin === 'received') {
          badges.appendChild(el('span', 'badge received', 'received'));
        }
        badges.appendChild(
          el('span', 'badge ' + row.kind, row.kind === 'generic' ? 'file' : row.kind)
        );
        var chip = countdownChip(row);
        if (chip) badges.appendChild(chip);
        btn.appendChild(g);
        btn.appendChild(mid);
        btn.appendChild(badges);
        btn.addEventListener('click', function () { openDetail(row.id); });
        list.appendChild(btn);
      });
      return rows;
    }).catch(function (err) {
      var list = $('vaultList');
      list.textContent = '';
      var n = el('div', 'card');
      n.appendChild(el('div', 'notice bad', 'Storage unavailable: ' + err.message));
      list.appendChild(n);
    });
  }

  // ---------------------------------------------------------------------------
  // Artifact detail sheet
  // ---------------------------------------------------------------------------

  var dialog = $('detail');

  // Where the stylesheet docks the detail sheet as a side panel, it is opened
  // NON-modally so the vault list behind it stays visible and clickable:
  // opening an artifact must not cost you your place in the list. Narrower
  // than that it stays a modal sheet, which is the right idiom on a phone.
  // The width here is the same 1060px the stylesheet uses for the docked panel.
  var DOCKED_QUERY = '(min-width: 1060px)';
  function dockedLayout() {
    return !!(window.matchMedia && window.matchMedia(DOCKED_QUERY).matches);
  }

  function showSheet() {
    // Already showing: openDetail has just replaced the body in place, which is
    // what makes clicking a second artifact work while the panel is docked.
    // Re-opening would also throw if the layout changed under an open modal.
    if (dialog.open) return;
    if (dockedLayout() && dialog.show) dialog.show();
    else if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  function hideSheet() {
    openDetailId = null;
    detailCountdown = null;
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
  }

  // Which artifact the detail sheet is showing, so the expiry ticker can
  // refresh it in place — and so a sheet left open on a record that expires
  // does not keep offering Send and Download for something already deleted.
  var openDetailId = null;

  function openDetail(id) {
    vaultGet(id).then(function (row) {
      if (!row) {
        // Swept out from under us, most likely by its own expiry.
        if (openDetailId === id) hideSheet();
        return;
      }
      if (expiryLib && expiryLib.isExpired(row.expiry, Date.now())) {
        hideSheet();
        renderVault();
        return;
      }
      openDetailId = id;
      var bytes = recordBytes(row);
      $('detailName').textContent = row.name;
      var body = $('detailBody');
      body.textContent = '';

      var dl = el('dl', 'kv');
      function kv(k, v, cls) {
        dl.appendChild(el('dt', '', k));
        dl.appendChild(el('dd', cls || '', v));
      }
      kv('Type', row.kindLabel);
      kv('Detected because', row.kindDetail, 'small muted');
      kv('Size', core.formatBytes(row.size) + ' (' + row.size.toLocaleString() + ' bytes)');
      kv('SHA-256', row.sha256, 'mono');
      kv('Added', new Date(row.addedAt).toLocaleString() + ' · ' + row.origin, 'small muted');
      kv('First bytes', core.hexPreview(bytes, 32), 'mono');
      body.appendChild(dl);

      if (row.kind === 'rvf') {
        var rvfBox = el('div', 'card tight');
        rvfBox.style.marginTop = '1rem';
        rvfBox.appendChild(el('h3', '', 'Container contents'));
        var rvfStatus = el('p', 'small muted', 'Loading the RVF microkernel\u2026');
        rvfBox.appendChild(rvfStatus);
        body.appendChild(rvfBox);
        renderRvf(rvfBox, rvfStatus, bytes);

        // Its own card, and rendered synchronously, because provenance is not
        // downstream of the microkernel: provenance.js walks the segment chain
        // itself precisely so that a container's account of itself can be read
        // on a machine where the WASM kernel never loads. Wiring it inside
        // renderRvf's promise would have quietly made the one dependent on the
        // other.
        var provBox = el('div', 'card tight');
        provBox.style.marginTop = '1rem';
        provBox.appendChild(el('h3', '', 'Provenance'));
        body.appendChild(provBox);
        renderProvenance(provBox, bytes);
      }

      if (row.kind === 'wasm') {
        var wasmBox = el('div', 'card tight');
        wasmBox.style.marginTop = '1rem';
        wasmBox.appendChild(el('h3', '', 'Module inspection'));
        var status = el('p', 'small muted', 'Compiling (no instantiation, no execution)…');
        wasmBox.appendChild(status);
        body.appendChild(wasmBox);
        inspectWasm(bytes).then(function (info) {
          status.textContent =
            info.exports.length + ' exports, ' + info.imports.length + ' imports. ' +
            'Compiled only — the module was never instantiated and no function was called.';
          if (info.exports.length) {
            var pre = el('div', 'mono small');
            pre.style.marginTop = '.5rem';
            pre.style.maxHeight = '160px';
            pre.style.overflowY = 'auto';
            pre.textContent = info.exports
              .map(function (e) { return e.kind + ' ' + e.name; })
              .join('\n');
            wasmBox.appendChild(pre);
          }
        }, function (err) {
          status.textContent = 'Could not compile: ' + err.message;
        });
      }

      var actions = el('div', 'row');
      actions.style.marginTop = '1.2rem';
      var sendBtn = el('button', 'btn-primary grow', 'Send this');
      sendBtn.addEventListener('click', function () {
        hideSheet();
        selectTab('send');
        $('sendPick').value = row.id;
        startSend(row.id);
      });
      var dlBtn = el('button', '', 'Download');
      dlBtn.addEventListener('click', function () { download(row); });
      actions.appendChild(sendBtn);
      actions.appendChild(dlBtn);
      body.appendChild(actions);

      body.appendChild(buildDisposal(row));

      showSheet();
    });
  }

  // ---------------------------------------------------------------------------
  // Disposal
  //
  // The destructive controls live together, behind the danger colour and a
  // confirmation, and away from Send and Download so that no amount of muscle
  // memory turns one into the other. Nothing here is decorative: arming writes
  // to the record, and every path out of it ends in a real vaultDelete.
  // ---------------------------------------------------------------------------

  function buildDisposal(row) {
    detailCountdown = null; // the previous sheet's node is being replaced
    var box = el('div', 'card tight disposal');
    box.appendChild(el('h3', '', 'Disposal'));

    if (!expiryLib) {
      box.appendChild(el('p', 'small muted',
        'The disposal module did not load, so self-destruct is unavailable for ' +
        'this artifact. Nothing is armed.'));
      return box;
    }

    var now = Date.now();
    var state = expiryLib.describe(row.expiry, now);
    var statusRow = el('div', 'row');
    statusRow.appendChild(el('span', 'small muted grow', row.expiry
      ? state.label + (state.countdown ? '' : ' — destroyed on the next download')
      : 'Nothing armed. This artifact stays until you delete it.'));
    if (row.expiry) {
      var chip = el('span', 'countdown');
      paintCountdown(chip, row, now);
      detailCountdown = { row: row, node: chip };
      statusRow.appendChild(chip);
    }
    box.appendChild(statusRow);

    var opts = el('div', 'disposal-opts');
    var currentMode = row.expiry ? row.expiry.mode : 'keep';

    function option(value, title, detail) {
      var label = el('label', 'opt');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'disposal-' + row.id;
      input.value = value;
      input.checked = value === currentMode;
      var text = el('div', 'opt-text');
      text.appendChild(el('strong', '', title));
      text.appendChild(el('span', '', detail));
      label.appendChild(input);
      label.appendChild(text);
      opts.appendChild(label);
      return input;
    }

    option('keep', 'Keep', 'No expiry. Delete it yourself when you are done with it.');
    option(expiryLib.MODE_BURN, 'Burn after export',
      'Deletes the vault copy as soon as you download it. Showing it as QR ' +
      'frames does not consume it, so a transfer can be re-sent.');
    option(expiryLib.MODE_TIMED, 'Timed expiry',
      'Deletes it once the clock runs out, whether or not it was ever used.');

    var ttl = document.createElement('select');
    ttl.setAttribute('aria-label', 'Time until this artifact is destroyed');
    expiryLib.TTL_PRESETS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      ttl.appendChild(o);
    });
    if (row.expiry && row.expiry.mode === expiryLib.MODE_TIMED) {
      ttl.value = expiryLib.TTL_PRESETS[0].id;
    }
    box.appendChild(opts);
    var ttlLabel = el('label', 'field', 'Time until destruction');
    box.appendChild(ttlLabel);
    box.appendChild(ttl);

    function chosen() {
      var checked = opts.querySelector('input:checked');
      return checked ? checked.value : 'keep';
    }
    function syncTtl() { ttl.disabled = chosen() !== expiryLib.MODE_TIMED; }
    opts.addEventListener('change', syncTtl);
    syncTtl();

    var armBtn = el('button', 'btn-danger btn-block', 'Apply disposal setting');
    armBtn.style.marginTop = '.7rem';
    armBtn.addEventListener('click', function () {
      var mode = chosen();
      if (mode === 'keep') {
        if (!row.expiry) { toast('Nothing was armed'); return; }
        if (!confirm('Disarm disposal for "' + row.name + '"?\n\n' +
          'It will stay on this device until you delete it.')) return;
        row.expiry = null;
        vaultPut(row).then(function () {
          toast('Disposal disarmed');
          openDetail(row.id);
          renderVault();
        });
        return;
      }

      var preset = expiryLib.ttlById(ttl.value);
      var next = expiryLib.createExpiry(mode, Date.now(), preset ? preset.ms : 0);
      if (!next) { toast('That disposal setting could not be armed'); return; }

      var warning = mode === expiryLib.MODE_BURN
        ? 'Arm "burn after export" on "' + row.name + '"?\n\n' +
          'The next time you download it, this device\'s copy is deleted.'
        : 'Arm a ' + (preset ? preset.label : '') + ' expiry on "' + row.name + '"?\n\n' +
          'When the time is up, this device\'s copy is deleted.';
      if (!confirm(warning + '\n\n' +
        'This deletes this app\'s copy on this device only. It cannot recall a ' +
        'file you already exported or a copy another device received, and ' +
        'browser storage is not secure erasure.')) return;

      row.expiry = next;
      vaultPut(row).then(function () {
        toast(mode === expiryLib.MODE_BURN ? 'Armed: burn after export' : 'Expiry armed');
        openDetail(row.id);
        renderVault();
      });
    });
    box.appendChild(armBtn);

    var nukeBtn = el('button', 'btn-danger-solid btn-block', 'Destroy now');
    nukeBtn.style.marginTop = '.5rem';
    nukeBtn.addEventListener('click', function () {
      if (!confirm('Destroy "' + row.name + '" now?\n\n' +
        'This deletes it from this device immediately and cannot be undone.')) return;
      vaultDelete(row.id).then(function () {
        hideSheet();
        toast('Destroyed');
        renderVault();
      }, function (err) {
        toast('Could not delete: ' + err.message);
      });
    });
    box.appendChild(nukeBtn);

    box.appendChild(el('p', 'small muted', 'What this does not do:'));
    var limits = el('ul', 'limits');
    expiryLib.describeLimits().forEach(function (line) {
      limits.appendChild(el('li', '', line));
    });
    box.appendChild(limits);

    return box;
  }

  // ---------------------------------------------------------------------------
  // RVF container inspection
  //
  // The microkernel is instantiated to parse the container. That is this app
  // loading a tool, not the artifact running: the kernel imports nothing, and
  // the container is data passed to it.
  // ---------------------------------------------------------------------------

  function renderRvf(box, status, bytes) {
    if (!rvflib) {
      status.textContent = 'The RVF binding failed to load.';
      return;
    }
    rvflib.load('./demo/rvf_wasm_bg.wasm').then(function (kernel) {
      var report = rvflib.inspect(kernel, bytes);
      status.textContent = report.header
        ? 'Parsed by the RVF microkernel \u2014 ' + report.segmentCount +
          ' segments, first segment ' + report.header.typeName + '.'
        : 'The kernel could not read a segment header here.';

      if (report.header) {
        var dl = el('dl', 'kv small');
        function kv(k, v) {
          dl.appendChild(el('dt', '', k));
          dl.appendChild(el('dd', '', v));
        }
        kv('Magic', report.header.magicBytes + '  (v1 segment magic)');
        kv('Version', String(report.header.version));
        kv('First segment', report.header.typeName + ' (type ' + report.header.type + ')');
        box.appendChild(dl);
      }

      if (report.segments.length) {
        var wrap = el('div', 'scroll-x');
        wrap.style.marginTop = '.8rem';
        var table = el('table', 'seg');
        var thead = el('tr');
        ['#', 'Type', 'Size', 'Offset', 'CRC32C'].forEach(function (h) {
          thead.appendChild(el('th', '', h));
        });
        table.appendChild(thead);
        report.segments.forEach(function (seg) {
          var tr = el('tr');
          tr.appendChild(el('td', 'num', String(seg.index)));
          tr.appendChild(el('td', '', seg.typeName));
          tr.appendChild(el('td', 'num', core.formatBytes(seg.size)));
          tr.appendChild(el('td', 'num', String(seg.offset)));
          tr.appendChild(el('td', 'mono', seg.crc32c || '\u2014'));
          table.appendChild(tr);
        });
        wrap.appendChild(table);
        box.appendChild(wrap);
      }

      if (report.checks.length) {
        var checks = el('div');
        checks.style.marginTop = '.8rem';
        report.checks.forEach(function (c) {
          var row = el('div', 'check ' + c.status);
          var marks = { pass: '\u2713', warn: '!', fail: '\u2717', unavailable: '\u2013' };
          row.appendChild(el('div', 'mark', marks[c.status] || '\u2013'));
          var b = el('div', 'body');
          b.appendChild(el('strong', '', c.name));
          b.appendChild(el('span', '', c.detail));
          row.appendChild(b);
          checks.appendChild(row);
        });
        box.appendChild(checks);
      }

      if (report.vectors && report.vectors.ok) {
        buildQueryPanel(box, kernel, bytes, report);
      }
      buildInventoryPanel(box, bytes, kernel);
    }, function (err) {
      status.textContent = 'Could not load the RVF microkernel: ' + err.message +
        (window.location.protocol === 'file:'
          ? ' (opening the page over http rather than from disk will fix this)'
          : '');
    });
  }

  // ---------------------------------------------------------------------------
  // Embedded provenance
  //
  // Per ADR-020. The panel's job is to keep two kinds of statement apart on
  // screen: a hash this device recomputed against bytes it holds, and a claim
  // that arrived in the same file as the thing it describes. The first gets a
  // verdict. The second gets an author and never a tick — see the view model at
  // the top of this file, which makes that split before any node is created.
  // ---------------------------------------------------------------------------

  function renderProvenance(box, bytes) {
    var lib = provenanceLib();
    var view = provenanceView();
    if (!lib || !view) {
      // A missing reader is a missing tool, not an unprovenanced container, and
      // saying "no provenance" here would be a lie about the file.
      box.appendChild(el('p', 'small muted',
        'The provenance reader is not loaded, so this container’s provenance was not ' +
        'examined. That is a tool this page is missing, not something known about the file.'));
      return;
    }

    var read, report;
    try {
      read = lib.readContainer(bytes);
      report = lib.verify(read.provenance, bytes, {
        sha256: function (b) { return core.sha256Hex(b); }
      });
    } catch (err) {
      // readContainer and decode are documented not to throw, and verify is
      // meant to be reachable with hostile input too. This catch is here
      // because the input is a file from an unknown sender and the cost of
      // being wrong about that promise is a detail sheet that renders nothing
      // at all.
      read = null;
      report = null;
      var m0 = view.model(null, null);
      m0.detail = 'The provenance reader threw: ' +
        (err && err.message ? err.message : String(err)) + '.';
      paintProvenance(box, m0, lib.describeLimits());
      return;
    }

    paintProvenance(box, view.model(read, report), lib.describeLimits());
  }

  /** One row of the checked list: a verdict, a mark, and what was compared. */
  function checkRow(entry) {
    var row = el('div', 'check ' + entry.status);
    row.appendChild(el('div', 'mark', entry.mark));
    var b = el('div', 'body');
    b.appendChild(el('strong', '', entry.name));
    b.appendChild(el('span', '', entry.detail));
    row.appendChild(b);
    return row;
  }

  /**
   * One row of the asserted list. A different element, a different class and a
   * different mark from checkRow above — an assertion that merely looked like a
   * check would be the failure this whole panel exists to avoid.
   */
  function claimRow(entry) {
    var row = el('div', 'claim');
    row.appendChild(el('div', 'mark', entry.mark));
    var b = el('div', 'body');
    var head = el('strong', '');
    head.textContent = entry.name;
    b.appendChild(head);
    var val = el('span', 'value' + (entry.stated ? '' : ' none'), entry.value);
    b.appendChild(val);
    b.appendChild(el('span', 'who', entry.attribution));
    b.appendChild(el('span', '', entry.detail));
    row.appendChild(b);
    return row;
  }

  function subhead(text) {
    return el('p', 'subhead', text);
  }

  function paintProvenance(box, m, limits) {
    var view = provenanceView();

    if (m.state === view.ABSENT) {
      var absent = el('div', 'notice prov-note');
      absent.appendChild(el('strong', '', m.headline));
      absent.appendChild(el('p', 'small muted', m.detail));
      box.appendChild(absent);
      if (typeof m.segments === 'number') {
        box.appendChild(el('p', 'small muted',
          m.segments + ' segments were walked, and none of them was a provenance segment.'));
      }
      appendLimits(box, limits);
      return;
    }

    if (m.state === view.UNREADABLE) {
      var bad = el('div', 'notice bad prov-note');
      bad.appendChild(el('strong', '', m.headline));
      bad.appendChild(el('p', 'small muted', m.detail));
      box.appendChild(bad);
      appendLimits(box, limits);
      return;
    }

    // A failed check leads, before the summary and before anything the document
    // says about itself.
    if (m.banner) {
      var banner = el('div', 'notice bad prov-note');
      banner.appendChild(el('strong', '', m.headline));
      banner.appendChild(el('p', 'small muted', m.banner.text));
      box.appendChild(banner);
    }

    var summary = el('p', 'small muted');
    summary.textContent = m.detail +
      (m.segment ? ' · provenance in segment ' + m.segment.index : '');
    box.appendChild(summary);

    if (m.canonicalNote) {
      var canon = el('div', 'notice prov-note');
      canon.appendChild(el('p', 'small muted', m.canonicalNote));
      box.appendChild(canon);
    }

    if (m.checks.length) {
      box.appendChild(subhead('Checked here, against these bytes'));
      var checks = el('div');
      m.checks.forEach(function (c) { checks.appendChild(checkRow(c)); });
      box.appendChild(checks);
    }

    if (m.components.length) {
      box.appendChild(subhead('Components'));
      var wrap = el('div', 'scroll-x');
      var table = el('table', 'seg prov');
      var head = el('tr');
      ['', 'Component', 'Licences', 'Segment', 'SHA-256'].forEach(function (h) {
        head.appendChild(el('th', '', h));
      });
      table.appendChild(head);
      m.components.forEach(function (c) {
        var tr = el('tr', 'comp ' + c.status);
        tr.appendChild(el('td', 'mark', c.mark));
        var nameCell = el('td', '');
        nameCell.appendChild(el('span', '', c.name + (c.version ? ' ' + c.version : '')));
        if (c.purpose) nameCell.appendChild(el('span', 'small muted', ' · ' + c.purpose));
        tr.appendChild(nameCell);
        tr.appendChild(el('td', 'small', c.licences.length ? c.licences.join(', ') : '—'));
        tr.appendChild(el('td', 'num', c.segment === null ? '—' : String(c.segment)));
        tr.appendChild(el('td', 'mono', c.sha256 ? c.sha256.slice(0, 16) + '…' : '—'));
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      box.appendChild(wrap);
    }

    if (m.claims.length) {
      box.appendChild(subhead('Asserted by the artifact — not checked'));
      box.appendChild(el('p', 'small muted',
        'Everything below arrived in the same file as the thing it describes. A signature ' +
        'over it would prove who wrote it, never that it is true.'));
      var claims = el('div');
      m.claims.forEach(function (c) { claims.appendChild(claimRow(c)); });
      box.appendChild(claims);
    }

    if (m.facts.length) {
      box.appendChild(subhead('What the document says'));
      var dl = el('dl', 'kv small');
      m.facts.forEach(function (f) {
        dl.appendChild(el('dt', '', f.label));
        dl.appendChild(el('dd', (f.mono ? 'mono' : '') + (f.absent ? ' muted' : ''), f.value));
      });
      box.appendChild(dl);
    }

    appendLimits(box, limits);
  }

  /** provenance.js owns this wording so the panel cannot overclaim past it. */
  function appendLimits(box, limits) {
    if (!limits || !limits.length) return;
    var details = el('details', 'prov-limits');
    details.appendChild(el('summary', '', 'What this can and cannot prove'));
    var ul = el('ul', 'limits');
    limits.forEach(function (line) { ul.appendChild(el('li', '', line)); });
    details.appendChild(ul);
    box.appendChild(details);
  }

  /** Live nearest-neighbour search over the vectors in the container. */
  function buildQueryPanel(box, kernel, bytes, report) {
    var vectors = report.vectors;
    var panel = el('div');
    panel.style.marginTop = '1rem';
    panel.appendChild(el('h3', '', 'Search these vectors'));
    panel.appendChild(el('p', 'small muted',
      vectors.count + ' vectors of ' + vectors.dim + ' dimensions. Pick a stored ' +
      'vector as the query, or roll a random one, and rvQR ranks the rest by distance.'));

    var controls = el('div', 'row');
    var metricSel = el('select');
    ['cosine', 'euclidean', 'inner product'].forEach(function (m) {
      var o = el('option', '', m);
      o.value = m;
      metricSel.appendChild(o);
    });
    metricSel.style.flex = '1 1 8rem';
    var randomBtn = el('button', 'btn-sm', 'Random query');
    var storedBtn = el('button', 'btn-sm', 'Use a stored vector');
    controls.appendChild(metricSel);
    controls.appendChild(randomBtn);
    controls.appendChild(storedBtn);
    panel.appendChild(controls);

    var queryLabel = el('p', 'small muted');
    queryLabel.style.margin = '.6rem 0 .2rem';
    panel.appendChild(queryLabel);
    var results = el('div');
    panel.appendChild(results);
    box.appendChild(panel);

    var current = null;
    var currentLabel = '';

    function run() {
      if (!current) return;
      var metric = metricSel.value;
      var ranked = rvflib.queryVectors(vectors, current, 5, metric);
      results.textContent = '';
      queryLabel.textContent = 'Query: ' + currentLabel + ' \u00b7 metric ' + metric;
      if (!ranked.length) {
        results.appendChild(el('p', 'small muted', 'No results.'));
        return;
      }
      var worst = Math.max.apply(null, ranked.map(function (r) { return Math.abs(r.distance); })) || 1;
      ranked.forEach(function (r) {
        var row = el('div', 'rank');
        row.appendChild(el('span', 'id', 'id ' + r.id));
        var bar = el('div', 'bar2');
        var fill = el('i');
        // Nearer means a longer bar, so the eye reads it the right way round.
        fill.style.width = Math.max(3, 100 - (Math.abs(r.distance) / worst) * 92) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', 'd', r.distance.toFixed(4)));
        results.appendChild(row);
      });

      // Show the kernel's own answer too when it disagrees, rather than
      // quietly presenting one engine's numbers as the truth.
      if (report.store && report.store.agrees === false) {
        var note = el('p', 'small muted');
        note.style.marginTop = '.5rem';
        note.textContent = 'Ranking comes from rvQR\u2019s reader. The bundled 0.1.9 ' +
          'kernel reads this container\u2019s vector header transposed, so its own ' +
          'store query returns ids that do not match the file.';
        results.appendChild(note);
      }
    }

    randomBtn.addEventListener('click', function () {
      current = rvflib.randomUnitVector(vectors.dim);
      currentLabel = 'random unit vector';
      run();
    });
    storedBtn.addEventListener('click', function () {
      var i = Math.floor(Math.random() * vectors.count);
      current = vectors.vectors[i];
      currentLabel = 'stored vector id ' + vectors.ids[i];
      run();
    });
    metricSel.addEventListener('change', run);

    // Start with a stored vector: its own id coming back at distance zero is
    // the clearest possible demonstration that the search is real.
    current = vectors.vectors[0];
    currentLabel = 'stored vector id ' + vectors.ids[0];
    run();
  }

  // ---------------------------------------------------------------------------
  // Delta transfer
  //
  // Needs a reverse channel the optical link does not have, so it borrows one:
  // the receiver shows an inventory of what it holds as a QR, and the sender
  // reads that with its own camera. Both devices therefore need a camera for
  // this flow, which is the honest cost of the feature.
  //
  // Two strategies can satisfy that request. delta.js resends whole segments;
  // semdelta.js goes inside them and resends records, WASM function bodies or
  // COW blocks. Neither is always smaller — a unit table costs bytes per unit,
  // and a container of many small records can spend more describing itself than
  // a span delta spends resending a segment. semdelta.chooseDelta() builds both
  // payloads, measures both and returns the smaller, and this file does not
  // form a second opinion: it renders the one chooseDelta() reached, both
  // figures, and the sentence it wrote explaining the choice. A transfer size
  // nobody can explain is a transfer size nobody can trust.
  //
  // The receiver's inventory is sealed to a crypto.js session, because an
  // inventory is a list of what a device holds: segment types, content hashes
  // and a root digest together tell anyone watching which artifacts and which
  // versions this device has. Sealing needs a session, and a session needs a
  // handshake, so pairing is a real step with a real cost rather than a
  // checkbox.
  // ---------------------------------------------------------------------------

  // What the sealed inventory's associated data names. Both ends must agree, or
  // the ciphertext will not open — which is the point: a sealed inventory
  // cannot be replayed into a slot that expected a different kind of message.
  var INVENTORY_CONTEXT = 'rvqr/semantic-inventory/v1';

  // delta.js's chunk header, so scanned text can be told from a single code.
  var INVENTORY_CHUNK_PREFIX = 'RVQI1:';

  // One session per device, whichever end of the handshake it happens to be.
  // `state` is the initiator's half-finished handshake and is discarded the
  // moment the session exists, so a stale invite cannot be confirmed twice.
  var pairing = { role: null, state: null, session: null };

  /** Draws a list of QR texts into `out`, with a part count when there is more than one. */
  function appendQrCodes(out, chunks, ecl) {
    chunks.forEach(function (text, idx) {
      var holder = el('div');
      holder.style.background = '#fff';
      holder.style.padding = '8px';
      holder.style.borderRadius = '10px';
      holder.style.marginTop = '.5rem';
      var canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.maxWidth = '300px';
      canvas.style.display = 'block';
      canvas.style.imageRendering = 'pixelated';
      holder.appendChild(canvas);
      out.appendChild(holder);
      var qr = qrlib.encodeText(text, { ecl: ecl || 'L' });
      qrlib.drawOnCanvas(qr, canvas, { size: 600 });
      out.appendChild(el('p', 'small muted',
        (chunks.length > 1 ? 'part ' + (idx + 1) + ' of ' + chunks.length + ' · ' : '') +
        'QR version ' + qr.version));
    });
  }

  /**
   * Splits text across as many symbols as it needs.
   *
   * A sealed semantic inventory carries a record per unit rather than per
   * segment, so it routinely outgrows one symbol. Degrading it is not an
   * option — a partial inventory would make the sender resend units the
   * receiver already holds — so it is chunked, exactly as delta.js chunks its
   * own oversized inventories, and the receiver's scanner reassembles them.
   */
  function qrChunksFor(lib, text) {
    var fit = lib.qrVersionFor(text.length, 'L');
    return fit ? [text] : lib.chunkInventory(text, lib.byteCapacity(40, 'L'));
  }

  /** The inverse: one text from however many codes were scanned or pasted. */
  function reassembleInventory(lib, raw) {
    var parts = String(raw).split(/\s+/).filter(function (s) { return s.length > 0; });
    if (!parts.length) return '';
    if (parts[0].slice(0, INVENTORY_CHUNK_PREFIX.length) === INVENTORY_CHUNK_PREFIX) {
      return lib.joinInventoryChunks(parts);
    }
    return parts.join('');
  }

  // --- Pairing ---------------------------------------------------------------

  /**
   * What the session does and does not prove.
   *
   * An unpinned handshake stops a passive observer reading the inventory. It
   * does not stop an active one from having been the party you paired with in
   * the first place, and saying otherwise would be the same overclaim the
   * signature panel refuses to make about an unpinned key.
   */
  function pairingNote(session) {
    return session.identityVerified
      ? 'Paired with the fingerprint you pinned. Their inventory travels encrypted.'
      : 'Paired, so their inventory travels encrypted rather than in the clear. ' +
        'Nothing here proves who you paired with — compare fingerprint ' +
        session.peerFingerprint + ' out of band if that matters.';
  }

  function startPairing() {
    var lib = cryptoLib();
    var box = $('deltaPairResult');
    box.textContent = '';
    if (!lib) {
      box.appendChild(el('div', 'notice bad',
        'The crypto module did not load, so no session can be established.'));
      return;
    }
    Promise.resolve(lib.sessionInvite({})).then(function (state) {
      pairing.role = 'initiator';
      pairing.state = state;
      pairing.session = null;
      box.textContent = '';
      box.appendChild(el('p', 'small muted',
        'Show this to the device holding the older copy. It answers with a code of ' +
        'its own — scan or paste that below to finish.'));
      appendQrCodes(box, [state.bootstrap]);
    }, function (e) {
      box.appendChild(el('div', 'notice bad', 'Could not start a session: ' + e.message));
    });
  }

  function finishPairing() {
    var lib = cryptoLib();
    var box = $('deltaPairResult');
    if (!lib) {
      box.textContent = '';
      box.appendChild(el('div', 'notice bad', 'The crypto module did not load.'));
      return;
    }
    if (!pairing.state || pairing.role !== 'initiator') {
      box.textContent = '';
      box.appendChild(el('div', 'notice', 'Show your pairing code first, then scan their reply.'));
      return;
    }
    var reply = $('deltaPairReply').value.trim();
    if (!reply) {
      box.textContent = '';
      box.appendChild(el('div', 'notice', 'Paste or scan their reply code first.'));
      return;
    }
    Promise.resolve(lib.sessionConfirm(pairing.state, reply, {})).then(function (r) {
      box.textContent = '';
      if (!r.ok) {
        // Named rather than smoothed over: 'session-id-mismatch' and
        // 'bad-bootstrap-signature' are different problems with different fixes.
        box.appendChild(el('div', 'notice bad', 'Pairing failed: ' + r.reason + '.'));
        return;
      }
      pairing.session = r.session;
      pairing.state = null;
      box.appendChild(el('div', 'notice good', pairingNote(r.session)));
    }, function (e) {
      box.textContent = '';
      box.appendChild(el('div', 'notice bad', 'Pairing failed: ' + e.message));
    });
  }

  // --- The receiver's half ---------------------------------------------------

  function buildInventoryPanel(box, bytes, kernel) {
    var lib = deltaLib();
    if (!lib) return;
    var panel = el('div');
    panel.style.marginTop = '1rem';
    panel.appendChild(el('h3', '', 'Update from another device'));
    panel.appendChild(el('p', 'small muted',
      'Show this code to a device holding a newer copy. It works out which ' +
      'segments you are missing and sends only those.'));

    var pairOut = el('div');
    pairOut.style.marginTop = '.7rem';
    buildAcceptPairingControls(panel, pairOut);
    panel.appendChild(pairOut);

    var btn = el('button', 'btn-sm', 'Show my inventory');
    btn.style.marginTop = '.7rem';
    panel.appendChild(btn);
    var out = el('div');
    out.style.marginTop = '.7rem';
    panel.appendChild(out);
    box.appendChild(panel);

    btn.addEventListener('click', function () {
      out.textContent = '';
      var sem = semDeltaLib();
      var parser;
      try {
        parser = kernel && lib.wasmParser ? lib.wasmParser(kernel.exports) : undefined;
      } catch (e) { parser = undefined; }
      var opts = parser ? { parser: parser } : undefined;

      // Sealed when there is a session to seal to. Without one the inventory
      // stays what it has always been — delta.js's span inventory, in the
      // clear — because a semantic inventory is strictly more revealing and
      // publishing it unsealed would be a downgrade dressed as a feature.
      if (sem && pairing.session) {
        sem.sealInventory(sem.semanticInventory(bytes, opts), pairing.session,
          { context: INVENTORY_CONTEXT })
          .then(function (sealed) {
            var chunks = qrChunksFor(lib, sealed);
            out.textContent = '';
            out.appendChild(el('p', 'small muted',
              sealed.length + ' characters of sealed inventory' +
              (chunks.length > 1 ? ' across ' + chunks.length + ' codes — scan them all' : '') +
              '. The contents are hidden; the size is not.'));
            appendQrCodes(out, chunks);
          }, function (e) {
            out.textContent = '';
            out.appendChild(el('div', 'notice bad', 'Could not seal the inventory: ' + e.message));
          });
        return;
      }

      try {
        var inv = lib.inventory(bytes, opts);
        var text = lib.encodeInventory(inv);
        var spanChunks = qrChunksFor(lib, text);
        out.appendChild(el('p', 'small muted',
          text.length + ' bytes of inventory' +
          (spanChunks.length > 1 ? ' across ' + spanChunks.length + ' codes — scan them all' : '') +
          '. Unpaired, so this travels in the clear and lists segments rather than records.'));
        appendQrCodes(out, spanChunks);
      } catch (e) {
        out.appendChild(el('div', 'notice bad', 'Could not build an inventory: ' + e.message));
      }
    });
  }

  /** The responder's half of the handshake, inside the artifact's own panel. */
  function buildAcceptPairingControls(panel, out) {
    if (!cryptoLib() || !semDeltaLib()) return;
    panel.appendChild(el('p', 'small muted',
      'Pair first and your inventory is encrypted to that session — and detailed ' +
      'enough for them to send individual records rather than whole segments.'));

    var area = document.createElement('textarea');
    area.placeholder = 'Paste their pairing code';
    area.style.marginTop = '.5rem';
    panel.appendChild(area);

    var row = el('div', 'row');
    row.style.marginTop = '.5rem';
    var pick = el('button', 'btn-sm', 'Scan their pairing code from a picture');
    var accept = el('button', 'btn-sm', 'Accept pairing');
    row.appendChild(pick);
    row.appendChild(accept);
    panel.appendChild(row);

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    panel.appendChild(file);

    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function (e) {
      var files = e.target.files;
      e.target.value = '';
      if (!files || !files.length || !qrdec) return;
      decodeImageToText(files[0]).then(function (texts) {
        if (!texts.length) { toast('No code found in that picture'); return; }
        area.value = texts[0];
        acceptPairing(area.value, out);
      });
    });
    accept.addEventListener('click', function () { acceptPairing(area.value.trim(), out); });
  }

  function acceptPairing(inviteText, out) {
    var lib = cryptoLib();
    out.textContent = '';
    if (!lib) {
      out.appendChild(el('div', 'notice bad', 'The crypto module did not load.'));
      return;
    }
    if (!inviteText) {
      out.appendChild(el('div', 'notice', 'Paste or scan their pairing code first.'));
      return;
    }
    Promise.resolve(lib.sessionAccept(inviteText, {})).then(function (r) {
      out.textContent = '';
      if (!r.ok) {
        out.appendChild(el('div', 'notice bad', 'Pairing failed: ' + r.reason + '.'));
        return;
      }
      pairing.role = 'responder';
      pairing.state = null;
      pairing.session = r.session;
      out.appendChild(el('div', 'notice good', pairingNote(r.session)));
      out.appendChild(el('p', 'small muted', 'Show this reply to their device to finish pairing.'));
      appendQrCodes(out, [r.bootstrap]);
    }, function (e) {
      out.textContent = '';
      out.appendChild(el('div', 'notice bad', 'Pairing failed: ' + e.message));
    });
  }

  // --- The sender's half -----------------------------------------------------

  /**
   * Turns whatever was scanned into a receiver inventory.
   *
   * Plaintext inventories of either shape are readable without a session, and
   * both still work. Anything else is treated as sealed, which is the only
   * remaining possibility: a sealed record carries a counter and a tag, not a
   * magic, so it is identified by neither plaintext magic matching rather than
   * by a marker an attacker could set.
   */
  function openReceiverInventory(lib, sem, text) {
    if (sem) {
      try {
        return Promise.resolve({ inventory: sem.decodeSemanticInventory(text), sealed: false });
      } catch (e) { /* not a plaintext semantic inventory */ }
    }
    try {
      return Promise.resolve({ inventory: lib.decodeInventory(text), sealed: false });
    } catch (e) { /* not a plaintext span inventory either */ }
    if (!sem) {
      return Promise.reject(new Error(
        'that is not an inventory, and the semantic-delta module did not load to try opening it as a sealed one'));
    }
    if (!pairing.session) {
      return Promise.reject(new Error(
        'that looks like a sealed inventory. Pair with their device first — a sealed ' +
        'inventory only opens with the session it was sealed to'));
    }
    return sem.openInventory(text, pairing.session, { context: INVENTORY_CONTEXT })
      .then(function (inv) { return { inventory: inv, sealed: true }; });
  }

  function runDeltaDiff() {
    var lib = deltaLib();
    var box = $('deltaResult');
    box.textContent = '';
    if (!lib) {
      box.appendChild(el('div', 'notice bad', 'The delta module did not load.'));
      return;
    }
    if (!send.record) {
      box.appendChild(el('div', 'notice', 'Choose the artifact you want to send first.'));
      return;
    }
    var raw = $('deltaInventory').value.trim();
    if (!raw) {
      box.appendChild(el('div', 'notice', 'Paste or scan their inventory first.'));
      return;
    }
    var text;
    try {
      text = reassembleInventory(lib, raw);
    } catch (e) {
      box.appendChild(el('div', 'notice bad', 'Those codes do not assemble: ' + e.message));
      return;
    }
    openReceiverInventory(lib, semDeltaLib(), text).then(function (r) {
      renderDeltaChoice(box, r.inventory, r.sealed);
    }, function (e) {
      box.textContent = '';
      box.appendChild(el('div', 'notice bad',
        'That does not look like an inventory: ' + (e && e.message ? e.message : e)));
    });
  }

  /**
   * Renders the choice, both figures, and why.
   *
   * The payload rendered here is the payload sent: chooseDelta() already built
   * both, so the button ships the very bytes that were measured rather than
   * rebuilding from the losing plan and quoting a number from the winning one.
   */
  function renderDeltaChoice(box, receiverInv, sealed) {
    var sem = semDeltaLib();
    var view = deltaChoiceView();
    box.textContent = '';
    if (!sem || !view) {
      renderSpanOnlyDiff(box, receiverInv);
      return;
    }
    var chosen, model;
    try {
      chosen = sem.chooseDelta(recordBytes(send.record), receiverInv);
      model = view.model(chosen, { formatBytes: core.formatBytes });
    } catch (e) {
      box.appendChild(el('div', 'notice bad', 'Could not compare the two deltas: ' + e.message));
      return;
    }
    if (!model) {
      box.appendChild(el('div', 'notice bad', 'The delta comparison returned no choice.'));
      return;
    }

    var n = el('div', model.tone ? 'notice ' + model.tone : 'notice');
    n.appendChild(el('strong', '', model.headline + ' '));
    n.appendChild(document.createTextNode(model.summary));
    if (model.note) {
      n.appendChild(el('span', 'small', ' ' + model.note));
    }
    box.appendChild(n);

    var dl = el('dl', 'kv');
    dl.style.marginTop = '.7rem';
    model.rows.forEach(function (row) {
      dl.appendChild(el('dt', '', row.label));
      dl.appendChild(el('dd', row.chosen ? '' : 'muted', row.text));
    });
    box.appendChild(dl);

    box.appendChild(el('p', 'small muted', model.reason));
    box.appendChild(el('p', 'small muted', sealed
      ? 'Their inventory arrived sealed and opened under this session.'
      : 'Their inventory arrived in the clear. Pair first to keep it from anyone watching.'));

    var go = el('button', 'btn-primary', 'Send the ' + model.label.toLowerCase());
    go.style.marginTop = '.6rem';
    go.addEventListener('click', function () {
      startSend(null, chosen.payload, send.record.name + '.delta');
      toast('Sending a ' + core.formatBytes(chosen.bytes) + ' ' + model.label.toLowerCase());
    });
    box.appendChild(go);
  }

  /** delta.js alone, for the build where semdelta.js did not load. */
  function renderSpanOnlyDiff(box, receiverInv) {
    var lib = deltaLib();
    try {
      var mine = lib.inventory(recordBytes(send.record));
      var d = lib.diff(mine, receiverInv);
      var saved = d.bytesSaved || 0;
      var ratio = d.ratio || (d.bytesToSend ? send.record.size / d.bytesToSend : 0);

      var n = el('div', 'notice good');
      n.appendChild(el('strong', '',
        core.formatBytes(d.bytesToSend) + ' instead of ' + core.formatBytes(send.record.size) + '. '));
      n.appendChild(document.createTextNode(
        (d.missing ? d.missing.length : 0) + ' segments to send, ' +
        core.formatBytes(saved) + ' saved' +
        (ratio ? ' — ' + ratio.toFixed(1) + '× less data' : '') + '.'
      ));
      box.appendChild(n);
      box.appendChild(el('p', 'small muted',
        'The semantic-delta module did not load, so only whole segments could be compared.'));

      var go = el('button', 'btn-primary', 'Send just those segments');
      go.style.marginTop = '.6rem';
      go.addEventListener('click', function () {
        try {
          var payload = lib.buildDeltaPayload(recordBytes(send.record), d.missing, { base: receiverInv });
          startSend(null, payload, send.record.name + '.delta');
          toast('Sending a ' + core.formatBytes(payload.length) + ' delta');
        } catch (e) {
          toast('Could not build the delta: ' + e.message);
        }
      });
      box.appendChild(go);
    } catch (e) {
      box.appendChild(el('div', 'notice bad', 'That does not look like an inventory: ' + e.message));
    }
  }

  // Compile-only: WebAssembly.compile validates and reads the module's shape.
  // It never runs code — instantiation is what would run a start function.
  function inspectWasm(bytes) {
    if (!window.WebAssembly || !WebAssembly.compile) {
      return Promise.reject(new Error('WebAssembly unavailable'));
    }
    return WebAssembly.compile(bytes.slice().buffer).then(function (mod) {
      return {
        exports: WebAssembly.Module.exports(mod),
        imports: WebAssembly.Module.imports(mod)
      };
    });
  }

  /**
   * The export path, and therefore the other enforcement point for disposal.
   *
   * Burn-on-export is consumed here rather than at the button, so a future
   * caller cannot export a burn-armed artifact without triggering it. Note the
   * honest limit of "successful": the browser owns the download once the click
   * is dispatched and never tells us how it ended, so the copy is destroyed at
   * the moment the bytes are handed over, not at the moment they hit disk.
   */
  function download(row) {
    var blob = new Blob([recordBytes(row)], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = row.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

    if (!expiryLib || !expiryLib.consumesOnExport(row.expiry)) return Promise.resolve(false);
    return vaultDelete(row.id).then(function () {
      hideSheet();
      toast('Exported — this device’s copy destroyed');
      renderVault();
      return true;
    }, function (err) {
      toast('Exported, but the copy could not be deleted: ' + err.message);
      return false;
    });
  }

  // ---------------------------------------------------------------------------
  // Import paths
  // ---------------------------------------------------------------------------

  function importFiles(files) {
    var queue = Array.prototype.slice.call(files);
    if (!queue.length) return;
    var done = 0;
    queue.reduce(function (chain, file) {
      return chain.then(function () {
        return file.arrayBuffer().then(function (buf) {
          return storeArtifact(file.name, new Uint8Array(buf), 'import');
        }).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      toast(done === 1 ? 'Imported 1 artifact' : 'Imported ' + done + ' artifacts');
      renderVault();
    }).catch(function (err) {
      toast('Import failed: ' + err.message);
    });
  }

  function loadDemo(file) {
    return fetch('./demo/' + file)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        return storeArtifact(file, new Uint8Array(buf), 'demo');
      })
      .then(function (record) {
        toast('Loaded ' + file);
        return renderVault().then(function () { return record; });
      })
      .catch(function (err) {
        toast('Could not load demo: ' + err.message);
        var list = $('vaultList');
        var n = el('div', 'card');
        n.appendChild(el('div', 'notice',
          'Loading the bundled demo needs the page to be served over http (GitHub Pages or any local server). ' +
          'Opened straight from disk, browsers block reading the neighbouring file. Import any file instead.'));
        list.insertBefore(n, list.firstChild);
      });
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  var send = {
    record: null,
    frames: [],
    index: 0,
    playing: false,
    timer: null,
    fps: 5,
    chunk: core.DEFAULT_CHUNK,
    ecl: 'L',
    mode: core.MODE_INDEXED,
    // v1 until the sender says otherwise. A v2 sender meeting a v1 receiver is
    // a dead transfer, so it is never what someone gets by not choosing.
    format: core.DEFAULT_FORMAT,
    stream: null,   // the erasure-coded symbol source, when in that mode
    esi: 0,         // next encoding symbol id to emit
    // The format the frames currently in hand were actually built in, which is
    // what drawFrame needs. Distinct from `format`, the choice: a v2 choice
    // with proto2.js missing produces v1 frames.
    wire: core.DEFAULT_FORMAT,
    sign: false,
    identity: null
  };

  /**
   * The format this send will actually use, as opposed to the one chosen.
   *
   * proto2.js is deferred and optional, exactly like the fountain and crypto
   * modules, so a v2 choice degrades to v1 rather than failing — and the note
   * under the picker says so, so the degradation is never silent.
   */
  function sendFormat() {
    return send.format === core.FORMAT_V2 && proto2Lib()
      ? core.FORMAT_V2
      : core.FORMAT_V1;
  }

  function refreshSendPicker() {
    var pick = $('sendPick');
    var current = pick.value;
    pick.textContent = '';
    if (!cachedVault.length) {
      var opt = el('option', '', 'No artifacts in the vault yet');
      opt.value = '';
      pick.appendChild(opt);
      $('sendStageCard').hidden = true;
      stopSend();
      return;
    }
    var placeholder = el('option', '', 'Choose an artifact…');
    placeholder.value = '';
    pick.appendChild(placeholder);
    cachedVault.forEach(function (row) {
      var o = el('option', '', row.name + ' · ' + core.formatBytes(row.size));
      o.value = row.id;
      pick.appendChild(o);
    });
    if (current) pick.value = current;
  }

  function stopSend() {
    send.playing = false;
    clearInterval(send.timer);
    send.timer = null;
  }

  function startSend(id, overrideBytes, overrideName) {
    stopSend();
    // The delta path sends bytes that are in no vault record, and calls this
    // with a null id. IDBObjectStore.get(null) throws DataError synchronously
    // inside the transaction, so the lookup is skipped rather than attempted
    // and caught: there is nothing to look up.
    var lookup = id ? vaultGet(id) : Promise.resolve(null);
    return lookup.then(function (row) {
      if (!row && !overrideBytes) return;
      send.record = row || null;
      var bytes = overrideBytes || recordBytes(row);
      var name = overrideName || (row ? row.name : 'artifact.bin');
      var hash = overrideBytes ? core.sha256Hex(bytes) : row.sha256;

      send.wire = sendFormat();
      if (send.wire === core.FORMAT_V2) {
        startSendV2(bytes, name, hash);
        return;
      }

      return signIfRequested({ name: name, size: bytes.length, sha256: hash })
        .then(function (signature) {
          if (send.mode === core.MODE_FOUNTAIN && fountainLib()) {
            var encoder = fountainLib().encoder(bytes, send.chunk);
            send.stream = core.buildFountainStream(encoder, {
              name: name, sha256: hash, size: bytes.length
            });
            if (signature) send.stream.manifest = withSignature(send.stream.manifest, signature);
            send.frames = null;
            send.esi = 0;
            send.index = 0;
            $('scrub').max = '0';
            $('sendStageCard').hidden = false;
            $('sendMeta').textContent =
              name + ' · ' + core.formatBytes(bytes.length) + ' · erasure-coded, K=' +
              encoder.K + ' · ' + encoder.symbolSize + ' B/symbol · transfer ' +
              send.stream.transferId + (signature ? ' · signed' : '');
            drawFrame(0);
            play(true);
            return;
          }

          send.stream = null;
          var built = core.buildFrames(bytes, { name: name, chunk: send.chunk, sha256: hash });
          if (signature) built.frames[0] = withSignature(built.frames[0], signature);
          send.frames = built.frames;
          send.index = 0;
          $('scrub').max = String(built.frames.length - 1);
          $('scrub').value = '0';
          $('sendStageCard').hidden = false;
          $('sendMeta').textContent =
            name + ' · ' + core.formatBytes(bytes.length) + ' · ' + built.chunk +
            ' B/frame · transfer ' + built.transferId + (signature ? ' · signed' : '');
          drawFrame(0);
          play(true);
        });
    });
  }

  /**
   * The v2 half of startSend.
   *
   * Kept separate rather than threaded through the v1 path with conditionals:
   * the two protocols are two state machines by design (proto2.js says so in
   * as many words), and the one place they meet is drawFrame, which has to know
   * whether it is holding a string or a byte array.
   *
   * Signing is not offered here. v2's manifest body is a fixed 47-byte record
   * plus the name, with no slot for a signature and a parser that rejects a
   * body of any other length — so a signed v2 transfer is not something the
   * frozen format can express. The checkbox is disabled and says why rather
   * than being quietly ignored.
   */
  function startSendV2(bytes, name, hash) {
    var P = proto2Lib();
    var digest = hexToBytes(hash);
    send.stream = null;
    send.frames = null;

    try {
      if (send.mode === core.MODE_FOUNTAIN && fountainLib()) {
        var encoder = fountainLib().encoder(bytes, P.clampChunk(send.chunk));
        send.stream = P.buildFountainStream(encoder, {
          name: name,
          contentHash: digest || core.sha256Bytes(bytes),
          originalSize: bytes.length,
          compressedSize: bytes.length
        });
        send.esi = 0;
        send.index = 0;
        $('scrub').max = '0';
        $('sendStageCard').hidden = false;
        $('sendMeta').textContent =
          name + ' · ' + core.formatBytes(bytes.length) + ' · v2 binary · erasure-coded, K=' +
          encoder.K + ' · ' + encoder.symbolSize + ' B/symbol · transfer ' +
          send.stream.transferIdHex;
        drawFrame(0);
        play(true);
        return;
      }

      var built = P.buildFrames(bytes, {
        name: name,
        chunk: send.chunk,
        contentHash: digest || undefined
      });
      send.frames = built.frames;
      send.index = 0;
      $('scrub').max = String(built.frames.length - 1);
      $('scrub').value = '0';
      $('sendStageCard').hidden = false;
      $('sendMeta').textContent =
        name + ' · ' + core.formatBytes(bytes.length) + ' · v2 binary · ' + built.chunk +
        ' B/frame · transfer ' + built.transferIdHex;
      drawFrame(0);
      play(true);
    } catch (e) {
      toast('Could not build v2 frames: ' + e.message);
      stopSend();
      $('sendStageCard').hidden = true;
    }
  }

  function withSignature(manifestFrame, signature) {
    var obj = JSON.parse(manifestFrame);
    obj.m.sig = signature.sig;
    obj.m.pub = signature.pub;
    return JSON.stringify(obj);
  }

  function drawFrame(i) {
    var text;
    if (send.stream) {
      // An erasure-coded stream has no end: frame 0 is the manifest and every
      // subsequent tick emits the next encoding symbol, for ever. The receiver
      // stops when it has enough, which the sender never learns.
      send.index = Math.max(0, i);
      if (send.index === 0) {
        text = send.stream.manifest;
      } else {
        text = send.stream.symbolFrame(send.esi++);
      }
    } else {
      if (!send.frames || !send.frames.length) return;
      send.index = ((i % send.frames.length) + send.frames.length) % send.frames.length;
      text = send.frames[send.index];
    }
    // A v1 frame is already the string that goes on the wire. A v2 frame is a
    // byte array, and the two QR decoders this app can reach — the browser's
    // BarcodeDetector and the bundled one — both hand back a string and nothing
    // else, so the bytes are ASCII-armoured here. That costs 8/7 rather than
    // v1's base64url 4/3; proto2.js explains why nothing denser survives the
    // round trip.
    if (send.wire === core.FORMAT_V2 && typeof text !== 'string') {
      text = proto2Lib().toTransport(text);
    }
    var qr;
    try {
      qr = qrlib.encodeText(text, { ecl: send.ecl });
    } catch (e) {
      toast('Frame too large for one QR symbol — lower the chunk size');
      stopSend();
      return;
    }
    qrlib.drawOnCanvas(qr, $('qrCanvas'), { size: 640, quietZone: 4 });

    var circumference = 2 * Math.PI * 33;
    if (send.stream) {
      var emitted = send.esi;
      var k = send.stream.K;
      $('sendFrameLabel').textContent =
        'symbol ' + emitted + '  ·  K = ' + k + '  ·  QR version ' + qr.version;
      // The ring shows progress towards K, then simply keeps going: past K
      // every extra symbol is insurance, not progress.
      var frac = Math.min(1, emitted / k);
      $('ringFill').setAttribute('stroke-dasharray',
        (circumference * frac).toFixed(1) + ' ' + circumference.toFixed(1));
      $('ringText').textContent = emitted <= k ? Math.round(frac * 100) + '%' : '+' + (emitted - k);
      return;
    }
    var total = send.frames.length;
    var shown = send.index + 1;
    $('sendFrameLabel').textContent =
      'frame ' + shown + ' / ' + total + '  ·  QR version ' + qr.version;
    var pct = Math.round((shown / total) * 100);
    $('ringFill').setAttribute(
      'stroke-dasharray',
      (circumference * shown / total).toFixed(1) + ' ' + circumference.toFixed(1)
    );
    $('ringText').textContent = pct + '%';
    $('scrub').value = String(send.index);
  }

  function play(on) {
    stopSend();
    send.playing = on;
    $('playBtn').textContent = on ? 'Pause' : 'Play';
    if (!on) return;
    send.timer = setInterval(function () {
      drawFrame(send.index + 1);
    }, Math.round(1000 / send.fps));
  }

  // ---------------------------------------------------------------------------
  // Receive
  // ---------------------------------------------------------------------------

  var rx = {
    gate: core.createFrameGate(),
    verification: null,
    pin: null,
    resume: null,
    state: core.createReceiver(),
    // The v2 receiver is a second, independent state machine, created lazily
    // because proto2.js is deferred. Two states rather than one union: sharing
    // a state would mean one protocol's bug is both protocols' bug, which is
    // the reason proto2.js keeps its own in the first place.
    v2: null,
    // Which of the two is holding the transfer in progress. Null means nothing
    // has been adopted yet and either format may start one.
    format: null,
    formatNote: null,
    stream: null,
    detector: null,
    running: false,
    lastText: null,
    finalizing: false
  };

  /** The v2 receiver, made on first use. Null when proto2.js never loaded. */
  function v2Receiver() {
    var P = proto2Lib();
    if (!P) return null;
    if (!rx.v2) rx.v2 = P.createReceiver();
    return rx.v2;
  }

  /**
   * One shape over two receivers, so the progress bar, the meta line and the
   * frame grid are written once instead of twice.
   *
   * The two states already agree on the fields that matter — total, received,
   * duplicates, rejected, and a chunks map keyed by frame index — because
   * proto2.js deliberately mirrored core's receiver. What differs is the
   * manifest: v1 spells it {name,size,chunk,k,symbolSize}, v2 spells the same
   * facts {name,originalSize,chunkSize,k}. This is the one place that knows.
   */
  function receiveView() {
    if (rx.format === core.FORMAT_V2) {
      var s = rx.v2;
      if (!s) return null;
      var m = s.manifest;
      var P = proto2Lib();
      return {
        format: core.FORMAT_V2,
        status: s.status,
        fountain: s.mode === P.MODE_FOUNTAIN,
        total: s.total,
        received: s.received,
        symbols: s.received,
        needed: m ? m.k : s.total,
        duplicates: s.duplicates,
        rejected: s.rejected,
        chunks: s.chunks,
        manifest: m,
        name: m ? m.name : null,
        size: m ? m.originalSize : 0
      };
    }
    var v1 = rx.state;
    var vm = v1.manifest;
    return {
      format: core.FORMAT_V1,
      status: v1.status,
      fountain: v1.mode === core.MODE_FOUNTAIN,
      total: v1.total,
      received: v1.received,
      symbols: v1.symbols,
      needed: v1.needed || (vm ? vm.k : 0),
      duplicates: v1.duplicates,
      rejected: v1.rejected,
      chunks: v1.chunks,
      manifest: vm,
      name: vm ? vm.name : null,
      size: vm ? vm.size : 0
    };
  }

  /**
   * Whether a frame in `arriving` may take over from the transfer in progress.
   *
   * Mirrors core.shouldAdoptNewTransfer's reasoning rather than its clock: a
   * finished or empty receiver has nothing to protect, so the other format is
   * simply a new transfer. A receiver mid-collection does, so the frame is
   * refused and named. Deliberately stricter than the v1-to-v1 rule — there is
   * no partial state to salvage across a format change, so there is no reason
   * to let a stray frame of the other format cost someone their progress.
   */
  function mayAdoptFormat(arriving) {
    if (!rx.format || rx.format === arriving) return true;
    var view = receiveView();
    if (!view) return true;
    if (view.status === 'IDLE' || view.status === 'VERIFIED' || view.status === 'REJECTED') {
      return true;
    }
    return !view.manifest && !view.received;
  }

  // Two decoding engines. The native one is faster and better tested, so it
  // wins when present; the bundled decoder means "no BarcodeDetector" is no
  // longer the same as "cannot scan".
  function nativeScannerAvailable() {
    return typeof window.BarcodeDetector !== 'undefined';
  }
  function scannerKind() {
    if (nativeScannerAvailable()) return 'native';
    return qrdec ? 'fallback' : 'none';
  }
  function isFramed() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true; // cross-origin frame: even asking throws
    }
  }
  // A cross-origin frame must be granted camera access explicitly by its host
  // page. Without allow="camera" the request is refused no matter what the
  // user does, so it is worth saying that plainly instead of blaming them.
  function cameraBlockedByFrame() {
    if (!isFramed()) return false;
    try {
      if (document.featurePolicy && document.featurePolicy.allowsFeature) {
        return !document.featurePolicy.allowsFeature('camera');
      }
    } catch (e) { /* fall through */ }
    return true;
  }

  function renderCapabilityNotice() {
    var box = $('capabilityNotice');
    box.textContent = '';
    var kind = scannerKind();

    if (cameraBlockedByFrame()) {
      var f = el('div', 'notice');
      f.appendChild(el('strong', '', 'This page is embedded in a frame that does not grant camera access. '));
      f.appendChild(document.createTextNode(
        'That is a decision made by the surrounding page, not by rvQR or by you, ' +
        'and no permission prompt can override it. Open rvQR directly to scan — '
      ));
      var link = el('a', '', 'open in its own tab');
      link.href = window.location.href;
      link.target = '_blank';
      link.rel = 'noopener';
      f.appendChild(link);
      f.appendChild(document.createTextNode(
        ' — or use the picture and paste options below, which work anywhere.'
      ));
      box.appendChild(f);
    }

    if (kind === 'none') {
      var n = el('div', 'notice bad');
      n.appendChild(el('strong', '', 'No decoder available. '));
      n.appendChild(document.createTextNode('The bundled decoder failed to load.'));
      box.appendChild(n);
      $('scanBtn').disabled = true;
    }

    $('scannerNote').textContent = kind === 'native'
      ? 'Scanning with this browser\u2019s native barcode reader.'
      : kind === 'fallback'
        ? 'This browser has no native barcode reader, so rvQR is using its own decoder. ' +
          'It reads the smaller symbols comfortably; on the densest frames, hold steady ' +
          'or ask the sender to drop the chunk size to 256 bytes.'
        : '';
  }

  function resetReceiver() {
    rx.state = core.createReceiver();
    rx.v2 = null;
    rx.format = null;
    rx.formatNote = null;
    rx.gate = core.createFrameGate();
    rx.verification = null;
    rx.sinceSave = 0;
    rx.finalizing = false;
    rx.lastText = null;
    $('rxCard').hidden = true;
    $('rxResult').textContent = '';
    $('rxGrid').textContent = '';
    $('rxBar').style.width = '0%';
    $('rxTitle').textContent = 'Waiting for frames…';
    $('rxMeta').textContent = '—';
  }

  function startCamera() {
    if (rx.running) { stopCamera(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera unavailable in this context');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (stream) {
      rx.stream = stream;
      var v = $('video');
      v.srcObject = stream;
      $('scanCard').hidden = false;
      $('rxCard').hidden = false;
      $('scanBtn').textContent = 'Stop camera';
      rx.running = true;
      rx.detector = nativeScannerAvailable()
        ? new window.BarcodeDetector({ formats: ['qr_code'] })
        : null;
      return v.play().catch(function () { /* autoplay policies */ });
    }).then(function () {
      scanLoop();
    }).catch(function (err) {
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' && isFramed()) {
        toast('The surrounding page blocks camera access — use a picture instead');
      } else if (name === 'NotAllowedError') {
        toast('Camera permission denied');
      } else if (name === 'NotFoundError') {
        toast('No camera on this device — use a picture instead');
      } else {
        toast('Camera error: ' + (err && err.message ? err.message : name));
      }
      renderCapabilityNotice();
    });
  }

  function stopCamera() {
    rx.running = false;
    if (rx.stream) {
      rx.stream.getTracks().forEach(function (t) { t.stop(); });
      rx.stream = null;
    }
    $('scanCard').hidden = true;
    $('scanBtn').textContent = 'Start camera';
  }

  var grabCanvas = null;

  /** Pulls the current video frame out as ImageData for the bundled decoder. */
  function grabFrame(video) {
    if (!grabCanvas) grabCanvas = document.createElement('canvas');
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    // Downscale very large frames: the decoder does not need 4K, and the
    // scan loop has to keep up with the camera.
    var maxSide = 1024;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    grabCanvas.width = Math.round(w * scale);
    grabCanvas.height = Math.round(h * scale);
    var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, grabCanvas.width, grabCanvas.height);
    return ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
  }

  function scanLoop() {
    if (!rx.running) return;
    var v = $('video');
    if (v.readyState < 2) {
      requestAnimationFrame(scanLoop);
      return;
    }
    if (rx.detector) {
      rx.detector.detect(v).then(function (codes) {
        for (var i = 0; i < codes.length; i++) feedFrame(codes[i].rawValue);
      }).catch(function () { /* transient detector errors are normal */ })
        .then(function () { requestAnimationFrame(scanLoop); });
      return;
    }
    // Fallback decoder: synchronous and heavier, so yield between frames
    // rather than pinning the main thread — and skip frames that cannot pay
    // for themselves. The gate is applied only on this path: the native
    // detector is cheap and handles motion better than a gate would, so
    // throttling it would cost frames for no saving.
    try {
      var image = grabFrame(v);
      if (image) {
        var decision = core.gateFrame(rx.gate, core.frameSignature(image));
        if (decision.decode) {
          var results = qrdec.decodeImage(image, { all: true, invert: false });
          for (var r = 0; r < results.length; r++) feedFrame(results[r].text);
        }
        rx.gateStats = rx.gate;
      }
    } catch (e) { /* keep scanning */ }
    setTimeout(function () { requestAnimationFrame(scanLoop); }, 60);
  }

  // ---------------------------------------------------------------------------
  // Decoding frames out of a still picture
  // ---------------------------------------------------------------------------

  /** Decodes every QR in one image file and resolves with their texts. */
  function decodeImageToText(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var texts = [];
        try {
          if (!grabCanvas) grabCanvas = document.createElement('canvas');
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          grabCanvas.width = Math.round(img.width * scale);
          grabCanvas.height = Math.round(img.height * scale);
          var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, grabCanvas.width, grabCanvas.height);
          var data = ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
          texts = qrdec.decodeImage(data, { all: true }).map(function (r) { return r.text; });
        } catch (e) { /* resolve with what we have */ }
        URL.revokeObjectURL(url);
        resolve(texts);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve([]); };
      img.src = url;
    });
  }

  function renderFormatNote() {
    var note = $('formatNote');
    if (send.format !== core.FORMAT_V2) {
      note.textContent = 'JSON frames. Every rvQR build reads them, including ones ' +
        'older than the binary format.';
      return;
    }
    note.textContent = proto2Lib()
      ? 'More payload per symbol — but the receiver has to speak v2, and one that ' +
        'does not will say so rather than read it wrong.'
      : 'The binary-format module has not loaded, so this send will use v1 JSON frames.';
  }

  function renderModeNote() {
    var note = $('modeNote');
    if (send.mode === core.MODE_FOUNTAIN) {
      note.textContent = fountainLib()
        ? 'The sender emits encoding symbols for ever; the receiver stops as soon as any K of them have landed, whichever ones those were. A dropped frame costs one extra symbol instead of a whole loop.'
        : 'The erasure-coding module has not loaded, so this send will use indexed frames.';
    } else {
      note.textContent = 'Numbered chunks, looped until the receiver has them all. A missed frame waits for the next pass.';
    }
  }

  function renderSignNote() {
    var note = $('signNote');
    // v2's manifest is a fixed-length binary record with no signature field,
    // and its parser rejects a body of any other length, so there is nowhere
    // for a signature to go. Said plainly here rather than left to be
    // discovered when the receiver reports an unsigned transfer.
    if (sendFormat() === core.FORMAT_V2) {
      $('signSend').disabled = true;
      note.textContent = 'Binary v2 frames carry no signature field, so this transfer ' +
        'cannot be signed. Switch back to v1 frames to sign.';
      return;
    }
    $('signSend').disabled = !cryptoLib();
    if (!send.sign) {
      note.textContent = 'Unsigned. The receiver can verify the bytes arrived intact, but not who sent them.';
      return;
    }
    if (!cryptoLib()) {
      note.textContent = 'The crypto module has not loaded, so this transfer cannot be signed.';
      return;
    }
    ensureIdentity().then(function (identity) {
      note.textContent = identity
        ? 'Signing with this device\u2019s key. Read the fingerprint to the other person out loud so they can pin it: ' + identity.fingerprint
        : 'A signing key could not be created on this device.';
    });
  }

  function decodeImageFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var box = $('imageResult');
    box.textContent = '';
    box.appendChild(el('div', 'notice', 'Reading ' + list.length + ' image' +
      (list.length === 1 ? '' : 's') + '\u2026'));

    var totalFound = 0, totalAccepted = 0, processed = 0;
    list.forEach(function (file) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          if (!grabCanvas) grabCanvas = document.createElement('canvas');
          // Big photos get scaled down, but not so far that modules vanish.
          var maxSide = 1600;
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          grabCanvas.width = Math.round(img.width * scale);
          grabCanvas.height = Math.round(img.height * scale);
          var ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, grabCanvas.width, grabCanvas.height);
          var data = ctx.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
          var results = qrdec.decodeImage(data, { all: true });
          totalFound += results.length;
          for (var i = 0; i < results.length; i++) {
            rx.lastText = null; // a still image may legitimately repeat a frame
            // Counted through the view rather than rx.state, so a picture full
            // of v2 frames reports what it actually accepted.
            var before = receivedCount();
            feedFrame(results[i].text);
            if (receivedCount() > before) totalAccepted++;
          }
        } catch (e) { /* report below */ }
        URL.revokeObjectURL(url);
        if (++processed === list.length) reportImageDecode(totalFound, totalAccepted);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        if (++processed === list.length) reportImageDecode(totalFound, totalAccepted);
      };
      img.src = url;
    });
  }

  function reportImageDecode(found, accepted) {
    var box = $('imageResult');
    box.textContent = '';
    if (!found) {
      box.appendChild(el('div', 'notice bad',
        'No QR codes found. Fill more of the picture with the code, keep it in ' +
        'focus, and avoid glare across the screen.'));
      return;
    }
    box.appendChild(el('div', 'notice good',
      'Read ' + found + ' code' + (found === 1 ? '' : 's') + ', ' + accepted +
      ' new frame' + (accepted === 1 ? '' : 's') + ' accepted.'));
    $('rxCard').hidden = false;
  }

  function feedFrame(text) {
    if (rx.finalizing) return;
    if (text === rx.lastText) return; // cheap guard against re-reading one frame
    rx.lastText = text;

    // Route on the format before either parser sees the frame. Both parsers
    // already refuse the other protocol by name rather than mis-decoding it —
    // that is what makes routing safe to get wrong — but naming the format up
    // here is what lets the receiver say which one arrived.
    var arriving = core.frameFormat(text, proto2Lib());
    if (arriving === core.FORMAT_V2 && !proto2Lib()) {
      rx.formatNote = 'A v2 binary frame arrived, but the module that reads them ' +
        'did not load. Nothing was decoded.';
      renderReceiveProgress();
      return;
    }
    if (!mayAdoptFormat(arriving)) {
      rx.formatNote = core.formatMismatchText(rx.format, arriving);
      bumpRejected();
      renderReceiveProgress();
      return;
    }
    rx.formatNote = null;
    if (arriving === core.FORMAT_V2) {
      feedFrameV2(text);
      return;
    }
    // An unrecognised string still goes to the v1 parser, which is where the
    // reason for refusing it comes from. Only a frame that is positively the
    // other format is diverted above.
    if (rx.format === core.FORMAT_V2 && arriving === 'unknown') {
      feedFrameV2(text);
      return;
    }
    rx.format = core.FORMAT_V1;
    var before = rx.state.status;
    var beforeManifest = rx.state.manifest;
    core.ingest(rx.state, text, Date.now());

    // The manifest is what says whether this is an erasure-coded transfer, so
    // the decoder is attached the moment one arrives — before any symbol can
    // need it, because symbols are replayed from state on attach below.
    if (!beforeManifest && rx.state.manifest && rx.state.mode === core.MODE_FOUNTAIN) {
      attachFountainDecoder();
    }
    if (rx.state.manifest && !rx.verification) verifyManifestSignature();
    recordFrameForResume();
    if (rx.state.status !== 'IDLE') $('rxCard').hidden = false;
    if (before === 'IDLE' && rx.state.status === 'COLLECTING') {
      toast('Transfer ' + rx.state.transferId + ' detected');
    }
    renderReceiveProgress();
    if (core.isComplete(rx.state)) finishReceive();
  }

  /** Data frames accepted so far, whichever receiver is holding the transfer. */
  function receivedCount() {
    var view = receiveView();
    return view ? view.received : 0;
  }

  /** A frame refused before either parser saw it still counts as refused. */
  function bumpRejected() {
    var s = rx.format === core.FORMAT_V2 ? rx.v2 : rx.state;
    if (s) s.rejected++;
  }

  /** The v2 half of feedFrame. Same order of operations, different module. */
  function feedFrameV2(text) {
    var P = proto2Lib();
    var s = v2Receiver();
    if (!s) return;
    rx.format = core.FORMAT_V2;
    var before = s.status;
    var beforeManifest = s.manifest;
    var out = P.ingest(s, text);

    // A frame the v2 parser refuses because it is v1 is named rather than
    // counted as damage. This is the case the routing above cannot catch: a
    // frame that identify() could not place, fed here because the transfer in
    // progress is v2, and then recognised by the parser itself.
    var named = core.rejectedFormat(out.reason);
    if (named) rx.formatNote = core.formatMismatchText(core.FORMAT_V2, named);

    if (!beforeManifest && s.manifest && s.mode === P.MODE_FOUNTAIN) {
      attachFountainDecoderV2();
    }
    // v2's manifest is a fixed-length binary record with no signature field,
    // so a v2 transfer is unsigned as a property of the format, not as an
    // omission by the sender. A pinned fingerprint therefore refuses it, which
    // is core.admitArtifact's existing behaviour for an unsigned transfer.
    if (s.manifest && !rx.verification) {
      rx.verification = { state: 'unsigned', note: 'binary v2 frames carry no signature' };
      renderVerification();
    }
    recordFrameForResume();
    if (s.status !== 'IDLE') $('rxCard').hidden = false;
    if (before === 'IDLE' && s.status === 'COLLECTING') {
      toast('Transfer ' + P.transferIdHex(s.transferId) + ' detected (v2)');
    }
    renderReceiveProgress();
    if (P.isComplete(s)) finishReceive();
  }

  /** attachFountainDecoder's v2 counterpart; same replay, different manifest. */
  function attachFountainDecoderV2() {
    var lib = fountainLib();
    var P = proto2Lib();
    var s = rx.v2;
    var m = s && s.manifest;
    if (!lib || !m || s.codec) return;
    try {
      var decoder = lib.decoder(m.k, m.chunkSize, m.k * m.chunkSize);
      P.useCodec(s, decoder);
      for (var key in s.chunks) {
        var esi = Number(key);
        var payload = s.chunks[key];
        if (payload) s.decodable = decoder.add({ esi: esi, bytes: payload }) === true;
      }
    } catch (e) {
      toast('Could not start the erasure decoder: ' + e.message);
    }
  }

  // Attaches the erasure decoder and replays any symbols that arrived before
  // the manifest did — frames can turn up in any order, including this one.
  function attachFountainDecoder() {
    var lib = fountainLib();
    var m = rx.state.manifest;
    if (!lib || !m || rx.state.codec) return;
    try {
      var decoder = lib.decoder(m.k, m.symbolSize, m.k * m.symbolSize);
      core.useCodec(rx.state, decoder);
      var seqs = core.receivedSequences(rx.state);
      for (var i = 0; i < seqs.length; i++) {
        var payload = rx.state.chunks[seqs[i]];
        if (payload) rx.state.decodable = decoder.add({ esi: seqs[i], bytes: payload }) === true;
      }
    } catch (e) {
      toast('Could not start the erasure decoder: ' + e.message);
    }
  }

  // --- signatures ------------------------------------------------------------

  function verifyManifestSignature() {
    var lib = cryptoLib();
    var m = rx.state.manifest;
    if (!m) return;
    if (!m.sig || !m.pub) {
      rx.verification = { state: 'unsigned' };
      renderVerification();
      return;
    }
    if (!lib) {
      rx.verification = { state: 'unsigned', note: 'signature present but the crypto module did not load' };
      renderVerification();
      return;
    }
    rx.verificationPromise = Promise.resolve()
      .then(function () {
        return lib.verifyManifest(
          { name: m.name, size: m.size, sha256: m.sha256 },
          m.sig, m.pub
        );
      })
      .then(function (ok) {
        var fp = lib.fingerprint(m.pub);
        if (!ok) {
          rx.verification = { state: 'bad', fingerprint: fp };
        } else if (rx.pin) {
          rx.verification = {
            state: lib.fingerprintEqual(fp, rx.pin) ? 'pinned' : 'wrong-key',
            fingerprint: fp
          };
        } else {
          rx.verification = { state: 'signed', fingerprint: fp };
        }
        renderVerification();
      })
      .catch(function () {
        rx.verification = { state: 'bad' };
        renderVerification();
      });
  }

  // Three outcomes, none of which may be mistaken for another. A signature
  // from an unpinned key proves only that one key signed it — not that it is
  // the key you wanted — so it must never read like a pass.
  var VERIFY_COPY = {
    unsigned: ['warn', 'Unsigned', 'The manifest carries no signature. The hash proves the bytes are intact; nothing proves who sent them.'],
    signed: ['warn', 'Signed, but by an unknown key', 'A signature checks out, but you have not pinned this fingerprint, so it only shows that some key signed the transfer. Compare the fingerprint out of band and pin it.'],
    pinned: ['pass', 'Signed by the key you pinned', 'The signature matches the fingerprint you pinned.'],
    'wrong-key': ['fail', 'Signed by a DIFFERENT key', 'A valid signature, but not from the fingerprint you pinned. Treat this transfer as hostile until you know why.'],
    bad: ['fail', 'Signature does not verify', 'The manifest claims a signature that does not check out against the key it names.']
  };

  function renderVerification() {
    var box = $('pinState');
    if (!box) return;
    var v = rx.verification;
    if (!v) { box.textContent = ''; return; }
    var copy = VERIFY_COPY[v.state] || VERIFY_COPY.unsigned;
    box.textContent = '';
    var row = el('div', 'check ' + copy[0]);
    var marks = { pass: '\u2713', warn: '!', fail: '\u2717' };
    row.appendChild(el('div', 'mark', marks[copy[0]] || '!'));
    var body = el('div', 'body');
    body.appendChild(el('strong', '', copy[1]));
    body.appendChild(el('span', '', copy[2] + (v.fingerprint ? ' Fingerprint: ' + v.fingerprint : '')));
    row.appendChild(body);
    box.appendChild(row);
  }

  function signIfRequested(manifestFields) {
    var lib = cryptoLib();
    if (!send.sign || !lib) return Promise.resolve(null);
    return ensureIdentity().then(function (identity) {
      if (!identity) return null;
      // signManifest takes (privateKey, manifest) — passing them the other way
      // round throws inside the canonicaliser, and the catch below turned that
      // into a silent "unsigned" for every transfer.
      return Promise.resolve(lib.signManifest(identity.secret, manifestFields))
        .then(function (sig) {
          return { sig: typeof sig === 'string' ? sig : lib.b64uEncode(sig), pub: identity.pubEncoded };
        });
    }).catch(function (err) {
      // Signing failing is a real fault, not a reason to quietly downgrade to
      // unsigned — say so where it can be seen, then continue unsigned so the
      // transfer still works.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('rvQR: manifest signing failed, sending unsigned:', err && err.message);
      }
      return null;
    });
  }

  // One key per browser, kept in local storage. This is a demonstration of the
  // mechanism, not a key management system: anything that can read the page's
  // storage can read this key.
  var IDENTITY_KEY = 'rvqr.identity.v1';
  function ensureIdentity() {
    var lib = cryptoLib();
    if (!lib) return Promise.resolve(null);
    if (send.identity) return Promise.resolve(send.identity);
    var store = safeStorage();
    var saved = null;
    try { saved = store && store.getItem(IDENTITY_KEY); } catch (e) { saved = null; }
    if (saved) {
      try {
        var parsed = JSON.parse(saved);
        send.identity = parsed;
        return Promise.resolve(parsed);
      } catch (e) { /* regenerate below */ }
    }
    return Promise.resolve(lib.generateKeyPair()).then(function (kp) {
      var secret = kp.secretKey || kp.secret || kp.privateKey;
      var pub = kp.publicKey || kp.pub;
      var identity = {
        secret: typeof secret === 'string' ? secret : lib.toHex(secret),
        pubEncoded: typeof pub === 'string' ? pub : lib.toHex(pub)
      };
      identity.fingerprint = lib.fingerprint(identity.pubEncoded);
      send.identity = identity;
      try { if (store) store.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* ephemeral */ }
      return identity;
    }).catch(function () { return null; });
  }

  // --- resume ----------------------------------------------------------------

  // Frames between writes. The module's author measured 1290us/frame writing
  // one at a time against 63us at 20, and saveProgress already tracks which
  // sequences are durable, so this only decides how often the transaction runs.
  var RESUME_BATCH = 20;

  function resumeStore() {
    var lib = resumeLib();
    if (!lib || !window.indexedDB) return Promise.resolve(null);
    if (rx.resume) return Promise.resolve(rx.resume);
    return Promise.resolve(lib.open({ factory: window.indexedDB }))
      .then(function (store) { rx.resume = store; return store; })
      .catch(function () { return null; });
  }

  /**
   * The key a transfer is stored under, with its format in front.
   *
   * The format has to survive the round trip through storage or a resumed
   * transfer cannot be handed to the right receiver, and resume.js persists a
   * fixed set of fields — so the key carries it. It is also what keeps a v1 and
   * a v2 transfer that happen to share a transfer id from colliding: the two
   * formats draw their ids from different spaces and neither knows the other.
   */
  function resumeId() {
    if (rx.format === core.FORMAT_V2) {
      var P = proto2Lib();
      var s = rx.v2;
      return s && s.transferId !== null ? 'v2:' + P.transferIdHex(s.transferId) : null;
    }
    return rx.state.transferId ? 'v1:' + rx.state.transferId : null;
  }

  /**
   * The receiver, in the shape resume.js persists: name, size, sha256 and
   * chunk, plus the chunk map it writes frame by frame.
   *
   * v2 spells three of those four differently (originalSize, chunkSize), so the
   * translation happens here rather than in the store — resume.js predates the
   * binary format and its restore() contract promises a core-shaped state.
   *
   * Erasure-coded transfers are not persisted, in either format. restore()
   * rebuilds an indexed receiver — no mode, no symbol count, no decoder — so a
   * fountain transfer that came back from it would resume into a receiver that
   * could never complete. Refusing to store it is the honest version of that.
   */
  function resumeStateView() {
    var v = receiveView();
    if (!v || !v.manifest || v.fountain) return null;
    var sha = v.manifest.sha256;
    if (typeof sha !== 'string' || sha.length !== 64) return null;
    return {
      hashPrefix: sha.slice(0, 8),
      total: v.total,
      received: v.received,
      chunks: v.chunks,
      manifest: {
        name: v.name,
        size: v.size,
        sha256: sha,
        chunk: v.format === core.FORMAT_V2 ? v.manifest.chunkSize : v.manifest.chunk
      }
    };
  }

  function recordFrameForResume() {
    if (!resumeLib()) return;
    var id = resumeId();
    var view = resumeStateView();
    if (!id || !view) return;
    var P = proto2Lib();
    var done = rx.format === core.FORMAT_V2
      ? !!(P && P.isComplete(rx.v2))
      : core.isComplete(rx.state);
    rx.sinceSave = (rx.sinceSave || 0) + 1;
    if (rx.sinceSave < RESUME_BATCH && !done) return;
    rx.sinceSave = 0;
    resumeStore().then(function (store) {
      if (!store || !store.saveProgress) return;
      // One transaction for everything that has arrived since the last call:
      // per-frame writes cost ~20x more, and a camera delivers frames far
      // faster than IndexedDB likes to commit. saveProgress tracks which
      // sequences are already durable, so re-passing the whole chunk map
      // writes only the new ones.
      return store.saveProgress(id, view);
    }).catch(function () { /* resume is a convenience, never a blocker */ });
  }

  function offerResume() {
    if (!resumeLib()) return;
    resumeStore().then(function (store) {
      if (!store || !store.listResumable) return null;
      return store.listResumable();
    }).then(function (list) {
      var box = $('resumeBanner');
      if (!box || !list || !list.length) return;
      box.textContent = '';
      var n = el('div', 'notice');
      n.appendChild(el('strong', '', list.length === 1
        ? '1 transfer in progress. '
        : list.length + ' transfers in progress. '));
      n.appendChild(document.createTextNode(
        'Frames you already scanned are still here — pick up where you left off.'
      ));
      box.appendChild(n);
      var row = el('div', 'row');
      row.style.marginTop = '.6rem';
      list.slice(0, 3).forEach(function (entry) {
        var v2 = typeof entry.id === 'string' && entry.id.slice(0, 3) === 'v2:';
        var label = (entry.name || 'transfer') + ' · ' +
          (entry.received || 0) + ' frames' + (v2 ? ' · v2' : '');
        var b = el('button', 'btn-sm', 'Continue ' + label);
        b.addEventListener('click', function () { resumeTransfer(entry); });
        row.appendChild(b);
      });
      box.appendChild(row);
    }).catch(function () { /* nothing to offer */ });
  }

  /**
   * Rebuilds a v2 receiver from what resume.js gives back.
   *
   * Everything a v2 receiver needs is either in the restored record or derivable
   * from it: the transfer id from the key, the header's 32-bit content hash from
   * the first four digest bytes, and both sizes from the one the manifest kept —
   * this app never sends a codec, so the two are equal by construction. Anything
   * that does not add up returns null and the transfer simply is not resumed.
   */
  function rebuildV2Receiver(id, restored) {
    var P = proto2Lib();
    var m = restored && restored.manifest;
    var digest = m && hexToBytes(m.sha256);
    if (!P || !digest || !m.name || !m.chunk || !restored.total) return null;
    var transferId = parseInt(id.slice(3), 16);
    if (!Number.isFinite(transferId)) return null;
    var s = P.createReceiver();
    s.status = 'COLLECTING';
    s.transferId = transferId >>> 0;
    s.contentHash32 =
      (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0;
    s.total = restored.total;
    s.mode = P.MODE_INDEXED;
    s.codecId = P.CODEC_NONE;
    s.dictId = P.DICT_NONE;
    s.chunks = restored.chunks;
    s.received = restored.received;
    s.manifest = {
      originalSize: m.size,
      compressedSize: m.size,
      contentHash: digest,
      sha256: m.sha256,
      chunkSize: m.chunk,
      k: 0,
      name: m.name
    };
    return s;
  }

  function resumeTransfer(entry) {
    var id = entry.id || entry.transferId;
    var format = typeof id === 'string' && id.slice(0, 3) === 'v2:'
      ? core.FORMAT_V2
      : core.FORMAT_V1;
    if (format === core.FORMAT_V2 && !proto2Lib()) {
      toast('That transfer is in the binary v2 format and the module that reads it did not load');
      return;
    }
    resumeStore().then(function (store) {
      if (!store || !store.restore) return;
      return store.restore(id);
    }).then(function (state) {
      if (!state) { toast('That transfer could not be restored'); return; }
      if (format === core.FORMAT_V2) {
        var v2 = rebuildV2Receiver(id, state);
        if (!v2) { toast('That v2 transfer could not be restored'); return; }
        rx.v2 = v2;
        rx.format = core.FORMAT_V2;
        rx.verification = { state: 'unsigned', note: 'binary v2 frames carry no signature' };
        renderVerification();
      } else {
        rx.state = state;
        rx.format = core.FORMAT_V1;
        if (state.mode === core.MODE_FOUNTAIN) attachFountainDecoder();
      }
      rx.formatNote = null;
      rx.sinceSave = 0;
      rx.finalizing = false;
      rx.lastText = null;
      $('rxCard').hidden = false;
      $('resumeBanner').textContent = '';
      renderReceiveProgress();
      toast('Resumed at ' + (state.received || 0) + ' frames');
      if (core.isComplete(rx.state)) finishReceive();
    }).catch(function (err) {
      toast('Could not resume: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  // A refused frame is worth a line of its own: the bar and the counters carry
  // on describing the transfer in progress, and this says why the last thing
  // scanned was not part of it.
  function renderRxFormatNote() {
    var box = $('rxFormatNote');
    if (!box) return;
    box.textContent = '';
    if (!rx.formatNote) return;
    box.appendChild(el('div', 'notice bad', rx.formatNote));
  }

  function renderReceiveProgress() {
    renderRxFormatNote();
    // One shape over both receivers. Everything below reads the view, so the
    // grid, the bar and the meta line are the same code for either format.
    var s = receiveView();
    if (!s || !s.total) return;
    var tag = s.format === core.FORMAT_V2 ? 'v2 binary · ' : '';
    if (s.fountain) {
      var k = s.needed || 0;
      var got = s.symbols;
      var fpct = k ? Math.min(100, Math.round((got / k) * 100)) : 0;
      $('rxBar').style.width = fpct + '%';
      $('rxTitle').textContent = (s.name ? core.sanitizeName(s.name) + ' — ' : '') +
        got + ' / ' + k + ' symbols';
      $('rxMeta').textContent = tag + 'erasure-coded · any ' + k + ' symbols rebuild it · ' +
        s.duplicates + ' duplicates · ' + s.rejected + ' rejected' +
        (s.manifest ? ' · ' + core.formatBytes(s.size) : '');
      $('rxGrid').textContent = '';
      return;
    }
    var need = s.total - 1;
    var have = s.received;
    var pct = need ? Math.round((have / need) * 100) : 100;
    $('rxBar').style.width = pct + '%';
    $('rxTitle').textContent = s.manifest
      ? core.sanitizeName(s.name) + ' — ' + pct + '%'
      : 'Collecting frames — ' + pct + '% (waiting for the manifest)';
    $('rxMeta').textContent = tag +
      have + ' / ' + need + ' data frames · ' + s.duplicates + ' duplicates · ' +
      s.rejected + ' rejected' +
      (s.manifest ? ' · ' + core.formatBytes(s.size) : '');

    // The cell count comes from gridPlan, never straight from s.total: the
    // frame count is attacker-controlled and must not be able to drive how
    // many DOM nodes this builds. Past the cap each cell stands for a run of
    // frames and lights up once that whole run has landed. v2 numbers its data
    // frames 1..total-1 exactly as v1 does, so the plan needs no notion of
    // which format it is drawing.
    var plan = core.gridPlan(s.total);
    var grid = $('rxGrid');
    if (grid.childElementCount !== plan.cells) {
      grid.textContent = '';
      for (var i = 0; i < plan.cells; i++) grid.appendChild(el('i'));
    }
    if (!plan.cells) return;

    var counts = new Uint32Array(plan.cells);
    for (var key in s.chunks) {
      var idx = core.cellForSequence(plan, Number(key));
      if (idx >= 0) counts[idx]++;
    }
    for (var c = 0; c < plan.cells; c++) {
      var first = c * plan.framesPerCell + 1;
      var span = Math.min(plan.framesPerCell, need - (first - 1));
      var full = span > 0 && counts[c] >= span;
      var cell = grid.children[c];
      if (full !== cell.classList.contains('have')) cell.classList.toggle('have', full);
    }
    if (plan.bucketed) {
      $('rxMeta').textContent += ' · grid shows ' + plan.framesPerCell + ' frames per cell';
    }
  }

  function finishReceive() {
    if (rx.finalizing) return;
    rx.finalizing = true;
    if (rx.format === core.FORMAT_V2) { finishReceiveV2(); return; }
    var s = rx.state;
    var bytes;
    try {
      bytes = core.assemble(s);
    } catch (e) {
      showReceiveResult(false, 'Reassembly failed: ' + e.message);
      return;
    }
    hashBytes(bytes).then(function (digest) {
      if (digest !== s.manifest.sha256) {
        s.status = 'REJECTED';
        showReceiveResult(false,
          'Hash mismatch — the whole transfer was discarded. Expected ' +
          s.manifest.sha256.slice(0, 16) + '…, got ' + digest.slice(0, 16) + '…');
        return;
      }
      return admitAndStore(s, bytes, s.manifest.name);
    }).catch(function (err) {
      showReceiveResult(false, 'Failed to store: ' + err.message);
    });
  }

  // Why a v2 transfer was refused, in the words of the thing that refused it.
  // proto2.finalize returns a reason rather than a sentence on purpose, so the
  // sentences live here with the rest of the copy.
  var V2_FINALIZE_COPY = {
    incomplete: 'The transfer is not complete yet.',
    'assembly-failed': 'The collected frames did not fit back together, so nothing was kept.',
    'compressed-size-mismatch': 'The reassembled stream is not the length the manifest declared. Discarded.',
    'no-codec': 'This transfer is compressed with a codec this build does not carry, so it was refused rather than handed over as-is.',
    'decode-failed': 'The compressed stream could not be decoded. Discarded.',
    'original-size-mismatch': 'The decoded artifact is not the size the manifest declared. Discarded.'
  };

  /**
   * The v2 half of finishReceive.
   *
   * proto2.finalize does the reassembly, the codec step and the SHA-256 check
   * in one call and hands back bytes only if the digest matches — so unlike the
   * v1 path there is no place here where unverified bytes exist under a name.
   * It hashes synchronously with core's SHA-256 rather than through WebCrypto,
   * which is what makes that single call possible.
   */
  function finishReceiveV2() {
    var P = proto2Lib();
    var s = rx.v2;
    var out = P.finalize(s, {});
    if (!out.ok) {
      if (out.reason === 'hash-mismatch') {
        showReceiveResult(false,
          'Hash mismatch — the whole transfer was discarded. Expected ' +
          String(out.expected).slice(0, 16) + '…, got ' + String(out.actual).slice(0, 16) + '…');
        return;
      }
      showReceiveResult(false,
        V2_FINALIZE_COPY[out.reason] || ('The transfer was refused: ' + out.reason + '.'));
      return;
    }
    Promise.resolve(admitAndStore(s, out.bytes, out.name)).catch(function (err) {
      showReceiveResult(false, 'Failed to store: ' + err.message);
    });
  }

  /**
   * The tail both formats share: pin check, then the vault.
   *
   * The hash proves the bytes; it does not prove the signer. When a fingerprint
   * is pinned the signature verdict has to be settled and admitting BEFORE
   * anything reaches the vault — the check runs asynchronously, so waiting on
   * it here is what makes the pin a control rather than a label.
   */
  function admitAndStore(state, bytes, name) {
    return Promise.resolve(rx.pin ? rx.verificationPromise : null)
      .catch(function () { return null; })
      .then(function () {
        var verdict = core.admitArtifact(rx.pin, rx.verification);
        if (!verdict.admit) {
          state.status = 'REJECTED';
          showReceiveResult(false,
            'Refused — ' + verdict.reason +
            ' The bytes arrived intact, but nothing was stored.');
          return;
        }
        state.status = 'VERIFIED';
        return storeArtifact(name, bytes, 'received').then(function () {
          stopCamera();
          showReceiveResult(true,
            'Verified and stored: ' + core.sanitizeName(name) + ' (' +
            core.formatBytes(bytes.length) +
            '). SHA-256 matches the manifest. Nothing was executed.');
          renderVault();
        });
      });
  }

  function showReceiveResult(ok, msg) {
    var box = $('rxResult');
    box.textContent = '';
    var n = el('div', 'notice ' + (ok ? 'good' : 'bad'), msg);
    box.appendChild(n);
    if (ok) {
      var go = el('button', 'btn-sm', 'Open vault');
      go.style.marginTop = '.6rem';
      go.addEventListener('click', function () { selectTab('vault'); });
      box.appendChild(go);
    }
    renderReceiveProgress();
  }

  // ---------------------------------------------------------------------------
  // Welcome
  //
  // Shown once, re-openable from About, and never on the critical path: the
  // vault renders and the app is usable whether or not this ever appears.
  // ---------------------------------------------------------------------------

  var welcomeDialog = $('welcome');
  var welcomeReturnFocus = null;
  var stage = null;

  function safeStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null; // private mode, or an embedded frame denying storage
    }
  }

  function openWelcome(opener) {
    welcomeReturnFocus = opener || null;
    welcomeDialog.classList.add('enter');
    // showModal() is not merely absent on some hosts — inside a sandboxed
    // iframe without allow-modals it EXISTS and THROWS. Falling back to the
    // open attribute keeps the sheet usable there instead of leaving a
    // half-opened dialog nobody can dismiss.
    try {
      if (welcomeDialog.showModal) welcomeDialog.showModal();
      else welcomeDialog.setAttribute('open', '');
    } catch (e) {
      welcomeDialog.setAttribute('open', '');
    }
    startStage();
    // Focus the primary action, not the dialog, so Enter does the useful thing.
    var primary = $('welcomeStart');
    // preventScroll matters on a phone: without it, focusing the primary
    // action scrolls the sheet to the bottom, so the reader lands on the last
    // beat and never sees the opening. Keyboard focus still starts on the
    // useful control; the view just does not jump to it.
    if (primary && primary.focus) {
      try {
        primary.focus({ preventScroll: true });
      } catch (e) {
        primary.focus();
      }
      if (welcomeDialog) welcomeDialog.scrollTop = 0;
    }
  }

  function closeWelcome() {
    // Native dialogs fire 'close' for every dismissal route — button, Escape,
    // backdrop — so the bookkeeping lives in that one handler. Only the
    // no-showModal fallback has to do it here.
    // A native close() fires the 'close' event, where the bookkeeping lives, so
    // prefer it. But it can throw on a host that refused showModal(), and if it
    // does the sheet must still go away — an intro nobody can dismiss is worse
    // than one that skips its own bookkeeping.
    if (welcomeDialog.close && welcomeDialog.open) {
      try {
        welcomeDialog.close();
        return;
      } catch (e) {
        // fall through to the manual teardown below
      }
    }
    stopStage();
    core.markWelcomeSeen(safeStorage());
    welcomeDialog.removeAttribute('open');
    welcomeDialog.classList.remove('enter');
    if (welcomeReturnFocus && welcomeReturnFocus.focus) welcomeReturnFocus.focus();
    welcomeReturnFocus = null;
  }

  // ---------------------------------------------------------------------------
  // Welcome animation
  //
  // The subject is its own illustration: frames leaving a screen, crossing a
  // gap, and filling a receiver's grid. It is decorative, so it yields to
  // everything — a reduced-motion preference renders one composed still frame
  // instead, and it stops entirely whenever the dialog is not on screen.
  // ---------------------------------------------------------------------------


  function stageColors() {
    var css = getComputedStyle(document.documentElement);
    var read = function (name, fallback) {
      var v = css.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    return {
      accent: read('--accent', '#2dd4bf'),
      line: read('--line', '#24303f'),
      muted: read('--muted', '#8b9bb0'),
      surface: read('--surface', '#121821')
    };
  }

  // A fixed pseudo-random matrix with finder-like corners: unmistakably a QR
  // code at a glance without pretending to be a scannable one.
  function stageMatrix(n) {
    var cells = [];
    var seed = 0x5eed;
    for (var y = 0; y < n; y++) {
      var row = [];
      for (var x = 0; x < n; x++) {
        var corner = (x < 3 && y < 3) || (x >= n - 3 && y < 3) || (x < 3 && y >= n - 3);
        if (corner) {
          var lx = x >= n - 3 ? n - 1 - x : x;
          var ly = y >= n - 3 ? n - 1 - y : y;
          row.push(lx === 1 && ly === 1 ? 0 : 1);
        } else {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          row.push((seed >>> 17) & 1);
        }
      }
      cells.push(row);
    }
    return cells;
  }

  function createStage(canvas) {
    return {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      matrix: stageMatrix(9),
      n: 9,
      model: core.createStageModel(),
      raf: 0,
      running: false
    };
  }

  function stageGeometry(st) {
    var w = st.canvas.width, h = st.canvas.height;
    var pad = Math.round(h * 0.12);
    var side = h - pad * 2;
    return {
      w: w, h: h, pad: pad, side: side,
      senderX: pad, senderY: pad,
      recvX: w - pad - side, recvY: pad,
      travel: (w - pad - side) - (pad + side)
    };
  }

  function drawStage(st) {
    var m = st.model;
    var ctx = st.ctx, c = stageColors(), g = stageGeometry(st);
    if (!ctx || g.side <= 0) return; // nothing sensible to draw into
    ctx.clearRect(0, 0, g.w, g.h);

    // Sender: the QR matrix.
    var cell = g.side / st.n;
    ctx.fillStyle = c.accent;
    for (var y = 0; y < st.n; y++) {
      for (var x = 0; x < st.n; x++) {
        if (!st.matrix[y][x]) continue;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(
          g.senderX + x * cell + 0.5, g.senderY + y * cell + 0.5,
          Math.ceil(cell) - 1, Math.ceil(cell) - 1
        );
      }
    }
    ctx.globalAlpha = 1;

    // The gap the data crosses.
    ctx.strokeStyle = c.line;
    ctx.lineWidth = Math.max(1, g.h * 0.008);
    ctx.setLineDash([g.h * 0.03, g.h * 0.05]);
    ctx.beginPath();
    ctx.moveTo(g.senderX + g.side + g.pad * 0.6, g.h / 2);
    ctx.lineTo(g.recvX - g.pad * 0.6, g.h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Receiver: a grid that fills as frames land.
    var cols = 4, rows = 3;
    var rcw = g.side / cols, rch = g.side / rows;
    for (var i = 0; i < m.cells; i++) {
      var cx = g.recvX + (i % cols) * rcw;
      var cy = g.recvY + Math.floor(i / cols) * rch;
      var filled = i < m.landed;
      ctx.fillStyle = filled ? c.accent : c.line;
      ctx.globalAlpha = filled ? 0.9 : 0.5;
      roundRect(ctx, cx + 1.5, cy + 1.5, rcw - 3, rch - 3, Math.min(rcw, rch) * 0.18);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Frames in flight.
    var size = Math.max(6, g.side * 0.2);
    for (var p = 0; p < m.packets.length; p++) {
      var pk = m.packets[p];
      var px = g.senderX + g.side + pk.progress * g.travel;
      var py = g.h / 2 - size / 2 + Math.sin(pk.progress * Math.PI) * (pk.drift * g.h * 0.06);
      ctx.globalAlpha = pk.progress > 0.9 ? (1 - pk.progress) * 10 : 1;
      ctx.fillStyle = c.accent;
      roundRect(ctx, px, py, size, size, size * 0.22);
      ctx.fill();
      // A couple of dark notches so it reads as a frame, not a dot.
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = c.surface;
      ctx.fillRect(px + size * 0.18, py + size * 0.18, size * 0.22, size * 0.22);
      ctx.fillRect(px + size * 0.6, py + size * 0.6, size * 0.22, size * 0.22);
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (!(w > 0) || !(h > 0)) return; // arcTo throws on degenerate boxes
    var rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function startStage() {
    var canvas = $('welcomeStage');
    if (!canvas || !canvas.getContext) return;
    if (!stage) stage = createStage(canvas);

    // Whatever happens next, paint something correct first. A decorative loop
    // that fails to start must degrade to a still picture, never to a blank
    // panel — the panel has to carry its meaning on its own.
    stage.model = core.stageStillModel(core.createStageModel());
    safeDraw();

    var reduced = core.prefersReducedMotion(
      window.matchMedia ? window.matchMedia.bind(window) : null
    );
    if (reduced) return; // the still above is the whole story

    stopStage();
    stage.model = core.createStageModel();
    stage.running = true;

    var tick = function (now) {
      if (!stage.running) return;
      // Re-check the world every frame rather than trusting a flag set once:
      // the dialog can be closed by routes this loop never hears about.
      var env = {
        open: !!welcomeDialog.open,
        visible: !document.hidden,
        reduced: false
      };
      if (!env.open) { stopStage(); return; }
      stage.raf = requestAnimationFrame(tick);
      var step = core.stageAdvance(stage.model, now, env);
      if (step.draw) safeDraw();
    };
    stage.raf = requestAnimationFrame(tick);
  }

  // A decorative animation must never become a source of console noise or a
  // half-painted panel: one failure stops the loop and leaves the still.
  function safeDraw() {
    try {
      drawStage(stage);
    } catch (e) {
      stopStage();
      try {
        stage.model = core.stageStillModel(core.createStageModel());
        drawStage(stage);
      } catch (e2) { /* nothing further to try */ }
    }
  }

  function stopStage() {
    if (!stage) return;
    stage.running = false;
    if (stage.raf) cancelAnimationFrame(stage.raf);
    stage.raf = 0;
  }

  // ---------------------------------------------------------------------------
  // Tabs and wiring
  // ---------------------------------------------------------------------------

  var TABS = ['vault', 'send', 'receive', 'guide', 'about'];

  function selectTab(name) {
    TABS.forEach(function (t) {
      $('tab-' + t).hidden = t !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabbar button'), function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    });
    if (name !== 'send') play(false);
    if (name !== 'receive') stopCamera();
    window.scrollTo(0, 0);
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabbar button'), function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.tab); });
    });

    $('importBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $('demoRvfBtn').addEventListener('click', function () { loadDemo('ruvnet-demo.rvf'); });
    $('demoWasmBtn').addEventListener('click', function () { loadDemo('rvf_wasm_bg.wasm'); });

    $('imageBtn').addEventListener('click', function () { $('imageInput').click(); });
    $('imageInput').addEventListener('change', function (e) {
      decodeImageFiles(e.target.files);
      e.target.value = '';
    });
    $('imageDrop').addEventListener('drop', function (e) {
      // Handled here as well as globally so a dropped picture on the Receive
      // tab is decoded rather than imported into the vault.
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) decodeImageFiles(e.dataTransfer.files);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.goto); });
    });
    $('refreshBtn').addEventListener('click', function () { renderVault(); });
    $('detailClose').addEventListener('click', hideSheet);

    // Every dismissal route ends in a 'close' event — the button, Escape on a
    // modal dialog, or a form submit. Without this the sheet could vanish while
    // openDetailId still claimed it was open, and the expiry ticker would go on
    // repainting a countdown node that is no longer on screen.
    dialog.addEventListener('close', function () {
      openDetailId = null;
      detailCountdown = null;
    });

    // A non-modal dialog gets no Escape handling from the browser, so the
    // docked panel needs its own. Harmless for the modal case: by the time the
    // browser acts on Escape the dialog is already closed.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !dialog.open) return;
      hideSheet();
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && e.relatedTarget) return;
        document.body.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', function (e) {
      if (e.defaultPrevented) return; // the Receive drop zone already took it
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        selectTab('vault');
        importFiles(e.dataTransfer.files);
      }
    });

    $('sendPick').addEventListener('change', function (e) {
      if (e.target.value) startSend(e.target.value);
      else { stopSend(); $('sendStageCard').hidden = true; }
    });
    $('playBtn').addEventListener('click', function () { play(!send.playing); });
    $('restartBtn').addEventListener('click', function () { drawFrame(0); play(true); });
    $('scrub').addEventListener('input', function (e) {
      play(false);
      drawFrame(Number(e.target.value));
    });
    $('chunkRange').addEventListener('input', function (e) {
      send.chunk = Number(e.target.value);
      $('chunkLabel').textContent = String(send.chunk);
    });
    $('chunkRange').addEventListener('change', function () {
      if (send.record) startSend(send.record.id);
    });
    $('fpsRange').addEventListener('input', function (e) {
      send.fps = Number(e.target.value);
      $('fpsLabel').textContent = String(send.fps);
      if (send.playing) play(true);
    });
    $('eclPick').addEventListener('change', function (e) {
      send.ecl = e.target.value;
      drawFrame(send.index);
    });

    // --- frame format ---
    // Changing the format rebuilds the stream: the frames in hand are in the
    // old one, and a receiver mid-transfer would see the two disagree.
    $('formatPick').addEventListener('change', function (e) {
      send.format = core.normalizeFormat(e.target.value);
      renderFormatNote();
      renderSignNote();
      if (send.record) startSend(send.record.id);
    });

    // --- transfer mode ---
    $('modePick').addEventListener('change', function (e) {
      send.mode = e.target.value === 'fountain' ? core.MODE_FOUNTAIN : core.MODE_INDEXED;
      renderModeNote();
      if (send.record) startSend(send.record.id);
    });
    $('signSend').addEventListener('change', function (e) {
      send.sign = !!e.target.checked;
      renderSignNote();
      if (send.record) startSend(send.record.id);
    });

    // --- delta ---
    $('deltaPairBtn').addEventListener('click', startPairing);
    $('deltaPairConfirmBtn').addEventListener('click', finishPairing);
    $('deltaPairImageBtn').addEventListener('click', function () { $('deltaPairImageInput').click(); });
    $('deltaPairImageInput').addEventListener('change', function (e) {
      var files = e.target.files;
      e.target.value = '';
      if (!files || !files.length || !qrdec) return;
      decodeImageToText(files[0]).then(function (texts) {
        if (!texts.length) { toast('No code found in that picture'); return; }
        $('deltaPairReply').value = texts[0];
        finishPairing();
      });
    });
    $('deltaDiffBtn').addEventListener('click', runDeltaDiff);
    $('deltaImageBtn').addEventListener('click', function () { $('deltaImageInput').click(); });
    $('deltaImageInput').addEventListener('change', function (e) {
      var files = e.target.files;
      e.target.value = '';
      if (!files || !files.length || !qrdec) return;
      decodeImageToText(files[0]).then(function (texts) {
        if (!texts.length) { toast('No code found in that picture'); return; }
        $('deltaInventory').value = texts.join('\n');
        toast('Read ' + texts.length + ' code' + (texts.length === 1 ? '' : 's'));
        runDeltaDiff();
      });
    });

    // --- signature pinning ---
    $('pinSet').addEventListener('click', function () {
      var v = $('pinInput').value.trim();
      if (!v) { toast('Enter a fingerprint first'); return; }
      rx.pin = v;
      toast('Pinned ' + v);
      if (rx.state.manifest) { rx.verification = null; verifyManifestSignature(); }
    });
    $('pinClear').addEventListener('click', function () {
      rx.pin = null;
      $('pinInput').value = '';
      if (rx.state.manifest) { rx.verification = null; verifyManifestSignature(); }
      else { rx.verification = null; renderVerification(); }
      toast('Pin cleared');
    });

    $('scanBtn').addEventListener('click', startCamera);
    $('resetRxBtn').addEventListener('click', function () {
      resetReceiver();
      toast('Receiver reset');
    });
    $('manualBtn').addEventListener('click', function () {
      var raw = $('manualFrames').value;
      var fed = 0;
      // One frame per line works for v1, whose frames are JSON and contain no
      // newline. It cannot work for v2: the armour's alphabet is every byte
      // 0x00-0x7F, newline and the other control characters included, so
      // splitting on '\n' or trimming whitespace cuts a frame in half. So the
      // whole box is offered as a single v2 frame first, and only text that is
      // not one falls through to the line-by-line path.
      if (core.frameFormat(raw, proto2Lib()) === core.FORMAT_V2) {
        rx.lastText = null;
        feedFrame(raw);
        fed = 1;
      } else {
        var lines = raw.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          rx.lastText = null;
          feedFrame(line);
          fed++;
        }
      }
      $('rxCard').hidden = false;
      toast('Fed ' + fed + ' frame' + (fed === 1 ? '' : 's'));
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { play(false); stopStage(); }
      else if (welcomeDialog.open) startStage();
    });

    // --- welcome ---
    $('welcomeStart').addEventListener('click', function () {
      closeWelcome();
      // The primary action does something: load the demo and land the user on
      // Send, ready to go. A first-run modal whose only outcome is vanishing
      // has wasted the one moment it had.
      loadDemo('ruvnet-demo.rvf').then(function (record) {
        selectTab('send');
        if (record && record.id) {
          $('sendPick').value = record.id;
          startSend(record.id);
        }
      });
    });
    $('welcomeClose').addEventListener('click', closeWelcome);

    // The intro opens on every load and dismissal covers only that visit, so
    // this checkbox is the sole permanent opt-out. It is applied on change
    // rather than on dismissal, so ticking it takes effect however the dialog
    // is then closed — button, Escape or backdrop.
    $('welcomeSuppress').addEventListener('change', function (e) {
      var storage = safeStorage();
      if (e.target.checked) {
        core.suppressWelcome(storage);
        toast('The intro will not open again');
      } else {
        core.unsuppressWelcome(storage);
      }
    });

    // "Show the intro again" is also the way back from that opt-out: reopening
    // it by hand is a clear statement that it is wanted, so the suppression is
    // lifted rather than leaving the viewer to hunt for the checkbox.
    $('showWelcome').addEventListener('click', function (e) {
      core.unsuppressWelcome(safeStorage());
      $('welcomeSuppress').checked = false;
      openWelcome(e.currentTarget);
    });
    // Escape and the backdrop both route through the dialog's own close event,
    // so dismissal is recorded however it happened.
    welcomeDialog.addEventListener('close', function () {
      stopStage();
      core.markWelcomeSeen(safeStorage());
      if (welcomeReturnFocus && welcomeReturnFocus.focus) welcomeReturnFocus.focus();
      welcomeReturnFocus = null;
    });
    welcomeDialog.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || welcomeDialog.showModal) return;
      // Manual focus trap only for browsers without showModal, which traps
      // focus natively.
      var focusable = welcomeDialog.querySelectorAll('button, [href], input, select, textarea');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    welcomeDialog.addEventListener('cancel', function () { stopStage(); });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  wire();
  renderCapabilityNotice();
  resetReceiver();
  // Deliberately after the vault render resolves: the welcome is an
  // enhancement, and the app must be usable whether or not it ever appears.
  if (core.shouldShowWelcome(safeStorage())) {
    setTimeout(function () { openWelcome(null); }, 0);
  }

  // The optional modules arrive after this script runs, so the notes that
  // describe them are filled in once the document is ready rather than now.
  window.addEventListener('load', function () {
    renderFormatNote();
    renderModeNote();
    renderSignNote();
    offerResume();
    if (!fountainLib()) $('modePick').disabled = true;
    if (!cryptoLib()) $('signSend').disabled = true;
    if (!deltaLib()) $('deltaSendCard').hidden = true;
    // Pairing only exists to seal a semantic inventory. Without either module
    // the controls would take a device through a handshake that bought it
    // nothing, so they are removed rather than left to disappoint.
    if (!cryptoLib() || !semDeltaLib()) $('deltaPairStep').hidden = true;
    // The picker offers v2 only when the module that builds it is here. A
    // choice that silently means something else is worse than no choice.
    if (!proto2Lib()) $('formatPick').disabled = true;
  });

  renderVault().then(function () {
    var kind = scannerKind();
    $('statusChip').textContent = kind === 'native'
      ? 'alpha \u00b7 native scan'
      : kind === 'fallback' ? 'alpha \u00b7 built-in scan' : 'alpha \u00b7 send only';
  });
})();
