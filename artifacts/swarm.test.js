/*!
 * rvQR fleet swarm distribution test suite — standalone.
 *
 * Node:    `node artifacts/swarm.test.js` — one line per test, non-zero exit
 *          on any failure.
 * Browser: load after swarm.js and crypto.js, then call
 *          RVQRSwarmTests.runAll(RVQRSwarm, { crypto: RVQRCrypto }).
 *
 * Nothing here reads a clock, a file, a network or a piece of hardware. The
 * digest function, the signer and the signature verifier are all injected, the
 * simulation's clock is a tick counter and its randomness is seeded, so the
 * same configuration produces the same schedule and the same report every time.
 *
 * Six groups carry the weight, one per thing ADR-024 could get wrong.
 *
 * The TRANSPORT group is ADR-024 §2.2 and criterion 3. It runs the real thing
 * the criterion asks for: a peer serving GENUINELY SIGNED chunks from a
 * DIFFERENT artifact into ten receivers, and every one of the ten rejecting
 * them — first with the other artifact's name on them, then relabelled with
 * this artifact's name so the refusal has to come from the bytes. It then
 * shows the structural reason: no function that can admit takes a peer
 * identity, the receiver policy has no field in which to trust one, and the
 * set this device forwards is derived from the set it stored.
 *
 * The QUARANTINE group walks the whole reachable object graph of a receiver
 * after every kind of refusal and asserts the refused bytes are in none of it
 * — so "discarded before it is stored or forwarded" is checked adversarially
 * rather than by reading the code.
 *
 * The MEASURED group is criterion 4. It asserts that advertising cannot move a
 * rank at all — the claims map is not in `rankProviders`' argument list, so the
 * test inflates a peer's advertisements arbitrarily and requires the ranking
 * to be byte-identical — and then measures what each of the three named
 * behaviours costs. The ordering that comes out is reported, not assumed.
 *
 * The SOURCE group is criterion 6: the meter is written where the bytes leave
 * the source, and the test asserts the direct number DIFFERS from what chunk
 * accounting would have claimed, because a test that could not tell the two
 * apart would not be testing anything.
 *
 * The CODEC group is criterion 5. It sweeps every string this module can emit
 * — from the honesty functions, from a simulation report and from a behaviour
 * comparison — and requires that anything mentioning RaptorQ also says it is
 * not RFC 6330 conformant.
 *
 * The HONESTY group asserts what this build is NOT entitled to claim: that
 * criteria 1 and 2 need physical devices and are not met, that no field
 * anywhere is denominated in seconds, and that running a ten-device simulation
 * does not turn into a Fleet-10 result.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var swarm = require('./swarm.js');
      var results = api.runAll(swarm, { crypto: require('./crypto.js') });
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
    root.RVQRSwarmTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALPHA = 'artifact-alpha';
  var BETA = 'artifact-beta';
  var SIGNER = 'fleet-source-v3';

  // --- Test doubles ----------------------------------------------------------
  // A deterministic 64-hex digest and a deterministic signature. NEITHER IS
  // CRYPTOGRAPHY: they stand in for the injected checks so the tests are fast
  // and deterministic. The last test in this file runs the same pipeline with
  // crypto.js's real SHA-256 and real Ed25519, which is the composition that
  // matters — and is still only half of ADR-012's scheme.

  function fnv(bytes, seed) {
    var hi = seed >>> 0, lo = 0x811c9dc5 >>> 0;
    for (var i = 0; i < bytes.length; i++) {
      lo = (lo ^ bytes[i]) >>> 0;
      lo = Math.imul(lo, 16777619) >>> 0;
      hi = (hi ^ (lo + i)) >>> 0;
      hi = Math.imul(hi, 2246822519) >>> 0;
    }
    return ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8);
  }

  function digestOf(bytes) {
    return fnv(bytes, 0x1234) + fnv(bytes, 0x9e37) + fnv(bytes, 0x85eb) + fnv(bytes, 0xc2b2);
  }

  function encode(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function fakeSign(message) {
    return digestOf(encode(SIGNER + ' ' + message)) + digestOf(encode(message + ' ' + SIGNER));
  }

  function wrongSign(message) {
    return digestOf(encode('impostor ' + message)) + digestOf(encode(message + ' impostor'));
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function runAll(S, deps) {
    var results = [];
    var D = deps || {};

    function test(name, fn) {
      try {
        var detail = fn();
        results.push({ name: name, ok: true, detail: detail || '' });
      } catch (err) {
        results.push({ name: name, ok: false, detail: err && err.message ? err.message : String(err) });
      }
    }

    function assert(cond, message) {
      if (!cond) throw new Error(message || 'assertion failed');
    }

    function eq(actual, expected, message) {
      if (actual !== expected) {
        throw new Error((message || 'mismatch') + ': expected ' + JSON.stringify(expected) +
          ', got ' + JSON.stringify(actual));
      }
    }

    var OPTS = {
      digest: digestOf,
      verifySignature: function (desc) { return desc.signature === fakeSign(desc.message); }
    };

    // --- Fixtures ------------------------------------------------------------
    // Two artifacts, both genuinely signed by the same trusted signer, the same
    // length and the same chunking. Beta exists so that criterion 3's peer has
    // something valid to serve that is nonetheless not this artifact — and the
    // matching lengths mean a relabelled beta chunk has to be refused on its
    // CONTENT rather than falling out on a size check.

    function makeArtifact(artifactId, filler, chunkSize) {
      var text = '';
      while (text.length < 32 * chunkSize) text += filler;
      var bytes = encode(text.slice(0, 32 * chunkSize));
      var built = S.buildManifest({
        artifactId: artifactId, signerId: SIGNER, bytes: bytes, chunkSize: chunkSize
      }, OPTS);
      assert(built.ok, 'fixture manifest must build: ' + built.reason);
      var manifestBytes = encode(JSON.stringify(built.manifest));
      var manifestDigest = digestOf(manifestBytes);
      var root = { artifactId: artifactId, signerId: SIGNER, manifestDigest: manifestDigest };
      var offer = {
        artifactId: artifactId,
        bytes: manifestBytes,
        signature: fakeSign(S.manifestSigningString({
          artifactId: artifactId, manifestDigest: manifestDigest
        }))
      };
      return {
        artifactId: artifactId, bytes: bytes, built: built, bodies: built.bodies,
        manifest: built.manifest, manifestBytes: manifestBytes, manifestDigest: manifestDigest,
        root: root, offer: offer, chunkSize: chunkSize
      };
    }

    var CHUNK = 16;
    var alpha = makeArtifact(ALPHA, 'alpha-payload-', CHUNK);
    var beta = makeArtifact(BETA, 'BETA-payload!!', CHUNK);
    assert(alpha.bytes.length === beta.bytes.length, 'the two fixtures must be the same size');
    assert(!bytesEqual(alpha.bodies[0], beta.bodies[0]), 'and must differ in content');

    var POLICY = { acceptUnsignedManifest: false, trustedSigners: [SIGNER] };

    function anchored(fixture, policy) {
      var r = S.beginReceive(fixture.root, policy || POLICY);
      var out = S.offerManifest(r, fixture.offer, OPTS);
      assert(out.decision.admit, 'the fixture manifest must anchor: ' + out.decision.reason);
      return out.receiver;
    }

    function deliveryFor(fixture, index, overrides) {
      var base = { artifactId: fixture.artifactId, index: index, bytes: fixture.bodies[index] };
      if (overrides) Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
      return base;
    }

    /** Every Uint8Array and every string reachable from a value. */
    function reachable(value, seen, bytes, strings, depth) {
      seen = seen || [];
      bytes = bytes || [];
      strings = strings || [];
      depth = depth || 0;
      if (depth > 12 || value === null || value === undefined) return { bytes: bytes, strings: strings };
      if (typeof value === 'string') { strings.push(value); return { bytes: bytes, strings: strings }; }
      if (typeof value !== 'object' && typeof value !== 'function') return { bytes: bytes, strings: strings };
      if (seen.indexOf(value) >= 0) return { bytes: bytes, strings: strings };
      seen.push(value);
      if (ArrayBuffer.isView(value)) { bytes.push(value); return { bytes: bytes, strings: strings }; }
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) reachable(value[keys[i]], seen, bytes, strings, depth + 1);
      return { bytes: bytes, strings: strings };
    }

    function everyKey(value, out, seen, depth) {
      out = out || [];
      seen = seen || [];
      depth = depth || 0;
      if (depth > 12 || !value || typeof value !== 'object' || ArrayBuffer.isView(value)) return out;
      if (seen.indexOf(value) >= 0) return out;
      seen.push(value);
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        if (!Array.isArray(value)) out.push(keys[i]);
        everyKey(value[keys[i]], out, seen, depth + 1);
      }
      return out;
    }

    // =========================================================================
    // TRANSPORT — a peer is a transport, not an authority (ADR-024 §2.2, crit 3)
    // =========================================================================

    test('a source chunk verifies against the receiver’s own manifest and is stored', function () {
      var r = anchored(alpha);
      var out = S.offerChunk(r, deliveryFor(alpha, 0), OPTS);
      eq(out.verdict.state, S.STATE_VERIFIED, 'the verdict');
      eq(out.decision.admit, true, 'admitted: ' + out.decision.reason);
      eq(out.decision.code, S.CODE_ADMITTED, 'the code');
      eq(out.receiver.chunks.length, 1, 'one chunk stored');
      assert(S.holds(out.receiver, 0), 'and it is held');
      assert(bytesEqual(S.advertise(out.receiver).have, [0]) ||
        S.advertise(out.receiver).have.join() === '0', 'and it is advertised');
      return 'chunk 0 of ' + alpha.built.parsed.chunkCount;
    });

    test('the whole artifact reassembles, and every byte was digested on this device', function () {
      var r = anchored(alpha);
      for (var i = 0; i < alpha.bodies.length; i++) {
        var out = S.offerChunk(r, deliveryFor(alpha, i), OPTS);
        eq(out.decision.admit, true, 'chunk ' + i + ': ' + out.decision.reason);
        r = out.receiver;
      }
      assert(S.isComplete(r), 'complete');
      assert(bytesEqual(S.reassemble(r), alpha.bytes), 'and byte-identical to the source artifact');
      var receipt = S.receiveReceipt(r);
      eq(receipt.verifiedLocally, true, 'the receipt records local verification');
      eq(receipt.chunksHeld, alpha.bodies.length, 'and the count');
      return alpha.bodies.length + ' chunks, ' + alpha.bytes.length + ' bytes';
    });

    test('CRITERION 3: a peer serving another artifact’s signed chunks is refused by every receiver', function () {
      // Ten receivers, exactly as ADR-024 §4.3 asks. Beta's chunks are
      // genuinely part of a manifest signed by the SAME trusted signer, so
      // nothing about them is forged — they are simply not this artifact.
      var refusals = {};
      for (var d = 0; d < 10; d++) {
        var r = anchored(alpha);
        var out = S.offerChunk(r, { artifactId: BETA, index: 0, bytes: beta.bodies[0] }, OPTS);
        eq(out.decision.admit, false, 'device ' + d + ' must refuse');
        eq(out.verdict.state, S.STATE_FOREIGN, 'device ' + d + ' refuses it as foreign');
        eq(out.receiver.chunks.length, 0, 'device ' + d + ' stores nothing');
        eq(S.advertise(out.receiver).have.length, 0, 'device ' + d + ' advertises nothing');
        refusals[out.decision.code] = (refusals[out.decision.code] || 0) + 1;
      }
      eq(refusals[S.CODE_FOREIGN], 10, 'all ten refused on the same ground');
      return '10/10 receivers refused a validly signed chunk of ' + BETA;
    });

    test('CRITERION 3: relabelled with THIS artifact’s name, the same chunk is still refused by all ten', function () {
      // The peer strips the giveaway. Now the refusal cannot come from the
      // label and has to come from the bytes — which is the whole property.
      for (var d = 0; d < 10; d++) {
        var r = anchored(alpha);
        var out = S.offerChunk(r, { artifactId: ALPHA, index: 0, bytes: beta.bodies[0] }, OPTS);
        eq(out.decision.admit, false, 'device ' + d + ' must refuse');
        eq(out.verdict.state, S.STATE_DIGEST_MISMATCH, 'device ' + d + ': the bytes decide, not the label');
        eq(out.receiver.chunks.length, 0, 'device ' + d + ' stores nothing');
      }
      return '10/10 refused on digest, with a size that matched and a label that matched';
    });

    test('CRITERION 3: the whole of the other artifact, chunk by chunk, lands nowhere', function () {
      var r = anchored(alpha);
      for (var i = 0; i < beta.bodies.length; i++) {
        r = S.offerChunk(r, { artifactId: ALPHA, index: i, bytes: beta.bodies[i] }, OPTS).receiver;
      }
      eq(r.chunks.length, 0, 'nothing stored');
      eq(r.quarantinedTotal, beta.bodies.length, 'every one refused');
      eq(S.advertise(r).have.length, 0, 'and nothing forwardable');
      eq(S.reassemble(r), null, 'and no artifact');
      return beta.bodies.length + ' valid chunks of the wrong artifact, 0 accepted';
    });

    test('a refused chunk is not forwardable, because the forwarding set is derived from the store', function () {
      var r = anchored(alpha);
      r = S.offerChunk(r, deliveryFor(alpha, 3), OPTS).receiver;
      var before = S.advertise(r);
      var after = r;
      // Every way a chunk can be refused, one after another.
      after = S.offerChunk(after, { artifactId: BETA, index: 4, bytes: alpha.bodies[4] }, OPTS).receiver;
      after = S.offerChunk(after, { artifactId: ALPHA, index: 4, bytes: beta.bodies[4] }, OPTS).receiver;
      after = S.offerChunk(after, { artifactId: ALPHA, index: 999, bytes: alpha.bodies[4] }, OPTS).receiver;
      after = S.offerChunk(after, { artifactId: ALPHA, index: 4, bytes: encode('short') }, OPTS).receiver;
      after = S.offerChunk(after, 'not an object at all', OPTS).receiver;
      eq(after.quarantinedTotal, 5, 'five refusals');
      eq(JSON.stringify(S.advertise(after).have), JSON.stringify(before.have),
        'and the advertised set did not move');
      return 'advertised ' + JSON.stringify(before.have) + ' before and after 5 refusals';
    });

    test('the refused bytes are reachable from nowhere in the receiver', function () {
      // Adversarial rather than by inspection: walk the whole object graph.
      var marker = new Uint8Array(alpha.chunkSize);
      for (var m = 0; m < marker.length; m++) marker[m] = 0xa7;
      var r = anchored(alpha);
      r = S.offerChunk(r, deliveryFor(alpha, 0), OPTS).receiver;
      var refused = [
        { artifactId: ALPHA, index: 1, bytes: marker },
        { artifactId: BETA, index: 1, bytes: marker },
        { artifactId: ALPHA, index: 4096, bytes: marker }
      ];
      for (var i = 0; i < refused.length; i++) {
        var out = S.offerChunk(r, refused[i], OPTS);
        eq(out.decision.admit, false, 'refusal ' + i);
        r = out.receiver;
      }
      var seen = reachable(r);
      for (var b = 0; b < seen.bytes.length; b++) {
        assert(!bytesEqual(seen.bytes[b], marker),
          'the refused bytes are reachable from the receiver at graph position ' + b);
      }
      eq(r.chunks.length, 1, 'only the one verified chunk is held');
      return 'walked ' + seen.bytes.length + ' byte arrays and ' + seen.strings.length + ' strings';
    });

    test('no function that can admit takes a peer identity, and a delivery cannot smuggle one', function () {
      var r = anchored(alpha);
      var plain = S.offerChunk(r, deliveryFor(alpha, 0), OPTS);
      var dressed = S.offerChunk(r, deliveryFor(alpha, 0, {
        peerId: 'trusted-peer', trusted: true, priority: 99, signature: 'ff'.repeat(64)
      }), OPTS);
      eq(dressed.verdict.state, plain.verdict.state, 'the verdict does not move');
      eq(dressed.decision.code, plain.decision.code, 'and neither does the decision');

      var hostile = S.offerChunk(r, {
        artifactId: ALPHA, index: 0, bytes: beta.bodies[0], peerId: 'trusted-peer', trusted: true
      }, OPTS);
      eq(hostile.decision.admit, false, 'and a trusted-looking peer with wrong bytes still fails');

      var p = S.normalizePolicy({
        acceptUnsignedManifest: false, trustedSigners: [SIGNER],
        trustedPeers: ['trusted-peer'], allowPeers: ['x'], peerId: 'y'
      });
      eq(Object.keys(p).sort().join(','), 'acceptUnsignedManifest,declared,trustedSigners',
        'the policy has no peer field to express trust in');
      return 'verdict and decision are byte-identical with and without peer dressing';
    });

    test('a chunk claiming another index is measured against the position it named, and stored under none', function () {
      var r = anchored(alpha);
      // Genuine chunk 5 bytes, offered as chunk 6.
      var out = S.offerChunk(r, { artifactId: ALPHA, index: 6, bytes: alpha.bodies[5] }, OPTS);
      eq(out.verdict.state, S.STATE_DIGEST_MISMATCH, 'it fails the digest for the position it named');
      eq(out.receiver.chunks.length, 0, 'and is not quietly filed under position 5');
      assert(!S.holds(out.receiver, 5), 'position 5 is still outstanding');
      assert(!S.holds(out.receiver, 6), 'and so is position 6');
      return 'index claim selects the committed digest and confers nothing';
    });

    test('a chunk offered before the manifest verifies is refused, and the digest function is never called', function () {
      var calls = 0;
      var counting = { digest: function (b) { calls++; return digestOf(b); } };
      var r = S.beginReceive(alpha.root, POLICY);
      var out = S.offerChunk(r, deliveryFor(alpha, 0), counting);
      eq(out.decision.code, S.CODE_MANIFEST_UNVERIFIED, 'refused for want of an anchor');
      eq(calls, 0, 'and nothing was hashed');
      eq(out.receiver.chunks.length, 0, 'and nothing stored');
      return 'no committed digest, so no comparison and no work done';
    });

    test('a foreign or unknown-index delivery never reaches the digest function either', function () {
      var calls = 0;
      var counting = { digest: function (b) { calls++; return digestOf(b); } };
      var r = anchored(alpha);
      S.offerChunk(r, { artifactId: BETA, index: 0, bytes: alpha.bodies[0] }, counting);
      S.offerChunk(r, { artifactId: ALPHA, index: 60000, bytes: alpha.bodies[0] }, counting);
      S.offerChunk(r, { artifactId: ALPHA, index: 0, bytes: encode('wrong length') }, counting);
      eq(calls, 0, 'a stranger cannot make a receiver hash by shouting chunk numbers');
      return 'foreign, unknown-index and wrong-size all refuse before the hash';
    });

    // =========================================================================
    // THE ANCHOR — the manifest is the only authority, and it is signed
    // =========================================================================

    test('a manifest whose digest is not the pinned one is refused', function () {
      var r = S.beginReceive(alpha.root, POLICY);
      var out = S.offerManifest(r, {
        artifactId: ALPHA, bytes: beta.manifestBytes, signature: alpha.offer.signature
      }, OPTS);
      eq(out.verdict.state, S.STATE_DIGEST_MISMATCH, 'the state');
      eq(out.decision.admit, false, 'refused');
      eq(out.receiver.manifest, null, 'and nothing anchored');
      return out.decision.code;
    });

    test('a manifest for a different artifact is refused even against its own pin', function () {
      var r = S.beginReceive({
        artifactId: ALPHA, signerId: SIGNER, manifestDigest: beta.manifestDigest
      }, POLICY);
      var out = S.offerManifest(r, beta.offer, OPTS);
      eq(out.verdict.state, S.STATE_FOREIGN, 'the state');
      eq(out.decision.admit, false, 'refused');
      return 'a pin naming one artifact will not anchor another';
    });

    test('a forged manifest signature is refused, and an untrusted signer is refused separately', function () {
      var forged = {
        artifactId: ALPHA, bytes: alpha.manifestBytes,
        signature: wrongSign(S.manifestSigningString({
          artifactId: ALPHA, manifestDigest: alpha.manifestDigest
        }))
      };
      var a = S.offerManifest(S.beginReceive(alpha.root, POLICY), forged, OPTS);
      eq(a.verdict.state, S.STATE_FORGED, 'a bad signature is forged');
      eq(a.decision.code, S.CODE_FORGED, 'and refused');

      // Genuine signature, verifier says yes, and this receiver still does not
      // accept the key: a verifier saying the signature is genuine is not this
      // receiver saying the key may sign for it.
      var b = S.offerManifest(
        S.beginReceive(alpha.root, { acceptUnsignedManifest: false, trustedSigners: ['someone-else'] }),
        alpha.offer, OPTS);
      eq(b.verdict.state, S.STATE_VERIFIED, 'the signature genuinely verified');
      eq(b.decision.admit, false, 'and the manifest was still refused');
      eq(b.decision.code, S.CODE_UNTRUSTED_SIGNER, 'on the signer');
      return 'forged and untrusted are different refusals';
    });

    test('an unsigned manifest is refused unless the receiver has declared it accepts one', function () {
      var unsigned = { artifactId: ALPHA, bytes: alpha.manifestBytes, signature: null };
      var strict = S.offerManifest(S.beginReceive(alpha.root, POLICY), unsigned, OPTS);
      eq(strict.verdict.state, S.STATE_UNSIGNED, 'the state');
      eq(strict.decision.code, S.CODE_UNSIGNED, 'refused');

      var lax = S.offerManifest(
        S.beginReceive(alpha.root, { acceptUnsignedManifest: true, trustedSigners: [SIGNER] }),
        unsigned, OPTS);
      eq(lax.decision.admit, true, 'accepted only because the receiver said so: ' + lax.decision.reason);
      assert(lax.receiver.manifest !== null, 'and it did anchor');
      // And the out-of-band pin is still doing all the work: different bytes
      // with no signature are still refused.
      var swapped = S.offerManifest(
        S.beginReceive(alpha.root, { acceptUnsignedManifest: true, trustedSigners: [SIGNER] }),
        { artifactId: ALPHA, bytes: beta.manifestBytes, signature: null }, OPTS);
      eq(swapped.decision.admit, false, 'the pin still refuses the wrong bytes');
      return 'acceptUnsignedManifest has no default and narrows to the pinned bytes';
    });

    test('an undeclared policy refuses everything, and normalising twice does not invent a position', function () {
      var r = S.beginReceive(alpha.root, { trustedSigners: [SIGNER] });
      var m = S.offerManifest(r, alpha.offer, OPTS);
      eq(m.decision.code, S.CODE_POLICY_UNDECLARED, 'the manifest');
      var once = S.normalizePolicy({ trustedSigners: [SIGNER] });
      var twice = S.normalizePolicy(once);
      eq(once.acceptUnsignedManifest, null, 'undeclared stays null');
      eq(twice.acceptUnsignedManifest, null, 'and stays null on a second pass');
      eq(twice.declared, false, 'so a policy never acquires a position nobody took');
      return 'policy-undeclared';
    });

    test('a receiver with no pinned root refuses everything', function () {
      var r = S.beginReceive(null, POLICY);
      eq(r.rootDeclared, false, 'no root');
      eq(S.offerManifest(r, alpha.offer, OPTS).decision.code, S.CODE_ROOT_UNDECLARED, 'the manifest');
      eq(S.offerChunk(r, deliveryFor(alpha, 0), OPTS).decision.code, S.CODE_ROOT_UNDECLARED, 'and a chunk');
      return 'root-undeclared';
    });

    test('reordering the manifest’s chunk list changes its digest, so the pin refuses it', function () {
      var reordered = {
        artifactId: ALPHA, signerId: SIGNER, totalBytes: alpha.manifest.totalBytes,
        chunks: alpha.manifest.chunks.slice(0)
      };
      var swap = reordered.chunks[0];
      reordered.chunks[0] = reordered.chunks[1];
      reordered.chunks[1] = swap;
      assert(S.canonicalManifestString(reordered) !== S.canonicalManifestString(alpha.manifest),
        'the canonical string must change');
      var bytes = encode(JSON.stringify(reordered));
      assert(digestOf(bytes) !== alpha.manifestDigest, 'and so must the digest');
      var out = S.offerManifest(S.beginReceive(alpha.root, POLICY), {
        artifactId: ALPHA, bytes: bytes, signature: alpha.offer.signature
      }, OPTS);
      eq(out.decision.admit, false, 'so a reordered artifact never starts');
      eq(out.verdict.state, S.STATE_DIGEST_MISMATCH, 'on the digest');
      return 'position is index; there is no index field to lie in';
    });

    test('a manifest whose declared total disagrees with its chunks is not a manifest', function () {
      var bad = {
        artifactId: ALPHA, signerId: SIGNER, chunks: alpha.manifest.chunks,
        totalBytes: alpha.manifest.totalBytes + 1
      };
      var parsed = S.parseManifest(bad);
      eq(parsed.ok, false, 'refused');
      assert(/two different artifacts/.test(parsed.reason), 'and says why: ' + parsed.reason);
      return parsed.reason.slice(0, 60);
    });

    test('a verified manifest is never replaced, so a peer cannot re-anchor a transfer', function () {
      var r = anchored(alpha);
      var again = S.offerManifest(r, beta.offer, OPTS);
      eq(again.decision.admit, false, 'refused');
      eq(again.decision.code, S.CODE_ALREADY_HELD, 'as already anchored');
      eq(again.receiver.manifest.artifactId, ALPHA, 'and the anchor is unchanged');
      var same = S.offerManifest(r, alpha.offer, OPTS);
      eq(same.decision.admit, false, 'even the identical manifest is not re-applied');
      return 'a receiver that can be re-anchored mid-transfer is a receiver a peer can redirect';
    });

    // =========================================================================
    // THE GATE — total, exhaustive, and one admit
    // =========================================================================

    test('chunkGate is total over the vocabulary and an unknown state fails closed', function () {
      for (var i = 0; i < S.STATES.length; i++) {
        var g = S.chunkGate(S.STATES[i]);
        eq(g.pass, S.STATES[i] === S.STATE_VERIFIED, 'gate for ' + S.STATES[i]);
        if (!g.pass) assert(typeof g.code === 'string' && g.code.length, 'and carries a code');
      }
      var unknown = S.chunkGate('a-state-from-a-later-build');
      eq(unknown.pass, false, 'an unknown state does not pass');
      eq(unknown.code, S.CODE_UNKNOWN_STATE, 'and is named as unknown');
      eq(S.chunkGate(undefined).pass, false, 'and neither does nothing at all');
      return S.STATES.length + ' states plus the default';
    });

    test('admitChunk admits on exactly one combination, swept exhaustively', function () {
      var states = S.STATES.concat(['invented-state', null, undefined]);
      var admits = 0;
      var total = 0;
      for (var s = 0; s < states.length; s++) {
        for (var root = 0; root < 2; root++) {
          for (var man = 0; man < 2; man++) {
            for (var held = 0; held < 2; held++) {
              for (var pol = 0; pol < 2; pol++) {
                total++;
                var policy = pol ? POLICY : { trustedSigners: [SIGNER] };
                var d = S.admitChunk(policy, states[s] ? { state: states[s], index: 0 } : null, {
                  rootDeclared: !!root, manifestVerified: !!man, held: !!held
                });
                var expected = !!pol && !!root && !!man && !held && states[s] === S.STATE_VERIFIED;
                eq(d.admit, expected, 'state=' + states[s] + ' root=' + !!root + ' manifest=' + !!man +
                  ' held=' + !!held + ' declared=' + !!pol);
                if (d.admit) admits++;
              }
            }
          }
        }
      }
      eq(admits, 1, 'exactly one admitting combination out of ' + total);
      return admits + ' admit out of ' + total + ' combinations';
    });

    test('a check that cannot run is refused, never passed', function () {
      var r = anchored(alpha);
      var none = S.offerChunk(r, deliveryFor(alpha, 0), {});
      eq(none.verdict.state, S.STATE_UNVERIFIED, 'no digest function');
      eq(none.decision.admit, false, 'refused');
      var threw = S.offerChunk(r, deliveryFor(alpha, 0), {
        digest: function () { throw new Error('hsm unplugged'); }
      });
      eq(threw.verdict.state, S.STATE_UNVERIFIED, 'a digest function that throws');
      eq(threw.decision.admit, false, 'is also refused');
      var lying = S.offerChunk(r, deliveryFor(alpha, 0), { digest: function () { return null; } });
      eq(lying.verdict.state, S.STATE_DIGEST_MISMATCH, 'and one that returns nothing does not pass');
      return 'unverified is a refusal, not the feature’s off state';
    });

    test('a second correct copy is already-held and does not overwrite the first', function () {
      var r = anchored(alpha);
      r = S.offerChunk(r, deliveryFor(alpha, 2), OPTS).receiver;
      var stored = r.chunks[0].bytes;
      var again = S.offerChunk(r, deliveryFor(alpha, 2), OPTS);
      eq(again.decision.admit, false, 'not stored twice');
      eq(again.decision.code, S.CODE_ALREADY_HELD, 'and not an error either');
      eq(again.verdict.state, S.STATE_VERIFIED, 'the bytes were fine');
      eq(again.receiver.chunks.length, 1, 'one copy');
      assert(again.receiver.chunks[0].bytes === stored, 'and it is the copy already held');
      return 'a duplicate is bandwidth spent, not a fault';
    });

    test('a receiver is immutable and the stored copy is not the caller’s buffer', function () {
      var r = anchored(alpha);
      var before = JSON.stringify(S.advertise(r));
      var mutable = new Uint8Array(alpha.bodies[0].length);
      mutable.set(alpha.bodies[0]);
      var out = S.offerChunk(r, { artifactId: ALPHA, index: 0, bytes: mutable }, OPTS);
      eq(JSON.stringify(S.advertise(r)), before, 'the receiver passed in did not move');
      eq(r.chunks.length, 0, 'and holds nothing');
      mutable[0] = (mutable[0] + 1) & 0xff;
      assert(bytesEqual(out.receiver.chunks[0].bytes, alpha.bodies[0]),
        'and writing into the offered buffer did not change what verified');
      return 'offerClosure’s rule, applied to chunks';
    });

    // =========================================================================
    // MEASURED, NOT CLAIMED — the scheduler (ADR-024 §2.2, criterion 4)
    // =========================================================================

    test('advertising cannot move a rank: the claims map is not in rankProviders’ arguments', function () {
      var ledger = S.newLedger();
      ledger = S.noteRequest(ledger, 'peer:quiet');
      ledger = S.noteDelivery(ledger, 'peer:quiet', { admitted: true, bytes: 16, ticks: 1 });
      ledger = S.noteRequest(ledger, 'peer:loud');
      ledger = S.noteTimeout(ledger, 'peer:loud', 8);
      var candidates = ['peer:quiet', 'peer:loud'];
      var before = JSON.stringify(S.rankProviders(S.measurementsOf(ledger), candidates));

      // The loud peer now advertises the entire chunk space, several times.
      var everything = [];
      for (var i = 0; i < 4096; i++) everything.push(i);
      for (var k = 0; k < 5; k++) ledger = S.noteAdvertisement(ledger, 'peer:loud', everything);
      var after = JSON.stringify(S.rankProviders(S.measurementsOf(ledger), candidates));
      eq(after, before, 'the ranking must be byte-identical');
      eq(S.claimsChunk(ledger, 'peer:loud', 4095), true, 'the claim was recorded');
      eq(S.rankProviders(S.measurementsOf(ledger), candidates)[0].peerId, 'peer:quiet',
        'and the peer that delivered is still first');
      return '4096 chunks advertised 5 times over: ranking unchanged';
    });

    test('peerScore reads measured counters only, and ignores anything a peer could send', function () {
      var honest = { requested: 4, accepted: 4, rejected: 0, timedOut: 0, deliveries: 4, ticksToDelivery: 4 };
      var dressed = {
        requested: 4, accepted: 4, rejected: 0, timedOut: 0, deliveries: 4, ticksToDelivery: 4,
        advertised: 4096, trusted: true, reputation: 1e9, priority: 'high', endorsedBy: ['everyone']
      };
      eq(S.peerScore(dressed), S.peerScore(honest), 'the score does not move');
      eq(S.peerScore(honest), 1, 'an honest peer scores 1');
      eq(S.peerScore(undefined), S.TRIAL_SCORE, 'an unmeasured peer gets a trial, not a promotion');
      eq(S.peerScore({ requested: 1, timedOut: 1 }), -S.FAILURE_WEIGHT, 'one unanswered request');
      eq(S.peerScore({ requested: 1, rejected: 1 }), -S.FAILURE_WEIGHT, 'one bad delivery');
      assert(S.peerScore({ requested: 1, timedOut: 1 }) < S.SCORE_FLOOR, 'both fall below the floor');
      return 'honest 1, withheld ' + S.peerScore({ requested: 1, timedOut: 1 }) +
        ', floor ' + S.SCORE_FLOOR;
    });

    test('advertise-and-withhold and corrupt-chunk fall below the floor after one attempt', function () {
      var withhold = S.noteTimeout(S.noteRequest(S.newLedger(), 'peer:w'), 'peer:w', 8);
      var corrupt = S.noteDelivery(S.noteRequest(S.newLedger(), 'peer:c'), 'peer:c',
        { admitted: false, bytes: 16, ticks: 1 });
      eq(S.rankProviders(S.measurementsOf(withhold), ['peer:w'])[0].eligible, false, 'the withholder');
      eq(S.rankProviders(S.measurementsOf(corrupt), ['peer:c'])[0].eligible, false, 'the corrupter');
      return 'one timeout or one bad chunk is enough';
    });

    test('a slow peer is never refused, only demoted — and that is deliberate', function () {
      var ledger = S.newLedger();
      ledger = S.noteRequest(ledger, 'peer:fast');
      ledger = S.noteDelivery(ledger, 'peer:fast', { admitted: true, bytes: 16, ticks: 1 });
      ledger = S.noteRequest(ledger, 'peer:slow');
      ledger = S.noteDelivery(ledger, 'peer:slow', { admitted: true, bytes: 16, ticks: 40 });
      var ranked = S.rankProviders(S.measurementsOf(ledger), ['peer:slow', 'peer:fast']);
      eq(ranked[0].peerId, 'peer:fast', 'the fast one first');
      eq(ranked[0].score, ranked[1].score, 'on identical scores');
      assert(ranked[1].meanTicks > ranked[0].meanTicks, 'separated by measured latency alone');
      eq(ranked[1].eligible, true, 'and the slow one is still eligible');
      return 'refusing on latency would refuse a weak radio, which is the ordinary case';
    });

    test('a ledger records claims and measurements in maps that never merge', function () {
      var ledger = S.noteAdvertisement(S.newLedger(), 'peer:x', [0, 1, 2, 2, -5, 'nine']);
      eq(JSON.stringify(ledger.claims['peer:x'].advertised), '[0,1,2]', 'claims are cleaned and deduped');
      eq(Object.keys(ledger.measured).length, 0, 'and nothing was measured by advertising');
      eq(S.measurementOf(ledger, 'peer:x').requested, 0, 'the measurement is still zero');
      var after = S.noteRequest(ledger, 'peer:x');
      eq(JSON.stringify(after.claims['peer:x'].advertised), '[0,1,2]', 'and measuring does not touch claims');
      eq(after.measured['peer:x'].requested, 1, 'the request was measured');
      return 'two maps, one direction';
    });

    test('a ledger belongs to one device: reputation is not shared', function () {
      var a = S.noteTimeout(S.noteRequest(S.newLedger(), 'peer:bad'), 'peer:bad', 8);
      var b = S.newLedger();
      eq(S.rankProviders(S.measurementsOf(a), ['peer:bad'])[0].eligible, false, 'device A has learned');
      eq(S.rankProviders(S.measurementsOf(b), ['peer:bad'])[0].eligible, true, 'device B has not');
      return 'a reputation arriving from a peer would be a claim, and claims are not acted on';
    });

    test('CRITERION 4: each of the three behaviours has a measured effect on completion', function () {
      var cmp = S.compareBehaviours({ deviceCount: 10, chunkCount: 32, chunkSize: 64 }, simOpts());
      eq(cmp.behaviours.length, 3, 'three behaviours');
      var byName = {};
      cmp.behaviours.forEach(function (b) { byName[b.behaviour] = b; });
      [S.BEHAVIOUR_WITHHOLD, S.BEHAVIOUR_SLOW, S.BEHAVIOUR_CORRUPT].forEach(function (name) {
        var row = byName[name];
        assert(row, name + ' must be measured');
        eq(row.completed, true, name + ' must still complete');
        assert(typeof row.extraTicksVsBaseline === 'number', name + ' must state an effect');
        eq(row.wrongChunksStored, 0, name + ' must put no wrong byte anywhere');
      });
      assert(cmp.baseline.completed, 'and the baseline completes');
      return 'baseline ' + cmp.baseline.ticksToComplete + ' ticks; +' +
        byName[S.BEHAVIOUR_CORRUPT].extraTicksVsBaseline + ' corrupt, +' +
        byName[S.BEHAVIOUR_WITHHOLD].extraTicksVsBaseline + ' withhold, +' +
        byName[S.BEHAVIOUR_SLOW].extraTicksVsBaseline + ' slow-drip (SIMULATION TICKS)';
    });

    test('the cost of a behaviour tracks how detectably wrong it is', function () {
      var cmp = S.compareBehaviours({ deviceCount: 10, chunkCount: 32, chunkSize: 64 }, simOpts());
      var by = {};
      cmp.behaviours.forEach(function (b) { by[b.behaviour] = b; });
      assert(by[S.BEHAVIOUR_CORRUPT].extraTicksVsBaseline <= by[S.BEHAVIOUR_WITHHOLD].extraTicksVsBaseline,
        'corruption is detected on arrival and must not cost more than a timeout does');
      assert(by[S.BEHAVIOUR_WITHHOLD].extraTicksVsBaseline < by[S.BEHAVIOUR_SLOW].extraTicksVsBaseline,
        'and a peer that is never wrong must be the expensive one');
      // The detection signatures are distinct, which is why the costs differ.
      assert(by[S.BEHAVIOUR_CORRUPT].chunksRejected > 0 && by[S.BEHAVIOUR_CORRUPT].chunksTimedOut === 0,
        'corruption shows up as rejections and no timeouts');
      assert(by[S.BEHAVIOUR_WITHHOLD].chunksTimedOut > 0 && by[S.BEHAVIOUR_WITHHOLD].chunksRejected === 0,
        'withholding shows up as timeouts and no rejections');
      eq(by[S.BEHAVIOUR_SLOW].chunksRejected, 0, 'and slow-drip shows up as neither');
      eq(by[S.BEHAVIOUR_SLOW].chunksTimedOut, 0, 'because it is never wrong');
      return 'corrupt ' + by[S.BEHAVIOUR_CORRUPT].chunksRejected + ' rejected, withhold ' +
        by[S.BEHAVIOUR_WITHHOLD].chunksTimedOut + ' timed out, slow 0 of either';
    });

    test('a hostile peer costs bandwidth and time and contributes no wrong byte', function () {
      var report = S.simulateSwarm({
        deviceCount: 10, chunkCount: 32, chunkSize: 64,
        peers: [
          { id: 'liar', behaviour: S.BEHAVIOUR_CORRUPT },
          { id: 'ghost', behaviour: S.BEHAVIOUR_WITHHOLD }
        ]
      }, simOpts());
      eq(report.completed, true, 'the fleet still completes');
      eq(report.audit.wrongChunksStored, 0, 'and no device stored a wrong chunk');
      eq(report.audit.receiversReassembledWrong, 0, 'and none reassembled a wrong artifact');
      eq(report.audit.receiversReassembledCorrectly, 10, 'all ten reassembled the source artifact');
      assert(report.chunksRejected > 0, 'the corrupter did deliver, and was refused');
      assert(report.chunksTimedOut > 0, 'and the withholder did waste requests');
      var corrupt = report.perProvider.filter(function (p) { return p.id === 'peer:liar'; })[0];
      eq(corrupt.bytesAccepted, 0, 'the corrupter contributed zero accepted bytes');
      return report.audit.chunksAudited + ' chunks re-digested independently, 0 wrong';
    });

    test('a slow but correct peer DOES contribute accepted data, and that is a peer being a transport', function () {
      var report = S.simulateSwarm({
        deviceCount: 10, chunkCount: 32, chunkSize: 64,
        peers: [{ id: 'molasses', behaviour: S.BEHAVIOUR_SLOW }]
      }, simOpts());
      assert(report.adversarial.bytesAccepted > 0,
        'its correct chunks were admitted, because they digest to the committed value');
      eq(report.audit.wrongChunksStored, 0, 'and none of them was wrong');
      assert(/transport/.test(report.adversarial.note), 'and the field says why it is not a failure');
      return report.adversarial.bytesAccepted + ' bytes accepted from a hostile peer, 0 of them wrong';
    });

    test('with no digest function the whole simulated fleet completes nothing', function () {
      var report = S.simulateSwarm({ deviceCount: 4, chunkCount: 8, chunkSize: 32 }, {});
      eq(report.completed, false, 'nothing completes');
      eq(report.audit.chunksAudited, 0, 'nothing was stored');
      assert(/could not be built|did not run/.test(report.note), 'and it says so: ' + report.note);
      return 'a check that cannot run refuses, at fleet scale too';
    });

    // =========================================================================
    // SOURCE TRAFFIC — measured directly (criterion 6)
    // =========================================================================

    test('CRITERION 6: the meter is written where the bytes leave the source', function () {
      var meter = S.meterSource();
      eq(meter.bytes, 0, 'starts empty');
      var body = S.serveFromSource(meter, alpha.bodies, 3);
      eq(meter.bytes, alpha.bodies[3].length, 'one chunk metered');
      eq(meter.responses, 1, 'one response');
      S.serveFromSource(meter, alpha.bodies, 3);
      eq(meter.bytes, alpha.bodies[3].length * 2, 'the SAME chunk twice counts twice on the link');
      eq(meter.distinctChunks.length, 1, 'and once in chunk accounting');
      assert(bytesEqual(body, alpha.bodies[3]), 'and the bytes came back');
      eq(S.serveFromSource(meter, alpha.bodies, 9999), null, 'an out-of-range index emits nothing');
      eq(meter.responses, 2, 'and meters nothing');
      return '2 responses, 1 distinct chunk — which is the gap';
    });

    test('CRITERION 6: the report carries the measurement and what inference would have claimed', function () {
      var report = S.simulateSwarm({ deviceCount: 10, chunkCount: 32, chunkSize: 64 }, simOpts());
      var src = report.source;
      eq(src.measuredDirectly, true, 'measured directly');
      assert(src.bytesMeasured > 0, 'and nonzero');
      assert(src.bytesMeasured !== src.bytesInferredFromChunkAccounting,
        'the two numbers must differ, or this test would not be testing anything');
      eq(src.inferenceUnderstatesByBytes, src.bytesMeasured - src.bytesInferredFromChunkAccounting,
        'and the gap is reported');
      return src.bytesMeasured + ' B measured vs ' + src.bytesInferredFromChunkAccounting +
        ' B inferred (SIMULATION)';
    });

    test('peer exchange is what reduces the source link, and the reduction is measured', function () {
      var report = S.simulateSwarm({ deviceCount: 10, chunkCount: 32, chunkSize: 64 }, simOpts());
      var pointToPoint = report.artifactBytes * report.fleetSizeSimulated;
      assert(report.source.bytesMeasured < pointToPoint,
        'the source must send less than point-to-point would');
      assert(report.source.ratioToArtifact < 3,
        'and under ADR-024 §2.1’s 3x target — IN SIMULATION');
      var fromPeers = report.receivers.reduce(function (n, r) { return n + r.acceptedFromPeers; }, 0);
      assert(fromPeers > 0, 'and peers must actually have carried chunks');
      return report.source.bytesMeasured + ' B measured vs ' + pointToPoint +
        ' B point-to-point (' + report.source.ratioToArtifact.toFixed(2) + '× the artifact) — ' +
        'a SIMULATION measurement, not a fleet one';
    });

    test('a hundred simulated devices: the ratio holds and every one verified for itself', function () {
      var report = S.simulateSwarm({
        deviceCount: 100, chunkCount: 64, chunkSize: 64, seed: 7
      }, simOpts());
      eq(report.completed, true, 'all hundred complete');
      eq(report.audit.receiversReassembledCorrectly, 100, 'and all hundred reassembled correctly');
      eq(report.audit.wrongChunksStored, 0, 'with no wrong chunk anywhere');
      assert(report.source.ratioToArtifact < 3, 'and the source stayed under 3x — IN SIMULATION');
      // And this is emphatically NOT Fleet-100.
      eq(report.physicalDevices, 0, 'no physical device was involved');
      eq(report.wallClockMeasured, false, 'and no wall clock was read');
      var fleet100 = S.describeCriteria().filter(function (c) { return c.id === 'fleet-100'; })[0];
      eq(fleet100.met, false, 'so criterion 2 is still not met after running this');
      return '100 simulated devices at ' + report.source.ratioToArtifact.toFixed(2) +
        '× — and criterion 2 remains unmet, because it needs 100 real ones';
    });

    // =========================================================================
    // THE BROADCAST CODEC — named accurately (criterion 5)
    // =========================================================================

    test('CRITERION 5: nothing this module emits says RaptorQ without saying it is not RFC 6330', function () {
      var report = S.simulateSwarm({ deviceCount: 3, chunkCount: 8, chunkSize: 32 }, simOpts());
      var cmp = S.compareBehaviours({ deviceCount: 3, chunkCount: 8, chunkSize: 32 }, simOpts());
      var sources = [
        S.describeBroadcastTier(), S.describeCriteria(), S.describeUnimplemented(),
        S.describeLimits(), report, cmp, S.BROADCAST_CODEC
      ];
      var mentions = 0;
      for (var i = 0; i < sources.length; i++) {
        var strings = reachable(sources[i]).strings;
        for (var j = 0; j < strings.length; j++) {
          if (strings[j].indexOf('RaptorQ') < 0) continue;
          mentions++;
          assert(strings[j].indexOf('NOT RFC 6330 conformant') >= 0,
            'a string mentions RaptorQ without the qualification: ' + strings[j].slice(0, 120));
        }
      }
      assert(mentions > 0, 'and the tier must actually be described somewhere');
      return mentions + ' mentions, every one qualified';
    });

    test('CRITERION 5: the broadcast tier reports itself as non-conformant and not wired in', function () {
      var tier = S.describeBroadcastTier();
      eq(tier.rfc6330Conformant, false, 'not conformant');
      eq(tier.interoperable, false, 'and interoperates with nothing');
      eq(tier.wiredIntoThisModule, false, 'and is not wired in here at all');
      eq(tier.module, 'artifacts/fountain.js', 'and names where it lives');
      assert(S.describeUnimplemented().some(function (u) {
        return u.id === 'broadcast-tier' && u.status === 'absent';
      }), 'and the unimplemented list agrees');
      return tier.codec;
    });

    // =========================================================================
    // HONESTY — what this build is not entitled to claim
    // =========================================================================

    test('criteria 1 and 2 are not met, and say they need physical devices', function () {
      var criteria = S.describeCriteria();
      eq(criteria.length, 6, 'all six are accounted for');
      var byId = {};
      criteria.forEach(function (c) { byId[c.id] = c; });
      ['fleet-10', 'fleet-100'].forEach(function (id) {
        eq(byId[id].met, false, id + ' is not met');
        eq(byId[id].status, 'requires-device-fleet', id + ' says why');
        assert(/PHYSICAL DEVICES/.test(byId[id].note), id + ' says it in the note too');
      });
      ['per-device-verification', 'malicious-peers-measured', 'broadcast-codec-named',
        'source-traffic-measured'].forEach(function (id) {
        eq(byId[id].met, true, id + ' is met');
      });
      return '4 of 6 met; 1 and 2 need a site and a wall clock';
    });

    test('no output anywhere is denominated in seconds, and every clock is a tick counter', function () {
      var report = S.simulateSwarm({ deviceCount: 5, chunkCount: 16, chunkSize: 32 }, simOpts());
      var cmp = S.compareBehaviours({ deviceCount: 5, chunkCount: 16, chunkSize: 32 }, simOpts());
      var keys = everyKey(report).concat(everyKey(cmp));
      for (var i = 0; i < keys.length; i++) {
        assert(!/second|Second|millis|Millis|_ms$|Ms$/.test(keys[i]),
          'a field is denominated in wall-clock time: ' + keys[i]);
      }
      eq(report.timingUnit, 'ticks', 'the unit is named');
      eq(report.wallClockMeasured, false, 'no wall clock was read');
      eq(report.physicalDevices, 0, 'and no physical device was involved');
      eq(cmp.wallClockMeasured, false, 'the comparison says the same');
      assert(keys.indexOf('ticksToComplete') >= 0, 'and the timings are named as ticks');
      assert(keys.indexOf('extraTicksVsBaseline') >= 0, 'including the differences');
      return keys.length + ' field names swept';
    });

    test('running ten simulated devices does not turn into a Fleet-10 result', function () {
      var report = S.simulateSwarm({ deviceCount: 10, chunkCount: 32, chunkSize: 64 }, simOpts());
      eq(report.fleetSizeSimulated, 10, 'ten devices were simulated');
      eq(report.completed, true, 'and it completed');
      eq(report.simulation, true, 'and the report leads with what it is');
      assert(/SIMULATION/.test(report.note), 'and says so in words');
      assert(/NOT measurements of any fleet/.test(report.note), 'and names what it is not');
      var fleet10 = S.describeCriteria().filter(function (c) { return c.id === 'fleet-10'; })[0];
      eq(fleet10.met, false, 'criterion 1 is still not met');
      assert(S.describeUnimplemented().some(function (u) {
        return u.id === 'device-fleet' && u.status === 'absent';
      }), 'and the device fleet is still absent');
      return 'a simulated ' + report.ticksToComplete + ' is not a measured 3 s or 60 s';
    });

    test('the honesty list names BitChat, the chunk store, custody receipts and interruption recovery', function () {
      var absent = {};
      S.describeUnimplemented().forEach(function (u) { absent[u.id] = u; });
      ['bitchat', 'chunk-store', 'custody-receipts', 'broadcast-tier', 'device-fleet',
        'interruption-recovery'].forEach(function (id) {
        assert(absent[id], id + ' must be listed');
        eq(absent[id].status, 'absent', id + ' is absent');
      });
      ['content-digest', 'manifest-signature'].forEach(function (id) {
        eq(absent[id].status, 'injected-absent', id + ' is injected');
      });
      assert(/no BitChat implementation in this repository/.test(absent.bitchat.note), 'and says so plainly');
      return Object.keys(absent).length + ' entries';
    });

    test('describeLimits does not drift from what the code does', function () {
      var limits = S.describeLimits();
      assert(limits.length >= 10, 'the list is not a stub');
      var joined = limits.join(' ');
      assert(/no function that can return admit:true takes a peer identity/.test(joined), 'the peer rule');
      assert(/NOT MET/.test(joined), 'and the criteria that are not met');
      assert(/tick counts are not seconds/.test(joined), 'and the units');
      // The claims the list makes are the claims the code makes.
      eq(S.normalizePolicy({ trustedPeers: ['x'] }).trustedSigners.length, 0, 'no peer trust exists');
      eq(S.describeCriteria().filter(function (c) { return c.met; }).length, 4, 'four criteria met');
      return limits.length + ' stated limits';
    });

    test('the receipt keeps "arrived" and "this device checked it" in separate named fields', function () {
      var r = anchored(alpha);
      for (var i = 0; i < alpha.bodies.length; i++) r = S.offerChunk(r, deliveryFor(alpha, i), OPTS).receiver;
      r = S.offerChunk(r, { artifactId: ALPHA, index: 0, bytes: beta.bodies[0] }, OPTS).receiver;
      var receipt = S.receiveReceipt(r);
      eq(receipt.complete, true, 'complete');
      eq(receipt.verifiedLocally, true, 'and separately, verified here');
      eq(receipt.manifestVerified, true, 'and the anchor is its own field');
      eq(receipt.rejectedTotal, 1, 'and the refusal is recorded');
      assert(/on this device/.test(receipt.summary), 'and the summary says where');
      var none = S.receiveReceipt('not a receiver');
      eq(none.verifiedLocally, false, 'a non-receiver verified nothing');
      eq(none.complete, false, 'and completed nothing');
      return receipt.summary.slice(0, 80) + '…';
    });

    test('a simulation is reproducible from its seed, and the seed is the only source of variation', function () {
      var cfg = { deviceCount: 8, chunkCount: 24, chunkSize: 48, seed: 1234 };
      var a = S.simulateSwarm(cfg, simOpts());
      var b = S.simulateSwarm(cfg, simOpts());
      eq(JSON.stringify(a), JSON.stringify(b), 'the same seed gives the same report');

      // The seed really does drive different draws...
      assert(S.seededRandom(1234)() !== S.seededRandom(4321)(), 'two seeds give two streams');

      // ...and a different seed is required to stay CORRECT, not to produce a
      // different report. This scheduling policy converges on the same tick and
      // byte counts under either draw at this size, and asserting otherwise
      // would be asserting a property the design does not have and does not
      // want: the point of the injected PRNG is reproducibility, not variety.
      var c = S.simulateSwarm({ deviceCount: 8, chunkCount: 24, chunkSize: 48, seed: 4321 }, simOpts());
      eq(c.completed, true, 'a different seed still completes');
      eq(c.audit.wrongChunksStored, 0, 'and is still correct');
      eq(c.audit.receiversReassembledCorrectly, 8, 'and every device still reassembles');
      return 'seed 1234 reproduces exactly; seed 4321 is equally correct (and, at this size, equally fast)';
    });

    test('every value the module hands back is frozen against edits after the fact', function () {
      var r = anchored(alpha);
      var out = S.offerChunk(r, deliveryFor(alpha, 0), OPTS);
      assert(Object.isFrozen(out.receiver), 'the receiver');
      assert(Object.isFrozen(S.advertise(out.receiver)), 'the advertisement');
      assert(Object.isFrozen(S.receiveReceipt(out.receiver)), 'the receipt');
      assert(Object.isFrozen(S.newLedger()), 'the ledger');
      var report = S.simulateSwarm({ deviceCount: 2, chunkCount: 4, chunkSize: 16 }, simOpts());
      assert(Object.isFrozen(report), 'and the report');
      var threw = false;
      try { 'use strict'; report.completed = false; } catch (e) { threw = true; }
      assert(threw || report.completed === true, 'a frozen report cannot be edited into a different one');
      return 'frozen';
    });

    test('hostile input never throws: junk in every position refuses instead', function () {
      var junk = [null, undefined, 0, '', 'text', [], { }, { index: 'x' }, { artifactId: 1 },
        { artifactId: ALPHA, index: -1, bytes: alpha.bodies[0] },
        { artifactId: ALPHA, index: 0, bytes: 'not bytes' },
        { artifactId: ALPHA, index: 0, bytes: alpha.bodies[0], digest: 'zz' }];
      var r = anchored(alpha);
      for (var i = 0; i < junk.length; i++) {
        var parsed = S.parseDelivery(junk[i]);
        assert(typeof parsed.ok === 'boolean', 'parseDelivery answers for input ' + i);
        var out = S.offerChunk(r, junk[i], OPTS);
        assert(out && out.decision && typeof out.decision.admit === 'boolean',
          'offerChunk answers for input ' + i);
        if (i < junk.length - 1) eq(out.decision.admit, false, 'and refuses input ' + i);
      }
      assert(!S.parseManifest(null).ok, 'and parseManifest refuses nothing');
      assert(!S.parseManifest('a string').ok, 'and a string');
      assert(!S.parseManifest({ artifactId: ALPHA, signerId: SIGNER, chunks: [] }).ok, 'and an empty list');
      assert(!S.buildManifest({}, {}).ok, 'and buildManifest refuses without a digest function');
      return junk.length + ' hostile inputs, 0 exceptions';
    });

    // =========================================================================
    // The composition that matters: real SHA-256 and real Ed25519
    // =========================================================================

    test('the whole pipeline under crypto.js’s real SHA-256 and real Ed25519', function () {
      var X = D.crypto;
      assert(X && typeof X.sha256 === 'function' && typeof X.signSync === 'function',
        'crypto.js must be supplied: this test is the one that runs the pipeline on real cryptography');

      var seed = new Uint8Array(32);
      for (var i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;
      var publicKey = X.publicKeyFromSeed(seed);
      var wrongSeed = new Uint8Array(32);
      for (var w = 0; w < 32; w++) wrongSeed[w] = (w * 11 + 5) & 0xff;

      function sha(bytes) { return X.toHex(X.sha256(bytes)); }
      function signWith(s, message) { return X.toHex(X.signSync(s, encode(message))); }

      var realOpts = {
        digest: sha,
        verifySignature: function (desc) {
          return X.verifySync(publicKey, encode(desc.message), X.fromHex(desc.signature));
        }
      };

      var payload = encode('a real firmware image, in miniature, repeated until it is worth chunking. ');
      var whole = new Uint8Array(payload.length * 6);
      for (var c = 0; c < 6; c++) whole.set(payload, c * payload.length);
      var built = S.buildManifest({
        artifactId: 'artifact-real', signerId: 'ed25519-fleet', bytes: whole, chunkSize: 64
      }, realOpts);
      assert(built.ok, 'the manifest builds under real SHA-256: ' + built.reason);

      var mBytes = encode(JSON.stringify(built.manifest));
      var mDigest = sha(mBytes);
      var root = { artifactId: 'artifact-real', signerId: 'ed25519-fleet', manifestDigest: mDigest };
      var offer = {
        artifactId: 'artifact-real', bytes: mBytes,
        signature: signWith(seed, S.manifestSigningString({
          artifactId: 'artifact-real', manifestDigest: mDigest
        }))
      };
      var policy = { acceptUnsignedManifest: false, trustedSigners: ['ed25519-fleet'] };

      // A manifest signed by the wrong key does not anchor.
      var forged = {
        artifactId: 'artifact-real', bytes: mBytes,
        signature: signWith(wrongSeed, S.manifestSigningString({
          artifactId: 'artifact-real', manifestDigest: mDigest
        }))
      };
      var bad = S.offerManifest(S.beginReceive(root, policy), forged, realOpts);
      eq(bad.verdict.state, S.STATE_FORGED, 'a real signature from the wrong key does not verify');

      // Ten devices, each verifying for itself.
      var complete = 0;
      for (var d = 0; d < 10; d++) {
        var r = S.beginReceive(root, policy);
        var anchoredOut = S.offerManifest(r, offer, realOpts);
        eq(anchoredOut.decision.admit, true, 'device ' + d + ' anchors: ' + anchoredOut.decision.reason);
        r = anchoredOut.receiver;
        // A chunk with one bit changed is refused by real SHA-256.
        var tampered = new Uint8Array(built.bodies[0].length);
        tampered.set(built.bodies[0]);
        tampered[7] ^= 1;
        var t = S.offerChunk(r, { artifactId: 'artifact-real', index: 0, bytes: tampered }, realOpts);
        eq(t.verdict.state, S.STATE_DIGEST_MISMATCH, 'device ' + d + ' refuses a one-bit change');
        for (var k = 0; k < built.bodies.length; k++) {
          var out = S.offerChunk(r, {
            artifactId: 'artifact-real', index: k, bytes: built.bodies[k]
          }, realOpts);
          eq(out.decision.admit, true, 'device ' + d + ' chunk ' + k + ': ' + out.decision.reason);
          r = out.receiver;
        }
        assert(bytesEqual(S.reassemble(r), whole), 'device ' + d + ' reassembles the artifact');
        complete++;
      }
      eq(complete, 10, 'all ten');

      // The honesty this test exists to keep attached to that result.
      assert(S.describeUnimplemented().some(function (u) {
        return u.id === 'manifest-signature' && /no ML-DSA-65/.test(u.note);
      }), 'and ADR-012 is still half-met');
      assert(S.describeCriteria().some(function (cr) {
        return cr.id === 'fleet-10' && cr.met === false;
      }), 'and ten software receivers are still not ten devices');
      return 'real SHA-256 and real Ed25519 across 10 receivers × ' + built.bodies.length +
        ' chunks — and no ML-DSA-65, so ADR-012 is half-met';
    });

    /** The injected checks a simulation runs with, including a real signer. */
    function simOpts() {
      return {
        digest: digestOf,
        sign: fakeSign,
        verifySignature: function (desc) { return desc.signature === fakeSign(desc.message); }
      };
    }

    return results;
  }

  function summarize(results) {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize };
});
