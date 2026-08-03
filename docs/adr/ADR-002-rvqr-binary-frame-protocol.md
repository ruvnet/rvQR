# ADR-002: Binary Frame Protocol v2

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | The wire format of an rvQR frame: header, manifest body, and the fields a receiver needs before it touches a payload |
| Implementation | `artifacts/proto2.js`, 26/26 tests in `artifacts/proto2.test.js`. **Not wired into `app.js` or `index.html`** — the app still sends and receives v1 |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-003: Adaptive Compression](./ADR-003-rvqr-adaptive-compression.md), [ADR-004: Multi-Symbol Spatial Lanes](./ADR-004-rvqr-multi-symbol-lanes.md), [ADR-034: QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) (mirrored), [ADR-004: RVF Cognitive Container Format](./ADR-004-rvf-format.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

A v1 data frame is a UTF-8 JSON object with a base64url payload
([docs/protocol.md](../protocol.md)). At the app's 512-byte default the envelope
and the encoding together turn 512 payload bytes into a **741-byte** QR frame —
**44.7% overhead**, recomputed by `proto2.test.js` on every run rather than
asserted. [docs/benchmarks.md](../benchmarks.md) §4 measures the same thing from
the other end as a wire efficiency of 65–72%.

Two thirds of that is base64url, which costs four bytes for every three because
QR byte mode carries arbitrary octets but JSON strings do not. The rest is the
envelope: `{"v":1,"t":…,"h":…,"i":…,"n":…,"p":…}`.

Neither cost is imposed by the medium — QR byte mode is 8-bit clean. Both are
self-inflicted, and they were the right self-infliction for a first transport
whose failure modes needed to be legible in a paste box. They are the wrong one
at the operating point that matters: a version 19 symbol at level L, which holds
792 bytes, of which v1 spends 229 on the encoding rather than the artifact.

There is also a correctness defect to fix while the format is open, and it is
not cosmetic. In the seed format rvQR's closest relative defines
([ADR-034](./ADR-034-qr-cognitive-seed.md) §1.1), compression is a **single
flag** — bit 5, `SEED_COMPRESSED`. One bit can say *that* something is
compressed. It cannot say *with what*. And the two descriptions of that bit do
not agree: the mirrored ADR in this directory renders it as "Microkernel is
LZ-compressed", while the doc comment on the upstream field in
`rvf-types/src/qr_seed.rs` reads **"Microkernel is Brotli-compressed"** — and
`SeedBuilder::compress_microkernel` in `rvf-runtime/src/qr_seed.rs` calls
`compress::compress`, the zero-dependency **SCF-1** LZ77 codec that
[ADR-034](./ADR-034-qr-cognitive-seed.md) §4.1 lists at `rvf-runtime/src/compress.rs`.
The flag says Brotli, the bytes are SCF-1, and nothing on the wire lets a
receiver notice. (The upstream Rust is not in this repository; the source
locations above are as reported by the implementation of `proto2.js` and are the
one claim here that could not be checked locally. The mirrored ADR's own
disagreement about the same bit is checkable and is in
[ADR-034](./ADR-034-qr-cognitive-seed.md) §1.1 and §4.1.)

rvQR must not repeat that, in either direction. "Compressed" is not a decoder,
and a doc comment is not a wire field.

## 2. Decision

### 2.1 A 28-byte binary header on every frame

Frames are octet sequences carried in QR byte mode. All multi-byte fields are
little-endian, stated explicitly because the mnemonic-versus-wire-bytes
confusion [the mirrored ADR-009 wire contract](./ADR-009-rvf-v1-wire-contract.md)
exists to close is exactly
the mistake a reader makes when byte order is left implicit — and asserted by a
test that reads the documented offsets directly.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `52 56 51 32`, ASCII `RVQ2`. Distinct from v1, whose frames are JSON text beginning `{` (`0x7B`), and from the delta magics. |
| 4 | 1 | Version, `2`. A parser rejects any other value rather than guessing. |
| 5 | 1 | Mode: 0 indexed, 1 fountain. Any other value rejected. |
| 6 | 1 | **Codec id.** 0 none, 1 SCF-1, 2 deflate-raw, 3 Brotli. |
| 7 | 1 | **Dictionary id.** 0 none. |
| 8 | 4 | Transfer id, `u32`. |
| 12 | 3 | Index, `u24` — frame number, or encoding symbol id in fountain mode. 0 is the manifest in both. |
| 15 | 3 | Total, `u24` — frame count including the manifest, or K in fountain mode. |
| 18 | 2 | Payload length, `u16`. Must equal the actual remainder of the frame; a frame that disagrees with itself is rejected, never trimmed. |
| 20 | 4 | **Content hash prefix** — first 4 bytes of SHA-256 over the original artifact. Binds every frame to the artifact it claims to belong to; this is v1's `h`. |
| 24 | 4 | **Transport hash prefix** — first 4 bytes of SHA-256 over *this frame's payload*, checked on parse. |

28 bytes. At version 19 level L the symbol holds 792 bytes, leaving **764 for
payload**. Measured against v1 at the identical QR version: **1.492× v1's
512-byte default**, and **1.389× the most v1 can carry at all** (550 bytes,
because v1's own envelope eats the rest).

**Codec id and dictionary id ride in every frame header, not only the manifest.**
That is the decision the defect in §1 argues for, taken further than strictly
necessary: 0 is a declared value meaning "none", never an absent field, and a
receiver that meets a codec it does not know **refuses the transfer** rather than
assuming the bytes are uncompressed and passing them on. A frame whose codec
disagrees with the transfer it claims to join is refused.

There is deliberately **no header checksum**. A QR symbol either passes its own
Reed–Solomon check and yields the exact bytes encoded, or it fails and yields
nothing — the link is an erasure channel, which is the premise the whole
benchmark methodology rests on ([docs/benchmarks.md](../benchmarks.md), "The
channel is an erasure channel"). The per-frame transport hash exists for a
different reason: it is checked *before the payload is used*, so a frame that
arrives wrong is rejected without touching receiver state.

### 2.2 Both hashes, at the two scopes where each is checkable

| Hash | Scope | Size | When |
|---|---|---|---|
| Transport | one frame's payload | 4 bytes, per frame | on parse, before the payload reaches receiver state |
| Content | the whole original artifact | 32 bytes, in the manifest | on finalize, after decoding |

The manifest body — the payload of frame 0, 47 bytes plus the name — carries
`originalSize` (`u32`), `compressedSize` (`u32`), the full 32-byte
`contentHash`, `chunkSize`, `k`, and the name length and name.

**`originalSize` and `compressedSize` are separate fields on purpose**: with one
of them, a receiver cannot tell a codec that expanded its input from a sender
that is lying. With both, the decoder's output length is checked against a
declaration — and a decoder returning the wrong length is refused rather than
trusted, which has its own test.

The content hash remains the acceptance rule and is unchanged from v1
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2): a substituted chunk that
somehow satisfied its frame's transport hash is still caught on finalize. The
name is deliberately **not** covered by the content hash — it is the one
sender-controlled field the hash cannot reach — so it is sanitised on the way
out, and a manifest declaring `../../etc/passwd` stores as `_.._etc_passwd`.

### 2.3 An ASCII armour, because the bundled decoder cannot return bytes

This is the constraint that most shapes the result, and it is a property of
rvQR's fallback decoder rather than of QR.

`vendor/qrdecode.js` collects byte-mode octets and hands them to a UTF-8
decoder, so its only output is a JavaScript string: a frame that is not valid
UTF-8 returns replacement characters and the original bytes are gone. The native
`BarcodeDetector` path has the same shape — it yields `rawValue`, a string.

So v2 ships two transports for the same canonical frame. `encodeFrame()` returns
the raw 28-byte-header octets, which go straight into a byte-mode segment with
no expansion. `toTransport()` / `fromTransport()` repack the frame's bits **7 at
a time** into bytes `0x00`–`0x7F`, which are single-byte UTF-8 and survive a
`TextDecoder` exactly.

The armour costs **8/7 = 14.3%** against base64url's 4/3 = 33.3%, both measured
across payload sizes. At version 19-L that is **665 payload bytes** rather than
764 — still **1.30× v1's default** and 1.209× v1's maximum. Widening the
alphabet does not help: two-byte UTF-8 sequences carry 11 bits per 2 bytes, 5.5
bits per byte against ASCII's 7.

The honest reading: **the full 1.49× is available only where the raw octets can
reach the parser**, which today means neither of the app's two decode paths. Any
integration has to either recover the raw bytes from the decoder or take the
armoured 1.30×.

### 2.4 v1 and v2 refuse each other by name

A v2 parser fed a v1 frame names it as v1; a v1 parser fed a v2 frame names it
as v2. Both have tests, in both text and byte form. v1 frames still build
byte-for-byte as they did, asserted against a frozen form.

Senders emit one format for a whole transfer. There is no mixed stream and no
downgrade negotiation, because a negotiation over a channel with no back channel
is not a negotiation ([ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) is
where that changes, if it does).

### 2.5 The ceilings from ADR-001 are inherited, not re-chosen

`proto2.js` reads `MAX_FRAMES`, `MAX_RECEIVE_CHUNK` and the rest from `core.js`
rather than picking its own, because a v2 receiver is exposed to exactly what a
v1 receiver is: an unauthenticated frame from whatever is pointed at the camera
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.3). Where v2 differs it is
stricter, never looser — 27 hostile frames are refused without any of them
throwing, and declared sizes that disagree with the bytes are rejected rather
than repaired.

## 3. Consequences

### What this buys

- **1.492× payload per symbol at the operating point that survives blur**, and
  1.30× through the armour. Not at a denser symbol: version 19 is the last one
  the blur sweep in [docs/benchmarks.md](../benchmarks.md) §6 reads at every
  scale that fits a 720p frame, so this buys throughput without spending
  robustness — the opposite of raising the chunk size.
- **A codec identifier that cannot drift from the bytes.** The defect in §1
  becomes unrepresentable, and an unknown codec is a refusal rather than a
  guess.
- **A frame is checked before it is used.** The per-frame transport hash keeps a
  damaged payload out of receiver state entirely.
- **Room for the rest of the roadmap.** Fountain mode is already in the header;
  repair symbols above K are a documented, tested case rather than a future
  format change.

### What it costs, honestly

- **It is not wired in.** `app.js` and `index.html` contain no reference to
  `proto2.js`. Every measured figure above is a property of the module, not of
  a transfer anyone has performed.
- **Neither decode path can carry the raw form today**, so the realistic
  near-term gain is the armoured 1.30×, not 1.49×. §2.3.
- **The paste-a-frame receive path stops being human-readable.** v1 frames are
  JSON you can read; v2 frames are octets or 7-bit-packed ASCII. That is a real
  regression for anyone diagnosing a transfer by eye
  ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.7).
- **The compressed stream as a whole has no 32-byte digest.** The strong hash is
  over the *reconstructed artifact*; the compressed bytes are covered at 32 bits
  per frame. That is ample against corruption on an erasure channel and it is
  not a strong statement about a sender that lies — which is unchanged from v1,
  where authenticity does not exist either
  ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2,
  [ADR-009](./ADR-009-rvqr-signature-admission.md)).
- **The codec table is not RuVector's**, and that is a conflict rather than a
  cost — see [ADR-003](./ADR-003-rvqr-adaptive-compression.md) §2.1 and §2.5.
  `proto2.js` ships 1 = SCF-1, 2 = deflate-raw, 3 = Brotli where
  [ADR-004 §5.1](./ADR-004-rvf-format.md) assigns 1 = LZ4, 2 = Zstd, 3 = Brotli.
  Only Brotli coincides, and Zstd — ADR-003's default — has no id at all.
- **Two formats to maintain, or a flag day.** rvQR is a static page with no
  deployment coupling between the two devices, so "both sides update" is not
  something the protocol can arrange.
- **1.49× does not change the character of the channel.** It is a necessary
  step underneath [ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
  [ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md), not a fix on its own.

## 4. Acceptance criteria

Items 1–7 are met by `artifacts/proto2.test.js` at 26/26. Items 8–11 are not.

1. ✅ **Measured, not asserted.** Bytes per frame for v1 and v2 at a fixed QR
   version are recomputed every run: 792 B capacity, v1 741 B at its default
   (44.7% overhead), v2 764 B, armoured 665 B.
2. ✅ **Size and layout.** 28-byte header, payload carried verbatim, every field
   round-tripped, little-endianness asserted at the documented offsets.
3. ✅ **Codec honesty.** All four codec ids and the dictionary id round-trip with
   0 as a value; a compressed transfer is refused without a decoder and verified
   byte-exact with one; a decoder returning the wrong length is refused.
4. ✅ **Hostile input.** 27 malformed frames refused without throwing; declared
   sizes that disagree with the bytes rejected rather than repaired; ceilings no
   looser than v1's; oversized names refused at encode and clamped at build.
5. ✅ **Both hashes do their own job.** A transport-hash mismatch is caught on
   parse with receiver state untouched; a substituted chunk that gets past it is
   caught by the content hash on finalize.
6. ✅ **Cross-version refusal**, both directions, in text and byte form, with v1
   frames still byte-identical to their frozen form.
7. ✅ **Armour.** 8/7 measured against base64url's 4/3; non-ASCII and non-zero
   padding refused.
8. ⬜ **Golden byte vectors checked in as hex** for a manifest and a data frame
   of the demo module, failing on any byte change. Round-trip tests do not catch
   a layout change made consistently on both sides.
9. ⬜ **Wired into the app**, with a decode path that can deliver either the raw
   octets or the armoured form, and the resulting gain measured end to end
   rather than at the module.
10. ⬜ **Codec ids reconciled with [ADR-004 §5.1](./ADR-004-rvf-format.md)**, or
    ADR-003 amended to match — one or the other, before anything depends on the
    numbering.
11. ⬜ **[ADR-010](./ADR-010-rvqr-acceptance-bar.md) passed on a v2 transfer.**
