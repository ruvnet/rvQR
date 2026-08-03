# ADR-020: Embedded Provenance as Native RVF Segments

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Where provenance, SBOM, licences and vulnerability assertions live |
| Value / effort / risk | 5 / 2 / 1 — **the lowest-effort, lowest-risk item in this set** |
| Implementation | None. `rvf-types` has `lineage.rs` and `attestation.rs`; there is no provenance segment type |
| Related | [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-021](./ADR-021-rvqr-device-attestation.md), [ADR-280: Durable Self-Contained Metadata](./ADR-280-rvf-durable-self-contained-metadata.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

An artifact crossing an air gap arrives with nothing but itself. Whatever a
receiver is going to know about where it came from must be *inside* it.

Sidecar manifests are the usual answer and they are the wrong one here for a
mechanical reason: a sidecar is a second file, and a second file crossing an
optical channel is a second transfer that can be omitted, substituted or simply
missed. The property [ADR-280](./ADR-280-rvf-durable-self-contained-metadata.md)
establishes for application metadata — that a received container should arrive
*complete*, not merely byte-identical — is the same property provenance needs,
for stronger reasons.

## 2. Decision

**Provenance, SBOM, licences, signer policy, source revision, build identity and
vulnerability assertions become native RVF segments.** Never sidecar manifests,
never a separate download, never a URL to fetch when the network returns.

The structure follows [SLSA v1.2 provenance](https://slsa.dev/spec/v1.2/provenance):
its approved source and build descriptions map onto RVF segments rather than
being reinvented — build definition, run details, resolved dependencies, and the
builder's identity each become segment payloads under a provenance segment type,
retaining SLSA's field semantics so an existing verifier can be pointed at the
extracted document.

Three rules make this worth having rather than decorative:

1. **Provenance is covered by the artifact's content hash and the manifest
   signature** ([ADR-012](./ADR-012-rvqr-post-quantum-manifest.md)). Provenance
   that is not signed is a claim anybody can write.
2. **Absence is a state, not a default.** An artifact with no provenance segment
   is *unprovenanced*, and that is reported as such — the same rule
   [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) applies to codecs, where 0
   means "none" explicitly rather than a missing field.
3. **Provenance is evidence for policy, not policy.** It tells RVM's capability
   check what the artifact claims about itself; the decision remains the policy's
   ([ADR-016](./ADR-016-rvqr-verified-execution.md),
   [ADR-021](./ADR-021-rvqr-device-attestation.md)).

## 3. Consequences

### What this buys

- **Provenance survives the gap.** It cannot be separated from the artifact by
  the transport, because it is the artifact.
- **It is nearly free at rvQR's layer.** No new transport, no new crypto, no new
  gate — segments are what RVF already is, and the byte cost is small against
  payloads measured in megabytes.
- **It lands early and unblocks the rest.**
  [ADR-021](./ADR-021-rvqr-device-attestation.md) and
  [ADR-016](./ADR-016-rvqr-verified-execution.md) both want something to reason
  about, and this is the cheapest way to give them one.
- **Standard shape.** SLSA rather than a house format means external tooling and
  external auditors already know how to read it.

### What it costs, honestly

- **Provenance inflates small artifacts disproportionately.** An SBOM for a
  40 KB WASM module can rival the module. On a channel measured at 2.44 KB/s
  that is seconds of scanning for metadata, and the compression measured in
  [ADR-003](./ADR-003-rvqr-adaptive-compression.md) helps here — text compresses
  at 3.535× — but does not eliminate it.
- **Signed provenance is still self-asserted.** A signature proves who said it,
  never that it is true. A compromised build system signs false provenance
  perfectly.
- **It commits to SLSA's schema evolution**, which is outside this project's
  control.
- **A new segment type is a format change**, and every reader that does not know
  it must ignore it safely — which RVF's design allows but which needs testing
  rather than assuming.

## 4. Acceptance criteria

1. **Round trip through the optical channel**, byte-exact, with provenance
   covered by the content hash — demonstrated by a test that mutates a
   provenance byte and observes the whole transfer rejected.
2. **An older reader ignores the segment safely** rather than failing to open the
   container.
3. **SLSA conformance is checked against an external verifier**, not only against
   this project's own parser.
4. **Unprovenanced is reported as a distinct state**, never as a pass, in the UI
   and in the receipt.
5. **The byte cost is measured** for both demo artifacts, compressed and
   uncompressed, and reported in `bench/` — because on a 2 KB container this may
   be the dominant term.
6. **Provenance never gates on its own**, asserted by a test that a valid
   provenance segment does not by itself admit an artifact that policy refuses.
