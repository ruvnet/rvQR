# ADR-016: Verified Execution and the RVM Handoff

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | What happens between "the bytes are verified" and "the agent is running", and what comes out the far end |
| Implementation | rvQR's half of the invariant ships ([ADR-035](./ADR-035-rvqr-signature-admission.md)). RVM's witness machinery exists upstream. **The two are not connected** |
| Related | [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-011](./ADR-011-rvqr-deployment-plane.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-021](./ADR-021-rvqr-device-attestation.md), [ADR-022](./ADR-022-rvqr-progressive-activation.md), [RVM ADR-149](./RVM-ADR-149-rvf-integration.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-001](./ADR-001-rvqr-optical-transport.md) §2.9 draws a line rvQR has always
held: **transport is not activation.** Received artifacts are inert; stored
`.wasm` is compiled to list exports, never instantiated; the hash authorises
storage, and storage is not execution.

That line is correct and it is not the whole answer, because
[ADR-011](./ADR-011-rvqr-deployment-plane.md) says the point of a transfer is a
running, trusted deployment. Something has to cross the line deliberately. The
question is what governs that crossing, and the answer is not rvQR — it is RVM.

## 2. Decision

### 2.1 The same invariant at two layers

| Layer | Gate | Rule |
|---|---|---|
| rvQR | `core.admitArtifact(pin, verification)` | No vault write before verification |
| RVM | capability check, proof gate, resource budget | No execution before verification |

**These are one invariant, stated twice, and neither is allowed to trust the
other's word for it.** rvQR admitting an artifact is not a claim that the
artifact may run; RVM being willing to run something is not a reason for rvQR to
have stored it. Each gate re-derives its own answer.

That symmetry is the point. [ADR-035](./ADR-035-rvqr-signature-admission.md)
exists because a control that reports rather than enforces admits exactly what it
claims to stop, and the same failure at the execution layer is worse: a badge
saying "verified" next to a running agent.

`admitArtifact` is a pure, total function over the verdict space, with an
unrecognised verdict failing closed. The RVM-side gate must have the same
properties, for the same reason: a future state must not become an accidental
bypass.

### 2.2 The receiver pipeline, in order

1. Reassemble ([ADR-002](./ADR-002-rvqr-binary-frame-protocol.md)).
2. **Bounded** decompression — inflation capped against the declared original
   size, allocation bounded before the first inflated byte
   ([ADR-003](./ADR-003-rvqr-adaptive-compression.md)).
3. Verify the original content digest.
4. Verify the manifest signatures
   ([ADR-012](./ADR-012-rvqr-post-quantum-manifest.md)).
5. Admit to the RVF vault, or refuse
   ([ADR-035](./ADR-035-rvqr-signature-admission.md)).
6. **Hand off to RVM**, which independently applies capability checks, proof
   gates and resource budgets, and emits witness records.

Steps 3 and 4 are both mandatory and neither substitutes for the other: the
digest proves the bytes are the bytes described, the signature proves who
described them.

### 2.3 The receipt is RVM's witness record — do not invent a second one

`crates/rvm/crates/rvm-witness` implements ADR-134 and already provides exactly
what a deployment receipt needs:

- **96-byte v2 records** with **128-bit keyed-BLAKE3 chain MACs** and **Merkle
  segment sealing**, one keyed compression per append with signature cost
  amortised per segment.
- A frozen 64-byte v1 format retained verify-only, with dispatch on the version
  byte at offset 19 — so old logs keep verifying.
- The core invariant, in its own words: **"No witness, no mutation. Every
  privileged action emits a witness record before the mutation is committed. If
  emission fails, the mutation does not proceed."**

That invariant is the execution-layer form of
[ADR-035](./ADR-035-rvqr-signature-admission.md)'s, and it is already
implemented. **rvQR binds to ADR-134's format rather than defining a parallel
one.** The receipt a transfer produces is the same artifact RVM already emits —
not a new document that would immediately need its own verifier, its own format
drift, and its own ADR explaining why there are two.

### 2.4 Quarantine is the default state, not a stage

An admitted artifact sits in the vault as data. Activation is a separate,
explicitly authorised operation, and everything that has not been through step 6
stays quarantined — including the remainder of a partially-activated artifact
under [ADR-022](./ADR-022-rvqr-progressive-activation.md).

## 3. Consequences

### What this buys

- **The output becomes a verified deployment plus a checkable receipt**, which
  is the claim in [ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.2 and the
  thing that distinguishes this from a file transfer.
- **No new receipt format.** §2.3 reuses a shipped, tested, versioned one with a
  migration story already worked out.
- **Two independent gates.** Compromising the transport does not confer
  execution authority, and vice versa.

### What it costs, honestly

- **The connection does not exist.** rvQR is a static web page; `rvm-witness` is
  a Rust crate in the microhypervisor. Nothing in this repository calls it, and
  the handoff is a genuine integration with a component that has its own release
  cadence.
- **Two gates mean two places to get it wrong**, and the failure is asymmetric:
  a gate that is too strict is visible immediately, a gate that is too lax is
  visible never.
- **The receipt is only as meaningful as the key that signs it.**
  [ADR-035](./ADR-035-rvqr-signature-admission.md) §2.4 records rvQR's signing
  key sitting in plaintext `localStorage`; a receipt chain rooted in a key
  anything on the origin can read is an audit trail an attacker can forge.
  [ADR-021](./ADR-021-rvqr-device-attestation.md) is the intended remedy.
- **Bounded decompression is stated and not implemented**, since no codec is
  bundled ([ADR-003](./ADR-003-rvqr-adaptive-compression.md)).
- **"Refuse" is a worse user experience than "warn"**, and every gate here
  refuses. That is correct and it will generate complaints.

## 4. Acceptance criteria

1. **Zero vault writes and zero RVM executions before complete verification**,
   demonstrated adversarially rather than by inspection: corrupted digest,
   wrong-key signature, unsigned manifest and truncated payload each attempted,
   each leaving the vault and the runtime untouched.
2. **Both gates are pure and total over their verdict space**, with an
   unrecognised verdict failing closed — the property
   [ADR-035](./ADR-035-rvqr-signature-admission.md) already tests on rvQR's side,
   applied to RVM's.
3. **Neither gate can be satisfied by the other's assertion.** A test supplies a
   forged "already verified" claim from each side and asserts the other still
   re-derives.
4. **The receipt verifies with `rvf-cli verify-witness`** — the existing tool,
   against the existing format, with no rvQR-specific verifier.
5. **A deliberately broken witness emission blocks the mutation**, exercising
   ADR-134's "no witness, no mutation" from rvQR's side of the handoff.
6. **Bounded decompression holds under a bomb**: peak allocation stays within the
   declared original size, and the transfer is refused mid-stream.
7. **The end-to-end claim runs once**, on hardware:
   [ADR-011](./ADR-011-rvqr-deployment-plane.md) §4.4's single demonstration is
   this pipeline, and until it happens both halves of §2.1 are separately tested
   and jointly unproven.
