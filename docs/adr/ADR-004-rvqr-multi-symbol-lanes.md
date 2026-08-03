# ADR-004: Multi-Symbol Spatial Lanes

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Painting more than one QR symbol per frame period, and what the receiver has to do about it |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-002: Binary Frame Protocol v2](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-005: Bounded Decode Worker Pool](./ADR-005-rvqr-decode-worker-pool.md), [ADR-008: Colour Channels](./ADR-008-rvqr-colour-channels.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR's payload rate is one symbol's capacity times the frame rate, and both
numbers are small. Measured: 2.44 KB/s at the 512-byte, 5 fps default and
9.53 KB/s at the 1024-byte, 10 fps ceiling
([docs/benchmarks.md](../benchmarks.md) §4).

The obvious way to raise it — a denser symbol — is measurably closed. Under a
one-pixel blur every version through 19 decodes at some scale that fits a 720p
frame and **version 22 and above fail at every such scale**
([docs/benchmarks.md](../benchmarks.md) §6). The 512-byte default produces
version 19, sitting exactly on that cliff; the 1024-byte ceiling produces
version 27, already past it. There is no headroom in symbol density to spend.

The other way is to paint more symbols. This is what the fastest comparator
does: Decimen Optical Transfer reports **128 KB/s phone-to-phone** using
version-40 symbols at 60 fps together with multi-code grids and colour
(the project's README, reproduced as its claim in
[docs/benchmarks.md](../benchmarks.md) §7 — and note that the 190 KB/s figure in
press coverage is the README's *projection*, not its measurement). rvQR is
roughly 13× behind, and [docs/benchmarks.md](../benchmarks.md) §9 names
"colour or multi-symbol frames" as **the single largest throughput lever the
comparators use and rvQR does not**.

Compute is not what stands in the way. `decodeImage` costs 10–15 ms per frame at
720p across the *entire* version range, because finder-pattern search dominates
and that scales with pixels rather than modules
([docs/benchmarks.md](../benchmarks.md) §6). At 5 fps the budget is 200 ms.

And the receiver is already shaped for this. On the native path
`artifacts/app.js` calls `detector.detect(v)` and iterates the array it returns,
feeding every code found in the image to the state machine
(`artifacts/app.js:1297`). On the fallback path the worker's decode job calls
`qrdec.decodeImage(frame, { all: true })` and collects every result
(`artifacts/worker.js`). **Neither path assumes one symbol per image.** The
sender is the half that does.

## 2. Decision

### 2.1 Four version-13 lanes in a 2×2 grid

The sender paints a 2×2 grid of independent QR symbols per frame period. Each
lane carries an ordinary [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md)
frame with its own index — lanes are a *display* arrangement, not a protocol
layer. The receiver keeps ingesting every symbol it finds and does not need to
know a grid exists.

The operating point is **version 13 at level L**: 425 bytes of capacity, 397
after the 28-byte header, and **384 payload bytes** as the sender's default,
leaving slack. At 15 fps that is 4 × 15 × 384 = **23.0 KB/s** before
compression, and 30.7 KB/s at 20 fps. With the measured Brotli ratio for the
demo WASM module (2.464×, [ADR-003](./ADR-003-rvqr-adaptive-compression.md)),
4 × 15 × 384 ÷ 0.406 ≈ **56.7 KB/s** of artifact.

Every one of those figures is a **projection**. Nothing has been painted, no
camera has read a grid, and the harness models frame loss without modelling
optics at all ([docs/benchmarks.md](../benchmarks.md) §8).

Version 13 rather than 19 because four symbols have to share a frame's pixels,
and §2.2 is the reason that matters more than the capacity does.

### 2.2 The binding constraint is capture resolution, and at 720p this does not fit

This is the finding that should govern the schedule, and it falls straight out
of the blur measurement.

[docs/benchmarks.md](../benchmarks.md) §6 reports, for a one-pixel blur, the
smallest module size at which every sampled payload still decoded, and the share
of a 1280×720 frame that implies. Version 13: **6 px per module**, 64% of the
frame. That 64% is the symbol's 69 modules plus a four-module quiet zone on each
side — 77 modules — at 6 px, which is **462 pixels**.

A 2×2 grid divides the frame in both axes. The app requests
`width: {ideal: 1280}, height: {ideal: 720}` (`artifacts/app.js:1230`), so each
quadrant is 640 × 360 and the **vertical** axis binds:

| Capture | Quadrant | Version 13 needs (blur r=1) | Fits? |
|---|---|---|---|
| 1280 × 720 | 640 × 360 | 462 px | **no** |
| 1920 × 1080 | 960 × 540 | 462 px | yes, 17% margin |
| 3840 × 2160 | 1920 × 1080 | 462 px | yes, ample |

So: **four version-13 lanes require at least 1080p capture.** The sender
therefore requests 1080p, and where the camera cannot supply it the receiver
falls back to a **version-10 lane** — 57 modules plus quiet zone is 65 modules
at 5 px = 325 px, which does fit a 360-pixel quadrant. Version 10 at level L
holds 271 bytes, 243 after the header: 4 × 15 × 243 = 14.6 KB/s raw, about
35.9 KB/s at the measured WASM compression ratio. Slower than the 1080p case and
still six times the current ceiling.

The lane profile is therefore a **negotiated property of the receiver's camera,
not a sender preference** — which the sender cannot learn without a back
channel. Until [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) exists it
is a user-visible setting with a conservative default, and that is a real
limitation rather than a design.

### 2.3 Lanes carry interchangeable symbols, not a striped object

Once the fountain layer is wired into the transport, lanes emit encoding symbols
from the same source block with distinct symbol ids. A lane the camera crops out
or the glare kills costs symbols, not a specific piece of the object — the
receiver needs any K + ε of them regardless of which lane they came from
([docs/benchmarks.md](../benchmarks.md) §2 measures 98.45% of decodes completing
at exactly K).

Assigning each lane a fixed quarter of the artifact would be the simpler thing
to build and the wrong one: a lane that is consistently unreadable — because of
where a lamp is — would stall the transfer indefinitely rather than cost it
throughput. Spatial loss on a screen-to-camera link is not independent across
lanes and should not be assumed to be.

### 2.4 Ship this after the worker pool exists, not before

Four lanes at 15 fps is four symbol decodes per 66 ms. On the test machine a
single 720p `decodeImage` is 10.7 ms and cost tracks pixels, so a 1080p frame is
roughly 24 ms whether it holds one symbol or four, plus about 0.25 ms per
symbol for the grid sample and Reed–Solomon
([docs/benchmarks.md](../benchmarks.md) §6). That fits 66 ms with room to spare
on an Apple M4 Pro. **A phone is five to ten times slower at JavaScript**
(§8), which puts the same work at 120–240 ms and makes 15 fps impossible on the
main thread, which is already running a camera preview and a render loop.

Ordering follows from that: [ADR-005](./ADR-005-rvqr-decode-worker-pool.md)
first, lanes second. Building lanes on a single-threaded receiver would produce
a sender that emits 23 KB/s into a receiver that cannot read it, and the failure
would look like frame loss.

## 3. Consequences

### What this buys

- **The largest lever available, by a wide margin.** A projected 9.4× on raw
  frame capacity over today's measured default (23.0 against 2.44 KB/s) and
  about 23× with compression, against 1.48× for the framing change and 2.46× for
  compression on the best-measured artifact.
- **No new receiver concept.** Both decode paths already return every symbol
  found in an image; this is a sender change and a resolution requirement.
- **It buys throughput without buying density.** Every lane sits at a version
  the blur measurement says is readable, which is the opposite trade from
  raising the chunk size.

### What it costs, honestly

- **The highest execution risk of anything in this set, and it is optical.**
  Everything above is arithmetic over a bench harness that explicitly does not
  model cameras, screens, autofocus, glare, rolling shutter or display refresh
  ([docs/benchmarks.md](../benchmarks.md) §8). A four-symbol frame stresses
  every one of those: autofocus hunts across a busier scene, a single glare
  patch can take out a quadrant, and four symbols at once is exactly when a
  rolling shutter's row timing starts to matter.
- **It fails on 720p cameras, which are common.** §2.2 is a measured
  geometric bound, not a tuning problem. The fallback lane profile is 36% slower
  and the receiver cannot tell the sender which it needs.
- **`BarcodeDetector` behaviour with four symbols is unknown.** It is the app's
  primary path and its cost is not measurable in Node
  ([docs/benchmarks.md](../benchmarks.md) §9). Whether it finds four symbols as
  cheaply as one, or degrades, is an open question no measurement in this
  repository answers.
- **Sender-side paint cost multiplies.** Encoding is ~150 KB/s of QR payload
  (§6), so four version-13 symbols is roughly 8 ms per frame period on the test
  machine — again, five to ten times that on a phone, in the same thread as the
  display.
- **A larger, busier display is harder to aim at.** rvQR's receive experience
  today is "point at the code". Four codes means the whole grid has to be in
  frame and in focus simultaneously, which is a real usability cost on a
  handheld device.
- **Nothing is implemented.** No grid painter, no lane assignment, no resolution
  negotiation, no measurement.

## 4. Acceptance criteria

1. **Two real phones, not a harness.** A 40 KB transfer completes between an
   iPhone on Safari and an Android on Chrome with a four-lane sender, measured
   wall-clock, in bright and dim light. Until that exists, every throughput
   number here stays labelled a projection.
2. **The resolution bound is confirmed or refuted on real optics.** Four
   version-13 lanes are attempted at 720p and at 1080p and the §2.2 prediction —
   fails at 720p, works at 1080p — is checked. If it survives at 720p, this
   document is wrong and should say so.
3. **Measured throughput at least 5× the current default** (≥ 12.2 KB/s of
   artifact) on real hardware, or the approach is not worth its risk.
4. **Per-lane loss is measured, not assumed.** Report the loss rate of each
   quadrant separately under glare from one side. If loss is strongly correlated
   with position, §2.3's interchangeable-symbol decision is what saves the
   transfer and should be demonstrated doing so.
5. **`BarcodeDetector` cost with four symbols** is measured in-browser on both
   target platforms, against the single-symbol baseline.
6. **The receiver keeps up.** No frame-drop regression against the single-symbol
   path at the same fps, with the worker pool from
   [ADR-005](./ADR-005-rvqr-decode-worker-pool.md) in place.
7. **Graceful degradation.** With one quadrant permanently occluded the transfer
   still completes, slower — demonstrated, not argued.
8. **The acceptance bar in [ADR-010](./ADR-010-rvqr-acceptance-bar.md) is met by
   the multi-lane path**, not only by the single-symbol path.
