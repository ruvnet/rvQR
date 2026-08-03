/*!
 * rvQR progressive verified activation — four independently signed closures,
 * one gate applied four times.
 *
 * Per ADR-022. [ADR-016](docs/adr/ADR-016-rvqr-verified-execution.md) makes
 * verification total, and applied to a whole artifact that means
 * time-to-first-useful-state equals transfer time. ADR-022 splits the artifact
 * instead: manifest and policy, minimal RVM runtime, required code and hot
 * state, cold indexes and optional assets. The agent starts once 1–3 verify
 * while 4 is still crossing the channel.
 *
 * ---------------------------------------------------------------------------
 * THE GATE IS NOT WEAKENED. IT IS APPLIED MORE TIMES — ADR-022 §2.1
 * ---------------------------------------------------------------------------
 *
 * Every closure walks the whole ADR-016 §2.2 pipeline before one byte of it is
 * used, in that order and with no step optional:
 *
 *   order → artifact identity → declared size → bounded decompression →
 *   content digest → signature → admission
 *
 * What changes between ADR-016 and here is the UNIT, not the strictness. A
 * closure that fails is a closure that does not run, and a failed closure in the
 * activation set stops the activation outright — closure 1 failing stops
 * everything, because the policy that says what any later closure may do is
 * inside closure 1.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS SIGNED, SO IT CANNOT BE REORDERED — ADR-022 §2.2
 * ---------------------------------------------------------------------------
 *
 * Three independent things have to hold before a closure is looked at, and each
 * of them defeats a different attack:
 *
 *   1. **Position.** A closure is only ever compared against the ONE closure
 *      this receiver expects next. Offer closure 3 before closure 1 has
 *      verified and there is nothing to compare it to at all — no digest, no
 *      role, no signer — so it is refused without being parsed for content,
 *      inflated, digested or handed to a signature verifier. This is ADR-022
 *      §2.2's argument in code: the manifest that says what closure 3 is lives
 *      in closure 1.
 *
 *   2. **Artifact identity.** Every closure names the artifact it belongs to,
 *      and that name is compared against the verified manifest's. A valid
 *      closure 3 lifted out of a different artifact is refused as `foreign`.
 *
 *   3. **The committed digest.** `closures[]` in the manifest is an ORDERED
 *      list with no index fields: an entry's position IS its index. Reordering
 *      the list therefore changes the manifest's canonical bytes, changes its
 *      digest, and the pinned root refuses closure 1 — so a reordered artifact
 *      never starts, rather than starting in the wrong order.
 *
 * A fourth falls out of the signing string: a signature covers artifactId,
 * index, role and digest together, so even a closure whose digest collided
 * with ours carries a signature over another artifact's name.
 *
 * **A closure cannot nominate the key that checks it.** The offer carries no
 * signer field at all. The pinned root names closure 1's signer; the verified
 * manifest names the rest. There is no path by which the bytes being checked
 * choose the check.
 *
 * ---------------------------------------------------------------------------
 * QUARANTINE IS STRUCTURAL, NOT PROCEDURAL — ADR-022 §2.3, ADR-016 §2.4
 * ---------------------------------------------------------------------------
 *
 * The session never holds the bytes of a closure that did not verify. Not in a
 * pending buffer, not in a staging area, not behind a flag. There is exactly
 * one place in this file where offered bytes are copied into a session, it sits
 * after `admitClosure` returned `admit: true`, and a refused offer contributes
 * only a descriptor — index, role, state, code, reason, declared length. A
 * running agent cannot reach closure 4 because there is nothing to reach: the
 * refused or outstanding bytes were never taken.
 *
 * `agentView(session)` is the only thing an activated agent is given. It is
 * built fresh, holds no reference back to the session, and exposes closure
 * contents ONLY while the gate is open — and never the cold closure until the
 * whole artifact has verified. A verified closure 2 sitting behind a closure 3
 * that has not arrived is not reachable either: ADR-022 §2.1 says the agent
 * starts once closures 1–3 verify, so a partial activation set activates
 * nothing.
 *
 * What this cannot do, and does not pretend to: the caller already holds the
 * bytes it offered, and a caller holding the session can write into the copies
 * inside it. JavaScript has no way to stop either. Quarantine here is a
 * property of what the session and the agent view can reach, which is the part
 * that is actually enforceable.
 *
 * ---------------------------------------------------------------------------
 * FAILURE SEMANTICS ARE DECIDED, NOT DISCOVERED — ADR-022 §2.3
 * ---------------------------------------------------------------------------
 *
 * If closure 4 never verifies the agent keeps running on 1–3 and the artifact
 * is `incomplete`. That is a DISTINCT state, not a degraded complete one:
 *
 *   - `sealIncomplete()` is an explicit decision, and after it a perfectly
 *     valid closure 4 is refused with `sealed-incomplete`. The artifact does
 *     not silently acquire the cold state later.
 *   - `complete` is reachable only by verifying every closure the manifest
 *     declares, and a sealed artifact can never reach it.
 *   - the receipt carries `completion`, `complete` and `verifiedWholeArtifact`
 *     as separate named fields, so no reader can mistake "running" for
 *     "verified whole" — the same rule attest.js applies to keeping
 *     "attested and approved" apart from "nobody asked".
 *
 * A refused closure INSIDE the activation set is fatal to the activation and
 * leaves it `blocked`; recovery is a new activation from the pinned root, not a
 * retry into the same one. A refused COLD closure is not fatal — the agent is
 * already running and the cold state may be re-offered until it verifies or the
 * artifact is sealed. An out-of-order stray never blocks anything, because a
 * peer that can block an activation by shouting the wrong frame number has a
 * denial of service for free.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IMPLEMENTED HERE. READ THIS BEFORE QUOTING A NUMBER.
 * ---------------------------------------------------------------------------
 *
 * `describeUnimplemented()` says all of this from inside the running system,
 * for the reason attest.js's `describeRoots()` does: a caveat that lives only
 * in a report is a caveat that stops being read.
 *
 *   - **There is no radio tier.** No QUIC and no radio transport exists in this
 *     repository. ADR-022 §4.5's "under 3 s at p95 on the radio tier" cannot be
 *     measured here, and nothing in this module may be presented as having
 *     measured it. Simulating a radio and reporting the result as if observed
 *     would be the dishonest option.
 *
 *   - **There are no hybrid signatures.** crypto.js exposes Ed25519 only; there
 *     is no ML-DSA-65 anywhere in this repository, so ADR-012's hybrid scheme
 *     is half-implemented at best. ADR-022 §4.5 explicitly warns that measuring
 *     with Ed25519 alone "would flatter the result", so an Ed25519 timing IS
 *     NOT a criterion-5 result and this module labels every hybrid figure it
 *     produces as an arithmetic PROJECTION over ADR-022's own 3,309 bytes per
 *     ML-DSA-65 signature.
 *
 *   - **Nothing splits an artifact.** No tool in this repository turns an RVF
 *     container into closures. ADR-022 §3 calls this out: deciding what is hot
 *     and what is cold is artifact-specific and the tooling does not exist. The
 *     closures this module verifies are constructed by its caller.
 *
 *   - **Nothing executes.** There is no RVM here. "Running" in this file means
 *     the gate opened and the activated bytes are readable, not that any code
 *     ran; ADR-016 §2.2's step 6 — the handoff to RVM, its capability check and
 *     its witness record — does not exist, so this is one half of an invariant
 *     ADR-016 states twice.
 *
 *   - **The receipt is not a witness record.** ADR-016 §2.3 binds the receipt
 *     to ADR-134's format. `activationReceipt()` returns a plain object that
 *     `rvf-cli verify-witness` has never seen. It is the shape of what a
 *     receipt must carry about a partial activation, not the receipt.
 *
 *   - **Digest, decompression and signature checking are all injected, and all
 *     absent by default.** With no digest function, or no signature verifier,
 *     or a compressed closure and no inflater, the verdict is `unverified` and
 *     the gate refuses. A check that cannot run reports that it could not run
 *     and never degrades into a pass — provenance.js's rule for `sha256` and
 *     attest.js's for `verifyChain`.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything here is a pure function over plain data: no DOM, no storage, no
 * network and no clock. A session is an immutable value — `offerClosure` returns
 * a new one and never writes to the one it was given — so the same offers in
 * the same order produce the same session, and a caller cannot mutate a
 * refusal into an admission.
 *
 * Trust asymmetry follows provenance.js and attest.js: `parseOffer` and
 * `parseManifest` never throw, because their input arrived from whatever is on
 * the other end of the link.
 *
 * Browser: load this file; it needs nothing else.
 * Node:    require('./closure.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRClosure = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- The four closures, ADR-022 §2.1 ---------------------------------------
  // A closed vocabulary. A role nobody has defined must not reach a comparison
  // as an opaque string, so an unknown one is refused where it is read.

  /** Closure 1: manifest + policy. Committed by the pinned root, not by itself. */
  var ROLE_MANIFEST = 'manifest';

  /** Closure 2: minimal RVM runtime. */
  var ROLE_RUNTIME = 'runtime';

  /** Closure 3: required code and hot state. */
  var ROLE_CODE = 'code';

  /** Closure 4: cold indexes and optional assets. The one the agent runs without. */
  var ROLE_COLD = 'cold';

  var ROLES = [ROLE_MANIFEST, ROLE_RUNTIME, ROLE_CODE, ROLE_COLD];

  /**
   * The activation set: ADR-022 §2.1's "the agent starts once closures 1–3
   * verify". Every role outside it is cold, and cold is what the agent is
   * allowed to be missing.
   */
  var ACTIVATION_ROLES = [ROLE_MANIFEST, ROLE_RUNTIME, ROLE_CODE];

  var ROLE_LABELS = {
    'manifest': 'manifest and policy',
    'runtime': 'minimal RVM runtime',
    'code': 'required code and hot state',
    'cold': 'cold indexes and optional assets'
  };

  // --- The verdict vocabulary ------------------------------------------------
  // Closed, and the gate switches over it exhaustively. A state outside this
  // list is refused as unknown rather than falling through — ADR-035 §2.1's
  // rule, which ADR-022 §3 names as the failure most likely to recur here.

  /** Bounded, in order, digested, signed and readable. */
  var STATE_VERIFIED = 'verified';

  /** Arrived and could not be read as a closure at all. */
  var STATE_MALFORMED = 'malformed';

  /** Reads fine, and belongs to a different artifact. */
  var STATE_FOREIGN = 'foreign';

  /** Not the closure this receiver expects next. Refused before it is looked at. */
  var STATE_UNORDERED = 'out-of-order';

  /** The declared original size is not the committed one, or is past a ceiling. */
  var STATE_SIZE_REFUSED = 'size-refused';

  /** Decompression exceeded the declared original size, or could not be done. */
  var STATE_INFLATION_REFUSED = 'inflation-refused';

  /** The bytes are not the bytes the manifest described. */
  var STATE_DIGEST_MISMATCH = 'digest-mismatch';

  /** No signature was offered for a closure that must carry one. */
  var STATE_UNSIGNED = 'unsigned';

  /** A signature verifier ran and said no. */
  var STATE_FORGED = 'forged';

  /** A check could not be performed: no digest function, no verifier, no answer. */
  var STATE_UNVERIFIED = 'unverified';

  var STATES = [
    STATE_VERIFIED, STATE_MALFORMED, STATE_FOREIGN, STATE_UNORDERED,
    STATE_SIZE_REFUSED, STATE_INFLATION_REFUSED, STATE_DIGEST_MISMATCH,
    STATE_UNSIGNED, STATE_FORGED, STATE_UNVERIFIED
  ];

  // --- Decision codes --------------------------------------------------------
  // Stable strings, matching attest.js, delta.js, semdelta.js and planner.js:
  // callers switch on the code, the reason is for people.

  var CODE_PENDING = 'pending';
  var CODE_POLICY_UNDECLARED = 'policy-undeclared';
  var CODE_ROOT_UNDECLARED = 'root-undeclared';
  var CODE_BLOCKED = 'activation-blocked';
  var CODE_SEALED_INCOMPLETE = 'sealed-incomplete';
  var CODE_UNKNOWN_STATE = 'unknown-closure-state';
  var CODE_MALFORMED = 'malformed-closure';
  var CODE_FOREIGN = 'foreign-closure';
  var CODE_UNORDERED = 'out-of-order-closure';
  var CODE_SIZE_REFUSED = 'size-refused';
  var CODE_INFLATION_REFUSED = 'inflation-refused';
  var CODE_DIGEST_MISMATCH = 'digest-mismatch';
  var CODE_UNSIGNED = 'unsigned-closure';
  var CODE_FORGED = 'forged-signature';
  var CODE_UNVERIFIED = 'unverified-closure';
  var CODE_UNTRUSTED_SIGNER = 'untrusted-signer';
  var CODE_ROLE_REFUSED = 'role-refused';
  var CODE_ADMITTED = 'closure-admitted';

  // --- Completion states -----------------------------------------------------
  // ADR-022 §2.3: partially verified is a distinct state, not a degraded
  // complete one, so it has its own name and the receipt carries it.

  /** No root pinned, or a closure in the activation set was refused. */
  var COMPLETION_BLOCKED = 'blocked';

  /** The activation set has not finished verifying. Nothing runs yet. */
  var COMPLETION_TRANSFERRING = 'transferring';

  /** Closures 1–3 verified, the agent is running, the cold state is outstanding. */
  var COMPLETION_PARTIAL = 'partial';

  /** Every closure the manifest declares has verified. */
  var COMPLETION_COMPLETE = 'complete';

  /** Decided: the cold state never verified and this artifact will run without it. */
  var COMPLETION_INCOMPLETE = 'incomplete';

  var COMPLETIONS = [
    COMPLETION_BLOCKED, COMPLETION_TRANSFERRING, COMPLETION_PARTIAL,
    COMPLETION_COMPLETE, COMPLETION_INCOMPLETE
  ];

  // --- Hostile-input ceilings ------------------------------------------------
  // A closure arrives from the other end of the link. Every value below bounds
  // something that end controls, and each is checked before it reaches an
  // allocation, a loop or a decompressor.

  var LIMITS = {
    identifier: 256,
    digestHex: 128,
    // Generous on purpose: an ML-DSA-65 signature is 3,309 bytes and a hybrid
    // one more, and a ceiling that refused the scheme ADR-012 selects would be
    // a limit pretending to be a policy. Nothing here implements either.
    signatureHex: 16384,
    closures: 16,
    closureBytes: 64 * 1024 * 1024,
    manifestBytes: 1024 * 1024,
    // Diagnostics only. Unlike attest.js's consumed-nonce list, truncating this
    // cannot change an answer — nothing reads it to decide anything — so it is
    // capped and the DROPPED COUNT is kept and reported rather than the record
    // silently shrinking.
    quarantineEntries: 64
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

  // ---------------------------------------------------------------------------
  // The manifest — the closure list, its digests, and its ORDER
  // ---------------------------------------------------------------------------

  /**
   * The canonical bytes of a manifest, as a string. Deterministic, and the
   * thing the root's digest is taken over.
   *
   * Entries carry NO index field: an entry's position in the list is its index.
   * That is the whole ordering mechanism — swap two entries and this string
   * changes, so the digest changes, so the pinned root refuses closure 1 and
   * the artifact never starts. An index field would have let a reordered list
   * describe the same artifact, which is exactly what ADR-022 §2.2 forbids.
   *
   * Closure 1 is absent from the list because a manifest cannot contain its own
   * digest. The chain is: pinned root commits closure 1, closure 1 commits
   * closures 2..n.
   */
  function canonicalManifestString(manifest) {
    var m = manifest || {};
    var closures = Array.isArray(m.closures) ? m.closures : [];
    var parts = ['rvqr-closure-manifest/1', String(m.artifactId), String(m.signerId)];
    for (var i = 0; i < closures.length; i++) {
      var c = closures[i] || {};
      parts.push([String(i + 2), String(c.role), String(c.digest), String(c.originalSize)].join(':'));
    }
    return parts.join('\n');
  }

  /**
   * Reads a manifest. Returns { ok, manifest, reason } and never throws: these
   * bytes arrived over the link, inside closure 1, and closure 1 is exactly the
   * closure nothing else can vouch for.
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
    if (!Array.isArray(input.closures)) {
      return { ok: false, reason: 'closures must be an array of the closures after closure 1' };
    }
    if (!input.closures.length) {
      return { ok: false, reason: 'a manifest that commits to no further closure describes nothing to activate' };
    }
    if (input.closures.length > LIMITS.closures - 1) {
      return {
        ok: false,
        reason: 'the manifest declares ' + input.closures.length + ' closures after closure 1, over the limit of ' +
          (LIMITS.closures - 1)
      };
    }

    var closures = [];
    var seenCold = false;
    var seenActivationRoles = [];
    for (var i = 0; i < input.closures.length; i++) {
      var c = input.closures[i];
      var at = 'closure ' + (i + 2);
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return { ok: false, reason: at + ' is not an object' };
      }
      if (ROLES.indexOf(c.role) < 0) {
        return {
          ok: false,
          reason: at + ' claims role ' + JSON.stringify(String(c.role).slice(0, 40)) +
            ', which is not one of ' + ROLES.join(', ')
        };
      }
      if (c.role === ROLE_MANIFEST) {
        return {
          ok: false,
          reason: at + ' claims to be a manifest. Closure 1 is the manifest and it is committed by the ' +
            'pinned root; a second one would be a policy the first policy did not authorise'
        };
      }
      // The activation set is a PREFIX. Cold state interleaved with hot state
      // would make "the agent starts once 1–3 verify" undefinable, so a manifest
      // that puts cold before hot is refused rather than reinterpreted.
      if (c.role === ROLE_COLD) seenCold = true;
      else if (seenCold) {
        return {
          ok: false,
          reason: at + ' is in the activation set but follows a cold closure. The activation set must be a ' +
            'prefix, or "the agent starts once closures 1–3 verify" has no meaning'
        };
      }
      // An activation role appears at most once. Two closures claiming to be
      // the runtime is a question with no answer — which one runs — and
      // "whichever verified last" is the shape of bug this whole file exists to
      // avoid. Cold closures may repeat: "cold indexes and optional assets" is
      // naturally several things, and none of them is addressed by role.
      else if (seenActivationRoles.indexOf(c.role) >= 0) {
        return {
          ok: false,
          reason: at + ' is a second closure claiming the role ' + JSON.stringify(c.role) +
            '. An activation role names one closure, or which of them the agent runs is undefined'
        };
      } else {
        seenActivationRoles.push(c.role);
      }
      if (!isDigestHex(c.digest)) {
        return { ok: false, reason: at + ' has no even-length lowercase hex digest inside the ceiling' };
      }
      if (!isInteger(c.originalSize) || c.originalSize < 0 || c.originalSize > LIMITS.closureBytes) {
        return { ok: false, reason: at + ' declares an original size that is not a non-negative integer inside the ceiling' };
      }
      closures.push({ index: i + 2, role: c.role, digest: c.digest, originalSize: c.originalSize });
    }

    // Closure 1 is the manifest, so the activation set is 1 plus the leading
    // non-cold entries.
    var activationCount = 1;
    for (var a = 0; a < closures.length && closures[a].role !== ROLE_COLD; a++) activationCount++;

    return {
      ok: true,
      manifest: {
        artifactId: input.artifactId,
        signerId: input.signerId,
        closures: closures,
        totalCount: closures.length + 1,
        activationCount: activationCount
      }
    };
  }

  // ---------------------------------------------------------------------------
  // The offer — one closure as it arrives, read without trusting it
  // ---------------------------------------------------------------------------

  /**
   * What a signature covers: the artifact, the position, the role and the
   * content digest, together. Binding all four is what stops a genuinely signed
   * closure 3 from one artifact being replayed as closure 3 of another, even in
   * the case where the digests happened to match.
   */
  function closureSigningString(binding) {
    var b = binding || {};
    return ['rvqr-closure/1', String(b.artifactId), String(b.index), String(b.role), String(b.digest)].join('\n');
  }

  /**
   * Reads an offered closure. Returns { ok, offer, reason } and never throws.
   *
   * Note what an offer CANNOT carry: a signer. The key that checks a closure is
   * named by the pinned root (for closure 1) or by the verified manifest (for
   * the rest), never by the closure itself.
   */
  function parseOffer(input) {
    if (input === null || input === undefined) {
      return { ok: false, reason: 'no closure was offered' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'the offer is not an object' };
    }
    if (!isIdentifier(input.artifactId, LIMITS.identifier)) {
      return { ok: false, reason: 'artifactId is missing or is not an identifier' };
    }
    if (!isInteger(input.index) || input.index < 1 || input.index > LIMITS.closures) {
      return { ok: false, reason: 'index is not a closure number inside the ceiling of ' + LIMITS.closures };
    }
    if (ROLES.indexOf(input.role) < 0) {
      return {
        ok: false,
        reason: 'role ' + JSON.stringify(String(input.role).slice(0, 40)) + ' is not one of ' + ROLES.join(', ')
      };
    }
    if (!isBytes(input.payload)) {
      return { ok: false, reason: 'payload is not a byte array' };
    }
    if (input.payload.length > LIMITS.closureBytes) {
      return {
        ok: false,
        reason: 'the payload is ' + input.payload.length + ' bytes, over the ceiling of ' + LIMITS.closureBytes
      };
    }
    var compressed = input.compressed === true;
    if (!isInteger(input.originalSize) || input.originalSize < 0 || input.originalSize > LIMITS.closureBytes) {
      return { ok: false, reason: 'originalSize is not a non-negative integer inside the ceiling' };
    }
    if (!compressed && input.originalSize !== input.payload.length) {
      return {
        ok: false,
        reason: 'an uncompressed closure declares ' + input.originalSize + ' bytes and carries ' +
          input.payload.length
      };
    }
    var signature = null;
    if (input.signature !== undefined && input.signature !== null) {
      if (!isString(input.signature) || !input.signature.length ||
          input.signature.length > LIMITS.signatureHex || !HEX_RE.test(input.signature) ||
          (input.signature.length & 1)) {
        return { ok: false, reason: 'signature is not an even-length run of lowercase hex inside the ceiling' };
      }
      signature = input.signature;
    }

    return {
      ok: true,
      offer: {
        artifactId: input.artifactId,
        index: input.index,
        role: input.role,
        payload: input.payload,
        compressed: compressed,
        originalSize: input.originalSize,
        signature: signature
      }
    };
  }

  // ---------------------------------------------------------------------------
  // The verifier — a verdict, and nothing that resembles a permission
  // ---------------------------------------------------------------------------

  /**
   * The verdict object, shaped like attest.js's: no `admit`, no `allow`, no
   * `ok` — nothing a caller could read as permission. `state` is the whole
   * answer and `admitClosure` is the only thing entitled to act on it.
   *
   * The committed facts — and the CONTENT — are published only on `verified`.
   * On every other state they are null, so no ordering mistake in a caller can
   * put unverified bytes where verified bytes go.
   *
   * `claim` is the opposite: what the offer SAID, kept for diagnostics and
   * quarantine records, and read by no decision anywhere.
   */
  function verdictFor(state, reason, facts) {
    var f = facts || {};
    var verified = state === STATE_VERIFIED;
    return {
      state: state,
      reason: reason,
      claim: f.claim || { artifactId: null, index: null, role: null, byteLength: null },
      artifactId: verified ? f.artifactId : null,
      index: verified ? f.index : null,
      role: verified ? f.role : null,
      digest: verified ? f.digest : null,
      signerId: verified ? f.signerId : null,
      byteLength: verified ? f.byteLength : null,
      content: verified ? f.content : null,
      manifest: verified && f.manifest ? f.manifest : null,
      signatureChecked: f.signatureChecked === undefined ? null : f.signatureChecked
    };
  }

  function claimOf(parsed, raw) {
    if (parsed && parsed.ok) {
      return {
        artifactId: parsed.offer.artifactId,
        index: parsed.offer.index,
        role: parsed.offer.role,
        byteLength: parsed.offer.payload.length
      };
    }
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      artifactId: isIdentifier(r.artifactId, LIMITS.identifier) ? r.artifactId : null,
      index: isInteger(r.index) ? r.index : null,
      role: ROLES.indexOf(r.role) >= 0 ? r.role : null,
      byteLength: isBytes(r.payload) ? r.payload.length : null
    };
  }

  /**
   * Verifies one closure against the ONE closure this receiver expects next.
   *
   * `expectation` is derived from already-verified data — the pinned root for
   * closure 1, the verified manifest for the rest — and is the only outside
   * data this function takes. There is no policy in the argument list, by
   * construction, so the verifier has nothing to decide with and cannot decide.
   * A null expectation means nothing is expected, which is a refusal and not a
   * licence.
   *
   * The order of the checks is ADR-016 §2.2's and is load-bearing:
   *
   *   1. order      — before anything is looked at
   *   2. identity   — the artifact this closure names
   *   3. size       — the declared original size, BEFORE any allocation
   *   4. inflate    — bounded by that size
   *   5. digest     — the bytes are the bytes described
   *   6. signature  — and who described them
   *
   * Nothing expensive runs early: an out-of-order or foreign closure never
   * reaches the inflater, the digest function or the signature verifier, so a
   * stranger cannot make a receiver do work by shouting frame numbers.
   *
   * `opts.digest(bytes) -> lowercase hex`, `opts.inflate(payload, limit) ->
   * bytes`, and `opts.verifySignature(desc) -> true | false | null` are all
   * supplied by the caller and all absent by default. With none, the state is
   * `unverified`, which the gate refuses.
   */
  function verifyClosure(offer, expectation, opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var parsed = parseOffer(offer);
    var claim = claimOf(parsed, offer);

    if (!parsed.ok) {
      return verdictFor(STATE_MALFORMED,
        'A closure was offered and could not be read: ' + parsed.reason + '. Unlike an attestation, ' +
        'a closure has no legitimate absence — the manifest commits to every one of them — so an ' +
        'unreadable offer and a missing one are the same refusal.',
        { claim: claim });
    }
    var o = parsed.offer;

    // --- 1. order, ADR-022 §2.2 ----------------------------------------------
    var e = expectation && typeof expectation === 'object' ? expectation : null;
    if (!e || !isInteger(e.index)) {
      return verdictFor(STATE_UNORDERED,
        'This receiver expects no closure right now, so closure ' + o.index + ' has nothing to be ' +
        'checked against. The manifest that says what a closure is allowed to be lives in closure 1, ' +
        'and until it verifies there is no digest, no role and no signer to compare.',
        { claim: claim });
    }
    if (o.index !== e.index) {
      return verdictFor(STATE_UNORDERED,
        'Closure ' + o.index + ' was offered where this receiver expects closure ' + e.index +
        '. The order is committed by the manifest, so a closure out of position is refused before it ' +
        'is looked at rather than being held for later.',
        { claim: claim });
    }
    if (o.role !== e.role) {
      return verdictFor(STATE_UNORDERED,
        'Closure ' + o.index + ' claims the role ' + JSON.stringify(o.role) + ' where the manifest ' +
        'commits that position to ' + JSON.stringify(e.role) + '. A closure does not get to say what ' +
        'it is.',
        { claim: claim });
    }

    // --- 2. artifact identity ------------------------------------------------
    if (o.artifactId !== e.artifactId) {
      return verdictFor(STATE_FOREIGN,
        'Closure ' + o.index + ' names artifact ' + JSON.stringify(o.artifactId) + ' and this ' +
        'activation is of ' + JSON.stringify(e.artifactId) + '. A closure from another artifact is a ' +
        'valid closure of that artifact and no part of this one.',
        { claim: claim });
    }

    // --- 3. declared size, before one byte is allocated ----------------------
    if (o.originalSize !== e.originalSize) {
      return verdictFor(STATE_SIZE_REFUSED,
        'Closure ' + o.index + ' declares ' + o.originalSize + ' original bytes where the manifest ' +
        'commits ' + e.originalSize + '. The declared size bounds the decompressor, so it is checked ' +
        'against the committed one before any allocation rather than after.',
        { claim: claim });
    }

    // --- 4. bounded decompression, ADR-016 §2.2 step 2 -----------------------
    var content;
    if (o.compressed) {
      if (typeof options.inflate !== 'function') {
        return verdictFor(STATE_UNVERIFIED,
          'Closure ' + o.index + ' is compressed and no decompressor was supplied, so its original ' +
          'bytes were never produced and nothing about them was checked. No codec is bundled in this ' +
          'repository (ADR-003), and a check that cannot run says it could not run.',
          { claim: claim });
      }
      var inflated;
      try {
        inflated = options.inflate(o.payload, o.originalSize);
      } catch (err) {
        return verdictFor(STATE_INFLATION_REFUSED,
          'Decompressing closure ' + o.index + ' failed: ' + (err && err.message ? err.message : String(err)) +
          '. Whether that was a bomb or a broken codec, the transfer is refused mid-stream.',
          { claim: claim });
      }
      if (!isBytes(inflated)) {
        return verdictFor(STATE_INFLATION_REFUSED,
          'The decompressor returned ' + JSON.stringify(typeof inflated) + ' rather than bytes for ' +
          'closure ' + o.index + ', so there are no original bytes to check.',
          { claim: claim });
      }
      if (inflated.length !== o.originalSize) {
        return verdictFor(STATE_INFLATION_REFUSED,
          'Closure ' + o.index + ' declared ' + o.originalSize + ' original bytes and inflated to ' +
          inflated.length + '. Inflation past the declared size is the bomb ADR-016 §4.6 tests for, ' +
          'and inflation short of it is not the content that was described either.',
          { claim: claim });
      }
      content = inflated;
    } else {
      content = o.payload;
    }

    // --- 5. the content digest, ADR-016 §2.2 step 3 --------------------------
    if (typeof options.digest !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No digest function was supplied, so closure ' + o.index + '’s content was never compared ' +
        'against the digest the manifest commits. Nothing was established.',
        { claim: claim });
    }
    var actual;
    try {
      actual = options.digest(content);
    } catch (err2) {
      return verdictFor(STATE_UNVERIFIED,
        'The digest function failed on closure ' + o.index + ': ' +
        (err2 && err2.message ? err2.message : String(err2)) + '. A check that failed is a check that ' +
        'did not happen, never a pass.',
        { claim: claim });
    }
    if (!isString(actual) || actual.toLowerCase() !== e.digest) {
      return verdictFor(STATE_DIGEST_MISMATCH,
        'Closure ' + o.index + ' digests to ' + JSON.stringify(String(actual).slice(0, 16) + '…') +
        ' where the manifest commits ' + JSON.stringify(e.digest.slice(0, 16) + '…') + '. These are ' +
        'not the bytes that were described.',
        { claim: claim });
    }

    // --- 6. the signature, ADR-016 §2.2 step 4 -------------------------------
    // The digest proves the bytes are the bytes described; the signature proves
    // who described them. Neither substitutes for the other, so both run and
    // the signature runs second — a closure whose content is wrong never
    // reaches a verifier.
    if (o.signature === null) {
      return verdictFor(STATE_UNSIGNED,
        'Closure ' + o.index + ' carries no signature. Each closure is separately signed under ' +
        'ADR-022 §2.1, so an unsigned one is a closure nobody stands behind.',
        { claim: claim });
    }
    if (typeof options.verifySignature !== 'function') {
      return verdictFor(STATE_UNVERIFIED,
        'No signature verifier was supplied, so the signature on closure ' + o.index + ' was not ' +
        'checked and it is unknown who described these bytes.',
        { claim: claim });
    }
    var message = closureSigningString({
      artifactId: e.artifactId, index: e.index, role: e.role, digest: e.digest
    });
    var answer;
    try {
      answer = options.verifySignature({
        artifactId: e.artifactId,
        index: e.index,
        role: e.role,
        digest: e.digest,
        signerId: e.signerId,
        signature: o.signature,
        message: message
      });
    } catch (err3) {
      return verdictFor(STATE_UNVERIFIED,
        'The signature verifier failed on closure ' + o.index + ': ' +
        (err3 && err3.message ? err3.message : String(err3)) + '.',
        { claim: claim, signatureChecked: null });
    }
    if (answer === false) {
      return verdictFor(STATE_FORGED,
        'The signature on closure ' + o.index + ' did not verify under ' + JSON.stringify(e.signerId) +
        ', the signer this artifact commits to for that position.',
        { claim: claim, signatureChecked: false });
    }
    if (answer !== true) {
      return verdictFor(STATE_UNVERIFIED,
        'The signature verifier returned ' + JSON.stringify(answer) + ' rather than a verdict for ' +
        'closure ' + o.index + ', so nothing was established.',
        { claim: claim, signatureChecked: null });
    }

    // --- closure 1 is a manifest, and a manifest that cannot be read is not one
    var manifest = null;
    if (e.role === ROLE_MANIFEST) {
      if (content.length > LIMITS.manifestBytes) {
        return verdictFor(STATE_SIZE_REFUSED,
          'Closure 1 is ' + content.length + ' bytes, over the ' + LIMITS.manifestBytes +
          '-byte ceiling this build will read a manifest from.',
          { claim: claim, signatureChecked: true });
      }
      var read = readManifestBytes(content, options);
      if (!read.ok) {
        return verdictFor(STATE_MALFORMED,
          'Closure 1 verified as bytes and is not a readable manifest: ' + read.reason + '. Bytes that ' +
          'are correctly signed and do not describe an artifact commit to nothing.',
          { claim: claim, signatureChecked: true });
      }
      if (read.manifest.artifactId !== e.artifactId) {
        return verdictFor(STATE_FOREIGN,
          'Closure 1 verified and describes artifact ' + JSON.stringify(read.manifest.artifactId) +
          ' where the pinned root names ' + JSON.stringify(e.artifactId) + '.',
          { claim: claim, signatureChecked: true });
      }
      manifest = read.manifest;
    }

    return verdictFor(STATE_VERIFIED,
      'Closure ' + e.index + ' (' + ROLE_LABELS[e.role] + ') is in order, belongs to ' +
      JSON.stringify(e.artifactId) + ', inflated inside its declared size, digests to the value the ' +
      'manifest commits, and is signed by ' + JSON.stringify(e.signerId) + '. That is the whole ' +
      'ADR-016 pipeline, applied to this closure alone.',
      {
        claim: claim, signatureChecked: true,
        artifactId: e.artifactId, index: e.index, role: e.role, digest: e.digest,
        signerId: e.signerId, byteLength: content.length, content: content, manifest: manifest
      });
  }

  /**
   * Closure 1's content is a manifest. How it is encoded is the caller's
   * business — `opts.decodeManifest(bytes)` is injected for that — and the
   * default reads UTF-8 JSON, which is what the rest of this repository's
   * frames use. A decoder that throws yields an unreadable manifest rather
   * than an exception on a security path.
   */
  function readManifestBytes(content, options) {
    var value;
    try {
      if (typeof options.decodeManifest === 'function') {
        value = options.decodeManifest(content);
      } else {
        value = JSON.parse(utf8ToString(content));
      }
    } catch (err) {
      return { ok: false, reason: 'it did not decode (' + (err && err.message ? err.message : String(err)) + ')' };
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
  // The policy — the receiver's, and every field of it defaults to refusing
  // ---------------------------------------------------------------------------

  /**
   * Normalises a receiver policy. Absence is never generosity: no trusted
   * signer trusts nobody, no permitted role permits nothing.
   *
   * `requireSignature` is the one field with no default at all, for the reason
   * attest.js gives `requireAttestation` none: whether a closure that nobody
   * signed may ever be activated is a decision the receiver has to make, and a
   * policy that has not made it is refused rather than handed an answer nobody
   * chose.
   *
   * An undeclared policy therefore normalises to `requireSignature: null` and
   * NOT to `false`. That is what makes this function idempotent: a session
   * stores the normalised policy and normalises it again on every decision, and
   * a `false` there would turn "has not decided" into "has decided not to" the
   * first time it went round — a policy silently acquiring a position nobody
   * took.
   */
  function normalizePolicy(policy) {
    var p = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
    var stated = p.requireSignature === true ? true : (p.requireSignature === false ? false : null);
    var out = {
      declared: stated !== null,
      requireSignature: stated,
      trustedSigners: [],
      allowRoles: []
    };
    var signers = Array.isArray(p.trustedSigners) ? p.trustedSigners : [];
    for (var i = 0; i < signers.length && out.trustedSigners.length < LIMITS.identifier; i++) {
      if (isIdentifier(signers[i], LIMITS.identifier) && out.trustedSigners.indexOf(signers[i]) < 0) {
        out.trustedSigners.push(signers[i]);
      }
    }
    var roles = Array.isArray(p.allowRoles) ? p.allowRoles : [];
    for (var r = 0; r < roles.length; r++) {
      if (ROLES.indexOf(roles[r]) >= 0 && out.allowRoles.indexOf(roles[r]) < 0) out.allowRoles.push(roles[r]);
    }
    out.allowRoles.sort();
    return out;
  }

  // ---------------------------------------------------------------------------
  // The gate — pure, total, and the only thing here that decides
  // ---------------------------------------------------------------------------

  function refusal(code, reason) {
    return { admit: false, code: code, reason: reason };
  }

  /**
   * Stage one: what the verdict state alone permits. Total over the vocabulary,
   * and an unrecognised state fails closed — ADR-035 §4.1's rule, which ADR-022
   * §3 names as the failure most likely to recur across four verification
   * boundaries instead of one.
   */
  function closureGate(policy, state) {
    switch (state) {
      case STATE_VERIFIED:
        return { pass: true };
      case STATE_MALFORMED:
        return { pass: false, code: CODE_MALFORMED, reason: 'The closure could not be read.' };
      case STATE_FOREIGN:
        return { pass: false, code: CODE_FOREIGN, reason: 'The closure belongs to a different artifact.' };
      case STATE_UNORDERED:
        return {
          pass: false, code: CODE_UNORDERED,
          reason: 'The closure is not the one this receiver expects next, and the order is signed.'
        };
      case STATE_SIZE_REFUSED:
        return {
          pass: false, code: CODE_SIZE_REFUSED,
          reason: 'The declared original size is not the size the manifest commits.'
        };
      case STATE_INFLATION_REFUSED:
        return {
          pass: false, code: CODE_INFLATION_REFUSED,
          reason: 'Decompression did not stay inside the declared original size.'
        };
      case STATE_DIGEST_MISMATCH:
        return {
          pass: false, code: CODE_DIGEST_MISMATCH,
          reason: 'The content is not the content the manifest described.'
        };
      case STATE_UNSIGNED:
        // Refused whether or not the receiver requires signatures: a closure
        // whose position, digest and content are committed by a manifest that
        // names a signer is a closure that was meant to carry one. The policy
        // field exists so a receiver states its position, not so that silence
        // becomes the widest permission in the system.
        return {
          pass: false, code: CODE_UNSIGNED,
          reason: policy.requireSignature
            ? 'This receiver requires a signature on every closure and this one carries none.'
            : 'This closure carries no signature. The manifest names a signer for this position, so an ' +
              'unsigned closure there is a missing signature rather than an unsigned artifact.'
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
          reason: 'Unrecognised closure state: ' + JSON.stringify(state) +
            '. A state this build does not know is refused rather than interpreted.'
        };
    }
  }

  /**
   * May this closure be activated?
   *
   * Same shape as `core.admitArtifact` and `attest.admitTransfer` — a policy
   * and a verdict in, an { admit, code, reason } out — pure and total for the
   * same reason: so the rule can be tested exhaustively and no other path can
   * reach around it.
   *
   * `situation` is the session's, not the closure's: whether a root is pinned,
   * whether the activation is already blocked, whether the artifact has been
   * sealed incomplete. All three refuse a PERFECT closure, which is the point —
   * ADR-022 §2.3's "it does not silently acquire the cold state later" is only
   * true if a valid closure 4 offered after sealing is refused on the situation
   * rather than admitted on its merits.
   *
   * Every field of `situation` defaults to the refusing value.
   *
   * There is exactly one `admit: true` in this function and it is at the bottom.
   */
  function admitClosure(policy, verdict, situation) {
    var p = normalizePolicy(policy);
    var s = situation && typeof situation === 'object' && !Array.isArray(situation) ? situation : {};

    if (!p.declared) {
      return refusal(CODE_POLICY_UNDECLARED,
        'This policy has not stated whether it requires a signature on every closure. Four separately ' +
        'signed closures is four decisions, and there is no default to fall back on.');
    }
    if (s.rootDeclared !== true) {
      return refusal(CODE_ROOT_UNDECLARED,
        'No root is pinned for this activation. Closure 1 is committed by the root and everything else ' +
        'by closure 1, so with no root there is no chain to check anything against.');
    }
    if (s.blocked === true) {
      return refusal(CODE_BLOCKED,
        'A closure in the activation set was already refused, so this activation is abandoned and ' +
        'nothing downstream of it runs. Recovery is a new activation from the pinned root, not a retry ' +
        'into this one.');
    }
    if (s.sealed === true) {
      return refusal(CODE_SEALED_INCOMPLETE,
        'This artifact was sealed incomplete: it is running on its activation closures and has been ' +
        'decided to run without the rest. It does not acquire the cold state afterwards, however valid ' +
        'the offer.');
    }

    if (!verdict || !verdict.state) {
      return refusal(CODE_PENDING, 'The verification of this closure has not completed yet.');
    }

    var gate = closureGate(p, verdict.state);
    if (!gate.pass) return refusal(gate.code, gate.reason);

    // Verified, and still two independent questions to answer. ADR-016 §2.1:
    // neither gate is allowed to trust the other's word for it, so the fact
    // that an injected verifier accepted the signature is not the same as this
    // receiver accepting the signer.
    if (!p.allowRoles.length || p.allowRoles.indexOf(verdict.role) < 0) {
      return refusal(CODE_ROLE_REFUSED,
        'This receiver does not admit closures of role ' + JSON.stringify(verdict.role) +
        (p.allowRoles.length ? '; it admits ' + p.allowRoles.join(', ') : '; it admits no role at all') + '.');
    }
    if (!p.trustedSigners.length || p.trustedSigners.indexOf(verdict.signerId) < 0) {
      return refusal(CODE_UNTRUSTED_SIGNER,
        'The signature on this closure verified under ' + JSON.stringify(verdict.signerId) +
        ', which is not a signer this receiver trusts. A verifier saying the signature is genuine is ' +
        'not this receiver saying the key may sign for it.');
    }

    return {
      admit: true,
      code: CODE_ADMITTED,
      reason: 'Closure ' + verdict.index + ' (' + ROLE_LABELS[verdict.role] + ') passed the whole ' +
        'pipeline and is admitted under signer ' + JSON.stringify(verdict.signerId) + '.'
    };
  }

  // ---------------------------------------------------------------------------
  // The session — an immutable value, and the one place bytes get in
  // ---------------------------------------------------------------------------

  var SESSION_KIND = 'rvqr-activation-session/1';

  function normalizeRoot(rootPin) {
    var r = rootPin && typeof rootPin === 'object' && !Array.isArray(rootPin) ? rootPin : {};
    if (!isIdentifier(r.artifactId, LIMITS.identifier)) return null;
    if (!isIdentifier(r.signerId, LIMITS.identifier)) return null;
    if (!isDigestHex(r.digest)) return null;
    if (!isInteger(r.originalSize) || r.originalSize < 0 || r.originalSize > LIMITS.manifestBytes) return null;
    return {
      artifactId: r.artifactId,
      signerId: r.signerId,
      digest: r.digest,
      originalSize: r.originalSize
    };
  }

  /**
   * Starts an activation against a pinned root.
   *
   * The root is the receiver's out-of-band anchor — ADR-035's pinned
   * fingerprint, extended to commit closure 1's digest and size as well as its
   * signer. Without it nothing can be checked, so a malformed root produces a
   * session that refuses everything with `root-undeclared` rather than one that
   * quietly accepts whatever arrives first.
   */
  function beginActivation(rootPin, policy) {
    var root = normalizeRoot(rootPin);
    var p = normalizePolicy(policy);
    return freezeDeep({
      kind: SESSION_KIND,
      rootDeclared: root !== null,
      root: root,
      policy: p,
      artifactId: root ? root.artifactId : null,
      manifest: null,
      verified: [],
      contents: [],
      quarantined: [],
      quarantinedTotal: 0,
      blocked: root === null,
      blockedReason: root === null
        ? 'No root is pinned, so this activation has no anchor and can never verify closure 1.'
        : null,
      sealed: false,
      sealReason: null
    });
  }

  /**
   * A session is recognised by its SHAPE, not by its tag. A value carrying the
   * right `kind` and none of the structure is not a session and gets the
   * refusing treatment, because every function below indexes into those arrays
   * and a half-built object would throw on a security path rather than refuse
   * on one.
   *
   * A caller that forges a structurally complete session is already inside the
   * trust boundary — and still cannot admit a closure without it passing the
   * whole pipeline against whatever root that forged session pins.
   */
  function isSession(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === SESSION_KIND &&
      Array.isArray(v.verified) && Array.isArray(v.contents) && Array.isArray(v.quarantined) &&
      isInteger(v.quarantinedTotal) && !!v.policy && typeof v.policy === 'object';
  }

  /** How many closures the manifest declares, once it is known. */
  function totalCount(session) {
    return session.manifest ? session.manifest.totalCount : null;
  }

  /** How many have to verify before the agent starts. Unknown before closure 1. */
  function activationCount(session) {
    return session.manifest ? session.manifest.activationCount : null;
  }

  /** ADR-022 §2.1's gate: the agent starts once the activation set has verified. */
  function gateOpen(session) {
    if (!isSession(session) || session.blocked) return false;
    var need = activationCount(session);
    return need !== null && session.verified.length >= need;
  }

  /**
   * The one closure this receiver will look at next, derived entirely from
   * already-verified data: the pinned root for closure 1, the verified manifest
   * for the rest. Null means nothing is expected, which refuses.
   */
  function expectationFor(session) {
    if (!isSession(session) || !session.rootDeclared || session.blocked || session.sealed) return null;
    var next = session.verified.length + 1;
    if (next === 1) {
      return {
        artifactId: session.root.artifactId,
        index: 1,
        role: ROLE_MANIFEST,
        digest: session.root.digest,
        originalSize: session.root.originalSize,
        signerId: session.root.signerId
      };
    }
    if (!session.manifest) return null;
    var entry = session.manifest.closures[next - 2];
    if (!entry) return null;
    return {
      artifactId: session.manifest.artifactId,
      index: next,
      role: entry.role,
      digest: entry.digest,
      originalSize: entry.originalSize,
      signerId: session.manifest.signerId
    };
  }

  function situationFor(session) {
    return {
      rootDeclared: !!session.rootDeclared,
      blocked: !!session.blocked,
      sealed: !!session.sealed
    };
  }

  /**
   * Whether refusing this closure abandons the activation.
   *
   * Fatal when the closure that failed IS the one the activation is waiting for
   * and that closure is inside the activation set: closure 1 failing stops
   * everything, and closure 2 or 3 failing means the agent never starts.
   *
   * NOT fatal for an out-of-order stray, however hostile — a peer that can
   * abandon an activation by shouting the wrong closure number has a denial of
   * service for free. NOT fatal for a cold closure either: ADR-022 §2.3 says
   * the agent keeps running and the artifact is marked incomplete.
   */
  function refusalIsFatal(session, verdict, expectation, decision) {
    if (!expectation) return false;
    if (!verdict || verdict.state === STATE_UNORDERED) return false;
    if (decision.code === CODE_BLOCKED || decision.code === CODE_SEALED_INCOMPLETE ||
        decision.code === CODE_ROOT_UNDECLARED || decision.code === CODE_POLICY_UNDECLARED) {
      // Already refusing on the situation; the activation state does not change
      // because of an offer it never looked at.
      return false;
    }
    if (expectation.role === ROLE_COLD) return false;
    return true;
  }

  function quarantineEntry(session, verdict, decision, expectation) {
    var claim = verdict && verdict.claim ? verdict.claim : { index: null, role: null, byteLength: null };
    return {
      // The CLAIMED position, because a refused closure has no established one.
      claimedIndex: claim.index,
      claimedRole: claim.role,
      claimedBytes: claim.byteLength,
      expectedIndex: expectation ? expectation.index : null,
      state: verdict ? verdict.state : null,
      code: decision.code,
      reason: decision.reason
    };
  }

  /**
   * Offers one closure to an activation. Returns { session, verdict, decision }
   * with a NEW session; the one passed in is never written to.
   *
   * ---------------------------------------------------------------------------
   * THIS IS THE ONLY PLACE OFFERED BYTES ENTER A SESSION, AND IT IS ONE BRANCH.
   * ---------------------------------------------------------------------------
   *
   * On admission the content is COPIED into `contents`. On every refusal the
   * session gains a descriptor and nothing else — no payload, no inflated
   * buffer, no reference to the offer. That is what makes quarantine structural
   * rather than a promise: there is no unverified-bytes container to leak from,
   * because unverified bytes are never taken.
   */
  function offerClosure(session, offer, opts) {
    if (!isSession(session)) {
      // Junk in the session position gets a refusing session rather than an
      // exception, and certainly not an admission.
      var fresh = beginActivation(null, null);
      return {
        session: fresh,
        verdict: null,
        decision: admitClosure(fresh.policy, null, situationFor(fresh))
      };
    }

    var expectation = expectationFor(session);
    var situation = situationFor(session);

    // A situation that refuses everything refuses before verification runs, so
    // a sealed or abandoned activation does not hand a stranger's bytes to a
    // decompressor or a signature verifier either.
    var early = admitClosure(session.policy, { state: STATE_VERIFIED }, situation);
    if (!early.admit && (early.code === CODE_ROOT_UNDECLARED || early.code === CODE_BLOCKED ||
        early.code === CODE_SEALED_INCOMPLETE || early.code === CODE_POLICY_UNDECLARED)) {
      return {
        session: withQuarantine(session, quarantineEntry(session, null, early, expectation)),
        verdict: null,
        decision: early
      };
    }

    var verdict = verifyClosure(offer, expectation, opts);
    var decision = admitClosure(session.policy, verdict, situation);

    if (!decision.admit) {
      var next = withQuarantine(session, quarantineEntry(session, verdict, decision, expectation));
      if (refusalIsFatal(session, verdict, expectation, decision)) {
        next = withBlock(next,
          'Closure ' + expectation.index + ' (' + ROLE_LABELS[expectation.role] + ') was refused: ' +
          decision.code + '. It is inside the activation set, so the agent never starts and nothing ' +
          'downstream of it runs.');
      }
      return { session: next, verdict: verdict, decision: decision };
    }

    return { session: activate(session, verdict), verdict: verdict, decision: decision };
  }

  function withQuarantine(session, entry) {
    var list = session.quarantined.slice(0);
    // Capped, because a peer controls how many refusals it can cause. The
    // dropped ones are COUNTED rather than forgotten: unlike attest.js's spent
    // challenges, nothing reads this list to decide anything, so truncating it
    // cannot change an answer — but a record that shrinks without saying so
    // still misleads whoever reads the receipt.
    if (list.length < LIMITS.quarantineEntries) list.push(entry);
    return freezeDeep(assign(session, {
      quarantined: list,
      quarantinedTotal: session.quarantinedTotal + 1
    }));
  }

  function withBlock(session, reason) {
    return freezeDeep(assign(session, { blocked: true, blockedReason: reason }));
  }

  /**
   * The single admission path. Everything above this line refuses; this is the
   * only function that copies a caller's bytes into a session.
   */
  function activate(session, verdict) {
    var verified = session.verified.slice(0);
    verified.push({ index: verdict.index, role: verdict.role, digest: verdict.digest, byteLength: verdict.byteLength });
    var contents = session.contents.slice(0);
    // A copy, so the transport cannot change what was activated after the fact
    // by writing into the buffer it handed over.
    contents.push({ index: verdict.index, role: verdict.role, bytes: copyBytes(verdict.content) });
    return freezeDeep(assign(session, {
      verified: verified,
      contents: contents,
      manifest: verdict.manifest ? verdict.manifest : session.manifest
    }));
  }

  function assign(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * ADR-022 §2.3's decision, made rather than discovered: the cold state never
   * verified, the agent keeps running on its activation closures, and this
   * artifact is INCOMPLETE from here on.
   *
   * Only meaningful on a partial activation. Sealing a complete artifact would
   * be marking a verified whole incomplete; sealing one that never started
   * would be recording a running deployment that is not running. Both are
   * no-ops, and `completion()` says which state the session is actually in.
   */
  function sealIncomplete(session, reason) {
    if (!isSession(session)) return beginActivation(null, null);
    if (completion(session) !== COMPLETION_PARTIAL) return session;
    return freezeDeep(assign(session, {
      sealed: true,
      sealReason: isString(reason) && reason.length ? reason.slice(0, 512)
        : 'The cold closure never verified and this deployment was decided to run without it.'
    }));
  }

  /** Which of the five states this activation is in. A pure function of it. */
  function completion(session) {
    if (!isSession(session)) return COMPLETION_BLOCKED;
    if (!session.rootDeclared || session.blocked) return COMPLETION_BLOCKED;
    if (session.sealed) return COMPLETION_INCOMPLETE;
    var total = totalCount(session);
    if (total !== null && session.verified.length >= total) return COMPLETION_COMPLETE;
    if (gateOpen(session)) return COMPLETION_PARTIAL;
    return COMPLETION_TRANSFERRING;
  }

  /** Every closure position that is known, and where it stands. */
  function positions(session) {
    if (!isSession(session)) return [];
    var out = [];
    var known = totalCount(session);
    var count = known === null ? 1 : known;
    for (var i = 1; i <= count; i++) {
      var v = null;
      for (var j = 0; j < session.verified.length; j++) {
        if (session.verified[j].index === i) v = session.verified[j];
      }
      var role = i === 1 ? ROLE_MANIFEST
        : (session.manifest && session.manifest.closures[i - 2] ? session.manifest.closures[i - 2].role : null);
      out.push({
        index: i,
        role: role,
        activation: role !== null && role !== ROLE_COLD,
        status: v ? 'verified' : 'pending',
        digest: v ? v.digest : null,
        byteLength: v ? v.byteLength : null
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The agent's view — the only thing an activated agent is handed
  // ---------------------------------------------------------------------------

  /**
   * What a running agent can reach. Built fresh on every call, holding no
   * reference back to the session, so there is no path from an agent to the
   * quarantine record, to the policy, or to any closure that has not verified.
   *
   * Two rules do the work:
   *
   *   1. **Nothing is reachable until the gate opens.** ADR-022 §2.1 says the
   *      agent starts once closures 1–3 verify, so a verified closure 2 waiting
   *      on a closure 3 that never came activates nothing. A partial activation
   *      set is not a small activation.
   *
   *   2. **Cold state is reachable only when the WHOLE artifact has verified.**
   *      A manifest may commit several cold closures, and one of them
   *      verifying does not make the artifact whole — so while any of them is
   *      outstanding, refused, or sealed away, `cold` is empty and holds a
   *      reference to nothing. The strictness costs a verified cold closure its
   *      reachability on a sealed artifact, which is the trade: `incomplete`
   *      then means exactly one thing, "running on the activation set and
   *      nothing else", rather than "running on the activation set plus
   *      whichever cold pieces happened to land".
   *
   * The activation closures are keyed by role, which is unambiguous because a
   * manifest may not name an activation role twice. Cold closures are a list in
   * index order, because they may repeat and nothing distinguishes them by role.
   */
  function agentView(session) {
    var open = gateOpen(session);
    var state = completion(session);
    var view = {
      running: open,
      artifactId: open ? session.artifactId : null,
      completion: state,
      complete: state === COMPLETION_COMPLETE,
      closures: {},
      cold: []
    };
    if (!open) return freezeDeep(view);
    var coldReachable = state === COMPLETION_COMPLETE;
    for (var i = 0; i < session.contents.length; i++) {
      var c = session.contents[i];
      if (c.role === ROLE_COLD) {
        if (coldReachable) view.cold.push(c.bytes);
      } else {
        view.closures[c.role] = c.bytes;
      }
    }
    return freezeDeep(view);
  }

  // ---------------------------------------------------------------------------
  // The receipt — ADR-022 §4.4 and ADR-016 §2.3
  // ---------------------------------------------------------------------------

  /**
   * What a receipt has to carry about a progressive activation.
   *
   * The one thing this must never do is let "running" read as "verified whole".
   * Three separate named fields keep them apart — `completion`, `complete` and
   * `verifiedWholeArtifact` — and the summary is built from all of them rather
   * than from whether anything is running, because ADR-022 §2.3 makes
   * partially-verified a distinct state and an auditor is the person who later
   * has to tell it from a complete one.
   *
   * This is NOT ADR-134's witness record. See `describeUnimplemented()`.
   */
  function activationReceipt(session) {
    if (!isSession(session)) {
      return freezeDeep({
        artifactId: null, completion: COMPLETION_BLOCKED, complete: false,
        verifiedWholeArtifact: false, running: false, sealed: false, sealReason: null,
        closuresVerified: 0, closuresDeclared: null, activationClosures: null,
        activated: [], outstanding: [], quarantined: [], quarantinedTotal: 0,
        quarantinedRecorded: 0, blockedReason: 'This is not an activation session.',
        summary: 'No activation session was recorded.'
      });
    }
    var state = completion(session);
    var open = gateOpen(session);
    var declared = totalCount(session);
    var activated = [];
    for (var i = 0; i < session.verified.length; i++) activated.push(session.verified[i].role);
    var outstanding = [];
    var pos = positions(session);
    for (var j = 0; j < pos.length; j++) if (pos[j].status === 'pending') outstanding.push(pos[j].role);

    var receipt = {
      artifactId: session.artifactId,
      completion: state,
      // Never derived from "is it running": the whole point of ADR-022 §2.3.
      complete: state === COMPLETION_COMPLETE,
      verifiedWholeArtifact: state === COMPLETION_COMPLETE,
      running: open,
      sealed: !!session.sealed,
      sealReason: session.sealReason,
      closuresVerified: session.verified.length,
      closuresDeclared: declared,
      activationClosures: activationCount(session),
      activated: activated,
      outstanding: outstanding,
      quarantined: session.quarantined.map(function (q) {
        return { claimedIndex: q.claimedIndex, claimedRole: q.claimedRole, state: q.state, code: q.code };
      }),
      quarantinedTotal: session.quarantinedTotal,
      quarantinedRecorded: session.quarantined.length,
      blockedReason: session.blockedReason,
      summary: ''
    };
    receipt.summary = summarise(receipt);
    return freezeDeep(receipt);
  }

  function summarise(r) {
    var of = r.closuresVerified + ' of ' + (r.closuresDeclared === null ? 'an unknown number of' : r.closuresDeclared) +
      ' closures verified';
    switch (r.completion) {
      case COMPLETION_COMPLETE:
        return 'Complete: ' + of + ', including the cold state. This is a verified whole artifact.';
      case COMPLETION_INCOMPLETE:
        return 'Incomplete: running on its activation closures with ' + of + '. The cold state never ' +
          'verified and this artifact was sealed incomplete — it is NOT a verified whole artifact and ' +
          'cannot become one.';
      case COMPLETION_PARTIAL:
        return 'Partial: running on its activation closures with ' + of + ', and the cold state still ' +
          'outstanding. Not a verified whole artifact.';
      case COMPLETION_BLOCKED:
        return 'Blocked: ' + of + ', and nothing runs. ' + (r.blockedReason || 'No activation was possible.');
      default:
        return 'Transferring: ' + of + ', and the agent has not started.';
    }
  }

  // ---------------------------------------------------------------------------
  // Honesty
  // ---------------------------------------------------------------------------

  /**
   * What ADR-022 asks for that this build does not have, said from inside the
   * running system rather than only in a report — the reason attest.js's
   * `describeRoots()` exists.
   *
   * `status` is `absent` for a thing that does not exist here at all, and
   * `injected-absent` for a check this module will perform if a caller supplies
   * it and refuses without.
   */
  function describeUnimplemented() {
    return [
      {
        id: 'radio-tier',
        label: 'ADR-022 §4.5: under 3 s at p95 on the radio tier',
        status: 'absent',
        note: 'There is no radio tier. No QUIC and no radio transport exists in this repository, so the ' +
          'p95 figure ADR-022 §4.5 asks for CANNOT BE MEASURED here and this build makes no such claim. ' +
          'Simulating a radio and reporting the result as though observed would be worse than reporting ' +
          'nothing.'
      },
      {
        id: 'hybrid-signatures',
        label: 'ADR-012 hybrid signing: Ed25519 + ML-DSA-65',
        status: 'absent',
        note: 'crypto.js exposes Ed25519 only; there is no ML-DSA-65 anywhere in this repository. ADR-022 ' +
          '§4.5 requires the timing to be taken WITH hybrid signatures in place and warns that Ed25519 ' +
          'alone "would flatter the result", so any timing produced here is not a criterion-5 result. ' +
          'The hybrid figures this module can produce are arithmetic projections and are labelled as ' +
          'projections where they are returned.'
      },
      {
        id: 'closure-splitting',
        label: 'ADR-022 §3: tooling that splits an artifact into closures',
        status: 'absent',
        note: 'Nothing in this repository decides what is required code and hot state versus cold. The ' +
          'closures this module verifies are constructed by its caller, and ADR-022 §3 notes that a ' +
          'wrong split produces an agent that starts and immediately stalls — which is a runtime ' +
          'property this module cannot see.'
      },
      {
        id: 'rvm-execution',
        label: 'ADR-016 §2.2 step 6: the handoff to RVM',
        status: 'absent',
        note: 'Nothing here executes anything. "Running" means the gate opened and the activated bytes ' +
          'are readable, not that any code ran: there is no RVM, no capability check on its side and no ' +
          'resource budget. ADR-016 §2.1 states one invariant at two layers and this file is one of them.'
      },
      {
        id: 'witness-receipt',
        label: 'ADR-016 §2.3: the receipt is ADR-134’s witness record',
        status: 'absent',
        note: 'activationReceipt() returns a plain object. It is the shape of what a receipt must carry ' +
          'about a partial activation; it is not a witness record, nothing signs it, and ' +
          '`rvf-cli verify-witness` has never seen anything this module produced.'
      },
      {
        id: 'bounded-decompression',
        label: 'ADR-016 §2.2 step 2: bounded decompression',
        status: 'injected-absent',
        note: 'No codec is bundled (ADR-003), so `opts.inflate` is injected. The BOUND is enforced here — ' +
          'the declared original size is checked against the manifest before the inflater is called, and ' +
          'the inflater is given that size as its limit — but the decompressor itself is the caller’s, so ' +
          'peak allocation inside it is not something this module can observe. A compressed closure with ' +
          'no inflater is refused.'
      },
      {
        id: 'content-digest',
        label: 'ADR-016 §2.2 step 3: the content digest',
        status: 'injected-absent',
        note: '`opts.digest` is injected. With none, every closure is `unverified` and refused: a check ' +
          'that cannot run says it could not run.'
      },
      {
        id: 'signature-verification',
        label: 'ADR-016 §2.2 step 4: the manifest signatures',
        status: 'injected-absent',
        note: '`opts.verifySignature` is injected. An Ed25519 verifier can be built from crypto.js, and ' +
          'that is HALF of ADR-012’s scheme — a closure verified that way is verified under one of the ' +
          'two signatures the design requires.'
      }
    ];
  }

  /**
   * ADR-022 §3's signature multiplication, as arithmetic over ADR-012's own
   * figures. A PROJECTION, and it says so in its own fields: nothing here has
   * produced or verified an ML-DSA-65 signature, so this is what the scheme
   * would cost and not what anything measured.
   */
  var ED25519_SIGNATURE_BYTES = 64;
  var MLDSA65_SIGNATURE_BYTES = 3309;

  function hybridSignatureProjection(closures) {
    var n = isInteger(closures) && closures > 0 ? closures : 0;
    var ed = n * ED25519_SIGNATURE_BYTES;
    var pq = n * MLDSA65_SIGNATURE_BYTES;
    return {
      projection: true,
      measured: false,
      closures: n,
      ed25519Bytes: ed,
      mldsa65Bytes: pq,
      totalBytes: ed + pq,
      note: 'PROJECTION, not a measurement: ' + n + ' closures × (' + ED25519_SIGNATURE_BYTES + ' B Ed25519 + ' +
        MLDSA65_SIGNATURE_BYTES + ' B ML-DSA-65) = ' + (ed + pq) + ' B of signature. The ML-DSA-65 figure is ' +
        'ADR-022 §3’s own; no ML-DSA-65 signature has been produced or verified in this repository.'
    };
  }

  /**
   * ADR-022 §4.6: the optical case, measured and reported honestly, "including
   * 'not achievable at this artifact size' where that is the answer".
   *
   * The measured input is the optical rate the protocol benchmark reports —
   * 2.44 KB/s, in `bench/results/report.md`. Everything else is arithmetic over
   * it, and the conclusion is decided before any artifact content is
   * considered: under ADR-012's hybrid signing the signatures ALONE outgrow a
   * three-second optical budget, so the answer is not "not achievable at this
   * artifact size" but "not achievable at ANY artifact size".
   */
  var OPTICAL_BYTES_PER_SECOND = 2440;

  function opticalBudget(options) {
    var o = options && typeof options === 'object' ? options : {};
    var rate = isInteger(o.rateBytesPerSecond) && o.rateBytesPerSecond > 0
      ? o.rateBytesPerSecond : OPTICAL_BYTES_PER_SECOND;
    var seconds = typeof o.seconds === 'number' && isFinite(o.seconds) && o.seconds > 0 ? o.seconds : 3;
    var closures = isInteger(o.closures) && o.closures > 0 ? o.closures : ACTIVATION_ROLES.length;
    var hybrid = o.hybrid !== false;
    var perSignature = hybrid ? ED25519_SIGNATURE_BYTES + MLDSA65_SIGNATURE_BYTES : ED25519_SIGNATURE_BYTES;
    var budget = Math.floor(rate * seconds);
    var floor = closures * perSignature;
    var content = budget - floor;
    return {
      projection: true,
      rateMeasured: rate === OPTICAL_BYTES_PER_SECOND,
      rateBytesPerSecond: rate,
      seconds: seconds,
      closures: closures,
      hybrid: hybrid,
      signatureBytesEach: perSignature,
      budgetBytes: budget,
      signatureFloorBytes: floor,
      contentBytes: content > 0 ? content : 0,
      achievable: content > 0,
      note: hybrid
        ? 'PROJECTION over a measured rate. At ' + rate + ' B/s, ' + seconds + ' s is ' + budget +
          ' B in total. ADR-012 hybrid signing costs ' + perSignature + ' B per closure, so ' + closures +
          ' closures spend ' + floor + ' B on signatures before a single content byte' +
          (content > 0 ? ', leaving ' + content + ' B.'
            : '. That already exceeds the whole budget, so the three-second target is NOT ACHIEVABLE ' +
              'optically at any artifact size — not merely at a large one.')
        : 'PROJECTION over a measured rate, with Ed25519 only. ADR-022 §4.5 says measuring without the ' +
          'hybrid signature would flatter the result, so this row is here to show the difference and is ' +
          'not a criterion-5 answer: ' + closures + ' closures cost ' + floor + ' B of the ' + budget +
          ' B budget' + (content > 0 ? ', leaving ' + content + ' B.' : ', which exhausts it.')
    };
  }

  /**
   * What this module is not entitled to claim, kept here so the wording in a UI
   * or a report cannot drift from what the code does.
   */
  function describeLimits() {
    return [
      'The gate is not weakened, it is applied more times: every closure walks the whole ADR-016 §2.2 pipeline — order, identity, declared size, bounded decompression, digest, signature, admission — before one byte of it is used.',
      'Nothing here executes anything. "Running" means the gate opened and the activated bytes are readable; there is no RVM, so ADR-016 §2.2 step 6 and its capability check do not exist and this is one half of an invariant ADR-016 states twice.',
      'There is no radio tier in this repository, so ADR-022 §4.5’s "under 3 s at p95 on the radio tier" cannot be measured here and is not claimed.',
      'There are no hybrid signatures. crypto.js is Ed25519 only and there is no ML-DSA-65, so any timing taken here is Ed25519-only and is not a criterion-5 result; the hybrid figures this module returns are arithmetic projections over ADR-022’s own 3,309 bytes per signature.',
      'Optically the three-second target is not achievable at any artifact size under hybrid signing: at the measured 2.44 KB/s a three-second budget is 7,320 bytes and three hybrid-signed closures cost 10,119 bytes of signature before any content.',
      'Nothing splits an artifact into closures. The split is artifact-specific, the tooling does not exist, and a wrong split produces an agent that starts and immediately stalls — which this module cannot detect.',
      'The receipt is not ADR-134’s witness record. It is the shape of what a receipt must carry about a partial activation; nothing signs it and rvf-cli has never verified one.',
      'Digest, decompression and signature verification are all injected and all absent by default, so a closure is refused as unverified unless a caller supplies them. A check that cannot run never degrades into a pass.',
      'The bound on decompression is enforced outside the decompressor — the declared size is checked against the manifest before the inflater runs and is passed to it as a limit — but peak allocation inside a caller’s codec is not something this module can observe.',
      'Quarantine is a property of what the session and the agent view can reach. The caller already holds the bytes it offered, and a caller holding the session can write into the copies inside it; JavaScript cannot prevent either and this module does not pretend to.',
      'A refused closure inside the activation set abandons the activation rather than allowing a retry, so a damaged frame costs a whole activation. That is a deliberate trade against a retry-until-accepted oracle, and it makes this less tolerant of a lossy channel than a transport would like.',
      'Sealing incomplete is a decision a caller makes; nothing here decides it on a timeout, because there is no clock in this module.'
    ];
  }

  return {
    // the four closures
    ROLE_MANIFEST: ROLE_MANIFEST,
    ROLE_RUNTIME: ROLE_RUNTIME,
    ROLE_CODE: ROLE_CODE,
    ROLE_COLD: ROLE_COLD,
    ROLES: ROLES,
    ROLE_LABELS: ROLE_LABELS,
    ACTIVATION_ROLES: ACTIVATION_ROLES,

    // the verdict vocabulary
    STATE_VERIFIED: STATE_VERIFIED,
    STATE_MALFORMED: STATE_MALFORMED,
    STATE_FOREIGN: STATE_FOREIGN,
    STATE_UNORDERED: STATE_UNORDERED,
    STATE_SIZE_REFUSED: STATE_SIZE_REFUSED,
    STATE_INFLATION_REFUSED: STATE_INFLATION_REFUSED,
    STATE_DIGEST_MISMATCH: STATE_DIGEST_MISMATCH,
    STATE_UNSIGNED: STATE_UNSIGNED,
    STATE_FORGED: STATE_FORGED,
    STATE_UNVERIFIED: STATE_UNVERIFIED,
    STATES: STATES,

    // decision codes
    CODE_PENDING: CODE_PENDING,
    CODE_POLICY_UNDECLARED: CODE_POLICY_UNDECLARED,
    CODE_ROOT_UNDECLARED: CODE_ROOT_UNDECLARED,
    CODE_BLOCKED: CODE_BLOCKED,
    CODE_SEALED_INCOMPLETE: CODE_SEALED_INCOMPLETE,
    CODE_UNKNOWN_STATE: CODE_UNKNOWN_STATE,
    CODE_MALFORMED: CODE_MALFORMED,
    CODE_FOREIGN: CODE_FOREIGN,
    CODE_UNORDERED: CODE_UNORDERED,
    CODE_SIZE_REFUSED: CODE_SIZE_REFUSED,
    CODE_INFLATION_REFUSED: CODE_INFLATION_REFUSED,
    CODE_DIGEST_MISMATCH: CODE_DIGEST_MISMATCH,
    CODE_UNSIGNED: CODE_UNSIGNED,
    CODE_FORGED: CODE_FORGED,
    CODE_UNVERIFIED: CODE_UNVERIFIED,
    CODE_UNTRUSTED_SIGNER: CODE_UNTRUSTED_SIGNER,
    CODE_ROLE_REFUSED: CODE_ROLE_REFUSED,
    CODE_ADMITTED: CODE_ADMITTED,

    // completion states
    COMPLETION_BLOCKED: COMPLETION_BLOCKED,
    COMPLETION_TRANSFERRING: COMPLETION_TRANSFERRING,
    COMPLETION_PARTIAL: COMPLETION_PARTIAL,
    COMPLETION_COMPLETE: COMPLETION_COMPLETE,
    COMPLETION_INCOMPLETE: COMPLETION_INCOMPLETE,
    COMPLETIONS: COMPLETIONS,

    LIMITS: LIMITS,
    ED25519_SIGNATURE_BYTES: ED25519_SIGNATURE_BYTES,
    MLDSA65_SIGNATURE_BYTES: MLDSA65_SIGNATURE_BYTES,
    OPTICAL_BYTES_PER_SECOND: OPTICAL_BYTES_PER_SECOND,

    // the manifest and its order commitment
    canonicalManifestString: canonicalManifestString,
    parseManifest: parseManifest,
    closureSigningString: closureSigningString,

    // the pipeline, in the order it runs
    parseOffer: parseOffer,
    verifyClosure: verifyClosure,
    normalizePolicy: normalizePolicy,
    closureGate: closureGate,
    admitClosure: admitClosure,

    // the session
    beginActivation: beginActivation,
    expectationFor: expectationFor,
    offerClosure: offerClosure,
    sealIncomplete: sealIncomplete,
    completion: completion,
    gateOpen: gateOpen,
    positions: positions,
    agentView: agentView,
    activationReceipt: activationReceipt,

    // honesty
    describeUnimplemented: describeUnimplemented,
    hybridSignatureProjection: hybridSignatureProjection,
    opticalBudget: opticalBudget,
    describeLimits: describeLimits
  };
});
