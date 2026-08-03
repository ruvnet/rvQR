# ADR-033: Bounded Decode Worker Pool

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | What runs off the main thread, how buffers cross the boundary, and when more than one worker is worth having |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-031: Multi-Symbol Spatial Lanes](./ADR-031-rvqr-multi-symbol-lanes.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

**Workers do not add optical capacity.** The channel's rate is symbol capacity
times frame rate, and no amount of parallelism changes either. Nothing in this
document makes rvQR faster on its own. What it does is make the mechanisms in
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md),
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) sustainable on a phone whose
main thread is already running a camera preview, a render loop and a QR painter.

That framing matters because the measurements say the current worker split is
not even neutral. Benchmarked in this session over `node:worker_threads` through
the browser-shaped surface `artifacts/offload.js` expects, against the identical
job table running inline:

| Job | Worker path versus inline |
|---|---|
| `sha256` over an artifact | **~15% slower** |
| `signature` (the keyframe gate's 16×16 frame digest) | **~59% slower** |

Those numbers are from this session's harness and are not in `bench/` as
committed; they are reproducible from `artifacts/perf.test.js`'s worker adapter
and should be folded into the benchmark suite before anyone relies on them.

The cause is not the worker. It is the buffer. `artifacts/offload.js` states its
contract plainly: *"By default every byte argument is COPIED into the worker and
the caller keeps its buffer"*, and *"Never pass `transfer: true` for a buffer you
still own (a canvas's `ImageData`, an artifact you are also hashing)"*. The two
jobs measured slower are exactly the two where the caller still owns the buffer.
So the copy is structural, not an oversight — and for `signature` it is
absurd on its face: the input is a full camera frame, the output is 256 bytes,
and the job itself is cheap. Copying a megabyte to avoid a fraction of a
millisecond of arithmetic is what 59% slower looks like.

## 2. Decision

### 2.1 Transfer a cropped `ImageBitmap`; stop cloning `ImageData`

Camera frames reach the worker as an `ImageBitmap` created with
`createImageBitmap(source, sx, sy, sw, sh)` and handed over in the `postMessage`
transfer list. The main thread never wanted the pixels; it wanted the answer.

`ImageBitmap` is transferable, so there is no clone. Cropping at creation means
only the region a lane occupies crosses the boundary, which under
[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) is a quarter of the frame per
worker. The ownership warning in `offload.js` stops applying because the bitmap
is constructed for the worker rather than borrowed from a canvas the main thread
is still drawing into.

This is a change to how the *decode* and *signature* jobs are fed, not to the
job table, which stays a plain function of plain data so the inline path and the
worker path continue to run identical code (`artifacts/worker.js`).

### 2.2 The artifact hash is transferred both ways, or not offloaded at all

`sha256` runs once per transfer, not once per frame, and it measured 15% slower
offloaded. Two acceptable resolutions, in order of preference:

1. The assembled buffer is transferred *into* the worker and the worker
   transfers it back with the digest. Two transfers, zero copies, and the main
   thread gets its bytes back for storage.
2. It stays on the main thread. A once-per-transfer cost of a few milliseconds
   against a transfer measured in seconds is not worth a boundary crossing.

What is not acceptable is the present arrangement, which pays a full copy to
move work that was never blocking anything.

### 2.3 Two to four workers, and only after lanes exist

Today there is one symbol per frame period. A pool has nothing to distribute and
would only multiply the startup cost — each worker `importScripts`es five files,
and `offload.js` allows four seconds for a worker to say hello before writing it
off.

After [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) there are four symbols per
frame period and a genuine reason for concurrency. The pool is then sized to
**min(lanes, hardwareConcurrency − 1, 4)**: one thread reserved for the main
loop, and a ceiling of four because a phone's core count is not its sustained
thermal budget and rvQR's whole point is that it works on a handheld device that
has been recording video for several minutes.

**The ordering is a decision, not a schedule detail.** Adding workers before
there is parallel work to do would bank the copying cost measured above and
return nothing.

### 2.4 The inline fallback stays mandatory and stays identical

`offload.js` never throws on a missing or blocked worker: a `file://` page cannot
construct a same-origin Worker in Chrome, a sandboxed iframe cannot either, and
this page's CSP (`script-src 'self' file: 'wasm-unsafe-eval'`, no `worker-src`)
blocks the usual `blob:` inlining trick. In every one of those cases rvQR must
still decode, still hash and still transfer — it loses parallelism, never
function.

That property is not negotiable and the pool must not weaken it. A pool that
cannot start degrades to inline, and `ready` reports which path was taken. The
`ImageBitmap` change has to work inline too, which means the inline path
constructs and consumes a bitmap rather than taking a shortcut that would let
the two paths diverge.

## 3. Consequences

### What this buys

- **A receiver that can absorb four lanes.** A 1080p `decodeImage` is roughly
  24 ms on the test machine and five to ten times that on a phone
  ([docs/benchmarks.md](../benchmarks.md) §6, §8); 15 fps is a 66 ms budget.
  Only concurrency makes that fit, and only if the frame is not copied first.
- **It removes a measured regression.** 15% and 59% slower become the baseline
  to beat rather than a cost being carried silently.
- **The critical path stops competing with the camera preview.** Which is the
  actual user-visible symptom: dropped preview frames look like frame loss and
  are indistinguishable from it in the UI.

### What it costs, honestly

- **Zero throughput on its own.** Every number in
  [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md),
  [ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
  [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) is unchanged by this document.
  It is a prerequisite, and prerequisites are easy to mistake for progress.
- **`createImageBitmap` is not free and has not been measured here.** It does
  its own work, asynchronously, and whether the total is cheaper than the clone
  is a browser-dependent empirical question. On Safari in particular it should
  be verified rather than assumed.
- **Two code paths that must not diverge.** The inline fallback exists precisely
  because the worker path is unavailable in the environments rvQR cares most
  about, and every change to the boundary is a chance for them to disagree.
  `artifacts/perf.test.js` exists to catch that and has to keep covering it.
- **A neutered buffer is a real hazard.** Transfer semantics detach the
  caller's view; code written against the copying default breaks quietly when
  the default changes. `offload.js` already detaches on the inline path
  deliberately so the contract does not change between paths — that discipline
  gets harder, not easier, with bitmaps in play.
- **Thermal behaviour is unmeasured.** Four workers decoding at 15 fps on a
  phone that is also driving a camera is exactly the workload that throttles,
  and nothing in this repository can observe that.
- **Nothing here is implemented.** The pool does not exist; today `offload.js`
  manages a single worker.

## 4. Acceptance criteria

1. **The regression is gone.** `sha256` and `signature` over the worker path are
   at least as fast as inline on the same machine, measured by the same harness
   that produced the 15% and 59% figures, and that harness lands in `bench/`.
2. **No copy on the frame path.** A test asserts the camera frame crosses as a
   transferred `ImageBitmap` and that the main thread holds no pixel copy.
3. **Inline parity.** Every job produces byte-identical results inline and on
   the worker, including the bitmap-fed decode and signature jobs — the existing
   parity tests extended, not replaced.
4. **Degradation is silent and complete.** With Workers blocked by CSP, by
   `file://`, and by a sandboxed iframe, the app still completes a transfer, and
   `ready` reports `inline` with a reason in each case.
5. **Pool sizing is bounded and observable.** Never more than 4 workers, never
   more than `hardwareConcurrency − 1`, never more than the lane count, and the
   count is visible in the UI's diagnostics.
6. **Measured on a phone, at four lanes.** Sustained frame rate over a five-minute
   transfer on both target platforms, with thermal throttling reported if it
   occurs rather than averaged away.
7. **No frame-drop regression** against the single-worker path at the same fps
   and lane count.
