# ADR-028: Swarm Delivery Structure

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | How parallel agent capacity is organised so that it produces a system rather than a merge conflict |
| Implementation | None. The failure mode it exists to prevent has already occurred twice in this repository — see §1 |
| Related | [ADR-011](./ADR-011-rvqr-deployment-plane.md), [ADR-018](./ADR-018-rvqr-device-physics.md), and every other rvQR-local ADR |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

Engineering capacity is no longer the constraint. The remaining bottlenecks are
protocol decisions, merge contention, platform permissions, hardware
availability, RF physics, and verification.

**Agent capacity can be unlimited. Shared contract ownership cannot.** That
asymmetry is the entire reason for this ADR: adding workers to a module with one
owner scales; adding owners to a shared wire format does not, and the failure is
silent.

The evidence is local and recent. Parallel agents on this repository have already
produced exactly that failure twice in one day:

- A shared `core.js` change broke `resume.js`'s restored-state contract.
- A hardcoded script list in the standalone build silently diverged from
  `index.html`.

**Both were caught by verification, not by review.** That is the empirical case
for §2.3, and it is worth more than the argument would be on its own.

A third instance is visible in this ADR set itself: `artifacts/proto2.js` landed
while [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) was being written, with
a codec table that disagrees with
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) and with the shipped
`CompressionAlgo` enum. Nobody did anything wrong; two agents made reasonable
independent choices about a shared contract.

## 2. Decision

### 2.1 One architecture coordinator, seven domains, one owner per module

Unlimited workers may explore alternatives **behind** a module boundary. The
boundary itself has exactly one owner.

| # | Domain | In | Out | Invariant |
|---|---|---|---|---|
| 1 | **Protocol** | existing rvQR / BitChat / RVF / RVCOW / RVM contracts | versioned manifest, transport trait, session transcript, receipt schema, test vectors, compatibility rules | **No implementation changes the shared wire format independently** |
| 2 | **Transport** | the common transport trait | WiFi Aware, Apple peer WiFi, Android WiFi Direct, QUIC, WebRTC, BitChat, optical, ultrasound, UWB, USB, shared-LAN adapters | every adapter supports capability detection, interruption, fallback and deterministic error reporting |
| 3 | **Data intelligence** | artifacts and receiver inventories | semantic delta, RVCOW/agenticow transfer, adaptive compression, chunk sizing, concurrency, receiver-specific plans | competing implementations selected on **measured results, not consensus** |
| 4 | **Trust** | identities, policy | hybrid X25519 + ML-KEM-768, signed Merkle roots, DICE attestation, monotonic activation epochs, provenance, revocation, bounded decompression | **security invariants are deterministic and agents do not vote on correctness** |
| 5 | **Progressive execution** | verified closures | signed closures for manifest, runtime, hot state, indexes, cold assets | first trusted execution under 3 s; the remainder continues into **quarantine** |
| 6 | **Fleet distribution** | content-addressed chunks | BitChat peer discovery, local chunk exchange, RaptorQ broadcast, custody receipts, store-and-carry, offline sync | 100 devices × 1 GB under 3 GB of source traffic |
| 7 | **Verification** | everything | protocol fuzzing, differential tests, malicious-peer simulation, RF impairment replay, thermal and power measurement, formal invariant checks, reproducible benchmark receipts | **stays independent of implementation teams** |

Domain 4's invariant deserves emphasis because it is the one most likely to be
softened under delivery pressure. Correctness is not a majority outcome. Where
[ADR-035](./ADR-035-rvqr-signature-admission.md),
[ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.3 and
[ADR-016](./ADR-016-rvqr-verified-execution.md) state an invariant, it is
deterministic, and no amount of agreement among agents changes it.

### 2.2 Research tournaments, only where independent exploration creates real competition

Four areas, scored identically:

**S = 0.30 throughput + 0.20 time-to-useful-state + 0.15 energy efficiency +
0.15 recovery reliability + 0.20 security confidence**

| Tournament | Candidates |
|---|---|
| Optical modulation | [ADR-026](./ADR-026-rvqr-optical-turbo.md)'s techniques |
| Transfer controller | symbolic rules vs contextual bandits vs MPC vs hybrid RuVector/SONA ([ADR-015](./ADR-015-rvqr-adaptive-control.md)) |
| Semantic delta | byte delta vs CDC vs RVF segment delta vs RVCOW slab reuse vs tensor delta vs dependency-aware packing ([ADR-013](./ADR-013-rvqr-byte-minimisation.md)) |
| Congestion strategy | fixed streams vs BDP estimation vs path racing vs adaptive windows vs app-managed multipath ([ADR-019](./ADR-019-rvdrop-bulk-transport.md)) |

Note that security confidence is 20% of the score — the second-largest weight —
so a candidate cannot win on throughput alone. That is deliberate, and it is the
scoring form of domain 4's invariant.

### 2.3 The four mitigations against integration drift

1. **Immutable shared contracts.** Domain 1 freezes them; nobody else edits them.
2. **One owner per module.**
3. **Generated conformance tests** — derived from the contracts, not written
   alongside implementations, so an implementation cannot quietly redefine what
   it conforms to.
4. **Daily merge trains**, and **rejection of any branch lacking benchmark AND
   security evidence**.

The third is the one that would have caught all three incidents in §1.

### 2.4 Schedule, recorded as a plan with its assumptions visible

- **First 48 hours:** freeze protocol contracts, invariants, corpus, benchmark
  definitions and module ownership. **Start Apple entitlement work immediately** —
  it is an external dependency on someone else's timeline
  ([adopting Wi-Fi Aware](https://developer.apple.com/documentation/wifiaware/adopting-wi-fi-aware)).
- **Days 3–7:** reference Rust core, simulators, transport adapters,
  semantic-delta candidates, hostile test peers.
- **Week 2:** integrated native alpha across iPhone, Android, Windows, macOS,
  Linux, Pi 5, Cognitum Seed, simulated RVM.
- **Week 3:** attestation, progressive execution, fleet swarm, provenance,
  adaptive planning.
- **Week 4:** physical RF lab, security tournament, power testing, fuzzing,
  partner hardware.
- **Weeks 5–6:** release candidate, SDKs, white-label integration, compatibility
  certification, public comparative benchmark against AirDrop, Quick Share and
  LocalSend.

**Sequencing rule, which overrides the calendar:** prototype the adaptive
planner, RVF delta, provenance and the benchmark harness **first**; then
attestation and progressive activation; fleet swarm and optical turbo **only
after the core invariants pass**.

**Estimated effort for a hardened release: 24–30 senior engineer weeks.** That is
an estimate. It assumes the QUIC greenfield work in
[ADR-019](./ADR-019-rvdrop-bulk-transport.md), the PQ migration in
[ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) §2.4, and hardware
availability all go roughly as planned, and any of the three could dominate.

### 2.5 The biggest uncertainty is unchanged

**Real radio performance across Apple and Android hardware** — the sibling of
[ADR-018](./ADR-018-rvqr-device-physics.md)'s optical uncertainty. Mitigation is a
**twelve-device conformance lab** exercising congested spectrum, thermal
throttling, background restrictions, interruption, malicious peers and
unsupported capability combinations.

## 3. Consequences

### What this buys

- **Parallelism where it scales and serialisation where it does not.**
- **Verification that can contradict implementers**, because it does not report
  to them — which §1 shows is where the last three defects were actually caught.
- **Tournaments that settle arguments with measurement**, consistent with
  [ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.4's benchmarks-not-features
  standard.

### What it costs, honestly

- **One owner per module is a bottleneck by design**, and the protocol domain
  will be the tightest one. Under pressure the temptation is to let a second
  agent "just add a field".
- **Generated conformance tests need generators**, which is real work before any
  feature ships and will feel like delay.
- **Tournaments cost multiples of the work.** Four candidate deltas means four
  implementations, three of which are discarded.
- **The 24–30 week estimate rests on three assumptions any of which could double
  it**, per §2.4.
- **A twelve-device lab is capital, space and time** and cannot be simulated —
  the same constraint as
  [ADR-018](./ADR-018-rvqr-device-physics.md) and
  [ADR-024](./ADR-024-rvqr-fleet-swarm.md)'s fleet tests.
- **This ADR describes an organisation that does not exist**, and organisational
  ADRs are the easiest to write and the hardest to enforce.

## 4. Acceptance criteria

1. **Contracts are frozen and versioned before implementation starts**, with test
   vectors — the freeze is checkable, not declarative.
2. **Conformance tests are generated from the contracts**, and an implementation
   that changes a contract fails them without anyone writing a new test.
3. **No branch merges without both benchmark and security evidence**, enforced in
   CI rather than in review.
4. **Verification reports independently** and can block a merge over an
   implementation domain's objection.
5. **Every tournament publishes all candidates' S scores**, including the losers,
   so selection is auditable.
6. **The three §1 incidents each have a regression test**, since they are the
   only measured evidence this ADR has.
7. **The estimate is revisited at week 2** against actual progress on the three
   assumptions in §2.4, and revised in this document rather than defended.
