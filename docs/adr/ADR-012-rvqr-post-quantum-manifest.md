# ADR-012: Post-Quantum Manifest Cryptography

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | What the bootstrap manifest carries cryptographically, and where signatures may and may not appear |
| Implementation | None. And the prerequisite in §2.4 is not a detail — the tree's post-quantum dependencies are on archived crates |
| Related | [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-021](./ADR-021-rvqr-device-attestation.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-035](./ADR-035-rvqr-signature-admission.md) made a pinned fingerprint
enforceable at the vault write. It says nothing about what algorithm produced
the signature, and the answer today is Ed25519 over a manifest, with an X25519
handshake sketched for the escalated path
([ADR-006](./ADR-006-rvqr-p2p-escalation.md)).

That is fine for a demonstration and wrong for the artifacts rvQR is meant to
carry. **RVF containers, model weights, policy and credentials are long-lived.**
A container signed today may be verified in a decade, and a session key
negotiated today protects a transcript an adversary can record now and attack
later. Harvest-now-decrypt-later is not a hypothetical threat model for a
courier whose whole purpose is moving material across a boundary somebody is
interested in.

## 2. Decision

### 2.1 The manifest is the cryptographic unit

The bootstrap manifest carries: session id, receiver identity, protocol version,
codec and dictionary ids, the artifact's content digest, X25519 key material,
and optionally ML-KEM-768 encapsulation. Everything a receiver needs to decide
*whether to proceed* is in one place, arrives in one frame, and is covered by
one signature.

### 2.2 Hybrid, not replacement

Key establishment is **X25519 + ML-KEM-768**, combined so that the session key
depends on both. Signatures are **Ed25519 + ML-DSA-65**, both required.

- [NIST FIPS 203](https://csrc.nist.gov/pubs/fips/203/final) — ML-KEM, the
  standardised module-lattice KEM.
- [NIST FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) — ML-DSA, the
  standardised module-lattice signature scheme.

Hybrid rather than a swap because the classical primitives have two decades of
cryptanalysis and the lattice ones have far less; an attacker must break both.
The cost is size, and §2.3 is where that bites.

### 2.3 Full signatures live in the MANIFEST, never in every frame

**This is the constraint that governs the design, and it is a throughput
decision as much as a cryptographic one.**

The entire programme in [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md),
[ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) is a fight for bytes inside a
792-byte version 19-L symbol, of which v2 leaves 764 for payload. An Ed25519
signature is 64 bytes; an ML-DSA-65 signature is 3,309 bytes, which
[ADR-034 §1.2](./ADR-034-qr-cognitive-seed.md) already notes "requires 2-QR" for
a seed. Per-frame:

| Per-frame signature | Payload left of 764 | Versus v2 unsigned |
|---|---:|---|
| none (manifest only) | 764 | — |
| Ed25519, 64 B | 700 | −8.4% |
| ML-DSA-65, 3,309 B | **negative** | does not fit in the symbol at all |

So per-frame signing would give back the entire 1.492× that v2 bought, and
post-quantum per-frame signing is not merely expensive but arithmetically
impossible at this symbol size. **Signatures go in the manifest. Frames are
bound to the signed manifest by hash, not by their own signatures** — which is
exactly what v2's per-frame transport hash and content-hash prefix already do.

The manifest itself may span multiple frames when ML-DSA is present, and those
frames are protected the same way every other frame is: by the content hash the
manifest commits to, verified before anything is admitted.

### 2.4 Migrating off the archived PQClean lineage is a prerequisite, not a step

"Add ML-KEM-768" reads as additive. It is not. Verified in the tree:

- `crates/ruvector-dag/Cargo.toml:14` gates post-quantum behind
  `production-crypto = ["pqcrypto-dilithium", "pqcrypto-kyber"]` — the
  **pre-standardisation** Kyber and Dilithium names, at versions 0.8 and 0.5.
- `.cargo/audit.toml` records why those are muted:
  - **RUSTSEC-2024-0380** — `pqcrypto-dilithium`, replaced by `pqcrypto-mldsa`.
  - **RUSTSEC-2024-0381** — `pqcrypto-kyber`, replaced by `pqcrypto-mlkem`.
  - **RUSTSEC-2026-0162** and **RUSTSEC-2026-0163** — `pqcrypto-traits` and
    `pqcrypto-internals`, unmaintained because upstream PQClean is being
    archived.
- `crates/ruvix/crates/boot/Cargo.toml:23` separately comments that it verifies
  **ML-DSA-65 signatures (NIST FIPS 204)** "using pqcrypto" — a second site on
  the same lineage.

Pre-standardisation Kyber and Dilithium are **not** ML-KEM and ML-DSA. The
parameter sets and the derivation differ, so an artifact signed by the old crates
does not verify under the standard and vice versa. Building rvQR's manifest
crypto on top of the archived lineage would produce signatures that are neither
FIPS 204 nor maintained.

**Decision: migrating `ruvector-dag` and `ruvix-boot` to `pqcrypto-mlkem` and
`pqcrypto-mldsa`, or to another maintained ML-KEM/ML-DSA implementation, is a
prerequisite for this ADR and blocks it.** The four RUSTSEC ignores above are
the tracking list, and they should be removed rather than renewed.

### 2.5 Algorithm identifiers are explicit and versioned

Every manifest names its KEM and its signature algorithm by identifier, and an
unknown identifier is a refusal, never a fallback to a weaker one. This is the
same rule [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) applies to codecs,
for the same reason, and it is the direct lesson of the `SEED_COMPRESSED` defect:
an algorithm that is implied rather than declared will eventually be the wrong
algorithm.

Downgrade is refused rather than negotiated. There is no back channel to
negotiate over ([ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md)), and a
downgrade an attacker can induce is not a compatibility feature.

## 3. Consequences

### What this buys

- **Artifacts that stay verifiable.** A container signed under FIPS 204 does not
  need re-signing when a classical assumption weakens.
- **Recorded transcripts stay closed.** Hybrid key establishment means a session
  recorded today is not opened by a future attack on X25519 alone.
- **The byte budget survives.** §2.3 makes the throughput programme and the
  cryptography programme compatible instead of competing.

### What it costs, honestly

- **A blocked prerequisite in someone else's crate.** §2.4 is real work outside
  this repository, and the tree currently mutes four advisories rather than
  doing it.
- **Manifest frames get bigger and may span symbols.** An ML-DSA-65 signature is
  3,309 bytes — at 764 payload bytes per frame that is five frames of manifest
  before any payload moves, where v1's manifest was one easily-scanned symbol
  ([docs/protocol.md](../protocol.md): ~183 bytes, version 8). On a 40 KB
  artifact that is a measurable fraction of the transfer, and on a 2 KB one it
  dominates.
- **Verification cost on a phone is unmeasured.**
  [docs/benchmarks.md](../benchmarks.md) §9 records signature verification as
  not measured because there is no signing path to time; adding lattice
  signatures makes that gap larger, not smaller.
- **Hybrid doubles the key material** in a manifest whose size is already the
  problem in the previous bullet.
- **None of it is implemented.**

## 4. Acceptance criteria

1. **The prerequisite is discharged first.** `ruvector-dag` and `ruvix-boot`
   build against maintained ML-KEM/ML-DSA crates, and RUSTSEC-2024-0380,
   -0381, -2026-0162 and -0163 are removed from `.cargo/audit.toml` rather than
   renewed.
2. **Known-answer tests against the FIPS 203 and FIPS 204 vectors**, not only
   round-trip tests. A round trip passes happily against a wrong implementation
   of both halves.
3. **Hybrid is genuinely hybrid.** A test disables each half in turn and asserts
   the session key changes and verification fails — proving neither is
   decorative.
4. **No signature appears in a data frame.** Asserted structurally, so the byte
   budget cannot be eroded by a later change.
5. **Unknown algorithm ids are refused**, and a downgraded manifest is refused,
   each with its own test.
6. **Manifest frame count is measured** for Ed25519-only and hybrid, for both
   demo artifacts, and reported in `bench/` — this is a throughput cost and
   belongs in the throughput numbers.
7. **Verification latency measured on both target phones**, since it now sits on
   the path between "bytes arrived" and "anything is stored"
   ([ADR-035](./ADR-035-rvqr-signature-admission.md) refuses on a pending
   verdict, so slow verification is a liveness cost).
