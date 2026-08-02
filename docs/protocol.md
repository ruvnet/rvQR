# rvQR Protocol

## Current Implementation (v1)

rvQR uses a simple, deterministic protocol for optical artifact transfer. A frame is one QR code containing a single UTF-8 JSON object with no whitespace.

### Frame Structure

**Manifest frame (always sequence 0):**

```json
{"v":1,"t":"<8 lowercase hex chars>","h":"<8 hex chars>","i":0,"n":<integer>,"m":{"name":"<string>","size":<integer>,"sha256":"<64 hex chars>","chunk":<integer>}}
```

**Data frame (sequences 1 through n-1):**

```json
{"v":1,"t":"<8 hex>","h":"<8 hex>","i":<integer>,"n":<integer>,"p":"<base64url string>"}
```

### Field Semantics

| Field | Type | Meaning | Scope |
|-------|------|---------|-------|
| v | integer | Protocol version; currently 1. A receiver rejects frames with unknown v. | All frames |
| t | string | Transfer ID, 8 lowercase hex characters, random per send session. Distinguishes different transfers of the same file and lets the receiver notice if the sender restarts. | All frames |
| h | string | First 8 hex characters of the artifact SHA-256. Lets the receiver bind data frames to a transfer before the manifest has arrived. A manifest whose full hash does not begin with h is rejected. | All frames |
| i | integer | Frame sequence number. Frame i carries artifact bytes [(i-1)*chunk, min(i*chunk, size)). Frame 0 is the manifest. | All frames |
| n | integer | Total frames including the manifest. Computed as 1 + ceil(size / chunk). A manifest whose n contradicts its size and chunk is rejected. | All frames |
| p | string | Base64url (RFC 4648 section 5: alphabet A-Za-z0-9-_, padding stripped). Encodes the artifact chunk at sequence i-1. Chosen because it survives QR byte mode and needs no JSON string escaping, at a 4/3 size cost. | Data frames only |
| m | object | The manifest object, present only on frame 0. Contains name, size, sha256 (full 64-char hash), and chunk (bytes per data frame). | Manifest only |

### Size Budget

Frame text length is approximately **4 \* ceil(chunk / 3) + 80 to 95 bytes** of JSON header.

With the default 512-byte chunk:
- Frame text ≈ 4 × ceil(512/3) + 87 ≈ 683 + 87 = **~740 bytes text**
- QR encoder places this at **version 19, level L**
- Smaller final frames use much smaller symbols (version 5 and up in practice)

**Tradeoff:** Larger chunks yield fewer frames but denser QR symbols that phone cameras may fail to resolve. Smaller chunks scan more reliably but require more frames. Level L error correction maximizes payload; level M buys roughly 15% recoverable damage at lower capacity.

The sender's chunk slider spans **128 to 1024 bytes**; the app auto-selects the smallest QR version that fits each frame.

### Receiver State Machine

```
IDLE
  │ (on first valid frame, adopt its t and h)
  ▼
COLLECTING
  │ (store each frame by i; ignore duplicates, unknown v, mismatched t/h/n)
  │ (may arrive in any order; manifest may arrive last)
  │ (when manifest arrived AND every sequence 1..n-1 is present)
  ▼
COMPLETE
  │ (concatenate payloads in order, compute SHA-256)
  ▼
VERIFIED (hash matches manifest) ──→ Store to vault
   │
   └──→ REJECTED (hash mismatch) ──→ Discard (no partial acceptance)
```

### Loss Handling Today

v1 has no forward error correction of its own above the QR layer, and no back channel. It compensates the cheap way: the sender loops its frame stream forever, so a receiver that missed frame 37 on the first pass simply picks it up on the next one. Duplicates cost nothing — the receiver stores each sequence once and counts the rest. This is why a transfer can start mid-stream, survive a hand wobble, and still complete, at the price of taking longer the more frames were missed. RaptorQ (below) replaces this with something far better.

### Integrity Rules

- Every byte accepted into the vault has been verified against the manifest hash.
- A hash mismatch discards the **entire transfer**. There is no partial acceptance.
- QR's own Reed-Solomon error correction means a frame either decodes intact or does not decode at all. Damaged frames are dropped, not silently accepted.
- The hash authorizes storage. **Storage is not execution.**

### Protocol Version Semantics

Protocol version 1 is the current, stable version. New major features (RaptorQ, encryption, signature verification) will be introduced in protocol version 2 and beyond. Receivers MUST reject frames with an unknown protocol version; senders MUST advertise the minimum version that carries all their features.

## Roadmap

The following features are designed but not yet implemented. They represent the next phases of rvQR development.

### RaptorQ Fountain Coding (RFC 6330)

**Status:** Designed; implementation pending.

The current protocol requires every frame to arrive intact and in roughly the right order (or buffered for out-of-order reassembly). RaptorQ replaces fixed chunks with an unbounded stream of encoding symbols.

**How it works:**
- The sender emits an unbounded stream of encoding symbols derived from the K source symbols, and simply keeps going.
- The receiver reconstructs the original artifact once it holds **any** K + ε symbols — a small overhead over K, typically a couple of symbols — regardless of *which* ones arrived.
- A dropped frame costs exactly one extra symbol, not a retransmission round trip.
- The sender never needs to learn what the receiver missed.

**Benefits:**
- Resilience to frame loss without explicit feedback.
- Optimal for high packet-loss optical channels (e.g., poor camera angles, glare).

**Protocol change:**
- Frame p field carries an encoding symbol, not a source chunk.
- Manifest includes an "encoding" field indicating fountain mode.

### RVF Segment-Map Delta Transfer

**Status:** Designed; implementation pending.

RVF containers are append-only segment streams with a 4096-byte root manifest at the tail. Most updates affect only a small fraction of segments. Delta transfer sends only the missing segments.

**How it works:**
- The receiver displays a compact QR code carrying its own root manifest hash plus a **segment map** (bitmap of segments it already has).
- The sender receives this QR, diffs its own segment list against the receiver's map, and transmits only the missing segments.
- For a 1 GB artifact with 1% changed data (10 MB): transfer time drops from roughly **2 hours to roughly 75 seconds** at 140 KB/s.

**Benefits:**
- Dramatic speedup for incremental updates.
- Receiver controls which segments it needs.

**Protocol change:**
- Manifest includes optional "segments" field (bitmap or run-length encoding).
- Receiver uses a separate "poll" QR to advertise its state.

### BitChat Session Bootstrap

**Status:** Designed; implementation pending.

The optical data plane can carry encrypted payloads over an authenticated control channel. A bootstrap QR exchanges keys; subsequent data frames carry encrypted artifacts.

**How it works:**
- Sender generates an ephemeral X25519 keypair.
- Sender encodes the public key in a bootstrap QR.
- Receiver scans, decodes the public key, and generates its own ephemeral keypair.
- Both sides derive shared session keys using **HKDF-SHA256**.
- Receiver sends its public key in a (different) bootstrap QR back to the sender, or implicitly via first data frame.
- Subsequent data frames carry base64url-encoded, ChaCha20-Poly1305 ciphertexts.

**Benefits:**
- Privacy: an observer watching QR codes sees only encrypted blobs.
- Authentication: both sides prove they hold the shared secret.

**Protocol change:**
- New frame types: "bootstrap" (carries X25519 public key).
- Data frame p field contains ChaCha20-Poly1305 ciphertext instead of plaintext base64url.
- Manifest or separate frame carries AEAD nonce and tag.

### Signed Manifest Verification

**Status:** Designed; implementation pending.

Manifests can carry detached signatures, verified against a pinned key before artifacts leave quarantine.

**How it works:**
- Sender signs the tuple (name, size, sha256) using Ed25519 (via rvf-crypto).
- Manifest frame includes a "signature" field (base64url-encoded Ed25519 signature).
- Receiver verifies the signature against a pinned public key before the artifact is released from quarantine.
- A signature mismatch marks the artifact as untrusted; activation is blocked.

**Benefits:**
- Authenticity: receiver confirms the artifact came from a trusted source.
- Tamper detection: any change to name, size, or hash invalidates the signature.

**Protocol change:**
- Manifest m object includes optional "signature" field.
- Receiver configuration includes a "trusted_keys" list of Ed25519 public keys (base64url).

### Quarantine and Activation Split

**Status:** Designed; currently partially implemented (quarantine only).

Received artifacts are inert data until explicitly activated. Activation is a separate, privileged operation.

**Current state:**
- Artifacts arrive in quarantine (IndexedDB vault).
- Export/download is safe (data only, no execution).
- WASM inspection is compile-only (never instantiates modules).

**Planned:**
- Proof-gated installer: activating a WASM artifact requires a proof (e.g., from rvf-crypto) that the payload is authentic.
- Witness record: every activation emits a timestamped, signed witness record.
- Revocation: a manifest signature can be revoked; stored artifacts inherit the revocation.

**Benefits:**
- Tight boundary between transport authority and execution authority.
- Audit trail of what ran and when.

### Resume After Browser Termination

**Status:** Designed; implementation pending.

A transfer interrupted by browser close, network failure, or device sleep should resume cleanly.

**How it works:**
- Transfer state (t, h, received sequence map, partial payloads) is persisted to IndexedDB or localStorage.
- On next session, the receiver detects the incomplete transfer and offers "Resume" or "Discard".
- If resumed, the receiver re-enters COLLECTING state and ignores frames it already has.

**Benefits:**
- Seamless recovery from transient interruptions.
- No duplicate acceptance (receiver skips already-received frames).

## Acceptance Test Bar

The implementation must clear the following tests:

1. **100 transfers of 100 MB each, zero incorrectly accepted files.** Every transferred byte must match the source; no false positives, no silent corruption.
2. **Successful recovery under 20% frame loss.** (Requires RaptorQ.)
3. **Resume after browser termination.** (Requires persistent transfer state.)

These tests validate both the protocol and the implementation against real-world failure modes.

## Related Specifications

- **RVF Container Format** — [ADR-009: RVF Version 1 Wire Contract](./adr/ADR-009-rvf-v1-wire-contract.md) (mirrored): segment magic `53 46 56 52`, root manifest magic `30 4D 56 52`. Note that "RVFS" and "RVM0" are the *big-endian* mnemonics of the numeric constants; RVF serializes little-endian, so those mnemonics never appear as ASCII on the wire. A 4096-byte root manifest sits at the tail of the newest manifest payload, and there is no header at offset zero. The full mirrored ADR set is indexed in [docs/adr/](./adr/README.md).
- **rvf-crypto**: Cryptographic signing, verification and the witness chain for RVF containers. Where it slots into the receive pipeline is sketched in [docs/ecosystem.md](./ecosystem.md).
- **@ruvector/rvf-wasm** (`0.1.9`): the RVF WebAssembly runtime, a 39 KB module. rvQR bundles it as the demo artifact — as payload to move, not as a dependency it loads.
- **RuVector** (https://github.com/ruvnet/RuVector): Parent project and specification authority.

## References

- RFC 4648 — Base Encoding Data Formats (base64url)
- RFC 6330 — RaptorQ Forward Error Correction for Object Delivery
- HKDF-SHA256 — HMAC-based Extract-and-Expand Key Derivation Function
- X25519 — Elliptic Curve Diffie-Hellman (Curve25519)
- ChaCha20-Poly1305 — AEAD cipher (RFC 8439)
- Ed25519 — Public-key signature system (RFC 8032)
