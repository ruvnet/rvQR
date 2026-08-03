/*!
 * rvQR embedded provenance — SBOM, licences, signer policy, source revision,
 * build identity and vulnerability assertions as a native RVF segment.
 *
 * Per ADR-020. The decision this implements is short: a sidecar manifest is a
 * second file, and a second file crossing an optical channel is a second
 * transfer that can be omitted or substituted. Provenance that is optional is
 * provenance that is absent. So it travels in-band, inside the container, under
 * the same content hash as everything else.
 *
 * ---------------------------------------------------------------------------
 * What is taken from SLSA v1.2, and what is not
 * ---------------------------------------------------------------------------
 *
 * Where SLSA v1.2 defines a shape, this module emits SLSA's shape verbatim, so
 * `extractStatement()` hands an external verifier a document it already knows
 * how to read:
 *
 *   - The in-toto Statement wrapper: `_type`, `subject`, `predicateType`,
 *     `predicate` — https://in-toto.io/Statement/v1 and
 *     https://slsa.dev/provenance/v1.
 *   - `predicate.buildDefinition`: buildType, externalParameters,
 *     internalParameters, resolvedDependencies.
 *   - `predicate.runDetails`: builder{id, builderDependencies, version},
 *     metadata{invocationId, startedOn, finishedOn}, byproducts.
 *   - ResourceDescriptor: uri, digest, name, downloadLocation, mediaType,
 *     content, annotations. Every component, dependency and source revision in
 *     here is a ResourceDescriptor rather than a house-shaped record.
 *   - Source revision rides in `externalParameters.source` as a
 *     ResourceDescriptor with `digest.gitCommit`, which is how SLSA's own build
 *     types carry it — not as a parallel {repo, commit} field.
 *
 * Four deliberate deviations, each because SLSA v1.2 does not define the thing:
 *
 *   1. **The statement is emitted only when build identity is present.** SLSA
 *      requires `buildDefinition.buildType` and `runDetails.builder.id`; a
 *      statement without a build is not conformant provenance, it is a shape
 *      borrowed for decoration. An artifact with an SBOM but no known build
 *      therefore carries its components under `rvqr.sbom`, in the *same*
 *      ResourceDescriptor shape. One home at a time, chosen by a pure function
 *      of `present.build`, so the encoding stays canonical.
 *
 *   2. **Licences, signer policy and vulnerability assertions live under a
 *      namespaced `rvqr` sibling, not inside the predicate.** SLSA v1.2 defines
 *      none of them. Smuggling them into the predicate as unknown keys would
 *      make the document something a strict verifier must reject, to no benefit.
 *      Per-component licences and versions use `annotations`, which is the
 *      extension point in-toto actually provides.
 *
 *   3. **The reproducibility flag is an rvQR field.** SLSA has no field for it,
 *      and it is an assertion rather than a measurement — see the split below.
 *
 *   4. **Vulnerability assertions follow VEX** (OpenVEX status and justification
 *      vocabularies) rather than anything SLSA-shaped, because VEX is the
 *      standard for that claim. `not_affected` requires a justification, as VEX
 *      requires.
 *
 * Source provenance is *not* modelled as its own predicate: SLSA v1.2's source
 * track explicitly "leaves source provenance attestations undefined and up to
 * the SCSs", so there is no approved shape to follow. The revision goes in the
 * build definition where SLSA does define a home for it.
 *
 * ---------------------------------------------------------------------------
 * Checkable versus asserted
 * ---------------------------------------------------------------------------
 *
 * `verify()` splits every claim into two lists and never merges them. A hash a
 * receiver can recompute against bytes it holds is CHECKABLE and gets a
 * pass/fail. Everything else — who built it, on what, whether the build was
 * reproducible, which keys are allowed to sign, whether a CVE applies — is an
 * ASSERTION, reported as a claim with an author, never as a tick. This is the
 * same line the rest of this project draws between integrity and authenticity,
 * and between attestation and authorization: a signature proves who said a
 * thing, never that the thing is true.
 *
 * ---------------------------------------------------------------------------
 * Trust asymmetry
 * ---------------------------------------------------------------------------
 *
 * `encode()` throws on bad input, because its input is this app's own data and a
 * malformed provenance document must not be written. `decode()` never throws,
 * because its input arrived in a file from an unknown sender: every length,
 * count and string is bounded before it reaches an allocation, the way core.js
 * bounds a scanned frame.
 *
 * No DOM, no storage, no clock, no crypto. `verify()` takes a `sha256` function
 * from the caller rather than reaching for one, so the same code runs under Node
 * and in a worker; without one, hash checks report `unavailable` rather than
 * quietly passing.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RVQRProvenance = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Segment and document identity -----------------------------------------

  // The RVF segment type this lives in. The segment table bundled with this app
  // (rvf-types/src/segment_type.rs, mirrored in rvf.js) ends at 0x36
  // AggregateWeights, so 0x37 is the next free slot. If upstream later claims
  // 0x37 for something else this is a one-constant change — and a reader that
  // does not know the type must skip it rather than fail to open the container,
  // which is ADR-020's second acceptance criterion.
  var PROVENANCE_SEGMENT_TYPE = 0x37;

  // RVF v1 segment framing, as observed byte-exactly in the shipped demo
  // container: 'SFVR' | u8 version | u8 type | u16 flags | u64 id | u64 pad |
  // u64 payloadSize | ... | 16 bytes at offset 40 whose derivation this project
  // has not established | 8 zero bytes.
  var SEGMENT_MAGIC = [0x53, 0x46, 0x56, 0x52];
  var SEGMENT_HEADER_SIZE = 64;
  var SEGMENT_VERSION = 1;
  var MAX_SEGMENTS = 4096;

  // Payload framing: 'RVPV' | u8 version | u8 flags | u16 reserved |
  // u32 document length | canonical JSON document.
  var DOC_MAGIC = [0x52, 0x56, 0x50, 0x56];
  var DOC_VERSION = 1;
  var DOC_HEADER_SIZE = 12;

  var STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
  var PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

  // Annotation keys for the things a ResourceDescriptor has no field for.
  var ANN_VERSION = 'rvqr.dev/version';
  var ANN_PURPOSE = 'rvqr.dev/purpose';
  var ANN_LICENCES = 'rvqr.dev/licences';
  var ANN_SEGMENT = 'rvqr.dev/segment';
  var ANN_REF = 'rvqr.dev/ref';

  // --- Hostile-input ceilings ------------------------------------------------
  // A provenance segment arrives in a file from an unknown sender. Every one of
  // these bounds something that sender controls, and each is checked before the
  // value reaches an allocation or a loop.

  var LIMITS = {
    // 256 KiB. At the 2.44 KB/s measured for the optical channel that is already
    // 29 hours of scanning, so nothing legitimate is being excluded.
    documentBytes: 262144,
    // JSON nesting. Checked by scanning the text before JSON.parse ever sees it,
    // because a parser is the wrong place to discover a 100000-deep array.
    depth: 16,
    components: 1024,
    licences: 64,
    signerKeys: 64,
    signerScopes: 8,
    vulnAssertions: 1024,
    digests: 8,
    annotations: 16,
    // Free text: justifications, statements, download locations.
    string: 1024,
    // Names, versions, ids, URIs, build types.
    identifier: 256,
    // Base64 of a public key. Generous enough for a post-quantum key
    // (ML-DSA-87 is 2592 bytes raw); see ADR-012.
    publicKey: 8192,
    spdxId: 96,
    segmentIndex: MAX_SEGMENTS
  };

  // --- Controlled vocabularies -----------------------------------------------

  // Digest algorithms accepted in a ResourceDescriptor `digest` map, with the
  // hex lengths each must have. Anything else is refused rather than stored as
  // an opaque string nobody can check.
  var DIGEST_ALGORITHMS = {
    sha256: [64], sha512: [128], sha1: [40],
    gitCommit: [40, 64], gitTree: [40, 64]
  };

  var COMPONENT_PURPOSES = [
    'application', 'library', 'framework', 'container', 'operating-system',
    'device', 'firmware', 'file', 'data', 'source'
  ];

  // OpenVEX status vocabulary.
  var VEX_STATUSES = ['not_affected', 'affected', 'fixed', 'under_investigation'];

  // OpenVEX justifications. Required when the status is not_affected — a bare
  // "we are fine" is exactly the claim that needs a reason attached.
  var VEX_JUSTIFICATIONS = [
    'component_not_present',
    'vulnerable_code_not_present',
    'vulnerable_code_not_in_execute_path',
    'vulnerable_code_cannot_be_controlled_by_adversary',
    'inline_mitigations_already_exist'
  ];

  // What a key is permitted to sign. Deliberately coarse: this is evidence for a
  // policy, not a policy language.
  var SIGNER_SCOPES = ['manifest', 'provenance', 'payload', 'any'];

  // A partial SPDX registry — the common identifiers, not the full list, which
  // runs to several hundred and would cost more bytes than it earns here.
  // Membership is reported as `known`; syntactic validity is a separate and
  // stricter test. An id that is well-formed but unlisted is accepted and
  // flagged, never silently blessed.
  var SPDX_KNOWN = [
    '0BSD', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-1.1', 'Apache-2.0',
    'Artistic-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC0-1.0',
    'CC-BY-4.0', 'CC-BY-SA-4.0', 'CDDL-1.0', 'EPL-2.0', 'EUPL-1.2',
    'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
    'ISC', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only',
    'LGPL-3.0-or-later', 'MIT', 'MIT-0', 'MPL-2.0', 'PostgreSQL', 'Python-2.0',
    'Ruby', 'Unlicense', 'Unicode-DFS-2016', 'WTFPL', 'Zlib'
  ];

  // SPDX's own sentinels for "no licence" and "we did not determine one".
  // Absence of a licence and an undetermined licence are different states, and
  // SPDX already distinguishes them, so this does too.
  var SPDX_SENTINELS = ['NONE', 'NOASSERTION'];

  var SPDX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
  var LICENSE_REF_RE = /^(?:DocumentRef-[A-Za-z0-9.+-]+:)?LicenseRef-[A-Za-z0-9.+-]+$/;
  var RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  var HEX_RE = /^[0-9a-f]+$/;

  // ---------------------------------------------------------------------------
  // SPDX identifiers
  // ---------------------------------------------------------------------------

  /**
   * Syntactic validity only: a simple identifier, a LicenseRef, or a sentinel.
   * Licence *expressions* ("MIT OR Apache-2.0") are not identifiers and are
   * refused here — they belong in `licences.expression`, which is carried as
   * declared text precisely because this module does not parse it.
   */
  function isValidSpdxId(id) {
    if (typeof id !== 'string' || !id.length || id.length > LIMITS.spdxId) return false;
    if (SPDX_SENTINELS.indexOf(id) >= 0) return true;
    if (LICENSE_REF_RE.test(id)) return true;
    // Anything reaching for the LicenseRef grammar and missing it is a truncated
    // reference, not a licence that happens to be called "LicenseRef". Catching
    // it here stops a malformed ref from passing as an ordinary identifier.
    if (/^(?:DocumentRef|LicenseRef)/.test(id)) return false;
    if (!SPDX_ID_RE.test(id)) return false;
    // A trailing '+' is SPDX's "or later" operator and is legal on an id.
    return !/[.+-]{2}/.test(id);
  }

  /** Whether the id appears in the partial registry above. Never a gate. */
  function isKnownSpdxId(id) {
    return SPDX_KNOWN.indexOf(id) >= 0;
  }

  // ---------------------------------------------------------------------------
  // Canonical JSON
  // ---------------------------------------------------------------------------

  /**
   * RFC 8785-style canonicalisation: keys sorted by UTF-16 code unit, no
   * whitespace, one representation per value. Key order in the input object is
   * therefore irrelevant to the output bytes, which is the whole point — this
   * document is about to be covered by a content hash and eventually a
   * signature, and a hash that changes because a field moved is worthless.
   *
   * Numbers are restricted to safe integers rather than implementing JCS's
   * float grammar. Nothing in a provenance document is a float; refusing them
   * is cheaper and more honest than serialising one ambiguously.
   */
  function canonicalJson(value) {
    if (value === null) return 'null';
    var t = typeof value;
    if (t === 'boolean') return value ? 'true' : 'false';
    if (t === 'number') {
      if (!isFinite(value)) throw new Error('non-finite number in provenance document');
      if (Math.floor(value) !== value) throw new Error('non-integer number in provenance document');
      if (Math.abs(value) > 9007199254740991) throw new Error('integer outside the safe range');
      return String(value); // String(-0) is "0", so there is one zero
    }
    if (t === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(canonicalJson(value[i]));
      return '[' + items.join(',') + ']';
    }
    if (t === 'object') {
      var keys = [];
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined) keys.push(k);
      }
      keys.sort(); // default sort is code-unit order, which is what JCS specifies
      var out = [];
      for (var j = 0; j < keys.length; j++) {
        out.push(JSON.stringify(keys[j]) + ':' + canonicalJson(value[keys[j]]));
      }
      return '{' + out.join(',') + '}';
    }
    throw new Error('unserialisable value of type ' + t);
  }

  /**
   * Nesting depth of a JSON text, counted without parsing it. Runs before
   * JSON.parse so a document engineered to blow the parser's stack is refused
   * by a bounded loop instead.
   */
  function jsonDepth(text) {
    var depth = 0, max = 0, inString = false, escaped = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true;
        else if (c === 0x22) inString = false;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b || c === 0x5b) { // { [
        depth++;
        if (depth > max) max = depth;
        if (max > LIMITS.depth) return max; // no reason to keep counting
      } else if (c === 0x7d || c === 0x5d) { // } ]
        depth--;
        if (depth < 0) return LIMITS.depth + 1; // unbalanced; let the parser's
      }                                        // verdict be pre-empted
    }
    return max;
  }

  // ---------------------------------------------------------------------------
  // The empty provenance — absence as an explicit state
  // ---------------------------------------------------------------------------

  /**
   * Every block is present-or-absent explicitly, never implied by a missing
   * field. ADR-020's second rule, and the same rule ADR-002 applies to codecs:
   * 0 means "none" because someone wrote 0, not because nobody wrote anything.
   */
  function emptyProvenance() {
    return {
      subject: null,
      sbom: { present: false, components: [] },
      licences: { present: false, artifact: [], expression: null },
      signerPolicy: { present: false, requiredSigners: 0, keys: [] },
      source: { present: false, repository: null, commit: null, ref: null },
      build: {
        present: false, builder: null, buildType: null, invocationId: null,
        startedOn: null, finishedOn: null, reproducible: null
      },
      vulnerabilities: { present: false, assertions: [] }
    };
  }

  // ---------------------------------------------------------------------------
  // Validation of outbound provenance
  // ---------------------------------------------------------------------------

  function checkString(errors, v, max, what, required) {
    if (v === null || v === undefined || v === '') {
      if (required) errors.push(what + ' is required');
      return null;
    }
    if (typeof v !== 'string') { errors.push(what + ' must be a string'); return null; }
    if (v.length > max) { errors.push(what + ' exceeds ' + max + ' characters'); return null; }
    return v;
  }

  function checkDigest(errors, digest, what) {
    if (digest === null || digest === undefined) return null;
    if (typeof digest !== 'object' || Array.isArray(digest)) {
      errors.push(what + ' digest must be a map of algorithm to hex');
      return null;
    }
    var algs = Object.keys(digest);
    if (!algs.length) return null;
    if (algs.length > LIMITS.digests) { errors.push(what + ' declares too many digests'); return null; }
    var out = {};
    for (var i = 0; i < algs.length; i++) {
      var alg = algs[i];
      var lengths = DIGEST_ALGORITHMS[alg];
      if (!lengths) { errors.push(what + ' uses unsupported digest algorithm ' + alg); continue; }
      var hex = digest[alg];
      if (typeof hex !== 'string' || !HEX_RE.test(hex) || lengths.indexOf(hex.length) < 0) {
        errors.push(what + ' ' + alg + ' digest is not ' + lengths.join('/') + ' lowercase hex characters');
        continue;
      }
      out[alg] = hex;
    }
    return Object.keys(out).length ? out : null;
  }

  function checkLicenceList(errors, list, what) {
    if (!list) return [];
    if (!Array.isArray(list)) { errors.push(what + ' must be an array'); return []; }
    if (list.length > LIMITS.licences) { errors.push(what + ' exceeds ' + LIMITS.licences + ' entries'); return []; }
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = list[i];
      if (!isValidSpdxId(id)) { errors.push(what + ': "' + String(id).slice(0, 40) + '" is not a valid SPDX identifier'); continue; }
      if (seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    // A licence list is a set, so it is sorted and deduplicated. Two callers who
    // list the same licences in different orders must produce the same bytes.
    out.sort();
    return out;
  }

  function checkSegmentIndex(errors, v, what) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || Math.floor(v) !== v || v < 0 || v >= LIMITS.segmentIndex) {
      errors.push(what + ' must be a segment index between 0 and ' + (LIMITS.segmentIndex - 1));
      return null;
    }
    return v;
  }

  function checkComponent(errors, c, i) {
    var what = 'component ' + i;
    if (!c || typeof c !== 'object') { errors.push(what + ' must be an object'); return null; }
    var out = {
      name: checkString(errors, c.name, LIMITS.identifier, what + ' name', true),
      version: checkString(errors, c.version, LIMITS.identifier, what + ' version', false),
      uri: checkString(errors, c.uri, LIMITS.identifier, what + ' uri', false),
      downloadLocation: checkString(errors, c.downloadLocation, LIMITS.string, what + ' downloadLocation', false),
      mediaType: checkString(errors, c.mediaType, LIMITS.identifier, what + ' mediaType', false),
      purpose: null,
      digest: checkDigest(errors, c.digest, what),
      licences: checkLicenceList(errors, c.licences, what + ' licences'),
      segment: checkSegmentIndex(errors, c.segment, what + ' segment')
    };
    if (c.purpose !== null && c.purpose !== undefined && c.purpose !== '') {
      if (COMPONENT_PURPOSES.indexOf(c.purpose) < 0) {
        errors.push(what + ' purpose "' + String(c.purpose).slice(0, 40) + '" is not one of ' + COMPONENT_PURPOSES.join(', '));
      } else {
        out.purpose = c.purpose;
      }
    }
    return out;
  }

  function checkSignerKey(errors, k, i) {
    var what = 'signer key ' + i;
    if (!k || typeof k !== 'object') { errors.push(what + ' must be an object'); return null; }
    var scopes = [];
    var raw = Array.isArray(k.maySign) ? k.maySign : [];
    if (raw.length > LIMITS.signerScopes) errors.push(what + ' declares too many scopes');
    else {
      for (var s = 0; s < raw.length; s++) {
        if (SIGNER_SCOPES.indexOf(raw[s]) < 0) errors.push(what + ' scope "' + String(raw[s]).slice(0, 40) + '" is not one of ' + SIGNER_SCOPES.join(', '));
        else if (scopes.indexOf(raw[s]) < 0) scopes.push(raw[s]);
      }
    }
    if (!scopes.length) errors.push(what + ' must say what it may sign');
    scopes.sort();
    return {
      id: checkString(errors, k.id, LIMITS.identifier, what + ' id', true),
      algorithm: checkString(errors, k.algorithm, LIMITS.identifier, what + ' algorithm', true),
      publicKey: checkString(errors, k.publicKey, LIMITS.publicKey, what + ' publicKey', false),
      maySign: scopes
    };
  }

  function checkAssertion(errors, a, i) {
    var what = 'vulnerability assertion ' + i;
    if (!a || typeof a !== 'object') { errors.push(what + ' must be an object'); return null; }
    var status = null;
    if (VEX_STATUSES.indexOf(a.status) < 0) {
      errors.push(what + ' status "' + String(a.status).slice(0, 40) + '" is not one of ' + VEX_STATUSES.join(', '));
    } else {
      status = a.status;
    }
    var justification = null;
    if (a.justification !== null && a.justification !== undefined && a.justification !== '') {
      if (VEX_JUSTIFICATIONS.indexOf(a.justification) < 0) {
        errors.push(what + ' justification "' + String(a.justification).slice(0, 60) + '" is not an OpenVEX justification');
      } else {
        justification = a.justification;
      }
    }
    // VEX's own rule, kept rather than softened: not_affected without a reason
    // is an unfalsifiable claim, and this format has no room for those.
    if (status === 'not_affected' && !justification) {
      errors.push(what + ' is not_affected and must carry an OpenVEX justification');
    }
    return {
      advisory: checkString(errors, a.advisory, LIMITS.identifier, what + ' advisory', true),
      component: checkString(errors, a.component, LIMITS.identifier, what + ' component', false),
      status: status,
      justification: justification,
      statement: checkString(errors, a.statement, LIMITS.string, what + ' statement', false)
    };
  }

  function checkTimestamp(errors, v, what) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || v.length > 64 || !RFC3339_RE.test(v)) {
      errors.push(what + ' must be an RFC 3339 timestamp');
      return null;
    }
    return v;
  }

  /**
   * Normalises a caller's provenance into the full six-block model and reports
   * everything wrong with it at once. Returns { ok, errors, provenance }.
   */
  function validate(input) {
    var errors = [];
    var p = emptyProvenance();
    var src = input || {};

    if (src.subject) {
      var sub = src.subject;
      p.subject = {
        name: checkString(errors, sub.name, LIMITS.identifier, 'subject name', true),
        uri: checkString(errors, sub.uri, LIMITS.identifier, 'subject uri', false),
        digest: checkDigest(errors, sub.digest, 'subject'),
        segment: checkSegmentIndex(errors, sub.segment, 'subject segment')
      };
      if (!p.subject.digest) errors.push('subject must carry at least one digest');
    }

    if (src.sbom && src.sbom.present) {
      var comps = Array.isArray(src.sbom.components) ? src.sbom.components : [];
      if (comps.length > LIMITS.components) {
        errors.push('sbom declares ' + comps.length + ' components, over the limit of ' + LIMITS.components);
      } else {
        p.sbom.present = true;
        for (var i = 0; i < comps.length; i++) {
          var c = checkComponent(errors, comps[i], i);
          if (c) p.sbom.components.push(c);
        }
        if (!p.sbom.components.length) errors.push('sbom is marked present but lists no components');
      }
    }

    if (src.licences && src.licences.present) {
      p.licences.present = true;
      p.licences.artifact = checkLicenceList(errors, src.licences.artifact, 'artifact licences');
      p.licences.expression = checkString(errors, src.licences.expression, LIMITS.identifier, 'licence expression', false);
      if (!p.licences.artifact.length && !p.licences.expression) {
        errors.push('licences is marked present but names none');
      }
    }

    if (src.signerPolicy && src.signerPolicy.present) {
      var keys = Array.isArray(src.signerPolicy.keys) ? src.signerPolicy.keys : [];
      if (keys.length > LIMITS.signerKeys) {
        errors.push('signer policy declares ' + keys.length + ' keys, over the limit of ' + LIMITS.signerKeys);
      } else {
        p.signerPolicy.present = true;
        for (var k = 0; k < keys.length; k++) {
          var key = checkSignerKey(errors, keys[k], k);
          if (key) p.signerPolicy.keys.push(key);
        }
        if (!p.signerPolicy.keys.length) errors.push('signer policy is marked present but lists no keys');
        var req = src.signerPolicy.requiredSigners;
        if (typeof req !== 'number' || Math.floor(req) !== req || req < 1 || req > LIMITS.signerKeys) {
          errors.push('signer policy requiredSigners must be an integer of at least 1');
        } else if (req > p.signerPolicy.keys.length) {
          errors.push('signer policy requires ' + req + ' signers but lists only ' + p.signerPolicy.keys.length + ' keys');
        } else {
          p.signerPolicy.requiredSigners = req;
        }
      }
    }

    if (src.source && src.source.present) {
      p.source.present = true;
      p.source.repository = checkString(errors, src.source.repository, LIMITS.identifier, 'source repository', true);
      p.source.commit = checkString(errors, src.source.commit, LIMITS.identifier, 'source commit', true);
      p.source.ref = checkString(errors, src.source.ref, LIMITS.identifier, 'source ref', false);
      if (p.source.commit && !(HEX_RE.test(p.source.commit) && (p.source.commit.length === 40 || p.source.commit.length === 64))) {
        errors.push('source commit must be 40 or 64 lowercase hex characters');
      }
    }

    if (src.build && src.build.present) {
      p.build.present = true;
      p.build.builder = checkString(errors, src.build.builder, LIMITS.identifier, 'build builder', true);
      p.build.buildType = checkString(errors, src.build.buildType, LIMITS.identifier, 'build buildType', true);
      p.build.invocationId = checkString(errors, src.build.invocationId, LIMITS.identifier, 'build invocationId', false);
      p.build.startedOn = checkTimestamp(errors, src.build.startedOn, 'build startedOn');
      p.build.finishedOn = checkTimestamp(errors, src.build.finishedOn, 'build finishedOn');
      if (src.build.reproducible === true || src.build.reproducible === false) {
        p.build.reproducible = src.build.reproducible;
      } else if (src.build.reproducible !== null && src.build.reproducible !== undefined) {
        errors.push('build reproducible must be true, false or null');
      }
    }

    if (src.vulnerabilities && src.vulnerabilities.present) {
      var asserts = Array.isArray(src.vulnerabilities.assertions) ? src.vulnerabilities.assertions : [];
      if (asserts.length > LIMITS.vulnAssertions) {
        errors.push('vulnerabilities declares ' + asserts.length + ' assertions, over the limit of ' + LIMITS.vulnAssertions);
      } else {
        p.vulnerabilities.present = true;
        for (var v = 0; v < asserts.length; v++) {
          var a = checkAssertion(errors, asserts[v], v);
          if (a) p.vulnerabilities.assertions.push(a);
        }
        if (!p.vulnerabilities.assertions.length) {
          errors.push('vulnerabilities is marked present but lists no assertions');
        }
      }
    }

    return { ok: errors.length === 0, errors: errors, provenance: p };
  }

  // ---------------------------------------------------------------------------
  // Model to document
  // ---------------------------------------------------------------------------

  function nonEmpty(obj) {
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null) return true;
    }
    return false;
  }

  /** A component as an in-toto ResourceDescriptor, extensions in annotations. */
  function componentToDescriptor(c) {
    var ann = {};
    if (c.version) ann[ANN_VERSION] = c.version;
    if (c.purpose) ann[ANN_PURPOSE] = c.purpose;
    if (c.licences && c.licences.length) ann[ANN_LICENCES] = c.licences;
    if (c.segment !== null && c.segment !== undefined) ann[ANN_SEGMENT] = c.segment;
    var d = { name: c.name };
    if (c.uri) d.uri = c.uri;
    if (c.digest) d.digest = c.digest;
    if (c.downloadLocation) d.downloadLocation = c.downloadLocation;
    if (c.mediaType) d.mediaType = c.mediaType;
    if (nonEmpty(ann)) d.annotations = ann;
    return d;
  }

  function sourceToDescriptor(s) {
    var d = { uri: s.repository, digest: { gitCommit: s.commit } };
    if (s.ref) {
      d.annotations = {};
      d.annotations[ANN_REF] = s.ref;
    }
    return d;
  }

  function subjectToDescriptor(s) {
    var d = { name: s.name };
    if (s.uri) d.uri = s.uri;
    if (s.digest) d.digest = s.digest;
    if (s.segment !== null && s.segment !== undefined) d.annotations = { 'rvqr.dev/segment': s.segment };
    return d;
  }

  /**
   * Builds the wire document. Its shape is a pure function of which blocks are
   * present, which is what keeps the encoding canonical: there is exactly one
   * document for any given model.
   */
  function buildDocument(p) {
    var present = {
      sbom: p.sbom.present,
      licences: p.licences.present,
      signerPolicy: p.signerPolicy.present,
      source: p.source.present,
      build: p.build.present,
      vulnerabilities: p.vulnerabilities.present
    };

    var doc = { rvqrProvenance: DOC_VERSION, present: present };
    var descriptors = [];
    var i;
    for (i = 0; i < p.sbom.components.length; i++) {
      descriptors.push(componentToDescriptor(p.sbom.components[i]));
    }

    if (p.build.present) {
      // SLSA's own shape, emitted only when there is a build to describe.
      var ext = {};
      if (p.source.present) ext.source = sourceToDescriptor(p.source);
      var metadata = {};
      if (p.build.invocationId) metadata.invocationId = p.build.invocationId;
      if (p.build.startedOn) metadata.startedOn = p.build.startedOn;
      if (p.build.finishedOn) metadata.finishedOn = p.build.finishedOn;

      var buildDefinition = { buildType: p.build.buildType, externalParameters: ext };
      if (descriptors.length) buildDefinition.resolvedDependencies = descriptors;

      var runDetails = { builder: { id: p.build.builder } };
      if (nonEmpty(metadata)) runDetails.metadata = metadata;

      doc.statement = {
        _type: STATEMENT_TYPE,
        predicateType: PREDICATE_TYPE,
        subject: p.subject ? [subjectToDescriptor(p.subject)] : [],
        predicate: { buildDefinition: buildDefinition, runDetails: runDetails }
      };
    } else if (p.subject) {
      // No build, so no conformant SLSA statement — the subject still needs a
      // home, in the same ResourceDescriptor shape.
      doc.subject = subjectToDescriptor(p.subject);
    }

    var rvqr = {};
    if (!p.build.present && descriptors.length) rvqr.components = descriptors;
    if (!p.build.present && p.source.present) rvqr.source = sourceToDescriptor(p.source);
    if (p.build.present && p.build.reproducible !== null) rvqr.reproducible = p.build.reproducible;
    if (p.licences.present) {
      rvqr.licences = { artifact: p.licences.artifact };
      if (p.licences.expression) rvqr.licences.expression = p.licences.expression;
    }
    if (p.signerPolicy.present) {
      rvqr.signerPolicy = {
        requiredSigners: p.signerPolicy.requiredSigners,
        keys: p.signerPolicy.keys.map(function (k) {
          var out = { id: k.id, algorithm: k.algorithm, maySign: k.maySign };
          if (k.publicKey) out.publicKey = k.publicKey;
          return out;
        })
      };
    }
    if (p.vulnerabilities.present) {
      rvqr.vulnerabilities = p.vulnerabilities.assertions.map(function (a) {
        var out = { advisory: a.advisory, status: a.status };
        if (a.component) out.component = a.component;
        if (a.justification) out.justification = a.justification;
        if (a.statement) out.statement = a.statement;
        return out;
      });
    }
    if (nonEmpty(rvqr)) doc.rvqr = rvqr;
    return doc;
  }

  // ---------------------------------------------------------------------------
  // Encoding
  // ---------------------------------------------------------------------------

  function utf8Encode(text) {
    return new TextEncoder().encode(text);
  }

  /**
   * Provenance to segment payload bytes. Throws on invalid input: this side of
   * the boundary is our own data, and writing a malformed provenance document is
   * a bug to surface, not a state to represent.
   */
  function encode(provenance) {
    var v = validate(provenance);
    if (!v.ok) throw new Error('invalid provenance: ' + v.errors.join('; '));
    var doc = buildDocument(v.provenance);
    var text = canonicalJson(doc);
    var body = utf8Encode(text);
    if (body.length > LIMITS.documentBytes) {
      throw new Error('provenance document is ' + body.length + ' bytes, over the limit of ' + LIMITS.documentBytes);
    }
    var out = new Uint8Array(DOC_HEADER_SIZE + body.length);
    out.set(DOC_MAGIC, 0);
    out[4] = DOC_VERSION;
    out[5] = 0; // flags: none defined in v1; a reader must refuse the ones it
    out[6] = 0; // does not know rather than guess at their meaning
    out[7] = 0;
    new DataView(out.buffer).setUint32(8, body.length, true);
    out.set(body, DOC_HEADER_SIZE);
    return out;
  }

  /**
   * The same payload wrapped in an RVF v1 segment header, ready to concatenate
   * into a container. Bytes 40..55 of a v1 header carry a 16-byte field whose
   * derivation this project has not established — the shipped demo container
   * populates it with four rotations of a 32-bit value — so it is left zero
   * here rather than filled with something that looks like a checksum and is
   * not one.
   */
  function encodeSegment(provenance, id) {
    var payload = encode(provenance);
    var out = new Uint8Array(SEGMENT_HEADER_SIZE + payload.length);
    out.set(SEGMENT_MAGIC, 0);
    out[4] = SEGMENT_VERSION;
    out[5] = PROVENANCE_SEGMENT_TYPE;
    var dv = new DataView(out.buffer);
    dv.setUint32(8, (id || 0) >>> 0, true);
    dv.setUint32(16, payload.length, true);
    out.set(payload, SEGMENT_HEADER_SIZE);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Decoding — every value below arrived from an unknown sender
  // ---------------------------------------------------------------------------

  function Refused(reason) { this.reason = reason; }

  function refuse(reason) { throw new Refused(reason); }

  function takeString(v, max, what, required) {
    if (v === undefined || v === null) {
      if (required) refuse(what + ' is missing');
      return null;
    }
    if (typeof v !== 'string') refuse(what + ' is not a string');
    if (v.length > max) refuse(what + ' is ' + v.length + ' characters, over the limit of ' + max);
    return v;
  }

  function takeArray(v, max, what) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) refuse(what + ' is not an array');
    if (v.length > max) refuse(what + ' declares ' + v.length + ' entries, over the limit of ' + max);
    return v;
  }

  function takeObject(v, what) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) refuse(what + ' is not an object');
    return v;
  }

  function takeBool(v, what) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'boolean') refuse(what + ' is not a boolean');
    return v;
  }

  function takeDigest(v, what) {
    var d = takeObject(v, what);
    if (!d) return null;
    var algs = Object.keys(d);
    if (algs.length > LIMITS.digests) refuse(what + ' declares too many digests');
    var out = {};
    for (var i = 0; i < algs.length; i++) {
      var lengths = DIGEST_ALGORITHMS[algs[i]];
      if (!lengths) refuse(what + ' uses unsupported digest algorithm ' + algs[i].slice(0, 32));
      var hex = takeString(d[algs[i]], 160, what + ' ' + algs[i], true);
      if (!HEX_RE.test(hex) || lengths.indexOf(hex.length) < 0) {
        refuse(what + ' ' + algs[i] + ' digest is not ' + lengths.join('/') + ' lowercase hex characters');
      }
      out[algs[i]] = hex;
    }
    return Object.keys(out).length ? out : null;
  }

  function takeLicences(v, what) {
    var list = takeArray(v, LIMITS.licences, what);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = takeString(list[i], LIMITS.spdxId, what + ' entry', true);
      if (!isValidSpdxId(id)) refuse(what + ' entry "' + id.slice(0, 40) + '" is not a valid SPDX identifier');
      out.push(id);
    }
    return out;
  }

  function takeSegmentIndex(v, what) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || Math.floor(v) !== v || v < 0 || v >= LIMITS.segmentIndex) {
      refuse(what + ' is not a segment index below ' + LIMITS.segmentIndex);
    }
    return v;
  }

  function descriptorToComponent(d, what) {
    var o = takeObject(d, what);
    if (!o) refuse(what + ' is missing');
    var ann = takeObject(o.annotations, what + ' annotations') || {};
    if (Object.keys(ann).length > LIMITS.annotations) refuse(what + ' carries too many annotations');
    return {
      name: takeString(o.name, LIMITS.identifier, what + ' name', true),
      version: takeString(ann[ANN_VERSION], LIMITS.identifier, what + ' version', false),
      uri: takeString(o.uri, LIMITS.identifier, what + ' uri', false),
      downloadLocation: takeString(o.downloadLocation, LIMITS.string, what + ' downloadLocation', false),
      mediaType: takeString(o.mediaType, LIMITS.identifier, what + ' mediaType', false),
      purpose: (function () {
        var p = takeString(ann[ANN_PURPOSE], LIMITS.identifier, what + ' purpose', false);
        if (p !== null && COMPONENT_PURPOSES.indexOf(p) < 0) refuse(what + ' purpose "' + p.slice(0, 40) + '" is not a known purpose');
        return p;
      })(),
      digest: takeDigest(o.digest, what),
      licences: takeLicences(ann[ANN_LICENCES], what + ' licences'),
      segment: takeSegmentIndex(ann[ANN_SEGMENT], what + ' segment')
    };
  }

  function descriptorToSubject(d, what) {
    var o = takeObject(d, what);
    if (!o) refuse(what + ' is missing');
    var ann = takeObject(o.annotations, what + ' annotations') || {};
    return {
      name: takeString(o.name, LIMITS.identifier, what + ' name', true),
      uri: takeString(o.uri, LIMITS.identifier, what + ' uri', false),
      digest: takeDigest(o.digest, what),
      segment: takeSegmentIndex(ann[ANN_SEGMENT], what + ' segment')
    };
  }

  function descriptorToSource(d, what) {
    var o = takeObject(d, what);
    if (!o) refuse(what + ' is missing');
    var ann = takeObject(o.annotations, what + ' annotations') || {};
    var digest = takeDigest(o.digest, what);
    if (!digest || !digest.gitCommit) refuse(what + ' carries no gitCommit digest');
    return {
      present: true,
      repository: takeString(o.uri, LIMITS.identifier, what + ' uri', true),
      commit: digest.gitCommit,
      ref: takeString(ann[ANN_REF], LIMITS.identifier, what + ' ref', false)
    };
  }

  function parseDocument(doc) {
    var p = emptyProvenance();
    var root = takeObject(doc, 'document');
    if (!root) refuse('document is not an object');
    if (root.rvqrProvenance !== DOC_VERSION) {
      refuse('document version ' + JSON.stringify(root.rvqrProvenance) + ' is not ' + DOC_VERSION);
    }
    var present = takeObject(root.present, 'present map');
    if (!present) refuse('document carries no present map');

    var blocks = ['sbom', 'licences', 'signerPolicy', 'source', 'build', 'vulnerabilities'];
    var flags = {};
    for (var b = 0; b < blocks.length; b++) {
      var f = takeBool(present[blocks[b]], 'present.' + blocks[b]);
      if (f === null) refuse('present.' + blocks[b] + ' must be stated explicitly');
      flags[blocks[b]] = f;
    }

    var rvqr = takeObject(root.rvqr, 'rvqr block') || {};
    var descriptors = [];
    var i;

    if (flags.build) {
      var st = takeObject(root.statement, 'statement');
      if (!st) refuse('build is present but the statement is missing');
      if (st._type !== STATEMENT_TYPE) refuse('statement _type is not ' + STATEMENT_TYPE);
      if (st.predicateType !== PREDICATE_TYPE) refuse('statement predicateType is not ' + PREDICATE_TYPE);
      var pred = takeObject(st.predicate, 'predicate');
      if (!pred) refuse('statement carries no predicate');
      var bd = takeObject(pred.buildDefinition, 'buildDefinition');
      var rd = takeObject(pred.runDetails, 'runDetails');
      if (!bd || !rd) refuse('predicate is missing buildDefinition or runDetails');
      var builder = takeObject(rd.builder, 'builder');
      if (!builder) refuse('runDetails carries no builder');
      var meta = takeObject(rd.metadata, 'metadata') || {};

      p.build.present = true;
      p.build.buildType = takeString(bd.buildType, LIMITS.identifier, 'buildType', true);
      p.build.builder = takeString(builder.id, LIMITS.identifier, 'builder id', true);
      p.build.invocationId = takeString(meta.invocationId, LIMITS.identifier, 'invocationId', false);
      p.build.startedOn = takeString(meta.startedOn, 64, 'startedOn', false);
      p.build.finishedOn = takeString(meta.finishedOn, 64, 'finishedOn', false);
      if (p.build.startedOn && !RFC3339_RE.test(p.build.startedOn)) refuse('startedOn is not an RFC 3339 timestamp');
      if (p.build.finishedOn && !RFC3339_RE.test(p.build.finishedOn)) refuse('finishedOn is not an RFC 3339 timestamp');
      p.build.reproducible = takeBool(rvqr.reproducible, 'rvqr.reproducible');

      var subjects = takeArray(st.subject, 1, 'subject');
      if (subjects.length) p.subject = descriptorToSubject(subjects[0], 'subject');

      var ext = takeObject(bd.externalParameters, 'externalParameters') || {};
      if (flags.source) p.source = descriptorToSource(ext.source, 'externalParameters.source');
      descriptors = takeArray(bd.resolvedDependencies, LIMITS.components, 'resolvedDependencies');
    } else {
      if (root.statement !== undefined) refuse('a statement is present but build is not');
      if (root.subject !== undefined) p.subject = descriptorToSubject(root.subject, 'subject');
      if (flags.source) p.source = descriptorToSource(rvqr.source, 'rvqr.source');
      descriptors = takeArray(rvqr.components, LIMITS.components, 'rvqr.components');
    }

    if (flags.sbom) {
      if (!descriptors.length) refuse('sbom is present but no components were carried');
      p.sbom.present = true;
      for (i = 0; i < descriptors.length; i++) {
        p.sbom.components.push(descriptorToComponent(descriptors[i], 'component ' + i));
      }
    } else if (descriptors.length) {
      refuse('components were carried but sbom is marked absent');
    }

    if (flags.licences) {
      var lic = takeObject(rvqr.licences, 'rvqr.licences');
      if (!lic) refuse('licences is present but the block is missing');
      p.licences.present = true;
      p.licences.artifact = takeLicences(lic.artifact, 'artifact licences');
      p.licences.expression = takeString(lic.expression, LIMITS.identifier, 'licence expression', false);
      if (!p.licences.artifact.length && !p.licences.expression) refuse('licences is present but names none');
    }

    if (flags.signerPolicy) {
      var sp = takeObject(rvqr.signerPolicy, 'rvqr.signerPolicy');
      if (!sp) refuse('signerPolicy is present but the block is missing');
      p.signerPolicy.present = true;
      var keys = takeArray(sp.keys, LIMITS.signerKeys, 'signer keys');
      for (i = 0; i < keys.length; i++) {
        var k = takeObject(keys[i], 'signer key ' + i);
        if (!k) refuse('signer key ' + i + ' is missing');
        var scopes = takeArray(k.maySign, LIMITS.signerScopes, 'signer key ' + i + ' maySign');
        for (var s = 0; s < scopes.length; s++) {
          if (SIGNER_SCOPES.indexOf(scopes[s]) < 0) refuse('signer key ' + i + ' claims unknown scope');
        }
        if (!scopes.length) refuse('signer key ' + i + ' does not say what it may sign');
        p.signerPolicy.keys.push({
          id: takeString(k.id, LIMITS.identifier, 'signer key ' + i + ' id', true),
          algorithm: takeString(k.algorithm, LIMITS.identifier, 'signer key ' + i + ' algorithm', true),
          publicKey: takeString(k.publicKey, LIMITS.publicKey, 'signer key ' + i + ' publicKey', false),
          maySign: scopes.slice()
        });
      }
      if (!p.signerPolicy.keys.length) refuse('signerPolicy is present but lists no keys');
      var req = sp.requiredSigners;
      if (typeof req !== 'number' || Math.floor(req) !== req || req < 1 || req > p.signerPolicy.keys.length) {
        refuse('signerPolicy requiredSigners is not an integer between 1 and the number of keys');
      }
      p.signerPolicy.requiredSigners = req;
    }

    if (flags.vulnerabilities) {
      var list = takeArray(rvqr.vulnerabilities, LIMITS.vulnAssertions, 'vulnerability assertions');
      if (!list.length) refuse('vulnerabilities is present but lists no assertions');
      p.vulnerabilities.present = true;
      for (i = 0; i < list.length; i++) {
        var a = takeObject(list[i], 'assertion ' + i);
        if (!a) refuse('assertion ' + i + ' is missing');
        if (VEX_STATUSES.indexOf(a.status) < 0) refuse('assertion ' + i + ' carries an unknown VEX status');
        var just = takeString(a.justification, LIMITS.identifier, 'assertion ' + i + ' justification', false);
        if (just !== null && VEX_JUSTIFICATIONS.indexOf(just) < 0) refuse('assertion ' + i + ' carries an unknown VEX justification');
        if (a.status === 'not_affected' && !just) refuse('assertion ' + i + ' is not_affected without a justification');
        p.vulnerabilities.assertions.push({
          advisory: takeString(a.advisory, LIMITS.identifier, 'assertion ' + i + ' advisory', true),
          component: takeString(a.component, LIMITS.identifier, 'assertion ' + i + ' component', false),
          status: a.status,
          justification: just,
          statement: takeString(a.statement, LIMITS.string, 'assertion ' + i + ' statement', false)
        });
      }
    }

    return p;
  }

  /**
   * Segment payload bytes to provenance. Never throws — a malformed segment is
   * a reported state, because the alternative is an unhandled exception on a
   * path whose input is by definition attacker-controlled.
   */
  function decode(bytes) {
    try {
      if (!bytes || typeof bytes.length !== 'number') {
        return { ok: false, reason: 'no bytes were supplied' };
      }
      if (bytes.length < DOC_HEADER_SIZE) {
        return { ok: false, reason: 'payload is ' + bytes.length + ' bytes, shorter than the ' + DOC_HEADER_SIZE + '-byte header' };
      }
      var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      for (var m = 0; m < 4; m++) {
        if (u8[m] !== DOC_MAGIC[m]) return { ok: false, reason: 'payload does not start with the RVPV provenance magic' };
      }
      if (u8[4] !== DOC_VERSION) {
        return { ok: false, reason: 'provenance document version ' + u8[4] + ' is not ' + DOC_VERSION };
      }
      if (u8[5] !== 0) return { ok: false, reason: 'provenance document sets flag bits this version does not define' };
      if (u8[6] !== 0 || u8[7] !== 0) return { ok: false, reason: 'reserved header bytes are not zero' };

      var dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
      var declared = dv.getUint32(8, true);
      if (declared > LIMITS.documentBytes) {
        return { ok: false, reason: 'declares a ' + declared + '-byte document, over the limit of ' + LIMITS.documentBytes };
      }
      if (DOC_HEADER_SIZE + declared > u8.length) {
        return {
          ok: false,
          reason: 'declares ' + declared + ' bytes of document but the payload holds ' + (u8.length - DOC_HEADER_SIZE)
        };
      }
      if (DOC_HEADER_SIZE + declared !== u8.length) {
        // One encoding per document: trailing bytes would be a second
        // representation of the same claims, and a hash cannot be canonical
        // over two of those.
        return { ok: false, reason: (u8.length - DOC_HEADER_SIZE - declared) + ' unaccounted bytes follow the document' };
      }

      var text;
      try {
        text = new TextDecoder('utf-8', { fatal: true })
          .decode(u8.subarray(DOC_HEADER_SIZE, DOC_HEADER_SIZE + declared));
      } catch (e) {
        return { ok: false, reason: 'document is not well-formed UTF-8' };
      }

      var depth = jsonDepth(text);
      if (depth > LIMITS.depth) {
        return { ok: false, reason: 'document nests ' + depth + ' levels deep, over the limit of ' + LIMITS.depth };
      }

      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: 'document is not valid JSON' };
      }

      var provenance = parseDocument(parsed);

      // A received document that does not re-encode to the bytes it arrived as
      // is not canonical. That is reported rather than corrected: silently
      // rewriting it would break the hash it was supposed to be covered by.
      var canonical = false;
      try {
        canonical = canonicalJson(parsed) === text;
      } catch (e) {
        canonical = false;
      }

      return { ok: true, provenance: provenance, document: parsed, canonical: canonical, bytes: u8.length };
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      return { ok: false, reason: 'provenance could not be read: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  /** The SLSA statement, for handing to an external verifier. Null if absent. */
  function extractStatement(decoded) {
    if (!decoded || !decoded.ok || !decoded.document) return null;
    return decoded.document.statement || null;
  }

  // ---------------------------------------------------------------------------
  // Container access
  // ---------------------------------------------------------------------------

  /**
   * Walks the RVF segment chain in plain JavaScript. rvf.js does this through
   * the microkernel; provenance verification must not depend on loading WASM,
   * so this reader stands alone. Every length comes from the file, so every
   * length is checked against what is left of it.
   */
  function readSegmentTable(bytes) {
    if (!bytes || typeof bytes.length !== 'number') return { ok: false, reason: 'no bytes were supplied', segments: [] };
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var segments = [];
    var off = 0;
    while (off + SEGMENT_HEADER_SIZE <= u8.length && segments.length < MAX_SEGMENTS) {
      var ok = true;
      for (var m = 0; m < 4; m++) if (u8[off + m] !== SEGMENT_MAGIC[m]) ok = false;
      if (!ok) {
        return { ok: false, reason: 'no segment magic at offset ' + off, segments: segments };
      }
      var dv = new DataView(u8.buffer, u8.byteOffset + off, SEGMENT_HEADER_SIZE);
      var size = dv.getUint32(16, true);
      var payloadOffset = off + SEGMENT_HEADER_SIZE;
      if (size > u8.length - payloadOffset) {
        return {
          ok: false,
          reason: 'segment ' + segments.length + ' declares ' + size + ' bytes but only ' +
            (u8.length - payloadOffset) + ' remain',
          segments: segments
        };
      }
      segments.push({
        index: segments.length,
        version: u8[off + 4],
        type: u8[off + 5],
        id: dv.getUint32(8, true),
        offset: off,
        payloadOffset: payloadOffset,
        size: size
      });
      off = payloadOffset + size;
    }
    return { ok: true, segments: segments, trailing: u8.length - off };
  }

  /**
   * Reads a container's provenance. `provenanced: false` is a distinct state
   * from a failed read and from a pass — ADR-020's fourth acceptance criterion,
   * and the reason this returns three fields instead of a boolean.
   */
  function readContainer(bytes) {
    var table = readSegmentTable(bytes);
    if (!table.ok) {
      return { provenanced: false, ok: false, provenance: null, reason: table.reason, segments: table.segments };
    }
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var found = null;
    for (var i = 0; i < table.segments.length; i++) {
      if (table.segments[i].type === PROVENANCE_SEGMENT_TYPE) { found = table.segments[i]; break; }
    }
    if (!found) {
      return {
        provenanced: false, ok: true, provenance: null,
        reason: 'this container carries no provenance segment', segments: table.segments
      };
    }
    var decoded = decode(u8.subarray(found.payloadOffset, found.payloadOffset + found.size));
    return {
      provenanced: true,
      ok: decoded.ok,
      provenance: decoded.ok ? decoded.provenance : null,
      document: decoded.ok ? decoded.document : null,
      canonical: decoded.ok ? decoded.canonical : false,
      reason: decoded.ok ? null : decoded.reason,
      segment: found,
      segments: table.segments
    };
  }

  // ---------------------------------------------------------------------------
  // Verification: what can be checked here, and what is only claimed
  // ---------------------------------------------------------------------------

  function check(name, status, detail) {
    return { name: name, status: status, detail: detail };
  }

  function claim(name, value, vouchedBy, detail) {
    return { name: name, value: value, vouchedBy: vouchedBy, detail: detail };
  }

  /**
   * Splits a decoded provenance into checks a receiver can perform against the
   * bytes in front of it, and assertions only the builder can vouch for.
   *
   * `opts.sha256(Uint8Array) -> lowercase hex` is supplied by the caller. Where
   * it is missing, hash checks report `unavailable` and say so; they never
   * degrade into passes.
   *
   * Nothing here is a decision. Provenance is evidence for a policy, never the
   * policy — ADR-020's third rule, and the reason this function returns a
   * report rather than an admit/refuse.
   */
  function verify(provenance, containerBytes, opts) {
    var options = opts || {};
    var sha256 = typeof options.sha256 === 'function' ? options.sha256 : null;
    var report = {
      provenanced: !!provenance,
      checkable: [],
      asserted: [],
      checksPassed: 0, checksFailed: 0, checksUnavailable: 0,
      ok: false
    };

    if (!provenance) {
      report.checkable.push(check('Provenance segment', 'unavailable',
        'This container carries no provenance segment. Unprovenanced is a state, not a pass.'));
      report.checksUnavailable = 1;
      return report;
    }

    var table = containerBytes ? readSegmentTable(containerBytes) : { ok: false, segments: [], reason: 'no container bytes were supplied' };
    var u8 = containerBytes
      ? (containerBytes instanceof Uint8Array ? containerBytes : new Uint8Array(containerBytes))
      : null;

    function segmentPayload(index) {
      if (!u8 || !table.segments[index]) return null;
      var s = table.segments[index];
      return u8.subarray(s.payloadOffset, s.payloadOffset + s.size);
    }

    // --- checkable: component digests against the bytes they name ------------
    var bound = 0;
    for (var i = 0; i < provenance.sbom.components.length; i++) {
      var c = provenance.sbom.components[i];
      var label = c.name + (c.version ? ' ' + c.version : '');
      if (c.segment === null || c.segment === undefined) continue;
      bound++;
      if (!u8) {
        report.checkable.push(check('Component hash: ' + label, 'unavailable',
          'It names segment ' + c.segment + ', but no container was supplied to check it against.'));
        continue;
      }
      if (!table.ok && !table.segments[c.segment]) {
        report.checkable.push(check('Component hash: ' + label, 'fail',
          'It names segment ' + c.segment + ', and this container\'s segment chain could not be walked: ' + table.reason));
        continue;
      }
      if (!table.segments[c.segment]) {
        report.checkable.push(check('Component hash: ' + label, 'fail',
          'It names segment ' + c.segment + ', but this container has only ' + table.segments.length + ' segments.'));
        continue;
      }
      if (!c.digest || !c.digest.sha256) {
        report.checkable.push(check('Component hash: ' + label, 'unavailable',
          'It names segment ' + c.segment + ' but carries no SHA-256 to compare against.'));
        continue;
      }
      if (!sha256) {
        report.checkable.push(check('Component hash: ' + label, 'unavailable',
          'No SHA-256 implementation was supplied, so the claimed digest for segment ' + c.segment + ' was not recomputed.'));
        continue;
      }
      var actual;
      try {
        actual = sha256(segmentPayload(c.segment));
      } catch (err) {
        report.checkable.push(check('Component hash: ' + label, 'unavailable',
          'Hashing segment ' + c.segment + ' failed: ' + (err && err.message ? err.message : String(err))));
        continue;
      }
      var match = typeof actual === 'string' && actual.toLowerCase() === c.digest.sha256;
      report.checkable.push(check('Component hash: ' + label, match ? 'pass' : 'fail',
        match
          ? 'SHA-256 of segment ' + c.segment + ' matches the claimed digest.'
          : 'Segment ' + c.segment + ' hashes to ' + String(actual).slice(0, 16) + '…, but the SBOM claims ' +
            c.digest.sha256.slice(0, 16) + '…. The component in this container is not the one described.'));
    }

    if (provenance.sbom.present && !bound) {
      report.checkable.push(check('Component hashes', 'unavailable',
        provenance.sbom.components.length + ' components are listed, but none names a segment in this container, ' +
        'so none of their digests can be recomputed here.'));
    }
    if (!provenance.sbom.present) {
      report.checkable.push(check('SBOM', 'unavailable', 'No SBOM is present. Nothing is claimed about components.'));
    }

    // --- checkable: the subject, only when it names bytes we hold ------------
    if (provenance.subject) {
      if (provenance.subject.segment !== null && provenance.subject.segment !== undefined && u8 && sha256 && table.segments[provenance.subject.segment] && provenance.subject.digest && provenance.subject.digest.sha256) {
        var sactual = sha256(segmentPayload(provenance.subject.segment));
        var smatch = String(sactual).toLowerCase() === provenance.subject.digest.sha256;
        report.checkable.push(check('Subject digest', smatch ? 'pass' : 'fail',
          smatch
            ? 'The subject names segment ' + provenance.subject.segment + ', which hashes as claimed.'
            : 'The subject names segment ' + provenance.subject.segment + ', which does not hash as claimed.'));
      } else {
        report.checkable.push(check('Subject digest', 'unavailable',
          'The subject is "' + provenance.subject.name + '". It does not name bytes inside this container, so its digest ' +
          'describes something a receiver here cannot hold up against it.'));
      }
    }

    // --- checkable: the container itself -------------------------------------
    if (u8) {
      report.checkable.push(check('Segment chain', table.ok ? 'pass' : 'fail',
        table.ok
          ? table.segments.length + ' segments walked cleanly.'
          : 'The segment chain could not be walked: ' + table.reason));
    }

    // --- assertions: everything a receiver cannot test ------------------------
    if (provenance.build.present) {
      report.asserted.push(claim('Builder', provenance.build.builder, provenance.build.builder,
        'Who the artifact says built it. Nothing in this container can confirm it; only a signature over the ' +
        'provenance ties it to a key, and even then it proves who said it, not that it is true.'));
      report.asserted.push(claim('Build type', provenance.build.buildType, provenance.build.builder,
        'The build process the builder says it ran.'));
      if (provenance.build.invocationId) {
        report.asserted.push(claim('Invocation', provenance.build.invocationId, provenance.build.builder,
          'An identifier for the build run, checkable only against the builder\'s own logs.'));
      }
      if (provenance.build.startedOn || provenance.build.finishedOn) {
        report.asserted.push(claim('Build window',
          (provenance.build.startedOn || '?') + ' to ' + (provenance.build.finishedOn || '?'),
          provenance.build.builder,
          'Timestamps written by the builder. A clock is not evidence.'));
      }
      if (provenance.build.reproducible !== null) {
        report.asserted.push(claim('Reproducible', provenance.build.reproducible, provenance.build.builder,
          'A claim that rebuilding these inputs yields these bytes. Testing it means running the build again, ' +
          'which is exactly what a receiver on the far side of an air gap cannot do.'));
      }
    } else {
      report.asserted.push(claim('Build identity', null, null,
        'No build identity is present. This artifact does not say what produced it.'));
    }

    if (provenance.source.present) {
      report.asserted.push(claim('Source revision',
        provenance.source.repository + '@' + provenance.source.commit + (provenance.source.ref ? ' (' + provenance.source.ref + ')' : ''),
        provenance.build.present ? provenance.build.builder : null,
        'A commit id is verifiable against the repository it names — which is on the other side of the gap. ' +
        'Here it is a claim about where the bytes came from.'));
    }

    if (provenance.licences.present) {
      var lic = provenance.licences.artifact.slice();
      if (provenance.licences.expression) lic.push(provenance.licences.expression);
      report.asserted.push(claim('Licences', lic.join(', '), null,
        'Declared licensing. A licence is a legal statement, not a property of the bytes; nothing here tests it.'));
      for (var l = 0; l < provenance.licences.artifact.length; l++) {
        if (!isKnownSpdxId(provenance.licences.artifact[l])) {
          report.checkable.push(check('SPDX identifier: ' + provenance.licences.artifact[l], 'unavailable',
            'Well-formed, but not in the partial SPDX registry this build carries, so it is neither confirmed nor rejected.'));
        }
      }
    }

    if (provenance.signerPolicy.present) {
      report.asserted.push(claim('Signer policy',
        provenance.signerPolicy.requiredSigners + ' of ' + provenance.signerPolicy.keys.length + ' keys',
        null,
        'A signer policy carried inside the artifact it governs is a claim about who may sign, not an authorisation. ' +
        'The policy a receiver enforces has to come from the receiver — see ADR-016 and ADR-021.'));
    }

    if (provenance.vulnerabilities.present) {
      for (var v = 0; v < provenance.vulnerabilities.assertions.length; v++) {
        var a = provenance.vulnerabilities.assertions[v];
        report.asserted.push(claim('Vulnerability ' + a.advisory,
          a.status + (a.justification ? ' (' + a.justification + ')' : ''),
          provenance.build.present ? provenance.build.builder : null,
          'A VEX assertion about ' + (a.component || 'this artifact') + '. It states an opinion about exploitability; ' +
          'no scan runs here to test it.'));
      }
    } else {
      report.asserted.push(claim('Vulnerability assertions', null, null,
        'None are present. That is silence, not an all-clear.'));
    }

    for (var r = 0; r < report.checkable.length; r++) {
      if (report.checkable[r].status === 'pass') report.checksPassed++;
      else if (report.checkable[r].status === 'fail') report.checksFailed++;
      else report.checksUnavailable++;
    }
    report.ok = report.checksFailed === 0;
    return report;
  }

  /**
   * What this feature can and cannot prove, in one place, so the wording in the
   * UI cannot drift from what the code does.
   */
  function describeLimits() {
    return [
      'Provenance travels inside the container and is covered by its content hash — it cannot be separated from the bytes it describes.',
      'A hash a receiver can recompute is checked. Everything else is a claim, reported as a claim.',
      'A signature over provenance proves who wrote it, never that what it says is true: a compromised build system signs false provenance perfectly.',
      'An artifact with no provenance segment is unprovenanced. That is reported as its own state and never as a pass.',
      'Provenance is evidence for a policy decision, not the decision. Nothing here admits or refuses an artifact.'
    ];
  }

  return {
    PROVENANCE_SEGMENT_TYPE: PROVENANCE_SEGMENT_TYPE,
    SEGMENT_HEADER_SIZE: SEGMENT_HEADER_SIZE,
    DOC_MAGIC: DOC_MAGIC,
    DOC_VERSION: DOC_VERSION,
    DOC_HEADER_SIZE: DOC_HEADER_SIZE,
    STATEMENT_TYPE: STATEMENT_TYPE,
    PREDICATE_TYPE: PREDICATE_TYPE,
    LIMITS: LIMITS,
    DIGEST_ALGORITHMS: DIGEST_ALGORITHMS,
    COMPONENT_PURPOSES: COMPONENT_PURPOSES,
    VEX_STATUSES: VEX_STATUSES,
    VEX_JUSTIFICATIONS: VEX_JUSTIFICATIONS,
    SIGNER_SCOPES: SIGNER_SCOPES,
    SPDX_KNOWN: SPDX_KNOWN,
    isValidSpdxId: isValidSpdxId,
    isKnownSpdxId: isKnownSpdxId,
    canonicalJson: canonicalJson,
    jsonDepth: jsonDepth,
    emptyProvenance: emptyProvenance,
    validate: validate,
    encode: encode,
    encodeSegment: encodeSegment,
    decode: decode,
    extractStatement: extractStatement,
    readSegmentTable: readSegmentTable,
    readContainer: readContainer,
    verify: verify,
    describeLimits: describeLimits
  };
});
