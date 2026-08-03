# ADR-015: Adaptive Transfer Control

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | What chooses the transport, codec, symbol version, grid size, frame rate, worker count and redundancy — and what that chooser is never allowed to decide |
| Value / effort / risk | 5 / 3 / 2 |
| Implementation | None. Every parameter is a fixed default or a user-visible slider today |
| Related | [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md), [ADR-033](./ADR-033-rvqr-decode-worker-pool.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-017](./ADR-017-rvqr-transport-modes.md), [ADR-018](./ADR-018-rvqr-device-physics.md), [ADR-027](./ADR-027-rvqr-non-goals.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

Every ADR in this set adds a knob. Symbol version and lane count
([ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md)), frame rate, worker count
([ADR-033](./ADR-033-rvqr-decode-worker-pool.md)), codec and level
([ADR-003](./ADR-003-rvqr-adaptive-compression.md)), chunk size, stream count and
transport ([ADR-019](./ADR-019-rvdrop-bulk-transport.md)), fountain redundancy
([ADR-014](./ADR-014-rvqr-fountain-selection.md)).

They interact, and the interactions are not monotone. The clearest measured
example is in [docs/benchmarks.md](../benchmarks.md) §3: the optimal manifest
repaint interval is **4 slots at K=5 and 32 slots at K=81**, and the report's
conclusion is that "any fixed constant is wrong at one end or the other". The
second clearest is §6: raising the chunk size raises throughput *and* pushes the
symbol past the blur cliff, so the two effects have opposite signs and the
harness cannot see the second one at all.

A human cannot tune this per device pair, and a fixed default is provably wrong
somewhere.

## 2. Decision

### 2.1 The objective, and what it is made of

The controller maximises

**G = R × C × E × P**

| Term | Meaning | Where it comes from |
|---|---|---|
| **R** | raw optical or link rate | symbol capacity × lanes × fps |
| **C** | compression and delta gain | [ADR-003](./ADR-003-rvqr-adaptive-compression.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md) |
| **E** | recovery efficiency | K ÷ symbols actually needed, [ADR-014](./ADR-014-rvqr-fountain-selection.md) |
| **P** | decode success probability | the term no simulation in this repository can supply |

Two worked projections, **and they are projections built on somebody else's
measurement**:

- 128 KB/s × 2.46 × 0.98 × 0.90 ≈ **278 KB/s effective**
- 186 KB/s × 3.53 × 0.98 × 0.95 ≈ **612 KB/s effective**

The 128 KB/s is Decimen Optical Transfer's **published handheld phone-to-phone
figure** and 186 KB/s its **published stationary projection**
([github.com/bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/)) —
their claims, reproduced as theirs, not measurements of rvQR. rvQR's own measured
R is 9.53 KB/s at its ceiling. The 2.46 and 3.53 are our measured Brotli ratios
on the WASM module and the standalone page; 0.98 is our measured recovery
efficiency; the 0.90 and 0.95 for P are **assumed**, because P is precisely what
[ADR-018](./ADR-018-rvqr-device-physics.md) says nobody has measured.

Quoting these as rvQR figures would repeat the error
[docs/benchmarks.md](../benchmarks.md) §7 documents in Decimen's own press
coverage, where a projected ceiling became a headline measurement.

### 2.2 A bounded controller first, a learned one second

**Stage one is a bounded rule-based controller** over a small, enumerated set of
profiles, because a search space of five profiles can be exhaustively validated
and a continuous one cannot.

**Stage two is a constrained contextual bandit** — RuVector or SONA — taking
receiver inventory, payload entropy, link forecast, signal strength, thermal
state, battery, latency and prior receipts, and emitting transport, codec,
compression level, chunk size, stream count and redundancy. Its objective:

**J = 0.45·T + 0.20·E + 0.20·B + 0.15·R**

throughput, energy, battery and reliability. The weights are a starting point to
be tuned against measurement, not derived constants.

Apple's WiFi Aware API exposes throughput ceilings, capacity forecasts, signal
strength and latency estimates as inputs
([WAPerformanceForecast](https://developer.apple.com/documentation/wifiaware/waperformanceforecast)),
**parts of which are still beta** — so the forecast inputs are optional and the
controller must work without them.

### 2.3 Hard rules always override learning

**A learned policy that can override a trust gate is not a policy, it is a
vulnerability.** The following are evaluated outside the objective function, and
no score can satisfy them:

| Invariant | Enforced by |
|---|---|
| Trust must pass | [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) |
| Working memory stays under 128 MiB | [ADR-025](./ADR-025-rvqr-zero-copy-pipeline.md) |
| Radio use satisfies policy | [ADR-017](./ADR-017-rvqr-transport-modes.md) |
| Commit requires complete verification | [ADR-016](./ADR-016-rvqr-verified-execution.md) |

The controller chooses **how** to transfer. It never chooses **whether to
trust**. Structurally, that means the policy emits a candidate configuration and
a separate, non-learned gate accepts or rejects it — the same shape as
`core.admitArtifact`, which is a pure total function precisely so that no other
code path can reach around it.

This is the same invariant as the pin fix in
[ADR-035](./ADR-035-rvqr-signature-admission.md), one layer up: a control that
advises rather than enforces is worse than no control, because it manufactures
confidence it does not supply.

### 2.4 Explore only within verified-safe bounds

A bandit explores, and exploration on this system means trying a configuration
that might fail. Exploration is therefore confined to parameters whose failure
costs **time**: symbol version within the measured blur-safe set, lane count,
frame rate, worker count, redundancy, chunk size. It never explores over
algorithm choice, verification strictness, or transport mode.

## 3. Consequences

### What this buys

- **A defensible answer to "what should the chunk size be?"**, which
  [docs/benchmarks.md](../benchmarks.md) §8 says the harness cannot answer
  because it cannot see the density-versus-loss trade.
- **The per-device-pair learning in
  [ADR-018](./ADR-018-rvqr-device-physics.md) has somewhere to go.** A learned
  profile is only useful if something consumes it.
- **G makes the whole programme comparable.** Four multiplicative terms, each
  owned by an ADR, each measurable separately.

### What it costs, honestly

- **G's fourth term is unmeasured and the other three are nearly maxed.** E is
  0.98 and cannot improve much; C is bounded by the payload (1.32× on float
  vectors); so realistically only R and P move, and P is the one nobody can
  currently see.
- **A learned controller is hard to debug and harder to explain.** When a
  transfer is slow, "the policy chose this" is a worse answer than "the chunk
  size is 512". Every decision must be loggable and replayable or this is not
  shippable.
- **Exploration costs real users real time**, on a channel where a bad choice
  can mean minutes.
- **Beta inputs.** Apple's forecast APIs are partly beta; a controller that
  degrades badly without them is a controller that fails on Android and on every
  optical-only transfer.
- **It is the fifth thing in this set that needs a benchmark harness that does
  not exist yet**, and unlike the others it cannot be validated offline at all —
  its whole value is in conditions the simulator does not model.

## 4. Acceptance criteria

1. **The bounded controller beats every fixed default** across the measured
   condition matrix, or it is not adopted. Specifically it must pick 4-slot
   repaint at K=5 and 32-slot at K=81 — the case
   [docs/benchmarks.md](../benchmarks.md) §3 already proved a constant gets
   wrong.
2. **Hard rules are proven unreachable by the policy.** An adversarial test
   drives the controller toward configurations that violate each of the four
   invariants and asserts the gate refuses every one, with the policy's score
   irrelevant to the outcome.
3. **Every decision is logged with its inputs and replayable offline**, so a slow
   transfer can be explained after the fact.
4. **The learned stage beats the bounded stage** on measured J across the
   condition matrix, or stage two is not shipped. A bandit that ties with rules
   is strictly worse than rules.
5. **Degradation without forecast inputs is measured**, not assumed — the
   controller runs on Android and on optical-only paths where none of Apple's
   estimates exist.
6. **Exploration is bounded structurally**, asserted by a test that the policy
   cannot emit an out-of-set algorithm, verification level or transport mode.
7. **G is reported term by term** in `bench/`, so a disappointing product is
   attributable to a specific factor rather than to the objective as a whole.
