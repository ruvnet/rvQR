# ADR-021: Measured Device Attestation

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Binding a transfer to the receiver's measured boot state, and the strict limit on what that binding means |
| Value / effort / risk | 5 / 4 / 3 |
| Implementation | None in rvQR. `rvf-crypto/src/attestation.rs` and `rvf-cli verify-attestation` exist upstream |
| Related | [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-020](./ADR-020-rvqr-embedded-provenance.md), [ADR-023](./ADR-023-rvqr-presence-fusion.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-035](./ADR-035-rvqr-signature-admission.md) lets a *receiver* decide which
signer it will accept. Nothing lets a *sender* decide which receiver it will
send to.

For most of rvQR's uses that asymmetry is fine — the human aiming the camera is
the authorisation. For the uses in
[ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.3 it is not: shipping a signed
agent, a credential, or a model into a fleet means caring whether the device on
the other side is running an approved RVM, at a current policy epoch, with
storage that will not leak what it receives.

There is also an unresolved weakness one layer down.
[ADR-035](./ADR-035-rvqr-signature-admission.md) §2.4 records the signing key in
plaintext `localStorage`, where anything on the origin can read it. Hardware-held
keys are the remedy named there, and this ADR is where they arrive.

## 2. Decision

### 2.1 Bind the handshake to measured boot state

> **Implementation status, added when `artifacts/attest.js` landed
> ([519a209](https://github.com/ruvnet/rvQR/commit/519a209)): NONE of the four
> roots of trust below is exercised.** §4.4 of this document requires each to be
> exercised on real hardware "or the ones that are not are removed from this
> document". They are named here rather than removed, because the evidence
> format and the verdict-and-gate structure around them are built and tested and
> would otherwise lose their subject — but the protocols themselves are not
> implemented and no attestation has ever been produced or checked by this
> repository, on hardware or otherwise. `attest.describeRoots()` reports the same
> thing at runtime, so the limitation is discoverable from the code and not only
> from this note. Any reader treating the list below as support is reading an
> intention.

The session established in
[ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) incorporates the receiver's
attestation evidence, produced by whichever root of trust the platform offers:
**DICE**, **TPM 2.0**, **Secure Enclave**, or **Android hardware-backed keys**.
The [TCG DICE attestation architecture](https://trustedcomputinggroup.org/resource/dice-attestation-architecture/)
is the reference model — layered measurements where each stage attests the next,
which is the shape RuVix and RVM boot in.

A sender may then require, as a precondition of transferring:

- the receiver's **signer set** is trusted;
- the receiver's **policy epoch** is current;
- the receiver's **RVM measurement** is approved;
- the receiver's **storage policy** permits this class of artifact.

### 2.2 Attestation is evidence, not authorization

**This is the load-bearing sentence and it is the same invariant as
[ADR-035](./ADR-035-rvqr-signature-admission.md), one layer down.**

Attestation says what a device measured about itself at boot. It does not say
that the device may have this artifact. The **capability policy remains
authoritative**: attestation is an input to it, exactly as provenance
([ADR-020](./ADR-020-rvqr-embedded-provenance.md)) is an input, and neither is a
decision.

The failure this forbids is precise and common: treating a valid attestation as
a pass. A device can be genuinely, verifiably running approved firmware and still
be the wrong device to send a credential to. Structurally, that means the
attestation verifier returns a *verdict object* consumed by a separate gate — the
same shape as `core.admitArtifact`, which is pure and total precisely so no other
path can reach around it — and an unrecognised attestation state fails closed
rather than falling through.

### 2.3 Absent attestation is a state, not a failure

Most devices rvQR runs on are a web page in a browser with no attestation
available at all. Unattested is reported as **unattested**, and whether that is
acceptable is the sender's policy decision, not a default.

A sender that requires attestation refuses to transfer. A sender that does not
proceeds, and the receipt
([ADR-016](./ADR-016-rvqr-verified-execution.md) §2.3) records which it was — so
an auditor can later distinguish "attested and approved" from "nobody asked".

### 2.4 Hardware-backed keys supersede the localStorage identity

Where a platform key store exists, rvQR's signing identity moves into it and the
private key stops being readable by page script. Where it does not — a `file://`
page, a browser without WebAuthn — the existing behaviour is unchanged and
continues to be labelled a demonstration.

This is the concrete discharge of
[ADR-035](./ADR-035-rvqr-signature-admission.md) §4.8, which said that ADR is
superseded rather than amended when the key leaves `localStorage`.

## 3. Consequences

### What this buys

- **The sender gets a say.** Fleet provisioning and credential rotation become
  possible without trusting whoever holds the receiving device.
- **Receipts get meaningfully stronger.** A witness chain rooted in a
  hardware-held key is evidence; one rooted in `localStorage` is a formality
  ([ADR-016](./ADR-016-rvqr-verified-execution.md) cost list).
- **A stated limit that prevents the standard mistake.** §2.2 is written down so
  "attested" never quietly becomes "authorised".

### What it costs, honestly

- **Four platform mechanisms, four implementations, four failure modes**, and
  none of them are available to a static web page. This is the ADR that most
  forces rvQR toward a native shell, which is a change in what the project *is*.
- **Attestation is a strong claim about boot and a weak claim about now.** A
  device correctly attested at boot can be compromised afterwards; the evidence
  does not expire on its own.
- **Privacy.** Attestation evidence identifies a device, often durably. A
  protocol whose selling point includes not associating devices on a network now
  has a mechanism that identifies them cryptographically, and that tension should
  be resolved deliberately rather than discovered.
- **It can lock people out of their own hardware.** A policy requiring an
  approved RVM measurement refuses devices with legitimate modifications, and
  the failure mode reads as a bricked device.
- **Effort 4, risk 3** — the second-hardest item after progressive activation,
  with dependencies on platform APIs and on RVM's measurement format.

## 4. Acceptance criteria

1. **The verdict is separate from the decision.** A test supplies a valid
   attestation for a device the policy refuses and asserts the transfer does not
   proceed — attestation alone never authorises.
2. **Unrecognised attestation states fail closed**, with a test for a state that
   does not exist yet, mirroring
   [ADR-035](./ADR-035-rvqr-signature-admission.md) §4.1.
3. **Unattested is distinguishable from attested-and-approved** in the UI and in
   the receipt, never conflated.
4. **Each of the four roots of trust is exercised on real hardware**, or the ones
   that are not are removed from this document.
   **NOT MET, and none is exercised.** See the status note in §2.1.

> **Where this list actually stands at [519a209](https://github.com/ruvnet/rvQR/commit/519a209).**
> Recording which criteria are met matters more than counting them: an
> acceptance list whose met and unmet entries look alike will be read as
> satisfied.
>
> | # | State | Evidence |
> |---|---|---|
> | 1 | **met** | A valid attestation for an ungranted device returns `admit: false`, `capability-refused`; restoring the grant admits the identical verdict, so the refusal is the capability rule and not another one. |
> | 2 | **met** | A state that does not exist yet returns `unknown-attestation-state` and fails closed. |
> | 3 | **half met** | The RECEIPT distinguishes the two cases — `senderRequiredAttestation` separates "nobody asked" from "asked and got none". The UI half is NOT met: nothing is wired to the page yet, and until it is, a criterion reading "in the UI and in the receipt" is not satisfied. |
> | 4 | **not met** | No root of trust is exercised. |
> | 5 | **met** | A replayed nonce returns `replayed`; evidence bound to another session returns `unbound`. |
> | 6 | **not met** | The hardware-key path is not demonstrated, so ADR-035 is NOT superseded and the localStorage identity stands. |
> | 7 | **not met** | The privacy trade is not yet stated anywhere a user can see it. |
5. **Replay of a recorded attestation is refused** — the evidence is bound to the
   session id and a fresh nonce, the same rule
   [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.4 applies to
   acoustic control frames.
6. **The hardware-key path is demonstrated end to end**, with the private key
   never present in page script, and
   [ADR-035](./ADR-035-rvqr-signature-admission.md) marked superseded at that
   point.
7. **The privacy trade is documented** where a user can see it, before
   attestation is enabled.
