# ADR-022: Progressive Verified Activation

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Starting an agent before the whole artifact has arrived, without weakening the verification gate |
| Value / effort / risk | 5 / 4 / 4 — **the highest-risk item in this set** |
| Implementation | None. `rvf-index/src/progressive.rs` exists upstream for progressive index loading; nothing splits an artifact into signed closures |
| Related | [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-024](./ADR-024-rvqr-fleet-swarm.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-016](./ADR-016-rvqr-verified-execution.md) makes verification total: no
vault write and no execution before the artifact's digest and signature check
out. Applied to a whole artifact, that means time-to-first-useful-state equals
transfer time, and transfer time is 20–40 s for a large container over rvDrop
and minutes to hours optically.

For a deployment plane that is the wrong shape. Most of an RVF container is cold
— indexes, optional assets, historical vectors — and the agent does not need any
of it to start. [ADR-034](./ADR-034-qr-cognitive-seed.md) already establishes the
principle upstream: a seed reaches "first query at 50% recall after 6%
download", and `rvf-index/src/progressive.rs` exists for progressive index
loading.

The risk is equally clear. **Every mechanism that lets something run before
everything has been verified is a mechanism for running something unverified.**

## 2. Decision

### 2.1 Independently signed execution closures

An RVF artifact is split into closures, each **separately signed and separately
verifiable**:

| Closure | Contents |
|---|---|
| 1 | manifest + policy |
| 2 | minimal RVM runtime |
| 3 | required code and hot state |
| 4 | cold indexes and optional assets |

The agent starts once closures 1–3 verify. Closure 4 keeps transferring.

**The gate is not weakened; it is applied more times.** Each closure passes the
full [ADR-016](./ADR-016-rvqr-verified-execution.md) pipeline — bounded
decompression, digest, signature, admission — before anything in it is used. What
changes is the *unit*, not the strictness. A closure that fails is a closure that
does not run, and closure 1 failing stops everything.

### 2.2 Closure order is signed, so it cannot be reordered

The manifest commits to the closure list, their digests and their order.
A receiver that is offered closure 3 before closure 1 has verified refuses it,
because the policy that says what closure 3 is allowed to do is *in* closure 1.

This closes the obvious attack: deliver the closures out of order, or deliver a
valid closure 3 from a different artifact.

### 2.3 Everything unverified stays quarantined, including the remainder

An artifact that is running on closures 1–3 is not an admitted artifact. Closure
4 is quarantined data until it verifies
([ADR-016](./ADR-016-rvqr-verified-execution.md) §2.4), and a running agent
cannot reach into it.

The failure semantics have to be decided rather than discovered: **if closure 4
never verifies, the agent keeps running on 1–3 and the artifact is marked
incomplete.** It does not silently acquire the cold state later, and it does not
retroactively become a verified whole artifact. A partially-verified deployment
is a distinct state and appears as one in the receipt.

### 2.4 The target, and what it is measured against

**Time-to-first-trusted-agent under 3 seconds**, even when the full artifact
needs 20–40 seconds. That is a target, not a measurement — there is no
implementation and no closure-splitting tool.

The 3 seconds must include: closure 1–3 transfer, decompression, digest,
signature verification (which grows under
[ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) — an ML-DSA-65 signature is
3,309 bytes per closure and four closures means four of them), and RVM
capability evaluation. On the optical channel at a measured 2.44 KB/s, three
seconds is 7.3 KB, so **this target is a radio-tier feature**
([ADR-019](./ADR-019-rvdrop-bulk-transport.md)); optically it is only reachable
if closures 1–3 are very small, and that should be stated rather than assumed.

## 3. Consequences

### What this buys

- **Time-to-useful-state stops tracking artifact size**, which is what makes a
  1 GB container practical to deploy rather than merely possible to transfer.
- **Failure gets cheaper.** A bad closure 4 costs cold state, not the deployment.
- **It composes with [ADR-024](./ADR-024-rvqr-fleet-swarm.md)**: a fleet can
  activate on closures 1–3 while cold state is still circulating peer to peer,
  which is where the 3-second first-activation target in that ADR's test comes
  from.

### What it costs, honestly

- **This is the item most likely to introduce a security defect**, and the
  reason its risk score is 4. Four verification boundaries instead of one, an
  ordering constraint, a partially-verified state, and a running agent adjacent
  to quarantined bytes — every one of those is a place for the
  [ADR-035](./ADR-035-rvqr-signature-admission.md) failure to recur, where a
  check exists but the path around it does too.
- **Signature overhead multiplies by the closure count.** Four closures under
  hybrid signing is four Ed25519 plus four ML-DSA-65 signatures — over 13 KB of
  signature on an artifact whose fast start is the entire point.
- **Splitting is not automatic.** Deciding what is "required code and hot state"
  versus "cold" is artifact-specific, needs tooling that does not exist, and a
  wrong split produces an agent that starts and immediately stalls.
- **"Running but incomplete" is a new state the whole system must understand** —
  the vault, the UI, the receipt, and any policy that asks whether an artifact is
  present.
- **On the optical channel the target is likely unreachable**, per §2.4.

## 4. Acceptance criteria

1. **Each closure is independently verified**, demonstrated by corrupting each in
   turn and asserting that only that closure is refused and nothing downstream
   of it runs.
2. **Out-of-order and cross-artifact closures are refused**, with a test that
   offers a valid closure 3 from a different artifact.
3. **Nothing unverified is reachable from a running agent**, tested adversarially
   rather than by inspection.
4. **The incomplete state is explicit** in the vault, the UI and the receipt, and
   an artifact stuck at closures 1–3 never presents as complete.
5. **Time-to-first-trusted-agent under 3 s at p95** on the radio tier, measured
   with hybrid signatures in place — not with Ed25519 only, which would flatter
   the result.
6. **The optical case is measured and reported honestly**, including "not
   achievable at this artifact size" where that is the answer.
7. **Signature and closure overhead is reported in `bench/`** as a fraction of
   the artifact, since on small artifacts it may exceed the payload.
