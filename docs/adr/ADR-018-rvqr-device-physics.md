# ADR-018: Device Physics and Calibration

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | The gap between what the harness measures and what hardware does — **the largest uncertainty in the entire programme** |
| Implementation | None. And the uncertainty this ADR describes is why that matters more here than elsewhere |
| Related | [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md), [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md), [ADR-010](./ADR-010-rvqr-acceptance-bar.md), [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-026](./ADR-026-rvqr-optical-turbo.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

**Autofocus, display refresh, camera frame-rate reporting, microphone filtering
and speaker response will dominate the laboratory algorithm choices in this ADR
set.** That is the single most important sentence in the programme and it should
be uncomfortable, because most of the preceding decisions were made against a
simulator.

[docs/benchmarks.md](../benchmarks.md) §8 states the limit in its own words:
"No camera, no screen, no optics. This is the big one. The harness models frame
loss as a probability and says nothing about where that probability comes from."
§9 adds that `BarcodeDetector` — the app's *primary* receive path — is not
measurable in Node at all, so only the fallback decoder has ever been timed.

Three concrete examples of the gap, from decisions already taken:

- [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) §2.2 derives a hard
  requirement — four version-13 lanes need 1080p capture — from a **synthetic box
  blur**. §6 of the benchmarks is explicit that "a box blur is not a lens": no
  depth of field, no rolling shutter, no noise, no glare, no motion.
- [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.5 found a published
  20% error tolerance that tests a transformation the decoder cannot perceive.
  The real acoustic channel is entirely unmeasured.
- [ADR-015](./ADR-015-rvqr-adaptive-control.md)'s objective has a term **P**,
  decode success probability, for which the worked projections simply assume 0.90
  and 0.95.

## 2. Decision

### 2.1 Every throughput number in this ADR set is an engineering baseline

Not a phone result. This applies to 2.44 KB/s, 9.53 KB/s, the measured 1.492×,
the projected 23.0 KB/s and 56.7 KB/s, the 278 and 612 KB/s in
[ADR-015](./ADR-015-rvqr-adaptive-control.md), and every ratio in
[ADR-003](./ADR-003-rvqr-adaptive-compression.md). Each is labelled where it
appears and stays labelled until a hardware run replaces it.

### 2.2 A calibration phase of about three seconds

Before a transfer, the pair characterises itself: the sender paints a short
sequence spanning symbol versions, lane counts and frame rates; the receiver
reports what decoded. The output is a profile — symbol version, lane count,
frame rate, error-correction level, and for the acoustic channel a usable band
and symbol rate.

Three seconds is chosen against the transfer times it protects: 16.4 seconds
measured for 40 KB today, and minutes for anything larger. It is a bad trade for
a 2 KB container and an obviously good one above about 100 KB, so calibration is
skipped below a size threshold and the conservative profile is used instead.

Calibration measures **P directly** — the term
[ADR-015](./ADR-015-rvqr-adaptive-control.md) currently assumes.

### 2.3 Conservative fallback profiles, always available

Calibration can fail: the room changes, the user moves, the camera reports a
frame rate it does not deliver. Every device pair therefore has a profile that
does not depend on calibration succeeding — for the optical channel, the
measured-safe single version-19 symbol at 5 fps that
[docs/benchmarks.md](../benchmarks.md) §6 shows is the last version readable
under a one-pixel blur; for the acoustic channel, open-loop with no back channel
at all ([ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.6).

**Falling back is never an error.** It is slower, and slower is the correct
behaviour when the alternative is unmeasured.

### 2.4 RuVector memory learns the best *verified* profile per device pair

A calibrated profile is stored keyed on the device pair, and reused on the next
transfer between the same two devices — which is the common case for a
provisioning workstation and a fleet of identical appliances.

Only profiles that produced a **verified** transfer are stored. A profile that
completed quickly and failed its digest is not a fast profile; it is a broken
one. This is the same rule as
[ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.4's bounded exploration:
learning is allowed over things whose failure costs time, and a stored profile is
re-validated by calibration rather than trusted indefinitely, because rooms and
devices change.

### 2.5 What must be measured, named explicitly

So the list cannot quietly shrink: autofocus hunting and its recovery time;
display refresh versus camera exposure and the beat between them; rolling
shutter; **camera frame-rate reporting versus delivery**, since a device that
claims 30 fps and delivers 22 breaks every rate calculation in this set; glare
and specular reflection; motion blur at handheld tremor amplitudes; thermal
throttling over a multi-minute transfer; microphone AGC and band-limiting;
speaker response above 18 kHz; and battery state's effect on all of the above.

## 3. Consequences

### What this buys

- **P becomes a measurement.** The one term in G that is currently a guess.
- **The 1080p requirement in
  [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) gets tested rather than
  inherited**, and if real optics contradict it, that ADR is wrong and says so.
- **Repeat transfers between the same pair get fast without a user learning
  anything.**
- **An honest baseline.** A programme that says "these are simulator numbers"
  everywhere is one whose eventual hardware numbers can be believed.

### What it costs, honestly

- **Three seconds on every transfer above the threshold**, which is 18% of a
  measured 16.4-second 40 KB transfer and is pure overhead when the profile was
  already right.
- **It cannot be done in this repository.** Every item in §2.5 needs hardware,
  a room, and a person. The bench harness cannot be extended to cover any of it
  — that is what "not modelled at all" means.
- **A stored profile is a stale profile.** Lighting, distance, case, cracked
  screen protector and battery state all change what works, and the mechanism
  cannot tell a changed room from a changed device.
- **Learned profiles are per-pair and do not generalise**, so the benefit
  arrives only for repeat pairings — good for fleet provisioning, useless for a
  first contact, which is the case most demos exercise.
- **The findings may invalidate earlier decisions.** That is the honest risk of
  taking measurement seriously: §2.2's calibration could show that four lanes do
  not work at 1080p either, and
  [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) is the largest projected gain
  in the set.

## 4. Acceptance criteria

1. **P is reported as a measurement** for each condition in
   [ADR-010](./ADR-010-rvqr-acceptance-bar.md)'s matrix, replacing the assumed
   0.90 and 0.95 in [ADR-015](./ADR-015-rvqr-adaptive-control.md).
2. **Calibration completes in under 3 seconds** at p95 and its chosen profile
   beats the conservative default on measured goodput, or calibration is not
   worth its own overhead.
3. **The induced-versus-observed loss gap is published**
   ([ADR-010](./ADR-010-rvqr-acceptance-bar.md) §2.2) — the quantity no
   simulation here can produce.
4. **Camera frame-rate reporting is validated against delivery** on every test
   device, since every rate in this ADR set is computed from a claimed frame
   period.
5. **[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) §2.2's prediction is
   confirmed or refuted on real optics**, and that ADR is edited to match the
   result rather than kept as written.
6. **Thermal behaviour is reported, not averaged away**, over a transfer long
   enough to throttle.
7. **Stored profiles are only ever derived from verified transfers**, asserted by
   a test that a completed-but-failed-digest transfer contributes nothing.
8. **Every simulator-derived number in this ADR set is labelled**, checked
   mechanically if possible — this is the criterion that keeps the rest honest.
