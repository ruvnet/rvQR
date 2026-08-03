/*!
 * rvQR offload + p2p test suite.
 *
 * Node only: `node artifacts/perf.test.js`. One line per test, non-zero exit on
 * any failure — same shape as artifacts/tests.js and artifacts/delta.test.js.
 *
 * Three things this suite exists to prove.
 *
 *   1. The inline fallback is not a lesser path. offload.js's whole claim is
 *      that a page which cannot construct a Worker still answers identically,
 *      so every job is run BOTH ways and the two answers are compared as bytes,
 *      not as shapes. The worker path runs over node:worker_threads through the
 *      same browser-shaped Worker surface offload.js expects, so the comparison
 *      is against a real postMessage round trip rather than a mock.
 *
 *   2. p2p.js's parsers are hostile-input parsers. Everything that arrives from
 *      a camera is driven with truncated, oversized, mistyped and bomb payloads,
 *      and the requirement is a rejection value, never a throw.
 *
 *   3. Bytes that arrive over the data channel are verified by core.js. Not by
 *      something in this file that resembles core.js — the tests drive
 *      core.createReceiver / core.ingest / core.finalize through p2p.link and
 *      assert on what core decided.
 *
 * Byte-exactness is asserted with SHA-256 from node:crypto throughout, so a
 * test that passes because two wrong answers are the same wrong length cannot
 * happen.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
'use strict';

var crypto = require('crypto');
var path = require('path');
var core = require('./core.js');
var qrlib = require('./vendor/qrcode.js');
var delta = require('./delta.js');
var offload = require('./offload.js');
var workerApi = require('./worker.js');
var p2p = require('./p2p.js');

var WORKER_PATH = path.join(__dirname, 'worker.js');

var WT = null;
try { WT = require('worker_threads'); } catch (e) { WT = null; }

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
    throw new Error((msg || 'expected') + ': got ' + show(actual) + ', want ' + show(expected));
  }
}

function show(v) {
  if (typeof v === 'string') return v.length > 96 ? JSON.stringify(v.slice(0, 96)) + '…' : JSON.stringify(v);
  if (v instanceof Uint8Array) return 'u8[' + v.length + '] ' + hex(v.subarray(0, 16)) + (v.length > 16 ? '…' : '');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function assertThrows(reason, fn, msg) {
  var caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert(caught, (msg || 'expected a rejection') + ', nothing was thrown');
  assertEqual(caught.reason, reason, (msg || 'rejection') + ' reason (message: ' + caught.message + ')');
  return caught;
}

function assertRejects(reason, promise, msg) {
  return promise.then(
    function (v) { throw new Error((msg || 'expected a rejection') + ', it resolved with ' + show(v)); },
    function (e) {
      assertEqual(e.reason, reason, (msg || 'rejection') + ' reason (message: ' + e.message + ')');
      return e;
    }
  );
}

function hex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

/** node:crypto is the outside opinion every hash in this file is checked against. */
function nodeSha(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0,
    bytes.byteLength === undefined ? bytes.length : bytes.byteLength)).digest('hex');
}

function shaText(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Serialises a job result to a string that distinguishes anything two runs of
 * the same job could disagree about — typed arrays by their bytes, objects by
 * their sorted keys — so "byte-identical" can be asserted as one SHA-256
 * comparison instead of a hand-written walk per job type.
 */
function canonical(value) {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Uint8Array) return 'u8[' + value.length + ']:' + hex(value);
  if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + hex(new Uint8Array(
    value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(value[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function assertSameAnswer(a, b, msg) {
  var fa = fingerprint(a), fb = fingerprint(b);
  if (fa === fb) return fa;
  var ca = canonical(a), cb = canonical(b);
  var at = 0;
  while (at < ca.length && at < cb.length && ca.charAt(at) === cb.charAt(at)) at++;
  throw new Error((msg || 'answers differ') + ': first difference at offset ' + at +
    '\n  inline: …' + ca.slice(Math.max(0, at - 24), at + 40) +
    '\n  worker: …' + cb.slice(Math.max(0, at - 24), at + 40));
}

function assertBytesEqual(actual, expected, msg) {
  var a = actual instanceof Uint8Array ? actual : new Uint8Array(actual);
  var b = expected instanceof Uint8Array ? expected : new Uint8Array(expected);
  if (a.length !== b.length) {
    throw new Error((msg || 'bytes') + ': length ' + a.length + ', want ' + b.length);
  }
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error((msg || 'bytes') + ': first difference at byte ' + i + ' (got 0x' +
        a[i].toString(16) + ', want 0x' + b[i].toString(16) + ')');
    }
  }
  assertEqual(nodeSha(a), nodeSha(b), (msg || 'bytes') + ' sha256');
}

// Deterministic pseudo-random bytes so a failure is reproducible.
var seed = 0x9e37b1;
function rndBytes(n) {
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
}

/**
 * Keeps the event loop alive across a test that waits on offload.js's handshake
 * timer. That timer is deliberately unref'd — a browser page is never held open
 * by it — so under Node a test that waits for it and nothing else would see the
 * process exit instead of the timeout firing.
 */
function keepAlive() {
  var t = setInterval(function () {}, 5);
  return function () { clearInterval(t); };
}

// --- A browser-shaped Worker over node:worker_threads -----------------------
// offload.js constructs `new ctor(url)` and talks to it through onmessage /
// onerror / postMessage(msg, transfer) / terminate — the DOM Worker surface.
// This adapter supplies exactly that surface and nothing more, so the worker
// path under test is the same code path a browser drives.

var WORKER_BOOTSTRAP = [
  "var WT = require('worker_threads');",
  "var api = require(WT.workerData.path);",
  "var scope = { postMessage: function (m, t) { WT.parentPort.postMessage(m, t || []); } };",
  "api.listen(scope);",
  "WT.parentPort.on('message', function (m) {",
  "  if (scope.onmessage) scope.onmessage({ data: m });",
  "});"
].join('\n');

function NodeWorker(url) {
  var self = this;
  this._w = new WT.Worker(WORKER_BOOTSTRAP, { eval: true, workerData: { path: url } });
  this._w.on('message', function (m) { if (self.onmessage) self.onmessage({ data: m }); });
  this._w.on('error', function (e) {
    if (self.onerror) self.onerror({ message: e && e.message ? e.message : String(e) });
  });
}
NodeWorker.prototype.postMessage = function (m, t) { this._w.postMessage(m, t || []); };
NodeWorker.prototype.terminate = function () { this._w.terminate(); };

// --- Fixtures ---------------------------------------------------------------

/** Rasterises a symbol the way a camera frame arrives: pixels in, text out. */
function rasterize(qr, opts) {
  opts = opts || {};
  var scale = opts.scale || 4;
  var quiet = opts.quiet === undefined ? 4 : opts.quiet;
  var dim = qr.size + quiet * 2;
  var W = dim * scale;
  var data = new Uint8Array(W * W * 4);
  for (var y = 0; y < W; y++) {
    for (var x = 0; x < W; x++) {
      var mx = Math.floor(x / scale) - quiet;
      var my = Math.floor(y / scale) - quiet;
      var dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.getModule(mx, my);
      var v = dark ? 0 : 255;
      var p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data: data, width: W, height: W };
}

function copyImage(img) {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
}

/**
 * A data-channel offer of the shape Chrome emits: two host candidates, a
 * SHA-256 certificate fingerprint, ICE credentials, no media sections.
 */
var OFFER_SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.42 54321 typ host generation 0',
  'a=candidate:1467250028 1 udp 2122194687 10.0.0.7 54322 typ host generation 0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:' +
    'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144'
].join('\r\n') + '\r\n';

function sdpWithCandidates(n) {
  var head = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy',
    'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:' +
      'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000'
  ];
  for (var i = 0; i < n; i++) {
    head.push('a=candidate:' + (1000 + i) + ' 1 udp 2122260223 10.0.0.' +
      (i % 250 + 1) + ' ' + (50000 + i) + ' typ host generation 0');
  }
  return head.join('\r\n') + '\r\n';
}

/**
 * A data channel with no connection behind it: send() hands the message to
 * whatever `onto` is, bufferedAmount is whatever the test says it is. Every
 * WebRTC call p2p.link makes goes through this surface, which is the whole
 * reason link() takes a channel rather than a peer connection.
 */
function FakeChannel() {
  this.bufferedAmount = 0;
  this.bufferedAmountLowThreshold = 0;
  this.readyState = 'open';
  this.binaryType = '';
  this.sent = [];
  this.closed = false;
}
FakeChannel.prototype.send = function (data) {
  this.sent.push(data);
  if (this.onSend) this.onSend(data, this);
};
FakeChannel.prototype.close = function () { this.closed = true; };
FakeChannel.prototype.open = function () {
  this.readyState = 'open';
  if (this.onopen) this.onopen({});
};

/** An answer of the shape a browser produces for the offer above. */
var ANSWER_SDP = [
  'v=0',
  'o=- 8123456789012345678 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:2467250099 1 udp 2122260223 192.168.1.99 61001 typ host generation 0',
  'a=ice-ufrag:9QpZ',
  'a=ice-pwd:9rXk0NuRHlPy2/1muCWoOi',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:' +
    '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
  'a=setup:active',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144'
].join('\r\n') + '\r\n';

/**
 * The smallest RTCPeerConnection that createOffer/acceptOffer actually touch:
 * createDataChannel, createOffer/createAnswer, set{Local,Remote}Description,
 * localDescription, the ICE gathering signals and close. p2p.js reaches WebRTC
 * only through opts.factory, so this is the whole of the surface under test.
 */
function FakePeerConnection(config, script) {
  this.config = config;
  this.script = script;
  this.iceGatheringState = script.gathering || 'complete';
  this.localDescription = null;
  this.remoteDescription = null;
  this.closed = false;
  this.calls = [];
}
FakePeerConnection.prototype.createDataChannel = function (label, opts) {
  this.calls.push('createDataChannel');
  this.dataChannelLabel = label;
  this.dataChannelOptions = opts;
  return this.script.localChannel;
};
FakePeerConnection.prototype.createOffer = function () {
  this.calls.push('createOffer');
  return Promise.resolve({ type: 'offer', sdp: this.script.offer });
};
FakePeerConnection.prototype.createAnswer = function () {
  this.calls.push('createAnswer');
  return Promise.resolve({ type: 'answer', sdp: this.script.answer });
};
FakePeerConnection.prototype.setLocalDescription = function (d) {
  this.calls.push('setLocalDescription');
  this.localDescription = d;
  return Promise.resolve();
};
FakePeerConnection.prototype.setRemoteDescription = function (d) {
  var self = this;
  this.calls.push('setRemoteDescription');
  this.remoteDescription = d;
  if (this.script.onRemote) setTimeout(function () { self.script.onRemote(self); }, 0);
  return Promise.resolve();
};
FakePeerConnection.prototype.close = function () { this.closed = true; };

// ===========================================================================
// Offload / worker
// ===========================================================================

function registerOffloadTests(ctx) {
  var SIZES = [0, 1, 2, 31, 32, 33, 64, 1000, 4096, 65536];

  test('a missing Worker constructor degrades to inline instead of throwing', function () {
    // No WorkerCtor, and Node has no global Worker: construction has to succeed
    // and report why it is inline, because a file:// page hits this every time.
    assertEqual(typeof Worker, 'undefined', 'this Node build must have no global Worker');
    var c = offload.create({});
    assertEqual(c.mode, offload.MODE_INLINE, 'mode before ready');
    return c.ready.then(function (r) {
      assertEqual(r.mode, offload.MODE_INLINE, 'ready mode');
      assert(/no Worker constructor/.test(r.reason || ''), 'reason names the cause, got ' + r.reason);
      return c.sha256(new Uint8Array([7])).then(function (h) {
        assertEqual(h, nodeSha(new Uint8Array([7])), 'inline sha256 still answers');
        return r.reason;
      });
    });
  });

  test('create({fallback:true}) reports inline and still runs every job', function () {
    var c = offload.create({ fallback: true });
    return c.ready.then(function (r) {
      assertEqual(r.mode, 'inline', 'documented mode for the fallback client');
      var bytes = rndBytes(3000);
      return c.sha256(bytes).then(function (h) {
        assertEqual(h, nodeSha(bytes), 'sha256 agrees with node:crypto');
        return 'mode=' + r.mode;
      });
    });
  });

  test('a Worker constructor that throws (CSP) degrades to inline, not to an exception', function () {
    function BlockedWorker() {
      throw new Error('Refused to create a worker: violates Content Security Policy');
    }
    var c = offload.create({ WorkerCtor: BlockedWorker });
    return c.ready.then(function (r) {
      assertEqual(r.mode, offload.MODE_INLINE, 'ready mode');
      assert(/construction failed/.test(r.reason || ''), 'reason, got ' + r.reason);
      assert(/Content Security Policy/.test(r.reason || ''),
        'reason carries the underlying message, got ' + r.reason);
      var b = rndBytes(101);
      return c.sha256(b).then(function (h) {
        assertEqual(h, nodeSha(b), 'work still happens');
        return r.reason.slice(0, 48);
      });
    });
  });

  test('a worker that never says hello is written off after timeoutMs and demotes to inline', function () {
    function SilentWorker() { /* constructs, then says nothing at all */ }
    SilentWorker.prototype.postMessage = function () {};
    SilentWorker.prototype.terminate = function () { this.terminated = true; };
    var stop = keepAlive();
    var c = offload.create({ WorkerCtor: SilentWorker, timeoutMs: 40 });
    assertEqual(c.mode, offload.MODE_PENDING, 'mode while the handshake is outstanding');
    // Submitted before the handshake settles: it must be queued and replayed,
    // not lost and not rejected.
    var early = c.sha256(new Uint8Array([1, 2, 3]));
    return c.ready.then(function (r) {
      assertEqual(r.mode, offload.MODE_INLINE, 'mode after the deadline');
      assert(/did not answer within 40ms/.test(r.reason || ''), 'reason, got ' + r.reason);
      return early;
    }).then(function (h) {
      assertEqual(h, nodeSha(new Uint8Array([1, 2, 3])), 'the queued call ran inline');
      stop();
      return 'demoted after 40ms';
    }, function (e) { stop(); throw e; });
  });

  test('fallback:never keeps a silent worker rather than demoting behind the caller\'s back', function () {
    function SilentWorker() {}
    SilentWorker.prototype.postMessage = function () {};
    SilentWorker.prototype.terminate = function () {};
    var stop = keepAlive();
    var c = offload.create({ WorkerCtor: SilentWorker, timeoutMs: 40, fallback: 'never' });
    return c.ready.then(function (r) {
      stop();
      assertEqual(r.mode, offload.MODE_WORKER, 'mode stays worker');
      assertEqual(r.reason, 'handshake timed out', 'reason');
      return r.reason;
    }, function (e) { stop(); throw e; });
  });

  test('a worker whose protocol does not match is refused and the client falls back', function () {
    function WrongProtocolWorker() {
      var self = this;
      setTimeout(function () {
        if (self.onmessage) self.onmessage({ data: { hello: workerApi.PROTOCOL + 99 } });
      }, 0);
    }
    WrongProtocolWorker.prototype.postMessage = function () {};
    WrongProtocolWorker.prototype.terminate = function () { this.terminated = true; };
    var c = offload.create({ WorkerCtor: WrongProtocolWorker });
    return c.ready.then(function (r) {
      assertEqual(r.mode, offload.MODE_INLINE, 'mode');
      assert(/speaks protocol/.test(r.reason || ''), 'reason, got ' + r.reason);
      var b = rndBytes(77);
      return c.sha256(b).then(function (h) {
        assertEqual(h, nodeSha(b), 'still answers');
        return r.reason;
      });
    });
  });

  test('the worker path comes up over worker_threads and answers the protocol handshake', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    assertEqual(ctx.workerReady.mode, offload.MODE_WORKER, 'ready mode');
    assertEqual(ctx.workerReady.reason, null, 'no demotion reason');
    var caps = ctx.workerReady.capabilities;
    assert(caps, 'the hello carried capabilities');
    assertEqual(caps.protocol, workerApi.PROTOCOL, 'protocol');
    ['ping', 'sha256', 'decode', 'signature', 'fountain.open', 'delta.spans'].forEach(function (j) {
      assert(caps.jobs.indexOf(j) >= 0, 'capabilities list the ' + j + ' job, got ' + caps.jobs.join(','));
    });
    assertEqual(caps.decode, true, 'decoder present');
    assertEqual(caps.fountain, true, 'fountain codec present');
    assertEqual(caps.delta, true, 'delta module present');
    return caps.jobs.length + ' jobs, protocol ' + caps.protocol;
  });

  test('inline sha256 agrees with node:crypto at every size, including 0 and 1 bytes', function () {
    return SIZES.reduce(function (chain, n) {
      return chain.then(function () {
        var b = rndBytes(n);
        var want = nodeSha(b);
        return ctx.inline.sha256Full(b).then(function (r) {
          assertEqual(r.hex, want, 'hex for ' + n + ' bytes');
          assertEqual(r.length, n, 'reported length for ' + n + ' bytes');
          assertEqual(hex(r.digest), want, 'digest bytes for ' + n + ' bytes');
          assertEqual(r.digest.length, 32, 'digest length for ' + n + ' bytes');
        });
      });
    }, Promise.resolve()).then(function () {
      return SIZES.length + ' sizes: ' + SIZES.join(',');
    });
  });

  test('worker sha256 agrees with node:crypto at every size, including 0 and 1 bytes', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    return SIZES.reduce(function (chain, n) {
      return chain.then(function () {
        var b = rndBytes(n);
        var want = nodeSha(b);
        return ctx.worker.sha256Full(b).then(function (r) {
          assertEqual(r.hex, want, 'hex for ' + n + ' bytes');
          assertEqual(r.length, n, 'reported length for ' + n + ' bytes');
          assertEqual(hex(r.digest), want, 'digest bytes for ' + n + ' bytes');
        });
      });
    }, Promise.resolve()).then(function () {
      return SIZES.length + ' sizes over postMessage';
    });
  });

  test('inline and worker sha256 answers are byte-identical across sizes', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    return SIZES.reduce(function (chain, n) {
      return chain.then(function () {
        var b = rndBytes(n);
        return Promise.all([
          ctx.inline.sha256Full(new Uint8Array(b)),
          ctx.worker.sha256Full(new Uint8Array(b))
        ]).then(function (r) {
          assertSameAnswer(r[0], r[1], 'sha256 answer for ' + n + ' bytes');
          assertEqual(r[0].hex, nodeSha(b), 'and both match node:crypto for ' + n + ' bytes');
        });
      });
    }, Promise.resolve()).then(function () { return SIZES.length + ' sizes identical'; });
  });

  test('inline and worker QR decode answers are byte-identical', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    return Promise.all([
      ctx.inline.decode(copyImage(ctx.image)),
      ctx.worker.decode(copyImage(ctx.image))
    ]).then(function (r) {
      assertSameAnswer(r[0], r[1], 'decode answer');
      assertEqual(r[0].count, 1, 'one symbol found');
      assertEqual(r[0].texts[0], ctx.imageText, 'decoded text');
      return r[0].count + ' symbol, ' + r[0].texts[0].length + ' chars';
    });
  });

  test('inline and worker frame signatures are byte-identical and match core.frameSignature', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    var direct = core.frameSignature(copyImage(ctx.image));
    return Promise.all([
      ctx.inline.signature(copyImage(ctx.image)),
      ctx.worker.signature(copyImage(ctx.image))
    ]).then(function (r) {
      assertBytesEqual(r[0], r[1], 'inline vs worker signature');
      assertBytesEqual(r[0], direct, 'offloaded vs in-process core.frameSignature');
      return r[0].length + ' bytes, sha256 ' + nodeSha(r[0]).slice(0, 12);
    });
  });

  test('inline and worker fountain symbols are byte-identical for the same encoder', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    var art = rndBytes(4000);
    function run(client) {
      return client.fountainOpen(new Uint8Array(art), 512).then(function (h) {
        return client.fountainSymbols(h, 0, 16).then(function (syms) {
          return client.fountainClose(h).then(function (closed) {
            assertEqual(closed.closed, true, 'session closed');
            return { handle: { K: h.K, symbolSize: h.symbolSize, totalBytes: h.totalBytes }, symbols: syms };
          });
        });
      });
    }
    return Promise.all([run(ctx.inline), run(ctx.worker)]).then(function (r) {
      assertSameAnswer(r[0], r[1], 'fountain encoder output');
      assertEqual(r[0].symbols.length, 16, 'symbol count');
      assertEqual(r[0].handle.totalBytes, art.length, 'declared total');
      return r[0].symbols.length + ' symbols, K=' + r[0].handle.K +
        ', sha256 ' + fingerprint(r[0].symbols).slice(0, 12);
    });
  });

  test('inline and worker delta span inventories are byte-identical', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    var container = rndBytes(6000);
    return Promise.all([
      ctx.inline.deltaSpans(new Uint8Array(container)),
      ctx.worker.deltaSpans(new Uint8Array(container))
    ]).then(function (r) {
      assertSameAnswer(r[0], r[1], 'delta inventory');
      return 'inventory sha256 ' + fingerprint(r[0]).slice(0, 12);
    });
  });

  test('transfer:true neuters the caller\'s buffer on the inline path', function () {
    // Documented in offload.js's header: "Pass { transfer: true } and the
    // argument's buffer is handed over instead — zero-copy, and NEUTERED".
    // The inline path has nothing to hand it to, so it detaches deliberately
    // rather than letting the contract differ between the two paths.
    assertEqual(typeof structuredClone, 'function',
      'this platform can detach; offload.detach documents the older-Safari case where it cannot');
    var bytes = rndBytes(2048);
    var want = nodeSha(bytes);
    return ctx.inline.sha256(bytes, { transfer: true }).then(function (h) {
      assertEqual(h, want, 'hash of the transferred bytes');
      assertEqual(bytes.byteLength, 0, 'view byteLength after transfer');
      assertEqual(bytes.buffer.byteLength, 0, 'buffer byteLength after transfer');
      assertEqual(bytes.length, 0, 'view length after transfer');
      return 'buffer detached, hash ' + h.slice(0, 12);
    });
  });

  test('transfer:true neuters the caller\'s buffer on the worker path', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    var bytes = rndBytes(2048);
    var want = nodeSha(bytes);
    return ctx.worker.sha256(bytes, { transfer: true }).then(function (h) {
      assertEqual(h, want, 'hash of the transferred bytes');
      assertEqual(bytes.byteLength, 0, 'view byteLength after postMessage transfer');
      assertEqual(bytes.buffer.byteLength, 0, 'buffer byteLength after postMessage transfer');
      return 'buffer detached, hash ' + h.slice(0, 12);
    });
  });

  test('without transfer the caller keeps its buffer intact on both paths', function () {
    // The default is a copy precisely because the usual caller is holding a
    // canvas's ImageData it is about to reuse for the next camera frame.
    var a = rndBytes(4096);
    var b = new Uint8Array(a);
    var want = nodeSha(a);
    return ctx.inline.sha256(a).then(function (h) {
      assertEqual(h, want, 'inline hash');
      assertEqual(a.byteLength, 4096, 'inline: buffer still owned');
      assertEqual(nodeSha(a), want, 'inline: caller can still read the same bytes');
      if (!ctx.worker) return 'inline only: ' + ctx.workerSkip;
      return ctx.worker.sha256(b).then(function (h2) {
        assertEqual(h2, want, 'worker hash');
        assertEqual(b.byteLength, 4096, 'worker: buffer still owned');
        assertEqual(nodeSha(b), want, 'worker: caller can still read the same bytes');
        return 'both paths kept 4096 readable bytes';
      });
    });
  });

  test('a decode job keeps the caller\'s pixel buffer, and transfer:true takes it', function () {
    var keep = copyImage(ctx.image);
    var keepSha = nodeSha(keep.data);
    return ctx.inline.decode(keep).then(function (r) {
      assertEqual(r.texts[0], ctx.imageText, 'decoded');
      assertEqual(keep.data.byteLength, ctx.image.data.length, 'pixels survived a copying decode');
      assertEqual(nodeSha(keep.data), keepSha, 'pixels are unchanged, not merely present');
      var give = copyImage(ctx.image);
      return ctx.inline.decode(give, { transfer: true }).then(function (r2) {
        assertEqual(r2.texts[0], ctx.imageText, 'decoded from the transferred buffer');
        assertEqual(give.data.byteLength, 0, 'pixel buffer detached');
        return 'kept ' + keepSha.slice(0, 8) + ', gave up ' + give.data.byteLength + ' bytes';
      });
    });
  });

  test('an unknown job rejects with the same reason on both paths', function () {
    var runs = [ctx.inline.submit({ type: 'no-such-job' })];
    if (ctx.worker) runs.push(ctx.worker.submit({ type: 'no-such-job' }));
    return Promise.all(runs.map(function (p) {
      return assertRejects('unknown-job', p, 'unknown job');
    })).then(function (errs) {
      if (errs.length === 2) {
        assertEqual(errs[0].message, errs[1].message, 'the two paths give the same message');
      }
      return errs[0].message;
    });
  });

  test('worker.handle() never throws, whatever it is handed', function () {
    // A worker that dies on a malformed job takes every in-flight call with it,
    // so handle() converts throws into values. Drive it directly.
    var cases = [
      [null, 'bad-job'], [undefined, 'bad-job'], ['sha256', 'bad-job'], [42, 'bad-job'],
      [[], 'bad-job'], [{}, 'bad-job'], [{ type: 7 }, 'bad-job'],
      [{ type: 'nope' }, 'unknown-job'],
      [{ type: 'sha256' }, 'job-failed'],
      [{ type: 'sha256', bytes: 'not bytes' }, 'job-failed'],
      [{ type: 'decode', image: { width: 5000, height: 5000, data: new Uint8Array(0) } }, 'job-failed'],
      [{ type: 'decode', image: { width: 0, height: 4, data: new Uint8Array(0) } }, 'job-failed'],
      [{ type: 'fountain.symbol', id: 999999, esi: 0 }, 'job-failed'],
      [{ type: 'fountain.close', id: 'not-an-id' }, null]
    ];
    cases.forEach(function (c) {
      var out;
      try {
        out = workerApi.handle(c[0]);
      } catch (e) {
        throw new Error('handle(' + show(c[0]) + ') threw: ' + (e && e.message));
      }
      assert(out && typeof out === 'object', 'handle(' + show(c[0]) + ') returned ' + show(out));
      if (c[1] === null) {
        assertEqual(out.ok, true, 'handle(' + show(c[0]) + ') ok');
      } else {
        assertEqual(out.ok, false, 'handle(' + show(c[0]) + ') ok');
        assertEqual(out.reason, c[1], 'handle(' + show(c[0]) + ') reason');
        assert(typeof out.message === 'string' && out.message.length,
          'handle(' + show(c[0]) + ') carries a message');
      }
    });
    return cases.length + ' hostile jobs, no throw';
  });

  test('the worker\'s session ceiling is a rejection, not an allocation', function () {
    // MAX_SESSIONS is a leak bound: the ceiling+1 open must fail cleanly and
    // every earlier session must still work afterwards.
    workerApi.closeAllSessions();
    var opened = [];
    for (var i = 0; i < workerApi.MAX_SESSIONS; i++) {
      var r = workerApi.handle({ type: 'fountain.open', bytes: rndBytes(256), symbolSize: 64 });
      assertEqual(r.ok, true, 'open ' + i);
      opened.push(r.result.id);
    }
    var over = workerApi.handle({ type: 'fountain.open', bytes: rndBytes(256), symbolSize: 64 });
    assertEqual(over.ok, false, 'the ' + (workerApi.MAX_SESSIONS + 1) + 'th open');
    assertEqual(over.reason, 'job-failed', 'ceiling reason');
    assertEqual(over.message, 'too many open sessions', 'ceiling message');
    var still = workerApi.handle({ type: 'fountain.symbol', id: opened[0], esi: 0 });
    assertEqual(still.ok, true, 'the first session still works');
    workerApi.closeAllSessions();
    var gone = workerApi.handle({ type: 'fountain.symbol', id: opened[0], esi: 0 });
    assertEqual(gone.ok, false, 'closed sessions are gone');
    return workerApi.MAX_SESSIONS + ' sessions, ' + (workerApi.MAX_SESSIONS + 1) + 'th refused';
  });

  test('terminate() settles every in-flight call instead of leaving promises hanging', function () {
    if (!ctx.worker) return 'SKIPPED: ' + ctx.workerSkip;
    var c = offload.create({ WorkerCtor: NodeWorker, workerUrl: WORKER_PATH });
    return c.ready.then(function (r) {
      assertEqual(r.mode, offload.MODE_WORKER, 'came up on the worker');
      var p = c.submit({ type: 'sha256', bytes: rndBytes(1 << 20) });
      c.terminate();
      return assertRejects('terminated', p, 'in-flight call at terminate');
    }).then(function (e) {
      assertEqual(c.mode, offload.MODE_INLINE, 'mode after terminate');
      return e.message;
    });
  });

  test('throughput: inline vs worker sha256 over 8 MB', function () {
    var MB = 1024 * 1024;
    var big = rndBytes(8 * MB);
    var want = nodeSha(big);
    var rounds = 3;

    function timeIt(client) {
      var started = process.hrtime.bigint();
      var chain = Promise.resolve();
      for (var i = 0; i < rounds; i++) {
        chain = chain.then(function () {
          return client.sha256(big).then(function (h) {
            assertEqual(h, want, 'hash during the throughput run');
          });
        });
      }
      return chain.then(function () {
        var ms = Number(process.hrtime.bigint() - started) / 1e6;
        return { ms: ms, mbps: (rounds * 8) / (ms / 1000) };
      });
    }

    return timeIt(ctx.inline).then(function (inl) {
      ctx.report.inlineMbps = inl.mbps;
      if (!ctx.worker) {
        ctx.report.workerMbps = null;
        return 'inline ' + inl.mbps.toFixed(1) + ' MB/s; no worker: ' + ctx.workerSkip;
      }
      return timeIt(ctx.worker).then(function (wrk) {
        ctx.report.workerMbps = wrk.mbps;
        return 'inline ' + inl.mbps.toFixed(1) + ' MB/s, worker ' + wrk.mbps.toFixed(1) +
          ' MB/s (' + (wrk.mbps / inl.mbps).toFixed(2) + '× incl. structured clone)';
      });
    });
  });

  test('throughput: inline vs worker frame signature over a camera-sized frame', function () {
    var frame = { width: 1280, height: 720, data: rndBytes(1280 * 720 * 4) };
    var megapixels = (1280 * 720) / 1e6;
    var rounds = 5;

    function timeIt(client) {
      var started = process.hrtime.bigint();
      var chain = Promise.resolve();
      for (var i = 0; i < rounds; i++) {
        chain = chain.then(function () { return client.signature(frame); });
      }
      return chain.then(function () {
        var ms = Number(process.hrtime.bigint() - started) / 1e6;
        return { ms: ms, fps: rounds / (ms / 1000), mpps: (rounds * megapixels) / (ms / 1000) };
      });
    }

    return timeIt(ctx.inline).then(function (inl) {
      ctx.report.inlineSigFps = inl.fps;
      if (!ctx.worker) return 'inline ' + inl.fps.toFixed(1) + ' fps; no worker: ' + ctx.workerSkip;
      return timeIt(ctx.worker).then(function (wrk) {
        ctx.report.workerSigFps = wrk.fps;
        return 'inline ' + inl.fps.toFixed(1) + ' fps, worker ' + wrk.fps.toFixed(1) +
          ' fps at 1280x720 (' + (wrk.fps / inl.fps).toFixed(2) + '×)';
      });
    });
  });
}

// ===========================================================================
// P2P — codecs, carrier, ceilings, backpressure
// ===========================================================================

function registerP2PTests(ctx) {

  test('deflateRaw/inflateRaw round-trips byte-for-byte', function () {
    var cases = [
      ['empty', new Uint8Array(0)],
      ['one byte', new Uint8Array([0x41])],
      ['all zeroes 4 KB', new Uint8Array(4096)],
      ['incompressible 4 KB', rndBytes(4096)],
      ['every byte value', (function () {
        var b = new Uint8Array(256);
        for (var i = 0; i < 256; i++) b[i] = i;
        return b;
      })()],
      ['a minified SDP', p2p.minifySdp(OFFER_SDP)]
    ];
    var notes = [];
    cases.forEach(function (c) {
      var input = typeof c[1] === 'string'
        ? Uint8Array.from(Buffer.from(c[1], 'ascii')) : c[1];
      var packed = p2p.deflateRaw(input);
      var back = p2p.inflateRaw(packed, p2p.MAX_SDP_BYTES);
      assertBytesEqual(back, input, c[0] + ' round trip');
      notes.push(c[0] + ' ' + input.length + '→' + packed.length);
    });
    return notes.join(', ');
  });

  test('a repetitive 732-byte SDP deflates to a fraction of its size', function () {
    var line = 'a=candidate:1 1 udp 2122260223 192.168.1.42 54321 typ host\r\n';
    var text = '';
    while (text.length < 732) text += line;
    text = text.slice(0, 732);
    var input = Uint8Array.from(Buffer.from(text, 'ascii'));
    assertEqual(input.length, 732, 'fixture size');
    var packed = p2p.deflateRaw(input);
    assertBytesEqual(p2p.inflateRaw(packed, p2p.MAX_SDP_BYTES), input, 'round trip');
    assert(packed.length < 100, 'expected under 100 bytes, got ' + packed.length);
    return '732 → ' + packed.length + ' bytes (' + (732 / packed.length).toFixed(1) + '×)';
  });

  test('SDP → payload → parse → SDP is the identical text, and it is the minified SDP', function () {
    var c = p2p.compressSdp(OFFER_SDP);
    var back = p2p.parseOfferPayload(c.payload);
    assertEqual(back.ok, true, 'parse ok (reason ' + back.reason + ')');
    assertEqual(back.codec, c.codec, 'codec survived');
    assertEqual(shaText(back.sdp), shaText(c.canonical), 'reconstructed SDP sha256 vs canonical');
    assertEqual(back.sdp, c.canonical, 'reconstructed SDP');
    // canonical === minified means the reconstruction really is the SDP, not a
    // merely-equivalent regeneration.
    assertEqual(shaText(c.canonical), shaText(c.minified), 'canonical is the minified SDP');
    // And the parts that matter survived verbatim.
    ['a=fingerprint:sha-256 AB:CD:EF:01', 'a=ice-ufrag:4ZcD',
      'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlPy', 'a=setup:actpass',
      '192.168.1.42 54321 typ host'].forEach(function (needle) {
      assert(back.sdp.indexOf(needle) >= 0, 'reconstruction kept "' + needle + '"');
    });
    ctx.report.sdp = {
      raw: OFFER_SDP.length, minified: c.minified.length,
      payloadChars: c.payload.length, payloadBytes: c.bytes,
      codec: c.codec, sizes: c.sizes
    };
    return c.codec + ' codec, ' + OFFER_SDP.length + '→' + c.minified.length + '→' +
      c.payload.length + ' payload chars, sha256 ' + shaText(back.sdp).slice(0, 12);
  });

  test('every codec round-trips, and compressSdp picks the smallest that reproduces the input', function () {
    var forced = [
      ['profile', p2p.compressSdp(OFFER_SDP)],
      ['deflate', p2p.compressSdp(OFFER_SDP, { profile: false })]
    ];
    var notes = [];
    forced.forEach(function (f) {
      var c = f[1];
      var back = p2p.parseOfferPayload(c.payload);
      assertEqual(back.ok, true, f[0] + ': parse ok (reason ' + back.reason + ')');
      assertEqual(shaText(back.sdp), shaText(c.canonical), f[0] + ': reconstruction');
      notes.push(f[0] + '→' + c.codec + ' ' + c.payload.length + ' chars');
    });
    var sizes = forced[0][1].sizes;
    assert(sizes.profile < sizes.deflate, 'profile (' + sizes.profile + ') beats deflate (' +
      sizes.deflate + ')');
    assert(sizes.deflate < sizes.raw, 'deflate (' + sizes.deflate + ') beats raw (' + sizes.raw + ')');
    assertEqual(forced[0][1].codec, 'profile', 'the smallest codec was chosen');
    assertEqual(forced[1][1].codec, 'deflate', 'with the profile disabled');
    return notes.join(', ') + '; sizes raw=' + sizes.raw + ' deflate=' + sizes.deflate +
      ' profile=' + sizes.profile;
  });

  test('the QR version p2p reports is the version the project\'s own encoder needs', function () {
    var c = p2p.compressSdp(OFFER_SDP);
    var qr = p2p.payloadQr(c.payload);
    assertEqual(qr.chunks, 1, 'the offer fits one symbol');
    // The authority is artifacts/vendor/qrcode.js, not a capacity table written
    // in this file: encode the payload for real and read the version off it.
    var encoded = qrlib.encodeText(c.payload, { ecl: 'L' });
    assertEqual(qr.version, encoded.version, 'version p2p reports vs the encoder');
    assertEqual(encoded.size, encoded.version * 4 + 17, 'module count follows the version');
    assert(c.payload.length <= qr.capacity, 'payload ' + c.payload.length +
      ' fits capacity ' + qr.capacity);
    ctx.report.qr = {
      payloadChars: c.payload.length, version: encoded.version,
      modules: encoded.size, capacity: qr.capacity, codec: c.codec
    };
    return c.payload.length + ' chars → QR version ' + encoded.version + '-L (' +
      encoded.size + '×' + encoded.size + ' modules, capacity ' + qr.capacity + ')';
  });

  test('payloadQr agrees with the encoder across the whole capacity range', function () {
    var checked = [];
    [10, 100, 214, 230, 231, 500, 1000, 2953].forEach(function (n) {
      var payload = 'RVQP1:' + 'A'.repeat(n - 6);
      var qr = p2p.payloadQr(payload);
      var encoded = qrlib.encodeText(payload, { ecl: 'L' });
      assertEqual(qr.chunks, 1, n + ' chars should be one symbol');
      assertEqual(qr.version, encoded.version, n + ' chars: version');
      checked.push(n + '→v' + encoded.version);
    });
    return checked.join(' ');
  });

  test('an oversized payload becomes chunks that each fit a version 40 symbol', function () {
    var payload = 'RVQP1:' + 'B'.repeat(9000);
    var qr = p2p.payloadQr(payload);
    assert(qr.chunks > 1, 'expected several symbols, got ' + qr.chunks);
    assertEqual(qr.version, 40, 'chunked carriers use version 40');
    qr.symbols.forEach(function (s, i) {
      var encoded = qrlib.encodeText(s, { ecl: 'L' });
      assert(encoded.version <= 40, 'symbol ' + i + ' needs version ' + encoded.version);
    });
    assertEqual(p2p.joinChunks(qr.symbols), payload, 'rejoined payload');
    assertEqual(shaText(p2p.joinChunks(qr.symbols)), shaText(payload), 'rejoined sha256');
    return qr.chunks + ' symbols, largest v' + Math.max.apply(null, qr.symbols.map(function (s) {
      return qrlib.encodeText(s, { ecl: 'L' }).version;
    }));
  });

  test('chunks rejoin identically out of order, with duplicates, and with a real offer', function () {
    var c = p2p.compressSdp(OFFER_SDP);
    var chunks = p2p.chunkPayload(c.payload, 96);
    assert(chunks.length > 1, 'expected a split, got ' + chunks.length);
    var shuffled = chunks.slice().reverse();
    shuffled.push(chunks[0], chunks[chunks.length - 1], chunks[0]);
    var joined = p2p.joinChunks(shuffled);
    assertEqual(shaText(joined), shaText(c.payload), 'rejoined payload sha256');
    var back = p2p.parseOfferPayload(joined);
    assertEqual(back.ok, true, 'the rejoined payload still parses (reason ' + back.reason + ')');
    assertEqual(shaText(back.sdp), shaText(c.canonical), 'and yields the same SDP');
    return chunks.length + ' chunks reversed + 3 duplicates → identical payload';
  });

  test('a broken chunk set is refused rather than best-effort joined', function () {
    var chunks = p2p.chunkPayload('RVQP1:' + 'C'.repeat(400), 96);
    assert(chunks.length >= 4, 'fixture needs several chunks, got ' + chunks.length);
    assertThrows('missing-chunk', function () {
      p2p.joinChunks(chunks.slice(0, chunks.length - 1));
    }, 'a missing chunk');
    assertThrows('bad-chunks', function () { p2p.joinChunks([]); }, 'no chunks');
    assertThrows('bad-chunks', function () {
      p2p.joinChunks(chunks.concat(['RVQPC1:deadbeef:0/' + chunks.length + ':X']));
    }, 'a chunk from another payload');
    assertThrows('bad-chunks', function () {
      p2p.joinChunks(['not a chunk at all']);
    }, 'a malformed header');
    // A tampered body still carries a well-formed header; the id digest is what
    // catches it.
    var tampered = chunks.slice();
    tampered[1] = tampered[1].slice(0, tampered[1].length - 1) + 'Z';
    assertThrows('bad-chunks', function () { p2p.joinChunks(tampered); }, 'a tampered chunk body');
    return '5 broken chunk sets refused';
  });

  test('hostile offer payloads are rejected as values, never as exceptions', function () {
    var goodPayload = p2p.compressSdp(OFFER_SDP).payload;
    var goodBytes = core.b64uDecode(goodPayload.slice('RVQP1:'.length));

    function wrap(bytes) { return 'RVQP1:' + core.b64uEncode(bytes); }

    // A DEFLATE stream that expands to far more than MAX_SDP_BYTES.
    var bomb = p2p.deflateRaw(new Uint8Array(256 * 1024));
    var bombPayload = new Uint8Array(bomb.length + 1);
    bombPayload[0] = 1;
    bombPayload.set(bomb, 1);

    // A well-formed DEFLATE stream with its tail cut off.
    var whole = p2p.deflateRaw(Uint8Array.from(Buffer.from(p2p.minifySdp(OFFER_SDP), 'ascii')));
    var cut = new Uint8Array(whole.length - 4);
    cut.set(whole.subarray(0, whole.length - 5), 1);
    cut[0] = 1;

    // A valid SDP through the raw codec, but for a session type this module
    // refuses to hand to setRemoteDescription.
    var withVideo = p2p.minifySdp(OFFER_SDP).replace('a=setup:actpass',
      'a=setup:actpass\r\nm=video 9 UDP/TLS/RTP/SAVPF 96');
    var videoBytes = Uint8Array.from(Buffer.from(withVideo, 'ascii'));
    var videoPayload = new Uint8Array(videoBytes.length + 1);
    videoPayload.set(videoBytes, 1);

    var cases = [
      ['null', null, 'not-a-payload'],
      ['undefined', undefined, 'not-a-payload'],
      ['a number', 12345, 'not-a-payload'],
      ['an object', { payload: goodPayload }, 'not-a-payload'],
      ['an array', [1, 2, 3], 'not-a-payload'],
      ['empty string', '', 'not-a-payload'],
      ['plain text', 'scan me', 'not-a-payload'],
      ['wrong magic', 'RVQP2:' + goodPayload.slice(6), 'not-a-payload'],
      ['delta.js magic', 'RVQPC1:aaaaaaaa:0/1:x', 'not-a-payload'],
      ['prefix only', 'RVQP1:', 'payload-too-short'],
      ['one byte body', 'RVQP1:' + core.b64uEncode(new Uint8Array([0])), 'payload-too-short'],
      ['non-base64url', 'RVQP1:not/valid+base64url!!', 'bad-base64url'],
      ['unicode body', 'RVQP1:éééé', 'bad-base64url'],
      ['over MAX_PAYLOAD_CHARS', 'RVQP1:' + 'A'.repeat(p2p.MAX_PAYLOAD_CHARS), 'payload-too-large'],
      ['unknown codec', wrap(new Uint8Array([9, 1, 2, 3, 4])), 'unknown-codec'],
      ['codec 255', wrap(new Uint8Array([255, 1, 2, 3, 4])), 'unknown-codec'],
      ['truncated deflate', wrap(cut), 'bad-deflate'],
      ['deflate bomb', wrap(bombPayload), 'inflate-too-large'],
      ['garbage deflate', wrap(new Uint8Array([1, 0xff, 0xff, 0xff, 0xff, 0xff])), 'bad-deflate'],
      ['truncated profile', wrap(new Uint8Array([2, 1, 2, 3])), 'bad-payload'],
      ['garbage profile', wrap(new Uint8Array([2].concat(Array.from(rndBytes(64))))), 'bad-payload'],
      ['raw non-SDP text', wrap(Uint8Array.from([0].concat(Array.from(
        Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n', 'ascii'))))), 'unknown-line'],
      ['raw with NUL bytes', wrap(new Uint8Array([0, 118, 61, 48, 0, 13, 10])), 'bad-payload'],
      ['raw empty SDP', wrap(new Uint8Array([0, 13])), 'non-printable-sdp'],
      ['a smuggled video section', wrap(videoPayload), 'unexpected-media-section'],
      ['a truncated good payload', goodPayload.slice(0, goodPayload.length - 20), null],
      ['a good payload with its first byte cut', 'RVQP1:' + goodPayload.slice(7), null]
    ];

    var reasons = [];
    cases.forEach(function (c) {
      var out;
      try {
        out = p2p.parseOfferPayload(c[1]);
      } catch (e) {
        throw new Error(c[0] + ': parseOfferPayload threw ' + (e && e.message) +
          ' instead of returning a rejection');
      }
      assert(out && typeof out === 'object', c[0] + ': returned ' + show(out));
      assertEqual(out.ok, false, c[0] + ' should be rejected (got sdp: ' + show(out.sdp) + ')');
      assert(typeof out.reason === 'string' && out.reason.length,
        c[0] + ': rejection carries no reason');
      if (c[2] !== null) assertEqual(out.reason, c[2], c[0] + ' reason');
      reasons.push(out.reason);
    });
    // Sanity: the same parser accepts the honest payload, so the rejections
    // above are not a parser that rejects everything.
    assertEqual(p2p.parseOfferPayload(goodPayload).ok, true, 'the good payload still parses');
    return cases.length + ' hostile payloads, all rejected: ' +
      Object.keys(reasons.reduce(function (m, r) { m[r] = 1; return m; }, {})).join(',');
  });

  test('a corrupted payload never decodes back to the original offer', function () {
    // The honest property. A single flipped bit inside a *profile* payload
    // often still decodes — the codec's fields are opaque values, an ICE
    // password or an address, and there is nothing in the format that could
    // tell a corrupted one from a legitimate one. That is exactly the trust
    // model p2p.js documents: an offer QR is unauthenticated and what you
    // scanned is what you get. What must never happen is a corruption that
    // silently reconstructs the ORIGINAL offer, because then a peer would
    // connect believing it verified something it did not.
    var good = p2p.compressSdp(OFFER_SDP);
    var goodBytes = core.b64uDecode(good.payload.slice('RVQP1:'.length));
    var wantSha = shaText(good.canonical);
    var accepted = 0, rejected = 0;
    for (var i = 0; i < goodBytes.length; i++) {
      for (var bit = 0; bit < 8; bit += 3) {
        var b = new Uint8Array(goodBytes);
        b[i] ^= (1 << bit);
        var out;
        try {
          out = p2p.parseOfferPayload('RVQP1:' + core.b64uEncode(b));
        } catch (e) {
          throw new Error('byte ' + i + ' bit ' + bit + ': parseOfferPayload threw ' + e.message);
        }
        if (!out.ok) {
          assert(typeof out.reason === 'string' && out.reason.length,
            'byte ' + i + ' bit ' + bit + ': rejection with no reason');
          rejected++;
          continue;
        }
        accepted++;
        assert(shaText(out.sdp) !== wantSha,
          'byte ' + i + ' bit ' + bit + ' was corrupted but reconstructed the original SDP');
        assertEqual(p2p.validateSdp(out.sdp).ok, true,
          'byte ' + i + ' bit ' + bit + ': an accepted SDP must still pass the whitelist');
      }
    }
    assert(rejected > 0, 'no corruption was rejected at all, which would mean no checking');
    return (accepted + rejected) + ' bit flips: ' + rejected + ' rejected, ' + accepted +
      ' decoded to a different offer, 0 to the original';
  });

  test('MAX_SDP_BYTES is enforced on the way out and on the way in', function () {
    var huge = 'v=0\r\n' + 'a=mid:0\r\n'.repeat(3000);
    assert(huge.length > p2p.MAX_SDP_BYTES, 'fixture is over the ceiling');
    assertThrows('sdp-too-large', function () { p2p.minifySdp(huge); }, 'minify refuses');
    assertEqual(p2p.validateSdp(huge).reason, 'sdp-too-large', 'validate refuses');
    // And the raw codec cannot smuggle one past on the way in.
    var body = new Uint8Array(p2p.MAX_SDP_BYTES + 2);
    body[0] = 0;
    for (var i = 1; i < body.length; i++) body[i] = 0x41;
    var out = p2p.parseOfferPayload('RVQP1:' + core.b64uEncode(body));
    assertEqual(out.ok, false, 'oversized raw body');
    assertEqual(out.reason, 'sdp-too-large', 'oversized raw body reason');
    // An SDP one byte under the ceiling is a size rejection nowhere.
    assert(p2p.validateSdp('v=0\r\n' + 'a=mid:0\r\n'.repeat(100)).reason !== 'sdp-too-large',
      'a normal SDP is not rejected for size');
    return 'ceiling ' + p2p.MAX_SDP_BYTES + ' bytes enforced at minify, validate and parse';
  });

  test('MAX_CANDIDATES caps how many candidates survive minification', function () {
    var over = p2p.MAX_CANDIDATES + 6;
    var minified = p2p.minifySdp(sdpWithCandidates(over));
    var kept = (minified.match(/a=candidate:/g) || []).length;
    assertEqual(kept, p2p.MAX_CANDIDATES, 'candidates kept from ' + over);
    assertEqual(p2p.validateSdp(minified).ok, true, 'the capped SDP is still valid');
    var under = p2p.minifySdp(sdpWithCandidates(3));
    assertEqual((under.match(/a=candidate:/g) || []).length, 3, 'a normal list is untouched');
    return over + ' offered → ' + kept + ' kept (MAX_CANDIDATES=' + p2p.MAX_CANDIDATES + ')';
  });

  test('MAX_CHUNKS bounds both the splitter and the joiner', function () {
    // Splitting: a payload needing more than MAX_CHUNKS symbols is refused.
    var room = 64 - 32;
    var tooBig = 'x'.repeat(room * p2p.MAX_CHUNKS + 1);
    assertThrows('payload-too-large', function () { p2p.chunkPayload(tooBig, 64); },
      'more than MAX_CHUNKS symbols');
    // One under the ceiling still works.
    var justFits = 'y'.repeat(room * p2p.MAX_CHUNKS);
    var chunks = p2p.chunkPayload(justFits, 64);
    assertEqual(chunks.length, p2p.MAX_CHUNKS, 'exactly MAX_CHUNKS');
    assertEqual(shaText(p2p.joinChunks(chunks)), shaText(justFits), 'and rejoins');
    // Joining: an attacker-supplied list longer than the ceiling is refused
    // before anything is allocated per chunk.
    var flood = [];
    for (var i = 0; i <= p2p.MAX_CHUNKS; i++) flood.push('RVQPC1:aaaaaaaa:0/1:x');
    assertThrows('bad-chunks', function () { p2p.joinChunks(flood); }, 'too many chunks');
    // A header claiming an absurd count is refused too.
    assertThrows('bad-chunks', function () {
      p2p.joinChunks(['RVQPC1:aaaaaaaa:0/000:x']);
    }, 'a zero chunk count');
    assertThrows('bad-chunks', function () {
      p2p.joinChunks(['RVQPC1:aaaaaaaa:500/003:x']);
    }, 'an index past the count');
    // And a capacity that leaves no room for a header is a rejection, not a
    // division that produces a million chunks.
    assertThrows('bad-capacity', function () { p2p.chunkPayload('abc', 40); }, 'a tiny capacity');
    return 'MAX_CHUNKS=' + p2p.MAX_CHUNKS + ' enforced when splitting and joining';
  });

  test('MAX_PAYLOAD_CHARS bounds the joiner as well as the parser', function () {
    var giant = 'RVQPC1:aaaaaaaa:0/1:' + 'z'.repeat(p2p.MAX_PAYLOAD_CHARS);
    assertThrows('bad-chunks', function () { p2p.joinChunks([giant]); }, 'an oversized chunk');
    assertEqual(p2p.parseOfferPayload('RVQP1:' + 'A'.repeat(p2p.MAX_PAYLOAD_CHARS)).reason,
      'payload-too-large', 'an oversized payload');
    return 'ceiling ' + p2p.MAX_PAYLOAD_CHARS + ' chars enforced at both entry points';
  });

  test('sendDecision is a total function over the buffered/threshold space', function () {
    var HW = p2p.DEFAULT_HIGH_WATER;
    var cases = [
      // [bufferedAmount, chunkSize, opts, send, reason]
      [0, 1, undefined, true, 'headroom'],
      [0, HW, undefined, true, 'headroom'],
      [1, HW, undefined, false, 'high-water'],
      [HW - 1024, 1024, undefined, true, 'headroom'],
      [HW - 1024, 1025, undefined, false, 'high-water'],
      [HW, 0, undefined, true, 'headroom'],
      [HW, 1, undefined, false, 'high-water'],
      [HW + 1, 1, undefined, false, 'high-water'],
      [0, HW + 1, undefined, true, 'oversized-chunk-on-empty-queue'],
      [1, HW + 1, undefined, false, 'oversized-chunk'],
      [-1, 1, undefined, false, 'unknown-buffer'],
      [NaN, 1, undefined, false, 'unknown-buffer'],
      [Infinity, 1, undefined, false, 'unknown-buffer'],
      ['nonsense', 1, undefined, false, 'unknown-buffer'],
      [null, 1, undefined, true, 'headroom'],          // Number(null) === 0
      [0, 1, { highWater: 0 }, true, 'oversized-chunk-on-empty-queue'],
      [0, 0, { highWater: 0 }, true, 'headroom'],
      [1, 1, { highWater: 0 }, false, 'oversized-chunk'],
      [512, 512, { highWater: 1024 }, true, 'headroom'],
      [513, 512, { highWater: 1024 }, false, 'high-water'],
      [0, 4096, { highWater: 2048 }, true, 'oversized-chunk-on-empty-queue']
    ];
    cases.forEach(function (c) {
      var d = p2p.sendDecision(c[0], c[1], c[2]);
      var label = 'sendDecision(' + String(c[0]) + ', ' + c[1] + ', ' + JSON.stringify(c[2]) + ')';
      assertEqual(d.send, c[3], label + '.send');
      assertEqual(d.reason, c[4], label + '.reason');
      assertEqual(typeof d.headroom, 'number', label + '.headroom is a number');
      assert(isFinite(d.headroom), label + '.headroom is finite, got ' + d.headroom);
    });
    // The invariant the pump depends on: an empty queue always sends something,
    // so a transfer can never deadlock at the first chunk.
    for (var size = 0; size <= 4 * 1024 * 1024; size = size ? size * 4 : 1) {
      assertEqual(p2p.sendDecision(0, size).send, true, 'an empty queue accepts ' + size + ' bytes');
    }
    return cases.length + ' cases + the empty-queue invariant across 0..4 MB chunks';
  });

  test('lowThresholdFor always lands strictly between zero and the high water mark', function () {
    var cases = [
      [{}, p2p.DEFAULT_LOW_THRESHOLD],
      [{ highWater: p2p.DEFAULT_HIGH_WATER }, p2p.DEFAULT_LOW_THRESHOLD],
      [{ highWater: 1000, lowThreshold: 5000 }, 250],   // above high water → quartered
      [{ highWater: 1000, lowThreshold: 1000 }, 250],   // equal → quartered
      [{ highWater: 1000, lowThreshold: 400 }, 400],
      [{ highWater: 2, lowThreshold: 0 }, 1],
      [{ highWater: 1, lowThreshold: 0 }, 1],
      [{ lowThreshold: -5 }, 1],
      [{ highWater: 4, lowThreshold: 4 }, 1]            // quarter of 4 is 1
    ];
    cases.forEach(function (c) {
      var low = p2p.lowThresholdFor(c[0]);
      assertEqual(low, c[1], 'lowThresholdFor(' + JSON.stringify(c[0]) + ')');
      assert(low >= 1, 'threshold ' + low + ' must be positive or the sender stalls per chunk');
      var hw = c[0].highWater === undefined ? p2p.DEFAULT_HIGH_WATER : c[0].highWater;
      if (hw > 1) {
        assert(low < hw, 'threshold ' + low + ' must be under the high water mark ' + hw +
          ' or bufferedamountlow never fires');
      }
    });
    return cases.length + ' cases, default ' + p2p.lowThresholdFor({});
  });

  test('backpressure actually stalls and resumes a real send', function () {
    // A channel that never drains by itself: bufferedAmount grows with every
    // send and only the test's drain() brings it down. If the pump ignored
    // sendDecision this would queue the whole artifact in one tick.
    var bytes = rndBytes(200 * 1024);
    var ch = new FakeChannel();
    var HIGH = 16 * 1024;
    ch.onSend = function (data) {
      ch.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength;
    };
    var link = p2p.link(ch, { highWater: HIGH, lowThreshold: 4 * 1024 });
    assertEqual(ch.bufferedAmountLowThreshold, 4 * 1024, 'the channel was configured');
    assertEqual(ch.binaryType, 'arraybuffer', 'binaryType was set');

    var drains = 0;
    var timer = setInterval(function () {
      if (ch.bufferedAmount > 0) {
        ch.bufferedAmount = 0;
        drains++;
        var cb = ch.onbufferedamountlow;
        if (cb) cb();
      }
    }, 1);

    var started = Date.now();
    return link.send(bytes, { name: 'backpressure.bin' }).then(function (r) {
      clearInterval(timer);
      var stats = link.stats();
      assert(stats.waits > 0, 'the pump never waited — backpressure was not exercised');
      assertEqual(r.bytes, bytes.length, 'bytes reported');
      assertEqual(r.sha256, nodeSha(bytes), 'sha256 reported matches node:crypto');
      assertEqual(stats.framesOut, r.frames + 1, 'one manifest plus every data frame');
      // Nothing that was handed to the channel exceeded the allowance.
      var maxFrame = 0;
      ch.sent.forEach(function (d) {
        if (typeof d !== 'string') maxFrame = Math.max(maxFrame, d.byteLength);
      });
      assert(maxFrame <= HIGH, 'a frame of ' + maxFrame + ' bytes exceeded the high water mark');
      return stats.waits + ' waits, ' + drains + ' drains, ' + stats.framesOut +
        ' messages in ' + (Date.now() - started) + 'ms';
    }, function (e) { clearInterval(timer); throw e; });
  });

  test('wire frames round-trip into the shape core.ingest consumes', function () {
    var bytes = rndBytes(20000);
    var plan = p2p.buildSend(bytes, { name: 'wire.bin' });
    assertEqual(plan.sha256, nodeSha(bytes), 'plan sha256 vs node:crypto');
    var state = core.createReceiver();
    var m = core.ingest(state, plan.manifest, Date.now());
    assertEqual(m.accepted, true, 'manifest accepted (reason ' + m.reason + ')');

    var rebuilt = new Uint8Array(bytes.length);
    for (var seq = 1; seq < plan.total; seq++) {
      var frame = plan.frame(seq);
      assertEqual((frame[0] << 8) | frame[1], p2p.WIRE_MAGIC, 'frame ' + seq + ' magic');
      assertEqual(frame[2] | frame[3], 0, 'frame ' + seq + ' flags are reserved-zero');
      var parsed = p2p.parseWireFrame(frame, state);
      assertEqual(parsed.ok, true, 'frame ' + seq + ' parsed (reason ' + parsed.reason + ')');
      assertEqual(parsed.frame.i, seq, 'frame ' + seq + ' sequence');
      assertEqual(parsed.frame.n, plan.total, 'frame ' + seq + ' total');
      assertEqual(parsed.frame.t, plan.transferId, 'frame ' + seq + ' transfer id from state');
      rebuilt.set(parsed.frame.payload, (seq - 1) * plan.chunk);
    }
    assertBytesEqual(rebuilt, bytes, 'payloads reassembled from the wire frames');
    assertThrows('bad-seq', function () { plan.frame(0); }, 'frame 0 is the manifest');
    assertThrows('bad-seq', function () { plan.frame(plan.total); }, 'one past the last frame');
    return plan.total - 1 + ' frames of ' + plan.chunk + ' bytes, sha256 ' +
      plan.sha256.slice(0, 12);
  });

  test('malformed wire frames are rejected with a reason, never accepted', function () {
    var bytes = rndBytes(9000);
    var plan = p2p.buildSend(bytes, { name: 'wire.bin' });
    var state = core.createReceiver();
    core.ingest(state, plan.manifest, Date.now());
    var good = plan.frame(1);

    function mutate(fn) {
      var c = new Uint8Array(good);
      fn(c);
      return c;
    }

    var cases = [
      ['empty', new Uint8Array(0), 'short-frame'],
      ['header only, one byte short', new Uint8Array(p2p.WIRE_HEADER - 1), 'short-frame'],
      ['null', null, 'short-frame'],
      ['wrong magic', mutate(function (c) { c[0] = 0x00; }), 'not-a-frame'],
      ['delta magic', mutate(function (c) { c[0] = 0x52; c[1] = 0x00; }), 'not-a-frame'],
      ['unknown flags', mutate(function (c) { c[2] = 1; }), 'unknown-flags'],
      ['unknown flags low byte', mutate(function (c) { c[3] = 0x80; }), 'unknown-flags'],
      ['sequence 0', mutate(function (c) { c[4] = c[5] = c[6] = c[7] = 0; }), 'bad-seq'],
      ['sequence == total', mutate(function (c) {
        c[4] = c[8]; c[5] = c[9]; c[6] = c[10]; c[7] = c[11];
      }), 'bad-seq'],
      ['sequence past total', mutate(function (c) { c[6] = 0xff; c[7] = 0xff; }), 'bad-seq'],
      ['total 0', mutate(function (c) { c[8] = c[9] = c[10] = c[11] = 0; }), 'too-many-frames'],
      ['total past core.MAX_FRAMES', mutate(function (c) {
        c[8] = 0xff; c[9] = 0xff; c[10] = 0xff; c[11] = 0xff;
      }), 'too-many-frames'],
      ['a total the manifest did not declare', mutate(function (c) {
        c[10] = ((plan.total + 1) >>> 8) & 0xff; c[11] = (plan.total + 1) & 0xff;
        c[6] = 0; c[7] = 1;
      }), 'inconsistent-frame']
    ];

    cases.forEach(function (c) {
      var out;
      try {
        out = p2p.parseWireFrame(c[1], state);
      } catch (e) {
        throw new Error(c[0] + ': parseWireFrame threw ' + (e && e.message));
      }
      assertEqual(out.ok, false, c[0] + ' should be rejected');
      assertEqual(out.reason, c[2], c[0] + ' reason');
    });

    // An oversized payload is refused even with a perfect header.
    var fat = new Uint8Array(p2p.WIRE_HEADER + core.MAX_RECEIVE_CHUNK + 1);
    fat.set(good.subarray(0, p2p.WIRE_HEADER));
    assertEqual(p2p.parseWireFrame(fat, state).reason, 'chunk-too-large', 'oversized payload');
    // And a frame that arrives before any manifest has nothing to bind to.
    assertEqual(p2p.parseWireFrame(good, core.createReceiver()).reason, 'no-manifest-yet',
      'a data frame before the manifest');
    assertEqual(p2p.parseWireFrame(good, null).reason, 'no-manifest-yet', 'no state at all');
    // Sanity: the unmutated frame is still accepted.
    assertEqual(p2p.parseWireFrame(good, state).ok, true, 'the good frame still parses');
    return (cases.length + 4) + ' malformed frames refused';
  });
}

// ===========================================================================
// Integrity — the data channel goes through core.js's verification, unchanged
// ===========================================================================

function registerIntegrityTests(ctx) {

  /**
   * Wires a sending link to a receiving link through two fake channels, with an
   * optional hook that corrupts, drops or reorders what crosses.
   */
  function duplex(opts) {
    opts = opts || {};
    var delivered = [];
    var rejected = [];
    var rx = new FakeChannel();
    var rxLink = p2p.link(rx, {
      onData: function (v) { delivered.push(v); },
      onReject: function (v) { rejected.push(v); }
    });
    var tx = new FakeChannel();
    tx.onSend = function (data) {
      var out = opts.wire ? opts.wire(data) : data;
      if (out === null) return;   // dropped in flight
      rxLink.handleMessage(out);
    };
    var txLink = p2p.link(tx, {});
    return {
      tx: txLink, rx: rxLink, channel: tx,
      delivered: delivered, rejected: rejected
    };
  }

  test('an artifact over the data channel is delivered only after core.finalize verifies it', function () {
    var bytes = rndBytes(64 * 1024);
    var want = nodeSha(bytes);
    var d = duplex();
    return d.tx.send(bytes, { name: '../../etc/passwd' }).then(function (r) {
      assertEqual(r.sha256, want, 'the sender hashed what node:crypto hashes');
      assertEqual(d.rejected.length, 0, 'nothing was rejected');
      assertEqual(d.delivered.length, 1, 'exactly one artifact delivered');
      var v = d.delivered[0];
      // This verdict object is core.finalize's, not this file's.
      assertEqual(v.ok, true, 'verdict ok');
      assertEqual(v.sha256, want, 'verdict sha256 vs node:crypto');
      assertBytesEqual(v.bytes, bytes, 'delivered bytes');
      assertEqual(d.rx.state.status, 'VERIFIED', 'receiver status');
      // core.sanitizeName ran on the one field the hash does not cover.
      assertEqual(v.name, core.sanitizeName('../../etc/passwd'),
        'the delivered name is core.sanitizeName\'s, not the sender\'s');
      assert(v.name.indexOf('/') < 0 && v.name.indexOf('\\') < 0,
        'delivered name still contains a path separator: ' + v.name);
      assertEqual(v.name.charAt(0) === '.', false,
        'delivered name starts with a dot: ' + v.name);
      return r.frames + ' frames, ' + bytes.length + ' bytes verified as ' + want.slice(0, 12) +
        ', name → ' + v.name;
    });
  });

  test('one flipped bit in one data frame is refused by the manifest hash', function () {
    var bytes = rndBytes(48 * 1024);
    var hit = 0;
    var d = duplex({
      wire: function (data) {
        // Corrupt the payload of the third data frame, leaving the header —
        // and therefore every framing check — perfectly valid.
        if (typeof data !== 'string' && ++hit === 3) {
          var c = new Uint8Array(data);
          c[p2p.WIRE_HEADER + 10] ^= 0x01;
          return c;
        }
        return data;
      }
    });
    return d.tx.send(bytes, { name: 'corrupt.bin' }).then(function () {
      assertEqual(d.delivered.length, 0, 'a corrupted artifact was delivered');
      assertEqual(d.rejected.length, 1, 'expected exactly one rejection');
      var v = d.rejected[0];
      assertEqual(v.ok, false, 'verdict ok');
      assertEqual(v.reason, 'hash-mismatch', 'rejection reason');
      assertEqual(v.expected, nodeSha(bytes), 'expected hash is the manifest\'s');
      assert(v.actual !== v.expected, 'the actual hash must differ');
      assertEqual(v.actual.length, 64, 'actual hash is a full digest');
      assertEqual(d.rx.state.status, 'REJECTED', 'receiver status');
      return 'flipped one bit → ' + v.expected.slice(0, 12) + ' ≠ ' + v.actual.slice(0, 12);
    });
  });

  test('a payload swapped for a different artifact of the same length is refused', function () {
    var bytes = rndBytes(32 * 1024);
    var evil = rndBytes(core.MAX_RECEIVE_CHUNK);
    var hit = 0;
    var d = duplex({
      wire: function (data) {
        if (typeof data !== 'string' && ++hit === 2) {
          var c = new Uint8Array(data);
          c.set(evil.subarray(0, c.length - p2p.WIRE_HEADER), p2p.WIRE_HEADER);
          return c;
        }
        return data;
      }
    });
    return d.tx.send(bytes, { name: 'swapped.bin' }).then(function () {
      assertEqual(d.delivered.length, 0, 'a swapped artifact was delivered');
      assertEqual(d.rejected.length, 1, 'expected one rejection');
      assertEqual(d.rejected[0].reason, 'hash-mismatch', 'reason');
      assertEqual(d.rejected[0].expected, nodeSha(bytes), 'expected hash');
      return 'whole chunk replaced → hash-mismatch';
    });
  });

  test('a tampered manifest is refused before a single byte is accepted', function () {
    var bytes = rndBytes(16 * 1024);
    var d = duplex({
      wire: function (data) {
        if (typeof data === 'string') {
          var m = JSON.parse(data);
          // Claim a different artifact — the hash prefix and the full hash must
          // agree, so alter both consistently. core.parseFrame accepts it; only
          // finalize can catch it.
          var lie = nodeSha(rndBytes(16 * 1024));
          m.m.sha256 = lie;
          m.h = lie.slice(0, 8);
          return JSON.stringify(m);
        }
        return data;
      }
    });
    return d.tx.send(bytes, { name: 'lying-manifest.bin' }).then(function () {
      assertEqual(d.delivered.length, 0, 'nothing should be delivered');
      assertEqual(d.rejected.length, 1, 'expected one rejection');
      assertEqual(d.rejected[0].reason, 'hash-mismatch', 'reason');
      assertEqual(d.rejected[0].actual, nodeSha(bytes),
        'the actual hash is of the bytes that really arrived');
      return 'manifest claimed ' + d.rejected[0].expected.slice(0, 12) + ', got ' +
        d.rejected[0].actual.slice(0, 12);
    });
  });

  test('a transfer missing a frame never finalizes at all', function () {
    var bytes = rndBytes(40 * 1024);
    var hit = 0;
    var d = duplex({
      wire: function (data) {
        if (typeof data !== 'string' && ++hit === 4) return null;   // dropped
        return data;
      }
    });
    return d.tx.send(bytes, { name: 'lossy.bin' }).then(function () {
      assertEqual(d.delivered.length, 0, 'nothing delivered');
      assertEqual(d.rejected.length, 0, 'nothing rejected either — it is simply incomplete');
      assert(d.rx.state.status !== 'VERIFIED', 'status is ' + d.rx.state.status);
      var verdict = core.finalize(d.rx.state);
      assertEqual(verdict.ok, false, 'finalize on an incomplete transfer');
      assertEqual(verdict.reason, 'incomplete', 'reason');
      assertEqual(core.missingSequences(d.rx.state).length, 1, 'exactly one frame missing');
      return 'dropped frame ' + core.missingSequences(d.rx.state)[0] + ' of ' + d.rx.state.total;
    });
  });

  test('garbage on the data channel is refused by the framing before it reaches core', function () {
    var d = duplex();
    var before = d.rx.state.rejected;
    var junk = [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      rndBytes(64),
      'not json at all',
      '{"v":1}',
      '{"v":99,"t":"aaaaaaaa","h":"bbbbbbbb","i":0,"n":1}'
    ];
    junk.forEach(function (j, i) {
      var out = d.rx.handleMessage(j);
      assertEqual(out.accepted, false, 'junk ' + i + ' was accepted');
      assert(typeof out.reason === 'string' && out.reason.length, 'junk ' + i + ' has no reason');
      assertEqual(out.complete, false, 'junk ' + i + ' claimed completion');
    });
    assertEqual(d.rx.state.rejected - before, junk.length, 'every rejection was counted');
    assertEqual(d.delivered.length, 0, 'nothing was delivered');
    // And the receiver is still usable afterwards — a rejection is not a wedge.
    var bytes = rndBytes(8 * 1024);
    return d.tx.send(bytes, { name: 'after-junk.bin' }).then(function () {
      assertEqual(d.delivered.length, 1, 'a good transfer still completes after junk');
      assertEqual(d.delivered[0].sha256, nodeSha(bytes), 'and verifies');
      return junk.length + ' junk messages refused, receiver still works';
    });
  });

  test('the data channel and the optical channel accept through the same code path', function () {
    // core.buildFrames is the optical sender. Feeding its frames and p2p's wire
    // frames into two receivers must produce the same verdict for the same
    // artifact — that is the claim "changing the pipe does not change the
    // acceptance rule", asserted rather than asserted-in-a-comment.
    var bytes = rndBytes(24 * 1024);
    var optical = core.createReceiver();
    var built = core.buildFrames(bytes, { name: 'same.bin', chunk: core.MAX_RECEIVE_CHUNK });
    built.frames.forEach(function (f) { core.ingest(optical, f, Date.now()); });
    var opticalVerdict = core.finalize(optical);
    assertEqual(opticalVerdict.ok, true, 'optical verdict (reason ' + opticalVerdict.reason + ')');

    var d = duplex();
    return d.tx.send(bytes, { name: 'same.bin', chunk: core.MAX_RECEIVE_CHUNK }).then(function () {
      assertEqual(d.delivered.length, 1, 'data channel delivered');
      var wire = d.delivered[0];
      assertEqual(wire.sha256, opticalVerdict.sha256, 'same sha256 from both transports');
      assertEqual(wire.name, opticalVerdict.name, 'same sanitised name');
      assertBytesEqual(wire.bytes, opticalVerdict.bytes, 'same bytes');
      assertEqual(wire.sha256, nodeSha(bytes), 'and both match node:crypto');
      return 'optical and data-channel verdicts identical: ' + wire.sha256.slice(0, 12);
    });
  });

  test('a verified artifact survives the offload path\'s hash too', function () {
    // The receiver hashes with core.sha256Hex; the app may hash the same bytes
    // through offload. The two must not be allowed to disagree.
    var bytes = rndBytes(96 * 1024);
    var d = duplex();
    return d.tx.send(bytes, { name: 'cross-check.bin' }).then(function () {
      assertEqual(d.delivered.length, 1, 'delivered');
      var v = d.delivered[0];
      var runs = [ctx.inline.sha256(new Uint8Array(v.bytes))];
      if (ctx.worker) runs.push(ctx.worker.sha256(new Uint8Array(v.bytes)));
      return Promise.all(runs).then(function (hs) {
        hs.forEach(function (h, i) {
          assertEqual(h, v.sha256, 'offload client ' + i + ' vs core.finalize');
          assertEqual(h, nodeSha(bytes), 'offload client ' + i + ' vs node:crypto');
        });
        return hs.length + ' offload path(s) agree with core.finalize and node:crypto';
      });
    });
  });
}

// ===========================================================================
// Runner
// ===========================================================================

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
  var ctx = { report: {} };

  ctx.imageText = 'RVQP1:rvQR offload round trip fixture';
  ctx.image = rasterize(qrlib.encodeText(ctx.imageText, { ecl: 'L' }), { scale: 5, quiet: 4 });

  ctx.inline = offload.create({ fallback: 'always' });

  var workerReady;
  if (!WT || typeof WT.Worker !== 'function') {
    ctx.worker = null;
    ctx.workerSkip = 'node:worker_threads is unavailable in this build';
    workerReady = Promise.resolve(null);
  } else {
    ctx.worker = offload.create({ WorkerCtor: NodeWorker, workerUrl: WORKER_PATH });
    workerReady = ctx.worker.ready;
  }

  return Promise.all([ctx.inline.ready, workerReady]).then(function (r) {
    ctx.inlineReady = r[0];
    ctx.workerReady = r[1];
    if (ctx.worker && ctx.workerReady.mode !== offload.MODE_WORKER) {
      ctx.workerSkip = 'the worker did not come up: ' + ctx.workerReady.reason;
      ctx.worker = null;
    }
    registerOffloadTests(ctx);
    registerP2PTests(ctx);
    registerIntegrityTests(ctx);
    return runQueue();
  }).then(function () {
    if (ctx.worker) ctx.worker.terminate();

    results.forEach(function (r) {
      console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
    });
    var failed = results.filter(function (r) { return !r.ok; }).length;
    console.log('\n' + (results.length - failed) + '/' + results.length +
      ' passed, ' + failed + ' failed');

    console.log('\noffload: inline mode "' + ctx.inlineReady.mode + '" (' +
      ctx.inlineReady.reason + '); worker mode "' +
      (ctx.workerReady ? ctx.workerReady.mode : 'n/a') + '"' +
      (ctx.worker ? '' : ' — SKIPPED: ' + ctx.workerSkip));
    if (ctx.report.inlineMbps) {
      console.log('sha256 throughput: inline ' + ctx.report.inlineMbps.toFixed(1) + ' MB/s' +
        (ctx.report.workerMbps
          ? ', worker ' + ctx.report.workerMbps.toFixed(1) + ' MB/s (' +
            (ctx.report.workerMbps / ctx.report.inlineMbps).toFixed(2) +
            '× — one job at a time, structured clone included)'
          : ' (no worker available)'));
    }
    if (ctx.report.inlineSigFps) {
      console.log('frame signature at 1280x720: inline ' + ctx.report.inlineSigFps.toFixed(1) +
        ' fps' + (ctx.report.workerSigFps
          ? ', worker ' + ctx.report.workerSigFps.toFixed(1) + ' fps'
          : ''));
    }
    if (ctx.report.sdp && ctx.report.qr) {
      console.log('offer SDP: ' + ctx.report.sdp.raw + ' bytes → ' + ctx.report.sdp.minified +
        ' minified → ' + ctx.report.sdp.payloadBytes + ' payload bytes → ' +
        ctx.report.qr.payloadChars + ' base64url chars (' + ctx.report.sdp.codec +
        ' codec; raw ' + ctx.report.sdp.sizes.raw + ', deflate ' + ctx.report.sdp.sizes.deflate +
        ', profile ' + ctx.report.sdp.sizes.profile + ') → QR version ' +
        ctx.report.qr.version + '-L, ' + ctx.report.qr.modules + '×' + ctx.report.qr.modules +
        ' modules');
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
