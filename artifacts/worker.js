/*!
 * rvQR worker — the expensive half of the pipeline, moved off the main thread.
 *
 * On a phone the main thread is already running a camera preview, a render
 * loop and the QR painter. Decoding a frame, hashing a file and building
 * fountain symbols are all long synchronous burns, and every one of them lands
 * in the same queue as the next animation frame. This module is the code that
 * runs somewhere else.
 *
 * It is deliberately NOT a worker-only file. The job table is a plain function
 * of plain data — `handle(job)` — so the identical code runs three ways:
 *
 *   1. inside a real Worker, via listen() (the fast path);
 *   2. inline on the main thread, when Workers are unavailable or blocked
 *      (offload.js's fallback — the app loses parallelism, never a feature);
 *   3. under Node `require`, which is how the test suite proves 1 and 2 agree.
 *
 * Nothing here touches the DOM, and no job holds state between messages except
 * the explicitly-opened fountain sessions, which exist only because building a
 * fountain encoder means solving a matrix and you do not want to pay for that
 * once per symbol.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;

  function optionalRequire(id) {
    try { return require(id); } catch (e) { return null; }
  }

  var deps;
  if (isNode) {
    deps = {
      core: require('./core.js'),
      fountain: optionalRequire('./fountain.js'),
      delta: optionalRequire('./delta.js'),
      qrdec: optionalRequire('./vendor/qrdecode.js')
    };
  } else {
    // Inside a worker none of the page's scripts are loaded, so pull them in.
    // On a page they already are, and importScripts does not exist — the same
    // file therefore works as a worker entry point and as a plain <script>.
    // importScripts is also the first thing a restrictive CSP kills, so a
    // failure here has to surface as a worker error the client can fall back
    // from, not as a half-initialised module that answers wrongly.
    if (typeof importScripts === 'function' && !root.RVQRCore) {
      importScripts(
        'core.js',
        'vendor/qrcode.js',
        'vendor/qrdecode.js',
        'fountain.js',
        'delta.js'
      );
    }
    deps = {
      core: root.RVQRCore,
      fountain: root.RVQRFountain || null,
      delta: root.RVQRDelta || null,
      qrdec: root.RVQRDecode || null
    };
  }

  var api = factory(deps);
  if (isNode) module.exports = api;
  else root.RVQRWorker = api;

  // A DedicatedWorkerGlobalScope has both postMessage and importScripts; a
  // Window has postMessage but not importScripts. That pair is the cheapest
  // reliable discriminator, and it keeps this file inert when the app loads it
  // as an ordinary script for the inline path.
  if (!isNode &&
      typeof root.postMessage === 'function' &&
      typeof root.importScripts === 'function') {
    api.listen(root);
  }
})(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  var core = deps.core;
  var fountain = deps.fountain;
  var delta = deps.delta;
  var qrdec = deps.qrdec;

  // Bumped when the message shape changes. offload.js refuses a worker whose
  // hello does not match, because a stale cached worker answering a newer
  // protocol is worse than no worker at all.
  var PROTOCOL = 1;

  // --- Session ceilings ------------------------------------------------------
  // Jobs originate in our own app rather than from a camera, so these are not
  // hostile-input bounds — they are leak bounds. A session is an encoder or a
  // decoder holding a whole artifact plus its solved matrix; forgetting to
  // close one on a page that never reloads is how a tab reaches a gigabyte.

  var MAX_SESSIONS = 8;
  var MAX_SESSION_BYTES = 64 * 1024 * 1024;

  // Largest image a decode job will accept. 4096x4096 RGBA is 64 MB, well past
  // any camera frame; anything larger is a bug in the caller, not a photo.
  var MAX_IMAGE_PIXELS = 4096 * 4096;

  var sessions = Object.create(null);
  var nextSessionId = 1;
  var sessionBytes = 0;

  // --- Argument coercion -----------------------------------------------------

  /**
   * Normalises whatever structured clone delivered into a Uint8Array without
   * copying. A transferred argument arrives as a bare ArrayBuffer; a cloned
   * one arrives as the view it was sent as; the inline path hands over the
   * caller's own view untouched.
   */
  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (value && typeof value === 'object' && value.buffer &&
        typeof value.byteLength === 'number') {
      return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new TypeError('expected a byte container');
  }

  function asInt(value, name, min, max) {
    var n = Number(value);
    if (!isFinite(n) || Math.floor(n) !== n) throw new TypeError(name + ' must be an integer');
    if (n < min || n > max) throw new RangeError(name + ' out of range');
    return n;
  }

  /**
   * Returns a Uint8Array that owns its whole buffer, so the buffer can be
   * handed to postMessage as a transferable without dragging a larger backing
   * store along or neutering something a caller still holds.
   */
  function ownBuffer(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
    return bytes.slice();
  }

  // --- Sessions --------------------------------------------------------------

  function openSession(kind, value, bytes) {
    var live = 0, id;
    for (id in sessions) live++;
    if (live >= MAX_SESSIONS) throw new Error('too many open sessions');
    if (sessionBytes + bytes > MAX_SESSION_BYTES) throw new Error('session memory ceiling reached');
    id = nextSessionId++;
    sessions[id] = { kind: kind, value: value, bytes: bytes };
    sessionBytes += bytes;
    return id;
  }

  function useSession(id, kind) {
    var s = sessions[id];
    if (!s) throw new Error('no such session: ' + id);
    if (s.kind !== kind) throw new Error('session ' + id + ' is a ' + s.kind + ', not a ' + kind);
    return s.value;
  }

  function closeSession(id) {
    var s = sessions[id];
    if (!s) return false;
    sessionBytes -= s.bytes;
    delete sessions[id];
    return true;
  }

  function closeAllSessions() {
    var id;
    for (id in sessions) closeSession(id);
  }

  // --- Jobs ------------------------------------------------------------------
  // Every handler returns { result, transfer } — `transfer` lists buffers this
  // side is finished with, so postMessage can move rather than copy them. A
  // buffer only ever appears there if the worker created it.

  var JOBS = {
    /** Liveness plus what this build can actually do. */
    'ping': function () {
      return { result: capabilities(), transfer: [] };
    },

    /**
     * SHA-256 over a byte array. The app's own hashBytes() prefers
     * crypto.subtle, which is already async and already off-thread — this job
     * is for the file:// and insecure-context cases where subtle is missing
     * and core's synchronous implementation would otherwise stall the frame.
     */
    'sha256': function (job) {
      var bytes = asBytes(job.bytes);
      var digest = core.sha256Bytes(bytes);
      return {
        result: { hex: core.toHex(digest), digest: digest, length: bytes.length },
        transfer: [digest.buffer]
      };
    },

    /**
     * QR decode over raw pixels. Takes an ImageData-shaped { width, height,
     * data } rather than an ImageData, because ImageData is not constructible
     * in every worker context and the plain object clones the same way.
     */
    'decode': function (job) {
      if (!qrdec) throw new Error('no QR decoder in this build');
      var image = job.image || {};
      var width = asInt(image.width, 'image.width', 1, 65535);
      var height = asInt(image.height, 'image.height', 1, 65535);
      if (width * height > MAX_IMAGE_PIXELS) throw new RangeError('image too large');
      var data = asBytes(image.data);
      if (data.length < width * height * 4) throw new RangeError('image data is short');
      var frame = { width: width, height: height, data: data };
      var results = qrdec.decodeImage(frame, {
        all: job.all !== false,
        invert: job.invert === true
      });
      var texts = [];
      for (var i = 0; i < results.length; i++) {
        if (results[i] && results[i].ok && typeof results[i].text === 'string') {
          texts.push(results[i].text);
        }
      }
      return { result: { texts: texts, count: texts.length }, transfer: [] };
    },

    /**
     * The keyframe gate's signature. Cheap on its own, but it runs on every
     * camera frame, and doing it here means the pixel buffer never has to
     * cross back.
     */
    'signature': function (job) {
      var image = job.image || {};
      var width = asInt(image.width, 'image.width', 1, 65535);
      var height = asInt(image.height, 'image.height', 1, 65535);
      if (width * height > MAX_IMAGE_PIXELS) throw new RangeError('image too large');
      var sig = core.frameSignature(
        { width: width, height: height, data: asBytes(image.data) },
        job.size
      );
      return { result: { signature: sig }, transfer: [sig.buffer] };
    },

    /** Builds a fountain encoder and keeps it; the matrix solve happens once. */
    'fountain.open': function (job) {
      if (!fountain) throw new Error('no fountain codec in this build');
      var bytes = asBytes(job.bytes);
      var symbolSize = asInt(job.symbolSize, 'symbolSize', 1, core.MAX_RECEIVE_CHUNK);
      var enc = fountain.encoder(bytes, symbolSize);
      var id = openSession('encoder', enc, bytes.length);
      return {
        result: {
          id: id, K: enc.K, symbolSize: enc.symbolSize, totalBytes: enc.totalBytes
        },
        transfer: []
      };
    },

    /** One encoding symbol from an open encoder. */
    'fountain.symbol': function (job) {
      var enc = useSession(job.id, 'encoder');
      var sym = enc.symbol(asInt(job.esi, 'esi', 0, fountain.MAX_ESI - 1));
      var bytes = ownBuffer(sym.bytes);
      return { result: { esi: sym.esi, bytes: bytes }, transfer: [bytes.buffer] };
    },

    /**
     * A run of symbols in one round trip. The send loop paints a symbol every
     * ~700ms; asking for the next dozen up front costs one message instead of
     * twelve and keeps the encoder ahead of the painter.
     */
    'fountain.symbols': function (job) {
      var enc = useSession(job.id, 'encoder');
      var from = asInt(job.from, 'from', 0, fountain.MAX_ESI - 1);
      var count = asInt(job.count, 'count', 1, 256);
      var out = [], transfer = [];
      for (var i = 0; i < count && from + i < fountain.MAX_ESI; i++) {
        var sym = enc.symbol(from + i);
        var bytes = ownBuffer(sym.bytes);
        out.push({ esi: sym.esi, bytes: bytes });
        transfer.push(bytes.buffer);
      }
      return { result: { symbols: out }, transfer: transfer };
    },

    /** Opens a decoder for a declared source block. */
    'fountain.decoder': function (job) {
      if (!fountain) throw new Error('no fountain codec in this build');
      var K = asInt(job.K, 'K', 1, fountain.MAX_SYMBOLS);
      var symbolSize = asInt(job.symbolSize, 'symbolSize', 1, core.MAX_RECEIVE_CHUNK);
      var totalBytes = asInt(job.totalBytes, 'totalBytes', 0, MAX_SESSION_BYTES);
      var dec = fountain.decoder(K, symbolSize, totalBytes);
      var id = openSession('decoder', dec, K * symbolSize);
      return { result: { id: id, K: K, symbolSize: symbolSize }, transfer: [] };
    },

    /**
     * One decode step: fold a symbol in and report whether the block became
     * recoverable. This is the job that most wants to be off-thread — the
     * elimination runs on the same tick as the camera otherwise.
     */
    'fountain.add': function (job) {
      var dec = useSession(job.id, 'decoder');
      var decodable = dec.add({
        esi: asInt(job.esi, 'esi', 0, fountain.MAX_ESI - 1),
        bytes: asBytes(job.bytes)
      }) === true;
      return {
        result: { decodable: decodable, received: dec.received, needed: dec.needed },
        transfer: []
      };
    },

    /** The recovered object, or null while the block is still short. */
    'fountain.decode': function (job) {
      var dec = useSession(job.id, 'decoder');
      var out = dec.decode();
      if (!out) return { result: { bytes: null }, transfer: [] };
      var bytes = ownBuffer(out);
      return { result: { bytes: bytes }, transfer: [bytes.buffer] };
    },

    'fountain.close': function (job) {
      return { result: { closed: closeSession(job.id) }, transfer: [] };
    },

    /**
     * Delta segment hashing: the span plan for an RVF container, which is a
     * SHA-256 per segment plus one over the whole container. On a multi-
     * megabyte container that is the single longest burn in the delta path.
     *
     * The wasm parser cannot cross a postMessage boundary, so a worker run
     * uses delta.js's byte-faithful JS scanner. The app should keep using the
     * microkernel for anything authoritative and treat this as what it is: the
     * same span boundaries, computed by the fallback parser.
     */
    'delta.spans': function (job) {
      if (!delta) throw new Error('no delta module in this build');
      var bytes = asBytes(job.bytes);
      var inv = delta.inventory(bytes, { hashBytes: job.hashBytes });
      return { result: { inventory: inv }, transfer: [] };
    }
  };

  function capabilities() {
    return {
      protocol: PROTOCOL,
      jobs: Object.keys(JOBS),
      decode: !!qrdec,
      fountain: !!fountain,
      delta: !!delta
    };
  }

  /**
   * Runs one job. Never throws: a thrown handler becomes { ok:false, reason },
   * because a worker that dies on a malformed job takes every in-flight call
   * with it, and the caller cannot tell "this job failed" from "the worker is
   * gone" once that has happened.
   */
  function handle(job) {
    if (!job || typeof job !== 'object' || typeof job.type !== 'string') {
      return { ok: false, reason: 'bad-job', message: 'job must be an object with a type' };
    }
    var fn = JOBS[job.type];
    if (!fn) return { ok: false, reason: 'unknown-job', message: 'unknown job: ' + job.type };
    try {
      var out = fn(job);
      return { ok: true, result: out.result, transfer: out.transfer || [] };
    } catch (e) {
      return {
        ok: false,
        reason: 'job-failed',
        message: e && e.message ? e.message : String(e)
      };
    }
  }

  /**
   * Wires handle() to a worker scope. The hello message is the handshake:
   * offload.js waits for it before trusting the worker, so a scope that dies
   * during importScripts never gets counted as available.
   */
  function listen(scope) {
    scope.onmessage = function (event) {
      var msg = event && event.data;
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return;
      var out = handle(msg.job);
      var reply = {
        id: msg.id,
        ok: out.ok,
        result: out.ok ? out.result : undefined,
        reason: out.ok ? undefined : out.reason,
        message: out.ok ? undefined : out.message
      };
      try {
        scope.postMessage(reply, out.transfer || []);
      } catch (e) {
        // A result that will not clone (it should not happen, but a decoder
        // returning something exotic would) must still produce a reply, or the
        // caller waits for ever.
        scope.postMessage({
          id: msg.id, ok: false, reason: 'reply-failed',
          message: e && e.message ? e.message : String(e)
        });
      }
    };
    scope.postMessage({ hello: PROTOCOL, capabilities: capabilities() });
  }

  return {
    PROTOCOL: PROTOCOL,
    MAX_SESSIONS: MAX_SESSIONS,
    MAX_SESSION_BYTES: MAX_SESSION_BYTES,
    MAX_IMAGE_PIXELS: MAX_IMAGE_PIXELS,
    jobs: JOBS,
    capabilities: capabilities,
    handle: handle,
    listen: listen,
    closeAllSessions: closeAllSessions
  };
});
