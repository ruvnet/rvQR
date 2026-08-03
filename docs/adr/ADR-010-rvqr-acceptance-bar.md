# ADR-010: The Acceptance Bar

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 (revised the same day — see §2) |
| Scope | The physical-device tests every decision in this set must clear before it is described as working |
| Implementation | The bars are adopted. **None has been run.** No number in this repository comes from two phones |
| Related | The whole rvQR-local set; especially [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-018](./ADR-018-rvqr-device-physics.md), [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

This ADR is the constraint the rest of the set is written against. Every
throughput figure anywhere in the rvQR-local set is arithmetic over a bench
harness, and the harness is explicit about what it is not:

> **No camera, no screen, no optics.** This is the big one. The harness models
> frame loss as a probability and says nothing about where that probability
> comes from.
> — [docs/benchmarks.md](../benchmarks.md) §8

What that leaves out is not a footnote: **autofocus hunting, glare, display
refresh versus camera exposure, rolling shutter, motion blur**, and — over a
multi-minute transfer on a phone driving a camera — **thermal throttling**. A
denser symbol raises throughput *and* the loss rate, and the harness cannot see
the second half of that trade. `BarcodeDetector`, the app's *primary* receive
path, is not measurable in Node at all
([docs/benchmarks.md](../benchmarks.md) §9).

**So today's numbers are engineering baselines, not production phone results.**
2.44 KB/s, 9.53 KB/s, the measured 1.492×, 108 slots at 20% loss, 98.45% of
decodes at exactly K — all correct statements about a simulation, none a
statement about a phone. [ADR-018](./ADR-018-rvqr-device-physics.md) is the ADR
that closes that gap; this is where the closing gets graded.

## 2. Decision

Three bars, in increasing order of what they prove. **Earlier bars are not
deleted when later ones are adopted** — a milestone that has been passed is
evidence, and one that is skipped is a gap.

### 2.1 Milestone: the 40 KB optical bar

**100 physical transfers of the 40,989-byte demo module**, across iPhone/Safari
and Android/Chrome, under bright, dim and glare conditions, with **20% induced
frame loss** — six cells, roughly 17 transfers each, about an hour of scanning
and a day including setup.

Pass requires all four of: **zero corrupt accepts**; **zero wrong-key vault
writes** ([ADR-035](./ADR-035-rvqr-signature-admission.md)); **≥ 99 of 100
completions**; **p95 under 30 seconds**.

This is retained as the gate for the optical transport work in
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md),
[ADR-003](./ADR-003-rvqr-adaptive-compression.md),
[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) and
[ADR-033](./ADR-033-rvqr-decode-worker-pool.md), because it is the smallest test
that exercises the invariants and the only one runnable in a day.

**It is unreachable with the transport as it ships.** At 20% loss for this
artifact, [docs/benchmarks.md](../benchmarks.md) §1 measures p95 slots of **389
for v1's indexed chunks** and **116 for the shipped fountain**; at 5 fps that is
77.8 s against 23.2 s. Criterion 4 needs the fountain layer wired into the
transport, which has not happened — and 23.2 s leaves roughly seven seconds of
the thirty for everything §1 lists as unmodelled, which is thin.
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) and
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) are what make that margin
comfortable: at v2's measured 764 payload bytes and the measured 2.464× Brotli
ratio, the same artifact is 23 frames instead of 82.

### 2.2 The bar: 100 signed 10 MB RVF transfers, radios disabled

**Three phone/laptop combinations, radios disabled, 20% induced frame loss.**

| Criterion | Threshold | Tolerance |
|---|---|---|
| Digest and signature verification | **100%** | zero |
| Vault writes or RVM execution before verification | **zero** | zero |
| Accepted replayed ultrasonic commands | **zero** | zero |
| Median raw throughput | **> 100 KB/s** | — |
| Effective throughput, compressible corpus | **> 250 KB/s** | — |
| p95 completion | **< 120 s** | — |
| Memory | **< 256 MB** | — |

The three zero-tolerance rows map to specific decisions:
[ADR-016](./ADR-016-rvqr-verified-execution.md) §2.1 for the verification gate at
both layers, [ADR-035](./ADR-035-rvqr-signature-admission.md) for admission, and
[ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.4 for replay binding.
They are pass/fail and are never traded against the throughput rows.

**Radios disabled makes this a strict-mode bar**
([ADR-017](./ADR-017-rvqr-transport-modes.md)), so >100 KB/s raw is being asked
of the optical channel — roughly **10× the measured 9.53 KB/s ceiling**, and
above the 23.0 KB/s that [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md)
*projects* for four lanes. It is reachable only if multi-lane lands and holds on
hardware, which [ADR-018](./ADR-018-rvqr-device-physics.md) identifies as the
largest uncertainty in the programme. **This bar is deliberately set above what
any current projection comfortably delivers**, and should be read as a target,
not a forecast. If it fails, the honest response is to record the shortfall
rather than lower the bar.

The 256 MB ceiling is looser than
[ADR-025](./ADR-025-rvqr-zero-copy-pipeline.md)'s 128 MiB rule on purpose: the
tighter figure governs the pipeline, this one governs the whole process under
test.

### 2.3 Domain bars, owned by their own ADRs

Specified where they belong, so this ADR does not become the only place
acceptance is recorded:

| Bar | Owner |
|---|---|
| 1 GB rvDrop transfer, interrupted at 60%: ≤ 45 s, ≤ 1 MB retransmitted, identical BLAKE3 root, zero committed bytes on a corrupted signature | [ADR-019](./ADR-019-rvdrop-bulk-transport.md) §4.1 |
| Fleet-10 and Fleet-100: first closure in 3 s, fleet in 60 s, source traffic < 3× artifact, malicious peer contributes zero, matching witness lineage | [ADR-024](./ADR-024-rvqr-fleet-swarm.md) §4 |
| Acoustic error tolerance re-established on real speakers and microphones | [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §4.1 |

### 2.4 Induced loss is deliberate; real loss is counted on top

The sender skips 20% of scheduled slots from a seeded generator, so a run
repeats — the same erasure model the harness uses, applied to real hardware.
Whatever the optics lose *in addition* is real and counted, and both rates are
reported. **The gap between them is the number this whole exercise exists to
discover**, and it supplies the **P** term that
[ADR-015](./ADR-015-rvqr-adaptive-control.md) currently assumes at 0.90 and 0.95.

### 2.5 Every claim is scoped to what was run

A change that has not been through a bar is described as measured *in the
harness*, never as working. That covers every projection in the set — 3.6 KB/s,
23.0 KB/s, 56.7 KB/s, 278 KB/s, 612 KB/s — each labelled where it appears and
staying labelled until a run replaces it.

[docs/benchmarks.md](../benchmarks.md) §7 records a comparator's press coverage
quoting a projected ceiling as a measurement. rvQR does not get to make the
mistake it criticised.

## 3. Consequences

### What this buys

- **Gates that can actually be run** — a day for §2.1, against the twelve days of
  continuous scanning that [docs/protocol.md](../protocol.md)'s 100 × 100 MB bar
  implies at measured rates.
- **The measurement nothing else can produce**: induced-versus-observed loss.
- **Zero-tolerance criteria that cannot be traded against speed.**
- **Dependencies made explicit.** §2.1 shows the fountain wiring is not optional;
  §2.2 shows the 10 MB bar depends on multi-lane holding on real optics.

### What it costs, honestly

- **§2.2 may be unreachable, deliberately.** A 10× demand on the least certain
  part of the programme is a real risk of a bar that is never met.
- **All of it is manual.** Three device combinations, six condition cells,
  hundreds of transfers, run rarely — so regressions between runs are caught by
  the harness or not at all.
- **"Glare" and "dim" are not calibrated.** Two operators produce two conditions,
  and results will not be comparable at the precision a p95 implies. A lux meter
  and a fixed rig would fix it and are not specified.
- **Three device combinations are not a device matrix**, and say nothing about
  the five-year-old midrange phone most likely to fail.
- **p95 over ~17 samples per cell is a weak statistic**, reported as an ordered
  observation rather than an estimate with an interval.
- **A 10 MB artifact still exercises none of the K-scaling behaviour** the
  fountain codec shows at K=800, where decode is 168 ms on an M4 Pro and five to
  ten times that on a phone.
- **Nothing here has been run.**

## 4. Acceptance criteria — for the bars themselves

1. **A written protocol per run**: device models, OS and browser versions,
   distance, mount, light source and position, loss seed.
2. **Both loss rates reported**, induced and observed, per cell.
3. **Per-transfer records**, not aggregates: wall-clock, slots painted, frames
   accepted, outcome, admission verdict, memory peak.
4. **Byte-level verification independent of rvQR's own hash check** — the check
   under test must not be the check doing the testing.
5. **Zero-tolerance rows are tested with genuinely adversarial inputs**: a real
   wrong key rather than signing disabled, a real recorded ultrasonic command
   rather than a synthetic one.
6. **Failures are published with the run.** A pass rate without its failures is
   not a result.
7. **Milestone results are retained** when a harder bar is adopted, so progress
   is visible rather than replaced.
8. **Projections are edited to measured figures** once a run replaces them, and
   the word "projection" is removed only where a run actually replaced it.
