# ADR-026: Optical Turbo Research

| Field | Value |
|---|---|
| Status | **Experimental** — a research track, not a delivery commitment |
| Date | 2026-08-03 |
| Scope | Pushing the optical channel from 0.10–0.19 MB/s toward 0.5–1 MB/s, and why that is a research programme rather than a feature |
| Value / effort / risk | 3 / 5 / 4 — **the highest effort and the lowest value in this set** |
| Implementation | None |
| Related | [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md), [ADR-008](./ADR-008-rvqr-colour-channels.md), [ADR-017](./ADR-017-rvqr-transport-modes.md), [ADR-018](./ADR-018-rvqr-device-physics.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

Strict mode ([ADR-017](./ADR-017-rvqr-transport-modes.md)) has no radio, so its
rate *is* the optical rate — and the users with the strongest reason to want
sovereign transfer are the ones who cannot use rvDrop. Optical throughput is
therefore not merely a vanity metric; it is the only lever that mode has.

The baseline: **2.44 KB/s measured at the default, 9.53 KB/s at the ceiling**
(0.0024–0.0095 MB/s). The 0.10–0.19 MB/s figure this ADR takes as its starting
point is what [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md)'s multi-lane
projections would deliver **if they hold on hardware**, which nothing has yet
shown. Targeting 0.5–1 MB/s means targeting roughly 5× a projection that is
itself roughly 10× a measurement.

Both numbers should be read in that light.

## 2. Decision

**Pursue as research, on a separate track, with no delivery commitment.** The
techniques:

- **Camera-calibrated spatial grids** — grid geometry chosen from the calibration
  phase in [ADR-018](./ADR-018-rvqr-device-physics.md) rather than fixed, which is
  the direct answer to [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) §2.2's
  finding that four version-13 lanes do not fit a 720p capture.
- **Rolling-shutter modulation** — treating the sensor's row-by-row exposure as
  signal rather than as the impairment
  [docs/benchmarks.md](../benchmarks.md) §8 lists it as.
- **Adaptive colour constellations** — [ADR-008](./ADR-008-rvqr-colour-channels.md)
  deferred colour with reasons; this is the track that would resolve them, and
  that ADR's §4 acceptance criteria are the entry conditions.
- **GPU decoding** — moving finder-pattern search off the CPU, which §6 of the
  benchmarks shows is what dominates `decodeImage` cost.
- **Multiple simultaneous regions** — generalising lanes beyond a fixed grid.

**Marked experimental because display refresh, camera exposure and rolling-shutter
behaviour vary materially between devices.** Every technique above depends on
hardware behaviour that [ADR-018](./ADR-018-rvqr-device-physics.md) identifies as
the largest uncertainty in the programme, and three of the five actively exploit
it — which turns a source of variance into a dependency.

### 2.1 It does not block anything

This track is sequenced last deliberately
([ADR-028](./ADR-028-rvqr-swarm-delivery-structure.md)). Nothing else in
this ADR set depends on it, and a failure here costs strict-mode
throughput and nothing else. That is what makes an effort-5 risk-4 item
acceptable to attempt at all.

### 2.2 The honest comparison

Even at the optimistic end, 1 MB/s is below Decimen's published 128 KB/s only in
the sense of being above it — the comparison is not the point.
[ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.4 records that the optical layer
is not where this project is defensible: animated QR is easy to copy, rvQR is
13× behind the best comparator, and closing that gap wins a race nobody is
scoring. **The reason to do this work is strict mode, not competitiveness**, and
if that reason weakens the track should stop.

## 3. Consequences

### What this buys

- **Strict mode becomes usable for larger artifacts.** At 0.5 MB/s a 100 MB
  container is 3.3 minutes rather than the measured 11 hours — that is arithmetic
  on a target, not a measurement.
- **Calibration and grid work feed back into
  [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md)** even if the ambitious
  techniques fail.
- **Some of it is genuinely novel**, unlike the rest of the optical stack.

### What it costs, honestly

- **Effort 5 for value 3.** By the scoring in this set it is the worst
  ratio here, and it is included because strict mode has no alternative, not
  because it is a good investment on its own terms.
- **Three of five techniques depend on undocumented, varying hardware
  behaviour**, and rolling-shutter modulation in particular is device-specific in
  a way that resists a general implementation.
- **GPU decoding conflicts with rvQR's shape.** The app is a static page that
  runs from a `file://` URL with no install
  ([ADR-001](./ADR-001-rvqr-optical-transport.md)); a GPU decode path means WebGPU
  availability, a fallback, and a second decoder to keep in agreement with the
  first.
- **`BarcodeDetector` cannot be used for any of this.** The app's primary receive
  path decodes standard QR symbols and returns strings; every technique here
  needs raw pixels and a custom decoder, so the fallback decoder becomes the only
  path — on hardware, at high rates, having been characterised only as a fallback.
- **The target may be unreachable and that will only be discovered late**, after
  the hardware work.

## 4. Acceptance criteria

Gate conditions before any of this is treated as more than research:

1. **[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) and
   [ADR-018](./ADR-018-rvqr-device-physics.md) have both been measured on
   hardware.** Without a real baseline and a real P, every number here is a
   projection on a projection.
2. **Each technique is measured independently** before combination, with its
   contribution to G's R term reported separately
   ([ADR-015](./ADR-015-rvqr-adaptive-control.md)).
3. **A measured 3× over the multi-lane baseline** on at least two device pairs,
   or the track stops.
4. **No regression to the standard path.** The conservative
   version-19-at-5-fps profile keeps working unchanged, on every device, whatever
   this track produces.
5. **Device variance is quantified, not averaged.** A technique that works on one
   phone and fails on another is a negative result and is reported as one.
6. **Colour re-enters only through
   [ADR-008](./ADR-008-rvqr-colour-channels.md) §4's conditions**, which are not
   relaxed by being part of a research track.
