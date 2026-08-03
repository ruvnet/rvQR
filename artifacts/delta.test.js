/*!
 * rvQR delta + resume test suite.
 *
 * Node only, because these tests need the real RVF microkernel wasm and the
 * real demo container off disk: `node artifacts/delta.test.js`. One line per
 * test, non-zero exit on any failure — same shape as artifacts/tests.js.
 *
 * The delta tests run against artifacts/demo/ruvnet-demo.rvf parsed by
 * artifacts/demo/rvf_wasm_bg.wasm, so the segment boundaries under test are the
 * ones the shipped parser actually reports, not ones this suite invented.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('./core.js');
var qrlib = require('./vendor/qrcode.js');
var delta = require('./delta.js');
var resume = require('./resume.js');

var DEMO_DIR = path.join(__dirname, 'demo');
var DEMO_RVF = path.join(DEMO_DIR, 'ruvnet-demo.rvf');
var DEMO_WASM = path.join(DEMO_DIR, 'rvf_wasm_bg.wasm');

// --- Harness ----------------------------------------------------------------

var results = [];
var queue = [];

function test(name, fn) {
  queue.push({ name: name, fn: fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'expected') + ': got ' + actual + ', want ' + expected);
  }
}

function assertThrows(reason, fn, msg) {
  var caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert(caught, (msg || 'expected a rejection') + ', nothing was thrown');
  assertEqual(caught.reason, reason, msg || 'rejection reason');
  return caught;
}

function assertRejects(reason, promise, msg) {
  return promise.then(
    function () { throw new Error((msg || 'expected a rejection') + ', it resolved'); },
    function (e) {
      assertEqual(e.reason, reason, msg || 'rejection reason');
      return e;
    }
  );
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Deterministic pseudo-random bytes so failures are reproducible.
var seed = 0x51d3e7a;
function rndBytes(n) {
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
}

// --- Synthetic RVF containers ----------------------------------------------
// A 64-byte segment header per ADR-009: little-endian magic 53 46 56 52,
// version 1, type, flags, then the segment id and payload length as u64s.

function segmentHeader(type, segId, payloadLength) {
  var h = new Uint8Array(64);
  h.set([0x53, 0x46, 0x56, 0x52], 0);
  h[4] = 1;
  h[5] = type;
  h[8] = segId & 0xff;
  h[9] = (segId >>> 8) & 0xff;
  h[16] = payloadLength & 0xff;
  h[17] = (payloadLength >>> 8) & 0xff;
  h[18] = (payloadLength >>> 16) & 0xff;
  h[19] = (payloadLength >>> 24) & 0xff;
  return h;
}

/** specs: [{ type, payload }] -> a container both parsers enumerate. */
function makeContainer(specs) {
  var total = specs.reduce(function (n, s) { return n + 64 + s.payload.length; }, 0);
  var out = new Uint8Array(total);
  var at = 0;
  for (var i = 0; i < specs.length; i++) {
    out.set(segmentHeader(specs[i].type, i + 1, specs[i].payload.length), at);
    out.set(specs[i].payload, at + 64);
    at += 64 + specs[i].payload.length;
  }
  return out;
}

function spanList(entries) {
  return entries.map(function (e, i) {
    return { kind: 1, index: i, type: 1, length: e.length, hash: e.hash };
  });
}

// --- Delta tests ------------------------------------------------------------

function registerDeltaTests(ctx) {
  var demo = ctx.demo;
  var parser = ctx.parser;

  test('wasm microkernel instantiates with zero imports and parses the demo container', function () {
    assertEqual(WebAssembly.Module.imports(ctx.module).length, 0, 'import count');
    var index = delta.segmentIndex(demo, { parser: parser });
    assert(index.length >= 2, 'expected at least two segments, got ' + index.length);
    var covered = index.reduce(function (n, s) { return n + s.length; }, 0);
    assertEqual(covered, demo.length, 'segments cover the container');
    return index.length + ' segments: ' + index.map(function (s) {
      return s.typeName + '@' + s.offset + '+' + s.length;
    }).join(' ');
  });

  test('the JS scanner agrees with the wasm parser on the real container', function () {
    var w = delta.segmentIndex(demo, { parser: parser });
    var j = delta.segmentIndex(demo);
    assertEqual(j.length, w.length, 'segment count');
    for (var i = 0; i < w.length; i++) {
      assertEqual(j[i].offset, w[i].offset, 'segment ' + i + ' offset');
      assertEqual(j[i].length, w[i].length, 'segment ' + i + ' length');
      assertEqual(j[i].type, w[i].type, 'segment ' + i + ' type');
      assertEqual(j[i].segId, w[i].segId, 'segment ' + i + ' id');
      assertEqual(j[i].hash, w[i].hash, 'segment ' + i + ' hash');
    }
    return w.length + ' segments identical';
  });

  test('segment enumeration reports the types ADR-009 defines', function () {
    var index = delta.segmentIndex(demo, { parser: parser });
    var names = index.map(function (s) { return s.typeName; });
    assert(names.indexOf('MANIFEST') >= 0, 'expected a MANIFEST segment, saw ' + names.join(','));
    assert(names.indexOf('VEC') >= 0, 'expected a VEC segment, saw ' + names.join(','));
    index.forEach(function (s, i) {
      assertEqual(s.length, 64 + s.payloadLength, 'segment ' + i + ' header + payload');
      assert(s.offset + s.length <= demo.length, 'segment ' + i + ' inside the container');
    });
    return names.join(', ');
  });

  test('the span plan covers every byte of the container exactly once', function () {
    var spans = delta.spanPlan(demo, { parser: parser });
    var at = 0;
    spans.forEach(function (s, i) {
      assertEqual(s.offset, at, 'span ' + i + ' starts where the previous one ended');
      at += s.length;
    });
    assertEqual(at, demo.length, 'total coverage');
    return spans.length + ' spans, ' + demo.length + ' bytes';
  });

  test('the QR capacity table matches the vendored encoder for all 160 version/level pairs', function () {
    var levels = ['L', 'M', 'Q', 'H'];
    var checked = 0;
    levels.forEach(function (name) {
      for (var v = 1; v <= 40; v++) {
        assertEqual(
          delta.byteCapacity(v, name),
          qrlib.byteCapacity(v, qrlib.ECC[name]),
          'byte capacity at version ' + v + ' level ' + name
        );
        checked++;
      }
    });
    return checked + ' pairs';
  });

  test('the demo container inventory fits in a single QR symbol', function () {
    var inv = delta.inventory(demo, { parser: parser });
    var qr = delta.inventoryQr(inv, { ecl: 'L' });
    assertEqual(qr.chunks, 1, 'symbols needed');
    // The reported version must actually hold the payload in the real encoder.
    var encoded = qrlib.encodeText(qr.text, { ecl: qrlib.ECC.L });
    assertEqual(encoded.version, qr.version, 'version the encoder chose');
    ctx.report.inventoryBytes = qr.bytes;
    ctx.report.inventoryVersion = qr.version;
    ctx.report.inventorySpans = inv.spans.length;
    return qr.bytes + ' bytes, ' + inv.spans.length + ' spans, QR version ' + qr.version +
      '-L (capacity ' + qr.capacity + ')';
  });

  test('inventory survives an encode/decode round trip', function () {
    var inv = delta.inventory(demo, { parser: parser });
    var back = delta.decodeInventory(delta.encodeInventory(inv));
    assertEqual(back.root, inv.root, 'root digest');
    assertEqual(back.size, inv.size, 'size');
    assertEqual(back.spans.length, inv.spans.length, 'span count');
    for (var i = 0; i < inv.spans.length; i++) {
      assertEqual(back.spans[i].hash, inv.spans[i].hash, 'span ' + i + ' hash');
      assertEqual(back.spans[i].length, inv.spans[i].length, 'span ' + i + ' length');
      assertEqual(back.spans[i].offset, inv.spans[i].offset, 'span ' + i + ' offset');
      assertEqual(back.spans[i].type, inv.spans[i].type, 'span ' + i + ' type');
    }
    // A decoded inventory must diff identically to the one it came from.
    var d = delta.diff(inv, back);
    assertEqual(d.missing.length, 0, 'a decoded inventory holds everything the original did');
    return inv.spans.length + ' spans';
  });

  test('an inventory too large for one symbol splits and rejoins', function () {
    var segs = [];
    for (var i = 0; i < 400; i++) segs.push({ type: 1, payload: rndBytes(16) });
    var container = makeContainer(segs);
    var inv = delta.inventory(container, { parser: parser });
    var text = delta.encodeInventory(inv);
    assert(text.length > delta.byteCapacity(40, 'L'), 'expected an oversized inventory, got ' + text.length);
    var chunks = delta.chunkInventory(text, delta.byteCapacity(40, 'L'));
    assert(chunks.length > 1, 'expected several chunks');
    chunks.forEach(function (c, k) {
      assert(c.length <= delta.byteCapacity(40, 'L'), 'chunk ' + k + ' is ' + c.length + ' bytes');
    });
    var shuffled = chunks.slice().reverse();
    assertEqual(delta.joinInventoryChunks(shuffled), text, 'rejoined inventory');
    var back = delta.decodeInventory(delta.joinInventoryChunks(shuffled));
    assertEqual(back.root, inv.root, 'root digest after rejoin');
    return text.length + ' bytes over ' + chunks.length + ' symbols (' + inv.spans.length + ' spans)';
  });

  test('a chunked inventory rejects a missing chunk and a foreign chunk', function () {
    var inv = delta.inventory(demo, { parser: parser });
    var text = delta.encodeInventory(inv);
    var chunks = delta.chunkInventory(text, 64);
    assert(chunks.length >= 3, 'expected several chunks, got ' + chunks.length);
    assertThrows('missing-chunk', function () {
      delta.joinInventoryChunks(chunks.slice(1));
    }, 'dropping a chunk');
    var other = delta.chunkInventory(delta.encodeInventory(
      delta.inventory(makeContainer([{ type: 1, payload: rndBytes(32) }]), { parser: parser })
    ), 64);
    assertThrows('bad-chunks', function () {
      delta.joinInventoryChunks([chunks[0], other[0]]);
    }, 'mixing inventories');
    return chunks.length + ' chunks';
  });

  test('diff on synthetic spans: nothing missing, all missing, partial', function () {
    var sender = spanList([
      { length: 100, hash: 'aa' }, { length: 200, hash: 'bb' },
      { length: 300, hash: 'cc' }, { length: 400, hash: 'dd' }
    ]);
    var identical = delta.diff({ spans: sender }, { spans: sender });
    assertEqual(identical.missing.length, 0, 'nothing missing');
    assertEqual(identical.bytesToSend, 0, 'nothing to send');
    assertEqual(identical.bytesSaved, 1000, 'everything saved');
    assertEqual(identical.ratio, Infinity, 'ratio with nothing to send');

    var cold = delta.diff({ spans: sender }, null);
    assertEqual(cold.missing.length, 4, 'cold start misses everything');
    assertEqual(cold.bytesToSend, 1000, 'cold start sends everything');
    assertEqual(cold.bytesSaved, 0, 'cold start saves nothing');
    assertEqual(cold.ratio, 1, 'cold start ratio');

    var partial = delta.diff({ spans: sender }, {
      spans: spanList([
        { length: 100, hash: 'aa' }, { length: 300, hash: 'cc' }, { length: 999, hash: 'zz' }
      ])
    });
    assertEqual(partial.missing.join(','), '1,3', 'missing indices');
    assertEqual(partial.present.join(','), '0,2', 'present indices');
    assertEqual(partial.bytesToSend, 600, 'bytes to send');
    assertEqual(partial.bytesSaved, 400, 'bytes saved');

    // Same hash at a different length is a different span, not a match.
    var lengthTrap = delta.diff({ spans: sender }, {
      spans: spanList([{ length: 101, hash: 'aa' }])
    });
    assertEqual(lengthTrap.missing.length, 4, 'a hash match at the wrong length is not a match');
    return '4 cases';
  });

  test('delta round trip on the real container is byte-identical', function () {
    var base = delta.inventory(demo, { parser: parser });
    var modified = demo.slice();
    // Flip a byte inside the VEC payload: one segment changes, the rest do not.
    var vec = delta.segmentIndex(demo, { parser: parser }).filter(function (s) {
      return s.typeName === 'VEC';
    })[0];
    assert(vec, 'demo container has a VEC segment');
    modified[vec.offset + 100] ^= 0xff;

    var senderInv = delta.inventory(modified, { parser: parser });
    var d = delta.diff(senderInv, base);
    assertEqual(d.missing.length, 1, 'exactly one span changed');

    var payload = delta.buildDeltaPayload(modified, d.missing, { parser: parser, base: base });
    var applied = delta.applyDelta(demo, payload, { parser: parser });
    assert(bytesEqual(applied.bytes, modified), 'reconstructed bytes differ from the sender');
    assertEqual(core.sha256Hex(applied.bytes), core.sha256Hex(modified), 'SHA-256');
    return 'sent ' + payload.length + ' of ' + modified.length + ' bytes (' +
      d.ratio.toFixed(2) + '× less span data)';
  });

  test('a delta reconstructs even when the base holds its segments at other offsets', function () {
    // The receiver's container has the same VEC segment but a shorter manifest
    // ahead of it, so every later offset differs. Spans are matched by content,
    // so this still reconstructs.
    var payloadA = rndBytes(512);
    var shared = rndBytes(2048);
    var receiver = makeContainer([
      { type: 5, payload: payloadA.subarray(0, 128) },
      { type: 1, payload: shared }
    ]);
    var sender = makeContainer([
      { type: 5, payload: payloadA },
      { type: 1, payload: shared },
      { type: 10, payload: rndBytes(64) }
    ]);
    var base = delta.inventory(receiver, { parser: parser });
    var senderInv = delta.inventory(sender, { parser: parser });
    var d = delta.diff(senderInv, base);
    assertEqual(d.missing.length, 2, 'the shared VEC segment is not re-sent');
    var payload = delta.buildDeltaPayload(sender, d.missing, { parser: parser, base: base });
    var applied = delta.applyDelta(receiver, payload, { parser: parser });
    assert(bytesEqual(applied.bytes, sender), 'reconstruction differs');
    assertEqual(applied.fromBase, 2048 + 64, 'bytes taken from the base');
    return 'reused ' + applied.fromBase + ' bytes across shifted offsets';
  });

  test('a delta computed against another base is refused outright', function () {
    var base = delta.inventory(demo, { parser: parser });
    var modified = demo.slice();
    modified[200] ^= 0xff;
    var d = delta.diff(delta.inventory(modified, { parser: parser }), base);
    var payload = delta.buildDeltaPayload(modified, d.missing, { parser: parser, base: base });

    var wrongBase = demo.slice();
    wrongBase[wrongBase.length - 1] ^= 0x01;
    var err = assertThrows('base-mismatch', function () {
      delta.applyDelta(wrongBase, payload, { parser: parser });
    }, 'applying to a container the delta was not computed against');
    assertThrows('base-mismatch', function () {
      delta.applyDelta(new Uint8Array(0), payload, { parser: parser });
    }, 'applying to an empty base');
    return err.message.slice(0, 60) + '…';
  });

  test('a delta missing a span the base does not hold fails without producing bytes', function () {
    var sender = makeContainer([
      { type: 5, payload: rndBytes(64) },
      { type: 1, payload: rndBytes(256) }
    ]);
    // Claim the base holds everything, then apply against a base that holds
    // nothing: the reconstruction is unsatisfiable and must say so.
    var payload = delta.buildDeltaPayload(sender, [], { parser: parser });
    var empty = makeContainer([{ type: 5, payload: rndBytes(64) }]);
    assertThrows('missing-span', function () {
      delta.applyDelta(empty, payload, { parser: parser });
    }, 'unsatisfiable delta');
    return 'refused with no partial output';
  });

  test('an unbound delta carrying every span reconstructs from an empty base', function () {
    var sender = makeContainer([
      { type: 5, payload: rndBytes(96) },
      { type: 1, payload: rndBytes(300) }
    ]);
    var all = delta.spanPlan(sender, { parser: parser }).map(function (s, i) { return i; });
    var payload = delta.buildDeltaPayload(sender, all, { parser: parser });
    var applied = delta.applyDelta(new Uint8Array(0), payload, { parser: parser });
    assert(bytesEqual(applied.bytes, sender), 'full transfer differs');
    assertEqual(applied.fromBase, 0, 'nothing came from a base');
    return payload.length + ' bytes carried for a ' + sender.length + '-byte container';
  });

  test('buildDeltaPayload rejects a span index that is not in the plan', function () {
    var container = makeContainer([{ type: 1, payload: rndBytes(64) }]);
    assertThrows('bad-span-index', function () {
      delta.buildDeltaPayload(container, [99], { parser: parser });
    }, 'index past the end');
    assertThrows('bad-span-index', function () {
      delta.buildDeltaPayload(container, [-1], { parser: parser });
    }, 'negative index');
    return '2 cases';
  });

  test('a truncated container is rejected rather than half-parsed', function () {
    var full = makeContainer([
      { type: 5, payload: rndBytes(64) },
      { type: 1, payload: rndBytes(1024) }
    ]);
    var cut = full.subarray(0, full.length - 200);
    assertThrows('segment-out-of-bounds', function () {
      delta.segmentIndex(cut, { parser: parser });
    }, 'wasm parser on a truncated container');
    assertThrows('segment-out-of-bounds', function () {
      delta.segmentIndex(cut);
    }, 'JS scanner on a truncated container');
    return 'both parsers refused';
  });

  test('an absurd declared payload length allocates nothing', function () {
    var container = makeContainer([{ type: 1, payload: rndBytes(64) }]);
    // 0x00FFFFFFFF payload bytes declared inside a 128-byte file.
    container[16] = 0xff; container[17] = 0xff; container[18] = 0xff;
    container[19] = 0xff; container[20] = 0x00;
    var before = process.memoryUsage().heapUsed;
    assertThrows('segment-out-of-bounds', function () {
      delta.segmentIndex(container, { parser: parser });
    }, 'wasm parser');
    assertThrows('segment-out-of-bounds', function () {
      delta.segmentIndex(container);
    }, 'JS scanner');
    var grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    assert(grew < 64, 'heap grew ' + grew.toFixed(1) + ' MB handling a bogus length');
    return 'declared 4 GiB in 128 bytes, heap moved ' + grew.toFixed(1) + ' MB';
  });

  test('a container with no RVF magic yields an empty plan, not an error', function () {
    var junk = rndBytes(4096);
    junk[0] = 0x52; junk[1] = 0x56; junk[2] = 0x46; junk[3] = 0x53; // ASCII "RVFS"
    assertEqual(delta.segmentIndex(junk, { parser: parser }).length, 0, 'wasm segment count');
    assertEqual(delta.segmentIndex(junk).length, 0, 'JS segment count');
    // The whole file becomes one gap span, so a delta over it still works.
    var spans = delta.spanPlan(junk, { parser: parser });
    assertEqual(spans.length, 1, 'one gap span');
    assertEqual(spans[0].typeName, 'GAP', 'span kind');
    assertEqual(spans[0].length, junk.length, 'gap covers the file');
    return 'ASCII "RVFS" is not the wire magic 53 46 56 52';
  });

  test('a segment header with an unsupported version is skipped', function () {
    var container = makeContainer([{ type: 1, payload: rndBytes(128) }]);
    container[4] = 9;
    assertEqual(delta.segmentIndex(container, { parser: parser }).length, 0, 'wasm');
    assertEqual(delta.segmentIndex(container).length, 0, 'JS');
    return 'version 9 rejected by both parsers';
  });

  test('malformed delta payloads are rejected cleanly', function () {
    var container = makeContainer([{ type: 1, payload: rndBytes(256) }]);
    var good = delta.buildDeltaPayload(container, [0], { parser: parser });

    assertThrows('bad-delta', function () {
      delta.parseDeltaPayload(good.subarray(0, 40));
    }, 'truncated to less than a header');

    var wrongMagic = good.slice();
    wrongMagic[0] = 0x00;
    assertThrows('bad-delta-magic', function () {
      delta.parseDeltaPayload(wrongMagic);
    }, 'wrong magic');

    var wrongVersion = good.slice();
    wrongVersion[4] = 7;
    assertThrows('bad-delta-version', function () {
      delta.parseDeltaPayload(wrongVersion);
    }, 'wrong version');

    var absurdSpans = good.slice();
    absurdSpans[6] = 0xff; absurdSpans[7] = 0xff; // 65535 spans in a few hundred bytes
    assertThrows('bad-delta', function () {
      delta.parseDeltaPayload(absurdSpans);
    }, 'span table past the end');

    var absurdSize = good.slice();
    absurdSize[8] = 0xff; absurdSize[9] = 0xff; absurdSize[10] = 0xff; absurdSize[11] = 0xff;
    assertThrows('container-too-large', function () {
      delta.parseDeltaPayload(absurdSize);
    }, '4 GiB declared size');

    var shortBody = good.subarray(0, good.length - 8);
    assertThrows('bad-delta', function () {
      delta.parseDeltaPayload(shortBody);
    }, 'body shorter than the header declares');

    var corrupted = good.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    assertThrows('reconstruction-mismatch', function () {
      delta.applyDelta(new Uint8Array(0), corrupted, { parser: parser });
    }, 'corrupted carried bytes');
    return '7 cases';
  });

  test('malformed inventories are rejected cleanly', function () {
    var inv = delta.inventory(demo, { parser: parser });
    var text = delta.encodeInventory(inv);
    assertThrows('bad-inventory-encoding', function () {
      delta.decodeInventory('not base64url!!');
    }, 'bad encoding');
    assertThrows('bad-inventory', function () {
      delta.decodeInventory(text.slice(0, 8));
    }, 'shorter than the header');
    var bytes = core.b64uDecode(text);
    var wrongMagic = bytes.slice();
    wrongMagic[1] = 0x00;
    assertThrows('bad-inventory-magic', function () {
      delta.decodeInventory(core.b64uEncode(wrongMagic));
    }, 'wrong magic');
    var wrongCount = bytes.slice();
    wrongCount[6] = 0xff; wrongCount[7] = 0xff;
    assertThrows('bad-inventory', function () {
      delta.decodeInventory(core.b64uEncode(wrongCount));
    }, 'span count past the end');
    var wrongSize = bytes.slice();
    wrongSize[8] = 0x01;
    assertThrows('bad-inventory', function () {
      delta.decodeInventory(core.b64uEncode(wrongSize));
    }, 'spans that do not cover the declared size');
    return '5 cases';
  });

  test('a realistic delta: 200-segment container, 1% of segments changed', function () {
    var segs = [];
    for (var i = 0; i < 200; i++) segs.push({ type: i === 0 ? 5 : 1, payload: rndBytes(8192) });
    var receiver = makeContainer(segs);
    var modified = receiver.slice();
    var index = delta.segmentIndex(receiver, { parser: parser });
    // Rewrite two of the 200 segments — 1% of the container.
    [40, 120].forEach(function (k) {
      var seg = index[k];
      var fresh = rndBytes(seg.length - 64);
      modified.set(fresh, seg.offset + 64);
    });

    var base = delta.inventory(receiver, { parser: parser });
    var senderInv = delta.inventory(modified, { parser: parser });
    var d = delta.diff(senderInv, base);
    assertEqual(d.missing.length, 2, 'two spans changed');

    var payload = delta.buildDeltaPayload(modified, d.missing, { parser: parser, base: base });
    var applied = delta.applyDelta(receiver, payload, { parser: parser });
    assert(bytesEqual(applied.bytes, modified), 'reconstruction differs');

    var effective = modified.length / payload.length;
    assert(effective > 50, 'expected a large saving, got ' + effective.toFixed(1) + '×');
    ctx.report.realistic = {
      size: modified.length,
      payload: payload.length,
      spanRatio: d.ratio,
      effective: effective,
      inventoryBytes: delta.encodeInventory(base).length,
      spans: base.spans.length
    };
    return modified.length + ' bytes → ' + payload.length + ' byte delta (' +
      effective.toFixed(1) + '× less, span ratio ' + d.ratio.toFixed(1) + '×)';
  });
}

// --- Resume tests -----------------------------------------------------------

function registerResumeTests() {
  var artifact = rndBytes(6000);

  function newClock(start) {
    var at = start || 1700000000000;
    var clock = function () { return at; };
    clock.advance = function (ms) { at += ms; };
    return clock;
  }

  function openStore(opts) {
    opts = opts || {};
    return resume.open({
      factory: opts.factory || resume.memoryFactory(opts.factoryOpts),
      dbName: opts.dbName || 'test-' + Math.random().toString(36).slice(2),
      now: opts.now,
      ttlMs: opts.ttlMs
    });
  }

  /** Feeds `count` data frames into a fresh receiver, persisting each one. */
  function receiveInto(store, built, count, state) {
    var receiver = state || core.createReceiver();
    var chain = Promise.resolve();
    for (var i = 0; i <= count && i < built.frames.length; i++) {
      (function (index) {
        chain = chain.then(function () {
          var out = core.ingest(receiver, built.frames[index], Date.now());
          if (!out.accepted) throw new Error('frame ' + index + ' rejected: ' + out.reason);
          return store.saveProgress(built.transferId, receiver);
        });
      })(i);
    }
    return chain.then(function () { return receiver; });
  }

  test('resume: progress saved for a partial transfer loads back', function () {
    var built = core.buildFrames(artifact, { name: 'demo.rvf', chunk: 512 });
    var store;
    return openStore().then(function (s) {
      store = s;
      return receiveInto(store, built, 4);
    }).then(function () {
      return store.loadProgress(built.transferId);
    }).then(function (meta) {
      assert(meta, 'nothing was stored');
      assertEqual(meta.id, built.transferId, 'transfer id');
      assertEqual(meta.received, 4, 'frames recorded');
      assertEqual(meta.total, built.total, 'declared frame count');
      assertEqual(meta.manifest.sha256, built.sha256, 'manifest digest');
      assertEqual(meta.manifest.name, 'demo.rvf', 'manifest name');
      return store.loadProgress('deadbeef');
    }).then(function (absent) {
      assertEqual(absent, null, 'unknown transfer');
      store.close();
      return '4 of ' + (built.total - 1) + ' frames persisted';
    });
  });

  test('resume: a restored receiver finishes byte-identically', function () {
    var built = core.buildFrames(artifact, { name: 'demo.rvf', chunk: 512 });
    var factory = resume.memoryFactory();
    var dbName = 'resume-' + Math.random().toString(36).slice(2);
    var store;
    var half = Math.floor((built.total - 1) / 2);
    return openStore({ factory: factory, dbName: dbName }).then(function (s) {
      return receiveInto(s, built, half).then(function () {
        // The tab dies here: the handle is closed and every in-process
        // bookkeeping structure goes with it. What follows is a fresh page
        // load reading the state back out of storage.
        s.close();
      });
    }).then(function () {
      return openStore({ factory: factory, dbName: dbName });
    }).then(function (s) {
      store = s;
      return store.restore(built.transferId);
    }).then(function (state) {
      assertEqual(state.received, half, 'restored frame count');
      assertEqual(state.status, 'COLLECTING', 'restored status');
      assert(state.resumed, 'restored state is marked as resumed');
      // Feed the remaining frames into the restored state.
      for (var i = half + 1; i < built.total; i++) {
        var out = core.ingest(state, built.frames[i], Date.now());
        assert(out.accepted, 'frame ' + i + ' rejected: ' + out.reason);
      }
      assert(core.isComplete(state), 'transfer did not complete after resuming');
      var final = core.finalize(state);
      assert(final.ok, 'finalize failed: ' + final.reason);
      assert(bytesEqual(final.bytes, artifact), 'resumed artifact differs from the original');
      assertEqual(final.sha256, built.sha256, 'digest');
      store.close();
      return 'resumed at ' + half + '/' + (built.total - 1) + ', finished identical';
    });
  });

  test('resume: a stored transfer whose manifest disagrees with the scan is refused', function () {
    var built = core.buildFrames(artifact, { name: 'demo.rvf', chunk: 512 });
    var store;
    return openStore().then(function (s) {
      store = s;
      return receiveInto(store, built, 3);
    }).then(function () {
      // Same transfer id, different artifact: resuming would splice two files.
      var impostor = {
        name: 'demo.rvf', size: artifact.length, chunk: 512,
        sha256: core.sha256Hex(rndBytes(32))
      };
      return assertRejects('manifest-mismatch', store.restore(built.transferId, impostor),
        'a different artifact under the same transfer id');
    }).then(function () {
      var truthful = {
        name: 'demo.rvf', size: artifact.length, chunk: 512, sha256: built.sha256
      };
      return store.restore(built.transferId, truthful);
    }).then(function (state) {
      assertEqual(state.received, 3, 'the matching manifest still restores');
      return assertRejects('no-such-transfer', store.restore('00000000'), 'unknown transfer');
    }).then(function () {
      store.close();
      return 'mismatch refused, match accepted';
    });
  });

  test('resume: concurrent transfers stay isolated', function () {
    var artifactB = rndBytes(3000);
    var a = core.buildFrames(artifact, { name: 'a.rvf', chunk: 512 });
    var b = core.buildFrames(artifactB, { name: 'b.rvf', chunk: 256 });
    assert(a.transferId !== b.transferId, 'transfer ids collided');
    var store;
    return openStore().then(function (s) {
      store = s;
      return receiveInto(store, a, 3);
    }).then(function () {
      return receiveInto(store, b, 5);
    }).then(function () {
      return Promise.all([store.restore(a.transferId), store.restore(b.transferId)]);
    }).then(function (states) {
      assertEqual(states[0].received, 3, 'transfer A frame count');
      assertEqual(states[1].received, 5, 'transfer B frame count');
      assertEqual(states[0].manifest.name, 'a.rvf', 'transfer A name');
      assertEqual(states[1].manifest.name, 'b.rvf', 'transfer B name');
      assertEqual(states[0].manifest.chunk, 512, 'transfer A chunk size');
      assertEqual(states[1].manifest.chunk, 256, 'transfer B chunk size');
      // Finish B; A must be untouched.
      for (var i = 6; i < b.total; i++) core.ingest(states[1], b.frames[i], Date.now());
      var done = core.finalize(states[1]);
      assert(done.ok, 'B failed to finalize: ' + done.reason);
      assert(bytesEqual(done.bytes, artifactB), 'B reconstructed wrong');
      return store.listResumable();
    }).then(function (rows) {
      assertEqual(rows.length, 2, 'both transfers listed');
      return store.dropProgress(a.transferId).then(function () {
        return store.listResumable();
      });
    }).then(function (rows) {
      assertEqual(rows.length, 1, 'dropping one transfer left the other');
      assertEqual(rows[0].name, 'b.rvf', 'the surviving transfer');
      return store.restore(a.transferId).then(function () {
        throw new Error('the dropped transfer was still restorable');
      }, function (e) {
        assertEqual(e.reason, 'no-such-transfer', 'dropped transfer');
      });
    }).then(function () {
      store.close();
      return '2 transfers, isolated and independently droppable';
    });
  });

  test('resume: stale transfers are pruned and fresh ones survive', function () {
    var clock = newClock();
    var built = core.buildFrames(artifact, { name: 'old.rvf', chunk: 512 });
    var fresh = core.buildFrames(rndBytes(900), { name: 'new.rvf', chunk: 512 });
    var factory = resume.memoryFactory();
    var dbName = 'prune-' + Math.random().toString(36).slice(2);
    var store;
    return openStore({ factory: factory, dbName: dbName, now: clock }).then(function (s) {
      store = s;
      return receiveInto(store, built, 2);
    }).then(function () {
      clock.advance(8 * 24 * 60 * 60 * 1000); // eight days: past the seven-day TTL
      return receiveInto(store, fresh, 2);
    }).then(function () {
      return store.listResumable({ includeStale: true });
    }).then(function (rows) {
      assertEqual(rows.length, 2, 'both transfers present before pruning');
      var stale = rows.filter(function (r) { return r.stale; });
      assertEqual(stale.length, 1, 'exactly one is past its TTL');
      assertEqual(stale[0].name, 'old.rvf', 'the stale one');
      return store.listResumable();
    }).then(function (rows) {
      assertEqual(rows.length, 1, 'the default listing hides stale entries');
      return store.prune();
    }).then(function (pruned) {
      assertEqual(pruned.removed.length, 1, 'one transfer pruned');
      return store.listResumable({ includeStale: true });
    }).then(function (rows) {
      assertEqual(rows.length, 1, 'the fresh transfer survived');
      assertEqual(rows[0].name, 'new.rvf', 'survivor');
      return store.restore(built.transferId).then(function () {
        throw new Error('a pruned transfer was still restorable');
      }, function (e) {
        assertEqual(e.reason, 'no-such-transfer', 'pruned transfer');
      });
    }).then(function () {
      store.close();
      return 'TTL ' + (resume.DEFAULT_TTL_MS / 86400000) + ' days, 1 pruned, 1 kept';
    });
  });

  test('resume: a full quota surfaces a clear error and leaves stored state honest', function () {
    var built = core.buildFrames(artifact, { name: 'demo.rvf', chunk: 512 });
    var store;
    var lastDurable = 0;
    return openStore({ factoryOpts: { quotaBytes: 4000 } }).then(function (s) {
      store = s;
      // Keep feeding frames until the fake storage refuses one.
      var receiver = core.createReceiver();
      var chain = Promise.resolve();
      for (var k = 0; k < built.total; k++) {
        (function (index) {
          chain = chain.then(function () {
            core.ingest(receiver, built.frames[index], Date.now());
            return store.saveProgress(built.transferId, receiver).then(function () {
              lastDurable = receiver.received;
            });
          });
        })(k);
      }
      return assertRejects('quota-exceeded', chain, 'writing past the quota');
    }).then(function (err) {
      assert(lastDurable > 0, 'the quota tripped before anything was stored');
      assert(/full/i.test(err.message), 'the message should say what happened: ' + err.message);
      return store.loadProgress(built.transferId);
    }).then(function (after) {
      // The failed transaction took the meta update with it, so the stored
      // count never claims a frame that was not written.
      assertEqual(after.received, lastDurable, 'stored frame count after the failed write');
      return store.restore(built.transferId);
    }).then(function (state) {
      assertEqual(state.received, lastDurable, 'restored frame count matches the meta record');
      // A resumed receiver picks up from exactly what survived, and the
      // frames the quota refused are simply re-scanned.
      for (var i = lastDurable + 1; i < built.total; i++) {
        core.ingest(state, built.frames[i], Date.now());
      }
      var final = core.finalize(state);
      assert(final.ok, 'finalize after a quota failure: ' + final.reason);
      assert(bytesEqual(final.bytes, artifact), 'artifact differs after a quota failure');
      store.close();
      return 'quota refusal reported, ' + lastDurable + ' frames still durable, transfer still completable';
    });
  });

  test('resume: per-frame write cost', function () {
    var frames = 400;
    var payload = rndBytes(512);
    var store;
    var receiver = core.createReceiver();
    var built = core.buildFrames(rndBytes(frames * 512), { name: 'cost.rvf', chunk: 512 });
    return openStore().then(function (s) {
      store = s;
      core.ingest(receiver, built.frames[0], Date.now());
      var chain = Promise.resolve();
      var started = Date.now();
      for (var i = 1; i <= frames; i++) {
        (function (seq) {
          chain = chain.then(function () {
            receiver.chunks[seq] = payload;
            receiver.received = seq;
            return store.recordFrame(built.transferId, seq, payload, receiver);
          });
        })(i);
      }
      return chain.then(function () { return Date.now() - started; });
    }).then(function (elapsed) {
      return store.loadProgress(built.transferId).then(function (meta) {
        assertEqual(meta.received, frames, 'frames recorded');
        var metaBytes = JSON.stringify(meta).length;
        // The same frames again, committed 20 at a time, to separate the cost
        // of the work from the cost of the transaction boundary.
        var batched = core.createReceiver();
        core.ingest(batched, built.frames[0], Date.now());
        var chain = Promise.resolve();
        var startedBatch = Date.now();
        for (var i = 1; i <= frames; i++) {
          batched.chunks[i] = payload;
          batched.received = i;
          if (i % 20 === 0) {
            chain = chain.then(function () {
              return store.saveProgress(built.transferId + '-b', batched);
            });
          }
        }
        return chain.then(function () {
          var batchElapsed = Date.now() - startedBatch;
          store.close();
          return frames + ' frames one per transaction: ' + elapsed + ' ms (' +
            (elapsed * 1000 / frames).toFixed(0) + ' µs/frame); batched 20 per transaction: ' +
            batchElapsed + ' ms (' + (batchElapsed * 1000 / frames).toFixed(0) +
            ' µs/frame); ' + (payload.length + metaBytes) + ' bytes per frame (' +
            payload.length + ' chunk written once + ' + metaBytes + ' meta rewritten in place)';
        });
      });
    });
  });

  test('resume: saveProgress writes each chunk once, not the whole artifact each time', function () {
    var built = core.buildFrames(artifact, { name: 'demo.rvf', chunk: 512 });
    var store;
    var receiver = core.createReceiver();
    var writes = [];
    return openStore().then(function (s) {
      store = s;
      var chain = Promise.resolve();
      for (var i = 0; i < 6; i++) {
        (function (index) {
          chain = chain.then(function () {
            core.ingest(receiver, built.frames[index], Date.now());
            return store.saveProgress(built.transferId, receiver).then(function (r) {
              writes.push(r.wrote);
            });
          });
        })(i);
      }
      return chain;
    }).then(function () {
      assertEqual(writes.join(','), '0,1,1,1,1,1', 'chunks written per save');
      // Saving again with no new frames writes no chunks at all.
      return store.saveProgress(built.transferId, receiver);
    }).then(function (again) {
      assertEqual(again.wrote, 0, 'a redundant save wrote chunks');
      store.close();
      return 'writes per save: ' + writes.join(',') + ' (manifest frame carries no chunk)';
    });
  });
}

// --- Runner -----------------------------------------------------------------

function runQueue() {
  return queue.reduce(function (chain, entry) {
    return chain.then(function () {
      var started = Date.now();
      return Promise.resolve()
        .then(entry.fn)
        .then(function (detail) {
          results.push({ name: entry.name, ok: true, detail: detail || '', ms: Date.now() - started });
        }, function (e) {
          results.push({
            name: entry.name, ok: false,
            detail: (e && e.message ? e.message : String(e)), ms: Date.now() - started
          });
        });
    });
  }, Promise.resolve());
}

function main() {
  var report = {};
  var wasmBytes = fs.readFileSync(DEMO_WASM);
  var demo = new Uint8Array(fs.readFileSync(DEMO_RVF));
  return WebAssembly.compile(wasmBytes).then(function (mod) {
    return WebAssembly.instantiate(mod, {}).then(function (instance) {
      var ctx = {
        module: mod,
        demo: demo,
        parser: delta.wasmParser(instance.exports),
        report: report
      };
      registerDeltaTests(ctx);
      registerResumeTests();
      return runQueue();
    });
  }).then(function () {
    results.forEach(function (r) {
      console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    });
    var failed = results.filter(function (r) { return !r.ok; }).length;
    console.log('\n' + (results.length - failed) + '/' + results.length +
      ' passed, ' + failed + ' failed');
    if (report.inventoryBytes) {
      console.log(
        'demo container: ' + demo.length + ' bytes, ' + report.inventorySpans +
        ' spans, inventory ' + report.inventoryBytes + ' bytes → QR version ' +
        report.inventoryVersion + '-L'
      );
    }
    if (report.realistic) {
      var r = report.realistic;
      console.log(
        'realistic case: ' + r.size + '-byte container, ' + r.spans + ' spans, 1% rewritten → ' +
        r.payload + '-byte delta (' + r.effective.toFixed(1) + '× less data); ' +
        'inventory ' + r.inventoryBytes + ' bytes'
      );
    }
    process.exit(failed ? 1 : 0);
  });
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('FAIL harness  [' + (e && e.stack ? e.stack : e) + ']');
    process.exit(1);
  });
}

module.exports = { main: main };
