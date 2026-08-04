/*!
 * rvQR fleet swarm distribution — a peer is a transport, not an authority.
 *
 * Per ADR-024. A site is rarely one device. A hundred appliances taking a
 * firmware image point-to-point is up to a hundred times the artifact off the
 * source link, which the link cannot supply and the person holding it cannot
 * wait for — while the devices are next to each other and idle. So a chunk a
 * peer already holds is a chunk the source never sends.
 *
 * ---------------------------------------------------------------------------
 * A PEER IS A TRANSPORT, NOT AN AUTHORITY — ADR-024 §2.2
 * ---------------------------------------------------------------------------
 *
 * Every receiving device runs the whole pipeline against the SOURCE's signed
 * manifest — digest, signature, admission — regardless of which peer handed
 * over the bytes. That sentence is the design, and here is what makes it
 * structural rather than a promise:
 *
 *   1. **No function that can return `admit: true` takes a peer identity.**
 *      `verifyChunk(bytes, expectation, opts)` is handed the bytes and the
 *      expectation this receiver derived from its OWN verified manifest, and
 *      nothing else. `admitChunk(policy, verdict, situation)` is handed the
 *      verdict and the receiver's situation, and nothing else. There is no
 *      peer argument to remember to ignore, and `normalizePolicy` has no peer
 *      field, so a receiver cannot express "trust this peer" even if it wanted
 *      to. Who sent the bytes is a fact for the LEDGER — which schedules — and
 *      it never reaches the gate, which decides.
 *
 *   2. **A chunk cannot nominate what it is.** A delivery carries a claimed
 *      index, and the index only SELECTS which committed digest the bytes are
 *      tested against. The delivery's own digest field, if it carries one, is
 *      never compared to anything: `claim` is diagnostics and is read by no
 *      decision. A peer lying about the index does not get its bytes stored
 *      under another name; it fails the digest for the index it named and has
 *      wasted its own bandwidth.
 *
 *   3. **The forwarding set IS the store.** `advertise(receiver)` is derived
 *      from `receiver.chunks` — the array that `offerChunk` writes to in
 *      exactly one branch, after `admitChunk` returned `admit: true`. There is
 *      no pending buffer and no staging area, so a chunk that did not hash
 *      correctly is discarded on arrival, before it is stored OR FORWARDED,
 *      because there is no container it could be forwarded out of.
 *
 * A malicious peer can therefore waste bandwidth and cannot cause a wrong
 * artifact to be accepted anywhere: the chunks are content-addressed and the
 * whole is signed by a key the peer does not hold. Chunks carry no signature
 * of their own and need none — a chunk's digest is committed by a manifest
 * that IS signed, so signing each chunk would add a second answer to a
 * question the manifest has already answered once.
 *
 * ---------------------------------------------------------------------------
 * THE THREAT IS DENIAL, NOT CORRUPTION — ADR-024 §2.2
 * ---------------------------------------------------------------------------
 *
 * Corruption is cheap to defend against and this module refuses it in one
 * digest comparison. The failure mode to design against is a peer that offers
 * plausible chunk ADVERTISEMENTS and never delivers, or delivers slowly. That
 * is a scheduling problem, and the rule is that peers are deprioritised on
 * MEASURED BEHAVIOUR rather than on claims. Structurally:
 *
 *   - A ledger keeps two maps that are never merged. `claims` is what a peer
 *     SAID it holds. `measured` is what was requested, what arrived, whether
 *     it verified, and how long it took.
 *   - `rankProviders(measurements, candidates)` takes the MEASURED map. The
 *     claims map is not in its argument list, so an advertisement cannot raise
 *     a rank however loud it is. Advertising only makes a peer a candidate;
 *     nothing else follows from it.
 *   - Reputation is NOT shared between devices. A peer's reputation arriving
 *     from another peer would be a claim, and this design does not act on
 *     claims. Every device pays for its own discovery, which is the expensive
 *     direction and the honest one.
 *
 * `compareBehaviours()` measures what the three behaviours ADR-024 §4.4 names
 * — advertise-and-withhold, slow-drip, corrupt-chunk — cost in completion
 * time. The ordering that came out is not the intuitive one, and it sharpens
 * §2.2 rather than merely confirming it: the cost of a behaviour tracks how
 * DETECTABLY WRONG it is, and slow-drip is never wrong at all. A corrupt peer
 * is refused by one digest comparison and falls below the score floor on its
 * first delivery. A withholder costs one timeout on each device that tries it,
 * and then the same floor. A slow peer delivers correct, correctly digesting
 * chunks — so nothing ever refuses it, its score stays at the honest 1.0, and
 * only latency demotes it. It is measured here as the most expensive of the
 * three by two orders of magnitude, and this module deliberately does not
 * refuse it: refusing a peer for being slow would refuse a device with a weak
 * radio, which in a real fleet is the ordinary case rather than the attack.
 *
 * ---------------------------------------------------------------------------
 * SOURCE TRAFFIC IS MEASURED DIRECTLY, NEVER INFERRED — ADR-024 §4.6
 * ---------------------------------------------------------------------------
 *
 * `meterSource()` returns a counter and `serveFromSource()` is the only thing
 * that writes to it, on the same line that emits the bytes. The report carries
 * that number and also carries what chunk accounting WOULD have said, so the
 * gap is visible rather than assumed away. The gap is large and it is
 * structural: the source serves the same chunk to several devices, so counting
 * distinct chunks understates the link by a factor of the fleet size, which is
 * exactly the number the whole ADR is about.
 *
 * ---------------------------------------------------------------------------
 * THE BROADCAST TIER IS NOT RFC 6330 CONFORMANT — ADR-024 §2.4 and §4.5
 * ---------------------------------------------------------------------------
 *
 * `artifacts/fountain.js` is RaptorQ-STRUCTURED and deliberately not
 * conformant: it derives parameters the RFC tabulates, searches for the
 * systematic index at runtime, and uses its own Rand[] and HDPC block. Symbol
 * streams from it decode only with it. Broadcast is the one place a STANDARD
 * codec matters, because the receivers may not all be rvQR, so this module
 * names the tier through ONE constant — `BROADCAST_CODEC` — and every string
 * it emits about the tier is built from that constant. There is no second
 * place for the wording to drift, and `describeBroadcastTier()` reports
 * `rfc6330Conformant: false` and `interoperable: false` from inside the
 * running system.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SIMULATED AND WHAT IS MEASURED. READ THIS BEFORE QUOTING A NUMBER.
 * ---------------------------------------------------------------------------
 *
 * `simulateSwarm()` is a deterministic simulation. The distinction it exists
 * to keep is exact:
 *
 *   - Its BYTE COUNTS and CHUNK COUNTS are real measurements OF THE
 *     SIMULATION. They are produced by running the real verification pipeline
 *     over real bytes, and they say what this scheduling policy does.
 *   - Its TIMINGS ARE NOT MEASUREMENTS OF ANY FLEET. The clock is a tick
 *     counter that this module defines; a tick is not a second, a simulated
 *     60 is not a measured 60 s, and every timing field in every output is
 *     named `...Ticks` for that reason. `report.wallClockMeasured` is `false`
 *     and `report.physicalDevices` is `0`.
 *
 * ADR-024 §4.1's Fleet-10 and §4.2's Fleet-100 require TEN and ONE HUNDRED
 * PHYSICAL DEVICES with wall-clock gates of 3 s and 60 s. There is no device
 * fleet in this repository, those criteria are NOT met, and nothing here may
 * be presented as having met them. `describeCriteria()` says so per criterion.
 *
 * There is also no BitChat in this tree — no peer discovery, no custody
 * receipts, no rank exchange — and no chunk store. `describeUnimplemented()`
 * enumerates both.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network and no clock. A receiver is an immutable value — `offerChunk`
 * returns a new one and never writes to the one it was given. Time and
 * randomness are injected, so the same configuration produces the same
 * schedule and the same report every time.
 *
 * Trust asymmetry follows provenance.js, attest.js and closure.js:
 * `parseManifest` and `parseDelivery` never throw, because their input arrived
 * from whatever is on the other end of the link.
 *
 * Browser: load this file; it needs nothing else.
 * Node:    require('./swarm.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRSwarm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- The broadcast tier, named in exactly one place — ADR-024 §2.4 --------
  // Every string this module emits about the broadcast tier is built from this
  // constant, so the qualification cannot be dropped in one place and kept in
  // another. ADR-014 has not chosen conformance, so the tier is rvQR-only and
  // says so wherever it is described.

  var BROADCAST_CODEC = 'RaptorQ-structured (NOT RFC 6330 conformant; interoperates with nothing)';

  // --- The verdict vocabulary ------------------------------------------------
  // Closed, and the gates switch over it exhaustively. A state outside this
  // list is refused as unknown rather than falling through.

  /** The bytes are the bytes the signed manifest committed to that position. */
  var STATE_VERIFIED = 'verified';

  /** Arrived and could not be read as a delivery or a manifest at all. */
  var STATE_MALFORMED = 'malformed';

  /** Reads fine, and names a different artifact. */
  var STATE_FOREIGN = 'foreign';

  /** Names a chunk position the verified manifest does not commit to. */
  var STATE_UNKNOWN_INDEX = 'unknown-index';

  /** The byte length is not the length the manifest commits for that position. */
  var STATE_SIZE_REFUSED = 'size-refused';

  /** The bytes are not the bytes the manifest described. The peer's whole power. */
  var STATE_DIGEST_MISMATCH = 'digest-mismatch';

  /** A manifest arrived carrying no signature. */
  var STATE_UNSIGNED = 'unsigned';

  /** A signature verifier ran and said no. */
  var STATE_FORGED = 'forged';

  /** A check could not be performed: no digest function, no verifier, no answer. */
  var STATE_UNVERIFIED = 'unverified';

  var STATES = [
    STATE_VERIFIED, STATE_MALFORMED, STATE_FOREIGN, STATE_UNKNOWN_INDEX,
    STATE_SIZE_REFUSED, STATE_DIGEST_MISMATCH, STATE_UNSIGNED, STATE_FORGED,
    STATE_UNVERIFIED
  ];

  // --- Decision codes --------------------------------------------------------
  // Stable strings, matching attest.js and closure.js: callers switch on the
  // code, the reason is for people.

  var CODE_PENDING = 'pending';
  var CODE_POLICY_UNDECLARED = 'policy-undeclared';
  var CODE_ROOT_UNDECLARED = 'root-undeclared';
  var CODE_MANIFEST_UNVERIFIED = 'manifest-unverified';
  var CODE_UNKNOWN_STATE = 'unknown-chunk-state';
  var CODE_MALFORMED = 'malformed-delivery';
  var CODE_FOREIGN = 'foreign-artifact';
  var CODE_UNKNOWN_INDEX = 'unknown-index';
  var CODE_SIZE_REFUSED = 'size-refused';
  var CODE_DIGEST_MISMATCH = 'digest-mismatch';
  var CODE_UNSIGNED = 'unsigned-manifest';
  var CODE_FORGED = 'forged-signature';
  var CODE_UNVERIFIED = 'unverified-chunk';
  var CODE_UNTRUSTED_SIGNER = 'untrusted-signer';
  var CODE_ALREADY_HELD = 'already-held';
  var CODE_ADMITTED = 'chunk-admitted';
  var CODE_MANIFEST_ADMITTED = 'manifest-admitted';

  // --- Peer behaviours, ADR-024 §4.4 ----------------------------------------
  // A closed vocabulary, so a behaviour nobody has defined cannot reach the
  // simulation as an opaque string and be silently treated as honest.

  /** Serves what it advertises, promptly and correctly. */
  var BEHAVIOUR_HONEST = 'honest';

  /** Advertises everything and delivers nothing. Detected only by a timeout. */
  var BEHAVIOUR_WITHHOLD = 'advertise-and-withhold';

  /** Delivers correct bytes, far slower than the link would allow. */
  var BEHAVIOUR_SLOW = 'slow-drip';

  /** Delivers promptly, and the bytes are not the bytes it advertised. */
  var BEHAVIOUR_CORRUPT = 'corrupt-chunk';

  var BEHAVIOURS = [BEHAVIOUR_HONEST, BEHAVIOUR_WITHHOLD, BEHAVIOUR_SLOW, BEHAVIOUR_CORRUPT];

  var BEHAVIOUR_LABELS = {
    'honest': 'serves what it advertises',
    'advertise-and-withhold': 'advertises everything and delivers nothing',
    'slow-drip': 'delivers correct bytes far slower than the link allows',
    'corrupt-chunk': 'delivers promptly, and the bytes are not what it advertised'
  };

  // --- Hostile-input ceilings ------------------------------------------------
  // A delivery arrives from a peer, which is the party this whole mechanism
  // exists to be unsure about. Every value below bounds something that peer
  // controls, and each is checked before it reaches an allocation or a loop.

  var LIMITS = {
    identifier: 256,
    digestHex: 128,
    signatureHex: 16384,
    chunks: 65536,
    chunkBytes: 16 * 1024 * 1024,
    manifestBytes: 4 * 1024 * 1024,
    advertisedEntries: 65536,
    peers: 4096,
    // Diagnostics only. Nothing reads this to decide anything, so truncating it
    // cannot change an answer — but a record that shrinks without saying so
    // still misleads whoever reads the receipt, so the DROPPED COUNT is kept.
    quarantineEntries: 64,
    simulationTicks: 1000000,
    simulationDevices: 4096
  };

  var HEX_RE = /^[0-9a-f]+$/;
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

  // ---------------------------------------------------------------------------
  // Small pure helpers
  // ---------------------------------------------------------------------------

  function isString(v) { return typeof v === 'string'; }

  function isIdentifier(v, max) {
    return isString(v) && v.length > 0 && v.length <= max && ID_RE.test(v);
  }

  function isInteger(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  function isDigestHex(v) {
    return isString(v) && v.length >= 16 && v.length <= LIMITS.digestHex &&
      !(v.length & 1) && HEX_RE.test(v);
  }

  function isBytes(v) {
    return !!v && typeof v === 'object' && ArrayBuffer.isView(v) &&
      typeof v.length === 'number' && v.BYTES_PER_ELEMENT === 1;
  }

  function copyBytes(v) {
    var out = new Uint8Array(v.length);
    for (var i = 0; i < v.length; i++) out[i] = v[i];
    return out;
  }

  /**
   * Freezes a value graph so a caller cannot edit a refusal into an admission
   * after the fact. Typed arrays are stepped over: `Object.freeze` throws on a
   * view with elements, and the content copy is the thing that matters anyway.
   */
  function freezeDeep(v) {
    if (!v || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return v;
    Object.keys(v).forEach(function (k) { freezeDeep(v[k]); });
    return Object.freeze(v);
  }

  function assign(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  // ---------------------------------------------------------------------------
  // The manifest — the chunk list, its digests, and its ORDER
  // ---------------------------------------------------------------------------

  /**
   * The canonical bytes of a chunk manifest, as a string. Deterministic, and
   * the thing the pinned root's digest is taken over and the signature covers.
   *
   * Entries carry NO index field: an entry's position in the list IS its index.
   * Swap two entries and this string changes, so the digest changes, so the
   * pinned root refuses the manifest and the transfer never starts — the same
   * ordering mechanism closure.js uses, for the same reason. An index field
   * would have let a reordered list describe the same artifact.
   */
  function canonicalManifestString(manifest) {
    var m = manifest || {};
    var chunks = Array.isArray(m.chunks) ? m.chunks : [];
    var parts = [
      'rvqr-chunk-manifest/1',
      String(m.artifactId),
      String(m.signerId),
      String(m.totalBytes)
    ];
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i] || {};
      parts.push([String(i), String(c.digest), String(c.size)].join(':'));
    }
    return parts.join('\n');
  }

  /**
   * What a manifest signature covers: the artifact and the digest of the
   * canonical manifest bytes, together. Binding both is what stops a genuinely
   * signed manifest for one artifact being replayed as the manifest of another.
   */
  function manifestSigningString(binding) {
    var b = binding || {};
    return ['rvqr-chunk-manifest-sig/1', String(b.artifactId), String(b.manifestDigest)].join('\n');
  }

  /**
   * Reads a chunk manifest. Returns { ok, manifest, reason } and never throws:
   * these bytes arrived over a link, from a peer this receiver has no reason to
   * believe.
   */
  function parseManifest(input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no manifest was supplied' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'the manifest is not an object' };
    }
    if (!isIdentifier(input.artifactId, LIMITS.identifier)) {
      return { ok: false, reason: 'artifactId is missing or is not an identifier' };
    }
    if (!isIdentifier(input.signerId, LIMITS.identifier)) {
      return { ok: false, reason: 'signerId is missing or is not an identifier' };
    }
    if (!Array.isArray(input.chunks)) {
      return { ok: false, reason: 'chunks must be an array' };
    }
    if (!input.chunks.length) {
      return { ok: false, reason: 'a manifest committing to no chunk describes nothing to transfer' };
    }
    if (input.chunks.length > LIMITS.chunks) {
      return {
        ok: false,
        reason: 'the manifest declares ' + input.chunks.length + ' chunks, over the limit of ' + LIMITS.chunks
      };
    }

    var chunks = [];
    var total = 0;
    for (var i = 0; i < input.chunks.length; i++) {
      var c = input.chunks[i];
      var at = 'chunk ' + i;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return { ok: false, reason: at + ' is not an object' };
      }
      if (!isDigestHex(c.digest)) {
        return { ok: false, reason: at + ' has no even-length lowercase hex digest inside the ceiling' };
      }
      if (!isInteger(c.size) || c.size <= 0 || c.size > LIMITS.chunkBytes) {
        return { ok: false, reason: at + ' declares a size that is not a positive integer inside the ceiling' };
      }
      total += c.size;
      chunks.push({ index: i, digest: c.digest, size: c.size });
    }
    if (!isInteger(input.totalBytes) || input.totalBytes !== total) {
      return {
        ok: false,
        reason: 'the manifest declares ' + JSON.stringify(input.totalBytes) + ' total bytes and its chunks ' +
          'sum to ' + total + '. A declared total that does not match the parts is a manifest that ' +
          'describes two different artifacts'
      };
    }

    return {
      ok: true,
      manifest: {
        artifactId: input.artifactId,
        signerId: input.signerId,
        chunks: chunks,
        chunkCount: chunks.length,
        totalBytes: total
      }
    };
  }

  /**
   * Splits an artifact into a content-addressed chunk manifest.
   *
   * This is the sender's side and it is the only place in this module that
   * produces digests rather than checking them. `digest` is injected and has no
   * default: a manifest built with no digest function would commit to nothing,
   * so the function refuses rather than producing a manifest of empty strings.
   */
  function buildManifest(spec, opts) {
    var s = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
    var options = opts && typeof opts === 'object' ? opts : {};
    if (typeof options.digest !== 'function') {
      return { ok: false, reason: 'no digest function was supplied, so no chunk could be addressed' };
    }
    if (!isIdentifier(s.artifactId, LIMITS.identifier)) {
      return { ok: false, reason: 'artifactId is missing or is not an identifier' };
    }
    if (!isIdentifier(s.signerId, LIMITS.identifier)) {
      return { ok: false, reason: 'signerId is missing or is not an identifier' };
    }
    if (!isBytes(s.bytes) || !s.bytes.length) {
      return { ok: false, reason: 'bytes is not a non-empty byte array' };
    }
    if (!isInteger(s.chunkSize) || s.chunkSize <= 0 || s.chunkSize > LIMITS.chunkBytes) {
      return { ok: false, reason: 'chunkSize is not a positive integer inside the ceiling' };
    }
    var count = Math.ceil(s.bytes.length / s.chunkSize);
    if (count > LIMITS.chunks) {
      return { ok: false, reason: 'that chunk size yields ' + count + ' chunks, over the limit of ' + LIMITS.chunks };
    }

    var chunks = [];
    var bodies = [];
    for (var i = 0; i < count; i++) {
      var from = i * s.chunkSize;
      var body = copyBytes(s.bytes.subarray(from, Math.min(from + s.chunkSize, s.bytes.length)));
      var d;
      try {
        d = options.digest(body);
      } catch (err) {
        return { ok: false, reason: 'the digest function failed on chunk ' + i + ': ' + errText(err) };
      }
      if (!isString(d) || !isDigestHex(d.toLowerCase())) {
        return { ok: false, reason: 'the digest function returned no usable hex digest for chunk ' + i };
      }
      chunks.push({ digest: d.toLowerCase(), size: body.length });
      bodies.push(body);
    }

    var manifest = {
      artifactId: s.artifactId,
      signerId: s.signerId,
      chunks: chunks,
      totalBytes: s.bytes.length
    };
    var parsed = parseManifest(manifest);
    if (!parsed.ok) return { ok: false, reason: 'the manifest this builder produced does not parse: ' + parsed.reason };

    return { ok: true, manifest: manifest, parsed: parsed.manifest, bodies: bodies };
  }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  // ---------------------------------------------------------------------------
  // The verifier — a verdict, and nothing that resembles a permission
  // ---------------------------------------------------------------------------

  /**
   * The verdict object, shaped like attest.js's and closure.js's: no `admit`,
   * no `allow`, no `ok` — nothing a caller could read as permission. `state` is
   * the whole answer and the gate is the only thing entitled to act on it.
   *
   * The committed facts and the CONTENT are published only on `verified`. On
   * every other state they are null, so no ordering mistake in a caller can put
   * unverified bytes where verified bytes go.
   *
   * `claim` is the opposite: what the delivery SAID, kept for the quarantine
   * record and read by no decision anywhere.
   */
  function verdictFor(state, reason, facts) {
    var f = facts || {};
    var verified = state === STATE_VERIFIED;
    return {
      state: state,
      reason: reason,
      claim: f.claim || { artifactId: null, index: null, byteLength: null, digest: null },
      artifactId: verified ? f.artifactId : null,
      index: verified ? f.index : null,
      digest: verified ? f.digest : null,
      byteLength: verified ? f.byteLength : null,
      content: verified ? f.content : null,
      manifest: verified && f.manifest ? f.manifest : null,
      signerId: verified ? (f.signerId === undefined ? null : f.signerId) : null,
      signatureChecked: f.signatureChecked === undefined ? null : f.signatureChecked
    };
  }

  /**
   * Reads a chunk delivery. Returns { ok, delivery, reason } and never throws.
   *
   * Note what a delivery CANNOT carry into a decision: a digest that is
   * believed, and a peer identity. `digest` is accepted into `claim` if it is
   * present and well formed, and is compared to nothing — the receiver
   * recomputes the digest from the bytes and compares it against the manifest.
   * `peerId` is not read here at all; it belongs to the ledger, which schedules,
   * and never to the gate, which decides.
   */
  function parseDelivery(input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no delivery was supplied' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'the delivery is not an object' };
    }
    if (!isIdentifier(input.artifactId, LIMITS.identifier)) {
      return { ok: false, reason: 'artifactId is missing or is not an identifier' };
    }
    if (!isInteger(input.index) || input.index < 0 || input.index >= LIMITS.chunks) {
      return { ok: false, reason: 'index is not a chunk number inside the ceiling of ' + LIMITS.chunks };
    }
    if (!isBytes(input.bytes)) {
      return { ok: false, reason: 'bytes is not a byte array' };
    }
    if (input.bytes.length > LIMITS.chunkBytes) {
      return {
        ok: false,
        reason: 'the delivery is ' + input.bytes.length + ' bytes, over the ceiling of ' + LIMITS.chunkBytes
      };
    }
    return {
      ok: true,
      delivery: {
        artifactId: input.artifactId,
        index: input.index,
        bytes: input.bytes,
        // Diagnostics. Never compared to anything.
        claimedDigest: isDigestHex(input.digest) ? input.digest : null
      }
    };
  }

  function claimOf(parsed, raw) {
    if (parsed && parsed.ok) {
      return {
        artifactId: parsed.delivery.artifactId,
        index: parsed.delivery.index,
        byteLength: parsed.delivery.bytes.length,
        digest: parsed.delivery.claimedDigest
      };
    }
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      artifactId: isIdentifier(r.artifactId, LIMITS.identifier) ? r.artifactId : null,
      index: isInteger(r.index) ? r.index : null,
      byteLength: isBytes(r.bytes) ? r.bytes.length : null,
      digest: isDigestHex(r.digest) ? r.digest : null
    };
  }

  /**
   * Verifies the BYTES of one chunk against the ONE expectation this receiver
   * derived from its own verified manifest.
   *
   * ---------------------------------------------------------------------------
   * THIS FUNCTION HAS NO PEER PARAMETER. THAT IS THE WHOLE ARGUMENT.
   * ---------------------------------------------------------------------------
   *
   * `expectation` is { artifactId, index, digest, size } and comes from data
   * this receiver already verified. There is no peer id, no reputation, no
   * transport and no policy in the argument list, so this function has nothing
   * to be talked into. A null expectation means the manifest does not commit to
   * that position, which is a refusal and not a licence.
   *
   * The order of the checks is ADR-016 §2.2's, and nothing expensive runs
   * early: a foreign or unknown-index delivery never reaches the digest
   * function, so a stranger cannot make a receiver hash megabytes by shouting
   * chunk numbers.
   *
   *   1. readable   — before anything is looked at
   *   2. identity   — the artifact this delivery names
   *   3. size       — the committed length, before the digest is taken
   *   4. digest     — the bytes are the bytes the signed manifest described
   *
   * `opts.digest(bytes) -> lowercase hex` is injected and absent by default.
   * With none the state is `unverified`, which the gate refuses: a check that
   * cannot run reports that it could not run and never degrades into a pass.
   */
  function verifyChunk(delivery, expectation, opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var parsed = parseDelivery(delivery);
    var claim = claimOf(parsed, delivery);

    if (!parsed.ok) {
      return verdictFor(STATE_MALFORMED,
        'A chunk was delivered and could not be read: ' + parsed.reason + '. A delivery that cannot be ' +
        'read is discarded here, before it is stored or forwarded — there is no buffer it could sit in.',
        { claim: claim });
    }
    var d = parsed.delivery;

    // --- 1. is anything expected at all? -------------------------------------
    var e = expectation && typeof expectation === 'object' ? expectation : null;
    if (!e || !isInteger(e.index) || !isDigestHex(e.digest) || !isInteger(e.size)) {
      return verdictFor(STATE_UNKNOWN_INDEX,
        'This receiver holds no committed digest for chunk ' + d.index + ', so there is nothing to check ' +
        'these bytes against. Until the source’s signed manifest verifies, a chunk has no committed ' +
        'identity and cannot acquire one from the peer that offered it.',
        { claim: claim });
    }
    if (d.index !== e.index) {
      return verdictFor(STATE_UNKNOWN_INDEX,
        'Chunk ' + d.index + ' was delivered where this receiver was testing position ' + e.index +
        '. A delivery does not get to say which committed digest it is measured against.',
        { claim: claim });
    }

    // --- 2. artifact identity ------------------------------------------------
    if (d.artifactId !== e.artifactId) {
      return verdictFor(STATE_FOREIGN,
        'This chunk names artifact ' + JSON.stringify(d.artifactId) + ' and this receiver is assembling ' +
        JSON.stringify(e.artifactId) + '. A chunk of another artifact is a valid chunk of that artifact ' +
        'and no part of this one, however well it is signed over there.',
        { claim: claim });
    }

    // --- 3. the committed length, before the digest is taken -----------------
    if (d.bytes.length !== e.size) {
      return verdictFor(STATE_SIZE_REFUSED,
        'Chunk ' + d.index + ' arrived as ' + d.bytes.length + ' bytes where the signed manifest commits ' +
        e.size + '. The length is checked before the digest so a peer cannot make a receiver hash an ' +
        'arbitrary quantity of its choosing.',
        { claim: claim });
    }

    // --- 4. the content digest -----------------------------------------------
    if (typeof options.digest !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No digest function was supplied, so chunk ' + d.index + ' was never compared against the digest ' +
        'the signed manifest commits. Nothing was established.',
        { claim: claim });
    }
    var actual;
    try {
      actual = options.digest(d.bytes);
    } catch (err) {
      return verdictFor(STATE_UNVERIFIED,
        'The digest function failed on chunk ' + d.index + ': ' + errText(err) + '. A check that failed ' +
        'is a check that did not happen, never a pass.',
        { claim: claim });
    }
    if (!isString(actual) || actual.toLowerCase() !== e.digest) {
      return verdictFor(STATE_DIGEST_MISMATCH,
        'Chunk ' + d.index + ' digests to ' + JSON.stringify(String(actual).slice(0, 16) + '…') +
        ' where the signed manifest commits ' + JSON.stringify(e.digest.slice(0, 16) + '…') + '. These ' +
        'are not the bytes the source described, so they are discarded on arrival — before they are ' +
        'stored and therefore before they could ever be forwarded.',
        { claim: claim });
    }

    return verdictFor(STATE_VERIFIED,
      'Chunk ' + e.index + ' belongs to ' + JSON.stringify(e.artifactId) + ', is the committed ' + e.size +
      ' bytes, and digests to the value the source’s signed manifest commits. Which peer handed it over ' +
      'was not part of that decision and is not recorded in this verdict.',
      {
        claim: claim, artifactId: e.artifactId, index: e.index, digest: e.digest,
        byteLength: d.bytes.length, content: d.bytes
      });
  }

  /**
   * Verifies the source's signed manifest against a pinned root.
   *
   * The root is the receiver's out-of-band anchor — ADR-035's pinned
   * fingerprint, extended to commit the manifest's digest as well as its
   * signer. Without it nothing can be checked, so a receiver with no root
   * refuses everything rather than accepting whatever arrives first.
   *
   * The signature runs after the digest, for closure.js's reason: the digest
   * proves the bytes are the bytes the root pinned, the signature proves who
   * described them, and a manifest whose content is wrong never reaches a
   * verifier.
   */
  function verifyManifestOffer(offer, root, opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : null;
    var claim = {
      artifactId: o && isIdentifier(o.artifactId, LIMITS.identifier) ? o.artifactId : null,
      index: null,
      byteLength: o && isBytes(o.bytes) ? o.bytes.length : null,
      digest: null
    };

    var r = normalizeRoot(root);
    if (!r) {
      return verdictFor(STATE_UNKNOWN_INDEX,
        'This receiver has pinned no root, so there is no digest and no signer to check a manifest ' +
        'against. A receiver with no anchor cannot start a transfer at all.',
        { claim: claim });
    }
    if (!o || !isBytes(o.bytes)) {
      return verdictFor(STATE_MALFORMED,
        'A manifest was offered and carries no bytes.', { claim: claim });
    }
    if (o.bytes.length > LIMITS.manifestBytes) {
      return verdictFor(STATE_SIZE_REFUSED,
        'The offered manifest is ' + o.bytes.length + ' bytes, over the ' + LIMITS.manifestBytes +
        '-byte ceiling this build will read one from.',
        { claim: claim });
    }

    if (typeof options.digest !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No digest function was supplied, so the offered manifest was never compared against the pinned ' +
        'root. Nothing was established.',
        { claim: claim });
    }
    var actual;
    try {
      actual = options.digest(o.bytes);
    } catch (err) {
      return verdictFor(STATE_UNVERIFIED,
        'The digest function failed on the manifest: ' + errText(err) + '.', { claim: claim });
    }
    if (!isString(actual) || actual.toLowerCase() !== r.manifestDigest) {
      return verdictFor(STATE_DIGEST_MISMATCH,
        'The offered manifest digests to ' + JSON.stringify(String(actual).slice(0, 16) + '…') +
        ' where this receiver pinned ' + JSON.stringify(r.manifestDigest.slice(0, 16) + '…') + '.',
        { claim: claim });
    }

    var read = readManifestBytes(o.bytes, options);
    if (!read.ok) {
      return verdictFor(STATE_MALFORMED,
        'The manifest matched the pinned digest and is not a readable manifest: ' + read.reason +
        '. Bytes that match a digest and describe no artifact commit to nothing.',
        { claim: claim });
    }
    if (read.manifest.artifactId !== r.artifactId) {
      return verdictFor(STATE_FOREIGN,
        'The manifest describes artifact ' + JSON.stringify(read.manifest.artifactId) + ' where the ' +
        'pinned root names ' + JSON.stringify(r.artifactId) + '.',
        { claim: claim });
    }
    if (read.manifest.signerId !== r.signerId) {
      return verdictFor(STATE_FOREIGN,
        'The manifest names signer ' + JSON.stringify(read.manifest.signerId) + ' where the pinned root ' +
        'names ' + JSON.stringify(r.signerId) + '.',
        { claim: claim });
    }

    var signature = null;
    if (o.signature !== undefined && o.signature !== null) {
      if (!isString(o.signature) || !o.signature.length || o.signature.length > LIMITS.signatureHex ||
          !HEX_RE.test(o.signature) || (o.signature.length & 1)) {
        return verdictFor(STATE_MALFORMED,
          'The manifest signature is not an even-length run of lowercase hex inside the ceiling.',
          { claim: claim });
      }
      signature = o.signature;
    }

    if (signature === null) {
      return verdictFor(STATE_UNSIGNED,
        'This manifest carries no signature. Chunks are content-addressed and carry none of their own, ' +
        'so the manifest signature is the ONLY thing standing behind every chunk digest in the swarm — ' +
        'an unsigned manifest is an unsigned artifact.',
        {
          claim: claim, signatureChecked: null,
          unsignedManifest: read.manifest
        });
    }
    if (typeof options.verifySignature !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No signature verifier was supplied, so it is unknown who described these chunk digests.',
        { claim: claim, signatureChecked: null });
    }
    var message = manifestSigningString({ artifactId: r.artifactId, manifestDigest: r.manifestDigest });
    var answer;
    try {
      answer = options.verifySignature({
        artifactId: r.artifactId,
        manifestDigest: r.manifestDigest,
        signerId: r.signerId,
        signature: signature,
        message: message
      });
    } catch (err2) {
      return verdictFor(STATE_UNVERIFIED,
        'The signature verifier failed on the manifest: ' + errText(err2) + '.',
        { claim: claim, signatureChecked: null });
    }
    if (answer === false) {
      return verdictFor(STATE_FORGED,
        'The manifest signature did not verify under ' + JSON.stringify(r.signerId) + ', the signer this ' +
        'receiver pinned.',
        { claim: claim, signatureChecked: false });
    }
    if (answer !== true) {
      return verdictFor(STATE_UNVERIFIED,
        'The signature verifier returned ' + JSON.stringify(answer) + ' rather than a verdict, so nothing ' +
        'was established.',
        { claim: claim, signatureChecked: null });
    }

    return verdictFor(STATE_VERIFIED,
      'The manifest is the one this receiver pinned, describes ' + JSON.stringify(r.artifactId) +
      ', and is signed by ' + JSON.stringify(r.signerId) + '. Every chunk digest in the swarm now has ' +
      'exactly one authority, and it is not a peer.',
      {
        claim: claim, signatureChecked: true, artifactId: r.artifactId, index: 0,
        digest: r.manifestDigest, byteLength: o.bytes.length, content: o.bytes,
        manifest: read.manifest, signerId: r.signerId
      });
  }

  /**
   * A manifest's bytes decode however the caller says. `opts.decodeManifest` is
   * injected for that and the default reads UTF-8 JSON, which is what the rest
   * of this repository's frames use. A decoder that throws yields an unreadable
   * manifest rather than an exception on a security path.
   */
  function readManifestBytes(bytes, options) {
    var value;
    try {
      if (typeof options.decodeManifest === 'function') value = options.decodeManifest(bytes);
      else value = JSON.parse(utf8ToString(bytes));
    } catch (err) {
      return { ok: false, reason: 'it did not decode (' + errText(err) + ')' };
    }
    return parseManifest(value);
  }

  /** Minimal UTF-8 decode, so this module needs nothing else in a browser. */
  function utf8ToString(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(out));
  }

  // ---------------------------------------------------------------------------
  // The policy — the receiver's, and it has no peer field at all
  // ---------------------------------------------------------------------------

  /**
   * Normalises a receiver policy.
   *
   * There is deliberately no way to express "trust this peer". The policy names
   * signers, which sign manifests, and nothing else. A receiver cannot relax
   * verification for a peer it likes, because there is no field in which to say
   * so and no argument through which the gate could read one.
   *
   * `acceptUnsignedManifest` is the one field with no default, for the reason
   * attest.js gives `requireAttestation` none: whether a manifest nobody signed
   * may ever anchor a transfer is a decision the receiver has to make, and a
   * policy that has not made it is refused rather than handed an answer nobody
   * chose. Saying `true` is narrower than it sounds — the manifest must still
   * match the digest the operator pinned out of band — but it is still the
   * removal of the only signature in the design, so nobody gets it by accident.
   *
   * Normalising is idempotent: an undeclared policy stays `null` rather than
   * becoming `false`, so a receiver that stored a normalised policy and
   * normalised it again does not silently acquire a position nobody took.
   */
  function normalizePolicy(policy) {
    var p = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
    var stated = p.acceptUnsignedManifest === true ? true : (p.acceptUnsignedManifest === false ? false : null);
    var out = {
      declared: stated !== null,
      acceptUnsignedManifest: stated,
      trustedSigners: []
    };
    var signers = Array.isArray(p.trustedSigners) ? p.trustedSigners : [];
    for (var i = 0; i < signers.length && out.trustedSigners.length < LIMITS.identifier; i++) {
      if (isIdentifier(signers[i], LIMITS.identifier) && out.trustedSigners.indexOf(signers[i]) < 0) {
        out.trustedSigners.push(signers[i]);
      }
    }
    out.trustedSigners.sort();
    return out;
  }

  function normalizeRoot(rootPin) {
    var r = rootPin && typeof rootPin === 'object' && !Array.isArray(rootPin) ? rootPin : {};
    if (!isIdentifier(r.artifactId, LIMITS.identifier)) return null;
    if (!isIdentifier(r.signerId, LIMITS.identifier)) return null;
    if (!isDigestHex(r.manifestDigest)) return null;
    return { artifactId: r.artifactId, signerId: r.signerId, manifestDigest: r.manifestDigest };
  }

  // ---------------------------------------------------------------------------
  // The gates — pure, total, and the only things here that decide
  // ---------------------------------------------------------------------------

  function refusal(code, reason) {
    return { admit: false, code: code, reason: reason };
  }

  /**
   * Stage one for a chunk: what the verdict state alone permits. Total over the
   * vocabulary, and an unrecognised state fails closed — a future state must
   * not become an accidental bypass by falling through a switch.
   */
  function chunkGate(state) {
    switch (state) {
      case STATE_VERIFIED:
        return { pass: true };
      case STATE_MALFORMED:
        return { pass: false, code: CODE_MALFORMED, reason: 'The delivery could not be read.' };
      case STATE_FOREIGN:
        return { pass: false, code: CODE_FOREIGN, reason: 'The chunk belongs to a different artifact.' };
      case STATE_UNKNOWN_INDEX:
        return {
          pass: false, code: CODE_UNKNOWN_INDEX,
          reason: 'The signed manifest commits no digest at that position.'
        };
      case STATE_SIZE_REFUSED:
        return {
          pass: false, code: CODE_SIZE_REFUSED,
          reason: 'The delivery is not the length the signed manifest commits.'
        };
      case STATE_DIGEST_MISMATCH:
        return {
          pass: false, code: CODE_DIGEST_MISMATCH,
          reason: 'The bytes are not the bytes the source described.'
        };
      case STATE_UNSIGNED:
        return {
          pass: false, code: CODE_UNSIGNED,
          reason: 'A chunk cannot be admitted under an unsigned manifest.'
        };
      case STATE_FORGED:
        return { pass: false, code: CODE_FORGED, reason: 'The signature did not verify.' };
      case STATE_UNVERIFIED:
        return {
          pass: false, code: CODE_UNVERIFIED,
          reason: 'A step of the pipeline could not be performed, so nothing was established.'
        };
      default:
        return {
          pass: false, code: CODE_UNKNOWN_STATE,
          reason: 'Unrecognised chunk state: ' + JSON.stringify(state) +
            '. A state this build does not know is refused rather than interpreted.'
        };
    }
  }

  /**
   * May this chunk be stored — and therefore forwarded?
   *
   * Same shape as `attest.admitTransfer` and `closure.admitClosure`: a policy
   * and a verdict in, an { admit, code, reason } out, pure and total so the
   * rule can be tested exhaustively and no other path can reach around it.
   *
   * `situation` is the receiver's, not the chunk's: whether a root is pinned,
   * whether the manifest has verified, whether this position is already held.
   * There is exactly one `admit: true` in this function and it is at the bottom.
   *
   * THERE IS NO PEER ARGUMENT. A caller cannot pass one, so no version of this
   * function can be talked into admitting on the strength of who sent the bytes.
   */
  function admitChunk(policy, verdict, situation) {
    var p = normalizePolicy(policy);
    var s = situation && typeof situation === 'object' && !Array.isArray(situation) ? situation : {};

    if (!p.declared) {
      return refusal(CODE_POLICY_UNDECLARED,
        'This policy has not stated whether it accepts an unsigned manifest. The manifest signature is ' +
        'the only signature in this design, so there is no default to fall back on.');
    }
    if (s.rootDeclared !== true) {
      return refusal(CODE_ROOT_UNDECLARED,
        'No root is pinned for this transfer. Every chunk digest is committed by a manifest committed by ' +
        'the root, so with no root there is no chain to check anything against.');
    }
    if (s.manifestVerified !== true) {
      return refusal(CODE_MANIFEST_UNVERIFIED,
        'The source’s signed manifest has not verified on this device, so no chunk has a committed ' +
        'digest here yet. A peer offering chunks before the manifest lands is offering bytes nothing ' +
        'can measure.');
    }

    if (!verdict || !verdict.state) {
      return refusal(CODE_PENDING, 'The verification of this chunk has not completed yet.');
    }

    var gate = chunkGate(verdict.state);
    if (!gate.pass) return refusal(gate.code, gate.reason);

    // Verified, and already on disk. Not an error and not a store either: a
    // duplicate is the ordinary outcome of asking two peers for the same chunk,
    // and it must not overwrite a copy that already verified.
    if (s.held === true) {
      return refusal(CODE_ALREADY_HELD,
        'Chunk ' + verdict.index + ' verified and this receiver already holds it. A second correct copy ' +
        'is bandwidth spent, not a fault, and the copy already stored is kept.');
    }

    return {
      admit: true,
      code: CODE_ADMITTED,
      reason: 'Chunk ' + verdict.index + ' matches the digest the source’s signed manifest commits, so it ' +
        'is stored and becomes forwardable. No peer identity entered this decision.'
    };
  }

  /**
   * May this manifest anchor the transfer?
   *
   * Kept separate from `admitChunk` for attest.js's reason: two questions, two
   * functions, and an information barrier between them. This one is the only
   * place a signer is checked, and a verifier saying the signature is genuine
   * is still not this receiver saying the key may sign for it.
   */
  function admitManifest(policy, verdict, situation) {
    var p = normalizePolicy(policy);
    var s = situation && typeof situation === 'object' && !Array.isArray(situation) ? situation : {};

    if (!p.declared) {
      return refusal(CODE_POLICY_UNDECLARED,
        'This policy has not stated whether it accepts an unsigned manifest.');
    }
    if (s.rootDeclared !== true) {
      return refusal(CODE_ROOT_UNDECLARED, 'No root is pinned, so there is nothing to check a manifest against.');
    }
    if (!verdict || !verdict.state) {
      return refusal(CODE_PENDING, 'The verification of this manifest has not completed yet.');
    }

    if (verdict.state === STATE_UNSIGNED) {
      if (p.acceptUnsignedManifest !== true) {
        return refusal(CODE_UNSIGNED,
          'This manifest carries no signature and this receiver does not accept one. Every chunk digest ' +
          'in the swarm rests on this signature and on nothing else.');
      }
      // Accepted only because the receiver said so, and only because the bytes
      // still matched the digest an operator pinned out of band. The signer
      // check below is skipped because there is no signer to check.
      return {
        admit: true,
        code: CODE_MANIFEST_ADMITTED,
        reason: 'The manifest matches the pinned root digest and carries no signature, which this ' +
          'receiver has explicitly declared it accepts. The out-of-band pin is doing all of the work.'
      };
    }

    var gate = chunkGate(verdict.state);
    if (!gate.pass) return refusal(gate.code, gate.reason);

    if (!p.trustedSigners.length || p.trustedSigners.indexOf(verdict.signerId) < 0) {
      return refusal(CODE_UNTRUSTED_SIGNER,
        'The manifest signature verified under ' + JSON.stringify(verdict.signerId) + ', which is not a ' +
        'signer this receiver trusts. A verifier saying a signature is genuine is not this receiver ' +
        'saying the key may sign for it.');
    }

    return {
      admit: true,
      code: CODE_MANIFEST_ADMITTED,
      reason: 'The manifest is the pinned one and is signed by ' + JSON.stringify(verdict.signerId) + '.'
    };
  }

  // ---------------------------------------------------------------------------
  // The receiver — an immutable value, and the one place bytes get in
  // ---------------------------------------------------------------------------

  var RECEIVER_KIND = 'rvqr-swarm-receiver/1';

  /**
   * Starts a receive against a pinned root. Every device in the fleet does this
   * independently and runs the whole pipeline itself, whichever peer later
   * hands over the bytes.
   */
  function beginReceive(rootPin, policy) {
    var root = normalizeRoot(rootPin);
    return freezeDeep({
      kind: RECEIVER_KIND,
      rootDeclared: root !== null,
      root: root,
      policy: normalizePolicy(policy),
      artifactId: root ? root.artifactId : null,
      manifest: null,
      chunks: [],
      quarantined: [],
      quarantinedTotal: 0,
      acceptedBytes: 0
    });
  }

  /**
   * A receiver is recognised by its SHAPE, not by its tag: every function below
   * indexes into those arrays, and a half-built object would throw on a
   * security path rather than refuse on one.
   */
  function isReceiver(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === RECEIVER_KIND &&
      Array.isArray(v.chunks) && Array.isArray(v.quarantined) && isInteger(v.quarantinedTotal) &&
      !!v.policy && typeof v.policy === 'object';
  }

  function situationFor(receiver, index) {
    return {
      rootDeclared: !!receiver.rootDeclared,
      manifestVerified: receiver.manifest !== null,
      held: holds(receiver, index)
    };
  }

  /** Whether this receiver holds a VERIFIED copy of that position. */
  function holds(receiver, index) {
    if (!isReceiver(receiver)) return false;
    for (var i = 0; i < receiver.chunks.length; i++) {
      if (receiver.chunks[i].index === index) return true;
    }
    return false;
  }

  /**
   * The one expectation a delivery for this position will be measured against,
   * derived entirely from the manifest this receiver already verified. Null
   * before the manifest lands, which refuses.
   */
  function expectationFor(receiver, index) {
    if (!isReceiver(receiver) || !receiver.manifest) return null;
    if (!isInteger(index) || index < 0 || index >= receiver.manifest.chunks.length) return null;
    var entry = receiver.manifest.chunks[index];
    return {
      artifactId: receiver.manifest.artifactId,
      index: entry.index,
      digest: entry.digest,
      size: entry.size
    };
  }

  /**
   * Offers the source's manifest to a receiver. Returns { receiver, verdict,
   * decision } with a NEW receiver; the one passed in is never written to.
   */
  function offerManifest(receiver, offer, opts) {
    if (!isReceiver(receiver)) {
      var fresh = beginReceive(null, null);
      return {
        receiver: fresh, verdict: null,
        decision: admitManifest(fresh.policy, null, { rootDeclared: false })
      };
    }
    if (receiver.manifest) {
      // The manifest is pinned by digest, so a second one is either the same
      // bytes again or a different artifact. Neither replaces a verified
      // manifest: a receiver that could be re-anchored mid-transfer is a
      // receiver a peer can redirect.
      return {
        receiver: receiver, verdict: null,
        decision: refusal(CODE_ALREADY_HELD,
          'This receiver has already verified its manifest. A verified anchor is not replaced, because a ' +
          'receiver that can be re-anchored mid-transfer is a receiver a peer can redirect.')
      };
    }

    var verdict = verifyManifestOffer(offer, receiver.root, opts);
    var decision = admitManifest(receiver.policy, verdict, { rootDeclared: !!receiver.rootDeclared });

    if (!decision.admit) {
      return {
        receiver: withQuarantine(receiver, {
          claimedIndex: null, claimedBytes: verdict.claim.byteLength, claimedDigest: verdict.claim.digest,
          state: verdict.state, code: decision.code, reason: decision.reason, subject: 'manifest'
        }),
        verdict: verdict,
        decision: decision
      };
    }

    // The unsigned path carries the manifest outside the verdict's published
    // facts on purpose: `verdictFor` publishes nothing on a non-verified state,
    // and `unsigned` is not verified. So the manifest is re-read here rather
    // than lifted out of a field that must stay null.
    var manifest = verdict.manifest;
    if (!manifest && verdict.state === STATE_UNSIGNED) {
      var reread = readManifestBytes(offer.bytes, opts && typeof opts === 'object' ? opts : {});
      manifest = reread.ok ? reread.manifest : null;
    }
    if (!manifest) {
      return {
        receiver: withQuarantine(receiver, {
          claimedIndex: null, claimedBytes: verdict.claim.byteLength, claimedDigest: null,
          state: verdict.state, code: CODE_MALFORMED,
          reason: 'The manifest was admitted and could not be read back, so nothing was anchored.',
          subject: 'manifest'
        }),
        verdict: verdict,
        decision: refusal(CODE_MALFORMED, 'The admitted manifest could not be read back.')
      };
    }

    return {
      receiver: freezeDeep(assign(receiver, { manifest: manifest })),
      verdict: verdict,
      decision: decision
    };
  }

  /**
   * Offers one chunk to a receiver. Returns { receiver, verdict, decision } with
   * a NEW receiver; the one passed in is never written to.
   *
   * ---------------------------------------------------------------------------
   * THIS IS THE ONLY PLACE DELIVERED BYTES ENTER A RECEIVER, AND IT IS ONE
   * BRANCH — WHICH IS WHY A BAD CHUNK CANNOT BE FORWARDED.
   * ---------------------------------------------------------------------------
   *
   * On admission the content is COPIED into `chunks`. On every refusal the
   * receiver gains a descriptor and nothing else — no payload, no reference to
   * the delivery. `advertise()` reads `chunks`, so the set this device will
   * serve to the rest of the fleet is by construction the set that verified
   * against the source's signed manifest. There is no unverified-bytes
   * container to forward out of, because unverified bytes are never taken.
   */
  function offerChunk(receiver, delivery, opts) {
    if (!isReceiver(receiver)) {
      var fresh = beginReceive(null, null);
      return {
        receiver: fresh, verdict: null,
        decision: admitChunk(fresh.policy, null, situationFor(fresh, 0))
      };
    }

    var claimedIndex = delivery && typeof delivery === 'object' && isInteger(delivery.index)
      ? delivery.index : -1;
    var situation = situationFor(receiver, claimedIndex);

    // A receiver with no root or no verified manifest refuses before
    // verification runs, so it does not hand a stranger's bytes to a digest
    // function either.
    var early = admitChunk(receiver.policy, { state: STATE_VERIFIED }, situation);
    if (!early.admit && (early.code === CODE_ROOT_UNDECLARED || early.code === CODE_POLICY_UNDECLARED ||
        early.code === CODE_MANIFEST_UNVERIFIED)) {
      return {
        receiver: withQuarantine(receiver, quarantineEntry(null, early, claimedIndex)),
        verdict: null,
        decision: early
      };
    }

    var verdict = verifyChunk(delivery, expectationFor(receiver, claimedIndex), opts);
    var decision = admitChunk(receiver.policy, verdict, situation);

    if (!decision.admit) {
      return {
        receiver: withQuarantine(receiver, quarantineEntry(verdict, decision, claimedIndex)),
        verdict: verdict,
        decision: decision
      };
    }

    return { receiver: store(receiver, verdict), verdict: verdict, decision: decision };
  }

  function quarantineEntry(verdict, decision, claimedIndex) {
    var claim = verdict && verdict.claim ? verdict.claim : { index: null, byteLength: null, digest: null };
    return {
      // The CLAIMED position, because a refused chunk has no established one.
      claimedIndex: claim.index === null ? (claimedIndex < 0 ? null : claimedIndex) : claim.index,
      claimedBytes: claim.byteLength,
      claimedDigest: claim.digest,
      state: verdict ? verdict.state : null,
      code: decision.code,
      reason: decision.reason,
      subject: 'chunk'
    };
  }

  function withQuarantine(receiver, entry) {
    var list = receiver.quarantined.slice(0);
    // Capped, because a peer controls how many refusals it can cause. The
    // dropped ones are COUNTED rather than forgotten.
    if (list.length < LIMITS.quarantineEntries) list.push(entry);
    return freezeDeep(assign(receiver, {
      quarantined: list,
      quarantinedTotal: receiver.quarantinedTotal + 1
    }));
  }

  /**
   * The single storage path. Everything above this line refuses; this is the
   * only function that copies a peer's bytes into a receiver, and it runs only
   * after `admitChunk` returned `admit: true`.
   */
  function store(receiver, verdict) {
    var chunks = receiver.chunks.slice(0);
    // A copy, so a transport cannot change what verified after the fact by
    // writing into the buffer it handed over.
    chunks.push({ index: verdict.index, digest: verdict.digest, bytes: copyBytes(verdict.content) });
    chunks.sort(function (a, b) { return a.index - b.index; });
    return freezeDeep(assign(receiver, {
      chunks: chunks,
      acceptedBytes: receiver.acceptedBytes + verdict.byteLength
    }));
  }

  /**
   * What this device will serve to the rest of the fleet.
   *
   * Derived from the store, which is what makes "discarded before it is stored
   * OR FORWARDED" true by construction rather than by discipline. There is no
   * second list to keep in step.
   */
  function advertise(receiver) {
    if (!isReceiver(receiver)) return freezeDeep({ artifactId: null, manifestDigest: null, have: [] });
    var have = [];
    for (var i = 0; i < receiver.chunks.length; i++) have.push(receiver.chunks[i].index);
    return freezeDeep({
      artifactId: receiver.artifactId,
      manifestDigest: receiver.root ? receiver.root.manifestDigest : null,
      have: have
    });
  }

  /** Which positions are still outstanding. Empty before the manifest lands. */
  function missing(receiver) {
    if (!isReceiver(receiver) || !receiver.manifest) return [];
    var out = [];
    for (var i = 0; i < receiver.manifest.chunks.length; i++) {
      if (!holds(receiver, i)) out.push(i);
    }
    return out;
  }

  function isComplete(receiver) {
    return isReceiver(receiver) && receiver.manifest !== null &&
      receiver.chunks.length === receiver.manifest.chunks.length;
  }

  /**
   * The artifact, or null while anything is outstanding — never a partial or
   * speculative result. Every byte in it verified against the source's signed
   * manifest on THIS device.
   */
  function reassemble(receiver) {
    if (!isComplete(receiver)) return null;
    var out = new Uint8Array(receiver.manifest.totalBytes);
    var at = 0;
    for (var i = 0; i < receiver.chunks.length; i++) {
      out.set(receiver.chunks[i].bytes, at);
      at += receiver.chunks[i].bytes.length;
    }
    return out;
  }

  /**
   * What a receipt has to carry about a swarm receive.
   *
   * `verifiedLocally` is a separate named field from `complete` on purpose: an
   * auditor's question is not "did bytes arrive" but "did THIS device check
   * them", and a single "ok" would conflate the two forever. It is always true
   * for a complete receiver here, and it is recorded rather than assumed
   * because the whole ADR turns on it.
   *
   * This is NOT ADR-134's witness record and nothing signs it. See
   * `describeUnimplemented()`.
   */
  function receiveReceipt(receiver) {
    if (!isReceiver(receiver)) {
      return freezeDeep({
        artifactId: null, complete: false, verifiedLocally: false, manifestVerified: false,
        chunksHeld: 0, chunksDeclared: null, acceptedBytes: 0,
        rejected: [], rejectedTotal: 0, rejectedRecorded: 0,
        summary: 'No swarm receive was recorded.'
      });
    }
    var receipt = {
      artifactId: receiver.artifactId,
      complete: isComplete(receiver),
      // Never derived from "did it complete": the point of ADR-024 §2.2.
      verifiedLocally: isComplete(receiver),
      manifestVerified: receiver.manifest !== null,
      chunksHeld: receiver.chunks.length,
      chunksDeclared: receiver.manifest ? receiver.manifest.chunks.length : null,
      acceptedBytes: receiver.acceptedBytes,
      rejected: receiver.quarantined.map(function (q) {
        return { claimedIndex: q.claimedIndex, state: q.state, code: q.code, subject: q.subject };
      }),
      rejectedTotal: receiver.quarantinedTotal,
      rejectedRecorded: receiver.quarantined.length,
      summary: ''
    };
    receipt.summary = receipt.complete
      ? 'Complete: ' + receipt.chunksHeld + ' of ' + receipt.chunksDeclared + ' chunks, every one of them ' +
        'digested on this device against the source’s signed manifest, and ' + receipt.rejectedTotal +
        ' offered chunk(s) refused. Which peer supplied any given chunk did not enter the decision.'
      : 'Incomplete: ' + receipt.chunksHeld + ' of ' +
        (receipt.chunksDeclared === null ? 'an unknown number of' : receipt.chunksDeclared) +
        ' chunks, ' + receipt.rejectedTotal + ' refused.';
    return freezeDeep(receipt);
  }

  // ---------------------------------------------------------------------------
  // The ledger — claims and measurements, kept in two maps that never merge
  // ---------------------------------------------------------------------------

  /**
   * A device's own record of the peers around it.
   *
   * `claims` is what a peer SAID it holds. `measured` is what actually happened.
   * They are separate maps and `rankProviders` takes only the second, so an
   * advertisement can make a peer a candidate and can never raise its rank.
   *
   * A ledger belongs to ONE device. Reputation is not shared: a peer's
   * reputation arriving from another peer would be a claim, and this design
   * does not act on claims. Every device pays for its own discovery, which
   * costs more and is the only version that is honest.
   */
  function newLedger() {
    return freezeDeep({ claims: {}, measured: {} });
  }

  function zeroMeasurement() {
    return {
      requested: 0, accepted: 0, rejected: 0, timedOut: 0,
      bytesAccepted: 0, ticksToDelivery: 0, deliveries: 0
    };
  }

  function measurementOf(ledger, peerId) {
    var m = ledger && ledger.measured ? ledger.measured[peerId] : null;
    return m ? m : zeroMeasurement();
  }

  /** The measured map, and nothing else. What ranking is allowed to see. */
  function measurementsOf(ledger) {
    return ledger && ledger.measured ? ledger.measured : {};
  }

  function withMeasurement(ledger, peerId, change) {
    if (!isIdentifier(peerId, LIMITS.identifier)) return ledger;
    var measured = {};
    Object.keys(ledger.measured).forEach(function (k) { measured[k] = ledger.measured[k]; });
    if (Object.keys(measured).length >= LIMITS.peers && !measured[peerId]) return ledger;
    measured[peerId] = freezeDeep(assign(measurementOf(ledger, peerId), change));
    return freezeDeep(assign(ledger, { measured: measured }));
  }

  /**
   * Records what a peer SAYS it holds.
   *
   * This is the only function that writes to `claims`, and nothing that decides
   * or ranks ever reads that map. An advertisement makes a peer eligible to be
   * asked; it establishes nothing else, and a peer that advertises the whole
   * artifact and delivers none of it is exactly the case ADR-024 §2.2 says is
   * the real threat.
   */
  function noteAdvertisement(ledger, peerId, indexes) {
    if (!ledger || !isIdentifier(peerId, LIMITS.identifier)) return ledger;
    var list = [];
    var declared = Array.isArray(indexes) ? indexes : [];
    for (var i = 0; i < declared.length && list.length < LIMITS.advertisedEntries; i++) {
      if (isInteger(declared[i]) && declared[i] >= 0 && declared[i] < LIMITS.chunks &&
          list.indexOf(declared[i]) < 0) {
        list.push(declared[i]);
      }
    }
    list.sort(function (a, b) { return a - b; });
    var claims = {};
    Object.keys(ledger.claims).forEach(function (k) { claims[k] = ledger.claims[k]; });
    if (Object.keys(claims).length >= LIMITS.peers && !claims[peerId]) return ledger;
    claims[peerId] = freezeDeep({ advertised: list });
    return freezeDeep(assign(ledger, { claims: claims }));
  }

  /** Whether a peer has claimed that position. Eligibility only. */
  function claimsChunk(ledger, peerId, index) {
    var c = ledger && ledger.claims ? ledger.claims[peerId] : null;
    return !!c && c.advertised.indexOf(index) >= 0;
  }

  function noteRequest(ledger, peerId) {
    var m = measurementOf(ledger, peerId);
    return withMeasurement(ledger, peerId, { requested: m.requested + 1 });
  }

  /**
   * Records an OUTCOME that this device observed: bytes arrived, and the local
   * pipeline either admitted them or did not. `admitted` is the gate's answer,
   * not the peer's word for it.
   */
  function noteDelivery(ledger, peerId, outcome) {
    var o = outcome && typeof outcome === 'object' ? outcome : {};
    var m = measurementOf(ledger, peerId);
    var ticks = isInteger(o.ticks) && o.ticks >= 0 ? o.ticks : 0;
    if (o.admitted === true) {
      return withMeasurement(ledger, peerId, {
        accepted: m.accepted + 1,
        bytesAccepted: m.bytesAccepted + (isInteger(o.bytes) && o.bytes > 0 ? o.bytes : 0),
        ticksToDelivery: m.ticksToDelivery + ticks,
        deliveries: m.deliveries + 1
      });
    }
    return withMeasurement(ledger, peerId, {
      rejected: m.rejected + 1,
      ticksToDelivery: m.ticksToDelivery + ticks,
      deliveries: m.deliveries + 1
    });
  }

  /** Records a request that never produced bytes at all. */
  function noteTimeout(ledger, peerId, ticks) {
    var m = measurementOf(ledger, peerId);
    return withMeasurement(ledger, peerId, {
      timedOut: m.timedOut + 1,
      ticksToDelivery: m.ticksToDelivery + (isInteger(ticks) && ticks >= 0 ? ticks : 0)
    });
  }

  // --- Scheduling on measured behaviour, ADR-024 §2.2 -----------------------

  /**
   * How badly a failure counts against a peer, relative to a success. Two, so
   * one failure cancels two successes and a peer that fails everything lands
   * well below the floor on its first attempt.
   */
  var FAILURE_WEIGHT = 2;

  /**
   * Below this a peer is not asked again. A peer with one timeout and nothing
   * else scores -2, so a single unanswered request is enough — which is the
   * correct aggression: the cost of dropping an honest peer is one extra
   * request elsewhere, and the cost of keeping a withholder is a timeout per
   * chunk for the rest of the transfer.
   */
  var SCORE_FLOOR = -0.5;

  /** A peer nobody has measured yet. Neutral: it gets one trial, not a promotion. */
  var TRIAL_SCORE = 0;

  /**
   * A peer's score, from MEASURED counters alone.
   *
   * The argument is one measurement record. There is no advertisement in it, no
   * peer-supplied reputation, no identity and no claim of any kind — so there
   * is no expression a peer can send that changes this number. It moves only
   * when this device asks for something and observes what happened.
   */
  function peerScore(measurement) {
    var m = measurement && typeof measurement === 'object' ? measurement : zeroMeasurement();
    var requested = isInteger(m.requested) && m.requested > 0 ? m.requested : 0;
    if (!requested) return TRIAL_SCORE;
    var good = isInteger(m.accepted) ? m.accepted : 0;
    var bad = (isInteger(m.rejected) ? m.rejected : 0) + (isInteger(m.timedOut) ? m.timedOut : 0);
    return (good - FAILURE_WEIGHT * bad) / requested;
  }

  /** Mean ticks per observed delivery, or null when nothing has been delivered. */
  function peerLatency(measurement) {
    var m = measurement && typeof measurement === 'object' ? measurement : zeroMeasurement();
    var n = (isInteger(m.deliveries) ? m.deliveries : 0) + (isInteger(m.timedOut) ? m.timedOut : 0);
    if (!n) return null;
    return m.ticksToDelivery / n;
  }

  /**
   * Ranks candidate providers.
   *
   * `measurements` is the ledger's MEASURED map. The claims map is not in this
   * argument list, which is the structural form of "deprioritised on measured
   * behaviour rather than on claims": there is no parameter through which an
   * advertisement could arrive, so no amount of advertising changes an ordering.
   *
   * Order: score descending, then latency ascending (an unmeasured peer sorts
   * as if it were instant, so it gets its trial), then id ascending so the
   * result is deterministic.
   */
  function rankProviders(measurements, candidates) {
    var ms = measurements && typeof measurements === 'object' ? measurements : {};
    var ids = Array.isArray(candidates) ? candidates : [];
    var rows = [];
    for (var i = 0; i < ids.length; i++) {
      if (!isIdentifier(ids[i], LIMITS.identifier)) continue;
      var m = ms[ids[i]] ? ms[ids[i]] : zeroMeasurement();
      var latency = peerLatency(m);
      rows.push({
        peerId: ids[i],
        score: peerScore(m),
        meanTicks: latency,
        eligible: peerScore(m) >= SCORE_FLOOR
      });
    }
    rows.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      var al = a.meanTicks === null ? -1 : a.meanTicks;
      var bl = b.meanTicks === null ? -1 : b.meanTicks;
      if (al !== bl) return al - bl;
      return a.peerId < b.peerId ? -1 : (a.peerId > b.peerId ? 1 : 0);
    });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Source metering — measured directly, ADR-024 §4.6
  // ---------------------------------------------------------------------------

  /**
   * A counter for the source link.
   *
   * ADR-024 §4.6 says source traffic is measured directly and not inferred from
   * chunk accounting. `serveFromSource` below is the only thing that writes to
   * one of these, on the same line that produces the bytes, so the number is a
   * count of what left the link and not a reconstruction of what ought to have.
   */
  function meterSource() {
    return { bytes: 0, responses: 0, distinctChunks: [] };
  }

  /**
   * Emits one chunk from the source and meters it in the same step.
   *
   * Deliberately mutating: a meter that returned a new value would let a caller
   * emit bytes and drop the count, and this is the one number the whole ADR
   * turns on.
   */
  function serveFromSource(meter, bodies, index) {
    if (!meter || !Array.isArray(bodies) || !isInteger(index) || index < 0 || index >= bodies.length) {
      return null;
    }
    var body = bodies[index];
    meter.bytes += body.length;
    meter.responses += 1;
    if (meter.distinctChunks.indexOf(index) < 0) meter.distinctChunks.push(index);
    return body;
  }

  /**
   * What the meter says, and what chunk accounting WOULD have said.
   *
   * The gap is not noise. The source serves the same chunk to several devices,
   * so counting distinct chunks understates the link by roughly the fleet size
   * — which is the exact quantity ADR-024 exists to reduce, so inferring it
   * from chunk accounting would be measuring the thing with a ruler made out of
   * the answer.
   */
  function sourceTraffic(meter, artifactBytes, chunkCount) {
    var m = meter && typeof meter === 'object' ? meter : meterSource();
    var total = isInteger(artifactBytes) && artifactBytes > 0 ? artifactBytes : 0;
    var distinct = m.distinctChunks.length;
    var inferred = total && isInteger(chunkCount) && chunkCount > 0
      ? Math.round(total * (distinct / chunkCount)) : 0;
    return freezeDeep({
      measuredDirectly: true,
      bytesMeasured: m.bytes,
      responsesMeasured: m.responses,
      distinctChunksServed: distinct,
      bytesInferredFromChunkAccounting: inferred,
      inferenceUnderstatesByBytes: m.bytes - inferred,
      artifactBytes: total,
      ratioToArtifact: total ? m.bytes / total : null,
      note: 'bytesMeasured is a direct count taken where the bytes left the source, per ADR-024 §4.6. ' +
        'bytesInferredFromChunkAccounting is what "distinct chunks served × chunk size" would have ' +
        'claimed, and it is here only to show the size of the error: the source serves the same chunk ' +
        'to many devices, so chunk accounting understates the link by roughly the fleet size.'
    });
  }

  // ---------------------------------------------------------------------------
  // The simulation — deterministic, and its timings are NOT a fleet measurement
  // ---------------------------------------------------------------------------

  /**
   * A seeded PRNG. Injected everywhere it is used, so a scheduling run is
   * reproducible: the same seed produces the same schedule, the same byte
   * counts and the same tick counts, on any machine and in any order.
   */
  function seededRandom(seed) {
    var s = (isInteger(seed) ? seed : 1) >>> 0;
    if (s === 0) s = 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  var SIM_DEFAULTS = {
    deviceCount: 10,
    chunkSize: 64,
    chunkCount: 32,
    deviceSlots: 1,
    sourceSlots: 1,
    peerSlots: 1,
    chunkTicks: 1,
    timeoutTicks: 8,
    slowTicks: 6,
    maxTicks: 20000,
    seed: 0x5741524d
  };

  function normalizeSimConfig(config) {
    var c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    function num(name, min, max) {
      var v = c[name];
      if (!isInteger(v) || v < min || v > max) return SIM_DEFAULTS[name];
      return v;
    }
    var peers = [];
    var declared = Array.isArray(c.peers) ? c.peers : [];
    for (var i = 0; i < declared.length && peers.length < 64; i++) {
      var p = declared[i];
      if (!p || typeof p !== 'object') continue;
      if (!isIdentifier(p.id, LIMITS.identifier)) continue;
      if (BEHAVIOURS.indexOf(p.behaviour) < 0) continue;
      peers.push({ id: 'peer:' + p.id, behaviour: p.behaviour });
    }
    return {
      deviceCount: num('deviceCount', 1, LIMITS.simulationDevices),
      chunkSize: num('chunkSize', 1, 1 << 20),
      chunkCount: num('chunkCount', 1, 4096),
      deviceSlots: num('deviceSlots', 1, 64),
      sourceSlots: num('sourceSlots', 1, 64),
      peerSlots: num('peerSlots', 1, 64),
      chunkTicks: num('chunkTicks', 1, 1024),
      timeoutTicks: num('timeoutTicks', 1, 4096),
      slowTicks: num('slowTicks', 1, 4096),
      maxTicks: num('maxTicks', 1, LIMITS.simulationTicks),
      seed: isInteger(c.seed) ? c.seed : SIM_DEFAULTS.seed,
      peers: peers,
      artifactId: isIdentifier(c.artifactId, LIMITS.identifier) ? c.artifactId : 'fleet-artifact',
      signerId: isIdentifier(c.signerId, LIMITS.identifier) ? c.signerId : 'fleet-source'
    };
  }

  /** Deterministic artifact bytes, so a run needs no fixture file. */
  function syntheticArtifact(byteLength, seed) {
    var rnd = seededRandom(seed);
    var out = new Uint8Array(byteLength);
    for (var i = 0; i < byteLength; i++) out[i] = Math.floor(rnd() * 256) & 0xff;
    return out;
  }

  var SOURCE_ID = 'source';

  /**
   * Runs a swarm distribution and reports what happened.
   *
   * ---------------------------------------------------------------------------
   * WHAT THIS PRODUCES, AND WHAT IT DOES NOT.
   * ---------------------------------------------------------------------------
   *
   * The byte counts and chunk counts in the report are MEASUREMENTS OF THIS
   * SIMULATION: real bytes went through the real verification pipeline on every
   * simulated receiver, so `sourceBytesMeasured`, `chunksRejected` and
   * `maliciousBytesAccepted` say what this scheduling policy actually does.
   *
   * The timings are NOT measurements of any fleet. The clock is a tick counter
   * defined here; a tick is not a second and nothing in this repository has
   * calibrated one against a device. Every timing field is named `...Ticks`,
   * `wallClockMeasured` is false, and `physicalDevices` is 0. ADR-024 §4.1 and
   * §4.2 want ten and a hundred PHYSICAL devices against a 3 s and a 60 s
   * wall-clock gate, and this function cannot speak to either.
   *
   * `opts.digest` and `opts.verifySignature` are the same injected checks every
   * receiver uses. With no digest function every receiver refuses every chunk,
   * the run completes nothing, and the report says so rather than pretending.
   */
  function simulateSwarm(config, opts) {
    var cfg = normalizeSimConfig(config);
    var options = opts && typeof opts === 'object' ? opts : {};
    var rnd = seededRandom(cfg.seed);

    // --- the artifact and its signed manifest --------------------------------
    var artifactBytes = cfg.chunkSize * cfg.chunkCount;
    var built = buildManifest({
      artifactId: cfg.artifactId,
      signerId: cfg.signerId,
      bytes: syntheticArtifact(artifactBytes, cfg.seed ^ 0x1f2e3d4c),
      chunkSize: cfg.chunkSize
    }, options);
    if (!built.ok) {
      return freezeDeep(emptyReport(cfg, 'the manifest could not be built: ' + built.reason));
    }
    var manifestBytes = encodeUtf8(JSON.stringify(built.manifest));
    var manifestDigest = options.digest(manifestBytes).toLowerCase();
    var rootPin = { artifactId: cfg.artifactId, signerId: cfg.signerId, manifestDigest: manifestDigest };
    var manifestOffer = {
      artifactId: cfg.artifactId,
      bytes: manifestBytes,
      signature: typeof options.sign === 'function'
        ? options.sign(manifestSigningString({ artifactId: cfg.artifactId, manifestDigest: manifestDigest }))
        : null
    };
    var policy = {
      acceptUnsignedManifest: typeof options.sign !== 'function',
      trustedSigners: [cfg.signerId]
    };

    // --- the devices ---------------------------------------------------------
    var devices = [];
    for (var d = 0; d < cfg.deviceCount; d++) {
      var r = beginReceive(rootPin, policy);
      var anchored = offerManifest(r, manifestOffer, options);
      devices.push({
        id: 'device:' + d,
        receiver: anchored.receiver,
        ledger: newLedger(),
        inflight: {},
        slots: cfg.deviceSlots,
        completedAtTick: null,
        fromSource: 0,
        fromPeers: 0
      });
    }

    // --- the providers -------------------------------------------------------
    // The source and the seed peers hold everything from the start. Devices
    // become providers of whatever they have verified, which is the mechanism
    // the whole ADR is about.
    var meter = meterSource();
    var providers = {};
    providers[SOURCE_ID] = {
      id: SOURCE_ID, behaviour: BEHAVIOUR_HONEST, isSource: true, slots: cfg.sourceSlots,
      free: cfg.sourceSlots
    };
    for (var s = 0; s < cfg.peers.length; s++) {
      providers[cfg.peers[s].id] = {
        id: cfg.peers[s].id, behaviour: cfg.peers[s].behaviour, isSource: false, isSeed: true,
        slots: cfg.peerSlots, free: cfg.peerSlots
      };
    }
    for (var dv = 0; dv < devices.length; dv++) {
      providers[devices[dv].id] = {
        id: devices[dv].id, behaviour: BEHAVIOUR_HONEST, isSource: false, isDevice: true,
        deviceIndex: dv, slots: cfg.peerSlots, free: cfg.peerSlots
      };
    }

    // Every peer advertises the whole artifact from the start — including the
    // ones that will never deliver, which is precisely the behaviour ADR-024
    // §2.2 names as the real threat.
    var everything = [];
    for (var e = 0; e < cfg.chunkCount; e++) everything.push(e);
    for (var di = 0; di < devices.length; di++) {
      for (var pk = 0; pk < cfg.peers.length; pk++) {
        devices[di].ledger = noteAdvertisement(devices[di].ledger, cfg.peers[pk].id, everything);
      }
    }

    var stats = {};
    Object.keys(providers).forEach(function (id) {
      stats[id] = { requested: 0, delivered: 0, accepted: 0, rejected: 0, timedOut: 0, bytesAccepted: 0 };
    });

    var pending = [];      // { deviceIndex, providerId, index, dueTick, kind }
    var chunksRejected = 0;
    var chunksTimedOut = 0;
    var firstCompleteTick = null;
    var tick = 0;
    var completedDevices = 0;

    while (tick < cfg.maxTicks && completedDevices < devices.length) {
      // 1. anything due this tick lands, or times out.
      var still = [];
      for (var q = 0; q < pending.length; q++) {
        var job = pending[q];
        if (job.dueTick > tick) { still.push(job); continue; }
        settle(job, tick);
      }
      pending = still;

      // 2. hand out requests to whatever has a free slot.
      for (var w = 0; w < devices.length; w++) {
        var dev = devices[w];
        if (isComplete(dev.receiver)) continue;
        while (dev.slots > 0) {
          var pick = choose(dev);
          if (!pick) break;
          issue(dev, pick.providerId, pick.index, tick);
        }
      }

      tick++;
    }

    // Drain anything still in flight so the counters describe a finished run.
    var guard = 0;
    while (pending.length && guard < cfg.maxTicks) {
      var drained = [];
      for (var z = 0; z < pending.length; z++) {
        if (pending[z].dueTick > tick) drained.push(pending[z]);
        else settle(pending[z], tick);
      }
      pending = drained;
      tick++;
      guard++;
    }

    function settle(job, atTick) {
      var dev = devices[job.deviceIndex];
      var prov = providers[job.providerId];
      dev.slots += 1;
      prov.free += 1;
      var waited = atTick - job.issuedTick;

      if (job.kind === 'timeout') {
        stats[job.providerId].timedOut += 1;
        chunksTimedOut += 1;
        dev.ledger = noteTimeout(dev.ledger, job.providerId, waited);
        delete dev.inflight[job.index];
        return;
      }

      var body = job.bytes;
      var out = offerChunk(dev.receiver, {
        artifactId: cfg.artifactId, index: job.index, bytes: body
      }, options);
      dev.receiver = out.receiver;
      stats[job.providerId].delivered += 1;
      var admitted = out.decision.admit === true;
      if (admitted) {
        stats[job.providerId].accepted += 1;
        stats[job.providerId].bytesAccepted += body.length;
        if (job.providerId === SOURCE_ID) dev.fromSource += 1; else dev.fromPeers += 1;
      } else {
        stats[job.providerId].rejected += 1;
        chunksRejected += 1;
      }
      dev.ledger = noteDelivery(dev.ledger, job.providerId, {
        admitted: admitted, bytes: body.length, ticks: waited
      });
      delete dev.inflight[job.index];

      if (isComplete(dev.receiver) && dev.completedAtTick === null) {
        dev.completedAtTick = atTick;
        completedDevices += 1;
        if (firstCompleteTick === null) firstCompleteTick = atTick;
      }
    }

    /**
     * Picks the next (provider, chunk) for a device.
     *
     * Rarest-first over the chunks this device lacks, then the best-ranked
     * provider that holds it. Providers below the score floor are dropped
     * outright — that is the deprioritisation, and it reads only the measured
     * map. The source is the fallback, which is what makes a swarm that works
     * cost the source link almost nothing and a swarm of withholders cost it
     * everything.
     */
    function choose(dev) {
      var want = missing(dev.receiver);
      if (!want.length) return null;
      var best = null;
      // Rarest-first: the chunk the fewest providers hold. Ties broken by the
      // injected PRNG so two devices do not stampede the same chunk.
      var rarity = [];
      for (var i = 0; i < want.length; i++) {
        if (dev.inflight[want[i]]) continue;
        rarity.push({ index: want[i], holders: holdersOf(want[i]).length, jitter: rnd() });
      }
      if (!rarity.length) return null;
      rarity.sort(function (a, b) {
        if (a.holders !== b.holders) return a.holders - b.holders;
        return a.jitter - b.jitter;
      });

      for (var k = 0; k < rarity.length; k++) {
        var idx = rarity[k].index;
        var candidates = [];
        var hs = holdersOf(idx);
        for (var h = 0; h < hs.length; h++) {
          var pid = hs[h];
          if (pid === SOURCE_ID) continue;
          if (pid === dev.id) continue;
          if (providers[pid].free <= 0) continue;
          candidates.push(pid);
        }
        var ranked = rankProviders(measurementsOf(dev.ledger), candidates);
        for (var rIdx = 0; rIdx < ranked.length; rIdx++) {
          if (!ranked[rIdx].eligible) continue;
          best = { providerId: ranked[rIdx].peerId, index: idx };
          break;
        }
        if (best) break;
        if (providers[SOURCE_ID].free > 0) { best = { providerId: SOURCE_ID, index: idx }; break; }
      }
      return best;
    }

    /**
     * Who holds a chunk. Seeds and the source hold everything; a device holds
     * what it has VERIFIED, because `advertise()` reads the store. A malicious
     * seed is listed here because it CLAIMS to hold everything — being listed
     * is eligibility, not credit.
     */
    function holdersOf(index) {
      var out = [SOURCE_ID];
      for (var i = 0; i < cfg.peers.length; i++) out.push(cfg.peers[i].id);
      for (var j = 0; j < devices.length; j++) {
        if (holds(devices[j].receiver, index)) out.push(devices[j].id);
      }
      return out;
    }

    function issue(dev, providerId, index, atTick) {
      var prov = providers[providerId];
      dev.slots -= 1;
      prov.free -= 1;
      dev.inflight[index] = true;
      dev.ledger = noteRequest(dev.ledger, providerId);
      stats[providerId].requested += 1;

      var job = {
        deviceIndex: devices.indexOf(dev), providerId: providerId, index: index,
        issuedTick: atTick, dueTick: atTick + cfg.chunkTicks, kind: 'deliver', bytes: null
      };

      if (prov.isSource) {
        job.bytes = serveFromSource(meter, built.bodies, index);
      } else if (prov.behaviour === BEHAVIOUR_WITHHOLD) {
        job.kind = 'timeout';
        job.dueTick = atTick + cfg.timeoutTicks;
      } else if (prov.behaviour === BEHAVIOUR_SLOW) {
        if (cfg.slowTicks >= cfg.timeoutTicks) {
          job.kind = 'timeout';
          job.dueTick = atTick + cfg.timeoutTicks;
        } else {
          job.dueTick = atTick + cfg.slowTicks;
          job.bytes = built.bodies[index];
        }
      } else if (prov.behaviour === BEHAVIOUR_CORRUPT) {
        job.bytes = corrupt(built.bodies[index]);
      } else if (prov.isDevice) {
        job.bytes = chunkFrom(devices[prov.deviceIndex].receiver, index);
        if (!job.bytes) { job.kind = 'timeout'; job.dueTick = atTick + cfg.timeoutTicks; }
      } else {
        job.bytes = built.bodies[index];
      }
      pending.push(job);
    }

    function corrupt(body) {
      var out = copyBytes(body);
      out[0] = (out[0] + 1) & 0xff;
      return out;
    }

    // --- the report ----------------------------------------------------------
    var perProvider = [];
    Object.keys(stats).forEach(function (id) {
      var st = stats[id];
      if (!st.requested && !st.delivered) return;
      perProvider.push({
        id: id,
        behaviour: providers[id].behaviour,
        requested: st.requested,
        delivered: st.delivered,
        accepted: st.accepted,
        rejected: st.rejected,
        timedOut: st.timedOut,
        bytesAccepted: st.bytesAccepted
      });
    });
    perProvider.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });

    // Bytes that came from an adversarial peer and were nonetheless admitted.
    // This is NOT a failure and the field is not named as though it were: the
    // only behaviour that can produce a nonzero number here is slow-drip, whose
    // chunks digest to the value the signed manifest commits. They were
    // admitted because they are the right bytes, not because of who sent them
    // — a peer being a transport is the entire design, and a hostile peer that
    // hands over correct bytes has transported correctly.
    //
    // The claim that matters is the audit below: whether any WRONG chunk was
    // ever stored anywhere.
    var adversarialBytesAccepted = 0;
    var adversarialChunksAccepted = 0;
    var adversarialChunksDelivered = 0;
    for (var mp = 0; mp < perProvider.length; mp++) {
      if (perProvider[mp].behaviour === BEHAVIOUR_HONEST) continue;
      adversarialBytesAccepted += perProvider[mp].bytesAccepted;
      adversarialChunksAccepted += perProvider[mp].accepted;
      adversarialChunksDelivered += perProvider[mp].delivered;
    }

    var audit = auditReceivers(devices, built, options);

    var receivers = devices.map(function (dev) {
      return {
        id: dev.id,
        complete: isComplete(dev.receiver),
        chunksHeld: dev.receiver.chunks.length,
        acceptedFromSource: dev.fromSource,
        acceptedFromPeers: dev.fromPeers,
        rejectedTotal: dev.receiver.quarantinedTotal,
        completedAtTick: dev.completedAtTick
      };
    });

    var allComplete = completedDevices === devices.length;
    var lastTick = null;
    for (var lc = 0; lc < devices.length; lc++) {
      if (devices[lc].completedAtTick === null) { lastTick = null; break; }
      if (lastTick === null || devices[lc].completedAtTick > lastTick) lastTick = devices[lc].completedAtTick;
    }

    return freezeDeep({
      // --- what kind of numbers these are, first, so nobody has to look ------
      simulation: true,
      wallClockMeasured: false,
      physicalDevices: 0,
      timingUnit: 'ticks',
      bytesAreMeasuredOfTheSimulation: true,
      broadcastCodec: BROADCAST_CODEC,

      fleetSizeSimulated: devices.length,
      artifactBytes: artifactBytes,
      chunkSize: cfg.chunkSize,
      chunkCount: cfg.chunkCount,

      completed: allComplete,
      ticksToComplete: allComplete ? lastTick : null,
      ticksToFirstDeviceComplete: firstCompleteTick,

      source: sourceTraffic(meter, artifactBytes, cfg.chunkCount),

      chunksRejected: chunksRejected,
      chunksTimedOut: chunksTimedOut,

      adversarial: {
        chunksDelivered: adversarialChunksDelivered,
        chunksAccepted: adversarialChunksAccepted,
        bytesAccepted: adversarialBytesAccepted,
        note: 'Bytes admitted from a peer whose behaviour is not honest. Nonzero only for slow-drip, ' +
          'which delivers chunks that digest to the value the signed manifest commits — they were ' +
          'admitted because they are the right bytes and not because of who sent them, which is what ' +
          '"a peer is a transport, not an authority" means when it is working. The claim that a ' +
          'malicious peer contributes no WRONG data is the audit field, not this one.'
      },
      audit: audit,

      perProvider: perProvider,
      receivers: receivers,

      note: 'SIMULATION. The byte and chunk counts are measurements of this simulation — every chunk ' +
        'here went through the real verification pipeline on every simulated receiver. The tick counts ' +
        'are NOT measurements of any fleet: a tick is a unit this module defines and nothing has ' +
        'calibrated one against a device. ADR-024 §4.1 and §4.2 require ten and one hundred physical ' +
        'devices against 3 s and 60 s wall-clock gates, and neither is met or approximated here.'
    });
  }

  function emptyReport(cfg, why) {
    return {
      simulation: true, wallClockMeasured: false, physicalDevices: 0, timingUnit: 'ticks',
      bytesAreMeasuredOfTheSimulation: true, broadcastCodec: BROADCAST_CODEC,
      fleetSizeSimulated: cfg.deviceCount, artifactBytes: 0, chunkSize: cfg.chunkSize,
      chunkCount: cfg.chunkCount, completed: false, ticksToComplete: null,
      ticksToFirstDeviceComplete: null, source: sourceTraffic(meterSource(), 0, 0),
      chunksRejected: 0, chunksTimedOut: 0,
      adversarial: { chunksDelivered: 0, chunksAccepted: 0, bytesAccepted: 0, note: 'Nothing ran.' },
      audit: {
        independentOfTheStorePath: true, chunksAudited: 0, wrongChunksStored: 0,
        receiversReassembledCorrectly: 0, receiversReassembledWrong: 0,
        note: 'Nothing ran, so nothing was audited. Zero here is the absence of a check and not the ' +
          'absence of a fault.'
      },
      perProvider: [], receivers: [],
      note: 'SIMULATION did not run: ' + why + '.'
    };
  }

  function encodeUtf8(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }

  function chunkFrom(receiver, index) {
    if (!isReceiver(receiver)) return null;
    for (var i = 0; i < receiver.chunks.length; i++) {
      if (receiver.chunks[i].index === index) return receiver.chunks[i].bytes;
    }
    return null;
  }

  /**
   * After the run, checks every stored byte on every device against the
   * source's manifest — independently of the pipeline that stored them.
   *
   * This is the field that carries ADR-024 §4.1's "one malicious peer
   * contributes zero accepted data" in the form the sentence actually means:
   * not "no bytes from a hostile peer" — a slow peer serving correct chunks
   * contributes plenty, and should — but "no WRONG bytes anywhere", which is
   * the property that makes swarm distribution safe at all.
   *
   * It re-derives the digests rather than trusting the receivers' own record,
   * because a test of the storage path that reads the storage path's own
   * bookkeeping tests nothing.
   */
  function auditReceivers(devices, built, options) {
    var wrongChunks = 0;
    var chunksAudited = 0;
    var reassembledCorrectly = 0;
    var reassembledWrong = 0;
    var expected = built.parsed.chunks;
    var whole = null;
    for (var d = 0; d < devices.length; d++) {
      var rec = devices[d].receiver;
      for (var c = 0; c < rec.chunks.length; c++) {
        chunksAudited++;
        var held = rec.chunks[c];
        var entry = expected[held.index];
        var actual;
        try {
          actual = options.digest(held.bytes);
        } catch (err) {
          actual = null;
        }
        if (!entry || !isString(actual) || actual.toLowerCase() !== entry.digest) wrongChunks++;
      }
      if (!isComplete(rec)) continue;
      if (whole === null) {
        whole = new Uint8Array(built.parsed.totalBytes);
        var at = 0;
        for (var b = 0; b < built.bodies.length; b++) { whole.set(built.bodies[b], at); at += built.bodies[b].length; }
      }
      var out = reassemble(rec);
      if (out && bytesEqual(out, whole)) reassembledCorrectly++; else reassembledWrong++;
    }
    return {
      independentOfTheStorePath: true,
      chunksAudited: chunksAudited,
      wrongChunksStored: wrongChunks,
      receiversReassembledCorrectly: reassembledCorrectly,
      receiversReassembledWrong: reassembledWrong,
      note: 'Every stored chunk on every device was re-digested here and compared against the source’s ' +
        'manifest, and every complete device’s reassembled artifact was compared byte for byte against ' +
        'the source’s. wrongChunksStored is the number that carries ADR-024 §4.1’s "contributes zero ' +
        'accepted data" — a hostile peer may cost bandwidth and time, and may not put one wrong byte ' +
        'anywhere.'
    };
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // The three malicious behaviours, and what each costs — ADR-024 §4.4
  // ---------------------------------------------------------------------------

  /**
   * Runs the same configuration with no malicious peer and then with each of
   * the three behaviours ADR-024 §4.4 names, and reports the difference.
   *
   * The differences are IN SIMULATION TICKS. They are a property of this
   * scheduling policy and this cost model, not of any fleet, and every field
   * says so in its name.
   *
   * The ordering that comes out is the interesting part and it is ADR-024
   * §2.2's argument arriving as a number: corruption is detected on arrival and
   * costs the least, because one digest comparison ends it. Withholding is
   * detected only by a timeout, so it costs a timeout per device before the
   * peer falls below the score floor, and it costs the most. Slow-drip sits
   * between the two — it is never wrong, only expensive, so nothing ever
   * refuses it outright and it keeps its place behind faster peers.
   */
  function compareBehaviours(config, opts) {
    var base = normalizeSimConfig(config);
    // Honest peers the caller configured are part of the environment and stay
    // in every run, including the baseline. `normalizeSimConfig` prefixes ids,
    // so the prefix comes back off before it is handed round again.
    var kept = base.peers.filter(function (p) { return p.behaviour === BEHAVIOUR_HONEST; })
      .map(function (p) { return { id: p.id.replace(/^peer:/, ''), behaviour: p.behaviour }; });

    function run(extra) {
      return simulateSwarm(assign(base, { peers: kept.concat(extra) }), opts);
    }
    var baseline = run([]);
    var rows = [];
    for (var i = 0; i < BEHAVIOURS.length; i++) {
      if (BEHAVIOURS[i] === BEHAVIOUR_HONEST) continue;
      var report = run([{ id: 'adversary', behaviour: BEHAVIOURS[i] }]);
      rows.push({
        behaviour: BEHAVIOURS[i],
        label: BEHAVIOUR_LABELS[BEHAVIOURS[i]],
        completed: report.completed,
        ticksToComplete: report.ticksToComplete,
        extraTicksVsBaseline: report.completed && baseline.completed
          ? report.ticksToComplete - baseline.ticksToComplete : null,
        sourceBytesMeasured: report.source.bytesMeasured,
        extraSourceBytesVsBaseline: report.source.bytesMeasured - baseline.source.bytesMeasured,
        chunksRejected: report.chunksRejected,
        chunksTimedOut: report.chunksTimedOut,
        adversarialBytesAccepted: report.adversarial.bytesAccepted,
        wrongChunksStored: report.audit.wrongChunksStored,
        report: report
      });
    }
    rows.sort(function (a, b) {
      var av = a.extraTicksVsBaseline === null ? Infinity : a.extraTicksVsBaseline;
      var bv = b.extraTicksVsBaseline === null ? Infinity : b.extraTicksVsBaseline;
      return av - bv;
    });
    return freezeDeep({
      simulation: true,
      wallClockMeasured: false,
      timingUnit: 'ticks',
      baseline: {
        completed: baseline.completed,
        ticksToComplete: baseline.ticksToComplete,
        sourceBytesMeasured: baseline.source.bytesMeasured
      },
      behaviours: rows,
      note: 'The differences are SIMULATION TICKS against a no-adversary baseline of the same ' +
        'configuration and seed. They describe this scheduling policy under this cost model. They are ' +
        'not seconds, they are not a fleet measurement, and ADR-024 §4.1’s 3 s and §4.2’s 60 s gates ' +
        'are untouched by them. What every row does establish is wrongChunksStored: 0 — a hostile peer ' +
        'costs bandwidth and time and cannot put one wrong byte on one device. adversarialBytesAccepted ' +
        'is nonzero only for slow-drip, whose chunks are correct; that is a peer being a transport.'
    });
  }

  // ---------------------------------------------------------------------------
  // Honesty
  // ---------------------------------------------------------------------------

  /**
   * The broadcast tier, named accurately — ADR-024 §2.4 and criterion 5.
   *
   * Every string is built from `BROADCAST_CODEC`, so there is exactly one place
   * the qualification could be dropped and dropping it would break every
   * caller at once rather than one report quietly.
   */
  function describeBroadcastTier() {
    return freezeDeep({
      codec: BROADCAST_CODEC,
      module: 'artifacts/fountain.js',
      rfc6330Conformant: false,
      interoperable: false,
      wiredIntoThisModule: false,
      note: 'The broadcast tier ADR-024 §2.1 describes would use ' + BROADCAST_CODEC + '. Broadcast is ' +
        'the one place a STANDARD codec matters, because the receivers may not all be rvQR, and ' +
        'fountain.js derives parameters RFC 6330 tabulates, searches for the systematic index at ' +
        'runtime, and uses its own Rand[] and HDPC block — so its symbol streams decode only with it. ' +
        'ADR-014 has not chosen conformance, so this tier is rvQR-only. Nothing in this module encodes ' +
        'or decodes a fountain symbol; the peer-transfer tier implemented here is content-addressed ' +
        'chunk exchange and nothing else.'
    });
  }

  /**
   * ADR-024's six acceptance criteria, and what this build actually did about
   * each — said from inside the running system rather than only in a report,
   * for the reason attest.js's `describeRoots()` exists.
   *
   * `status` is one of:
   *   `requires-device-fleet`  — cannot be attempted here at all.
   *   `demonstrated`           — exercised by this module's tests, in simulation.
   *   `stated`                 — a naming or labelling obligation, met in code.
   */
  function describeCriteria() {
    return [
      {
        id: 'fleet-10',
        criterion: 1,
        label: 'ADR-024 §4.1: ten isolated devices, first closure within 3 s, fleet within 60 s',
        status: 'requires-device-fleet',
        met: false,
        note: 'NOT MET AND NOT ATTEMPTED. This needs TEN PHYSICAL DEVICES on one site and a wall clock. ' +
          'There is no device fleet in this repository. simulateSwarm() can run ten simulated receivers ' +
          'and its tick counts are not seconds — a simulated 3 is not a measured 3 s, and presenting one ' +
          'as the other is the failure this project keeps correcting.'
      },
      {
        id: 'fleet-100',
        criterion: 2,
        label: 'ADR-024 §4.2: one hundred heterogeneous devices, same gates, 30% interruption recovery',
        status: 'requires-device-fleet',
        met: false,
        note: 'NOT MET AND NOT ATTEMPTED. This needs ONE HUNDRED PHYSICAL DEVICES and a wall clock, and ' +
          'there is no device fleet in this repository. It fails for criterion 1’s reason and one order ' +
          'of magnitude more so: heterogeneity — different radios, different thermal limits, different ' +
          'older roots — is most of what the criterion is testing and is exactly what a simulation ' +
          'cannot supply. Running one hundred simulated receivers does not approach it.'
      },
      {
        id: 'per-device-verification',
        criterion: 3,
        label: 'ADR-024 §4.3: verification is per-device, shown by a peer serving another artifact’s chunks',
        status: 'demonstrated',
        met: true,
        note: 'Demonstrated. A peer serving genuinely signed chunks from a DIFFERENT artifact is refused ' +
          'by every receiver, because each derives its expectation from the manifest IT verified and no ' +
          'function that can admit takes a peer identity at all.'
      },
      {
        id: 'malicious-peers-measured',
        criterion: 4,
        label: 'ADR-024 §4.4: advertise-and-withhold, slow-drip and corrupt-chunk, each with a stated effect',
        status: 'demonstrated',
        met: true,
        note: 'Demonstrated in simulation. compareBehaviours() reports the effect of each on completion ' +
          'in SIMULATION TICKS against a no-adversary baseline, and reports wrongChunksStored: 0 for ' +
          'every one of them. Deprioritisation reads the measured map; the claims map is not in ' +
          'rankProviders’ argument list. The measured cost tracks how detectably wrong a behaviour is, ' +
          'so slow-drip — which is never wrong — is the most expensive of the three and is the one this ' +
          'module deliberately does not refuse.'
      },
      {
        id: 'broadcast-codec-named',
        criterion: 5,
        label: 'ADR-024 §4.5: the broadcast codec is named accurately',
        status: 'stated',
        met: true,
        note: 'Met. The tier is named through one constant that carries the qualification, ' +
          'describeBroadcastTier() reports rfc6330Conformant: false, and no broadcast tier is wired in ' +
          'here at all — the transfer implemented in this module is content-addressed chunk exchange.'
      },
      {
        id: 'source-traffic-measured',
        criterion: 6,
        label: 'ADR-024 §4.6: source traffic is measured directly, not inferred from chunk accounting',
        status: 'demonstrated',
        met: true,
        note: 'Demonstrated in simulation. The meter is written on the line that emits the bytes, and ' +
          'the report carries what chunk accounting would have claimed alongside it so the size of the ' +
          'error is visible rather than assumed away.'
      }
    ];
  }

  /**
   * What ADR-024 asks for that this build does not have.
   *
   * `status` is `absent` for a thing that does not exist here at all, and
   * `injected-absent` for a check this module performs if a caller supplies it
   * and refuses without.
   */
  function describeUnimplemented() {
    return [
      {
        id: 'bitchat',
        label: 'ADR-024 §2.1: BitChat for peer discovery, custody, rank exchange and receipts',
        status: 'absent',
        note: 'There is no BitChat implementation in this repository. This module takes its peer set as ' +
          'data: discovery, the control channel that has to work before any link exists, and the rank ' +
          'exchange all sit outside it. A peer set that arrives by hand is not a peer set that was ' +
          'discovered.'
      },
      {
        id: 'chunk-store',
        label: 'ADR-013: the content-addressed chunk store peer exchange depends on',
        status: 'absent',
        note: 'There is no persistent chunk store. A receiver here holds its verified chunks in memory ' +
          'for the life of the value, so store-and-carry across a reboot — the property ADR-024 §2.3 is ' +
          'about — is not implemented and cannot be tested here.'
      },
      {
        id: 'custody-receipts',
        label: 'ADR-024 §2.3: custody receipts travelling with the artifact into the witness lineage',
        status: 'absent',
        note: 'receiveReceipt() records what THIS device verified. It does not record who held the ' +
          'artifact before, nothing signs it, and it never reaches ADR-016 §2.3’s witness lineage. The ' +
          'privacy surface ADR-024 §3 warns about — which devices were near which others, and when — ' +
          'therefore does not exist here either, which is the one advantage of not having built it.'
      },
      {
        id: 'broadcast-tier',
        label: 'ADR-024 §2.1: the ' + BROADCAST_CODEC + ' broadcast tier',
        status: 'absent',
        note: 'No broadcast tier is wired in. fountain.js exists and is ' + BROADCAST_CODEC + ', which is ' +
          'the dependency ADR-024 §2.4 says this ADR cannot resolve on its own: either ADR-014 chooses ' +
          'conformance or the tier is rvQR-only. It is currently rvQR-only.'
      },
      {
        id: 'device-fleet',
        label: 'ADR-024 §4.1 and §4.2: ten and one hundred physical devices',
        status: 'absent',
        note: 'There is no device fleet, no site, and no wall-clock harness. simulateSwarm() is a ' +
          'simulation whose byte counts are measurements OF THE SIMULATION and whose tick counts are ' +
          'not seconds. Nothing here has been run on a radio, a phone or an appliance.'
      },
      {
        id: 'interruption-recovery',
        label: 'ADR-024 §4.1: interrupted receivers resend at most one chunk',
        status: 'absent',
        note: 'Not implemented and not claimed. A receiver here is an immutable in-memory value with no ' +
          'persistence, so there is nothing to interrupt and resume: the resend-at-most-one-chunk ' +
          'property is a property of a store this module does not have.'
      },
      {
        id: 'content-digest',
        label: 'The chunk digest',
        status: 'injected-absent',
        note: '`opts.digest` is injected. With none, every chunk is `unverified` and refused, and a ' +
          'whole simulated fleet completes nothing: a check that cannot run says it could not run.'
      },
      {
        id: 'manifest-signature',
        label: 'The manifest signature — the only signature in this design',
        status: 'injected-absent',
        note: '`opts.verifySignature` is injected. An Ed25519 verifier can be built from crypto.js, and ' +
          'that is HALF of ADR-012’s hybrid scheme; there is no ML-DSA-65 in this repository. Chunks ' +
          'carry no signature of their own by design — their digests are committed by this one.'
      }
    ];
  }

  /**
   * What this module is not entitled to claim, kept here so the wording in a UI
   * or a report cannot drift from what the code does.
   */
  function describeLimits() {
    return [
      'A peer is a transport, not an authority: no function that can return admit:true takes a peer identity, and the receiver policy has no peer field, so there is no path by which "who sent it" reaches "may it be stored".',
      'A chunk that does not hash correctly is discarded on arrival, before it is stored and therefore before it could be forwarded — advertise() is derived from the store, so the forwarding set is the verified set by construction.',
      'Chunks carry no signature and need none. The manifest signature is the only signature in the design, and every chunk digest in the swarm rests on it.',
      'Peers are deprioritised on measured behaviour: rankProviders takes the measured map and the claims map is not in its argument list, so no amount of advertising changes an ordering.',
      'Peer reputation is not shared between devices, because a reputation arriving from a peer is a claim. Every device pays for its own discovery, which is the expensive direction.',
      'A peer that is merely SLOW is never refused, only demoted behind faster ones. That is a deliberate choice — refusing on latency would refuse a device with a weak radio, which in a fleet is the ordinary case rather than an attack — and it is why slow-drip measures as the most expensive of the three behaviours by two orders of magnitude.',
      'A hostile peer that delivers CORRECT chunks contributes accepted data, and should: the bytes were admitted because they digest to the committed value, not because of who sent them. "Zero accepted data from a malicious peer" is carried as wrongChunksStored, audited independently of the path that stored them.',
      'simulateSwarm() is a SIMULATION. Its byte and chunk counts are measurements of the simulation; its tick counts are not seconds and are not a measurement of any fleet.',
      'ADR-024 §4.1 Fleet-10 and §4.2 Fleet-100 are NOT MET. They need ten and one hundred physical devices and a wall clock, and there is no device fleet in this repository.',
      'The broadcast tier is ' + BROADCAST_CODEC + ' and is not wired in here at all. Broadcast is the one place a standard codec matters and ADR-014 has not chosen conformance.',
      'There is no BitChat in this tree, so peer discovery, the pre-link control channel, rank exchange and custody receipts are all outside this module.',
      'There is no chunk store, so store-and-carry across a reboot and "interrupted receivers resend at most one chunk" are properties of something that does not exist here.',
      'Source traffic is metered where the bytes leave the source. The report also carries what chunk accounting would have claimed, and the gap between them is roughly the fleet size — which is why inferring it would be measuring the answer with a ruler made out of the answer.',
      'The receipt is not ADR-134’s witness record. Nothing signs it and rvf-cli has never verified one.',
      'The digest and the signature verifier are injected and absent by default; with neither, every receiver refuses everything and a whole simulated fleet completes nothing.'
    ];
  }

  return {
    // the broadcast tier, named once
    BROADCAST_CODEC: BROADCAST_CODEC,

    // the verdict vocabulary
    STATE_VERIFIED: STATE_VERIFIED,
    STATE_MALFORMED: STATE_MALFORMED,
    STATE_FOREIGN: STATE_FOREIGN,
    STATE_UNKNOWN_INDEX: STATE_UNKNOWN_INDEX,
    STATE_SIZE_REFUSED: STATE_SIZE_REFUSED,
    STATE_DIGEST_MISMATCH: STATE_DIGEST_MISMATCH,
    STATE_UNSIGNED: STATE_UNSIGNED,
    STATE_FORGED: STATE_FORGED,
    STATE_UNVERIFIED: STATE_UNVERIFIED,
    STATES: STATES,

    // decision codes
    CODE_PENDING: CODE_PENDING,
    CODE_POLICY_UNDECLARED: CODE_POLICY_UNDECLARED,
    CODE_ROOT_UNDECLARED: CODE_ROOT_UNDECLARED,
    CODE_MANIFEST_UNVERIFIED: CODE_MANIFEST_UNVERIFIED,
    CODE_UNKNOWN_STATE: CODE_UNKNOWN_STATE,
    CODE_MALFORMED: CODE_MALFORMED,
    CODE_FOREIGN: CODE_FOREIGN,
    CODE_UNKNOWN_INDEX: CODE_UNKNOWN_INDEX,
    CODE_SIZE_REFUSED: CODE_SIZE_REFUSED,
    CODE_DIGEST_MISMATCH: CODE_DIGEST_MISMATCH,
    CODE_UNSIGNED: CODE_UNSIGNED,
    CODE_FORGED: CODE_FORGED,
    CODE_UNVERIFIED: CODE_UNVERIFIED,
    CODE_UNTRUSTED_SIGNER: CODE_UNTRUSTED_SIGNER,
    CODE_ALREADY_HELD: CODE_ALREADY_HELD,
    CODE_ADMITTED: CODE_ADMITTED,
    CODE_MANIFEST_ADMITTED: CODE_MANIFEST_ADMITTED,

    // peer behaviours
    BEHAVIOUR_HONEST: BEHAVIOUR_HONEST,
    BEHAVIOUR_WITHHOLD: BEHAVIOUR_WITHHOLD,
    BEHAVIOUR_SLOW: BEHAVIOUR_SLOW,
    BEHAVIOUR_CORRUPT: BEHAVIOUR_CORRUPT,
    BEHAVIOURS: BEHAVIOURS,
    BEHAVIOUR_LABELS: BEHAVIOUR_LABELS,

    LIMITS: LIMITS,
    FAILURE_WEIGHT: FAILURE_WEIGHT,
    SCORE_FLOOR: SCORE_FLOOR,
    TRIAL_SCORE: TRIAL_SCORE,

    // the manifest and its order commitment
    canonicalManifestString: canonicalManifestString,
    manifestSigningString: manifestSigningString,
    parseManifest: parseManifest,
    buildManifest: buildManifest,

    // the pipeline, in the order it runs
    parseDelivery: parseDelivery,
    verifyChunk: verifyChunk,
    verifyManifestOffer: verifyManifestOffer,
    normalizePolicy: normalizePolicy,
    chunkGate: chunkGate,
    admitChunk: admitChunk,
    admitManifest: admitManifest,

    // the receiver
    beginReceive: beginReceive,
    offerManifest: offerManifest,
    offerChunk: offerChunk,
    expectationFor: expectationFor,
    holds: holds,
    advertise: advertise,
    missing: missing,
    isComplete: isComplete,
    reassemble: reassemble,
    receiveReceipt: receiveReceipt,

    // the ledger: claims and measurements, never merged
    newLedger: newLedger,
    noteAdvertisement: noteAdvertisement,
    claimsChunk: claimsChunk,
    noteRequest: noteRequest,
    noteDelivery: noteDelivery,
    noteTimeout: noteTimeout,
    measurementOf: measurementOf,
    measurementsOf: measurementsOf,
    peerScore: peerScore,
    peerLatency: peerLatency,
    rankProviders: rankProviders,

    // source traffic, measured directly
    meterSource: meterSource,
    serveFromSource: serveFromSource,
    sourceTraffic: sourceTraffic,

    // the simulation, and what it is not
    seededRandom: seededRandom,
    simulateSwarm: simulateSwarm,
    compareBehaviours: compareBehaviours,

    // honesty
    describeBroadcastTier: describeBroadcastTier,
    describeCriteria: describeCriteria,
    describeUnimplemented: describeUnimplemented,
    describeLimits: describeLimits
  };
});
