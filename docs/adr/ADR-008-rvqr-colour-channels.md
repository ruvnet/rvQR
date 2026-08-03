# ADR-008: Colour Channels

| Field | Value |
|---|---|
| Status | **Deferred** |
| Date | 2026-08-03 |
| Scope | Carrying independent data in colour planes rather than one monochrome symbol |
| Implementation | Nothing, and deliberately so |
| Related | [ADR-004: Multi-Symbol Spatial Lanes](./ADR-004-rvqr-multi-symbol-lanes.md), [ADR-005: Bounded Decode Worker Pool](./ADR-005-rvqr-decode-worker-pool.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR sends one black-and-white symbol per frame.
[docs/benchmarks.md](../benchmarks.md) §9 names "colour or multi-symbol frames"
as the single largest throughput lever the comparators use and rvQR does not,
and the two are listed together because they are the two ways to get more bits
into the same frame period without a denser symbol.

The prior art is real. COBRA (MobiSys '12) is a colour barcode system for
smartphones; Strata (MobiCom '14) layers colour codes with hierarchical
modulation; Decimen uses colour among its levers on the way to a claimed
128 KB/s. The plausible gain for rvQR is **1.5–3×** — a range, not a figure,
because it depends entirely on how many colour levels survive a real camera.

Note what [docs/benchmarks.md](../benchmarks.md) §7 says about the citations:
COBRA's throughput could not be verified, three secondary sources give three
different numbers (598 kbps, 518 kbps, 900 kbps), and the paper is paywalled.
The comparison table records the disagreement rather than picking a winner. So
even the prior art's magnitude is not something this project has established.

## 2. Decision

**Defer.** rvQR keeps one monochrome symbol per frame, and pursues capacity
through [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md),
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
[ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md) first.

Four reasons, in the order they matter.

### 2.1 The camera pipeline is not on our side

A phone camera is not a photometer. Between the display and the decoder sit
automatic white balance, automatic exposure, tone mapping, and per-vendor colour
science, none of which are addressable from a web page and all of which are
actively trying to make a coloured screen look like a *nice picture* rather than
a measurement. Two devices in the same room will not agree on what they saw.

Worse for this specific idea, most capture pipelines **subsample chroma** —
4:2:0 halves colour resolution in both axes relative to luma. A design that
assumes three independent planes at full resolution is assuming something the
pipeline actively removes, which is why the honest expectation is 1.5–3× and not
3×.

### 2.2 Display profiles vary as much as cameras do

The sender's half is no better. A P3 display and an sRGB display render the same
CSS colour differently; brightness, night-shift filters and ambient-light
adaptation all move the target. rvQR is a static page with no calibration step
and no way to ask what the panel is doing.

### 2.3 Rolling shutter and refresh interact badly with chroma

[docs/benchmarks.md](../benchmarks.md) §8 already lists rolling shutter, display
refresh versus camera exposure, and motion blur among the things the harness
cannot see. Colour makes each of them worse rather than orthogonal: a rolling
shutter samples different rows at different instants, and a panel's subpixel
response is not uniform across colours, so a row caught mid-refresh can carry a
colour that neither frame contained.

### 2.4 It competes with lanes for the same budget, and lanes can be reasoned
about offline

Both mechanisms spend the same resource — how much impairment a symbol can take
before it stops decoding — and rvQR has exactly one measurement of that budget,
the blur sweep in [docs/benchmarks.md](../benchmarks.md) §6.

The difference is that spatial lanes can be **bounded by geometry from data this
project already has**: [ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md) §2.2
derives a hard capture-resolution requirement from the measured module size,
before anyone builds anything. Colour has no equivalent. Its feasibility cannot
be estimated from any measurement in this repository, and the harness models no
optics whatsoever, so the first honest data point requires building it.

Spending the robustness budget on the lever that can be predicted is the better
order.

## 3. Consequences

### What deferring buys

- **The throughput programme stays measurable.** Every other decision here can
  be checked against `bench/` or against arithmetic on measured inputs. Colour
  cannot, and mixing it in would make a disappointing result impossible to
  attribute.
- **The decode path stays simple.** `BarcodeDetector` — the app's primary
  receive path on Chrome, Edge and Safari 17+ — reads monochrome QR symbols.
  Colour means it stops being usable and rvQR's own decoder becomes the only
  path, on every browser, having been characterised only as a fallback.
- **No calibration step.** "Point the camera at the code" survives.

### What deferring costs

- **1.5–3× left on the table**, on top of whatever
  [ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md) achieves. If lanes land at the
  projected 23 KB/s, colour is the difference between that and something near
  the comparators.
- **The gap to Decimen stays partly structural.** 128 KB/s comes from colour,
  density and 60 fps together; rvQR declining one of the three concedes part of
  the difference permanently.
- **Someone will ask.** It is the obvious idea, and "we thought about it" is a
  worse answer than a written record of why not — which is what this file is
  for.

## 4. Acceptance criteria — what would reopen this

Colour becomes a candidate when all of the following hold. Until then it stays
deferred, and no rvQR document should describe it as planned.

1. **[ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md) has shipped and been
   measured on real phones.** Its acceptance criteria are the prerequisite; if
   spatial lanes do not survive real optics, colour certainly will not.
2. **A device-pair colour study exists.** At least three sender displays and
   three receiver cameras across both target platforms, reporting how many
   distinguishable levels per channel survive at a working distance under
   bright, dim and glare conditions. Fewer than four levels per channel means
   the answer is no.
3. **Chroma subsampling is measured, not assumed.** The effective colour
   resolution of the capture path is established on each test device.
4. **A measured end-to-end gain of at least 1.5×** over the monochrome
   multi-lane path *at equal or better frame loss*. A gain that costs
   robustness is not a gain; §6 of the benchmarks already records that trade
   being made and lost once, when raising chunk size past version 19.
5. **A monochrome fallback that costs nothing**, selected automatically when the
   colour path underperforms, so a bad room degrades rather than fails.
6. **[ADR-010](./ADR-010-rvqr-acceptance-bar.md) passed on the colour path**,
   independently of the monochrome one.
