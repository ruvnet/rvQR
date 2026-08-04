/*!
 * rvQR streaming receive pipeline — ADR-025 §2.3, and only the part of ADR-025
 * that this repository can honestly be held to.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXES, AND WHAT IT WAS MEASURED AT
 * ---------------------------------------------------------------------------
 *
 * ADR-025 §2.2 sets three budgets. The one this file exists for is **fewer than
 * two full payload copies**: "one unavoidable read, one unavoidable write;
 * anything else is a defect."
 *
 * The shipped receivers are over it, and have been since the budget was first
 * measured. On standalone.html at 1,183,759 B, `bench/lib/memprobe.mjs` reports
 * the receiver holding **2.59× the artifact on v1 and 2.42× on v2** — retained
 * live bytes after a forced collection, so those are copies that genuinely
 * coexist, not allocator noise. The cause is visible in the code rather than
 * inferred from the number:
 *
 *   1. `ingest` drains every frame into `state.chunks`      →  1× the artifact
 *   2. `assemble` allocates the whole output while (1) is still live → +1×
 *   3. `sha256Bytes` allocates a padded copy of (2)         → +1× transiently
 *
 * Three full copies alive at the moment of verification, to deliver one
 * artifact. That is exactly the shape ADR-025 §2.3 names: "verifying a 1 GB
 * container by first assembling it in memory blows a 128 MiB budget by a factor
 * of eight."
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 * ---------------------------------------------------------------------------
 *
 * One preallocated output buffer, and a digest that advances as bytes land.
 *
 *   - The manifest allocates `out` once, at the declared size. There is no
 *     chunk list, so there is never a moment where the chunks and the assembled
 *     artifact are both alive.
 *   - Each data frame's payload is written straight into `out` at its offset
 *     and then dropped. A frame's payload is live for the duration of one
 *     `ingest` call and no longer.
 *   - The SHA-256 runs over a HASH FRONTIER: the longest contiguous prefix of
 *     `out` that has actually arrived. It reads views of `out` — `subarray`, not
 *     `slice` — so hashing costs nothing in memory. The hasher is incremental
 *     (`createSha256` below), so it never allocates the padded copy core.js's
 *     one-shot `sha256Bytes` does.
 *   - Because the frontier reaches the end of the artifact inside the `ingest`
 *     call that delivers the last missing byte, the digest is already decided
 *     when `finalize` is called. On a mismatch the output is released THERE,
 *     not at `finalize`: §2.3's "the artifact is never simultaneously complete
 *     and unverified in memory", with a window of zero.
 *
 * Out-of-order and duplicate arrival still work, which is the whole point of
 * having a frontier rather than requiring a stream. Frames may land in any
 * order; the frontier advances in bursts as gaps fill, and a duplicate is
 * counted and discarded without being written or hashed twice.
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT (ADR-025 criterion 1)
 * ---------------------------------------------------------------------------
 *
 * "Copy count is asserted, not inspected. An instrumented build counts full
 * payload copies per transfer and fails the test above 2."
 *
 * Every byte-buffer the receiver allocates or retains is registered with a
 * ledger at the allocation site: acquired when it becomes live, released when
 * the last reference is dropped. The ledger tracks the running total and its
 * MAXIMUM, and `copyReport` divides that maximum by the artifact size. Copies
 * that coexist are what the budget is about, so the peak is the number, never
 * the sum.
 *
 * The instrument is exact arithmetic over byte lengths, not a sampled
 * measurement: it is deterministic, it needs no `--expose-gc`, and it runs on
 * every transfer rather than in a special build. `assertCopyBudget` throws
 * above 2, and pipeline.test.js calls it — so the criterion fails the test
 * rather than reporting a number into a log.
 *
 * It deliberately over-counts rather than under-counts: the frame index bitmap
 * and the hasher's 64-byte carry block are charged to the receiver even though
 * neither is payload.
 *
 * `measureBuffered` runs the SAME ledger over the shipped `core`/`proto2`
 * receivers, so the instrument is shown to fail something before it is trusted
 * to pass something. One honest difference in method, stated rather than
 * buried: on the streaming path the ledger is called AT the allocation, so it
 * observes. On the buffered path the two allocations inside `assemble` and
 * `sha256Bytes` are not reachable from outside those functions, so the ledger
 * is told about them from what the source demonstrably allocates —
 * `new Uint8Array(size)` in core.js `assemble`, and `new Uint8Array(total)` in
 * `sha256Bytes` where `total` is the 64-byte-aligned padded length. That is a
 * model, and pipeline.test.js corroborates it against a forced-collection
 * measurement whenever `--expose-gc` is available.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT, AND WHY — ADR-025 criteria 2, 3 AND 6
 * ---------------------------------------------------------------------------
 *
 * ADR-025 specifies a RUST pipeline: memory mapping, SIMD BLAKE3, SIMD
 * compression, 4–8 bounded streams. rvQR is a JavaScript static site. Three of
 * the seven acceptance criteria therefore cannot be met here, and are recorded
 * as not applicable WITH THE REASON rather than quietly dropped. They are
 * machine-readable in `ADR025_CRITERIA` below so the omission cannot become
 * silent later:
 *
 *   2. Peak RSS under 128 MiB for a 1 GB transfer — NOT APPLICABLE. The optical
 *      channel runs at 2.44 KB/s (docs/benchmarks.md), so 1 GB is 4.7 days of
 *      continuous transfer. There is no 1 GB run to measure and fabricating one
 *      would be reporting a number nobody paid for. The peak-RSS budget IS
 *      measured, on the largest artifact that exists here: 75.2 MiB against
 *      128 MiB, and it is green.
 *   3. Internal throughput ≥ 2× the radio ceiling — NOT APPLICABLE. There is no
 *      radio tier in this repository, so there is no ceiling to be twice as
 *      fast as. ADR-027 lists the radio tier among the non-goals.
 *   6. Scalar fallback exercised on every SIMD path — NOT APPLICABLE. There are
 *      no SIMD paths. There are no intrinsics, no wasm-simd, and no build
 *      matrix; every routine here is scalar and is the only implementation.
 *
 * Criteria 1, 4, 5 and 7 are applicable. This file addresses 1 and 5; 4 belongs
 * to ADR-033's offload path and 7 to CI.
 *
 * ---------------------------------------------------------------------------
 * SCOPE LIMITS, STATED RATHER THAN DISCOVERED
 * ---------------------------------------------------------------------------
 *
 *   - Indexed transfers only. A fountain transfer has no fixed offset per
 *     symbol, so there is nothing to stream into; it is refused by name
 *     (`fountain-unsupported`) rather than mis-handled.
 *   - Uncompressed transfers only. v2 may declare a codec, and the manifest
 *     digest covers the DECODED artifact, so streaming the digest would mean
 *     streaming the decompressor too. Refused by name
 *     (`codec-unsupported`), which is what ADR-025 §2.3's bounded
 *     decompression would have to be built on and is not built here.
 *   - ONE BEHAVIOURAL DIFFERENCE from the shipped receivers, stated because it
 *     is the price of the budget rather than an oversight. core.js and
 *     proto2.js queue data frames that arrive before the manifest, without
 *     bound; this one queues at most a quarter of the transfer and refuses the
 *     rest by name (`manifest-pending-overflow`). An unbounded queue is a
 *     second full copy of the artifact — the instrument measured exactly that,
 *     at 2.0036 copies, when this bound was first written as a flat 256 KiB.
 *     A receiver that joins a cycle late therefore completes on the sender's
 *     next cycle instead of the current one: one cycle of time, not a failed
 *     transfer. Out-of-order and duplicate arrival among data frames is
 *     unaffected and is tested to death.
 *   - Nothing in this file is wired into the app. It is a receiver, complete
 *     and tested, and the wiring is a separate step.
 *
 * Browser: load core.js and proto2.js first. Node: require('./pipeline.js').
 *
 * MIT License. Copyright (c) 2026 rUv.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./proto2.js'));
  } else {
    root.RVQRPipeline = factory(root.RVQRCore, root.RVQRProto2);
  }
})(typeof self !== 'undefined' ? self : this, function (core, proto2) {
  'use strict';

  // ADR-025 §2.2. "Fewer than 2" and criterion 1's "fails above 2" are the same
  // line for a ledger that counts bytes exactly: a receiver holding the chunk
  // list and the assembled output sits at exactly 2.000, and is refused.
  var COPY_BUDGET = 2;

  // SHA-256's block size. The hasher's carry buffer is one block, and the
  // frontier only ever absorbs whole blocks until the final one, so in practice
  // the carry buffer stays empty and no payload byte is ever copied into it.
  var BLOCK_BYTES = 64;

  // How much data may be held before the manifest arrives.
  //
  // A data frame that turns up first has nowhere to go: the output buffer's
  // size is not known until the manifest states it. A queue is the obvious
  // answer and it is the same defect this file exists to remove, reintroduced
  // at the front — the instrument caught exactly that, at 2.0036 copies, when
  // this bound was a flat 256 KiB and a 40 KB artifact arrived manifest-last.
  // Every byte in the queue is a byte that will also exist in the output.
  //
  // So the bound is RELATIVE, not absolute, because an absolute bound cannot
  // work: for any fixed number of bytes there is an artifact smaller than it,
  // and for that artifact the queue is a second full copy. The queue is capped
  // at a fraction of the frame count — `total` is on every frame, is bounded by
  // the parser, and the manifest re-checks it against the size — so the cap is
  // a fraction of the ARTIFACT however large the artifact turns out to be.
  // The absolute byte cap remains as a second bound, for a frame that lies
  // about `total`.
  //
  // The cost, stated: a receiver that joins the cycle more than a quarter of
  // the way before the manifest discards the rest of that cycle. The sender
  // loops, so those frames come round again, and it costs one cycle of time
  // rather than a failed transfer. ADR-015 §2.3 puts the memory budget among
  // the invariants a policy may not trade away; this is what not trading it
  // away looks like at the one place a streaming receiver can leak.
  var DEFAULT_PENDING_FRACTION = 0.25;
  var DEFAULT_PENDING_LIMIT = 256 * 1024;

  /**
   * The four criteria this repository can be held to, and the three it cannot,
   * with the reason attached to each. Exported so a test can assert the not-
   * applicable ones are still declared: a criterion that quietly disappears
   * from a report reads exactly like a criterion that was met.
   */
  var ADR025_CRITERIA = [
    {
      id: 1,
      title: 'Copy count is asserted, not inspected',
      status: 'met',
      where: 'createLedger/copyReport/assertCopyBudget, asserted in pipeline.test.js'
    },
    {
      id: 2,
      title: 'Peak RSS under 128 MiB for a 1 GB transfer',
      status: 'not-applicable',
      reason:
        'the optical channel runs at 2.44 KB/s, so a 1 GB transfer is 4.7 days; ' +
        'there is no such run in this repository and inventing one would be a ' +
        'fabricated measurement. The budget itself is measured on the largest ' +
        'artifact that exists here — 75.2 MiB of 128 MiB — by bench/suites/memory.mjs'
    },
    {
      id: 3,
      title: 'Internal throughput at least 2x the measured radio ceiling',
      status: 'not-applicable',
      reason: 'there is no radio tier in this repository, so there is no ceiling to be twice'
    },
    {
      id: 4,
      title: 'The offload regression is gone (ADR-033 §4.1)',
      status: 'out-of-scope-here',
      reason: 'belongs to artifacts/offload.js, not to the receive path'
    },
    {
      id: 5,
      title: 'Streaming verification is byte-exact against the buffered result',
      status: 'met',
      where: 'pipeline.test.js compares bytes and digest on both demo artifacts, v1 and v2'
    },
    {
      id: 6,
      title: 'The scalar fallback is exercised in CI on every SIMD path',
      status: 'not-applicable',
      reason:
        'there are no SIMD paths: no intrinsics, no wasm-simd, no build matrix. ' +
        'Every routine here is scalar and is the only implementation, so there is ' +
        'no second path that could rot unexercised'
    },
    {
      id: 7,
      title: 'The budget is checked in CI',
      status: 'partial',
      reason: 'assertCopyBudget fails the suite; wiring the suite into CI is a separate step'
    }
  ];

  // --- Incremental SHA-256 ---------------------------------------------------
  // core.js's sha256Bytes is one-shot AND allocates a padded copy of its whole
  // input, which is the third full copy in the measurement at the top of this
  // file. Nothing in this codebase offers a synchronous incremental digest —
  // crypto.subtle is asynchronous and has no streaming interface in a browser —
  // so one is written here rather than the payload being buffered to hash it.
  // Buffering to hash would have defeated the entire exercise.
  //
  // The algorithm is FIPS 180-4, and it is the same round function core.js
  // already contains; what differs is that state persists across calls and the
  // padding is built into a 64- or 128-byte scratch instead of over a copy of
  // the message. pipeline.test.js checks it against core.sha256Hex at every
  // length that exercises a different padding case, and over both demo
  // artifacts, so "same algorithm" is asserted rather than asserted-by-eye.

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  var HEX = '0123456789abcdef';

  /**
   * A streaming SHA-256. `update` accepts any view — including a subarray of a
   * buffer the caller already owns, which is the whole point: hashing the
   * output buffer in place costs no memory at all.
   */
  function createSha256() {
    var h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var w = new Uint32Array(64);
    var carry = new Uint8Array(BLOCK_BYTES);
    var carryLen = 0;
    var total = 0;
    var blocks = 0;
    var updates = 0;
    var carriedBytes = 0;
    var finished = null;

    function compress(m, off) {
      var i, t;
      for (i = 0; i < 16; i++) {
        w[i] =
          (m[off + i * 4] << 24) |
          (m[off + i * 4 + 1] << 16) |
          (m[off + i * 4 + 2] << 8) |
          m[off + i * 4 + 3];
      }
      for (t = 16; t < 64; t++) {
        var w15 = w[t - 15], w2 = w[t - 2];
        var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];
      for (var j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e;
        e = (d + temp1) >>> 0;
        d = c; c = b; b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
      blocks++;
    }

    function update(view) {
      if (finished) throw new Error('sha256: update after digest');
      var n = view.length;
      if (!n) return;
      updates++;
      total += n;
      var i = 0;
      if (carryLen) {
        var take = Math.min(BLOCK_BYTES - carryLen, n);
        carry.set(view.subarray(0, take), carryLen);
        carriedBytes += take;
        carryLen += take;
        i = take;
        if (carryLen === BLOCK_BYTES) {
          compress(carry, 0);
          carryLen = 0;
        }
      }
      for (; i + BLOCK_BYTES <= n; i += BLOCK_BYTES) compress(view, i);
      if (i < n) {
        carry.set(view.subarray(i), 0);
        carryLen = n - i;
        carriedBytes += carryLen;
      }
    }

    function digest() {
      if (finished) return finished;
      // The same padding core.js computes, over at most two blocks instead of
      // over a copy of the message: 0x80, zeros, then the 64-bit length.
      var withPad = carryLen + 9;
      var tailLen = withPad <= BLOCK_BYTES ? BLOCK_BYTES : 2 * BLOCK_BYTES;
      var tail = new Uint8Array(tailLen);
      tail.set(carry.subarray(0, carryLen));
      tail[carryLen] = 0x80;
      var bitLenHi = Math.floor(total / 0x20000000) | 0;
      var bitLenLo = (total << 3) >>> 0;
      tail[tailLen - 8] = (bitLenHi >>> 24) & 255;
      tail[tailLen - 7] = (bitLenHi >>> 16) & 255;
      tail[tailLen - 6] = (bitLenHi >>> 8) & 255;
      tail[tailLen - 5] = bitLenHi & 255;
      tail[tailLen - 4] = (bitLenLo >>> 24) & 255;
      tail[tailLen - 3] = (bitLenLo >>> 16) & 255;
      tail[tailLen - 2] = (bitLenLo >>> 8) & 255;
      tail[tailLen - 1] = bitLenLo & 255;
      for (var off = 0; off < tailLen; off += BLOCK_BYTES) compress(tail, off);
      var out = new Uint8Array(32);
      for (var k = 0; k < 8; k++) {
        out[k * 4] = (h[k] >>> 24) & 255;
        out[k * 4 + 1] = (h[k] >>> 16) & 255;
        out[k * 4 + 2] = (h[k] >>> 8) & 255;
        out[k * 4 + 3] = h[k] & 255;
      }
      finished = out;
      return out;
    }

    function digestHex() {
      var d = digest();
      var s = '';
      for (var i = 0; i < d.length; i++) {
        s += HEX.charAt(d[i] >>> 4) + HEX.charAt(d[i] & 15);
      }
      return s;
    }

    return {
      update: update,
      digest: digest,
      digestHex: digestHex,
      /** Diagnostics, so a test can assert HOW the digest was computed. */
      stats: function () {
        return {
          bytes: total,
          blocks: blocks,
          updates: updates,
          // Payload bytes that had to be copied into the carry block because a
          // run did not end on a 64-byte boundary. The frontier keeps this at
          // zero until the final run, which is the point of aligning it.
          carriedBytes: carriedBytes,
          carryBytes: BLOCK_BYTES
        };
      }
    };
  }

  /** One-shot over the streaming hasher. Allocates 96 bytes, not len + padding. */
  function sha256Hex(bytes) {
    var s = createSha256();
    s.update(bytes);
    return s.digestHex();
  }

  /** What core.sha256Bytes allocates for `len` bytes of input: len + padding. */
  function paddedLength(len) {
    var withPad = len + 9;
    return withPad + ((BLOCK_BYTES - (withPad % BLOCK_BYTES)) % BLOCK_BYTES);
  }

  // --- The copy ledger -------------------------------------------------------

  function createLedger() {
    return {
      artifactBytes: 0,
      live: 0,
      peak: 0,
      acquired: 0,
      released: 0,
      writeBytes: 0,
      hashBytes: 0,
      byKind: Object.create(null)
    };
  }

  function acquire(ledger, kind, bytes) {
    ledger.live += bytes;
    ledger.acquired++;
    if (ledger.live > ledger.peak) ledger.peak = ledger.live;
    ledger.byKind[kind] = (ledger.byKind[kind] || 0) + bytes;
    return { kind: kind, bytes: bytes, open: true };
  }

  function release(ledger, handle) {
    if (!handle || !handle.open) return null;
    handle.open = false;
    ledger.live -= handle.bytes;
    ledger.released++;
    return null;
  }

  /**
   * The copy count, and the two pass counts either side of it.
   *
   * `copies` is the PEAK of live receiver-held bytes over the transfer, in
   * multiples of the artifact — the quantity ADR-025 §2.2 bounds, because the
   * budget is about copies that coexist and a sum of stage deltas is not that.
   *
   * `writePasses` and `hashPasses` are the other half of §2.2's sentence, made
   * literal: one write pass over the payload into the output buffer, one read
   * pass over it for the digest. Both should be exactly 1.
   */
  function copyReport(ledger, label) {
    var n = ledger.artifactBytes;
    var copies = n > 0 ? ledger.peak / n : NaN;
    return {
      label: label || null,
      artifactBytes: n,
      peakLiveBytes: ledger.peak,
      copies: copies,
      budget: COPY_BUDGET,
      withinBudget: n > 0 && copies < COPY_BUDGET,
      writeBytes: ledger.writeBytes,
      writePasses: n > 0 ? ledger.writeBytes / n : NaN,
      hashBytes: ledger.hashBytes,
      hashPasses: n > 0 ? ledger.hashBytes / n : NaN,
      openHandles: ledger.acquired - ledger.released,
      byKind: ledger.byKind
    };
  }

  /**
   * ADR-025 criterion 1, as a thrown error rather than a logged number.
   * A report at or above 2 full payload copies is a failure, not a note.
   */
  function assertCopyBudget(report) {
    if (!(report.artifactBytes > 0)) {
      throw new Error('copy budget: nothing was measured (artifactBytes = ' + report.artifactBytes + ')');
    }
    if (!report.withinBudget) {
      throw new Error(
        'copy budget exceeded' + (report.label ? ' [' + report.label + ']' : '') + ': ' +
          report.copies.toFixed(4) + ' full payload copies (' + report.peakLiveBytes +
          ' B peak live over ' + report.artifactBytes + ' B artifact), budget is fewer than ' +
          report.budget
      );
    }
    return report;
  }

  // --- Protocol adapters -----------------------------------------------------
  // The streaming receiver is one state machine over two wire formats. Each
  // adapter parses and then normalises to a single shape; nothing below this
  // point knows whether a frame arrived as JSON or as a binary header.

  function unsupportedManifest(reason) {
    return { unsupported: reason };
  }

  var V1 = {
    name: 'v1',
    parse: function (input) {
      if (input && typeof input === 'object' && input.kind) return { ok: true, frame: input };
      return core.parseFrame(input);
    },
    view: function (f) {
      var out = {
        kind: f.kind,
        index: f.i,
        total: f.n,
        transferId: f.t,
        binding: f.h,
        payload: f.payload || null,
        manifest: null,
        unsupported: null
      };
      if (f.kind !== 'manifest') {
        // A symbol has no fixed offset, so there is nothing to stream it into.
        if (f.mode === core.MODE_FOUNTAIN) out.unsupported = 'fountain-unsupported';
        return out;
      }
      if ((f.m.mode || core.MODE_INDEXED) !== core.MODE_INDEXED) {
        out.manifest = unsupportedManifest('fountain-unsupported');
        return out;
      }
      out.manifest = {
        size: f.m.size,
        chunkSize: f.m.chunk,
        sha256: f.m.sha256,
        name: f.m.name
      };
      return out;
    },
    buffered: {
      create: function () { return core.createReceiver(); },
      ingest: function (state, frame) { return core.ingest(state, frame); },
      // core.finalize takes a hex-returning hash function.
      finalize: function (state, hashBytesFn) {
        return core.finalize(state, function (b) { return core.toHex(hashBytesFn(b)); });
      },
      declaredSize: function (state) { return state.manifest ? state.manifest.size : 0; }
    }
  };

  var V2 = {
    name: 'v2',
    parse: function (input) {
      if (input && typeof input === 'object' && input.kind) return { ok: true, frame: input };
      return proto2.parseFrame(input);
    },
    view: function (f) {
      var out = {
        kind: f.kind,
        index: f.index,
        total: f.total,
        transferId: f.transferId,
        binding: f.contentHash32,
        payload: f.kind === 'manifest' ? null : f.payload,
        manifest: null,
        unsupported: null
      };
      if (f.kind !== 'manifest') {
        if (f.mode !== proto2.MODE_INDEXED) out.unsupported = 'fountain-unsupported';
        return out;
      }
      if (f.mode !== proto2.MODE_INDEXED) {
        out.manifest = unsupportedManifest('fountain-unsupported');
        return out;
      }
      if (f.codecId !== proto2.CODEC_NONE) {
        // The manifest digest covers the DECODED artifact, so a streamed digest
        // would have to stream the decompressor too. ADR-025 §2.3's bounded
        // decompression is what that needs and it is not built here.
        out.manifest = unsupportedManifest('codec-unsupported');
        return out;
      }
      out.manifest = {
        size: f.manifest.originalSize,
        chunkSize: f.manifest.chunkSize,
        sha256: f.manifest.sha256,
        name: f.manifest.name
      };
      return out;
    },
    buffered: {
      create: function () { return proto2.createReceiver(); },
      ingest: function (state, frame) { return proto2.ingest(state, frame); },
      // proto2.finalize takes a digest-bytes-returning hash function.
      finalize: function (state, hashBytesFn) {
        return proto2.finalize(state, { hashFn: hashBytesFn });
      },
      declaredSize: function (state) { return state.manifest ? state.manifest.originalSize : 0; }
    }
  };

  // --- The streaming receiver ------------------------------------------------

  function createReceiver(adapter, opts) {
    opts = opts || {};
    var ledger = createLedger();
    var state = {
      adapter: adapter,
      status: 'IDLE',
      transferId: null,
      binding: null,
      total: 0,
      manifest: null,
      size: 0,
      chunkSize: 0,
      expectedSha256: null,
      out: null,
      outHandle: null,
      present: null,
      presentHandle: null,
      received: 0,
      duplicates: 0,
      rejected: 0,
      // The frontier: nextIndex is the first data frame not yet contiguous,
      // hashedUpTo is how far into `out` the digest has actually reached.
      nextIndex: 1,
      hashedUpTo: 0,
      hasher: createSha256(),
      digestHex: null,
      digestMatches: null,
      pending: [],
      pendingBytes: 0,
      pendingLimitBytes:
        opts.pendingLimitBytes === undefined ? DEFAULT_PENDING_LIMIT : opts.pendingLimitBytes,
      pendingFraction:
        opts.pendingFraction === undefined ? DEFAULT_PENDING_FRACTION : opts.pendingFraction,
      ledger: ledger,
      result: null
    };
    // Charged even though it is not payload: the ledger over-counts by
    // preference, so a number it reports as green is green with room.
    acquire(ledger, 'hash-carry', BLOCK_BYTES);
    return state;
  }

  function isComplete(state) {
    return !!state.manifest && state.received === state.total - 1;
  }

  function reject(state, reason) {
    state.rejected++;
    return { accepted: false, reason: reason, complete: isComplete(state) };
  }

  function duplicate(state) {
    state.duplicates++;
    return { accepted: false, reason: 'duplicate', complete: isComplete(state) };
  }

  /**
   * Advances the hash frontier as far as the contiguous prefix reaches.
   *
   * Only whole 64-byte blocks are absorbed until the artifact is complete, so
   * the hasher's carry buffer stays empty and no payload byte is ever copied
   * into it. The final run absorbs the ragged tail.
   */
  function advance(state) {
    while (state.nextIndex < state.total && state.present[state.nextIndex]) state.nextIndex++;
    var avail = Math.min((state.nextIndex - 1) * state.chunkSize, state.size);
    var target = avail === state.size ? state.size : avail - (avail % BLOCK_BYTES);
    if (target > state.hashedUpTo) {
      state.hasher.update(state.out.subarray(state.hashedUpTo, target));
      state.ledger.hashBytes += target - state.hashedUpTo;
      state.hashedUpTo = target;
    }
    if (state.hashedUpTo === state.size && state.digestHex === null && isComplete(state)) {
      settle(state);
    }
  }

  /**
   * The digest is decided the instant the last byte lands, inside the ingest
   * call that delivered it. ADR-025 §2.3: on a mismatch the output is released
   * HERE, so a complete-and-unverified artifact never exists.
   */
  function settle(state) {
    state.digestHex = state.hasher.digestHex();
    state.digestMatches = state.digestHex === state.expectedSha256;
    if (state.digestMatches) {
      state.status = 'COMPLETE';
    } else {
      state.status = 'REJECTED';
      state.out = null;
      state.outHandle = release(state.ledger, state.outHandle);
    }
  }

  function writeAt(state, index, payload) {
    if (index < 1 || index >= state.total) return reject(state, 'bad-index');
    if (state.present[index]) return duplicate(state);
    var offset = (index - 1) * state.chunkSize;
    var want = Math.min(state.chunkSize, state.size - offset);
    // A frame whose payload does not fill the slot the manifest reserved for it
    // is refused rather than padded: a short frame and a mis-stated length are
    // the same event from here, and neither is repairable.
    if (payload.length !== want) return reject(state, 'payload-length-mismatch');
    if (!state.out) return reject(state, 'transfer-already-rejected');
    state.out.set(payload, offset);
    state.ledger.writeBytes += payload.length;
    state.present[index] = 1;
    state.received++;
    advance(state);
    return { accepted: true, reason: null, complete: isComplete(state) };
  }

  function flushPending(state) {
    var queued = state.pending;
    state.pending = [];
    state.pendingBytes = 0;
    queued.sort(function (a, b) { return a.index - b.index; });
    for (var i = 0; i < queued.length; i++) {
      writeAt(state, queued[i].index, queued[i].payload);
      queued[i].payload = null;
      release(state.ledger, queued[i].handle);
    }
  }

  function adopt(state, f) {
    state.status = 'COLLECTING';
    state.transferId = f.transferId;
    state.binding = f.binding;
    state.total = f.total;
  }

  /**
   * Feeds one frame into the receiver. Accepts what the underlying parser
   * accepts — a v1 frame string, v2 frame bytes or armour, or a pre-parsed
   * frame — and mutates state in place.
   */
  function ingest(state, input) {
    if (state.status === 'REJECTED' || state.status === 'VERIFIED') {
      return { accepted: false, reason: 'transfer-closed', complete: isComplete(state) };
    }
    var parsed = state.adapter.parse(input);
    if (!parsed.ok) return reject(state, parsed.reason);
    var f = state.adapter.view(parsed.frame);
    if (f.unsupported) return reject(state, f.unsupported);

    if (state.status === 'IDLE') {
      adopt(state, f);
    } else if (f.transferId !== state.transferId) {
      return reject(state, 'other-transfer');
    } else if (f.binding !== state.binding || f.total !== state.total) {
      return reject(state, 'inconsistent-frame');
    }

    if (f.kind === 'manifest') {
      if (state.manifest) return duplicate(state);
      var m = f.manifest;
      if (m.unsupported) return reject(state, m.unsupported);
      // The frame count has to follow from the size and the chunk, or sender
      // and receiver disagree about the artifact before a byte is written.
      // Both parsers check this already; it is re-checked because the
      // allocation below is derived from it.
      if (1 + Math.ceil(m.size / m.chunkSize) !== state.total) {
        return reject(state, 'frame-count-mismatch');
      }
      state.manifest = m;
      state.size = m.size;
      state.chunkSize = m.chunkSize;
      state.expectedSha256 = m.sha256;
      state.ledger.artifactBytes = m.size;
      // The one allocation of the transfer. Nothing else ever holds a full
      // copy of the artifact, which is the whole of ADR-025 §2.2 here.
      state.out = new Uint8Array(m.size);
      state.outHandle = acquire(state.ledger, 'output', m.size);
      state.present = new Uint8Array(state.total);
      state.presentHandle = acquire(state.ledger, 'frame-index', state.total);
      flushPending(state);
      advance(state);
      return { accepted: true, reason: null, complete: isComplete(state) };
    }

    if (!state.manifest) {
      // Nowhere to put it yet. Held, bounded by a FRACTION of the transfer —
      // see DEFAULT_PENDING_FRACTION — and refused by name past the bound.
      // The sender loops, so a refused frame comes round again.
      var frameCap = Math.floor((state.total - 1) * state.pendingFraction);
      if (state.pending.length >= frameCap ||
          state.pendingBytes + f.payload.length > state.pendingLimitBytes) {
        return reject(state, 'manifest-pending-overflow');
      }
      // The parser already handed us an owned copy (v1 base64 decode, v2
      // payload.slice), so keeping it costs nothing beyond what already exists.
      state.pending.push({
        index: f.index,
        payload: f.payload,
        handle: acquire(state.ledger, 'pending-payload', f.payload.length)
      });
      state.pendingBytes += f.payload.length;
      return { accepted: true, reason: 'awaiting-manifest', complete: false };
    }

    // The payload is live for exactly the duration of this write and no longer.
    var handle = acquire(state.ledger, 'frame-payload', f.payload.length);
    try {
      return writeAt(state, f.index, f.payload);
    } finally {
      release(state.ledger, handle);
    }
  }

  /**
   * Hands over the artifact, or says why not.
   *
   * This performs no hashing and no assembly — both finished inside the ingest
   * call that delivered the last byte. It is a handover, which is what makes
   * ADR-025 §2.3's "never simultaneously complete and unverified" true with a
   * window of zero rather than merely brief.
   */
  function finalize(state) {
    if (state.status === 'VERIFIED' && state.result) return state.result;
    if (state.status === 'REJECTED' && state.digestMatches === false) {
      state.result = {
        ok: false,
        reason: 'hash-mismatch',
        expected: state.expectedSha256,
        actual: state.digestHex
      };
      return state.result;
    }
    if (!isComplete(state)) return { ok: false, reason: 'incomplete' };
    if (state.digestHex === null) return { ok: false, reason: 'digest-incomplete' };
    state.status = 'VERIFIED';
    state.result = {
      ok: true,
      bytes: state.out,
      sha256: state.digestHex,
      // The name is the one manifest field the digest does not cover, so it is
      // clamped and stripped here rather than trusted downstream — the same
      // rule core.finalize applies.
      name: core.sanitizeName(state.manifest.name),
      declaredName: state.manifest.name,
      copies: copyReport(state.ledger, state.adapter.name + ' streaming receiver')
    };
    return state.result;
  }

  /** Every index still missing, for a receiver that wants to ask for them. */
  function missingSequences(state, limit) {
    var out = [];
    if (!state.present) return out;
    for (var i = 1; i < state.total; i++) {
      if (!state.present[i]) {
        out.push(i);
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }

  // --- The control arm -------------------------------------------------------

  /**
   * Runs the SHIPPED receiver for a protocol under the same ledger, so the
   * instrument is shown to fail something before it is trusted to pass
   * anything.
   *
   * Three allocations are charged, and the reason each one is charged is that
   * the source demonstrably makes it:
   *
   *   chunk-list       every accepted data payload, retained in `state.chunks`
   *                    until the transfer ends. Observed: the payload length
   *                    comes from the frame this function parsed.
   *   assemble-output  `new Uint8Array(size)` inside assemble(). Modelled: the
   *                    allocation is not reachable from outside, and the size
   *                    is the manifest's.
   *   sha256-padding   `new Uint8Array(total)` inside core.sha256Bytes, where
   *                    total is the 64-byte-aligned padded length. Modelled the
   *                    same way, and charged only for the duration of the hash,
   *                    because that is how long it lives.
   *
   * pipeline.test.js corroborates the model against a forced-collection
   * measurement whenever --expose-gc is available, and says so when it is not.
   */
  function measureBuffered(adapter, frames, opts) {
    opts = opts || {};
    var ledger = createLedger();
    var state = adapter.buffered.create();
    var accepted = 0;
    var order = opts.order || null;

    function feed(i) {
      var parsed = adapter.parse(frames[i]);
      if (!parsed.ok) return;
      var view = adapter.view(parsed.frame);
      var res = adapter.buffered.ingest(state, parsed.frame);
      if (!res.accepted) return;
      if (view.kind === 'manifest') {
        ledger.artifactBytes = view.manifest && !view.manifest.unsupported ? view.manifest.size : 0;
      } else {
        acquire(ledger, 'chunk-list', view.payload.length);
        accepted++;
      }
    }

    if (order) {
      for (var j = 0; j < order.length; j++) feed(order[j]);
    } else {
      for (var i = 0; i < frames.length; i++) feed(i);
    }

    var size = adapter.buffered.declaredSize(state);
    if (size) ledger.artifactBytes = size;
    var outHandle = acquire(ledger, 'assemble-output', size);
    ledger.writeBytes += size;
    var result = adapter.buffered.finalize(state, function (bytes) {
      var padHandle = acquire(ledger, 'sha256-padding', paddedLength(bytes.length));
      try {
        var s = createSha256();
        s.update(bytes);
        ledger.hashBytes += bytes.length;
        return s.digest();
      } finally {
        release(ledger, padHandle);
      }
    });
    release(ledger, outHandle);

    return {
      result: result,
      accepted: accepted,
      report: copyReport(ledger, adapter.name + ' buffered receiver (shipped)')
    };
  }

  return {
    COPY_BUDGET: COPY_BUDGET,
    BLOCK_BYTES: BLOCK_BYTES,
    DEFAULT_PENDING_LIMIT: DEFAULT_PENDING_LIMIT,
    DEFAULT_PENDING_FRACTION: DEFAULT_PENDING_FRACTION,
    ADR025_CRITERIA: ADR025_CRITERIA,
    createSha256: createSha256,
    sha256Hex: sha256Hex,
    paddedLength: paddedLength,
    createLedger: createLedger,
    acquire: acquire,
    release: release,
    copyReport: copyReport,
    assertCopyBudget: assertCopyBudget,
    V1: V1,
    V2: V2,
    createReceiver: createReceiver,
    ingest: ingest,
    isComplete: isComplete,
    finalize: finalize,
    missingSequences: missingSequences,
    measureBuffered: measureBuffered
  };
});
