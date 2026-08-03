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

## rvQR's own decisions

These are rvQR's, written here rather than mirrored. **rvQR-local ADRs have
their own numbering starting at 001**, because the mirrored files below keep
their upstream numbers.

The two numbering spaces now collide: **ADR-004, ADR-005 and ADR-009 each exist
twice in this directory, meaning different things.** The rule that resolves it is
the filename, not the number — **a local ADR's slug begins with `rvqr-`**
(`ADR-009-rvqr-signature-admission.md` is rvQR's;
`ADR-009-rvf-v1-wire-contract.md` is RuVector's wire contract). Every local file
also says so in a note under its header. Cite these by filename rather than by
number.

Statuses are load-bearing. Only three of the ten are Accepted; the rest are a
throughput and control-channel programme that is written down and, with the
exception of `artifacts/p2p.js`, not built. Each one says in its own header what
exists.

| ADR | Status | What it decides |
|-----|--------|-----------------|
| [ADR-001 — rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md) | Accepted | The decisions this project has actually made and shipped: fixed indexed chunks before erasure coding, integrity without authenticity as a stated position, the hostile-input ceilings and why the renderer is capped independently of them, the stall-based transfer switching rule, native scanning with a vendored decoder fallback, the iframe camera constraint, the keyframe gate, and the line between parsing an untrusted container with WebAssembly and executing it. Includes an honest cost list. |
| [ADR-002 — Binary Frame Protocol v2](./ADR-002-rvqr-binary-frame-protocol.md) | Accepted | Replaces JSON-plus-base64 framing with a 28-byte binary header, taking a version 19 symbol from 512 payload bytes to 764 — a measured **1.492×** at the same robust operating point, or 1.30× through the ASCII armour the bundled decoder forces. Carries codec id and dictionary id in every frame, original and compressed sizes as separate fields, and **both** a per-frame transport hash and the artifact's content hash. Records the correctness defect this closes: RVQS carries one `SEED_COMPRESSED` bit whose doc comment says Brotli while the builder invokes SCF-1. Implemented in `artifacts/proto2.js` (26/26 tests) and **not yet wired into the app**. |
| [ADR-003 — Adaptive Compression](./ADR-003-rvqr-adaptive-compression.md) | Proposed | Zstandard (RFC 8878) by default and Brotli (RFC 7932) for WASM, HTML and metadata, reusing RuVector's codec ids and Rust implementation rather than inventing an rvQR vocabulary. Compress only when the whole transport envelope shrinks by ≥ 8%. Measured on this repository's artifacts: 2.464× on the demo WASM module, 1.320× on an RVF container of float vectors, 3.535× on the standalone page. **Records an open conflict**: `proto2.js` ships a different codec table from the one this ADR adopts, and Zstd has no id in it. |
| [ADR-004 — Multi-Symbol Spatial Lanes](./ADR-004-rvqr-multi-symbol-lanes.md) | Proposed | A 2×2 grid of version-13 symbols, projected at 23.0 KB/s raw and ~56.7 KB/s compressed. The single biggest lever and the highest execution risk. Derives a hard consequence from the existing blur measurement: four version-13 lanes **do not fit a 720p capture** and require 1080p, with a version-10 fallback for cameras that cannot supply it. |
| [ADR-005 — Bounded Decode Worker Pool](./ADR-005-rvqr-decode-worker-pool.md) | Proposed | Workers add no optical capacity, and today they measure *slower* — SHA ~15%, the keyframe signature ~59% — because buffers are copied across the boundary. Transfer a cropped `ImageBitmap` instead of cloning `ImageData`, and add 2–4 workers only after multi-lane tiling gives them something to do. |
| [ADR-006 — QR-Bootstrapped BitChat / WebRTC Escalation](./ADR-006-rvqr-p2p-escalation.md) | Proposed | QR carries identity, ephemeral keys, manifests and segment inventories; the payload moves over a WebRTC data channel (RFC 8831) or BitChat. Preserves the optical trust bootstrap and is explicitly **not radio-silent** — opt-in, off by default, empty `iceServers`. `artifacts/p2p.js` implements the WebRTC half and is not wired into the app. |
| [ADR-007 — Ultrasonic Reverse Control Channel](./ADR-007-rvqr-ultrasonic-control-channel.md) | Proposed | Forward optical, reverse acoustic: capability negotiation, fountain rank, signal quality, pause/resume/cancel/complete. Speed comes from omitting unnecessary QR frames, not from acoustic bandwidth. Proposes a ~20-byte RVU1 control frame over 4-tone FSK against `ruvnet/ultrasonic`'s 12.7–20.2 s for a 16-byte command. Records two safety findings: AES-GCM does not stop replay of a recording, and the published 20% error tolerance is tested by negating samples, which a sign-blind decoder cannot see. |
| [ADR-008 — Colour Channels](./ADR-008-rvqr-colour-channels.md) | **Deferred** | Potentially 1.5–3×, deferred with reasons: camera white balance and tone mapping, chroma subsampling, display profiles, and rolling shutter — none of which any measurement in this repository can bound, unlike spatial lanes. Lists what would reopen it. |
| [ADR-009 — Pinned-Fingerprint Admission](./ADR-009-rvqr-signature-admission.md) | Accepted | A pin must be enforced where the artifact is stored, not rendered as a badge. The pure `core.admitArtifact(pin, verification)`: pending never admits, unknown verdicts fail closed, no-pin is unchanged. Records the companion defect — `signManifest` called with reversed arguments, so signing silently never happened — and that the signing key currently sits in plaintext `localStorage`. |
| [ADR-010 — The Acceptance Bar](./ADR-010-rvqr-acceptance-bar.md) | Accepted | 100 physical transfers across iPhone Safari and Android Chrome, bright / dim / glare, 20% induced loss. Pass requires zero corrupt accepts, zero wrong-key vault writes, ≥ 99 completions and p95 under 30 s for 40 KB. States plainly that the benchmark models frame loss but not optics, so today's figures are engineering baselines — and shows the bar is unreachable until the fountain layer is wired into the transport. |

## Mirrored: wire format and contract

| ADR | What it decides |
|-----|-----------------|
| [ADR-009 — RVF Version 1 Wire Contract](./ADR-009-rvf-v1-wire-contract.md) | **The normative one.** An RVF file is an append-only stream of 64-byte-aligned segments with no header at offset zero; a reader finds the file's identity by scanning the *tail* for the 4096-byte Level-0 root manifest. Nails down the exact little-endian wire bytes — segment `53 46 56 52`, root manifest `30 4D 56 52` — and explains why the "RVFS"/"RVM0" mnemonics are the big-endian rendering and must never be compared as ASCII. Backed by golden byte-vector tests and a CI gate. This is the ADR rvQR's type detection implements. |
| [ADR-004 — RVF Cognitive Container Format](./ADR-004-rvf-format.md) | The original format decision. Historical: its wire layout sections describe a fixed 64-byte header at offset zero, which the shipped crates never implemented. **Superseded by ADR-009 for wire layout only**; the superseded banner is preserved. |
| [ADR-005 — RVF Cognitive Container Format](./ADR-005-rvf-cognitive-container.md) | The companion container decision, same vintage and the same caveat. **Superseded by ADR-009 for wire layout only**; banner preserved. Its non-wire reasoning still stands. |
| [ADR-029 — RVF as Canonical Binary Format](./ADR-029-rvf-canonical-format.md) | Makes RVF the one binary format across 70+ Rust crates and 50+ npm packages, ending the format fragmentation between ruvector-core, agentdb, claude-flow and friends. Why an artifact from any of them is a thing rvQR can carry. |

## Mirrored: cognitive containers and WASM

| ADR | What it decides |
|-----|-----------------|
| [ADR-030 — Self-Booting Vector Files](./ADR-030-rvf-cognitive-container.md) | Turns RVF from passive data into a container that carries its own runtime, so serving a file does not require an external stack to parse, index and expose it. The reason "artifact" and "executable" blur together — and the reason rvQR insists on the opposite: transport is not activation. |
| [ADR-032 — RVF WASM Integration](./ADR-032-rvf-wasm-integration.md) | How RVF ships to browsers and edges through the npm packages, including `@ruvector/rvf-wasm` — the very binary rvQR bundles as its demo artifact. |
| [ADR-280 — Durable Self-Contained Metadata](./ADR-280-rvf-durable-self-contained-metadata.md) | Makes application metadata survive close-and-reopen alongside the vectors, via the `Meta`/`MetaIdx` segment types. Matters for optical transfer because a received container should arrive complete, not merely byte-identical. Accepted on a branch; merge pending. |

## Mirrored: transfer and federation

| ADR | What it decides |
|-----|-----------------|
| [ADR-057 — Federated RVF Transfer Learning](./ADR-057-federated-rvf-transfer-learning.md) | Learning artifacts (SONA trajectories, policy kernels, transfer priors) move between deployments as RVF segments instead of being rediscovered independently. rvQR is one possible courier for exactly that traffic — one with no network at all. |
| [RVM ADR-149 — RVF Integration for RVM](./RVM-ADR-149-rvf-integration.md) | How RVM consumes RVF for boot images, dormant memory checkpoints, witness archives and GPU kernel distribution. Mirrored from a different repository with its own ADR numbering, hence the `RVM-` prefix. |

## Mirrored: QR and optical

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
[ADR-006](./ADR-006-rvqr-p2p-escalation.md) records the decision that governs it,
including the WebRTC sibling that *is* implemented in `artifacts/p2p.js` and the
reason escalation must be opt-in: it is not radio-silent.
