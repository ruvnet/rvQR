/*!
 * rvQR adaptive compression — deciding on the envelope, not on the ratio.
 *
 * A compression ratio is a fact about a codec. It is not a reason to compress.
 * The receiver does not observe the payload; it observes frames, one symbol at
 * a time, and it pays a 28-byte header for every one of them plus a whole
 * manifest frame that carries no artifact at all. Compression removes payload
 * bytes and leaves that per-frame cost exactly where it was, so the question a
 * sender has to answer is not "did the bytes shrink" but "did the thing that
 * crosses the wire shrink" — and on a small artifact those two questions have
 * different answers often enough that answering the first one is a bug.
 *
 * So every decision here is made on, and reported with, TWO figures:
 *
 *   payloadGain    1 − compressed / original. The codec's number.
 *   envelopeGain   1 − envelope(compressed) / envelope(original). The
 *                  transport's number, and the only one that gates anything.
 *
 * Both are returned on every result, passing or failing, so a reader can see
 * the margin rather than take the verdict on trust. That is the same reason
 * semdelta.chooseDelta() returns both payload sizes and not just the winner.
 *
 * ---------------------------------------------------------------------------
 * THE GATE: 8% OF THE ENVELOPE, AND WHAT IT ACTUALLY REJECTS
 * ---------------------------------------------------------------------------
 *
 * ADR-003 §2.2 sets the bar at an 8% envelope shrink. That is a chosen margin,
 * not a derived constant: below it the saving does not repay putting a
 * decompressor on the critical path of a receiver whose whole promise is that
 * it works from a file:// URL with nothing installed. It is stated here rather
 * than buried, and `ENVELOPE_GAIN_GATE` is one number a caller can move.
 *
 * The gap between the two figures is small and it is real. Holding the chunk at
 * 764 B and the ASCII armour on, the band where the payload clears 8% and the
 * envelope does not is measured, by the arithmetic in this file, at:
 *
 *     original    compressed   payloadGain   envelopeGain   frames
 *        600 B        543 B        9.50%          7.95%      2 → 2
 *        764 B        694 B        9.16%          7.95%      2 → 2
 *      1,000 B        909 B        9.10%          7.95%      3 → 3
 *      1,528 B      1,395 B        8.70%          7.95%      3 → 3
 *      3,000 B      2,745 B        8.50%          7.98%      5 → 5
 *     10,000 B      9,190 B        8.10%          7.99%     15 → 14
 *
 * Every one of those would be compressed by a payload rule and is refused by
 * this one. The band narrows as the artifact grows, because the per-frame
 * header becomes a smaller fraction of the whole — which is the shape you would
 * expect, and is the reason the rule matters most exactly where compression is
 * least likely to pay anyway.
 *
 * THE OTHER FAILURE IS SIMPLER AND WORSE, and it is measured on real bytes: a
 * codec on incompressible input returns MORE bytes than it was given. Brotli
 * quality 6 on 8,192 bytes of crypto.randomBytes returns 8,196, and on the
 * already-Brotli-compressed WASM module (16,636 B) it returns 16,640. Both grow
 * the envelope — by 5 bytes, saving no frame — and both are refused here with
 * a negative gain reported rather than a clamp.
 *
 * WHAT THE ENVELOPE MODEL DOES NOT MODEL. The chunk is held fixed across the
 * comparison, so a symbol version cannot move: compression only ever shortens
 * the last frame's fill, never lengthens a frame, so it cannot push a symbol UP
 * a version. What it also cannot do is remove the manifest frame or the 28-byte
 * header, and that floor is the whole of the effect above. A caller comparing
 * across DIFFERENT chunk sizes is comparing two transports and should say so;
 * `envelopeBytes` takes the chunk as an argument for exactly that reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AVAILABLE WHERE — DETECTED, NEVER ASSUMED
 * ---------------------------------------------------------------------------
 *
 * A codec this module names is not a codec the platform has, and the two are
 * not close. Measured on Node v22.22.1 and read off the WHATWG Compression
 * Streams specification for the browser:
 *
 *   node:zlib          brotliCompressSync, zstdCompressSync (Node ≥ 22.15),
 *                      deflateRawSync. All three synchronous, all three real.
 *   CompressionStream  gzip, deflate, deflate-raw. NOT brotli. NOT zstd.
 *
 * That second line is where a plausible bug lives. Node's CompressionStream
 * ALSO accepts the format string 'brotli' — `new CompressionStream('brotli')`
 * constructs without error under Node v22.22.1 — and that is a Node extension,
 * not the web standard. Probing for it and concluding "this platform has
 * brotli" would claim, in a browser, a codec no browser implements. So
 * `detectCodecs()` records which probe succeeded and refuses to promote a
 * non-standard stream format into a browser capability: `streamFormats` lists
 * what constructed, `nonStandardStreamFormats` lists which of those are outside
 * the specification, and availability for brotli comes from node:zlib alone.
 *
 * NO CODEC AT ALL IS A FIRST-CLASS OUTCOME, not an error and not a fallback
 * that happened. `choose()` on an empty codec list returns a decision with
 * codecId CODEC_NONE and a reason saying so, which is exactly the shape it
 * returns when three codecs were tried and all three missed the gate. A
 * receiver reads the same manifest either way.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTIFIER MUST DETERMINE THE DECODER — ADR-027 §2.2
 * ---------------------------------------------------------------------------
 *
 * ADR-027 §2.2 records the defect this file must not repeat, and records it
 * twice over: RVF's `CompressionAlgo::Custom = 3` carries no sub-identifier, so
 * SCF-1, Brotli and anything else are all `Custom` and indistinguishable on the
 * wire; and ADR-034's one-bit `SEED_COMPRESSED` flag is documented as "Brotli-
 * compressed" beside a builder that calls the SCF-1 LZ77 codec. In both cases a
 * receiver holding the bytes cannot say what produced them.
 *
 * Three things follow, and all three are enforced rather than documented:
 *
 *   1. Ids are taken from ADR-003 §2.1 and none is minted here — 0 none,
 *      1 LZ4, 2 Zstd, 3 Custom, 4 Brotli, 5 SCF-1, 6 deflate-raw. Zstd at 2 is
 *      the DEFAULT and Brotli at 4 is the maximum-ratio option for WASM, HTML
 *      and metadata, both subject to the same 8% test, exactly as §2.1 and
 *      §2.3 decide.
 *
 *      Id 3 is RESERVED AND REFUSED. It is in the table only so that an
 *      incoming id 3 has a defined meaning — "refuse" — and it is not a codec
 *      this module can select: `usable: false`, so `decoderFor(3, …)` throws
 *      `ambiguous-codec`, `compressWith(…, 3, …)` throws before it looks for an
 *      implementation, and 3 reaches no codec axis, no preference order and no
 *      decision. THIS IS NOT AN ESCAPE HATCH; it is the absence of one, and it
 *      is what §2.1's "3 stays Custom and rvQR does not use it" requires. The
 *      alternative — leaving 3 out of the table — would let some later reader
 *      assign it, which is how the defect happened the first time.
 *
 *   2. `decoderFor(codecId, dictId, held)` is total and single-valued: for any
 *      admissible pair it names exactly one decoder, and for anything else it
 *      throws. It never falls back, never guesses, and never returns the bytes.
 *
 *   3. The dictionary is a SEPARATE identifier with its own version, because a
 *      codec id and a dictionary id are two different facts and one field
 *      cannot carry both. That is the same argument as (1), one level down.
 *
 * PROTO2.JS DOES NOT AGREE WITH THIS TABLE, and that is reported rather than
 * quietly worked around. `artifacts/proto2.js` ships CODEC_NAMES =
 * ['none','scf1','deflate-raw','brotli'], so its id 2 is deflate-raw where
 * ADR-003 §2.1 says Zstd, and its `parseFrame` refuses any id ≥ 4 with
 * `unknown-codec` — which is every extension id ADR-003 defines. Nothing here
 * modifies proto2.js. `describeWireDivergence()` states the disagreement in
 * full, and `wireCompatible()` answers, per codec, whether a v2 frame carrying
 * that id would survive the shipped parser today. A sender that ignores it
 * builds a transfer the receiver rejects on the first frame.
 *
 * ---------------------------------------------------------------------------
 * DICTIONARIES: THE PLUMBING IS BUILT, THE DICTIONARY IS NOT
 * ---------------------------------------------------------------------------
 *
 * ADR-003 §2.4 decided this and the decision is "specified now and trained
 * later": rvQR ships NO dictionary, and every manifest sets the dictionary id
 * to 0x0000. The field exists because RVF containers share a great deal of
 * structure and a dictionary trained on a corpus of them is the obvious next
 * gain on small containers — and because adding the field later would be
 * another format change, while carrying two zero bytes now is not.
 *
 * So what is implemented here is the MECHANISM and nothing else:
 *
 *   - `DICTIONARIES` is empty. No corpus has been assembled, no dictionary has
 *     been trained, and none is embedded in this file or any other.
 *   - `DICT_NONE` is 0 and it is the default at every entry point. There is no
 *     code path that selects a non-zero dictionary id unless a caller passes a
 *     dictionary it already holds.
 *   - `codecAxis()` emits a dictionary-bearing axis value only when handed one,
 *     so with rvQR as shipped every axis value is at dictId 0.
 *   - `resolveDictionary()` refuses, and cannot do anything else, when the id
 *     is one the receiver does not hold.
 *
 * The figures below are EVIDENCE THAT THE FIELD IS WORTH CARRYING, measured to
 * justify the plumbing. They are not a dictionary and nothing here ships them.
 * Held out honestly — `artifacts/core.js`'s first 16,384 bytes as the
 * dictionary, prefixes of `artifacts/app.js` as the payload, two files a
 * receiver of this app genuinely already holds — deflate-raw level 9 measures:
 *
 *     payload    no dictionary   with dictionary   envelopeGain  →  with dict
 *       256 B        193 B            123 B           16.94%        35.76%
 *       512 B        333 B            255 B           28.55%        40.95%
 *     1,024 B        587 B            472 B           39.90%        49.70%
 *     2,048 B      1,045 B            798 B           46.44%        57.58%
 *     4,096 B      1,876 B          1,563 B           52.95%        60.14%
 *
 * WHAT A SHARED DICTIONARY COSTS, stated plainly because it is not free:
 *
 *   BOTH SIDES MUST ALREADY HOLD IT, at the same version, before the transfer
 *   starts. The receiver is offline by construction — that is the premise of
 *   the whole app — so it cannot fetch a dictionary it is missing. A dictionary
 *   is therefore not a compression setting; it is a deployment dependency, and
 *   shipping one means every receiver that will ever decode this stream already
 *   had it. That is the cost §2.4 is deferring, and it is why the right move is
 *   to carry the field and ship no data.
 *
 *   A MISMATCH IS SILENT AT THE CODEC LAYER. This was measured, not assumed.
 *   `zlib.deflateRawSync(rvf, {dictionary: correct})` decoded under
 *   `inflateRawSync` with a WRONG 1,024-byte dictionary returned 2,304 bytes —
 *   the right length, the wrong bytes — and threw nothing. Raw deflate has no
 *   checksum; that is what "raw" means. Zstd behaved the same way with a raw
 *   prefix dictionary: `zstdDecompressSync` with the wrong 1,024 bytes returned
 *   2,304 wrong bytes and no error. Omitting the dictionary entirely did throw
 *   in both cases (Z_DATA_ERROR, ZSTD_error_corruption_detected) — but "I have
 *   no dictionary" is the easy failure. The dangerous one is "I have the wrong
 *   one", and neither codec catches it.
 *
 *   SO FAIL-CLOSED IS THIS MODULE'S JOB AND NOT THE CODEC'S.
 *   `resolveDictionary()` requires an exact match on all three of id, version
 *   and the SHA-256 of the dictionary bytes, checked BEFORE a decoder is
 *   handed back, and throws on any disagreement. It has no fallback path: there
 *   is no branch in it that returns a decoder for a dictionary it could not
 *   confirm. Note what this buys and what it does not — proto2.finalize() would
 *   eventually catch the garbage above when the reconstructed SHA-256 missed,
 *   but only after the entire transfer had been spent. Refusing at the manifest
 *   costs one frame.
 *
 *   NODE'S BROTLI SILENTLY IGNORES A DICTIONARY OPTION. Measured:
 *   `brotliCompressSync(rvf, {dictionary: d})` and `brotliCompressSync(rvf)`
 *   both return 1,746 bytes, and no error is raised. A caller could therefore
 *   believe it had produced a dictionary-compressed stream and label it as one.
 *   `CODECS` marks brotli `supportsDictionary: false` and `compressWith()`
 *   refuses a dictionary for it rather than passing an option that does nothing.
 *
 * ---------------------------------------------------------------------------
 * THE PLANNER SEES THIS AS AN AXIS, NOT AS A SECOND MECHANISM
 * ---------------------------------------------------------------------------
 *
 * planner.js already treats granularity as a candidate axis: `candidates()`
 * crosses it into the grid, and it acts on J by changing `streamBytes()`, which
 * changes frames, which changes seconds and wire bytes. A codec does precisely
 * the same thing to precisely the same term. It is not a separate decision that
 * runs before or after the plan; it is one more column in the same table, and
 * modelling it any other way would produce a sender that picks a framing to
 * optimise J and then changes the stream length underneath it.
 *
 * `codecAxis()` produces the axis values the way planner produces its
 * `granularities` array, `expandCandidates()` crosses them in, and
 * `scoreAxis()` scores the result on planner's OWN J — its exported weights,
 * its exported `transferModel`, its exported `costTerms` — against ONE shared
 * reference at the original artifact size. The shared reference is the whole
 * subtlety: planner normalises against the reference strategy evaluated in the
 * same situation, so handing it a situation whose artifact is already
 * compressed would shrink the basis along with the candidate and score every
 * codec at B = 1. Rebasing is done here, explicitly, and `scoreAxis()` on the
 * CODEC_NONE axis value is asserted by the test suite to reproduce
 * planner.costTerms() exactly — which is the cheapest available check that the
 * rebasing did not invent an objective of its own.
 *
 * TWO CHANGES TO planner.js ARE NEEDED TO FOLD THIS IN PROPERLY, and neither is
 * made here — `describePlannerChanges()` states them so they are reviewable
 * rather than assumed:
 *
 *   (a) `streamBytes()` must return the codec's measured stream length when the
 *       candidate carries one, and `candidates()` must cross the codec axis in.
 *       Without that, planner cannot see a codec at all and this module has to
 *       rebase from outside.
 *   (b) `energyModel()` charges verification per `s.artifact.bytes`. Under
 *       compression that is the stream, not the artifact, and the receiver
 *       hashes the artifact — so E is charged on the wrong quantity, and there
 *       is no decode-energy term at all. The error is small at the modelled
 *       weight (ENERGY_PER_VERIFIED_BYTE is 2.0e-6 per byte against slot counts
 *       in the tens to thousands) and E is already the term planner's own
 *       docblock calls its weakest, but it is an error and it is stated rather
 *       than absorbed.
 *
 * The axis is offered for WHOLE-ARTIFACT candidates only. Compressing a delta
 * is a real case and is fully supported through `evaluate()` — but planner's
 * delta size is itself a projection from declared overlap, so scoring a codec
 * against a projected delta would be a projection of a projection. The sender
 * builds the real delta with semdelta.chooseDelta(), which measures it, and
 * then this module runs on that measured stream like any other.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything that DECIDES is a pure function over plain numbers: no DOM, no
 * storage, no network, and no clock — encode timings are not an input to any
 * branch here, so a decision made twice on the same bytes is the same decision.
 * The codecs themselves are injected, so the tests run without depending on
 * which of them this platform happens to have.
 *
 * Browser: load core.js before this file.
 * Node:    require('./compress.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.RVQRCompress = factory(root.RVQRCore);
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  // --- The gate --------------------------------------------------------------

  /**
   * ADR-003 §2.2. An envelope that does not shrink by this much is not worth a
   * decompressor on the receive path. A chosen margin, not a derived one.
   */
  var ENVELOPE_GAIN_GATE = 0.08;

  /**
   * ADR-003 §2.3: below this, compress the whole artifact and compare for real.
   * Above it, compress a bounded prefix to estimate — and then compress in full
   * and re-apply the gate to the real result, because an estimate that says yes
   * is a reason to measure, never a reason to ship.
   */
  var SAMPLE_ABOVE_BYTES = 8 * 1024 * 1024;
  var SAMPLE_PREFIX_BYTES = 1024 * 1024;

  // --- Frame geometry --------------------------------------------------------
  // proto2.js's constants, restated as arithmetic rather than imported, the way
  // planner.js restates delta.js's table sizes. The test suite loads proto2.js
  // when it can and asserts these two numbers still match it, so a drift is a
  // failing test rather than a silently wrong envelope.

  var HEADER_BYTES = 28;
  var MANIFEST_FIXED_BYTES = 47;

  /** v2's ASCII armour is 8 bytes out for every 7 in, rounded up PER FRAME. */
  var ARMOUR_NUMERATOR = 8;
  var ARMOUR_DENOMINATOR = 7;

  /** The operating point §1 and §10 measure against: v2 armoured at 19-L. */
  var DEFAULT_CHUNK_BYTES = 764;
  var DEFAULT_NAME_BYTES = 12;

  // --- Codec identifiers -----------------------------------------------------
  // ADR-003 §2.1. 0, 1 and 2 are RuVector's, from CompressionAlgo in
  // crates/rvf/rvf-types/src/compression.rs, because a frame and a segment must
  // never disagree about them. 3 is Custom and rvQR does not use it. 4, 5 and 6
  // are rvQR extensions and are labelled as such wherever they appear.

  var CODEC_NONE = 0;
  var CODEC_LZ4 = 1;
  var CODEC_ZSTD = 2;
  var CODEC_CUSTOM = 3;
  var CODEC_BROTLI = 4;
  var CODEC_SCF1 = 5;
  var CODEC_DEFLATE_RAW = 6;

  /** 0 is "no dictionary", declared. Same rule as the codec id. */
  var DICT_NONE = 0;

  // --- Hostile-input ceilings ------------------------------------------------
  // A manifest is unauthenticated input from whatever was pointed at the camera,
  // so anything read out of one is bounded before it reaches arithmetic.

  var MAX_STREAM_BYTES = core && core.MAX_ARTIFACT_BYTES ? core.MAX_ARTIFACT_BYTES : 256 * 1024 * 1024;
  var MAX_DICTIONARY_BYTES = 1024 * 1024;
  var MAX_AXIS_VALUES = 32;
  var MAX_CANDIDATES = 256;

  /**
   * Every rejection from this module is a CompressError with a stable `reason`
   * string, matching delta.js, semdelta.js and planner.js. Callers switch on
   * the reason; the message is for humans.
   */
  function CompressError(reason, message) {
    var err = new Error(message || reason);
    err.name = 'CompressError';
    err.reason = reason;
    return err;
  }

  function fail(reason, message) {
    throw CompressError(reason, message);
  }

  // --- Arithmetic helpers ----------------------------------------------------

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function num(value, fallback) {
    return isFiniteNumber(value) ? value : fallback;
  }

  function clamp01(n) {
    if (!isFiniteNumber(n)) return 1;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function byteLength(value) {
    if (value === null || value === undefined) return null;
    if (isFiniteNumber(value)) return value;
    if (isFiniteNumber(value.length)) return value.length;
    if (isFiniteNumber(value.byteLength)) return value.byteLength;
    return null;
  }

  function pct(fraction) {
    return (fraction * 100).toFixed(2) + '%';
  }

  // --- The envelope ----------------------------------------------------------

  /**
   * Total bytes a receiver observes for an indexed v2 transfer of `streamBytes`.
   *
   * Every frame pays HEADER_BYTES. Frame zero carries the manifest body instead
   * of payload, so it is a whole extra frame carrying no artifact at all — and
   * it is the term that makes a small artifact's envelope refuse to shrink the
   * way its payload does. Armouring multiplies each frame by 8/7 rounded up PER
   * FRAME, not once at the end, because each frame is armoured separately and
   * each rounds up separately.
   *
   * This is arithmetic over restated constants, not a measurement. It is the
   * same model bench/suites/compress.mjs uses, and that harness checks it
   * against frames the real proto2.buildFrames() produced.
   */
  function envelopeBytes(streamBytes, opts) {
    opts = opts || {};
    var stream = Math.max(0, Math.floor(num(streamBytes, 0)));
    if (stream > MAX_STREAM_BYTES) {
      fail('stream-too-large', stream + ' B exceeds the ' + MAX_STREAM_BYTES + ' B ceiling');
    }
    var chunk = Math.max(1, Math.floor(num(opts.chunk, DEFAULT_CHUNK_BYTES)));
    var armour = opts.armour !== false;
    var nameLen = Math.max(0, Math.floor(num(opts.nameLen, DEFAULT_NAME_BYTES)));
    var header = Math.max(0, Math.floor(num(opts.headerBytes, HEADER_BYTES)));
    var manifestFixed = Math.max(0, Math.floor(num(opts.manifestFixedBytes, MANIFEST_FIXED_BYTES)));

    var per = armour
      ? function (n) { return Math.ceil((n * ARMOUR_NUMERATOR) / ARMOUR_DENOMINATOR); }
      : function (n) { return n; };

    var total = per(header + manifestFixed + nameLen);
    var full = Math.floor(stream / chunk);
    var tail = stream - full * chunk;
    total += full * per(header + chunk);
    if (tail > 0) total += per(header + tail);

    return {
      bytes: total,
      frames: 1 + Math.ceil(stream / chunk),
      dataFrames: Math.ceil(stream / chunk),
      chunk: chunk,
      armour: armour,
      headerBytes: header,
      manifestBytes: manifestFixed + nameLen
    };
  }

  // --- The codec registry ----------------------------------------------------

  /**
   * Every identifier rvQR can put on a frame, what decodes it, and where that
   * decoder actually exists. `implemented: false` is a first-class row: SCF-1
   * and LZ4 are named by the format and have no JavaScript in this repository,
   * so they are listed as unavailable everywhere rather than omitted, because a
   * receiver still has to be able to say what an incoming id 5 means.
   *
   * `usable: false` on CODEC_CUSTOM is the ADR-027 §2.2 defect, refused by
   * construction: an id that does not determine a decoder cannot be selected.
   */
  var CODECS = [
    {
      id: CODEC_NONE,
      name: 'none',
      family: 'none',
      spec: 'no codec — the stream is the artifact',
      origin: 'RuVector CompressionAlgo::None',
      usable: true,
      implemented: true,
      supportsDictionary: false,
      nodeModule: null,
      streamFormat: null
    },
    {
      id: CODEC_LZ4,
      name: 'lz4',
      family: 'lz4',
      spec: 'LZ4 block format',
      origin: 'RuVector CompressionAlgo::Lz4',
      usable: true,
      implemented: false,
      unimplementedReason: 'no LZ4 implementation exists in this repository, in Node or in any browser',
      supportsDictionary: false,
      nodeModule: null,
      streamFormat: null
    },
    {
      id: CODEC_ZSTD,
      name: 'zstd',
      family: 'zstd',
      spec: 'Zstandard, RFC 8878',
      origin: 'RuVector CompressionAlgo::Zstd — the default codec, ADR-003 §2.1',
      usable: true,
      implemented: true,
      supportsDictionary: true,
      nodeModule: 'zstd',
      streamFormat: null
    },
    {
      id: CODEC_CUSTOM,
      name: 'custom',
      family: 'ambiguous',
      spec: 'RuVector CompressionAlgo::Custom — carries no sub-identifier',
      origin: 'RuVector CompressionAlgo::Custom',
      usable: false,
      unusableReason: 'ADR-027 §2.2: Custom names no decoder. SCF-1, Brotli and ' +
        'anything else are all id 3 and indistinguishable on the wire, which is ' +
        'the defect this module exists not to repeat',
      implemented: false,
      supportsDictionary: false,
      nodeModule: null,
      streamFormat: null
    },
    {
      id: CODEC_BROTLI,
      name: 'brotli',
      family: 'brotli',
      spec: 'Brotli, RFC 7932',
      origin: 'rvQR extension id, ADR-003 §2.1 — RuVector does not name Brotli',
      usable: true,
      implemented: true,
      // Node's zlib exposes no brotli dictionary parameter, and passing
      // {dictionary} is silently ignored — measured at 1,746 B either way.
      supportsDictionary: false,
      nodeModule: 'brotli',
      streamFormat: null
    },
    {
      id: CODEC_SCF1,
      name: 'scf1',
      family: 'scf1',
      spec: 'SCF-1, the zero-dependency LZ77 codec in the RVF runtime',
      origin: 'rvQR extension id, ADR-003 §2.1 — carried for RVQS interoperability',
      usable: true,
      implemented: false,
      unimplementedReason: 'SCF-1 exists only in Rust in the RVF runtime; there is ' +
        'no JavaScript implementation in this repository to compress or decode with',
      supportsDictionary: false,
      nodeModule: null,
      streamFormat: null
    },
    {
      id: CODEC_DEFLATE_RAW,
      name: 'deflate-raw',
      family: 'deflate',
      spec: 'raw DEFLATE, RFC 1951 — no zlib wrapper, no checksum',
      origin: 'rvQR extension id, ADR-003 §2.1 — the one codec every browser has',
      usable: true,
      implemented: true,
      supportsDictionary: true,
      nodeModule: 'deflateRaw',
      streamFormat: 'deflate-raw'
    }
  ];

  /** The WHATWG Compression Streams formats. Anything else is an extension. */
  var STANDARD_STREAM_FORMATS = ['gzip', 'deflate', 'deflate-raw'];

  function codecById(id) {
    for (var i = 0; i < CODECS.length; i++) if (CODECS[i].id === id) return CODECS[i];
    return null;
  }

  function codecByName(name) {
    for (var i = 0; i < CODECS.length; i++) if (CODECS[i].name === name) return CODECS[i];
    return null;
  }

  /**
   * What this platform actually has, probed rather than assumed.
   *
   * `env` is injectable so the tests can present a platform that does not exist
   * on the machine running them — a browser with no zlib, a Node without zstd,
   * a platform with nothing at all — and so nothing here reaches for a global.
   *
   * The brotli rule is the one worth reading twice. `new CompressionStream(
   * 'brotli')` constructs under Node v22.22.1 and does not construct in any
   * browser: it is a Node extension to the WHATWG list. So a successful probe
   * for it is recorded in `nonStandardStreamFormats` and does NOT make brotli
   * available — brotli's availability comes from node:zlib's synchronous
   * functions alone. Claiming otherwise would be claiming a browser codec that
   * does not exist, which is the failure this whole file is organised around.
   */
  function detectCodecs(env) {
    env = env || {};
    var zlib = env.zlib || null;
    var CS = env.CompressionStream || null;
    var DS = env.DecompressionStream || null;

    var streamFormats = [];
    var nonStandardStreamFormats = [];
    if (typeof CS === 'function' && typeof DS === 'function') {
      var probes = (env.probeFormats || STANDARD_STREAM_FORMATS.concat(['brotli', 'br', 'zstd']));
      for (var p = 0; p < probes.length; p++) {
        var format = probes[p];
        var ok = false;
        try {
          /* eslint-disable no-new */
          new CS(format);
          new DS(format);
          /* eslint-enable no-new */
          ok = true;
        } catch (e) {
          ok = false;
        }
        if (!ok) continue;
        streamFormats.push(format);
        if (STANDARD_STREAM_FORMATS.indexOf(format) < 0) nonStandardStreamFormats.push(format);
      }
    }

    function zlibHas(a, b) {
      return !!zlib && typeof zlib[a] === 'function' && typeof zlib[b] === 'function';
    }

    var rows = [];
    for (var i = 0; i < CODECS.length; i++) {
      var codec = CODECS[i];
      var available = false;
      var via = null;
      var why = '';

      if (!codec.usable) {
        why = codec.unusableReason;
      } else if (!codec.implemented) {
        why = codec.unimplementedReason;
      } else if (codec.id === CODEC_NONE) {
        available = true;
        via = 'none';
        why = 'sending the artifact as it stands needs nothing installed';
      } else if (codec.id === CODEC_ZSTD) {
        available = zlibHas('zstdCompressSync', 'zstdDecompressSync');
        via = available ? 'node:zlib' : null;
        why = available
          ? 'node:zlib zstdCompressSync / zstdDecompressSync'
          : 'node:zlib has no synchronous zstd, and no browser exposes zstd through ' +
            'CompressionStream — the WHATWG format list is gzip, deflate, deflate-raw';
      } else if (codec.id === CODEC_BROTLI) {
        available = zlibHas('brotliCompressSync', 'brotliDecompressSync');
        via = available ? 'node:zlib' : null;
        why = available
          ? 'node:zlib brotliCompressSync / brotliDecompressSync'
          : 'node:zlib has no synchronous brotli. A CompressionStream that accepts ' +
            '\'brotli\' is a Node extension and is not evidence of browser brotli';
      } else if (codec.id === CODEC_DEFLATE_RAW) {
        if (zlibHas('deflateRawSync', 'inflateRawSync')) {
          available = true;
          via = 'node:zlib';
          why = 'node:zlib deflateRawSync / inflateRawSync';
        } else if (streamFormats.indexOf('deflate-raw') >= 0) {
          available = true;
          via = 'CompressionStream';
          why = 'CompressionStream(\'deflate-raw\'), which is asynchronous — a caller ' +
            'must await it, and it accepts no dictionary';
        } else {
          why = 'neither node:zlib nor CompressionStream(\'deflate-raw\') is present';
        }
      }

      rows.push({
        id: codec.id,
        name: codec.name,
        family: codec.family,
        spec: codec.spec,
        available: available,
        via: via,
        reason: why,
        // A dictionary needs a synchronous zlib path: CompressionStream takes
        // no dictionary parameter in any implementation.
        supportsDictionary: available && codec.supportsDictionary && via === 'node:zlib',
        usable: codec.usable,
        implemented: codec.implemented
      });
    }

    var usable = [];
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].available && rows[r].id !== CODEC_NONE) usable.push(rows[r]);
    }

    return {
      codecs: rows,
      available: usable,
      anyAvailable: usable.length > 0,
      streamFormats: streamFormats,
      nonStandardStreamFormats: nonStandardStreamFormats,
      hasZlib: !!zlib,
      hasCompressionStreams: typeof CS === 'function' && typeof DS === 'function'
    };
  }

  // --- Dictionaries ----------------------------------------------------------

  /**
   * rvQR ships no dictionary. This list is empty and every manifest this module
   * produces sets dictId 0, exactly as ADR-003 §2.4 decided: the field exists so
   * that adding a dictionary later is not another format change, and no corpus
   * has been assembled, no dictionary trained, and no ratio measured with one.
   *
   * A deployment that has trained one registers it with defineDictionary() and
   * hands the descriptor to both ends. Both ends, at the same version — see the
   * module docblock on why that is a deployment dependency and not a setting.
   */
  var DICTIONARIES = [];

  /**
   * Describes a dictionary by id, version and the SHA-256 of its bytes.
   *
   * The digest is what makes the fail-closed check possible, and it is why the
   * bytes are required here rather than a name: an id and a version are two
   * numbers a mistaken deployment can match by accident, and the measured
   * failure this guards against is a wrong dictionary of the right length
   * decoding into the right number of wrong bytes with no error raised.
   */
  function defineDictionary(spec) {
    spec = spec || {};
    var id = Math.floor(num(spec.id, 0));
    if (!(id > DICT_NONE)) fail('bad-dictionary-id', 'a dictionary id must be a positive integer; 0 means none');
    var version = Math.floor(num(spec.version, -1));
    if (!(version >= 0)) fail('bad-dictionary-version', 'a dictionary version must be a non-negative integer');
    var bytes = spec.bytes;
    var length = byteLength(bytes);
    if (length === null || length <= 0) fail('bad-dictionary', 'a dictionary needs its bytes to hash');
    if (length > MAX_DICTIONARY_BYTES) {
      fail('dictionary-too-large', length + ' B exceeds the ' + MAX_DICTIONARY_BYTES + ' B ceiling');
    }
    return {
      id: id,
      version: version,
      label: spec.label || ('dictionary ' + id + ' v' + version),
      byteLength: length,
      digest: core.sha256Hex(bytes),
      bytes: bytes
    };
  }

  /**
   * The fail-closed check, and the only way to reach a dictionary.
   *
   * Every disagreement throws. There is deliberately no branch here that
   * returns a dictionary it could not confirm, and no branch that returns null
   * so a caller can carry on without one: a caller that decoded on the strength
   * of a null would be the silent-garbage case measured in the docblock. The
   * three reasons are distinct because they are three different operator
   * mistakes — an id nobody deployed, a version skew, and two dictionaries that
   * agree on their labels and disagree on their bytes.
   */
  function resolveDictionary(want, held) {
    want = want || {};
    var id = Math.floor(num(want.dictId, DICT_NONE));
    if (id === DICT_NONE) return null;

    var list = held || DICTIONARIES;
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { found = list[i]; break; }
    }
    if (!found) {
      fail('unknown-dictionary', 'dictionary ' + id + ' is not held here, and a dictionary ' +
        'cannot be fetched by a receiver that is offline by construction');
    }
    if (want.dictVersion !== undefined && Math.floor(num(want.dictVersion, -1)) !== found.version) {
      fail('dictionary-version-mismatch', 'dictionary ' + id + ' is held at version ' +
        found.version + ', the stream was produced against version ' + want.dictVersion);
    }
    if (want.digest !== undefined && want.digest !== null && want.digest !== found.digest) {
      fail('dictionary-digest-mismatch', 'dictionary ' + id + ' v' + found.version +
        ' hashes to ' + found.digest.slice(0, 16) + ' here and to ' +
        String(want.digest).slice(0, 16) + ' at the sender — a wrong dictionary of the ' +
        'right length decodes into the right number of wrong bytes and neither zstd nor ' +
        'raw deflate raises an error, so this is refused rather than attempted');
    }
    return found;
  }

  // --- The identifier determines the decoder ---------------------------------

  /**
   * Names the one decoder that reads a stream carrying this pair of ids.
   *
   * Total and single-valued: an admissible pair yields exactly one decoder
   * description, and everything else throws. There is no fallback, no guess and
   * no path that returns the stream unchanged — a receiver that cannot name the
   * decoder has not got a transfer, it has got some bytes.
   *
   * `want` carries what the SENDER said about the dictionary — its version and
   * the digest of its bytes — so the check below is between two independent
   * claims rather than between a claim and itself.
   */
  function decoderFor(codecId, dictId, held, want) {
    var codec = codecById(Math.floor(num(codecId, -1)));
    if (!codec) fail('unknown-codec', 'codec id ' + codecId + ' is not in the ADR-003 §2.1 table');
    if (!codec.usable) fail('ambiguous-codec', codec.unusableReason);

    var dictionary = null;
    var wantedDict = Math.floor(num(dictId, DICT_NONE));
    if (wantedDict !== DICT_NONE) {
      if (!codec.supportsDictionary) {
        fail('codec-takes-no-dictionary', codec.name + ' carries no dictionary — ' +
          (codec.id === CODEC_BROTLI
            ? 'node:zlib silently ignores a {dictionary} option for brotli, so a stream ' +
              'labelled with one would be labelled wrongly'
            : 'no dictionary mechanism is defined for it'));
      }
      dictionary = resolveDictionary({
        dictId: wantedDict,
        dictVersion: (want || {}).dictVersion,
        digest: (want || {}).digest
      }, held);
    }

    return {
      codecId: codec.id,
      codecName: codec.name,
      family: codec.family,
      spec: codec.spec,
      implemented: codec.implemented,
      dictId: wantedDict,
      dictVersion: dictionary ? dictionary.version : null,
      dictDigest: dictionary ? dictionary.digest : null,
      dictionary: dictionary,
      description: describeDecoder(codec, dictionary)
    };
  }

  function describeDecoder(codec, dictionary) {
    var text = codec.name + ' (id ' + codec.id + ', ' + codec.spec + ')';
    if (!dictionary) return text + ', no dictionary (dictId 0)';
    return text + ', dictionary ' + dictionary.id + ' v' + dictionary.version +
      ' sha256 ' + dictionary.digest.slice(0, 16);
  }

  /**
   * Whether proto2.js as shipped would accept a frame carrying this codec id.
   *
   * Answered from proto2's own table rather than from ADR-003's, because the
   * question is what the receiver does and not what the decision record says it
   * should do. See describeWireDivergence() for the disagreement in full.
   */
  var PROTO2_CODEC_NAMES = ['none', 'scf1', 'deflate-raw', 'brotli'];

  function wireCompatible(codecId) {
    var id = Math.floor(num(codecId, -1));
    var codec = codecById(id);
    if (!codec) return { ok: false, reason: 'codec id ' + codecId + ' is in no table' };
    if (id >= PROTO2_CODEC_NAMES.length) {
      return {
        ok: false,
        reason: 'proto2.parseFrame refuses codec id ' + id + ' with unknown-codec: its ' +
          'CODEC_NAMES has ' + PROTO2_CODEC_NAMES.length + ' entries, so ' + codec.name +
          ' cannot cross the wire until proto2.js adopts the ADR-003 §2.1 table'
      };
    }
    var shipped = PROTO2_CODEC_NAMES[id];
    if (shipped !== codec.name) {
      return {
        ok: false,
        reason: 'id ' + id + ' means ' + codec.name + ' here and ' + shipped +
          ' in proto2.js — a receiver would decode with the wrong codec, which is ' +
          'exactly the ADR-027 §2.2 defect'
      };
    }
    return { ok: true, reason: 'id ' + id + ' means ' + codec.name + ' in both tables' };
  }

  // --- The decision ----------------------------------------------------------

  /**
   * One codec's result, judged on the envelope and reported with both figures.
   *
   * Takes measured lengths, never a codec: this is the pure half, and it is the
   * half the tests exercise, so a verdict is arithmetic a reader can check by
   * hand rather than something a codec did. `originalBytes` and
   * `compressedBytes` may be numbers or anything with a length — passing the
   * real buffers is the common case and passing sizes is what makes a
   * synthetic edge case expressible.
   */
  function evaluate(spec) {
    spec = spec || {};
    var original = byteLength(spec.originalBytes);
    var compressed = byteLength(spec.compressedBytes);
    if (original === null || !(original > 0)) {
      fail('bad-artifact-size', 'originalBytes must be a positive size or a buffer');
    }
    if (compressed === null || !(compressed >= 0)) {
      fail('bad-compressed-size', 'compressedBytes must be a size or a buffer');
    }

    var envOpts = {
      chunk: spec.chunk,
      armour: spec.armour,
      nameLen: spec.nameLen,
      headerBytes: spec.headerBytes,
      manifestFixedBytes: spec.manifestFixedBytes
    };
    var before = envelopeBytes(original, envOpts);
    var after = envelopeBytes(compressed, envOpts);

    var gate = num(spec.gate, ENVELOPE_GAIN_GATE);
    var payloadGain = 1 - compressed / original;
    var envelopeGain = before.bytes > 0 ? 1 - after.bytes / before.bytes : 0;
    var passes = envelopeGain >= gate;

    var codec = codecById(Math.floor(num(spec.codecId, CODEC_NONE)));

    return {
      codecId: codec ? codec.id : Math.floor(num(spec.codecId, CODEC_NONE)),
      codecName: codec ? codec.name : 'unknown',
      dictId: Math.floor(num(spec.dictId, DICT_NONE)),
      originalBytes: original,
      compressedBytes: compressed,
      ratio: compressed > 0 ? original / compressed : Infinity,
      payloadGain: payloadGain,
      envelopeBefore: before.bytes,
      envelopeAfter: after.bytes,
      envelopeGain: envelopeGain,
      framesBefore: before.frames,
      framesAfter: after.frames,
      framesSaved: before.frames - after.frames,
      chunk: before.chunk,
      armour: before.armour,
      gate: gate,
      margin: envelopeGain - gate,
      passesGate: passes,
      reason: explainCell(codec, payloadGain, envelopeGain, gate, before, after, passes)
    };
  }

  /**
   * The sentence that has to carry both figures.
   *
   * Written so the disagreement between them is legible when there is one: a
   * reader who sees "payload 9.10%, envelope 7.95%" learns immediately what the
   * rule is for, and a reader who sees them agree learns that this artifact was
   * never near the boundary.
   */
  function explainCell(codec, payloadGain, envelopeGain, gate, before, after, passes) {
    var name = codec ? codec.name : 'codec';
    var frames = before.frames === after.frames
      ? 'no frame saved, ' + before.frames + ' either way'
      : (before.frames - after.frames) + ' of ' + before.frames + ' frames saved';
    var head = name + ': payload ' + pct(payloadGain) + ', envelope ' + pct(envelopeGain) +
      ' (' + before.bytes + ' B → ' + after.bytes + ' B, ' + frames + ')';
    if (passes) {
      return head + ' — clears the ' + pct(gate) + ' gate by ' + pct(envelopeGain - gate);
    }
    if (envelopeGain <= 0) {
      return head + ' — the envelope did not shrink at all, so this costs ' +
        (after.bytes - before.bytes) + ' B to send';
    }
    if (payloadGain >= gate) {
      return head + ' — the PAYLOAD clears the ' + pct(gate) + ' gate and the ENVELOPE does ' +
        'not: the per-frame header and the manifest frame are not compressible, and they ' +
        'are what the receiver actually waits through';
    }
    return head + ' — short of the ' + pct(gate) + ' gate by ' + pct(gate - envelopeGain);
  }

  /**
   * Picks among measured candidates, or declines.
   *
   * Declining is a decision and it is reported as one: the returned shape is
   * identical whether nothing was tried, everything was tried and everything
   * missed, or a winner was found. `codecId` is CODEC_NONE in the first two
   * cases, `dictId` is 0, and the transport hash equals the content hash, which
   * is what ADR-003 §2.2 says an uncompressed transfer looks like.
   *
   * Ties go to the LOWER codec id, which under ADR-003 §2.1 means Zstd before
   * Brotli before deflate-raw — the default before the maximum-ratio option
   * before the fallback. A tie broken by enumeration order would make the
   * decision depend on which codecs the platform happened to offer.
   */
  function choose(spec) {
    spec = spec || {};
    var original = byteLength(spec.originalBytes);
    if (original === null || !(original > 0)) {
      fail('bad-artifact-size', 'originalBytes must be a positive size or a buffer');
    }
    var gate = num(spec.gate, ENVELOPE_GAIN_GATE);
    var list = spec.candidates || [];

    var evaluated = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      evaluated.push(evaluate({
        originalBytes: original,
        compressedBytes: c.compressedBytes !== undefined ? c.compressedBytes : c.bytes,
        codecId: c.codecId,
        dictId: c.dictId,
        chunk: spec.chunk,
        armour: spec.armour,
        nameLen: spec.nameLen,
        headerBytes: spec.headerBytes,
        manifestFixedBytes: spec.manifestFixedBytes,
        gate: gate
      }));
    }

    var passing = [];
    for (var p = 0; p < evaluated.length; p++) if (evaluated[p].passesGate) passing.push(evaluated[p]);

    passing.sort(function (a, b) {
      if (a.envelopeAfter !== b.envelopeAfter) return a.envelopeAfter - b.envelopeAfter;
      if (a.codecId !== b.codecId) return a.codecId - b.codecId;
      return a.dictId - b.dictId;
    });

    var baseline = envelopeBytes(original, {
      chunk: spec.chunk, armour: spec.armour, nameLen: spec.nameLen,
      headerBytes: spec.headerBytes, manifestFixedBytes: spec.manifestFixedBytes
    });

    if (!passing.length) {
      return {
        compress: false,
        codecId: CODEC_NONE,
        codecName: 'none',
        dictId: DICT_NONE,
        streamBytes: original,
        originalBytes: original,
        envelopeBytes: baseline.bytes,
        frames: baseline.frames,
        gate: gate,
        best: null,
        considered: evaluated,
        reason: explainNothing(evaluated, gate, original)
      };
    }

    var winner = passing[0];
    return {
      compress: true,
      codecId: winner.codecId,
      codecName: winner.codecName,
      dictId: winner.dictId,
      streamBytes: winner.compressedBytes,
      originalBytes: original,
      envelopeBytes: winner.envelopeAfter,
      frames: winner.framesAfter,
      gate: gate,
      best: winner,
      considered: evaluated,
      reason: explainWinner(winner, passing, evaluated)
    };
  }

  function explainWinner(winner, passing, evaluated) {
    var head = winner.reason;
    if (passing.length > 1) {
      var runnerUp = passing[1];
      return head + '; ahead of ' + runnerUp.codecName + ' at ' + pct(runnerUp.envelopeGain) +
        ', ' + passing.length + ' of ' + evaluated.length + ' codecs cleared the gate';
    }
    return head + '; the only one of ' + evaluated.length + ' that cleared the gate';
  }

  function explainNothing(evaluated, gate, original) {
    if (!evaluated.length) {
      return 'no codec was available, so the artifact goes as it stands: ' + original +
        ' B, codec id 0, transport hash equal to content hash';
    }
    var best = evaluated[0];
    for (var i = 1; i < evaluated.length; i++) {
      if (evaluated[i].envelopeGain > best.envelopeGain) best = evaluated[i];
    }
    var lead = 'no codec shrank the envelope by the ' + pct(gate) + ' the gate wants';
    if (best.payloadGain >= gate && best.envelopeGain < gate) {
      lead = 'the payload shrank enough and the envelope did not';
    }
    return lead + ' — best was ' + best.reason + '. Sent uncompressed: codec id 0, ' +
      'transport hash equal to content hash';
  }

  // --- Running the codecs ----------------------------------------------------

  /**
   * Compresses with one injected codec, refusing anything it cannot label.
   *
   * `codecs` is a map from name to { compress, decompress }, injected rather
   * than reached for, so the tests can drive a codec with known behaviour and
   * so nothing in this file requires node:zlib to load. A dictionary is passed
   * through only for codecs that genuinely take one — brotli's is refused
   * here, because node:zlib accepts the option and ignores it, and a stream
   * labelled with a dictionary it was not built with is the whole defect.
   */
  function compressWith(bytes, codecId, codecs, opts) {
    opts = opts || {};
    var codec = codecById(Math.floor(num(codecId, -1)));
    if (!codec) fail('unknown-codec', 'codec id ' + codecId + ' is not in the ADR-003 §2.1 table');
    if (!codec.usable) fail('ambiguous-codec', codec.unusableReason);
    if (codec.id === CODEC_NONE) return bytes;

    var impl = (codecs || {})[codec.name];
    if (!impl || typeof impl.compress !== 'function') {
      fail('codec-unavailable', codec.name + ' has no implementation here: ' +
        (codec.implemented ? 'none was injected' : codec.unimplementedReason));
    }

    var dictionary = opts.dictionary || null;
    if (dictionary && !codec.supportsDictionary) {
      fail('codec-takes-no-dictionary', codec.name + ' takes no dictionary' +
        (codec.id === CODEC_BROTLI
          ? ' — node:zlib accepts the option and silently ignores it, measured at 1,746 B ' +
            'with and without, so a stream built this way would be mislabelled'
          : ''));
    }

    return impl.compress(bytes, dictionary ? dictionary.bytes : null);
  }

  /**
   * The sender's whole decision: what to run, what it measured, and the verdict.
   *
   * ADR-003 §2.3 in two branches, and the asymmetry between them is the point.
   *
   *   UP TO 8 MB the sender compresses the WHOLE artifact with every available
   *   codec and compares. There is no estimate anywhere in this branch. §2.3
   *   argues this is affordable and the arithmetic is its own: Brotli-6 encoded
   *   503,216 bytes in 8.38 ms, so an 8 MB artifact costs on the order of
   *   130 ms once, against a transfer measured in minutes.
   *
   *   ABOVE 8 MB each codec runs on a bounded 1 MB prefix first, AT A FAST
   *   LEVEL, and the gate is applied to that estimate as a PRE-FILTER. A codec
   *   whose estimate passes is then encoded in full and judged again on what it
   *   actually produced; if the full result misses the gate the sender falls
   *   back to uncompressed. AN ESTIMATE IS NEVER THE FINAL WORD IN THE
   *   DIRECTION THAT COSTS SOMETHING — a yes must be confirmed by a full encode
   *   before a single byte is sent, and an estimate that was overturned is
   *   reported in `overturned` rather than absorbed.
   *
   * The fast level for the estimate is a real requirement and this module
   * cannot satisfy it alone: the codecs are injected, so their level is the
   * caller's, and there is no parameter here that could turn Brotli-11 into
   * Brotli-4. `opts.sampleCodecs` is the seam — a second map used only for the
   * prefix, defaulting to `opts.codecs` when the caller does not distinguish
   * them. `sampleCodecsDistinct` on the result says which happened, so a report
   * cannot imply a fast estimate that never ran.
   *
   * A DECLINING ESTIMATE *IS* FINAL FOR THAT CODEC, and that is §2.3's flow
   * rather than an oversight — but it is the one place a prefix can lose real
   * bytes, because a prefix is not a smaller artifact of the same kind. See
   * describeLimits().
   *
   * Nothing here times anything. Encode cost is a real consideration and it is
   * deliberately not an input to any branch: a decision that depended on how
   * busy this machine was would not be reproducible, and reproducibility is
   * what lets a sender and a reviewer reach the same verdict.
   */
  function compressArtifact(bytes, opts) {
    opts = opts || {};
    var length = byteLength(bytes);
    if (length === null || !(length > 0)) fail('bad-artifact-size', 'nothing to compress');

    var detection = opts.detection || detectCodecs(opts.env || {});
    var codecs = opts.codecs || {};
    // ADR-003 §2.3 wants the estimate taken at a fast level. The level belongs
    // to the injected codec, so the only honest mechanism is a second map.
    var sampleCodecs = opts.sampleCodecs || codecs;
    var dictionary = opts.dictionary || null;

    var order = preferenceOrder(bytes, detection, opts);
    var sampled = length > num(opts.sampleAbove, SAMPLE_ABOVE_BYTES);
    var prefixLength = Math.min(length, Math.max(1, Math.floor(num(opts.samplePrefix, SAMPLE_PREFIX_BYTES))));

    var measured = [];
    var declined = [];
    var overturned = [];
    var streams = {};

    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var codec = codecById(id);
      var useDict = dictionary && codec.supportsDictionary ? dictionary : null;

      if (!sampled) {
        var out = compressWith(bytes, id, codecs, { dictionary: useDict });
        streams[keyFor(id, useDict)] = out;
        measured.push({ codecId: id, dictId: useDict ? useDict.id : DICT_NONE, compressedBytes: out });
        continue;
      }

      var prefix = slice(bytes, 0, prefixLength);
      var sample = compressWith(prefix, id, sampleCodecs, { dictionary: useDict });
      var estimate = evaluate({
        originalBytes: prefixLength,
        compressedBytes: sample,
        codecId: id,
        dictId: useDict ? useDict.id : DICT_NONE,
        chunk: opts.chunk, armour: opts.armour, nameLen: opts.nameLen,
        gate: num(opts.gate, ENVELOPE_GAIN_GATE)
      });
      if (!estimate.passesGate) {
        // Declined on the estimate, and recorded as declined rather than as a
        // measurement of zero gain. Inventing a compressed size for a codec
        // that was never run on the whole artifact would put a number in the
        // report that nothing produced.
        declined.push({
          codecId: id,
          codecName: codec.name,
          dictId: useDict ? useDict.id : DICT_NONE,
          estimate: estimate,
          note: 'the ' + prefixLength + ' B prefix estimated ' + pct(estimate.envelopeGain) +
            ', short of the ' + pct(estimate.gate) + ' gate, so the whole artifact was never encoded'
        });
        continue;
      }
      var full = compressWith(bytes, id, codecs, { dictionary: useDict });
      streams[keyFor(id, useDict)] = full;
      var row = { codecId: id, dictId: useDict ? useDict.id : DICT_NONE, compressedBytes: full, estimate: estimate };
      measured.push(row);
    }

    var decision = choose({
      originalBytes: length,
      candidates: measured,
      chunk: opts.chunk,
      armour: opts.armour,
      nameLen: opts.nameLen,
      gate: num(opts.gate, ENVELOPE_GAIN_GATE)
    });

    for (var m = 0; m < measured.length; m++) {
      if (!measured[m].estimate) continue;
      var cell = null;
      for (var c = 0; c < decision.considered.length; c++) {
        if (decision.considered[c].codecId === measured[m].codecId) { cell = decision.considered[c]; break; }
      }
      if (cell && !cell.passesGate) {
        overturned.push({
          codecId: measured[m].codecId,
          estimateGain: measured[m].estimate.envelopeGain,
          measuredGain: cell.envelopeGain,
          note: 'the ' + prefixLength + ' B prefix estimated ' + pct(measured[m].estimate.envelopeGain) +
            ' and the whole artifact measured ' + pct(cell.envelopeGain) + ', so the estimate was overturned'
        });
      }
    }

    decision.sampled = sampled;
    decision.samplePrefixBytes = sampled ? prefixLength : null;
    // Whether the estimate genuinely ran at a different (fast) level, or at the
    // same one. Reported so a summary cannot imply the former when it was the
    // latter — ADR-003 §2.3 asks for a fast level and this is the only place
    // the module can say whether it got one.
    decision.sampleCodecsDistinct = sampled ? sampleCodecs !== codecs : null;
    decision.declined = declined;
    decision.overturned = overturned;

    // choose() only ever sees codecs that were run in full, so when the sampled
    // path declined every one of them it would otherwise report "no codec was
    // available" — which would be false. Codecs existed; their estimates lost.
    if (!decision.compress && declined.length && !decision.considered.length) {
      decision.reason = declined.length + ' codec' + (declined.length === 1 ? '' : 's') +
        ' were available and every one was declined on a ' + prefixLength +
        ' B sample: ' + declined[0].note + '. Sent uncompressed: codec id 0, ' +
        'transport hash equal to content hash';
    }
    decision.stream = decision.compress ? streams[keyFor(decision.codecId, dictionary && decision.dictId ? dictionary : null)] : bytes;
    decision.detection = detection;
    decision.decoder = decoderFor(decision.codecId, decision.dictId, dictionary ? [dictionary] : null);
    decision.wire = wireCompatible(decision.codecId);
    return decision;
  }

  function keyFor(codecId, dictionary) {
    return codecId + '/' + (dictionary ? dictionary.id : DICT_NONE);
  }

  function slice(bytes, from, to) {
    if (typeof bytes.subarray === 'function') return bytes.subarray(from, to);
    if (typeof bytes.slice === 'function') return bytes.slice(from, to);
    return bytes;
  }

  /**
   * ADR-003 §2.3's artifact classes, in the vocabulary §2.3 uses.
   *
   * `core.detectArtifactType()` names wasm, rvf and generic and has no HTML kind
   * at all, so the HTML half of §2.3's rule cannot be read off it. It is decided
   * here instead, by the narrowest sniff that answers the question §2.3 asks —
   * and only by that sniff. This deliberately does NOT try to be a content-type
   * detector: a wrong answer costs a tie-break, because §2.3's other half
   * measures every codec anyway, so the cheap conservative test is the right
   * one and a thorough one would be spending effort on an outcome that does not
   * depend on it.
   */
  var HTML_MARKERS = ['<!doctype html', '<html', '<!DOCTYPE HTML', '<HTML'];
  var HTML_SNIFF_BYTES = 512;

  function looksLikeHtml(bytes) {
    if (!bytes || !bytes.length) return false;
    var limit = Math.min(bytes.length, HTML_SNIFF_BYTES);
    var head = '';
    for (var i = 0; i < limit; i++) {
      var b = bytes[i];
      // Anything outside printable ASCII plus whitespace is not the leading
      // text of an HTML document, so stop rather than keep hunting through a
      // binary that happens to contain the bytes '<html' somewhere.
      if (b === 0) return false;
      head += String.fromCharCode(b);
    }
    var lower = head.toLowerCase();
    for (var m = 0; m < HTML_MARKERS.length; m++) {
      if (lower.indexOf(HTML_MARKERS[m].toLowerCase()) >= 0) return true;
    }
    return false;
  }

  /**
   * The artifact class ADR-003 §2.3 routes on: 'wasm', 'html', 'rvf', 'generic'.
   * Reported rather than kept private, so a caller can see which branch of §2.3
   * it landed on and disagree with it by passing `prefer`.
   */
  function classifyArtifact(bytes) {
    var kind = 'generic';
    if (core && typeof core.detectArtifactType === 'function' && bytes && bytes.length) {
      kind = core.detectArtifactType(bytes).kind;
    }
    if (kind === 'generic' && looksLikeHtml(bytes)) return 'html';
    return kind;
  }

  /**
   * Which codecs to try, in which order.
   *
   * ADR-003 §2.3: WASM modules, HTML and metadata get Brotli, everything else
   * gets Zstd, "and both are subject to the same 8% test". That last clause is
   * why this is a PREFERENCE and not a selection — §2.3's other half compresses
   * an artifact under 8 MB with everything available and compares for real, so
   * the class only decides which codec wins a tie, never which codec runs.
   *
   * Zstd first for everything else is ADR-003 §2.1's default, and it is a
   * default with a reason: the ratio difference is under 4% on every artifact
   * measured, the encode difference on the largest was 2×, and Zstd is what the
   * rest of RuVector already uses for storage.
   */
  function preferenceOrder(bytes, detection, opts) {
    opts = opts || {};
    var available = [];
    for (var i = 0; i < detection.available.length; i++) available.push(detection.available[i].id);

    var prefer = opts.prefer;
    if (prefer === undefined) {
      var kind = classifyArtifact(bytes);
      prefer = (kind === 'wasm' || kind === 'html') ? CODEC_BROTLI : CODEC_ZSTD;
    }
    if (typeof prefer === 'string') {
      var named = codecByName(prefer);
      prefer = named ? named.id : undefined;
    }

    available.sort(function (a, b) {
      if (a === prefer && b !== prefer) return -1;
      if (b === prefer && a !== prefer) return 1;
      return a - b;
    });
    return available;
  }

  // --- The planner axis ------------------------------------------------------

  /**
   * The codec axis, built the way planner.candidates() builds its granularity
   * array: the always-available value first, then whatever the situation adds.
   *
   * CODEC_NONE is always present and always first. It is not a fallback that
   * happens when the others fail; it is a strategy that competes, and on the
   * measured incompressible cases it is the one that wins.
   */
  function codecAxis(opts) {
    opts = opts || {};
    var detection = opts.detection || detectCodecs(opts.env || {});
    var dictionary = opts.dictionary || null;

    var axis = [{
      codecId: CODEC_NONE,
      dictId: DICT_NONE,
      label: 'no codec'
    }];

    for (var i = 0; i < detection.available.length; i++) {
      var row = detection.available[i];
      if (opts.wireCompatibleOnly && !wireCompatible(row.id).ok) continue;
      axis.push({ codecId: row.id, dictId: DICT_NONE, label: row.name });
      if (dictionary && row.supportsDictionary) {
        axis.push({
          codecId: row.id,
          dictId: dictionary.id,
          dictVersion: dictionary.version,
          label: row.name + ' + dictionary ' + dictionary.id + ' v' + dictionary.version
        });
      }
    }

    if (axis.length > MAX_AXIS_VALUES) {
      fail('too-many-axis-values', axis.length + ' codec axis values exceeds the ' +
        MAX_AXIS_VALUES + ' ceiling');
    }
    return axis;
  }

  /**
   * Crosses the codec axis into a planner candidate list.
   *
   * Whole-artifact candidates only, and the reason is in the module docblock:
   * planner's delta size is a projection from declared overlap, so a codec
   * scored against one would be a projection of a projection. Delta candidates
   * pass through untouched, carrying codecId CODEC_NONE, so the returned list is
   * still a complete list of what planner offered.
   */
  function expandCandidates(candidates, axis, opts) {
    opts = opts || {};
    var fullGranularity = opts.fullGranularity || 'full';
    var out = [];

    for (var i = 0; i < (candidates || []).length; i++) {
      var candidate = candidates[i];
      if (candidate.granularity !== fullGranularity) {
        out.push(withCodec(candidate, { codecId: CODEC_NONE, dictId: DICT_NONE, label: 'no codec' }));
        continue;
      }
      for (var a = 0; a < axis.length; a++) out.push(withCodec(candidate, axis[a]));
    }

    if (out.length > MAX_CANDIDATES) {
      fail('too-many-candidates', out.length + ' candidates exceeds the ' + MAX_CANDIDATES + ' ceiling');
    }
    return out;
  }

  function withCodec(candidate, value) {
    var out = {};
    for (var k in candidate) {
      if (Object.prototype.hasOwnProperty.call(candidate, k)) out[k] = candidate[k];
    }
    out.codecId = value.codecId;
    out.dictId = value.dictId;
    out.codecName = (codecById(value.codecId) || { name: 'unknown' }).name;
    out.id = candidate.id + '/' + out.codecName + (value.dictId ? '+d' + value.dictId : '');
    out.label = candidate.label + (value.codecId === CODEC_NONE ? '' : ', ' + value.label);
    return out;
  }

  /**
   * Scores one codec-bearing candidate on planner's own J.
   *
   * The subtlety is the basis. planner normalises T, E and B against the
   * reference strategy evaluated IN THE SAME SITUATION, so handing it a
   * situation whose artifact is already compressed shrinks the basis along with
   * the candidate and every codec scores B = 1. So the reference is taken once,
   * at the ORIGINAL artifact size, and every codec's model is divided by that
   * one reference — which is what makes the axis values comparable to each
   * other and to the uncompressed candidate.
   *
   * Everything is computed by planner's exported functions and its exported
   * weights; nothing here re-implements its arithmetic. The test suite asserts
   * that scoring the CODEC_NONE axis value reproduces planner.costTerms()
   * exactly, which is the cheapest available check that this did not quietly
   * grow an objective of its own.
   */
  function scoreAxis(planner, candidate, situation, streamBytes) {
    if (!planner || typeof planner.costTerms !== 'function' || typeof planner.transferModel !== 'function') {
      fail('bad-planner', 'scoreAxis needs planner.costTerms and planner.transferModel');
    }
    var stream = byteLength(streamBytes);
    if (stream === null || !(stream > 0)) {
      fail('bad-stream-size', 'a codec axis value needs the measured stream length it produces');
    }

    var original = planner.normalizeSituation(situation);
    var compressed = planner.normalizeSituation(withArtifactBytes(situation, stream));

    var model = planner.transferModel(candidate, compressed);
    var referenceTerms = planner.costTerms(planner.REFERENCE, original);
    var ownTerms = planner.costTerms(candidate, compressed);

    var tRaw = referenceTerms.model.seconds > 0 ? model.seconds / referenceTerms.model.seconds : 1;
    var bRaw = referenceTerms.model.wireBytes > 0 ? model.wireBytes / referenceTerms.model.wireBytes : 1;
    var eRaw = referenceTerms.energy > 0 ? ownTerms.energy / referenceTerms.energy : 1;

    var T = clamp01(tRaw);
    var E = clamp01(eRaw);
    var B = clamp01(bRaw);
    var R = ownTerms.R;

    return {
      id: candidate.id,
      label: candidate.label,
      codecId: candidate.codecId,
      dictId: candidate.dictId,
      streamBytes: stream,
      T: T, E: E, B: B, R: R,
      tRaw: tRaw, eRaw: eRaw, bRaw: bRaw,
      J: planner.WEIGHT_TIME * T + planner.WEIGHT_ENERGY * E +
        planner.WEIGHT_BYTES * B + planner.WEIGHT_RISK * R,
      model: model,
      reference: referenceTerms.model,
      hazards: ownTerms.hazards,
      rebased: true,
      caveats: scoreCaveats()
    };
  }

  function withArtifactBytes(situation, bytes) {
    var out = {};
    for (var k in situation) {
      if (Object.prototype.hasOwnProperty.call(situation, k)) out[k] = situation[k];
    }
    var artifact = {};
    for (var a in (situation.artifact || {})) {
      if (Object.prototype.hasOwnProperty.call(situation.artifact, a)) artifact[a] = situation.artifact[a];
    }
    artifact.bytes = bytes;
    out.artifact = artifact;
    out.__normalized = false;
    return out;
  }

  function scoreCaveats() {
    return [
      'T and B are exact: planner’s own transferModel over the measured stream length, divided by one reference taken at the original artifact size.',
      'E is planner’s energy model, which charges verification per artifact.bytes — under compression that is the stream, not the artifact the receiver hashes. The error is bounded by ENERGY_PER_VERIFIED_BYTE and E is already the term planner calls its weakest.',
      'There is no decode-energy term anywhere in planner, so a codec is charged nothing for the work it makes the receiver do.',
      'R is untouched: none of planner’s hazards read the artifact size.'
    ];
  }

  // --- Honesty ---------------------------------------------------------------

  /**
   * The two tables that do not agree, stated in full so a reader does not have
   * to diff two files to find out that a sender and a receiver mean different
   * things by the same byte.
   */
  function describeWireDivergence() {
    var rows = [];
    for (var id = 0; id < Math.max(CODECS.length, PROTO2_CODEC_NAMES.length); id++) {
      var here = codecById(id);
      rows.push({
        id: id,
        adr003: here ? here.name : '(unassigned)',
        proto2: id < PROTO2_CODEC_NAMES.length ? PROTO2_CODEC_NAMES[id] : '(refused: unknown-codec)',
        agrees: !!here && id < PROTO2_CODEC_NAMES.length && here.name === PROTO2_CODEC_NAMES[id]
      });
    }
    return {
      rows: rows,
      summary: 'proto2.js ships a four-entry table and ADR-003 §2.1 decides a seven-entry ' +
        'one. Ids 0 agree; 1, 2 and 3 mean different codecs in the two; 4, 5 and 6 are ' +
        'refused by proto2.parseFrame with unknown-codec. Nothing in this module changes ' +
        'proto2.js — a sender must check wireCompatible() before putting an id on a frame.',
      required: 'proto2.js needs CODEC_NAMES replaced by the ADR-003 §2.1 table, and ' +
        'DICT_NAMES extended past its single \'none\' entry before any dictId above 0 can ' +
        'cross the wire at all — parseFrame refuses dictId >= DICT_NAMES.length.'
    };
  }

  /** The changes planner.js needs before this can stop rebasing from outside. */
  function describePlannerChanges() {
    return [
      'candidates(): cross the codec axis into the grid the way granularities and verifications are already crossed, so a codec is a column of the same table rather than a decision taken beside it.',
      'streamBytes(): return the candidate’s measured compressed stream when it carries one. It is the single point through which a codec acts on J, exactly as granularity does.',
      'energyModel(): charge verification against the ORIGINAL artifact size rather than s.artifact.bytes, which under compression is the stream. The receiver hashes what it reconstructed.',
      'energyModel(): there is no decode term, so a codec currently costs the receiver nothing in E. Adding one needs a per-byte decode weight, which would be MODELLED — this repository has no power measurement of any kind.',
      'None of these is made here. This module owns artifacts/compress.js and its tests and changes nothing else.'
    ];
  }

  /** What this module is not entitled to claim. */
  function describeLimits() {
    return [
      'The envelope is arithmetic over restated proto2.js constants, not a measurement. bench/suites/compress.mjs checks the same model against frames the real builder produced; this file’s test suite checks the constants still match proto2.js.',
      'The gate is a projection about wire bytes only. It says nothing about decode time, decode memory, or the receiver’s ability to instantiate a codec at all — a receiver that cannot decode has a transfer that ends in nothing rather than in a slower transfer.',
      'A codec identifier is checked against ADR-003 §2.1, which proto2.js does not implement. wireCompatible() reports that per codec; it does not fix it.',
      'rvQR ships no dictionary. Every dictionary figure quoted in this file’s docblock is either held out across two files a receiver genuinely holds, or explicitly labelled an upper bound measured with the container’s own bytes.',
      'A dictionary mismatch is caught here by comparing digests, not by the codec: both zstd and raw deflate were measured decoding a wrong dictionary into the right number of wrong bytes without raising anything.',
      'Encode cost is measured nowhere in this module and gates nothing. A decision that read a clock would not be reproducible, so the sender’s latency before the first frame is a real cost this file does not price.',
      'The sampled path above 8 MB judges an estimate on a prefix, and a prefix is not a smaller artifact of the same kind — the first megabyte of a WASM module is not representative of its code section. Any estimate that PASSES is re-judged on the full result and an overturned estimate is reported rather than absorbed, so a wrong yes costs encode time and nothing on the wire.',
      'A prefix estimate that FAILS is final for that codec, which is ADR-003 §2.3’s flow and is the one place this can lose real bytes: an artifact whose first megabyte compresses badly and whose remainder compresses well is declined without ever being measured. Nothing here detects that case.',
      'ADR-003 §2.3 wants the prefix encoded at a fast level. The level belongs to the injected codec, not to this module, so `sampleCodecs` is a seam and `sampleCodecsDistinct` reports whether a caller actually used it — a report that says false means the estimate ran at the full level, not that it ran fast.',
      'The artifact classification behind §2.3’s codec preference is a 512-byte sniff for a doctype or an <html> tag, not a content-type detector. It is deliberately cheap because it only breaks ties: under 8 MB every available codec is measured regardless, so a misclassification costs a tie-break and never a codec.'
    ];
  }

  return {
    // the gate
    ENVELOPE_GAIN_GATE: ENVELOPE_GAIN_GATE,
    SAMPLE_ABOVE_BYTES: SAMPLE_ABOVE_BYTES,
    SAMPLE_PREFIX_BYTES: SAMPLE_PREFIX_BYTES,

    // frame geometry, restated from proto2.js
    HEADER_BYTES: HEADER_BYTES,
    MANIFEST_FIXED_BYTES: MANIFEST_FIXED_BYTES,
    DEFAULT_CHUNK_BYTES: DEFAULT_CHUNK_BYTES,
    envelopeBytes: envelopeBytes,

    // identifiers
    CODEC_NONE: CODEC_NONE,
    CODEC_LZ4: CODEC_LZ4,
    CODEC_ZSTD: CODEC_ZSTD,
    CODEC_CUSTOM: CODEC_CUSTOM,
    CODEC_BROTLI: CODEC_BROTLI,
    CODEC_SCF1: CODEC_SCF1,
    CODEC_DEFLATE_RAW: CODEC_DEFLATE_RAW,
    DICT_NONE: DICT_NONE,
    CODECS: CODECS,
    STANDARD_STREAM_FORMATS: STANDARD_STREAM_FORMATS,
    PROTO2_CODEC_NAMES: PROTO2_CODEC_NAMES,
    codecById: codecById,
    codecByName: codecByName,
    decoderFor: decoderFor,
    wireCompatible: wireCompatible,

    // platform
    detectCodecs: detectCodecs,

    // dictionaries
    DICTIONARIES: DICTIONARIES,
    defineDictionary: defineDictionary,
    resolveDictionary: resolveDictionary,

    // the decision
    evaluate: evaluate,
    choose: choose,
    compressWith: compressWith,
    compressArtifact: compressArtifact,
    preferenceOrder: preferenceOrder,
    classifyArtifact: classifyArtifact,

    // the planner axis
    codecAxis: codecAxis,
    expandCandidates: expandCandidates,
    scoreAxis: scoreAxis,

    CompressError: CompressError,

    describeWireDivergence: describeWireDivergence,
    describePlannerChanges: describePlannerChanges,
    describeLimits: describeLimits
  };
});
