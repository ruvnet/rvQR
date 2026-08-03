/*!
 * rvQR provenance test suite — standalone.
 *
 * Node:    `node artifacts/provenance.test.js` — one line per test, non-zero
 *          exit on any failure.
 * Browser: load after provenance.js and call
 *          RVQRProvenanceTests.runAll(RVQRProvenance, deps).
 *
 * The interesting tests here are the ones that try to break the decoder, and
 * the one that hashes a component against the real demo container and expects a
 * FAIL when the bytes disagree. A provenance reader that accepts a wrong hash
 * quietly is worse than one that cannot read at all.
 *
 * SHA-256 comes from node:crypto rather than from the module under test, so the
 * byte-exactness assertions are made by something that has no stake in them.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module) {
      var P = require('./provenance.js');
      var crypto = require('crypto');
      var fs = require('fs');
      var path = require('path');
      var deps = {
        sha256: function (bytes) {
          return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
        },
        demo: (function () {
          var file = path.join(__dirname, 'demo', 'ruvnet-demo.rvf');
          try { return new Uint8Array(fs.readFileSync(file)); } catch (e) { return null; }
        })()
      };
      var results = api.runAll(P, deps);
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
    root.RVQRProvenanceTests = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function concat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }

  function runAll(P, deps) {
    var results = [];
    var sha256 = deps && deps.sha256;
    var demo = deps && deps.demo;

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

    // --- fixtures -------------------------------------------------------------

    // A fully populated provenance: every block present, nothing implied.
    function populated() {
      return {
        subject: {
          name: 'ruvnet-demo.rvf',
          uri: 'rvf:ruvnet-demo',
          digest: { sha256: 'a'.repeat(64) }
        },
        sbom: {
          present: true,
          components: [
            {
              name: 'rvf-microkernel', version: '0.1.9', purpose: 'library',
              uri: 'pkg:cargo/rvf-wasm@0.1.9', mediaType: 'application/wasm',
              digest: { sha256: 'b'.repeat(64) },
              licences: ['MIT', 'Apache-2.0'], segment: 1
            },
            {
              name: 'demo-vectors', version: '1', purpose: 'data',
              digest: { sha256: 'c'.repeat(64) }, licences: ['CC0-1.0'], segment: 2
            }
          ]
        },
        licences: { present: true, artifact: ['Apache-2.0', 'MIT'], expression: 'MIT OR Apache-2.0' },
        signerPolicy: {
          present: true, requiredSigners: 1,
          keys: [
            { id: 'release@ruv.net', algorithm: 'ml-dsa-65', publicKey: 'AAECAwQ=', maySign: ['manifest', 'provenance'] },
            { id: 'ci@ruv.net', algorithm: 'ed25519', publicKey: 'BQYHCAk=', maySign: ['payload'] }
          ]
        },
        source: {
          present: true, repository: 'git+https://github.com/ruvnet/ruvector',
          commit: '0'.repeat(40), ref: 'refs/heads/main'
        },
        build: {
          present: true, builder: 'https://github.com/ruvnet/ruvector/.github/workflows/build.yml',
          buildType: 'https://slsa.dev/container-based-build/v0.1',
          invocationId: 'run-12345', startedOn: '2026-08-03T09:00:00Z',
          finishedOn: '2026-08-03T09:04:31Z', reproducible: true
        },
        vulnerabilities: {
          present: true,
          assertions: [
            {
              advisory: 'CVE-2026-0001', component: 'rvf-microkernel', status: 'not_affected',
              justification: 'vulnerable_code_not_in_execute_path',
              statement: 'The affected entry point is never reached by this build.'
            },
            { advisory: 'GHSA-xxxx-yyyy-zzzz', component: 'demo-vectors', status: 'fixed' }
          ]
        }
      };
    }

    // The minimum that is still a provenance document: nothing present at all.
    function minimal() {
      return P.emptyProvenance();
    }

    // --- canonical encoding ---------------------------------------------------

    test('provenance: canonical encoding is byte-identical across key reordering', function () {
      var a = populated();
      // The same claims, with every object's keys written in a different order.
      var b = {
        vulnerabilities: a.vulnerabilities,
        build: {
          reproducible: a.build.reproducible, finishedOn: a.build.finishedOn,
          startedOn: a.build.startedOn, invocationId: a.build.invocationId,
          buildType: a.build.buildType, builder: a.build.builder, present: true
        },
        source: { ref: a.source.ref, commit: a.source.commit, repository: a.source.repository, present: true },
        signerPolicy: a.signerPolicy,
        licences: { expression: a.licences.expression, artifact: ['MIT', 'Apache-2.0'], present: true },
        sbom: a.sbom,
        subject: { digest: a.subject.digest, uri: a.subject.uri, name: a.subject.name }
      };
      var ea = P.encode(a);
      var eb = P.encode(b);
      assert(bytesEqual(ea, eb), 'reordered keys produced different bytes');
      if (sha256) {
        var ha = sha256(ea), hb = sha256(eb);
        eq(ha, hb, 'sha256 of the two encodings');
        return ea.length + ' bytes, sha256 ' + ha.slice(0, 16) + '…';
      }
      return ea.length + ' bytes identical';
    });

    test('provenance: re-encoding a decoded document reproduces the same bytes', function () {
      var first = P.encode(populated());
      var decoded = P.decode(first);
      assert(decoded.ok, 'decode failed: ' + decoded.reason);
      var second = P.encode(decoded.provenance);
      assert(bytesEqual(first, second), 'round trip was not byte-stable');
      assert(decoded.canonical, 'decoder did not recognise its own encoding as canonical');
      if (sha256) return 'sha256 ' + sha256(first).slice(0, 16) + '… both ways';
      return first.length + ' bytes both ways';
    });

    test('provenance: canonicalJson sorts keys and emits no whitespace', function () {
      var text = P.canonicalJson({ b: 1, a: { d: [3, 2], c: 'x' } });
      eq(text, '{"a":{"c":"x","d":[3,2]},"b":1}', 'canonical form');
      return text;
    });

    test('provenance: canonicalJson refuses floats and non-finite numbers', function () {
      var refused = 0;
      [1.5, Infinity, NaN, -Infinity].forEach(function (n) {
        try { P.canonicalJson({ n: n }); } catch (e) { refused++; }
      });
      eq(refused, 4, 'refusals');
      return '4/4 refused';
    });

    // --- round trips ----------------------------------------------------------

    test('provenance: full round trip preserves every block', function () {
      var input = populated();
      var decoded = P.decode(P.encode(input));
      assert(decoded.ok, 'decode failed: ' + decoded.reason);
      var p = decoded.provenance;
      eq(p.subject.name, 'ruvnet-demo.rvf', 'subject name');
      eq(p.subject.digest.sha256, 'a'.repeat(64), 'subject digest');
      eq(p.sbom.present, true, 'sbom present');
      eq(p.sbom.components.length, 2, 'component count');
      eq(p.sbom.components[0].name, 'rvf-microkernel', 'component 0 name');
      eq(p.sbom.components[0].version, '0.1.9', 'component 0 version');
      eq(p.sbom.components[0].purpose, 'library', 'component 0 purpose');
      eq(p.sbom.components[0].segment, 1, 'component 0 segment');
      eq(p.sbom.components[0].licences.join(','), 'Apache-2.0,MIT', 'component 0 licences (sorted)');
      eq(p.licences.present, true, 'licences present');
      eq(p.licences.artifact.join(','), 'Apache-2.0,MIT', 'artifact licences');
      eq(p.licences.expression, 'MIT OR Apache-2.0', 'licence expression');
      eq(p.signerPolicy.present, true, 'signer policy present');
      eq(p.signerPolicy.requiredSigners, 1, 'required signers');
      eq(p.signerPolicy.keys.length, 2, 'signer keys');
      eq(p.signerPolicy.keys[0].maySign.join(','), 'manifest,provenance', 'key 0 scopes');
      eq(p.source.present, true, 'source present');
      eq(p.source.repository, 'git+https://github.com/ruvnet/ruvector', 'repository');
      eq(p.source.commit, '0'.repeat(40), 'commit');
      eq(p.source.ref, 'refs/heads/main', 'ref');
      eq(p.build.present, true, 'build present');
      eq(p.build.builder, input.build.builder, 'builder');
      eq(p.build.buildType, input.build.buildType, 'buildType');
      eq(p.build.invocationId, 'run-12345', 'invocationId');
      eq(p.build.startedOn, '2026-08-03T09:00:00Z', 'startedOn');
      eq(p.build.reproducible, true, 'reproducible');
      eq(p.vulnerabilities.present, true, 'vulnerabilities present');
      eq(p.vulnerabilities.assertions.length, 2, 'assertion count');
      eq(p.vulnerabilities.assertions[0].status, 'not_affected', 'assertion 0 status');
      eq(p.vulnerabilities.assertions[0].justification, 'vulnerable_code_not_in_execute_path', 'assertion 0 justification');
      return '6 blocks + subject, ' + P.encode(input).length + ' bytes';
    });

    test('provenance: minimal round trip carries six explicit absences', function () {
      var bytes = P.encode(minimal());
      var decoded = P.decode(bytes);
      assert(decoded.ok, 'decode failed: ' + decoded.reason);
      var p = decoded.provenance;
      eq(p.sbom.present, false, 'sbom');
      eq(p.licences.present, false, 'licences');
      eq(p.signerPolicy.present, false, 'signerPolicy');
      eq(p.source.present, false, 'source');
      eq(p.build.present, false, 'build');
      eq(p.vulnerabilities.present, false, 'vulnerabilities');
      eq(p.subject, null, 'subject');
      // Absence is written down, not inferred from a missing field.
      var present = decoded.document.present;
      eq(Object.keys(present).length, 6, 'present map size');
      Object.keys(present).forEach(function (k) { eq(present[k], false, 'present.' + k); });
      return bytes.length + ' bytes, all six stated false';
    });

    test('provenance: an SBOM without a build carries its components outside the statement', function () {
      var p = P.emptyProvenance();
      p.sbom = { present: true, components: [{ name: 'lib', version: '1.0.0', digest: { sha256: 'd'.repeat(64) } }] };
      var decoded = P.decode(P.encode(p));
      assert(decoded.ok, 'decode failed: ' + decoded.reason);
      eq(decoded.document.statement, undefined, 'no SLSA statement without a build');
      assert(decoded.document.rvqr && decoded.document.rvqr.components, 'components must live under rvqr');
      eq(decoded.provenance.sbom.components[0].name, 'lib', 'component survived');
      return 'components under rvqr, statement omitted';
    });

    // --- SLSA shape -----------------------------------------------------------

    test('provenance: the extracted statement is SLSA v1.2 shaped', function () {
      var decoded = P.decode(P.encode(populated()));
      var st = P.extractStatement(decoded);
      assert(st, 'no statement extracted');
      eq(st._type, 'https://in-toto.io/Statement/v1', '_type');
      eq(st.predicateType, 'https://slsa.dev/provenance/v1', 'predicateType');
      assert(Array.isArray(st.subject) && st.subject.length === 1, 'subject array');
      var bd = st.predicate.buildDefinition;
      var rd = st.predicate.runDetails;
      assert(bd.buildType && typeof bd.buildType === 'string', 'buildDefinition.buildType');
      assert(bd.externalParameters && bd.externalParameters.source, 'externalParameters.source');
      eq(bd.externalParameters.source.digest.gitCommit, '0'.repeat(40), 'source gitCommit');
      assert(Array.isArray(bd.resolvedDependencies) && bd.resolvedDependencies.length === 2, 'resolvedDependencies');
      assert(rd.builder && rd.builder.id, 'runDetails.builder.id');
      eq(rd.metadata.invocationId, 'run-12345', 'runDetails.metadata.invocationId');
      // The rvQR-only claims stay out of the predicate, so a strict SLSA
      // verifier sees nothing it does not recognise.
      eq(st.predicate.rvqr, undefined, 'no rvqr key inside the predicate');
      eq(st.predicate.licences, undefined, 'no licences inside the predicate');
      eq(st.predicate.vulnerabilities, undefined, 'no vulnerabilities inside the predicate');
      return 'buildDefinition + runDetails, extensions kept outside';
    });

    // --- SPDX -----------------------------------------------------------------

    test('provenance: SPDX identifier validation accepts ids, refs and sentinels', function () {
      ['MIT', 'Apache-2.0', 'GPL-2.0-or-later', 'BSD-3-Clause', 'CC-BY-SA-4.0', '0BSD',
        'NONE', 'NOASSERTION', 'LicenseRef-rvqr-internal',
        'DocumentRef-spdx-tool:LicenseRef-x'].forEach(function (id) {
          assert(P.isValidSpdxId(id), id + ' should be valid');
        });
      ['', 'MIT OR Apache-2.0', 'MIT AND GPL-3.0-only', '-MIT', 'MIT--0', 'MIT/X11',
        'a b', 'LicenseRef', 'x'.repeat(200), null, 42, {}].forEach(function (id) {
          assert(!P.isValidSpdxId(id), JSON.stringify(id) + ' should be rejected');
        });
      assert(P.isKnownSpdxId('MIT') && !P.isKnownSpdxId('LicenseRef-rvqr-internal'),
        'registry membership is separate from syntax');
      return '10 accepted, 12 rejected';
    });

    test('provenance: an invalid SPDX id is refused at encode', function () {
      var p = P.emptyProvenance();
      p.licences = { present: true, artifact: ['MIT OR Apache-2.0'], expression: null };
      var v = P.validate(p);
      assert(!v.ok, 'validate should have failed');
      assert(/SPDX/.test(v.errors.join(' ')), 'error should name SPDX: ' + v.errors.join('; '));
      var threw = false;
      try { P.encode(p); } catch (e) { threw = true; }
      assert(threw, 'encode should throw on an invalid licence id');
      return v.errors[0];
    });

    test('provenance: a VEX not_affected without a justification is refused', function () {
      var p = P.emptyProvenance();
      p.vulnerabilities = {
        present: true,
        assertions: [{ advisory: 'CVE-2026-9999', component: 'x', status: 'not_affected' }]
      };
      var v = P.validate(p);
      assert(!v.ok, 'validate should have failed');
      assert(/justification/.test(v.errors.join(' ')), 'error should demand a justification');
      return v.errors[0];
    });

    // --- hostile input --------------------------------------------------------

    test('provenance: hostile payloads are refused without throwing', function () {
      var good = P.encode(populated());
      var cases = [];

      function add(name, bytes) { cases.push({ name: name, bytes: bytes }); }

      add('empty', new Uint8Array(0));
      add('header only', good.subarray(0, P.DOC_HEADER_SIZE));
      add('truncated header', good.subarray(0, 7));
      add('truncated document', good.subarray(0, good.length - 40));
      add('wrong magic', (function () { var b = good.slice(); b[0] = 0x00; return b; })());
      add('future version', (function () { var b = good.slice(); b[4] = 9; return b; })());
      add('undefined flag bits', (function () { var b = good.slice(); b[5] = 0xff; return b; })());
      add('reserved bytes set', (function () { var b = good.slice(); b[6] = 1; return b; })());
      add('absurd declared length', (function () {
        var b = good.slice();
        new DataView(b.buffer).setUint32(8, 0xffffffff, true);
        return b;
      })());
      add('length past the payload', (function () {
        var b = good.slice();
        new DataView(b.buffer).setUint32(8, good.length, true);
        return b;
      })());
      add('trailing slack', concat([good, new Uint8Array(8)]));
      add('invalid utf-8', (function () {
        var b = good.slice();
        b[P.DOC_HEADER_SIZE + 2] = 0xff;
        return b;
      })());

      // Documents that parse as JSON but describe something absurd.
      function docBytes(text) {
        var body = new TextEncoder().encode(text);
        var out = new Uint8Array(P.DOC_HEADER_SIZE + body.length);
        out.set(P.DOC_MAGIC, 0);
        out[4] = P.DOC_VERSION;
        new DataView(out.buffer).setUint32(8, body.length, true);
        out.set(body, P.DOC_HEADER_SIZE);
        return out;
      }

      add('not JSON', docBytes('{not json'));
      add('not an object', docBytes('[1,2,3]'));
      add('wrong document version', docBytes('{"rvqrProvenance":99,"present":{}}'));
      add('missing present map', docBytes('{"rvqrProvenance":1}'));
      add('implied absence', docBytes('{"present":{"sbom":false},"rvqrProvenance":1}'));
      add('deeply nested', docBytes('{"rvqrProvenance":1,"present":' + '['.repeat(4000) + ']'.repeat(4000) + '}'));
      add('absurd component count', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: true, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        rvqr: { components: new Array(5000).join('.').split('.').map(function () { return { name: 'x' }; }) }
      })));
      add('oversized string', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: true, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        rvqr: { components: [{ name: 'x'.repeat(100000) }] }
      })));
      add('absurd segment index', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: true, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        rvqr: { components: [{ name: 'x', annotations: { 'rvqr.dev/segment': 4294967295 } }] }
      })));
      add('bad digest length', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: true, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        rvqr: { components: [{ name: 'x', digest: { sha256: 'ab' } }] }
      })));
      add('unknown digest algorithm', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: true, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        rvqr: { components: [{ name: 'x', digest: { md5: 'ab' } }] }
      })));
      add('statement without a build', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: false, licences: false, signerPolicy: false, source: false, build: false, vulnerabilities: false },
        statement: { _type: 'https://in-toto.io/Statement/v1' }
      })));
      add('more signers required than keys', docBytes(P.canonicalJson({
        rvqrProvenance: 1,
        present: { sbom: false, licences: false, signerPolicy: true, source: false, build: false, vulnerabilities: false },
        rvqr: { signerPolicy: { requiredSigners: 9, keys: [{ id: 'a', algorithm: 'ed25519', maySign: ['any'] }] } }
      })));
      add('null bytes', new Uint8Array(512));

      var refused = [];
      for (var i = 0; i < cases.length; i++) {
        var r;
        try {
          r = P.decode(cases[i].bytes);
        } catch (err) {
          throw new Error(cases[i].name + ' threw instead of refusing: ' + err.message);
        }
        if (r.ok) throw new Error(cases[i].name + ' was accepted');
        if (typeof r.reason !== 'string' || !r.reason.length) {
          throw new Error(cases[i].name + ' refused without a reason');
        }
        refused.push(cases[i].name);
      }
      return refused.length + ' hostile payloads refused with a reason';
    });

    test('provenance: a non-canonical but valid document decodes and is flagged', function () {
      // Same claims, keys out of order and with whitespace — readable, but not
      // the one encoding a hash can be taken over.
      var text = '{ "present": {"build":false,"licences":false,"signerPolicy":false,' +
        '"sbom":false,"source":false,"vulnerabilities":false}, "rvqrProvenance": 1 }';
      var body = new TextEncoder().encode(text);
      var bytes = new Uint8Array(P.DOC_HEADER_SIZE + body.length);
      bytes.set(P.DOC_MAGIC, 0);
      bytes[4] = P.DOC_VERSION;
      new DataView(bytes.buffer).setUint32(8, body.length, true);
      bytes.set(body, P.DOC_HEADER_SIZE);
      var decoded = P.decode(bytes);
      assert(decoded.ok, 'a valid document should still decode: ' + decoded.reason);
      eq(decoded.canonical, false, 'canonical flag');
      return 'decoded, canonical=false';
    });

    test('provenance: jsonDepth stops counting past the limit', function () {
      assert(P.jsonDepth('{"a":1}') === 1, 'flat object');
      assert(P.jsonDepth('{"a":{"b":[1]}}') === 3, 'three levels');
      assert(P.jsonDepth('"{{{{{{{{{{"') === 0, 'braces inside a string do not count');
      assert(P.jsonDepth('"\\""') === 0, 'escaped quote does not open a string');
      assert(P.jsonDepth('['.repeat(1000)) > P.LIMITS.depth, 'deep nesting exceeds the limit');
      return 'depth limit ' + P.LIMITS.depth;
    });

    // --- the real container ---------------------------------------------------

    test('provenance: the demo container walks and reports as unprovenanced', function () {
      assert(demo, 'demo/ruvnet-demo.rvf was not readable');
      eq(demo.length, 2304, 'demo size');
      var table = P.readSegmentTable(demo);
      assert(table.ok, 'segment walk failed: ' + table.reason);
      eq(table.segments.length, 4, 'segment count');
      eq(table.segments.map(function (s) { return s.type; }).join(','), '5,1,10,5', 'segment types');
      eq(table.segments[1].size, 1734, 'Vec payload size');
      var read = P.readContainer(demo);
      eq(read.provenanced, false, 'provenanced');
      eq(read.ok, true, 'the walk itself succeeded');
      assert(/no provenance segment/.test(read.reason), 'reason: ' + read.reason);
      // Unprovenanced must never render as a pass.
      var report = P.verify(read.provenance, demo, { sha256: sha256 });
      eq(report.provenanced, false, 'report.provenanced');
      eq(report.checksPassed, 0, 'nothing passed');
      eq(report.checkable[0].status, 'unavailable', 'status');
      return '4 segments, unprovenanced reported as its own state';
    });

    test('provenance: a provenance segment appended to the demo container round trips', function () {
      assert(demo, 'demo container missing');
      var p = P.emptyProvenance();
      p.subject = { name: 'ruvnet-demo.rvf', digest: { sha256: sha256(demo) } };
      var seg = P.encodeSegment(p, 4);
      var container = concat([demo, seg]);
      var table = P.readSegmentTable(container);
      assert(table.ok, 'walk failed: ' + table.reason);
      eq(table.segments.length, 5, 'segment count');
      eq(table.segments[4].type, P.PROVENANCE_SEGMENT_TYPE, 'appended segment type');
      var read = P.readContainer(container);
      eq(read.provenanced, true, 'provenanced');
      eq(read.ok, true, 'decode: ' + read.reason);
      eq(read.provenance.subject.name, 'ruvnet-demo.rvf', 'subject survived the container');
      // An older reader that does not know the type must still walk past it.
      eq(table.segments[0].type, 5, 'the original segments are undisturbed');
      eq(table.trailing, 0, 'no unaccounted bytes');
      return container.length + ' bytes, ' + seg.length + ' of provenance';
    });

    test('provenance: checkable and asserted claims are reported separately', function () {
      assert(demo && sha256, 'demo container and sha256 required');
      var table = P.readSegmentTable(demo);
      var vecPayload = demo.subarray(table.segments[1].payloadOffset,
        table.segments[1].payloadOffset + table.segments[1].size);
      var witnessPayload = demo.subarray(table.segments[2].payloadOffset,
        table.segments[2].payloadOffset + table.segments[2].size);

      var p = populated();
      // Bind two components to real segments with their real hashes.
      p.sbom.components[0] = {
        name: 'demo-vectors', version: '1', purpose: 'data',
        digest: { sha256: sha256(vecPayload) }, licences: ['CC0-1.0'], segment: 1
      };
      p.sbom.components[1] = {
        name: 'demo-witness', version: '1', purpose: 'data',
        digest: { sha256: sha256(witnessPayload) }, licences: ['LicenseRef-rvqr-demo'], segment: 2
      };
      var decoded = P.decode(P.encode(p));
      assert(decoded.ok, 'decode: ' + decoded.reason);
      var report = P.verify(decoded.provenance, demo, { sha256: sha256 });

      var names = report.checkable.map(function (c) { return c.name + '=' + c.status; });
      assert(report.checksFailed === 0, 'unexpected failures: ' + names.join(', '));
      assert(report.checksPassed >= 2, 'expected both component hashes to pass: ' + names.join(', '));
      eq(report.ok, true, 'report.ok');

      // Everything only the builder can vouch for must be on the other list.
      var asserted = report.asserted.map(function (a) { return a.name; });
      ['Builder', 'Build type', 'Reproducible', 'Source revision', 'Licences', 'Signer policy']
        .forEach(function (n) {
          assert(asserted.indexOf(n) >= 0, n + ' should be an assertion, not a check');
        });
      assert(asserted.filter(function (n) { return /^Vulnerability /.test(n); }).length === 2,
        'both VEX assertions should be asserted');

      // And none of them may appear as a check.
      var checkNames = report.checkable.map(function (c) { return c.name; });
      ['Builder', 'Reproducible', 'Source revision', 'Signer policy'].forEach(function (n) {
        assert(checkNames.indexOf(n) < 0, n + ' must never be reported as a check');
      });
      // The reproducibility claim is carried with an author, not as a fact.
      var repro = report.asserted.filter(function (a) { return a.name === 'Reproducible'; })[0];
      eq(repro.value, true, 'reproducible value');
      assert(repro.vouchedBy === p.build.builder, 'reproducible must name who vouches for it');

      // An unlisted-but-valid SPDX id is surfaced as unavailable, not as a pass.
      var spdx = report.checkable.filter(function (c) { return /^SPDX identifier/.test(c.name); });
      assert(spdx.length === 0 || spdx.every(function (c) { return c.status === 'unavailable'; }),
        'unknown SPDX ids must not be reported as passing');

      return report.checksPassed + ' checkable passes, ' + report.asserted.length + ' assertions';
    });

    test('provenance: a component hash that disagrees with the container fails the check', function () {
      assert(demo && sha256, 'demo container and sha256 required');
      var table = P.readSegmentTable(demo);
      var vecPayload = demo.subarray(table.segments[1].payloadOffset,
        table.segments[1].payloadOffset + table.segments[1].size);
      var real = sha256(vecPayload);
      // Flip one hex character: the same length, the same shape, the wrong bytes.
      var wrong = (real[0] === 'f' ? '0' : 'f') + real.slice(1);

      var p = P.emptyProvenance();
      p.sbom = {
        present: true,
        components: [{ name: 'demo-vectors', version: '1', digest: { sha256: wrong }, segment: 1 }]
      };
      var decoded = P.decode(P.encode(p));
      assert(decoded.ok, 'decode: ' + decoded.reason);
      var report = P.verify(decoded.provenance, demo, { sha256: sha256 });
      var hit = report.checkable.filter(function (c) { return /^Component hash/.test(c.name); })[0];
      assert(hit, 'no component hash check was produced');
      eq(hit.status, 'fail', 'status');
      eq(report.checksFailed, 1, 'failed check count');
      eq(report.ok, false, 'report.ok must be false when a hash disagrees');
      assert(/not the one described/.test(hit.detail), 'detail should say what is wrong: ' + hit.detail);

      // The same provenance with the real hash passes, so the failure above is
      // the mismatch and not the plumbing.
      var q = P.emptyProvenance();
      q.sbom = {
        present: true,
        components: [{ name: 'demo-vectors', version: '1', digest: { sha256: real }, segment: 1 }]
      };
      var good = P.verify(P.decode(P.encode(q)).provenance, demo, { sha256: sha256 });
      eq(good.checksFailed, 0, 'the matching hash must pass');
      eq(good.checksPassed, 2, 'hash check plus segment chain');
      return 'mismatch failed, match passed';
    });

    test('provenance: a component naming a segment that is not there fails rather than passes', function () {
      assert(demo && sha256, 'demo container required');
      var p = P.emptyProvenance();
      p.sbom = {
        present: true,
        components: [{ name: 'ghost', digest: { sha256: 'e'.repeat(64) }, segment: 99 }]
      };
      var report = P.verify(P.decode(P.encode(p)).provenance, demo, { sha256: sha256 });
      var hit = report.checkable.filter(function (c) { return /^Component hash/.test(c.name); })[0];
      eq(hit.status, 'fail', 'status');
      assert(/only 4 segments/.test(hit.detail), 'detail: ' + hit.detail);
      return hit.detail;
    });

    test('provenance: without a hash function, hash claims read unavailable rather than pass', function () {
      assert(demo, 'demo container required');
      var p = P.emptyProvenance();
      p.sbom = {
        present: true,
        components: [{ name: 'demo-vectors', digest: { sha256: 'f'.repeat(64) }, segment: 1 }]
      };
      var report = P.verify(P.decode(P.encode(p)).provenance, demo, {});
      var hit = report.checkable.filter(function (c) { return /^Component hash/.test(c.name); })[0];
      eq(hit.status, 'unavailable', 'status');
      eq(report.checksPassed, 1, 'only the segment chain may pass');
      assert(/No SHA-256/.test(hit.detail), 'detail: ' + hit.detail);
      return hit.detail.slice(0, 60) + '…';
    });

    test('provenance: mutating one provenance byte changes the segment hash', function () {
      assert(sha256, 'sha256 required');
      var bytes = P.encode(populated());
      var before = sha256(bytes);
      var mutated = bytes.slice();
      mutated[P.DOC_HEADER_SIZE + 20] = mutated[P.DOC_HEADER_SIZE + 20] ^ 0x01;
      var after = sha256(mutated);
      assert(before !== after, 'a mutated byte must change the hash');
      // And the mutation is not silently readable as the same claims.
      var d1 = P.decode(bytes);
      var d2 = P.decode(mutated);
      assert(d1.ok, 'original should decode');
      assert(!d2.ok || P.canonicalJson(d1.document) !== P.canonicalJson(d2.document),
        'a mutated document must not decode to the same claims');
      return before.slice(0, 12) + '… vs ' + after.slice(0, 12) + '…';
    });

    test('provenance: byte cost on the demo container is measured, not assumed', function () {
      assert(demo, 'demo container required');
      var full = P.encodeSegment(populated(), 4);
      var min = P.encodeSegment(minimal(), 4);
      var pct = Math.round((full.length / demo.length) * 1000) / 10;
      // No pass/fail threshold here on purpose — ADR-020 asks for the number to
      // be reported, and on a 2 KB container it is the dominant term.
      assert(full.length > min.length, 'a populated segment must be larger than an empty one');
      return 'populated ' + full.length + ' B (' + pct + '% of the 2304 B demo), minimal ' + min.length + ' B';
    });

    test('provenance: describeLimits refuses to overclaim', function () {
      var limits = P.describeLimits();
      assert(limits.length >= 4, 'expected several limits');
      var joined = limits.join(' ');
      assert(/never that what it says is true/.test(joined), 'must say a signature is not truth');
      assert(/unprovenanced/i.test(joined), 'must name the unprovenanced state');
      assert(/not the decision/.test(joined), 'must say provenance does not gate');
      return limits.length + ' stated limits';
    });

    return results;
  }

  function summarize(results) {
    var passed = 0;
    results.forEach(function (r) { if (r.ok) passed++; });
    return { total: results.length, passed: passed, failed: results.length - passed };
  }

  return { runAll: runAll, summarize: summarize, hex: hex, bytesEqual: bytesEqual };
});
