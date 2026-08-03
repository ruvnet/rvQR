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

### The numbering rule

**A number in this directory means exactly one document.** Getting there took a
correction. Multi-symbol lanes, the decode worker pool and signature admission
were originally written as ADR-004, ADR-005 and ADR-009, which collided with
three mirrored files. They are now **031, 033 and 035**. Nothing was ever
overwritten — the slugs differed — but the *citation* was ambiguous, and
"ADR-009" meaning both RuVector's wire contract and rvQR's admission rule is a
particularly bad collision, because ADR-009 is the record that exists to stop one
identifier meaning two incompatible things.

| | |
|---|---|
| **Claimed by mirrors** | 004, 005, 009, 029, 030, 032, 034, 057, 280 |
| **rvQR-local, in use** | 001, 002, 003, 006, 007, 008, 010–028, 031, 033, 035, 036 |
| **Next free** | **037** |

**A new rvQR-local ADR takes the next number not claimed by any mirror in this
directory** — which is not the same as the next number after the last local one.
Check the first row before choosing. Mirrors added later may claim further
numbers, so this table is consulted rather than assumed, and re-mirroring is the
moment to re-check it.

Cite by **filename**, not by number: a local ADR's slug begins with `rvqr-`
(`ADR-035-rvqr-signature-admission.md`), a mirrored one names its upstream
subject (`ADR-009-rvf-v1-wire-contract.md`). The `RVM-` prefix on
`RVM-ADR-149-rvf-integration.md` exists for the same reason — a third numbering
space — and is the precedent for prefixing if this directory ever takes enough
mirrors to make number-avoidance impractical.

**Statuses are load-bearing, and most of this is not built.** Of 29 local ADRs,
six are Accepted and one is Deferred; the rest are a deployment-plane programme
that is written down and largely unimplemented. Each file's header table says
what exists in its own `Implementation` row, and
[ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.1 carries the summary: **of the
eight links in the chain, two ship.**

The set divides into three blocks: **the optical transport and its acceptance
bar** (001–003, 006–008, 010, 031, 033, 035); **the deployment plane** (011–018,
036); and **bulk transport, execution and delivery** (019–028).

### Optical transport and its acceptance bar

Ordered by topic, not by number — see the numbering rule above for why 031, 033
and 035 sit here rather than at the end.

| ADR | Status | What it decides |
|-----|--------|-----------------|
| [ADR-001 — rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md) | Accepted | The decisions this project has actually made and shipped: fixed indexed chunks before erasure coding, integrity without authenticity as a stated position, the hostile-input ceilings and why the renderer is capped independently of them, the stall-based transfer switching rule, native scanning with a vendored decoder fallback, the iframe camera constraint, the keyframe gate, and the line between parsing an untrusted container with WebAssembly and executing it. Includes an honest cost list. |
| [ADR-002 — Binary Frame Protocol v2](./ADR-002-rvqr-binary-frame-protocol.md) | Accepted | Replaces JSON-plus-base64 framing with a 28-byte binary header, taking a version 19 symbol from 512 payload bytes to 764 — a measured **1.492×** at the same robust operating point, or 1.30× through the ASCII armour the bundled decoder forces. Carries codec id and dictionary id in every frame, original and compressed sizes as separate fields, and **both** a per-frame transport hash and the artifact's content hash. Records the correctness defect this closes: RVQS carries one `SEED_COMPRESSED` bit whose doc comment says Brotli while the builder invokes SCF-1. **Wired into the app** as of `f2f07f4` — but through the ASCII armour, so the realised gain is 1.30×, and v1 remains the default. |
| [ADR-003 — Adaptive Compression](./ADR-003-rvqr-adaptive-compression.md) | Proposed | Zstandard (RFC 8878) by default and Brotli (RFC 7932) for WASM, HTML and metadata, reusing RuVector's codec ids and Rust implementation rather than inventing an rvQR vocabulary. Compress only when the whole transport envelope shrinks by ≥ 8%. Measured on this repository's artifacts: 2.464× on the demo WASM module, 1.320× on an RVF container of float vectors, 3.535× on the standalone page. **Records an open conflict**: `proto2.js` ships a different codec table from the one this ADR adopts, and Zstd has no id in it. |
| [ADR-031 — Multi-Symbol Spatial Lanes](./ADR-031-rvqr-multi-symbol-lanes.md) | Proposed | A 2×2 grid of version-13 symbols, projected at 23.0 KB/s raw and ~56.7 KB/s compressed. The single biggest lever and the highest execution risk. Derives a hard consequence from the existing blur measurement: four version-13 lanes **do not fit a 720p capture** and require 1080p, with a version-10 fallback for cameras that cannot supply it. |
| [ADR-033 — Bounded Decode Worker Pool](./ADR-033-rvqr-decode-worker-pool.md) | Proposed | Workers add no optical capacity, and today they measure *slower* — SHA ~15%, the keyframe signature ~59% — because buffers are copied across the boundary. Transfer a cropped `ImageBitmap` instead of cloning `ImageData`, and add 2–4 workers only after multi-lane tiling gives them something to do. |
| [ADR-006 — QR-Bootstrapped BitChat / WebRTC Escalation](./ADR-006-rvqr-p2p-escalation.md) | Proposed | QR carries identity, ephemeral keys, manifests and segment inventories; the payload moves over a WebRTC data channel (RFC 8831) or BitChat. Preserves the optical trust bootstrap and is explicitly **not radio-silent** — opt-in, off by default, empty `iceServers`. `artifacts/p2p.js` implements the WebRTC half and is not wired into the app. |
| [ADR-007 — Ultrasonic Reverse Control Channel](./ADR-007-rvqr-ultrasonic-control-channel.md) | Proposed | Forward optical, reverse acoustic: capability negotiation, fountain rank, signal quality, pause/resume/cancel/complete. Speed comes from omitting unnecessary QR frames, not from acoustic bandwidth. Proposes a ~20-byte RVU1 control frame over 4-tone FSK against `ruvnet/ultrasonic`'s 12.7–20.2 s for a 16-byte command. Records two safety findings: AES-GCM does not stop replay of a recording, and the published 20% error tolerance is tested by negating samples, which a sign-blind decoder cannot see. |
| [ADR-008 — Colour Channels](./ADR-008-rvqr-colour-channels.md) | **Deferred** | Potentially 1.5–3×, deferred with reasons: camera white balance and tone mapping, chroma subsampling, display profiles, and rolling shutter — none of which any measurement in this repository can bound, unlike spatial lanes. Lists what would reopen it. |
| [ADR-035 — Pinned-Fingerprint Admission](./ADR-035-rvqr-signature-admission.md) | Accepted | A pin must be enforced where the artifact is stored, not rendered as a badge. The pure `core.admitArtifact(pin, verification)`: pending never admits, unknown verdicts fail closed, no-pin is unchanged. Records the companion defect — `signManifest` called with reversed arguments, so signing silently never happened — and that the signing key currently sits in plaintext `localStorage`. |
| [ADR-010 — The Acceptance Bar](./ADR-010-rvqr-acceptance-bar.md) | Accepted | Three bars. Milestone: 100 × 40 KB across iPhone Safari and Android Chrome, bright / dim / glare, 20% induced loss, p95 under 30 s. **The bar**: 100 signed 10 MB RVF transfers across three phone/laptop combinations, radios disabled — 100% verification, zero pre-verification vault writes or executions, zero accepted replayed ultrasonic commands, median raw > 100 KB/s, effective > 250 KB/s, p95 < 120 s, memory < 256 MB. Says plainly that the benchmark models frame loss but not optics, so today's figures are engineering baselines, and that the 10 MB bar is set above what any current projection delivers. |

### The deployment plane (011–018, 036)

Ordered by topic, so 036 sits next to the ADR it gives a structure to rather
than at the end — the same reason 031, 033 and 035 sit in the block above.

| ADR | Status | What it decides |
|-----|--------|-----------------|
| [ADR-011 — rvQR Is a Deployment Plane](./ADR-011-rvqr-deployment-plane.md) | Accepted | The framing: rvQR moves code, models, vectors, credentials, policy, state and audit evidence across a disconnected security boundary, and the output is a verified deployment plus a receipt, not a downloaded file. Tabulates the eight-link chain and marks which two ship. States the defensibility argument plainly — animated QR is easy to copy, the full chain is not — and the standard that follows: state of the art is demonstrated by benchmarks, not feature count. |
| [ADR-012 — Post-Quantum Manifest Crypto](./ADR-012-rvqr-post-quantum-manifest.md) | Proposed | Hybrid X25519 + ML-KEM-768 and Ed25519 + ML-DSA-65 (NIST FIPS 203, FIPS 204), because RVF artifacts and credentials are long-lived. **Full signatures live in the manifest, never in every frame** — an ML-DSA-65 signature is 3,309 bytes against a 764-byte payload budget, so per-frame signing is arithmetically impossible. Records a blocking prerequisite: the tree's PQ deps are the archived PQClean lineage (RUSTSEC-2024-0380/0381, RUSTSEC-2026-0162/0163). |
| [ADR-013 — Byte Minimisation](./ADR-013-rvqr-byte-minimisation.md) | Proposed | Dedup and delta beat codec choice for recurring deliveries — a measured 85.1× against a measured 1.320× on the same payload class. FastCDC content-defined chunking (USENIX ATC '16), BLAKE3-addressed chunks, RVF segment delta, Zstd dictionaries. **Corrects a naming drift: RVCOW and `agenticow` are one mechanism with two names.** Encrypts the receiver inventory, because a list of installed models and agents is itself sensitive. |
| [ADR-014 — Fountain Code Selection](./ADR-014-rvqr-fountain-selection.md) | **Open** | Three options — keep the shipped RaptorQ-structured codec (measured 98.45% at exactly K), adopt Wirehair (its published N+0.02), or become RFC 6330 conformant. No winner asserted, because the evidence to pick one does not exist. Names the measurement that would decide it, and notes the choice blocks the fleet broadcast tier. |
| [ADR-015 — Adaptive Transfer Control](./ADR-015-rvqr-adaptive-control.md) | Proposed | A bounded controller, then a constrained bandit, maximising G = R × C × E × P and J = 0.45T + 0.20E + 0.20B + 0.15R. **Hard rules always override learning** — a learned policy that can override a trust gate is not a policy, it is a vulnerability. Records the 278 and 612 KB/s worked figures as projections resting on Decimen's published claims, not our measurements. |
| [ADR-036 — The Transfer Planner: Filter Before Score](./ADR-036-rvqr-transfer-planner.md) | Proposed | The structure that makes ADR-015's "hard rules always override learning" true rather than intended: the rules are a **filter that runs before the scorer**, so a violating candidate is structurally unreachable and its score is not a quantity that exists. Argues why a large negative weight cannot do the job — any finite penalty is a price a confident learned bonus can pay, the failure is silent, and the resulting property is untestable. Says plainly that **0.45/0.20/0.20/0.15 is a judgement, not a measurement**, that 0.40 of it sits on two terms nothing in this repository can evaluate, and what would change it. Records that ADR-015 §2.2 and this ADR expand the same four letters differently — throughput/battery/reliability against time/bytes/risk — and why the second reading is the one the measurements support. Inherits the semantic-inventory defect and locates it exactly: **2,177 B against 1,308 B across both hops**, with `chooseDelta` correct and the missing decision belonging upstream at the receiver. |
| [ADR-016 — Verified Execution and the RVM Handoff](./ADR-016-rvqr-verified-execution.md) | Proposed | No vault write and no execution authority before verification — the same invariant at two layers, with neither trusting the other's word. **Binds to `rvm-witness`'s ADR-134 format rather than defining a second receipt**: 96-byte records, 128-bit keyed-BLAKE3 chain MACs, Merkle sealing, and the existing invariant "no witness, no mutation". |
| [ADR-017 — Strict and Hybrid Transport Modes](./ADR-017-rvqr-transport-modes.md) | Proposed | Strict is light and sound only with radios disabled; hybrid lets optical and ultrasonic establish trust and a radio move the payload. **Mode is a mode, never a fallback** — no failure, including total failure to transfer, promotes strict to hybrid — and the mode in force is recorded in the receipt so an auditor can establish which medium carried a deployment. |
| [ADR-018 — Device Physics and Calibration](./ADR-018-rvqr-device-physics.md) | Proposed | **The largest uncertainty in the programme.** Autofocus, display refresh, camera frame-rate reporting, microphone filtering and speaker response will dominate the laboratory algorithm choices. A ~3 s calibration phase, conservative fallback profiles, and RuVector memory that learns the best *verified* profile per device pair. Every throughput number in the set is an engineering baseline, not a phone result. |

### Bulk transport, execution and delivery (019–028)

| ADR | Status | What it decides |
|-----|--------|-----------------|
| [ADR-019 — rvDrop: The Bulk Transport Tier](./ADR-019-rvdrop-bulk-transport.md) | Proposed | An AirDrop-class local mode sharing rvQR's trust root, explicitly not interoperating with AirDrop. **Do not stripe every medium as an equal data lane** — ultrasound is control, optical is bootstrap or strict mode, WiFi is bulk; race transports and pick the fastest *trusted* one. Shared-LAN QUIC is the pragmatic v1 target on reach and maturity; WiFi Aware is the differentiator once availability is proven. **QUIC, WiFi Aware, BitChat and CDC are absent from the entire tree — this is greenfield.** The fallback chain is the feature. |
| [ADR-020 — Embedded Provenance](./ADR-020-rvqr-embedded-provenance.md) | Proposed | Provenance, SBOM, licences, signer policy, source revision, build identity and vulnerability assertions become **native RVF segments, never sidecar manifests**, mapped onto SLSA v1.2. The lowest-effort, lowest-risk item in the set — it should land early. Provenance is evidence for policy, never policy. |
| [ADR-021 — Measured Device Attestation](./ADR-021-rvqr-device-attestation.md) | Proposed | Bind the handshake to measured RuVix/RVM boot state via DICE, TPM 2.0, Secure Enclave or Android hardware-backed keys, so a sender can require a trusted signer set, current epoch, approved measurement and permitting storage policy. **Attestation is evidence, not authorization** — the same invariant as the pin fix, one layer down. Supersedes the plaintext `localStorage` key. |
| [ADR-022 — Progressive Verified Activation](./ADR-022-rvqr-progressive-activation.md) | Proposed | Split an artifact into independently signed closures — manifest+policy, minimal runtime, hot code and state, cold assets — and start the agent once the minimal closure verifies. The gate is not weakened, it is applied more times. Target: first trusted agent under 3 s. **The highest-risk item in the set**, because every mechanism for running before full verification is a mechanism for running something unverified. |
| [ADR-023 — Physical Presence Fusion](./ADR-023-rvqr-presence-fusion.md) | Proposed | Bind QR line-of-sight, ultrasonic challenge-response and UWB ranging into the session transcript. **No channel may independently authorize activation** — each alone is arrangeable by an attacker; fused they are much harder. Raises the cost of relay MITM without claiming to close it. |
| [ADR-024 — Fleet Swarm Distribution](./ADR-024-rvqr-fleet-swarm.md) | Proposed | BitChat for custody, rank exchange and peer discovery; content-addressed peer transfer on normal links; RaptorQ for lossy broadcast. 100 devices × 1 GB should cost under 3 GB of source traffic, not 100 GB. **A peer is a transport, not an authority** — every device verifies against the source's signed manifest. Blocked on [ADR-014](./ADR-014-rvqr-fountain-selection.md) for the broadcast codec. |
| [ADR-025 — Zero-Copy Pipeline](./ADR-025-rvqr-zero-copy-pipeline.md) | Proposed | One bounded pipeline — read → hash → delta → compress → encrypt → send — with pooled buffers, memory mapping, SIMD BLAKE3 and compression, 4–8 bounded streams. Three budgets treated as contracts: internal throughput ≥ 2× the radio ceiling, fewer than two full payload copies, working memory under 128 MiB. The measured 15%/59% worker regression is what the alternative looks like. |
| [ADR-026 — Optical Turbo Research](./ADR-026-rvqr-optical-turbo.md) | **Experimental** | Camera-calibrated grids, rolling-shutter modulation, adaptive colour constellations, GPU decoding, multiple regions, targeting 0.5–1 MB/s from the 0.10–0.19 MB/s projected baseline. Highest effort and lowest value in the set; justified by strict mode having no alternative, not by competitiveness. Blocks nothing. |
| [ADR-027 — Non-Goals](./ADR-027-rvqr-non-goals.md) | Accepted | Recorded as decisions so they are not revisited by default: no ultrasonic bulk transfer (Google's consumer-hardware state of the art is 94.5 raw bit/s), no arbitrary learned compression, no uncontrolled multipath striping, no AirDrop interoperability, no chasing raw optical competitiveness, and **no learned policy with authority over trust**. Every entry but the last names the evidence that would overturn it. |
| [ADR-028 — Swarm Delivery Structure](./ADR-028-rvqr-swarm-delivery-structure.md) | Proposed | **Agent capacity can be unlimited; shared contract ownership cannot.** One architecture coordinator, seven domains, one owner per module, unlimited workers behind the boundary. Research tournaments scored on S = 0.30 throughput + 0.20 time-to-useful-state + 0.15 energy + 0.15 recovery + 0.20 security confidence. Verification stays independent of implementation teams — the empirical case being three integration-drift incidents in this repository, all caught by verification rather than review. |

### Which suite demonstrates which decision

Acceptance criteria in these ADRs are meant to be *run*, not read.
[`bench/`](../../bench/) carries the suites, and
[docs/benchmarks.md](../benchmarks.md) reports them. Where an ADR states a
number it cannot yet source, the suite below is where that number will come
from.

| Suite | Demonstrates |
|---|---|
| `loss.mjs`, `overhead.mjs` | [ADR-014](./ADR-014-rvqr-fountain-selection.md) — reception overhead and slots under loss |
| `payloads.mjs`, `qrcost.mjs` | [ADR-001](./ADR-001-rvqr-optical-transport.md), [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) — real payload rates, encode/decode cost and the blur cliff |
| `delta.mjs` | [ADR-013](./ADR-013-rvqr-byte-minimisation.md) — delta against codec on a recurring-delivery corpus |
| `proto.mjs` | [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) — v1 against v2 at matched QR versions |
| `compress.mjs` | [ADR-003](./ADR-003-rvqr-adaptive-compression.md) — the 8% whole-envelope threshold |
| `objective.mjs` | [ADR-015](./ADR-015-rvqr-adaptive-control.md) — G = R × C × E × P, reported term by term |
| `fleet.mjs` | [ADR-024](./ADR-024-rvqr-fleet-swarm.md) — source traffic for N receivers |
| `closures.mjs` | [ADR-022](./ADR-022-rvqr-progressive-activation.md) — time to first trusted closure |
| `memory.mjs` | [ADR-025](./ADR-025-rvqr-zero-copy-pipeline.md) — working memory and payload copies |

**No suite covers optics, radios or acoustics**, and none can — see
[ADR-018](./ADR-018-rvqr-device-physics.md) and
[ADR-010](./ADR-010-rvqr-acceptance-bar.md). Everything above is an engineering
baseline; the bars in ADR-010 are what turn one into a result.

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
