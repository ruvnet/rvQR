# Architecture Decision Records

rvQR moves RVF containers and WASM artifacts around, but it does not define
either format. These are **mirrored copies** of the decisions that do, kept here
so the protocol in [`../protocol.md`](../protocol.md) can be read without
switching repositories.

Every file carries a provenance header naming its canonical location. Copies
drift; the upstream repository is authoritative. Fix things there, then re-mirror
here.

Bodies are mirrored verbatim, which means their internal cross-references still
point into the upstream ADR set — ADR-057, for instance, links to ADR-059, which
is not mirrored here because it is not about RVF transfer. Follow those links
upstream rather than expecting them to resolve locally.

## Wire format and contract

| ADR | What it decides |
|-----|-----------------|
| [ADR-009 — RVF Version 1 Wire Contract](./ADR-009-rvf-v1-wire-contract.md) | **The normative one.** An RVF file is an append-only stream of 64-byte-aligned segments with no header at offset zero; a reader finds the file's identity by scanning the *tail* for the 4096-byte Level-0 root manifest. Nails down the exact little-endian wire bytes — segment `53 46 56 52`, root manifest `30 4D 56 52` — and explains why the "RVFS"/"RVM0" mnemonics are the big-endian rendering and must never be compared as ASCII. Backed by golden byte-vector tests and a CI gate. This is the ADR rvQR's type detection implements. |
| [ADR-004 — RVF Cognitive Container Format](./ADR-004-rvf-format.md) | The original format decision. Historical: its wire layout sections describe a fixed 64-byte header at offset zero, which the shipped crates never implemented. **Superseded by ADR-009 for wire layout only**; the superseded banner is preserved. |
| [ADR-005 — RVF Cognitive Container Format](./ADR-005-rvf-cognitive-container.md) | The companion container decision, same vintage and the same caveat. **Superseded by ADR-009 for wire layout only**; banner preserved. Its non-wire reasoning still stands. |
| [ADR-029 — RVF as Canonical Binary Format](./ADR-029-rvf-canonical-format.md) | Makes RVF the one binary format across 70+ Rust crates and 50+ npm packages, ending the format fragmentation between ruvector-core, agentdb, claude-flow and friends. Why an artifact from any of them is a thing rvQR can carry. |

## Cognitive containers and WASM

| ADR | What it decides |
|-----|-----------------|
| [ADR-030 — Self-Booting Vector Files](./ADR-030-rvf-cognitive-container.md) | Turns RVF from passive data into a container that carries its own runtime, so serving a file does not require an external stack to parse, index and expose it. The reason "artifact" and "executable" blur together — and the reason rvQR insists on the opposite: transport is not activation. |
| [ADR-032 — RVF WASM Integration](./ADR-032-rvf-wasm-integration.md) | How RVF ships to browsers and edges through the npm packages, including `@ruvector/rvf-wasm` — the very binary rvQR bundles as its demo artifact. |
| [ADR-280 — Durable Self-Contained Metadata](./ADR-280-rvf-durable-self-contained-metadata.md) | Makes application metadata survive close-and-reopen alongside the vectors, via the `Meta`/`MetaIdx` segment types. Matters for optical transfer because a received container should arrive complete, not merely byte-identical. Accepted on a branch; merge pending. |

## Transfer and federation

| ADR | What it decides |
|-----|-----------------|
| [ADR-057 — Federated RVF Transfer Learning](./ADR-057-federated-rvf-transfer-learning.md) | Learning artifacts (SONA trajectories, policy kernels, transfer priors) move between deployments as RVF segments instead of being rediscovered independently. rvQR is one possible courier for exactly that traffic — one with no network at all. |
| [RVM ADR-149 — RVF Integration for RVM](./RVM-ADR-149-rvf-integration.md) | How RVM consumes RVF for boot images, dormant memory checkpoints, witness archives and GPU kernel distribution. Mirrored from a different repository with its own ADR numbering, hence the `RVM-` prefix. |

## QR and optical

| ADR | What it decides |
|-----|-----------------|
| [ADR-034 — QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) | The closest relative to this repository. Defines RVQS, a self-bootstrapping payload sized to fit inside **one** QR code — 2,953 bytes at version 40, level L — carrying a 64-byte header, a compressed WASM microkernel, a signature, and a progressive download manifest. rvQR attacks the other half of the problem: when the payload will never fit in one symbol, stream it across many. The two are complementary, and a seed is a perfectly good thing to send over rvQR. |

## A note on BitChat

There are no standalone BitChat ADRs to mirror. Its design lives in the QuDAG
repository at
[github.com/ruvnet/QuDAG/tree/main/examples/bitchat](https://github.com/ruvnet/QuDAG/tree/main/examples/bitchat).
rvQR's planned use of it — a bootstrap QR carrying an X25519 public key, with
HKDF-SHA256 deriving session keys so the optical data plane can carry encrypted
payloads over an authenticated control channel — is specified in
[`../protocol.md`](../protocol.md) under the roadmap, and is not implemented.
