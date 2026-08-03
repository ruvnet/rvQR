# ADR-011: rvQR Is a Deployment Plane, Not a File Transfer Tool

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | What the project is for, which decides what the rest of the ADR set is allowed to optimise |
| Implementation | The framing is adopted. Of the chain it describes, transport and integrity ship; authentication, execution and receipts do not |
| Related | Everything from [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) to [ADR-028](./ADR-028-rvqr-swarm-delivery-structure.md); [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-010](./ADR-010-rvqr-acceptance-bar.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-001](./ADR-001-rvqr-optical-transport.md) describes a tool that moves a
file between two screens. That is what was built and it is an accurate
description of the code. It is not an accurate description of the problem.

The problem is moving **code, models, vectors, credentials, policy, state and
audit evidence across a disconnected security boundary** — and having something
at the far end that is safe to run, with evidence that it ran. Optical transport
is one link in that chain. Optimising it in isolation produces a faster tool for
a job nobody has: a 9.53 KB/s channel that delivers unauthenticated bytes to a
vault is not slow, it is pointed the wrong way.

This ADR is placed here rather than at 001 because the framing genuinely
arrived later, and rewriting 001 to pretend otherwise would falsify the record.

## 2. Decision

### 2.1 The chain, and where the current code sits in it

rvQR's job is the whole sequence, and each link is a separate ADR:

| Link | Decided in | Ships today? |
|---|---|---|
| Move bytes across a gap with no network | [ADR-001](./ADR-001-rvqr-optical-transport.md), [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) | yes — v1 default, v2 selectable (armoured, 1.30×) |
| Move as few bytes as possible | [ADR-003](./ADR-003-rvqr-adaptive-compression.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md) | no |
| Survive severe loss without a back channel | [ADR-014](./ADR-014-rvqr-fountain-selection.md) | codec yes, transport no |
| Authenticate the payload and the peer | [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-021](./ADR-021-rvqr-device-attestation.md), [ADR-023](./ADR-023-rvqr-presence-fusion.md) | signing yes, PQ no |
| Admit to the vault only when verified | [ADR-035](./ADR-035-rvqr-signature-admission.md) | **yes** |
| Execute under capability and proof gates | [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-022](./ADR-022-rvqr-progressive-activation.md) | no |
| Emit a witness receipt | [ADR-016](./ADR-016-rvqr-verified-execution.md) | RVM's exists; rvQR is not wired to it |
| Choose the fastest *trusted* path | [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-017](./ADR-017-rvqr-transport-modes.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md) | no |

**Two links ship: transport and integrity.** Everything else in that table is a
decision, not a capability. Any external description of rvQR that implies
otherwise is wrong, and this ADR exists partly so that is easy to check.

### 2.2 The output is a verified deployment and a receipt, not a downloaded file

This is the sentence that changes what the code has to do. A transfer that ends
with bytes in a vault has not finished; it has stopped. The unit of success is a
*deployment that is known to be what it claims, running under stated limits,
with evidence a third party can check later* — which is why
[ADR-016](./ADR-016-rvqr-verified-execution.md) treats admission and execution
authority as the same invariant at two layers, and why the acceptance bar in
[ADR-010](./ADR-010-rvqr-acceptance-bar.md) counts wrong-key vault writes as a
zero-tolerance failure alongside corrupt bytes.

### 2.3 What this enables, stated as intended uses rather than achievements

None of these work today. They are the reason the programme is worth its cost,
and they are the list against which its scope should be judged:

- Offline deployment of signed agents and Cogs into networks that will never be
  connected.
- Emergency firmware and model updates across segmented networks, where the
  segmentation is the control and must not be relaxed to perform the update.
- Credential rotation without connecting the target device.
- Portable RVM execution state and RuVector memory migration between hosts.
- Auditable cross-domain transfers for industrial, government, healthcare and
  critical-infrastructure settings, where the receipt matters as much as the
  payload.
- Zero-infrastructure onboarding for Cognitum Seed, Appliance, Xunison and
  partner hardware — a device that has never had a network can still be
  provisioned.

### 2.4 The defensibility argument, stated plainly

**Animated QR codes are easy to copy.** [docs/benchmarks.md](../benchmarks.md)
§7 says so directly: animated-QR fountain transfer was published by txqr in
2018, is deployed at scale in hardware wallets via BC-UR, and browser-based
install-free optical transfer already exists in Decimen — which is 13× faster
than rvQR. There is nothing defensible in the optical layer and this project
should stop implying there is.

What is hard to copy is the **whole chain**: physical transfer, plus knowing
what the artifact *is* (RVF segments, vector slabs, RVCOW membership — the delta
path in [ADR-013](./ADR-013-rvqr-byte-minimisation.md) is the only one in that
comparison that can exploit structure in the payload), plus cryptographic
governance, plus isolated execution, plus a witnessed proof. Each piece exists
elsewhere; the composition does not.

That argument only holds if the composition is real. **State of the art is
demonstrated by benchmarks, not feature count** — so every ADR in this set
states a measurable claim and names the suite that will demonstrate it, rather
than listing capabilities.

## 3. Consequences

### What this buys

- **A reason to reject work.** "Faster optical throughput" stops being
  self-justifying: [ADR-027](./ADR-027-rvqr-non-goals.md) records what the
  framing rules out.
- **The security decisions stop looking like overhead.**
  [ADR-035](./ADR-035-rvqr-signature-admission.md) is not a nice-to-have on a
  file mover; it is the load-bearing link.
- **An honest external story**, in which rvQR is not claiming to have invented
  animated QR.

### What it costs, honestly

- **The scope is now very large**, and the gap between framing and code is
  correspondingly large — two links of eight. That gap is a liability every time
  the project is described.
- **It invites integration debt.** Six of the eight links depend on components
  outside this repository (RVM, rvf-crypto, BitChat, RuVector memory), and
  [ADR-028](./ADR-028-rvqr-swarm-delivery-structure.md) exists because that is
  where drift happens.
- **It raises the bar for every claim.** A benchmark-not-features standard means
  the throughput programme cannot be reported as progress until it is measured
  on hardware ([ADR-010](./ADR-010-rvqr-acceptance-bar.md),
  [ADR-018](./ADR-018-rvqr-device-physics.md)).

## 4. Acceptance criteria

1. **The chain table in §2.1 is kept accurate**, and any link claimed as
   shipping names the file and the test that shows it.
2. **No external description of rvQR claims a link that table marks as not
   shipping.** This includes the README, the app's About tab, and any deck.
3. **Every ADR in this set names a benchmark suite**, not a number it cannot
   source — the harness work is being extended in `bench/` and
   [docs/benchmarks.md](../benchmarks.md) in parallel.
4. **The end-to-end claim is demonstrated once**, on hardware: an artifact that
   crosses a gap, is authenticated, is admitted, executes under gates, and emits
   a receipt that verifies. Until that has happened, this ADR describes an
   intention.
