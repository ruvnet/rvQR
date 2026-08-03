/*!
 * rvQR transfer planner — choosing a strategy before spending a byte on it.
 *
 * Every other module here answers a local question well. core.js frames, and
 * proto2.js frames more densely. fountain.js codes against loss. delta.js and
 * semdelta.js send differences instead of files, and semdelta.chooseDelta()
 * picks between two payloads it has already built. Nothing decides which of
 * those machines to run in the first place, so today the app decides by
 * defaulting, and a default is a decision nobody has to defend.
 *
 * This module is where that decision is made and written down. Given a
 * situation — artifact size, what the receiver already holds, what the link is
 * doing, what the device can spare, what the operator's policy allows — it
 * enumerates concrete strategies, discards the ones that are not allowed to
 * run, ranks what is left, and returns the winner together with every loser
 * and the reason it lost. A transfer nobody can explain is a transfer nobody
 * can trust, which is the same reason chooseDelta() reports both figures.
 *
 * ---------------------------------------------------------------------------
 * THE OBJECTIVE, AND WHERE ITS NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 *
 *   J = 0.45·T + 0.20·E + 0.20·B + 0.15·R      (a COST — lower is better)
 *
 * The weights sum to exactly 1 and every term is in [0,1], so J is in [0,1]
 * too and the weights mean what they look like they mean. An unnormalised
 * weighted sum of seconds, joules, bytes and a probability is four units added
 * together, which is not a number; the basis of each normalisation is
 * therefore stated here, restated by describeNormalisation() so it can be read
 * out of a running system, and asserted by the test suite.
 *
 * Three of the four terms are ratios against ONE fixed reference strategy:
 * v1 JSON framing, indexed mode, a 512-byte chunk, whole-artifact transfer,
 * complete verification — that is, exactly what this app does today when
 * nobody chooses anything. The reference is evaluated in the same situation as
 * the candidate, at the same loss rate, frame rate and symbol size, so the
 * ratio is dimensionless and means "against shipping it the way we ship it
 * now". The reference is deliberately NOT the best or worst candidate in the
 * set: a basis that depended on which candidates happened to be enumerated
 * would make every score change when an unrelated candidate was added.
 *
 *   T  time.   seconds(candidate) / seconds(reference), clamped to [0,1].
 *              Seconds are slots ÷ frame rate. Slots are symbols ÷ (1−loss),
 *              times the transport's measured inflation over that ideal:
 *              1.000191 for the fountain (docs/benchmarks.md §4, 2,200 decodes)
 *              and the v1 indexed table of §10, which runs 2.12× at 10% loss to
 *              3.90× at 60% because a cyclic sender can only replace a missed
 *              frame with that same frame coming round again.
 *
 *   E  energy. energy(candidate) / energy(reference), clamped to [0,1].
 *              MODELLED, and the weakest term here: this repository has no
 *              power measurement of any kind (§17), so E is a relative proxy
 *              in arbitrary units, not joules. Its terms are slots held with
 *              the screen and camera live, per-slot decode work, and radio
 *              time for transports that use one. Named weights, all of them
 *              guesses, all of them in one place below.
 *
 *   B  bytes.  wireBytes(candidate) / wireBytes(reference), clamped to [0,1].
 *              Bytes actually painted or sent, framing included, not payload
 *              bytes. The clamp is load-bearing and it hides something real:
 *              §7 measured span deltas LARGER than the file they replace on
 *              single-segment containers — 41,155 B against a 41,053 B module.
 *              Such a candidate scores B = 1, the same as resending everything,
 *              because "worse than the worst basis we chose" is still worst.
 *              The unclamped ratio is reported as `bRaw` so the case is
 *              visible rather than silently flattened.
 *
 *   R  risk.   Already a probability, so it is the one term with nothing to
 *              normalise: the chance this strategy has to be retried at all.
 *              Composed as 1 − ∏(1 − rᵢ) over independent hazards — the
 *              contact window closing early, a stale base making the delta
 *              unappliable, a receiver that may not have proto2.js, and the
 *              residual a partial verification leaves behind. Independence is
 *              an assumption and a generous one; see describeLimits().
 *
 * ---------------------------------------------------------------------------
 * HARD RULES OVERRIDE LEARNING, BY CONSTRUCTION AND NOT BY DISCIPLINE
 * ---------------------------------------------------------------------------
 *
 * Four rules decide whether a strategy is allowed to run at all: the peer must
 * be verified and correctly pinned, projected peak memory must stay under
 * 128 MiB, the radio policy must be satisfied, and a committing transfer must
 * verify completely. None of them is negotiable and none of them has a price.
 *
 * The obvious implementation — score everything, subtract a large penalty from
 * the forbidden ones — is wrong, and it is wrong in a way that testing rarely
 * catches. A penalty is a number, a learned bonus is a number, and a large
 * enough bonus beats any finite penalty. The rule then holds in practice and
 * fails exactly when the learned component has become confident enough to be
 * worth having.
 *
 * So the shape is: FILTER, THEN SCORE, and the two halves do not share data.
 * admit() splits the candidate list into `admissible` — real candidate objects
 * — and `rejected`, which are REPORT ROWS: an id, a label, the rule that
 * killed them and why. A report row carries no candidate object, so there is
 * nothing there to score even by accident. rank() is then handed the
 * admissible array alone; it is never passed the rejected list, never passed
 * the original list, and never consults the situation's rules again. A learned
 * score cannot resurrect a rejected candidate because after admit() runs there
 * is no rejected candidate left in the world rank() can see.
 *
 * The learned component is an ADVISER: an injectable object with one method,
 *
 *   adviser.preference(candidate, situation) -> number in [0,1], higher better
 *
 * whose output is blended into the ranking at a bounded weight and never into
 * J itself. The default adviser returns 0.5 for everything, which is an
 * additive constant and therefore leaves the J ordering exactly intact — tests
 * never depend on a trained model, and a system with no model behaves as if
 * the adviser were not there. A hosted SONA/RuVector policy drops in here by
 * implementing that one method. Note what the ordering above buys: a broken
 * adviser can cost you the best plan, but it cannot buy a forbidden one.
 *
 * ---------------------------------------------------------------------------
 * INVENTORY GRANULARITY — THE DEFECT MEASURED IN docs/benchmarks.md §7
 * ---------------------------------------------------------------------------
 *
 * semdelta.semanticInventory() builds a unit table unconditionally, for every
 * container, before anyone knows what changed. The receiver therefore pays for
 * unit granularity even in the transfers where the sender will look at it and
 * decline it. §7 measured that bill arriving: on the demo container with every
 * vector record rewritten, the two-hop total is 2,177 B against the span
 * path's 1,308 B.
 *
 * chooseDelta() is NOT at fault and must not be changed. It receives the
 * inventory as an argument; by the time it runs that hop has crossed the wire
 * and its cost is sunk, so comparing payloads alone is the correct comparison
 * at that call site and folding the inventory back in would be a textbook
 * sunk-cost error. The unexamined decision is upstream, on the receiver, and
 * that is what chooseInventoryGranularity() below makes.
 *
 * A receiver cannot know what changed. It can bound what a unit table could
 * possibly save, and the bound is arithmetic on sizes it already has.
 *
 *   The unit table is paid TWICE, with certainty, whatever changed:
 *
 *     on the inventory hop   b64(52 + (spans+units)·rec) − b64(44 + spans·rec)
 *     on the delta payload   (units − spans)·rec
 *
 *   where rec = 6 + hashBytes is a table record and b64(n) = ⌈4n/3⌉ because
 *   the app carries an inventory as base64url through a QR symbol. Both
 *   figures are exact, not estimates: they are the header and record sizes
 *   semdelta.js and delta.js actually encode.
 *
 *   The saving is paid ONCE, and only when the change is localised. Its
 *   ceiling is D, the bytes living in segments this module could decompose at
 *   all — a change outside those segments costs the span path and the unit
 *   path exactly the same.
 *
 *   If a change rewrites a fraction f of D, the unit path carries about f·D
 *   where the span path carries D, so the saving is (1−f)·D and unit
 *   granularity pays iff
 *
 *       (1 − f)·D  >  doublePaid       i.e.  f  <  1 − doublePaid/D
 *
 *   That right-hand side is computable by a receiver with no idea what f is.
 *   Call it the REWRITE TOLERANCE: the largest fraction of the decomposable
 *   bytes that may turn over before unit granularity stops paying. The rule
 *   publishes a unit table only when the tolerance it buys is at least
 *   DEFAULT_REWRITE_TOLERANCE.
 *
 * WHAT THE BOUND ASSUMES, stated so a reviewer can attack it:
 *   - that the sender's container decomposes roughly the way the receiver's
 *     does. They are two versions of one artifact; if that is false the delta
 *     path is the wrong path regardless of granularity.
 *   - that a byte changing inside a segment costs the span path the whole
 *     segment. That is what delta.js does, by construction.
 *   - that a semantic delta payload carries the full unit table and a span
 *     delta the full span table. Both do; the arithmetic above is their real
 *     wire format, and it reproduces §7's measured figures exactly rather than
 *     approximately — see the test named for 869 bytes.
 *   - that the inventory travels base64url. Adjustable via `inventoryExpansion`
 *     for a caller that ships it raw.
 *   - NOTHING about what changed. f never appears in the decision, only in the
 *     derivation of the threshold f is compared against.
 *
 * BEING CONSERVATIVE HERE IS CORRECT. Declining unit granularity when it would
 * have helped costs some bytes. Paying for it when it cannot possibly help is
 * the defect. Against §7's seven scenarios the default tolerance declines the
 * two demo rows and admits the other five; it gives up 687 B on the demo row
 * where units would have won and saves 869 B on its twin, which is the same
 * container with a different edit — a receiver cannot tell those two apart,
 * and any rule that claims to is claiming to know f.
 *
 * The threshold is calibrated on seven scenarios and that is not many. Any
 * tolerance in (0.517, 0.774] produces identical verdicts on all seven; 0.75 is
 * a round number inside that interval, and the interval's width is the honest
 * measure of how well the evidence pins it down.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network, and no clock — the time a decision depends on is passed in, so the
 * tests are deterministic and a plan made twice from the same situation is the
 * same plan.
 *
 * Browser: load core.js before this file.
 * Node:    require('./planner.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.RVQRPlanner = factory(root.RVQRCore);
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  // --- The objective ---------------------------------------------------------

  /**
   * Weights on the four normalised terms. They sum to exactly 1, which is what
   * lets J be read as a fraction of the reference strategy's badness rather
   * than as an arbitrary scalar. WEIGHT_SUM is asserted by the test suite so a
   * future edit cannot quietly break that reading.
   */
  var WEIGHT_TIME = 0.45;
  var WEIGHT_ENERGY = 0.20;
  var WEIGHT_BYTES = 0.20;
  var WEIGHT_RISK = 0.15;
  var WEIGHT_SUM = WEIGHT_TIME + WEIGHT_ENERGY + WEIGHT_BYTES + WEIGHT_RISK;

  /**
   * The strategy every ratio term is measured against: what this app does now.
   * Held here rather than inlined because three separate terms divide by it and
   * a reference that drifted between them would make J meaningless.
   */
  var REFERENCE = {
    id: 'reference',
    label: 'v1 JSON, indexed, 512 B chunk, whole artifact',
    transport: 'optical',
    needsRadio: false,
    format: 'v1',
    mode: 'indexed',
    chunkBytes: 512,
    granularity: 'full',
    verification: 'complete'
  };

  // --- Hard rules ------------------------------------------------------------

  var RULE_TRUST = 'trust';
  var RULE_MEMORY = 'memory';
  var RULE_RADIO = 'radio';
  var RULE_VERIFICATION = 'verification';

  /**
   * ADR-025 §2.2, confirmed by docs/benchmarks.md §9: under 128 MiB of working
   * memory. §9 measures the pipeline only — a browser tab's DOM, canvas backing
   * store and camera buffers sit outside it, which is why a situation supplies
   * `device.baselineBytes` and the projection adds it rather than pretending
   * the pipeline is the whole process.
   */
  var MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

  /** Radio policies. `offline` forbids every transport that needs a radio. */
  var RADIO_ANY = 'any';
  var RADIO_OFFLINE = 'offline';
  var KNOWN_RADIO_POLICIES = [RADIO_ANY, RADIO_OFFLINE];

  var VERIFY_COMPLETE = 'complete';
  var VERIFY_PARTIAL = 'partial';

  // --- Measured inputs -------------------------------------------------------
  // Everything in this block came off docs/benchmarks.md and is MEASURED. The
  // modelled weights are further down, kept apart on purpose so a reader can
  // see at a glance which numbers were observed and which were invented.

  /**
   * Framing bytes per payload byte, measured at version 19-L (§1). Note the
   * denominator: this is overhead over PAYLOAD, not over the symbol, which is
   * how §1's envelope column is defined and the only reading under which its
   * numbers reproduce. A 792-byte symbol carries 792 ÷ 1.440 = 550 artifact
   * bytes under v1's JSON+base64url framing and 792 ÷ 1.191 = 665 under v2
   * armoured, which are §1's measured maxima exactly.
   *
   * v2 BINARY is deliberately absent. §1 encoded one at 19-L and decoded it
   * with the shipped decoder: 792 bytes in, 830 bytes back, parseFrame rejects
   * it, because qrdecode.js hands byte-mode octets to a UTF-8 decoder. Its
   * 3.7% envelope is not a strategy anyone can choose today, and offering it
   * here would be offering a transfer that cannot complete.
   */
  var ENVELOPE = { v1: 0.440, v2: 0.191, raw: 0.0 };

  /**
   * Payload ceiling per frame by framing. v1 clamps at core.MAX_CHUNK, which
   * is why §1 found it cannot fill a version 40 symbol at any setting; v2
   * clamps at the absolute byte-mode capacity instead.
   */
  var MAX_PAYLOAD = { v1: core.MAX_CHUNK, v2: core.MAX_RECEIVE_CHUNK, raw: core.MAX_RECEIVE_CHUNK };

  /**
   * Slots the v1 indexed transport really needs, over the K/(1−p) an ideal
   * rateless transport would need (§10, cross-checked against §3's 500 trials
   * per cell). A cyclic sender can only replace a missed frame with that same
   * frame coming round again, so every distinct index must survive a pass and
   * the count grows by a log-K factor the fountain does not pay.
   *
   * Linearly interpolated between the measured points; held flat above the
   * last one, which understates the penalty at extreme loss and is the safe
   * direction to be wrong in for a term that already disfavours this transport.
   */
  var V1_LOSS_INFLATION = [
    { loss: 0.0, factor: 1.00 },
    { loss: 0.1, factor: 2.12 },
    { loss: 0.2, factor: 2.64 },
    { loss: 0.3, factor: 3.04 },
    { loss: 0.4, factor: 3.31 },
    { loss: 0.5, factor: 3.63 },
    { loss: 0.6, factor: 3.90 }
  ];

  /**
   * The fountain's reception overhead: 1.000191, from 2,200 decodes across
   * K ∈ {4…800} at 45% loss (§4), and independently 1.000185 from the codec
   * author's own 2,000 decodes. Not an assumption of ideality — a measurement
   * that happens to be very close to it.
   */
  var FOUNTAIN_RECEPTION_OVERHEAD = 1.000191;

  /**
   * How often a fountain stream must repaint its manifest, as a fraction of K.
   * §5 swept it: a receiver reaches full rank and then WAITS, unable to name or
   * verify the object, and at K=5 that wait was the entire 8.5-symbol finishing
   * overhead at 60% loss. The optimum moves in opposite directions at the two
   * ends of the K range, so no constant is right; clamp(K/2, 4, 32) matched the
   * measured optimum at both, and that is what these three numbers are.
   */
  var MANIFEST_EVERY_FRACTION = 0.5;
  var MANIFEST_EVERY_MIN = 4;
  var MANIFEST_EVERY_MAX = 32;

  /**
   * Live payload copies at the worst stage of each pipeline (§9, measured under
   * --expose-gc as heapUsed + external after a forced collection, because
   * typed-array payloads live in `external` and a copy count taken from the
   * heap alone under-reports them by about half).
   *
   * Both receivers are over ADR-025's "fewer than two copies" budget and §9 is
   * explicit that the cause is structural — the per-frame chunks and the
   * assembled output are alive together — so these are the numbers to plan
   * against, not the budget's aspiration.
   */
  var LIVE_COPIES = {
    receiver: { v1: 2.78, v2: 2.56, raw: 2.00 },
    sender: { v1: 1.78, v2: 1.45, raw: 1.00 }
  };

  // --- Modelled weights ------------------------------------------------------
  // Nothing below was measured. Each is named, defaulted, and reachable from
  // the outside so a caller with better information can replace it.

  /**
   * A fountain decoder holds its symbols until it can solve, so a whole extra
   * artifact-sized working set is live alongside the pipeline's copies.
   * MODELLED: §9 measured the indexed pipelines only.
   */
  var FOUNTAIN_LIVE_COPIES = 1.0;

  /**
   * Per-slot energy weights, in arbitrary units against the optical indexed
   * slot. There is no power measurement anywhere in this repository (§17), so
   * these are the honest shape of the cost and not its magnitude: a fountain
   * slot costs the same optics plus XOR work over the held symbols, and a radio
   * slot costs no screen and no camera but a transmitter.
   */
  var ENERGY_SLOT_OPTICAL = 1.0;
  var ENERGY_SLOT_FOUNTAIN_EXTRA = 0.15;
  var ENERGY_SLOT_RADIO = 0.60;

  /** Energy charged once for hashing and verifying, per artifact byte. MODELLED. */
  var ENERGY_PER_VERIFIED_BYTE = 2.0e-6;

  /** A partial verification leaves this much residual risk behind. MODELLED. */
  var PARTIAL_VERIFY_RISK = 0.25;

  /**
   * v1 is core.js's default framing precisely because a sender who has not
   * chosen otherwise must not be the reason a first-time receiver sees a
   * transfer it cannot read. A v2 candidate aimed at a receiver that has not
   * said it can read v2 carries that hazard explicitly. MODELLED.
   */
  var UNKNOWN_FORMAT_RISK = 0.30;

  /**
   * Ceiling on how much the adviser may move the ranking. The invariant does
   * not depend on this number — a rejected candidate is gone before ranking
   * begins, at any weight — so this bounds drift, not safety.
   */
  var MAX_ADVICE_WEIGHT = 0.35;
  var DEFAULT_ADVICE_WEIGHT = 0.20;

  // --- Inventory granularity -------------------------------------------------

  var GRANULARITY_SPAN = 'span';
  var GRANULARITY_UNIT = 'unit';
  var GRANULARITY_FULL = 'full';

  /** semdelta.js and delta.js header and record sizes, restated as arithmetic. */
  var SPAN_INVENTORY_HEADER = 44;
  var SEM_INVENTORY_HEADER = 52;
  var DEFAULT_HASH_BYTES = 8;
  var TABLE_RECORD_OVERHEAD = 6; // a record is 6 + hashBytes

  /** See the docblock: the interval the seven measured scenarios leave open is
   *  (0.517, 0.774]; this is a round number inside it. */
  var DEFAULT_REWRITE_TOLERANCE = 0.75;

  /** An inventory travels base64url through a QR symbol, so ⌈4n/3⌉ per byte. */
  var DEFAULT_INVENTORY_EXPANSION = 4 / 3;

  // --- Hostile-input ceilings ------------------------------------------------
  // A situation is mostly local, but the receiver half of it is built from a
  // scanned inventory — unauthenticated input from whatever was pointed at the
  // camera. Anything derived from that is bounded before it reaches arithmetic
  // that a wrong answer would propagate through.

  var MAX_CANDIDATES = 256;
  var MAX_UNIT_COUNT = 262144; // semdelta.MAX_UNITS, restated
  var MAX_SPAN_COUNT = 65535;  // delta.MAX_SPANS, restated

  /**
   * Every rejection from this module is a PlannerError with a stable `reason`
   * string, matching delta.js and semdelta.js. Callers switch on the reason;
   * the message is for humans.
   */
  function PlannerError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'PlannerError';
    err.reason = reason;
    return err;
  }

  function fail(reason, message) {
    throw PlannerError(reason, message);
  }

  // --- Arithmetic helpers ----------------------------------------------------

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function clamp01(n) {
    if (!isFiniteNumber(n)) return 1;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function num(value, fallback) {
    return isFiniteNumber(value) ? value : fallback;
  }

  /**
   * What n bytes of inventory cost on the wire. At the default expansion of
   * 4/3 this is exactly base64url's unpadded length — ⌈4n/3⌉ — which is how the
   * app carries an inventory through a QR symbol, and which reproduces §7's
   * 134 B and 667 B figures to the byte rather than to the nearest few.
   */
  function inventoryWireBytes(n, expansion) {
    return Math.ceil(n * expansion);
  }

  /**
   * Reads the v1 inflation table at an arbitrary loss rate. Linear between
   * measured points, flat outside them — see V1_LOSS_INFLATION on why flat is
   * the safe direction here.
   */
  function v1Inflation(loss) {
    var p = clamp01(loss);
    var table = V1_LOSS_INFLATION;
    if (p <= table[0].loss) return table[0].factor;
    for (var i = 1; i < table.length; i++) {
      if (p <= table[i].loss) {
        var lo = table[i - 1];
        var hi = table[i];
        var t = (p - lo.loss) / (hi.loss - lo.loss);
        return lo.factor + t * (hi.factor - lo.factor);
      }
    }
    return table[table.length - 1].factor;
  }

  // --- The situation ---------------------------------------------------------

  /**
   * Fills a situation out with defaults and rejects the parts that cannot be
   * defaulted. Returning a normalised copy rather than mutating the caller's
   * object keeps plan() a pure function of its argument — two calls on the same
   * situation object return the same plan and leave it untouched.
   *
   * `now` is accepted and carried but never read by the decision logic. It is
   * here so a caller can stamp a plan and so a future rule that genuinely needs
   * a clock has one passed in rather than reaching for Date.now().
   */
  function normalizeSituation(situation) {
    var s = situation || {};
    var artifact = s.artifact || {};
    var receiver = s.receiver || {};
    var link = s.link || {};
    var device = s.device || {};
    var policy = s.policy || {};
    var trust = s.trust || {};

    var artifactBytes = artifact.bytes;
    if (!isFiniteNumber(artifactBytes) || artifactBytes <= 0) {
      fail('bad-artifact-size', 'situation.artifact.bytes must be a positive number');
    }

    var radio = policy.radio === undefined ? RADIO_ANY : policy.radio;
    if (KNOWN_RADIO_POLICIES.indexOf(radio) < 0) {
      fail('unknown-radio-policy', 'policy.radio must be one of ' + KNOWN_RADIO_POLICIES.join(', '));
    }

    var spanCount = Math.max(0, Math.floor(num(receiver.spanCount, 0)));
    var unitCount = Math.max(0, Math.floor(num(receiver.unitCount, 0)));
    if (spanCount > MAX_SPAN_COUNT) fail('too-many-spans', spanCount + ' spans exceeds the ceiling');
    if (unitCount > MAX_UNIT_COUNT) fail('too-many-units', unitCount + ' units exceeds the ceiling');

    return {
      now: num(s.now, 0),
      artifact: {
        bytes: artifactBytes,
        name: artifact.name || ''
      },
      receiver: {
        // What the receiver has published about what it holds. `holds` is the
        // finest granularity its inventory supports, so a sender cannot plan a
        // unit delta against a receiver that only published spans.
        holds: receiver.holds === GRANULARITY_UNIT ? GRANULARITY_UNIT
          : receiver.holds === GRANULARITY_SPAN ? GRANULARITY_SPAN
            : 'none',
        baseBytes: Math.max(0, num(receiver.baseBytes, 0)),
        spanCount: spanCount,
        unitCount: unitCount,
        // Bytes living in segments semdelta.js can look inside, and the hash
        // width its tables use. Only the granularity rule reads these; they are
        // carried here so a plan is a function of one normalised object.
        decomposableBytes: Math.max(0, num(receiver.decomposableBytes, 0)),
        hashBytes: Math.max(1, Math.floor(num(receiver.hashBytes, DEFAULT_HASH_BYTES))),
        // Fraction of the artifact the receiver is expected to already hold.
        // Drives the delta candidates' wire size; 0 means a cold receiver.
        overlap: clamp01(num(receiver.overlap, 0)),
        // Confidence that the base it holds is the base the sender diffed
        // against. Below 1, a delta risks arriving unappliable.
        baseConfidence: clamp01(num(receiver.baseConfidence, 1)),
        supportsV2: receiver.supportsV2 === true
      },
      link: {
        lossRate: clamp01(num(link.lossRate, 0)),
        fps: Math.max(0.1, num(link.fps, 5)),
        // Byte-mode capacity of the QR version in use. 792 is version 19-L,
        // the operating point §1 and §10 measure against.
        symbolBytes: Math.max(1, Math.floor(num(link.symbolBytes, 792))),
        // How long the two devices can be expected to stay pointed at each
        // other. Infinite means "no window", not "unlimited time".
        contactSeconds: num(link.contactSeconds, Infinity),
        // Bytes per second a radio transport would manage. Only reached by
        // candidates the radio policy already allows.
        radioBytesPerSecond: Math.max(1, num(link.radioBytesPerSecond, 32768))
      },
      device: {
        role: device.role === 'sender' ? 'sender' : 'receiver',
        baselineBytes: Math.max(0, num(device.baselineBytes, 0)),
        memoryBudgetBytes: Math.max(1, num(device.memoryBudgetBytes, MEMORY_BUDGET_BYTES))
      },
      policy: {
        radio: radio,
        // A committing transfer is one whose result is written back as the new
        // base. It may not be built on a partial verification.
        commit: policy.commit === true,
        allowPartialVerification: policy.allowPartialVerification !== false,
        rewriteTolerance: clamp01(num(policy.rewriteTolerance, DEFAULT_REWRITE_TOLERANCE))
      },
      trust: {
        verified: trust.verified === true,
        pinnedKeyId: trust.pinnedKeyId === undefined ? null : trust.pinnedKeyId,
        presentedKeyId: trust.presentedKeyId === undefined ? null : trust.presentedKeyId
      }
    };
  }

  // --- Inventory granularity, decided before the inventory is built ----------

  /**
   * Span-only or unit-level, for a receiver about to publish what it holds.
   *
   * Takes sizes rather than a container so it stays a pure function of numbers
   * the caller already has: `decomposableBytes` is the total length of spans
   * whose type semdelta.js can look inside and which actually parsed, and
   * `unitCount` is how many units they would produce. Both come out of
   * semdelta.decompositionReport() without encoding anything.
   *
   * That decomposition still costs CPU — §7 measured about 27 ms to inventory
   * a 1.13 MB container. This rule does not claim to save that. The bill it
   * disputes is wire bytes, on a hop that §7 measured at 44,235 B against
   * 190 B, and the CPU spent deciding not to send them is not the same money.
   *
   * See the module docblock for the derivation. In one line: the unit table is
   * paid twice with certainty and saves at most D once, so it can only pay when
   * the change is confined to a fraction of D smaller than 1 − doublePaid/D.
   */
  function chooseInventoryGranularity(facts, opts) {
    facts = facts || {};
    opts = opts || {};

    var containerBytes = Math.max(0, num(facts.containerBytes, 0));
    var decomposable = Math.max(0, num(facts.decomposableBytes, 0));
    var spanCount = Math.max(0, Math.floor(num(facts.spanCount, 0)));
    var unitCount = Math.max(0, Math.floor(num(facts.unitCount, 0)));
    var hashBytes = Math.max(1, Math.floor(num(facts.hashBytes, DEFAULT_HASH_BYTES)));
    var expansion = Math.max(1, num(opts.inventoryExpansion, DEFAULT_INVENTORY_EXPANSION));
    var tolerance = clamp01(num(opts.rewriteTolerance, DEFAULT_REWRITE_TOLERANCE));

    if (spanCount > MAX_SPAN_COUNT) fail('too-many-spans', spanCount + ' spans exceeds the ceiling');
    if (unitCount > MAX_UNIT_COUNT) fail('too-many-units', unitCount + ' units exceeds the ceiling');

    var record = TABLE_RECORD_OVERHEAD + hashBytes;

    // The inventory hop, both ways round, in the units it actually travels in.
    var spanInventoryBytes = inventoryWireBytes(SPAN_INVENTORY_HEADER + spanCount * record, expansion);
    var unitInventoryBytes = inventoryWireBytes(SEM_INVENTORY_HEADER + (spanCount + unitCount) * record, expansion);
    var inventoryExtra = unitInventoryBytes - spanInventoryBytes;

    // The delta payload carries whichever table it is built from, and nothing
    // of the other one: a span delta is header + span table + content, a
    // semantic delta is header + unit table + content, and the two headers are
    // the same 88 bytes, so the difference is exactly the two tables.
    var payloadExtra = (unitCount - spanCount) * record;

    var doublePaid = inventoryExtra + payloadExtra;
    var breakEven = decomposable > 0 ? 1 - doublePaid / decomposable : 0;

    var result = {
      granularity: GRANULARITY_SPAN,
      verdict: '',
      unitCount: unitCount,
      spanCount: spanCount,
      recordBytes: record,
      spanInventoryBytes: spanInventoryBytes,
      unitInventoryBytes: unitInventoryBytes,
      inventoryExtra: inventoryExtra,
      payloadExtra: payloadExtra,
      doublePaid: doublePaid,
      decomposableBytes: decomposable,
      containerBytes: containerBytes,
      breakEvenRewriteFraction: breakEven,
      rewriteTolerance: tolerance,
      reason: '',
      assumptions: granularityAssumptions()
    };

    if (containerBytes <= 0 || unitCount <= 0) {
      result.verdict = 'nothing-to-decompose';
      result.reason = 'nothing held that decomposes, so a unit table would describe nothing';
      return result;
    }

    if (decomposable <= 0) {
      result.verdict = 'nothing-to-decompose';
      result.reason = 'no segment here has a payload layout this module can parse, ' +
        'so unit granularity cannot move a byte the span plan would not';
      return result;
    }

    // Stated separately from the tolerance test even though the tolerance test
    // subsumes it, because the two are different kinds of claim. This one is
    // certain: no edit whatsoever can make the table pay for itself.
    if (doublePaid >= decomposable) {
      result.verdict = 'impossible';
      result.reason = 'the unit table costs ' + doublePaid + ' B twice over against ' +
        decomposable + ' B of decomposable content — no change to that content, however ' +
        'small, could save what the table costs';
      return result;
    }

    if (breakEven < tolerance) {
      result.verdict = 'marginal';
      result.reason = 'unit granularity only pays if under ' +
        (breakEven * 100).toFixed(1) + '% of the ' + decomposable +
        ' decomposable bytes changed, and this receiver cannot know that it did; ' +
        'the ' + doublePaid + ' B the table costs twice over is certain, the saving is not';
      return result;
    }

    result.granularity = GRANULARITY_UNIT;
    result.verdict = 'worth-it';
    result.reason = 'the ' + doublePaid + ' B the unit table costs twice over still pays ' +
      'unless more than ' + (breakEven * 100).toFixed(1) + '% of the ' + decomposable +
      ' decomposable bytes turned over';
    return result;
  }

  /** The bound's assumptions, in one place, so the UI cannot restate them wrongly. */
  function granularityAssumptions() {
    return [
      'The sender’s container decomposes about the way this one does — they are two versions of one artifact.',
      'A byte changing inside a segment costs the span path that whole segment, which is what delta.js does.',
      'A semantic delta carries the full unit table and a span delta the full span table, which is their wire format.',
      'The inventory travels base64url through a QR symbol, so it costs ⌈4n/3⌉.',
      'Nothing at all about what changed: the fraction rewritten appears only in deriving the threshold, never in the decision.'
    ];
  }

  // --- Candidates ------------------------------------------------------------

  function candidateId(c) {
    return [c.transport, c.format, c.mode, c.chunkBytes, c.granularity, c.verification].join('/');
  }

  function candidateLabel(c) {
    var parts = [];
    parts.push(c.transport === 'peer' ? 'peer link' : 'optical ' + c.format);
    if (c.transport !== 'peer') parts.push(c.mode + ' @ ' + c.chunkBytes + ' B');
    parts.push(c.granularity === GRANULARITY_FULL ? 'whole artifact' : c.granularity + ' delta');
    if (c.verification === VERIFY_PARTIAL) parts.push('partial verify');
    return parts.join(', ');
  }

  function makeCandidate(spec) {
    var c = {
      transport: spec.transport,
      needsRadio: spec.transport === 'peer',
      format: spec.format,
      mode: spec.mode,
      chunkBytes: spec.chunkBytes,
      granularity: spec.granularity,
      verification: spec.verification
    };
    c.id = candidateId(c);
    c.label = candidateLabel(c);
    return c;
  }

  /**
   * The strategies worth considering in this situation.
   *
   * Bounded and enumerable on purpose: this is a small discrete space, so there
   * is no reason to search it approximately when it can be listed exactly. The
   * granularities offered are limited by what the receiver actually published —
   * planning a unit delta against a receiver that sent a span-only inventory
   * would be planning against a table nobody has.
   */
  function candidates(situation) {
    var s = normalizeSituation(situation);

    var granularities = [GRANULARITY_FULL];
    if (s.receiver.holds === GRANULARITY_SPAN || s.receiver.holds === GRANULARITY_UNIT) {
      granularities.push(GRANULARITY_SPAN);
    }
    if (s.receiver.holds === GRANULARITY_UNIT) granularities.push(GRANULARITY_UNIT);

    var verifications = [VERIFY_COMPLETE];
    if (s.policy.allowPartialVerification) verifications.push(VERIFY_PARTIAL);

    var out = [];
    var formats = [core.FORMAT_V1, core.FORMAT_V2];
    var modes = [core.MODE_INDEXED, core.MODE_FOUNTAIN];
    var chunks = [core.DEFAULT_CHUNK, core.MAX_CHUNK];

    for (var f = 0; f < formats.length; f++) {
      for (var m = 0; m < modes.length; m++) {
        for (var k = 0; k < chunks.length; k++) {
          for (var g = 0; g < granularities.length; g++) {
            for (var v = 0; v < verifications.length; v++) {
              out.push(makeCandidate({
                transport: 'optical',
                format: formats[f],
                mode: modes[m],
                chunkBytes: chunks[k],
                granularity: granularities[g],
                verification: verifications[v]
              }));
            }
          }
        }
      }
    }

    // The peer link is not QR-framed and does not chunk into symbols, so it
    // gets one candidate per granularity and verification rather than a grid.
    for (var pg = 0; pg < granularities.length; pg++) {
      for (var pv = 0; pv < verifications.length; pv++) {
        out.push(makeCandidate({
          transport: 'peer',
          format: 'raw',
          mode: core.MODE_INDEXED,
          chunkBytes: 0,
          granularity: granularities[pg],
          verification: verifications[pv]
        }));
      }
    }

    if (out.length > MAX_CANDIDATES) {
      fail('too-many-candidates', out.length + ' candidates exceeds the ' + MAX_CANDIDATES + ' ceiling');
    }
    return out;
  }

  // --- Cost model ------------------------------------------------------------

  /**
   * Bytes of artifact stream a candidate has to move, before framing.
   *
   * A delta's size is modelled from the receiver's declared overlap rather than
   * built, because this runs before anything is built — that is the whole point
   * of a planner. semdelta.chooseDelta() measures the real thing later and may
   * disagree; when it does, it is right and this was an estimate. What the
   * planner is choosing here is whether to go down the delta road at all.
   */
  function streamBytes(candidate, s) {
    if (candidate.granularity === GRANULARITY_FULL) return s.artifact.bytes;

    var changedFraction = 1 - s.receiver.overlap;
    var record = TABLE_RECORD_OVERHEAD + DEFAULT_HASH_BYTES;

    if (candidate.granularity === GRANULARITY_SPAN) {
      // A span delta resends whole segments, so a change anywhere in a segment
      // costs the segment. With `spanCount` even segments, a changed fraction
      // touches about that many of them — and never fewer than one.
      var spans = Math.max(1, s.receiver.spanCount);
      var touched = Math.min(spans, Math.max(1, Math.ceil(changedFraction * spans)));
      return (touched / spans) * s.artifact.bytes + spans * record;
    }

    var units = Math.max(1, s.receiver.unitCount);
    var touchedUnits = Math.min(units, Math.max(1, Math.ceil(changedFraction * units)));
    return (touchedUnits / units) * s.artifact.bytes + units * record;
  }

  /**
   * Payload bytes one symbol carries, framing and the chunk clamp both applied.
   * The symbol size is the link's constraint and the chunk is the sender's
   * choice, so the smaller of the two wins — which is why v1 at a 1,024-byte
   * chunk gets no more through a version 19-L symbol than its framing allows.
   */
  function payloadPerSymbol(candidate, s) {
    var fromSymbol = Math.floor(s.link.symbolBytes / (1 + ENVELOPE[candidate.format]));
    var cap = Math.min(candidate.chunkBytes || Infinity, MAX_PAYLOAD[candidate.format]);
    return Math.max(1, Math.min(fromSymbol, cap));
  }

  /**
   * Slots, seconds and wire bytes for one candidate.
   *
   * Kept separate from the scoring so the physical model can be read, tested
   * and disagreed with on its own terms, without any of the weights in view.
   */
  function transferModel(candidate, s) {
    var stream = streamBytes(candidate, s);
    var loss = s.link.lossRate;

    if (candidate.transport === 'peer') {
      // A radio link retransmits below this layer, so loss shows up as time
      // rather than as slots. One "slot" here is one second of link time,
      // which keeps the energy model below dimensionally consistent.
      var seconds = stream / (s.link.radioBytesPerSecond * Math.max(0.05, 1 - loss));
      return {
        stream: stream,
        payloadPerSymbol: 0,
        dataSymbols: 0,
        manifestSymbols: 0,
        slots: seconds,
        seconds: seconds,
        wireBytes: stream
      };
    }

    var per = payloadPerSymbol(candidate, s);
    var dataSymbols = Math.ceil(stream / per);

    var manifestSymbols;
    var slots;
    if (candidate.mode === core.MODE_FOUNTAIN) {
      // §5: the receiver reaches full rank and then waits for a manifest it
      // cannot name or verify the object without. clamp(K/2, 4, 32) matched the
      // measured optimum at both ends of the K range.
      var every = Math.min(MANIFEST_EVERY_MAX,
        Math.max(MANIFEST_EVERY_MIN, Math.ceil(dataSymbols * MANIFEST_EVERY_FRACTION)));
      var ideal = (dataSymbols * FOUNTAIN_RECEPTION_OVERHEAD) / Math.max(0.05, 1 - loss);
      manifestSymbols = Math.ceil(ideal / every);
      slots = Math.ceil(ideal + manifestSymbols);
    } else {
      manifestSymbols = 1;
      var total = dataSymbols + manifestSymbols;
      slots = Math.ceil((total / Math.max(0.05, 1 - loss)) * v1Inflation(loss));
    }

    return {
      stream: stream,
      payloadPerSymbol: per,
      dataSymbols: dataSymbols,
      manifestSymbols: manifestSymbols,
      slots: slots,
      seconds: slots / s.link.fps,
      wireBytes: slots * s.link.symbolBytes
    };
  }

  /**
   * Projected peak working memory, against the 128 MiB budget.
   *
   * Built as a sum of named terms rather than a single fudge factor, because
   * §9's finding was that the copy count is structural: the per-frame chunks
   * and the assembled output are alive at the same time, so the floor is two
   * copies before any framing cost is counted, and a plan that pretends
   * otherwise is planning against a budget it will miss.
   */
  function memoryModel(candidate, s) {
    var copies = LIVE_COPIES[s.device.role][candidate.format];
    var fountainExtra = candidate.mode === core.MODE_FOUNTAIN ? FOUNTAIN_LIVE_COPIES : 0;

    // Applying a delta materialises a new container while the base and the
    // payload are both still live.
    var deltaExtra = 0;
    if (candidate.granularity !== GRANULARITY_FULL && s.device.role === 'receiver') {
      deltaExtra = s.receiver.baseBytes + streamBytes(candidate, s);
    }

    var pipeline = s.artifact.bytes * (copies + fountainExtra) + deltaExtra;
    return {
      copies: copies,
      fountainExtra: fountainExtra,
      deltaExtraBytes: deltaExtra,
      pipelineBytes: pipeline,
      baselineBytes: s.device.baselineBytes,
      peakBytes: s.device.baselineBytes + pipeline
    };
  }

  /**
   * The hazards that make a transfer need doing again, and their union.
   *
   * Composed as 1 − ∏(1 − rᵢ), which keeps R inside [0,1] however many hazards
   * are added and however large each is. Treating them as independent is
   * generous — a link bad enough to close the contact window early is a link
   * that also makes a stale base more likely — so R understates correlated
   * trouble. Said plainly in describeLimits() rather than buried here.
   */
  function riskModel(candidate, s, model) {
    var hazards = [];

    if (isFinite(s.link.contactSeconds)) {
      if (model.seconds > s.link.contactSeconds) {
        hazards.push({
          name: 'contact-window',
          risk: clamp01(1 - s.link.contactSeconds / model.seconds),
          note: 'projected ' + model.seconds.toFixed(1) + ' s against a ' +
            s.link.contactSeconds + ' s window'
        });
      }
    }

    if (candidate.granularity !== GRANULARITY_FULL && s.receiver.baseConfidence < 1) {
      hazards.push({
        name: 'stale-base',
        risk: clamp01(1 - s.receiver.baseConfidence),
        note: 'a delta against a base the receiver may not hold arrives unappliable'
      });
    }

    if (candidate.format === core.FORMAT_V2 && !s.receiver.supportsV2) {
      hazards.push({
        name: 'unknown-framing',
        risk: UNKNOWN_FORMAT_RISK,
        note: 'the receiver has not said it can read v2 frames'
      });
    }

    if (candidate.verification === VERIFY_PARTIAL) {
      hazards.push({
        name: 'partial-verification',
        risk: PARTIAL_VERIFY_RISK,
        note: 'what was not verified may still be wrong'
      });
    }

    var survive = 1;
    for (var i = 0; i < hazards.length; i++) survive *= (1 - hazards[i].risk);
    return { hazards: hazards, risk: clamp01(1 - survive) };
  }

  /** Relative energy, in units of one optical indexed slot. See ENERGY_* above. */
  function energyModel(candidate, s, model) {
    var perSlot = candidate.transport === 'peer'
      ? ENERGY_SLOT_RADIO
      : ENERGY_SLOT_OPTICAL + (candidate.mode === core.MODE_FOUNTAIN ? ENERGY_SLOT_FOUNTAIN_EXTRA : 0);
    var verified = candidate.verification === VERIFY_COMPLETE ? s.artifact.bytes : s.artifact.bytes / 2;
    return model.slots * perSlot + verified * ENERGY_PER_VERIFIED_BYTE;
  }

  /**
   * J and its four terms for one candidate, against the reference strategy
   * evaluated in the same situation.
   *
   * Every ratio's numerator and denominator come from the same functions, so
   * the reference scores T = E = B = 1 exactly and J(reference) is
   * 0.85 + 0.15·R(reference). The test suite asserts that identity, because it
   * is the cheapest possible check that the basis has not drifted.
   */
  function costTerms(candidate, situation) {
    var s = situation && situation.__normalized ? situation : normalizeSituation(situation);

    var model = transferModel(candidate, s);
    var reference = transferModel(REFERENCE, s);

    var energy = energyModel(candidate, s, model);
    var referenceEnergy = energyModel(REFERENCE, s, reference);

    var risk = riskModel(candidate, s, model);

    var tRaw = reference.seconds > 0 ? model.seconds / reference.seconds : 1;
    var eRaw = referenceEnergy > 0 ? energy / referenceEnergy : 1;
    var bRaw = reference.wireBytes > 0 ? model.wireBytes / reference.wireBytes : 1;

    var T = clamp01(tRaw);
    var E = clamp01(eRaw);
    var B = clamp01(bRaw);
    var R = risk.risk;

    return {
      T: T, E: E, B: B, R: R,
      tRaw: tRaw, eRaw: eRaw, bRaw: bRaw,
      J: WEIGHT_TIME * T + WEIGHT_ENERGY * E + WEIGHT_BYTES * B + WEIGHT_RISK * R,
      model: model,
      reference: reference,
      energy: energy,
      referenceEnergy: referenceEnergy,
      hazards: risk.hazards
    };
  }

  // --- Hard rules ------------------------------------------------------------

  /**
   * The rules, as data. Each returns null to admit, or a sentence saying why
   * not. They run before anything is scored and they take no score as input,
   * so there is no number anywhere in this module that a rule can be traded
   * against.
   */
  var HARD_RULES = [
    {
      id: RULE_TRUST,
      label: 'the peer is verified and pinned to the key we expected',
      test: function (candidate, s) {
        if (!s.trust.verified) {
          return 'the peer is not verified, and an unverified peer is not a transfer partner at any score';
        }
        if (s.trust.pinnedKeyId !== null && s.trust.pinnedKeyId !== s.trust.presentedKeyId) {
          return 'the peer presented ' + describeKey(s.trust.presentedKeyId) + ' where ' +
            describeKey(s.trust.pinnedKeyId) + ' is pinned';
        }
        return null;
      }
    },
    {
      id: RULE_RADIO,
      label: 'the radio policy allows this transport',
      test: function (candidate, s) {
        if (s.policy.radio === RADIO_OFFLINE && candidate.needsRadio) {
          return 'policy is offline-only and this transport needs a radio';
        }
        return null;
      }
    },
    {
      id: RULE_MEMORY,
      label: 'projected peak working memory stays under the budget',
      test: function (candidate, s) {
        var memory = memoryModel(candidate, s);
        if (memory.peakBytes >= s.device.memoryBudgetBytes) {
          return 'projected peak ' + mib(memory.peakBytes) + ' against a ' +
            mib(s.device.memoryBudgetBytes) + ' budget';
        }
        return null;
      }
    },
    {
      id: RULE_VERIFICATION,
      label: 'a committing transfer verifies completely',
      test: function (candidate, s) {
        if (s.policy.commit && candidate.verification !== VERIFY_COMPLETE) {
          return 'this transfer commits its result, and a commit may not rest on a partial verification';
        }
        return null;
      }
    }
  ];

  function describeKey(id) {
    if (id === null || id === undefined) return 'no key';
    return String(id).slice(0, 16);
  }

  function mib(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }

  /**
   * Splits candidates into what may run and what may not.
   *
   * The asymmetry of the two outputs is the invariant, not an accident of
   * style. `admissible` holds candidate objects. `rejected` holds REPORT ROWS —
   * id, label, rule, reason — and no candidate object at all, so nothing
   * downstream has anything to score even if it tried. Rejections are
   * enumerated in full rather than short-circuited: a candidate that breaks
   * three rules should say so, because "and also" is how an operator learns
   * that fixing one thing will not be enough.
   */
  function admit(list, situation) {
    var s = situation && situation.__normalized ? situation : normalizeSituation(situation);
    var admissible = [];
    var rejected = [];

    for (var i = 0; i < (list || []).length; i++) {
      var candidate = list[i];
      var broken = [];
      for (var r = 0; r < HARD_RULES.length; r++) {
        var why = HARD_RULES[r].test(candidate, s);
        if (why) broken.push({ rule: HARD_RULES[r].id, label: HARD_RULES[r].label, reason: why });
      }
      if (broken.length === 0) {
        admissible.push(candidate);
      } else {
        rejected.push({
          id: candidate.id,
          label: candidate.label,
          rule: broken[0].rule,
          reason: broken[0].reason,
          broken: broken
        });
      }
    }

    return { admissible: admissible, rejected: rejected };
  }

  // --- The learned component -------------------------------------------------

  /**
   * The default adviser: 0.5 for everything.
   *
   * A constant preference adds a constant to every blended score, which leaves
   * the J ordering exactly intact. So an untrained system ranks by J alone and
   * the tests never depend on a model — which is the property that makes it
   * safe to ship the injection point before the model exists.
   */
  var NEUTRAL_ADVISER = {
    name: 'neutral',
    preference: function () { return 0.5; }
  };

  /**
   * Reads one preference, defensively. A non-finite or out-of-range answer is
   * clamped to neutral rather than propagated, because an adviser is foreign
   * code and NaN in a comparison is a silently arbitrary ordering.
   *
   * A throwing adviser is deliberately NOT caught. It cannot do harm — the
   * rules have already run and every candidate it can see is one that passed
   * them — so the safe failure is the loud one.
   */
  function adviceFor(adviser, candidate, s) {
    var raw = adviser.preference(candidate, s);
    if (!isFiniteNumber(raw)) return 0.5;
    return clamp01(raw);
  }

  /**
   * Ranks candidates that have ALREADY passed the hard rules.
   *
   * This function is handed nothing else. It has no access to the rejected
   * rows, no access to the original candidate list, and no reason to consult
   * the rules again — they are not its job and it could not undo them if it
   * tried. Everything it returns is derived from `admissible`, so the set it
   * can choose from is the set it was given.
   *
   * The blend is `(1 − w)·J + w·(1 − preference)`, both halves costs, both in
   * [0,1], w capped at MAX_ADVICE_WEIGHT. Ties break on J and then on id, so a
   * plan is a deterministic function of its situation.
   */
  function rank(admissible, situation, opts) {
    opts = opts || {};
    var s = situation && situation.__normalized ? situation : normalizeSituation(situation);
    var adviser = opts.adviser || NEUTRAL_ADVISER;
    if (typeof adviser.preference !== 'function') {
      fail('bad-adviser', 'an adviser must expose preference(candidate, situation)');
    }
    var weight = Math.min(MAX_ADVICE_WEIGHT, Math.max(0, num(opts.adviceWeight, DEFAULT_ADVICE_WEIGHT)));

    var scored = [];
    for (var i = 0; i < admissible.length; i++) {
      var candidate = admissible[i];
      var terms = costTerms(candidate, s);
      var preference = adviceFor(adviser, candidate, s);
      scored.push({
        candidate: candidate,
        id: candidate.id,
        label: candidate.label,
        terms: terms,
        J: terms.J,
        advice: preference,
        adviceWeight: weight,
        score: (1 - weight) * terms.J + weight * (1 - preference)
      });
    }

    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.J !== b.J) return a.J - b.J;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return scored;
  }

  // --- The plan --------------------------------------------------------------

  /**
   * The whole decision, from a situation to a strategy and its reasoning.
   *
   * Returns `chosen: null` when the rules leave nothing — which is the correct
   * outcome for an unverified peer or an offline policy with no offline route,
   * and is not an error. `rejected` is always populated, so a caller can always
   * say what happened rather than reporting a shrug.
   *
   * `chosen` and `inventory` are two decisions in two tenses and they may
   * legitimately disagree. `receiver.holds` is what the receiver ALREADY
   * published, and it bounds what the sender can do now: a unit delta needs a
   * unit table that has already crossed the wire. `inventory` is what that
   * receiver should publish NEXT time, and a receiver that published units once
   * and is told here not to do it again is the defect being corrected, not a
   * contradiction.
   */
  function plan(situation, opts) {
    opts = opts || {};
    var s = normalizeSituation(situation);
    s.__normalized = true;

    var all = candidates(s);
    var gate = admit(all, s);
    var scored = rank(gate.admissible, s, opts);
    var best = scored.length ? scored[0] : null;

    var granularity = chooseInventoryGranularity({
      containerBytes: s.receiver.baseBytes,
      decomposableBytes: s.receiver.decomposableBytes,
      spanCount: s.receiver.spanCount,
      unitCount: s.receiver.unitCount,
      hashBytes: s.receiver.hashBytes
    }, { rewriteTolerance: s.policy.rewriteTolerance });

    return {
      chosen: best ? best.candidate : null,
      score: best ? best.score : null,
      J: best ? best.J : null,
      terms: best ? best.terms : null,
      reason: best ? explain(best, scored) : explainNothing(gate.rejected),
      ranked: scored,
      admissible: gate.admissible,
      rejected: gate.rejected,
      inventory: granularity,
      adviser: (opts.adviser || NEUTRAL_ADVISER).name || 'anonymous',
      adviceWeight: scored.length ? scored[0].adviceWeight : 0,
      candidateCount: all.length
    };
  }

  function explain(best, scored) {
    var t = best.terms;
    var head = best.label + ': J = ' + t.J.toFixed(3) + ' (T ' + t.T.toFixed(2) +
      ', E ' + t.E.toFixed(2) + ', B ' + t.B.toFixed(2) + ', R ' + t.R.toFixed(2) + ')';
    if (scored.length < 2) return head + ', the only strategy the rules allowed';
    var runnerUp = scored[1];
    return head + ', ahead of ' + runnerUp.label + ' at ' + runnerUp.J.toFixed(3) +
      '; ' + scored.length + ' strategies passed the rules';
  }

  function explainNothing(rejected) {
    if (!rejected.length) return 'no strategy was even considered';
    var byRule = {};
    for (var i = 0; i < rejected.length; i++) {
      byRule[rejected[i].rule] = (byRule[rejected[i].rule] || 0) + 1;
    }
    var parts = [];
    for (var rule in byRule) {
      if (Object.prototype.hasOwnProperty.call(byRule, rule)) {
        parts.push(byRule[rule] + ' on ' + rule);
      }
    }
    return 'no strategy passed the hard rules — ' + parts.join(', ') +
      '; first: ' + rejected[0].reason;
  }

  // --- Honesty ---------------------------------------------------------------

  /**
   * The normalisation basis of each term, as text, so a reviewer can read it
   * out of a running system and not only out of this file.
   */
  function describeNormalisation() {
    return [
      {
        term: 'T', weight: WEIGHT_TIME, kind: 'ratio',
        basis: 'seconds ÷ seconds of the reference strategy (' + REFERENCE.label +
          ') in the same situation, clamped to [0,1]',
        source: 'MEASURED: fountain reception overhead ' + FOUNTAIN_RECEPTION_OVERHEAD +
          ' (§4, 2,200 decodes); v1 indexed slot inflation 1.00× to 3.90× over 0–60% loss (§10, §3)'
      },
      {
        term: 'E', weight: WEIGHT_ENERGY, kind: 'ratio',
        basis: 'relative energy ÷ the reference strategy’s relative energy, clamped to [0,1]',
        source: 'MODELLED: no power measurement exists in this repository (§17). ' +
          'Slots held with the optics live, per-slot decode work, radio time, and a per-byte verification charge.'
      },
      {
        term: 'B', weight: WEIGHT_BYTES, kind: 'ratio',
        basis: 'wire bytes ÷ the reference strategy’s wire bytes, clamped to [0,1]; ' +
          'the unclamped ratio is reported as bRaw because §7 measured deltas larger than the file they replace',
        source: 'MEASURED: envelope 44.0% v1 and 19.1% v2 armoured at version 19-L (§1)'
      },
      {
        term: 'R', weight: WEIGHT_RISK, kind: 'probability',
        basis: 'already a probability — nothing to normalise. 1 − ∏(1 − rᵢ) over the hazards, so it stays in [0,1]',
        source: 'MODELLED: hazard magnitudes are named constants, not measurements'
      }
    ];
  }

  /**
   * What this planner is not entitled to claim. Kept here so the copy in the
   * UI cannot drift away from what the code actually does.
   */
  function describeLimits() {
    return [
      'A plan is a projection, not a measurement. semdelta.chooseDelta() builds both payloads and measures them; this decides whether to go down that road at all, from sizes, before anything is built.',
      'The energy term is modelled in arbitrary units and calibrated against nothing — there is no power measurement anywhere in this repository.',
      'Risk treats its hazards as independent, which is generous: a link bad enough to close the contact window is also a link that makes a stale base more likely, so R understates correlated trouble.',
      'The delta size model reads the receiver’s declared overlap. A receiver that declares it wrongly gets a plan built on a wrong number, and no hard rule catches that.',
      'The inventory granularity threshold is calibrated on the seven scenarios in docs/benchmarks.md §7, which is not many; any tolerance in (0.517, 0.774] gives the same verdict on all seven.',
      'The hard rules bound what may run, not what will work. Passing them means a strategy is permitted, never that it will succeed.'
    ];
  }

  return {
    // objective
    WEIGHT_TIME: WEIGHT_TIME,
    WEIGHT_ENERGY: WEIGHT_ENERGY,
    WEIGHT_BYTES: WEIGHT_BYTES,
    WEIGHT_RISK: WEIGHT_RISK,
    WEIGHT_SUM: WEIGHT_SUM,
    REFERENCE: REFERENCE,

    // rules
    RULE_TRUST: RULE_TRUST,
    RULE_MEMORY: RULE_MEMORY,
    RULE_RADIO: RULE_RADIO,
    RULE_VERIFICATION: RULE_VERIFICATION,
    HARD_RULES: HARD_RULES,
    MEMORY_BUDGET_BYTES: MEMORY_BUDGET_BYTES,
    RADIO_ANY: RADIO_ANY,
    RADIO_OFFLINE: RADIO_OFFLINE,
    VERIFY_COMPLETE: VERIFY_COMPLETE,
    VERIFY_PARTIAL: VERIFY_PARTIAL,

    // granularity
    GRANULARITY_FULL: GRANULARITY_FULL,
    GRANULARITY_SPAN: GRANULARITY_SPAN,
    GRANULARITY_UNIT: GRANULARITY_UNIT,
    DEFAULT_REWRITE_TOLERANCE: DEFAULT_REWRITE_TOLERANCE,
    chooseInventoryGranularity: chooseInventoryGranularity,

    // measured and modelled inputs
    ENVELOPE: ENVELOPE,
    V1_LOSS_INFLATION: V1_LOSS_INFLATION,
    FOUNTAIN_RECEPTION_OVERHEAD: FOUNTAIN_RECEPTION_OVERHEAD,
    LIVE_COPIES: LIVE_COPIES,
    MAX_ADVICE_WEIGHT: MAX_ADVICE_WEIGHT,
    DEFAULT_ADVICE_WEIGHT: DEFAULT_ADVICE_WEIGHT,

    PlannerError: PlannerError,

    // the pipeline, in the order it runs
    normalizeSituation: normalizeSituation,
    candidates: candidates,
    admit: admit,
    costTerms: costTerms,
    transferModel: transferModel,
    memoryModel: memoryModel,
    rank: rank,
    plan: plan,

    // the learned component
    NEUTRAL_ADVISER: NEUTRAL_ADVISER,

    describeNormalisation: describeNormalisation,
    describeLimits: describeLimits
  };
});
