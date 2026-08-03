/*!
 * Suite 15 — progressive verified activation, artifacts/closure.js.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT SUITE 10. READ THE NEXT PARAGRAPH BEFORE QUOTING ANYTHING.
 * ---------------------------------------------------------------------------
 *
 * `bench/suites/closures.mjs` — plural — is a MODEL of transfer time: it takes
 * measured byte rates and measured artifact sizes and computes how long a split
 * artifact would take to arrive. It runs no module. This file — singular — runs
 * `artifacts/closure.js` end to end with the real SHA-256 and the real Ed25519
 * from `artifacts/crypto.js`, and measures what the shipped code costs. The two
 * answer different questions and their selectors differ by one letter
 * (`--suite closures` against `--suite closure`), which is a trap and is
 * therefore said here rather than left to be discovered.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR: ADR-022 ACCEPTANCE CRITERION 7
 * ---------------------------------------------------------------------------
 *
 * ADR-022 §4.7 is the one criterion in that ADR named after this directory:
 * "Signature and closure overhead is reported in `bench/` as a fraction of the
 * artifact, since on small artifacts it may exceed the payload." That sentence
 * says *may*. So the job is not to assert that it does — it is to measure
 * whether it does, at what size it stops doing so, and under which of the two
 * signature schemes in play.
 *
 * Four things are produced, and the first is the criterion:
 *
 * 1. THE OVERHEAD LADDER. Real four-closure artifacts are built and activated at
 *    a range of sizes spanning this repository's own artifacts — the 2,304 B
 *    demo container, the 40,989 B WASM runtime, the ~1 MB standalone app — and
 *    at every power-of-two size below them. Every row reports content bytes,
 *    digest bytes, signature bytes and the OVERHEAD AS A FRACTION OF THE
 *    ARTIFACT, which is the quantity the criterion names. The crossover — the
 *    artifact size at which overhead stops exceeding payload — is found by
 *    bisection over real builds rather than by reading it off the ladder.
 *
 * 2. BOTH SIGNATURE REGIMES, SIDE BY SIDE AND NEVER CONFLATED. Ed25519 at 64
 *    bytes is what this repository has and is MEASURED: every signature in every
 *    table below was produced by `crypto.signSync` and verified by
 *    `crypto.verifySync`. ADR-012's hybrid at 3,373 bytes per closure
 *    (ML-DSA-65's 3,309 plus Ed25519's 64) is an ARITHMETIC PROJECTION and is
 *    labelled as one in the same sentence every time it appears, because there
 *    is no ML-DSA-65 anywhere in this repository and an Ed25519 measurement
 *    presented as a hybrid result would be the exact thing ADR-022 §4.5 warns
 *    against.
 *
 * 3. VERIFICATION COST, WHICH IS THE "START SOONER" CLAIM'S NUMBER. Median
 *    milliseconds to verify closures 1–3 against the whole artifact, so the
 *    fraction of total verification work the activation set represents is a
 *    measured figure and not an intuition. It is not the obvious fraction: a
 *    digest is linear in bytes and a signature check is not, so the split
 *    between them moves with artifact size and both are measured separately.
 *
 * 4. THE OPTICAL VERDICT, RE-DERIVED. `opticalBudget()` already computes it and
 *    this suite recomputes it from the module's own constants rather than
 *    trusting the returned note, then sweeps artifact size to answer the
 *    question ADR-022 §4.6 actually asks — whether the answer is "not achievable
 *    at this artifact size" or the stronger "not achievable at any".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT CANNOT BE
 * ---------------------------------------------------------------------------
 *
 * Real: the module, driven through `beginActivation` → `offerClosure` ×n →
 * `completion` → `activationReceipt`, with `opts.digest` wired to
 * `crypto.sha256` and `opts.verifySignature` wired to `crypto.verifySync`.
 * Every artifact in the ladder is activated to `complete` before its row is
 * reported, so no byte count below describes a split the gate would refuse.
 * The manifest sizes are the real JSON the module parses, not a formula for it.
 *
 * Not real, and not simulated either:
 *
 *   - **There is no radio tier.** ADR-022 §4.5's "under 3 s at p95 on the radio
 *     tier" is unmeasurable in this repository and this suite does not measure
 *     it. No radio is modelled, no p95 is quoted, and criterion 5 is reported as
 *     UNMEETABLE rather than approximated. `describeUnimplemented()` is read out
 *     of the running module into the report so the caveat travels with the
 *     numbers.
 *   - **There is no ML-DSA-65.** Every hybrid figure is arithmetic over
 *     ADR-022 §3's own 3,309 bytes. Nothing here has produced, verified or timed
 *     a post-quantum signature, so the hybrid column has byte counts and no
 *     milliseconds — a projected size is arithmetic, a projected time would be
 *     an invention.
 *   - **Nothing splits an artifact.** ADR-022 §3 says the tooling does not
 *     exist, and it does not. The splits here are this harness's, stated as
 *     proportions in the report, and a different split moves the content column
 *     and leaves the overhead column almost exactly where it is — which is
 *     itself the finding that makes the fraction the interesting quantity.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../lib/transports.mjs';
import { percentile, summarize } from '../lib/stats.mjs';

const require = createRequire(import.meta.url);

export function loadClosure() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'closure.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate, exports: Object.keys(mod || {}) };
  } catch {
    return null;
  }
}

export function loadCrypto() {
  const candidate = path.join(REPO_ROOT, 'artifacts', 'crypto.js');
  try {
    const mod = require(candidate);
    return { module: mod, path: candidate };
  } catch {
    return null;
  }
}

// --- Identity ----------------------------------------------------------------

const ARTIFACT_ID = 'rvqr-bench-artifact';
const SIGNER_ID = 'bench-signers-v1';

/**
 * A fixed seed, so the signatures are the same bytes on every run.
 *
 * This is a benchmark key and nothing else signs with it. It is written out
 * rather than generated because a random key would make the signature hex
 * differ between runs, and the signature LENGTH is one of the quantities being
 * reported — a column that is constant by construction should be visibly
 * constant by construction.
 */
function benchSeed() {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 13) & 0xff;
  return seed;
}

/**
 * The injected checks, wired to the real primitives.
 *
 * `closure.js` takes `digest`, `verifySignature` and `inflate` as injected
 * functions and refuses without them — a check that cannot run reports that it
 * could not run and never degrades into a pass. So the only thing that decides
 * whether this suite measures cryptography or arithmetic is what is injected
 * here, and what is injected here is `crypto.sha256` and `crypto.verifySync`.
 *
 * `inflate` is deliberately absent. No codec is bundled (ADR-003), every closure
 * in this suite is uncompressed, and supplying a stub inflater would put a
 * decompression path in the timings that no closure here takes.
 */
export function realChecks(K) {
  const seed = benchSeed();
  const publicKey = K.publicKeyFromSeed(seed);
  const enc = (s) => new TextEncoder().encode(s);
  return {
    publicKey,
    encode: enc,
    sha256Hex: (bytes) => K.toHex(K.sha256(bytes)),
    signHex: (message) => K.toHex(K.signSync(seed, enc(message))),
    checks: {
      digest: (bytes) => K.toHex(K.sha256(bytes)),
      verifySignature: (desc) => K.verifySync(publicKey, enc(desc.message), K.fromHex(desc.signature))
    }
  };
}

// --- The split ---------------------------------------------------------------

/**
 * How an artifact of `bytes` bytes is divided across closures 2, 3 and 4.
 *
 * ADR-022 §2.1's roles are manifest+policy, minimal RVM runtime, required code
 * and hot state, and cold indexes and optional assets. Closure 1 carries no
 * artifact content at all — it is the manifest — so the artifact itself lives in
 * the other three, and these proportions are this harness's assumption rather
 * than anything the repository decides. Nothing splits an artifact here
 * (ADR-022 §3), so there is no measured split to use instead.
 *
 * The proportions matter less than they look. Overhead is one manifest plus one
 * signature per closure, and a manifest entry is a fixed-width digest plus a
 * decimal size — so moving bytes between closures 2, 3 and 4 changes the content
 * column and leaves the overhead column within a few bytes of where it was. The
 * split is reported anyway, because a number whose insensitivity is asserted
 * rather than shown is a number a reader has to take on trust.
 */
export const SPLIT = { runtime: 0.2, code: 0.3, cold: 0.5 };

function splitBytes(total) {
  const runtime = Math.max(1, Math.floor(total * SPLIT.runtime));
  const code = Math.max(1, Math.floor(total * SPLIT.code));
  const cold = total - runtime - code;
  return [runtime, code, cold];
}

/**
 * Deterministic filler with no structure. mulberry32 from a fixed seed, the same
 * generator `compress.mjs` uses for its incompressible block, so a synthetic
 * artifact reproduces byte for byte between runs.
 */
function fillerBytes(n, seed) {
  const out = new Uint8Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

// --- Building a real four-closure artifact -----------------------------------

/**
 * A four-closure artifact, in the shape `artifacts/closure.test.js`'s `build()`
 * uses, with real digests and real signatures.
 *
 * The shape is taken from the test file rather than invented here on purpose:
 * an offer is refused for a dozen different structural reasons before it ever
 * reaches a digest, and hand-building one is a reliable way to measure a
 * refusal while believing you measured a verification. The one structural thing
 * worth restating, because getting it wrong produces a plausible wrong number:
 * **closure 1 is the manifest and the manifest does not contain its own
 * digest.** The pinned root commits closure 1; closure 1 commits 2..n. So a
 * four-closure artifact carries three digests in its manifest and a fourth
 * out-of-band in the root, and only the three are on the wire.
 */
export function buildArtifact(C, crypto, { bytes, id = ARTIFACT_ID, signer = SIGNER_ID, seed = 20260802 }) {
  const parts = splitBytes(bytes.length);
  const bodies = [
    bytes.subarray(0, parts[0]),
    bytes.subarray(parts[0], parts[0] + parts[1]),
    bytes.subarray(parts[0] + parts[1])
  ];
  const roles = [C.ROLE_RUNTIME, C.ROLE_CODE, C.ROLE_COLD];

  const entries = bodies.map((b, i) => ({
    role: roles[i],
    digest: crypto.sha256Hex(b),
    originalSize: b.length
  }));
  const manifest = { artifactId: id, signerId: signer, closures: entries };
  const manifestBytes = crypto.encode(JSON.stringify(manifest));
  const root = {
    artifactId: id,
    signerId: signer,
    digest: crypto.sha256Hex(manifestBytes),
    originalSize: manifestBytes.length
  };

  const offerFor = (index, role, payload) => {
    const digest = crypto.sha256Hex(payload);
    return {
      artifactId: id,
      index,
      role,
      payload,
      compressed: false,
      originalSize: payload.length,
      signature: crypto.signHex(C.closureSigningString({ artifactId: id, index, role, digest }))
    };
  };

  const offers = [
    offerFor(1, C.ROLE_MANIFEST, manifestBytes),
    ...bodies.map((b, i) => offerFor(i + 2, roles[i], b))
  ];

  return { id, signer, seed, manifest, manifestBytes, root, offers, bodies, parts, entries };
}

export function benchPolicy(C) {
  return {
    requireSignature: true,
    trustedSigners: [SIGNER_ID],
    allowRoles: [C.ROLE_MANIFEST, C.ROLE_RUNTIME, C.ROLE_CODE, C.ROLE_COLD]
  };
}

/**
 * Offers `count` closures in order and returns the session, the per-offer
 * results, and — because a byte count that describes a refused artifact is
 * worthless — whether every one of them verified and was admitted.
 */
export function activate(C, art, count, checks) {
  let session = C.beginActivation(art.root, benchPolicy(C));
  const steps = [];
  for (let i = 0; i < count; i++) {
    const r = C.offerClosure(session, art.offers[i], checks);
    session = r.session;
    steps.push(r);
  }
  return {
    session,
    steps,
    allVerified: steps.every((s) => s.verdict && s.verdict.state === C.STATE_VERIFIED),
    allAdmitted: steps.every((s) => s.decision && s.decision.admit === true),
    completion: C.completion(session)
  };
}

// --- Criterion 7: the overhead accounting ------------------------------------

/**
 * Every byte a four-closure split costs beyond the artifact itself, counted
 * from the real bytes rather than from a formula for them.
 *
 * Three columns, and the distinction between the second and third is the one a
 * reader is most likely to collapse:
 *
 *   contentBytes    the artifact. Closures 2..n only; closure 1 carries none.
 *   manifestBytes   closure 1's real JSON body, measured. It exists only because
 *                   the artifact was split, so all of it is overhead.
 *   digestBytes     the part of that manifest which is digest hex — (n−1) × 64
 *                   characters. A SUBSET of manifestBytes, not an addition to
 *                   it, and reported so the manifest's cost can be seen to be
 *                   mostly digests rather than syntax.
 *
 * And two signature columns, because this module's wire encoding is not the
 * encoding ADR-022 does its arithmetic in. ADR-022 counts a signature as its raw
 * bytes; `parseOffer` requires `signature` to be a run of lowercase hex, so a
 * 64-byte Ed25519 signature occupies 128 bytes as offered. Both are reported:
 * the raw column is the one comparable to ADR-022 and to the hybrid projection,
 * the hex column is what this module would actually put on a wire.
 */
export function overheadOf(C, art, { hybridPerClosure }) {
  const closures = art.offers.length;
  const contentBytes = art.bodies.reduce((a, b) => a + b.length, 0);
  const manifestBytes = art.manifestBytes.length;
  const digestChars = art.entries.reduce((a, e) => a + e.digest.length, 0);
  const sigHexChars = art.offers.reduce((a, o) => a + o.signature.length, 0);
  const sigRawBytes = sigHexChars / 2;

  // The projection. Same manifest — a hybrid scheme changes what signs a
  // closure, not what the manifest says about it — and a projected signature
  // size in place of the measured one.
  const hybridSigBytes = closures * hybridPerClosure;

  const edOverhead = manifestBytes + sigRawBytes;
  const edOverheadOnWire = manifestBytes + sigHexChars;
  const hybridOverhead = manifestBytes + hybridSigBytes;

  return {
    closures,
    contentBytes,
    manifestBytes,
    digestBytes: digestChars,
    manifestSyntaxBytes: manifestBytes - digestChars,

    ed25519SignatureBytes: sigRawBytes,
    ed25519SignatureHexBytes: sigHexChars,
    ed25519OverheadBytes: edOverhead,
    ed25519OverheadOnWireBytes: edOverheadOnWire,
    ed25519Fraction: contentBytes ? edOverhead / contentBytes : Infinity,
    ed25519FractionOnWire: contentBytes ? edOverheadOnWire / contentBytes : Infinity,
    ed25519ExceedsPayload: edOverhead > contentBytes,

    // PROJECTION. Every field on this side of the object is arithmetic over
    // ADR-022 §3's 3,309 B; nothing here measured a post-quantum signature.
    hybridProjection: true,
    hybridSignatureBytes: hybridSigBytes,
    hybridOverheadBytes: hybridOverhead,
    hybridFraction: contentBytes ? hybridOverhead / contentBytes : Infinity,
    hybridExceedsPayload: hybridOverhead > contentBytes
  };
}

/**
 * The ladder: real artifacts at every size, each one activated to `complete`
 * before its overhead is reported.
 *
 * The activation is not ceremony. An overhead row for a split the gate would
 * refuse is a row about nothing, and the failure mode is quiet — a manifest one
 * byte off its committed size produces perfectly good-looking byte counts and a
 * `size-refused` verdict nobody looked at.
 */
export function runOverheadLadder(C, crypto, { sizes, realArtifacts, seed }) {
  const checks = crypto.checks;
  const hybridPerClosure = C.ED25519_SIGNATURE_BYTES + C.MLDSA65_SIGNATURE_BYTES;
  const rows = [];

  const measure = (label, source, bytes) => {
    const art = buildArtifact(C, crypto, { bytes, seed });
    const run = activate(C, art, art.offers.length, checks);
    const o = overheadOf(C, art, { hybridPerClosure });
    rows.push({
      label,
      source,
      bytes: bytes.length,
      split: art.parts,
      completion: run.completion,
      verified: run.allVerified && run.allAdmitted && run.completion === C.COMPLETION_COMPLETE,
      ...o
    });
  };

  for (const size of sizes) {
    measure(`${size.toLocaleString('en-US')} B synthetic`, 'generated', fillerBytes(size, (seed ^ size) >>> 0));
  }
  for (const a of realArtifacts) {
    measure(a.name, 'measured file', a.bytes);
  }
  rows.sort((x, y) => x.bytes - y.bytes);
  return { rows, hybridPerClosure, split: SPLIT };
}

/**
 * The crossover: the smallest artifact for which overhead no longer exceeds
 * payload, found by bisection over REAL builds.
 *
 * Bisection rather than reading it off the ladder, because the ladder's rungs
 * are powers of two and the answer is not: quoting the first ladder size that
 * clears would report a bound as though it were the crossing. The predicate is
 * monotone in size — overhead moves by a byte or two as `originalSize` gains a
 * decimal digit while content moves by the whole step — so bisection is sound
 * here, and the returned row is a real build that a reader can rebuild.
 */
export function findCrossover(C, crypto, { regime, hybridPerClosure, lo = 1, hi = 262144, seed }) {
  const exceeds = (n) => {
    const art = buildArtifact(C, crypto, { bytes: fillerBytes(n, (seed ^ n) >>> 0), seed });
    const o = overheadOf(C, art, { hybridPerClosure });
    return {
      exceeds: regime === 'hybrid' ? o.hybridExceedsPayload
        : regime === 'ed25519-wire' ? o.ed25519OverheadOnWireBytes > o.contentBytes
          : o.ed25519ExceedsPayload,
      overhead: regime === 'hybrid' ? o.hybridOverheadBytes
        : regime === 'ed25519-wire' ? o.ed25519OverheadOnWireBytes
          : o.ed25519OverheadBytes,
      content: o.contentBytes,
      fraction: regime === 'hybrid' ? o.hybridFraction
        : regime === 'ed25519-wire' ? o.ed25519FractionOnWire
          : o.ed25519Fraction
    };
  };

  if (!exceeds(lo).exceeds) return { regime, crossover: lo, bounded: true, atOrBelow: null, at: exceeds(lo) };
  if (exceeds(hi).exceeds) return { regime, crossover: null, bounded: false, atOrBelow: hi, at: exceeds(hi) };

  let a = lo;
  let b = hi;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (exceeds(mid).exceeds) a = mid;
    else b = mid;
  }
  return {
    regime,
    crossover: b,
    bounded: true,
    lastExceeding: a,
    atLast: exceeds(a),
    at: exceeds(b),
    projection: regime === 'hybrid'
  };
}

// --- Criterion 3's number: what verification costs ---------------------------

function timedMs(fn, reps) {
  fn();
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), reps, samples };
}

/**
 * Median milliseconds to verify the activation set against the whole artifact.
 *
 * The claim progressive activation makes is that a receiver starts sooner. Most
 * of that saving is transfer time and is modelled in suite 10; what is measured
 * here is the part that happens on the receiver after the bytes land, and
 * whether the activation set is a small enough share of it for the claim to
 * survive contact with the verification cost it adds.
 *
 * Each closure is timed through `offerClosure` — the whole shipped path, not
 * just the digest — and the digest and the signature check are timed separately
 * beside it, because their sum against the total says how much of the cost is
 * the module and how much is the cryptography. The two scale differently:
 * SHA-256 is linear in content and an Ed25519 verification is a constant per
 * closure, so the share of work in closures 1–3 is a function of the split and
 * not a property of the design.
 */
export function runVerificationCost(C, crypto, { artifacts, reps, seed }) {
  const checks = crypto.checks;
  const rows = [];

  for (const a of artifacts) {
    const art = buildArtifact(C, crypto, { bytes: a.bytes, seed });
    const confirm = activate(C, art, art.offers.length, checks);
    if (!confirm.allAdmitted) {
      rows.push({ name: a.name, bytes: a.bytes.length, error: 'the artifact did not activate; no timing is reported' });
      continue;
    }

    // Per closure, through the shipped path. Each is timed from a session that
    // already holds everything before it, so closure 3's figure is the cost of
    // closure 3 and not the cost of replaying 1 and 2.
    const perClosure = [];
    for (let i = 0; i < art.offers.length; i++) {
      let base = C.beginActivation(art.root, benchPolicy(C));
      for (let j = 0; j < i; j++) base = C.offerClosure(base, art.offers[j], checks).session;
      const frozen = base;
      const t = timedMs(() => C.offerClosure(frozen, art.offers[i], checks), reps);
      const body = i === 0 ? art.manifestBytes : art.bodies[i - 1];
      const digestT = timedMs(() => crypto.sha256Hex(body), reps);
      const verifyT = timedMs(() => checks.verifySignature({
        message: C.closureSigningString({
          artifactId: art.id,
          index: art.offers[i].index,
          role: art.offers[i].role,
          digest: crypto.sha256Hex(body)
        }),
        signature: art.offers[i].signature
      }), reps);
      perClosure.push({
        index: art.offers[i].index,
        role: art.offers[i].role,
        activation: art.offers[i].role !== C.ROLE_COLD,
        contentBytes: body.length,
        offerMs: t.p50,
        offerP95Ms: t.p95,
        digestMs: digestT.p50,
        // The digest is taken twice per verification here — once inside
        // `offerClosure` and once by this harness to attribute the cost — so the
        // attribution column is the cost of ONE digest and the offer column
        // contains one. Stated because two plausible readings differ by 2×.
        signatureVerifyMs: verifyT.p50
      });
    }

    const activationSet = perClosure.filter((c) => c.activation);
    const whole = perClosure;
    const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);

    rows.push({
      name: a.name,
      bytes: a.bytes.length,
      split: art.parts,
      perClosure,
      activationMs: sum(activationSet, 'offerMs'),
      wholeMs: sum(whole, 'offerMs'),
      activationShare: sum(whole, 'offerMs') ? sum(activationSet, 'offerMs') / sum(whole, 'offerMs') : NaN,
      activationContentBytes: sum(activationSet, 'contentBytes'),
      wholeContentBytes: sum(whole, 'contentBytes'),
      activationByteShare: sum(whole, 'contentBytes')
        ? sum(activationSet, 'contentBytes') / sum(whole, 'contentBytes')
        : NaN,
      digestMs: sum(whole, 'digestMs'),
      signatureVerifyMs: sum(whole, 'signatureVerifyMs'),
      // How much of a verification is cryptography and how much is the module's
      // own parsing, ordering, copying and freezing. A large residue would mean
      // the numbers above are about JavaScript rather than about verification.
      moduleResidueMs: sum(whole, 'offerMs') - sum(whole, 'digestMs') - sum(whole, 'signatureVerifyMs')
    });
  }

  // Per-call primitives, so the rows above can be read against something whose
  // scaling is known.
  const oneKiB = fillerBytes(1024, seed >>> 0);
  const sixtyFourB = fillerBytes(64, (seed ^ 0x51ed) >>> 0);
  const msg = C.closureSigningString({
    artifactId: ARTIFACT_ID, index: 2, role: C.ROLE_RUNTIME, digest: crypto.sha256Hex(sixtyFourB)
  });
  const sig = crypto.signHex(msg);
  const primitives = {
    sha256PerKiB: timedMs(() => crypto.sha256Hex(oneKiB), reps * 4).p50,
    sha256Small: timedMs(() => crypto.sha256Hex(sixtyFourB), reps * 4).p50,
    ed25519Verify: timedMs(() => crypto.checks.verifySignature({ message: msg, signature: sig }), reps * 4).p50,
    ed25519Sign: timedMs(() => crypto.signHex(msg), reps * 4).p50
  };

  return { rows, primitives, reps };
}

/**
 * What the module's SYNCHRONOUS verifier contract costs.
 *
 * `verifyClosure` reads `options.verifySignature(desc)` and compares the result
 * against `true`. A promise is not `true`, so a promise-returning verifier
 * produces `unverified` and the closure is refused — which is the right failure
 * mode and is also a hard constraint on what may be injected. On a platform with
 * WebCrypto that constraint has a price, because `crypto.verify` is asynchronous
 * precisely so it can use `subtle` and `crypto.verifySync` is the pure-JS path
 * by definition.
 *
 * Both are timed here over the same key, message and signature. The asynchronous
 * figure is NOT a figure for this module: nothing can inject it. It is the
 * measurement that turns "the sync contract costs something" into a number, and
 * the report says which of the two the shipped path actually pays.
 */
export async function runSignatureBackendCost(C, crypto, K, { reps = 40 } = {}) {
  const enc = (s) => new TextEncoder().encode(s);
  const seed = benchSeed();
  const publicKey = K.publicKeyFromSeed(seed);
  const message = enc(C.closureSigningString({
    artifactId: ARTIFACT_ID, index: 2, role: C.ROLE_RUNTIME, digest: 'a'.repeat(64)
  }));
  const signature = K.signSync(seed, message);

  let capabilities = null;
  try {
    capabilities = await K.capabilities();
  } catch {
    capabilities = null;
  }

  const syncSamples = [];
  K.verifySync(publicKey, message, signature);
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    K.verifySync(publicKey, message, signature);
    syncSamples.push(performance.now() - t0);
  }

  let asyncSummary = null;
  let asyncOk = null;
  try {
    asyncOk = await K.verify(publicKey, message, signature);
    const asyncSamples = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      await K.verify(publicKey, message, signature);
      asyncSamples.push(performance.now() - t0);
    }
    asyncSummary = summarize(asyncSamples);
  } catch {
    asyncSummary = null;
  }

  const syncSummary = summarize(syncSamples);
  return {
    available: true,
    reps,
    capabilities,
    syncMs: syncSummary,
    asyncMs: asyncSummary,
    asyncVerified: asyncOk,
    ratio: asyncSummary && asyncSummary.p50 ? syncSummary.p50 / asyncSummary.p50 : null,
    injectable: 'synchronous only — `verifyClosure` compares the verifier’s answer against `true`, and a ' +
      'promise is not `true`, so an asynchronous verifier yields `unverified` and the closure is refused'
  };
}

// --- Criterion 6's answer: the optical case, re-derived ----------------------

/**
 * ADR-022 §4.6 asks for the optical case "measured and reported honestly,
 * including 'not achievable at this artifact size' where that is the answer".
 *
 * `opticalBudget()` computes it and this function recomputes it independently
 * from the module's exported constants, then compares. Two calculations agreeing
 * is worth more than one calculation reported twice, and if they disagree the
 * report says so rather than printing whichever ran last.
 *
 * The sweep answers the part the ADR's wording leaves open. If the signature
 * floor alone exceeds the budget then no artifact size helps, because content is
 * what is left AFTER the floor — so the honest answer is stronger than the one
 * the criterion's phrasing anticipates, and the sweep is what establishes which
 * of the two answers applies rather than asserting it.
 */
export function runOpticalVerdict(C, { seconds = 3, closures = 3, sizes }) {
  const rate = C.OPTICAL_BYTES_PER_SECOND;
  const perHybrid = C.ED25519_SIGNATURE_BYTES + C.MLDSA65_SIGNATURE_BYTES;

  const hybrid = C.opticalBudget({ seconds, closures, hybrid: true });
  const ed = C.opticalBudget({ seconds, closures, hybrid: false });

  // The same arithmetic, done here, from the constants rather than from the
  // returned object.
  const budget = Math.floor(rate * seconds);
  const floorHybrid = closures * perHybrid;
  const floorEd = closures * C.ED25519_SIGNATURE_BYTES;
  const rederived = {
    rateBytesPerSecond: rate,
    seconds,
    closures,
    budgetBytes: budget,
    hybridPerClosure: perHybrid,
    hybridFloorBytes: floorHybrid,
    hybridContentBytes: budget - floorHybrid,
    hybridAchievable: budget - floorHybrid > 0,
    hybridOvershoot: floorHybrid / budget,
    ed25519FloorBytes: floorEd,
    ed25519ContentBytes: budget - floorEd,
    ed25519Achievable: budget - floorEd > 0,
    // What it would take for the hybrid floor to fit at all. Both are ratios of
    // measured-or-declared constants and neither is a proposal.
    secondsNeededForFloor: floorHybrid / rate,
    rateNeededForFloor: floorHybrid / seconds,
    // This module puts a signature on the wire as lowercase hex, so its own
    // encoding doubles the floor. Measured from `parseOffer`'s requirement, not
    // assumed.
    hybridFloorOnWireBytes: floorHybrid * 2
  };
  const agrees =
    rederived.budgetBytes === hybrid.budgetBytes &&
    rederived.hybridFloorBytes === hybrid.signatureFloorBytes &&
    rederived.hybridAchievable === hybrid.achievable &&
    rederived.ed25519FloorBytes === ed.signatureFloorBytes &&
    rederived.ed25519Achievable === ed.achievable;

  // Artifact size against the budget. The floor does not move with it, which is
  // the whole point, so the column that matters is whether ANY row is
  // achievable rather than which ones are.
  const sweep = sizes.map((size) => {
    const activationContent = Math.round(size * (SPLIT.runtime + SPLIT.code));
    return {
      artifactBytes: size,
      activationContentBytes: activationContent,
      // Content the budget could carry after the signatures are paid for.
      hybridRoomBytes: budget - floorHybrid,
      hybridFits: budget - floorHybrid >= activationContent,
      ed25519RoomBytes: budget - floorEd,
      ed25519Fits: budget - floorEd >= activationContent,
      // Seconds the activation set's CONTENT alone would take at the measured
      // rate, ignoring every signature. Below the target this is a size question;
      // above it, it is one too — but the hybrid row is neither, because it fails
      // before the content is considered at all.
      contentSeconds: activationContent / rate
    };
  });

  return {
    rate,
    seconds,
    closures,
    moduleHybrid: hybrid,
    moduleEd25519: ed,
    rederived,
    agrees,
    sweep,
    anySizeAchievableHybrid: sweep.some((s) => s.hybridFits),
    anySizeAchievableEd25519: sweep.some((s) => s.ed25519Fits)
  };
}

// --- The suite ---------------------------------------------------------------

/**
 * The asynchronous half, loaded and run for the caller. Separate from
 * `runClosureModuleSuite` only because `crypto.verify` has no synchronous form
 * and this suite is otherwise entirely synchronous.
 */
export async function runSignatureBackends({ reps = 40 } = {}) {
  const shipped = loadClosure();
  const loadedCrypto = loadCrypto();
  if (!shipped || !loadedCrypto) {
    return { available: false, reason: 'artifacts/closure.js or artifacts/crypto.js is not present' };
  }
  return runSignatureBackendCost(shipped.module, realChecks(loadedCrypto.module), loadedCrypto.module, { reps });
}

export function runClosureModuleSuite({ reps = 9, seed = 20260802, sizes, opticalSizes } = {}) {
  const shipped = loadClosure();
  if (!shipped) return { available: false, reason: 'artifacts/closure.js not present' };
  const loadedCrypto = loadCrypto();
  if (!loadedCrypto) {
    return { available: false, reason: 'artifacts/crypto.js not present, so no real digest or signature could be injected' };
  }
  const C = shipped.module;
  const crypto = realChecks(loadedCrypto.module);

  const ladderSizes = sizes || [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const opticalLadder = opticalSizes || [1024, 2304, 7320, 16384, 40989, 262144, 1048576];

  // The real artifacts this repository has, at the sizes they are today. Two of
  // them move between runs, so the size is recorded with the row rather than
  // quoted from the last time somebody looked.
  const realArtifacts = [];
  const addReal = (rel, label) => {
    try {
      realArtifacts.push({ name: label || rel, path: rel, bytes: new Uint8Array(fs.readFileSync(path.join(REPO_ROOT, rel))) });
    } catch {
      /* absent; the report lists what was found */
    }
  };
  addReal('artifacts/demo/ruvnet-demo.rvf');
  addReal('artifacts/demo/rvf_wasm_bg.wasm');
  addReal('standalone.html');

  const hybridPerClosure = C.ED25519_SIGNATURE_BYTES + C.MLDSA65_SIGNATURE_BYTES;

  const ladder = runOverheadLadder(C, crypto, { sizes: ladderSizes, realArtifacts, seed });

  const crossovers = ['ed25519', 'ed25519-wire', 'hybrid'].map((regime) =>
    findCrossover(C, crypto, { regime, hybridPerClosure, seed })
  );

  const verification = runVerificationCost(C, crypto, { artifacts: realArtifacts, reps, seed });

  const optical = runOpticalVerdict(C, { seconds: 3, closures: C.ACTIVATION_ROLES.length, sizes: opticalLadder });

  // One worked example, so the per-closure accounting can be checked by hand
  // against a table rather than inferred from totals. The demo container,
  // because it is the smallest real artifact and therefore the one where the
  // overhead is most visible.
  const exampleSource = realArtifacts[0] || { name: '2,304 B synthetic', bytes: fillerBytes(2304, seed) };
  const exampleArt = buildArtifact(C, crypto, { bytes: exampleSource.bytes, seed });
  const exampleRun = activate(C, exampleArt, exampleArt.offers.length, crypto.checks);
  const example = {
    name: exampleSource.name,
    bytes: exampleSource.bytes.length,
    completion: exampleRun.completion,
    receipt: exampleRun.session ? C.activationReceipt(exampleRun.session) : null,
    closures: exampleArt.offers.map((o, i) => ({
      index: o.index,
      role: o.role,
      activation: o.role !== C.ROLE_COLD,
      contentBytes: o.payload.length,
      // Closure 1's digest is in the PINNED ROOT and not on the wire; the rest
      // are in the manifest. Both are 64 hex characters and only three of the
      // four are transmitted, which is the sort of off-by-one that turns a byte
      // count into a wrong byte count.
      digestHexBytes: 64,
      digestOnWire: i > 0,
      signatureRawBytes: o.signature.length / 2,
      signatureHexBytes: o.signature.length,
      hybridSignatureProjectedBytes: hybridPerClosure
    })),
    overhead: overheadOf(C, exampleArt, { hybridPerClosure })
  };

  // The synchronous contract, asked rather than reasoned about. A verifier that
  // returns a promise must produce a refusal and not an admission, because a
  // promise is truthy and a gate that tested truthiness would admit every
  // closure any asynchronous verifier was pointed at.
  const asyncInjection = (() => {
    const r = C.offerClosure(
      C.beginActivation(exampleArt.root, benchPolicy(C)),
      exampleArt.offers[0],
      { digest: crypto.checks.digest, verifySignature: () => Promise.resolve(true) }
    );
    return {
      state: r.verdict ? r.verdict.state : null,
      admitted: r.decision.admit === true,
      code: r.decision.code,
      refusesClosed: !!r.verdict && r.verdict.state === C.STATE_UNVERIFIED && r.decision.admit !== true
    };
  })();

  return {
    available: true,
    path: shipped.path,
    cryptoPath: loadedCrypto.path,
    exports: shipped.exports.length,
    // Read out of the running module rather than restated, for the reason
    // attest.js's describeRoots() is: a caveat that lives only in a report is a
    // caveat that stops being read.
    unimplemented: C.describeUnimplemented(),
    limits: C.describeLimits(),
    constants: {
      ed25519SignatureBytes: C.ED25519_SIGNATURE_BYTES,
      mldsa65SignatureBytes: C.MLDSA65_SIGNATURE_BYTES,
      hybridPerClosure,
      opticalBytesPerSecond: C.OPTICAL_BYTES_PER_SECOND,
      activationRoles: C.ACTIVATION_ROLES,
      roles: C.ROLES
    },
    digestName: 'SHA-256 (artifacts/crypto.js)',
    signatureName: 'Ed25519 (artifacts/crypto.js, signSync/verifySync)',
    split: SPLIT,
    ladder,
    crossovers,
    verification,
    optical,
    example,
    asyncInjection,
    // The projection, read from the module for the closure counts that matter.
    hybridProjections: [3, 4].map((n) => C.hybridSignatureProjection(n)),
    // Criterion 5 is unmeetable here and this suite says so rather than
    // producing a number that could be mistaken for it.
    radioTier: {
      measured: false,
      reason: 'There is no radio tier in this repository — no QUIC and no radio transport — so ADR-022 ' +
        '§4.5\'s "under 3 s at p95 on the radio tier" is not measured here and no p95 is quoted. ' +
        'Simulating a radio and reporting the result as observed would be the dishonest option.'
    }
  };
}
