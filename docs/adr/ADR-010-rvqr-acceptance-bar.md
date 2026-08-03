# ADR-010: The Acceptance Bar

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | The physical-device test every change in ADR-002 through ADR-008 must clear before it is described as working |
| Implementation | The bar is adopted. **It has not been run.** No number in this repository comes from two phones |
| Related | [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-003](./ADR-003-rvqr-adaptive-compression.md), [ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md), [ADR-005](./ADR-005-rvqr-decode-worker-pool.md), [ADR-006](./ADR-006-rvqr-p2p-escalation.md), [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md), [ADR-009](./ADR-009-rvqr-signature-admission.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

This ADR is placed last and constrains everything before it. Every throughput
figure in ADR-002 through ADR-004 is arithmetic over bench-harness measurements,
and the harness is explicit about what it is not:

> **No camera, no screen, no optics.** This is the big one. The harness models
> frame loss as a probability and says nothing about where that probability
> comes from.
> — [docs/benchmarks.md](../benchmarks.md) §8

The list of what that leaves out is not a footnote. Real failures correlate with
symbol density, module size in camera pixels, **autofocus hunting**, **glare**,
**display refresh versus camera exposure**, rolling shutter, motion blur, and —
over a multi-minute transfer on a phone driving a camera at 15 fps —
**thermal throttling**. A denser symbol raises throughput *and* the loss rate,
and the harness cannot see the second half of that trade. On top of which the
app's primary receive path is `BarcodeDetector`, a browser API that
[docs/benchmarks.md](../benchmarks.md) §9 records as **not measurable in Node**
at all; only the JavaScript fallback decoder has ever been timed.

**So today's numbers are engineering baselines, not production phone results.**
2.44 KB/s, 9.53 KB/s, 108 slots at 20% loss, 98.45% of decodes at exactly K —
all of these are correct statements about a simulation and none of them is a
statement about a phone.

[docs/protocol.md](../protocol.md) already carries a bar, and already says of it
that at the measured ceiling its 100 × 100 MB requirement is "roughly twelve days
of continuous scanning… on today's single-symbol stream it is a thought
experiment, and the honest near-term version is the same test at a size that
finishes in minutes." This ADR is that honest near-term version, written down so
it can be run.

## 2. Decision

### 2.1 The bar

**100 physical transfers of the 40,989-byte demo module**, across:

| Dimension | Values |
|---|---|
| Receiver | iPhone / Safari **and** Android / Chrome |
| Lighting | bright, dim, **and glare** (a light source in frame) |
| Induced frame loss | **20%**, on every transfer |

Six cells, roughly 17 transfers each. At the current default that is a little
under an hour of scanning — a day's work including setup, against twelve days
for the 100 MB version.

**A pass requires all four of:**

1. **Zero corrupt accepts.** Not one stored artifact differs from the source by
   any byte. This is the zero-tolerance gate: a single wrongly accepted file is
   a hard fail, not a lower score.
2. **Zero wrong-key vault writes.** With a fingerprint pinned, no artifact
   signed by any other key — or by none — reaches the vault
   ([ADR-009](./ADR-009-rvqr-signature-admission.md)). Also zero tolerance.
3. **At least 99 of 100 transfers complete.**
4. **p95 under 30 seconds** for the 40 KB artifact.

Criteria 1 and 2 are absolute. Criteria 3 and 4 are the ones a change is allowed
to be judged on.

### 2.2 Induced loss is deliberate and reproducible, and real loss is counted on
top

The sender skips 20% of its scheduled slots, chosen from a seeded generator so a
run can be repeated. This isolates loss from optics: it is the same erasure
model the harness uses ([docs/benchmarks.md](../benchmarks.md), "The channel is
an erasure channel"), applied to real hardware.

Whatever the optics lose *in addition* is real and is counted. The report gives
both: the induced rate, and the total observed rate measured as frames the
receiver accepted against slots the sender painted. **The gap between them is
the number this whole exercise exists to discover**, because it is the one
quantity no simulation in this repository can produce.

### 2.3 The bar as written requires the fountain layer, and the fountain layer
is not wired in

This falls straight out of the measured slot counts and is the most useful thing
the bar says about today's code.

At 20% loss, for the 40 KB module at 512 bytes per frame,
[docs/benchmarks.md](../benchmarks.md) §1 measures p95 slots of **389 for rvQR
v1's indexed chunks** and **116 for the shipped fountain**. At the default 5 fps:

| Transport | p95 slots at 20% loss | p95 seconds at 5 fps | Under 30 s? |
|---|---:|---:|---|
| rvQR v1 (indexed chunks) | 389 | 77.8 | **no** |
| Fountain (shipped codec) | 116 | 23.2 | yes, with ~7 s of margin |

So criterion 4 is **not reachable with the transport as it ships**, and is
reachable with the fountain codec that exists in `artifacts/fountain.js`, passes
its own tests, and **is not wired into the transport**
([ADR-001](./ADR-001-rvqr-optical-transport.md), "Still roadmap"). Roughly seven
seconds of the thirty is the entire budget for everything §1 lists as unmodelled.
That is thin, and it is the honest reason
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) and
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) matter to this bar rather than
only to the headline rate: at v2's measured 764 payload bytes per frame and the measured 2.464×
Brotli ratio, the same artifact is 23 frames instead of 82, and the margin stops
being thin.

### 2.4 Every claim is scoped to what was run

A change that has not been through this bar is described as measured *in the
harness*, never as working. This applies to every projection in ADR-002 through
ADR-004 — 3.6 KB/s, 23.0 KB/s, 56.7 KB/s — each of which is labelled a
projection where it appears and stays labelled until a run replaces it.

The failure mode being guarded against is documented in this repository already:
[docs/benchmarks.md](../benchmarks.md) §7 records a comparator's press coverage
quoting a projected ceiling as a measurement, and notes that the comparison table
deliberately uses the measured figure instead. rvQR does not get to make the
mistake it criticised.

### 2.5 What this bar does not cover

Named so that passing it is not mistaken for more than it is:

- **Large artifacts.** [docs/protocol.md](../protocol.md)'s 100 × 100 MB
  requirement stands as the long-term gate and is untouched by this one. Nothing
  here says anything about an 11-hour transfer.
- **Resume after browser termination.** `artifacts/resume.js` exists and is
  covered by no benchmark ([docs/benchmarks.md](../benchmarks.md) §9). It needs
  its own bar.
- **The escalated path.** [ADR-006](./ADR-006-rvqr-p2p-escalation.md) has its
  own criteria; a LAN transfer is not an optical transfer.
- **The acoustic channel.** [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md)
  §2.5 requires its published error tolerance to be re-established before
  anything depends on it.
- **Longevity.** One hundred short transfers say little about a device that has
  been scanning for an hour, which is where thermal throttling lives.

## 3. Consequences

### What this buys

- **A gate that can actually be run**, in a day, on hardware two people own —
  as against a bar that requires twelve days of continuous scanning and has
  therefore never been attempted.
- **The one measurement nothing else can produce.** The gap between induced and
  observed loss is the missing term in every projection in this ADR set.
- **Two hard-zero criteria that cannot be traded against speed.** Correctness of
  stored bytes and correctness of admission are not scored; they are pass/fail.
- **It makes the fountain-wiring dependency explicit** rather than leaving it as
  a roadmap item of unclear priority. §2.3 shows the bar is unreachable without
  it.

### What it costs, honestly

- **It is manual.** A hundred transfers, six condition cells, two people or one
  person and a tripod. It will be run rarely, which means regressions between
  runs will be caught by the harness or not at all.
- **"Glare" and "dim" are not calibrated.** Two operators will produce two
  different conditions, and results will not be comparable across runs at the
  precision the p95 criterion implies. A lux meter and a fixed rig would fix
  this and have not been specified.
- **Two devices are not a device matrix.** One iPhone and one Android say
  nothing about a five-year-old midrange phone, which is the device most likely
  to fail.
- **40 KB is a convenient size, chosen to be runnable.** It exercises none of
  the K-scaling behaviour: at K=81 the fountain's decode is 3.19 ms, and at
  K=800 it is 168 ms ([docs/benchmarks.md](../benchmarks.md) §2).
- **p95 over 17 samples per cell is a weak statistic.** It is reported as an
  ordered observation, not as an estimate with a confidence interval, and should
  be read that way.
- **It has not been run.** Everything above is a bar, not a result.

## 4. Acceptance criteria — for the bar itself

The bar is only useful if a run is reproducible and legible:

1. **A written protocol** — device models, OS and browser versions, distance,
   mount, light source and its position, and the loss seed — recorded with every
   run so a later run can be compared to it.
2. **Both loss rates reported**, induced and total observed, per cell.
3. **Per-transfer records**, not only aggregates: wall-clock time, slots
   painted, frames accepted, outcome, and any admission verdict.
4. **Byte-level verification of every stored artifact** against the source,
   independently of rvQR's own hash check — the check being tested must not be
   the check doing the testing.
5. **The pinned-key cell is run with a real wrong key**, not with signing
   disabled, so criterion 2 tests refusal and not absence.
6. **Failures are published with the run.** A transfer that did not complete is
   part of the result; a run reported only as a pass rate is not a result.
7. **The projections in ADR-002 through ADR-004 are edited** to carry the
   measured figures once a run exists, and the word "projection" removed only
   from the ones a run replaced.
