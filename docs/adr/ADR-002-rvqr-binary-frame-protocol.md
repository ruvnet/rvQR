# ADR-002: Binary Frame Protocol v2

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | The wire format of an rvQR frame: header, manifest body, and the fields a receiver needs before it touches a payload |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-003: Adaptive Compression](./ADR-003-rvqr-adaptive-compression.md), [ADR-004: Multi-Symbol Spatial Lanes](./ADR-004-rvqr-multi-symbol-lanes.md), [ADR-034: QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) (mirrored), [ADR-004: RVF Cognitive Container Format](./ADR-004-rvf-format.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

A v1 data frame is a UTF-8 JSON object with a base64url payload
([docs/protocol.md](../protocol.md)). At the app's 512-byte default the envelope
and the encoding together turn 512 payload bytes into a 740-byte QR frame — a
44% expansion, measured across the whole chunk range in
[docs/benchmarks.md](../benchmarks.md) §4 and §6, which reports wire efficiency
of 65–72% depending on payload.

Two thirds of that overhead is base64url, which costs four bytes for every
three because QR byte mode carries arbitrary octets but JSON strings do not. The
rest is the envelope itself: `{"v":1,"t":…,"h":…,"i":…,"n":…,"p":…}` is 54 to 56
bytes of punctuation and hex.

None of this is required by the medium. QR byte mode carries binary. The JSON
was chosen because it is legible in a paste box and trivial to parse, and that
was the right call for a first transport whose failure modes needed to be
readable. It is not the right call for the operating point that matters, which
is a version 19 symbol at level L: 792 bytes of capacity, of which 280 are spent
on the encoding rather than the artifact.

There is also a correctness defect to fix while the format is open, and it is
not cosmetic. In the seed format rvQR's closest relative defines
([ADR-034](./ADR-034-qr-cognitive-seed.md) §1.1), compression is a **single
flag** — bit 5, `SEED_COMPRESSED`, "Microkernel is LZ-compressed". A flag can
say *that* something is compressed. It cannot say *with what*. Meanwhile the
format family's own compression contract
([ADR-004 §5.1](./ADR-004-rvf-format.md)) enumerates codecs by code — None
`0x00`, LZ4 `0x01`, Zstd `0x02`, Brotli `0x03` — and its tiered strategy (§5.2)
assigns **Brotli** to WASM payloads, while the RVQS builder actually invokes
**SCF-1**, a custom LZ77 with a 4 KB window
([ADR-034](./ADR-034-qr-cognitive-seed.md) §4.1, `rvf-runtime/src/compress.rs`).
A receiver that reads the flag and follows the contract reaches for the wrong
decoder. The bytes and the label disagree, and nothing on the wire lets a
receiver notice.

rvQR must not repeat that. Any format that can carry compressed payloads has to
name the codec explicitly, because "compressed" is not a decoder.

## 2. Decision

### 2.1 A 28-byte binary header on every frame

Frames become octet sequences carried in QR byte mode. All multi-byte integers
are little-endian, stated here because the mnemonic-versus-wire-bytes confusion
[ADR-009](./ADR-009-rvf-v1-wire-contract.md) exists to close is exactly the
mistake a reader makes when byte order is left implicit.

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | Magic. The two octets `0x52 0x51`. |
| 2 | 1 | Protocol version. `2` for this format. |
| 3 | 1 | Type and flags. Bits 0–2: frame type (0 manifest, 1 source, 2 repair, 3 control). Bits 3–7: reserved, sender MUST zero. |
| 4 | 4 | Transfer id, `uint32`. Replaces v1's 8 hex characters. |
| 8 | 8 | Transport hash prefix — the first 8 bytes of the transport hash defined in 2.2. Binds a data frame to a transfer before its manifest has arrived, which is what v1's `h` did in 4 hex characters' worth of entropy. |
| 16 | 4 | Frame index, or encoding symbol id in fountain mode, `uint32`. |
| 20 | 4 | Frame count, or source block size K, `uint32`. |
| 24 | 2 | Payload length in bytes, `uint16`. |
| 26 | 2 | Reserved. Sender MUST zero; receiver MUST reject non-zero, so the field stays available. |

28 bytes. At version 19 level L the symbol holds 792 bytes, leaving **764 for
payload**; the sender's default chunk becomes **760**, keeping four bytes of
slack. Against v1's 512 payload bytes in the same symbol that is **1.484×** more
artifact per frame, and it raises wire efficiency from a measured 69% to 96%.

There is deliberately **no header checksum**. A QR symbol either passes its own
Reed–Solomon check and yields the exact bytes encoded, or it fails and yields
nothing — the link is an erasure channel, which is the premise the whole
benchmark methodology rests on ([docs/benchmarks.md](../benchmarks.md),
"The channel is an erasure channel"). A CRC over a header that arrived through
Reed–Solomon protects against nothing and costs two bytes. This is *not* the
same situation as `artifacts/p2p.js`'s four-byte SDP tag, which exists because a
tokenised codec can decode a damaged payload into a *different valid* SDP; there
the damage arrives through a channel with no integrity check of its own.

### 2.2 The manifest body names the codec, the dictionary, both sizes and both hashes

A manifest frame (type 0) carries this body after the 28-byte header:

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | **Codec id**, `uint16`. Values are RuVector's, not rvQR's: `0x0000` none, `0x0001` LZ4, `0x0002` Zstd, `0x0003` Brotli ([ADR-004 §5.1](./ADR-004-rvf-format.md)). `0x00F1` names SCF-1 explicitly for RVQS interoperability. A receiver MUST reject an unknown codec id rather than guess. |
| 2 | 2 | **Dictionary id**, `uint16`. `0x0000` means no dictionary. A payload compressed against a dictionary the receiver does not hold is undecodable, so this has to be on the wire and not implied by the codec. |
| 4 | 8 | **Original size**, `uint64` — the length of the artifact after decoding. |
| 12 | 8 | **Compressed size**, `uint64` — the number of octets actually carried. Equal to original size when the codec is `0x0000`. |
| 20 | 32 | **Transport hash** — SHA-256 over the octets as carried, i.e. after compression. |
| 52 | 32 | **Content hash** — SHA-256 over the original artifact, after decoding. This is v1's `m.sha256` and it remains the acceptance rule. |
| 84 | 2 | Name length, `uint16`. |
| 86 | var | Name, UTF-8, subject to v1's sanitisation and 255-byte ceiling. |
| … | var | Optional TLVs: signature, segment inventory, sender public key. |

**Two hashes, because they answer different questions at different times.** The
content hash is the one that authorises storage and it cannot be checked until
the payload has been decoded. The transport hash can be checked on the bytes as
they arrive, *before* a receiver spends memory inflating them — which is what
makes "reject a payload whose inflated length would exceed the declared original
size" a bound and not a hope. Carrying only the content hash would mean the only
way to find out whether a compressed stream was worth decompressing is to
decompress it.

Both are 32 bytes and both are mandatory. When the codec is `0x0000` they are
equal, and that redundancy is 32 bytes on one frame in the entire transfer.

### 2.3 The ceilings from ADR-001 carry across unchanged

`n ≤ 65536`, `size ≤ 256 MB`, name ≤ 255 characters, and a per-frame payload
that cannot exceed a version 40 symbol's capacity — all of these are bounds on
attacker-controlled values applied before use, and none of them are affected by
the framing changing ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.3). Two
are added:

- Compressed size MUST equal the sum of the payload lengths actually received.
- Original size MUST be at most 256 MB and the decoder MUST stop at it, so a
  decompression bomb costs a bounded allocation and a rejection.

### 2.4 Version 2 is a clean break, not a negotiation

A v1 receiver rejects unknown protocol versions already, and a v2 frame is not
valid JSON, so the two formats cannot be confused for each other. Senders emit
one or the other for a whole transfer. There is no mixed-version stream and no
downgrade path, because a downgrade negotiated over a channel with no back
channel is not a negotiation.

## 3. Consequences

### What this buys

- **1.484× payload per symbol at the operating point that survives blur.** Not
  at a denser symbol: version 19 is the last one the blur measurement in
  [docs/benchmarks.md](../benchmarks.md) §6 reads at every scale that fits a
  720p frame, and this change buys throughput without moving off it. Projected
  from the measured 2.44 KB/s default, v2 alone gives about 3.6 KB/s at the same
  5 fps.
- **A codec identifier that cannot drift from the bytes.** The defect described
  in §1 becomes unrepresentable: a v2 manifest that says Zstd and carries Brotli
  fails its transport hash.
- **A bound on decompression before decompression.** The transport hash and the
  declared original size are both checkable before the first inflated byte
  exists.
- **Room for the rest of the roadmap.** The type field has four values and five
  spare bits; repair frames, control frames and segment inventories all have a
  place to live without another format change.

### What it costs, honestly

- **The paste-a-frame receive path stops being human-readable.** v1 frames are
  JSON you can read in a text box; v2 frames are octets. The paste path
  ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.7) has to accept a
  base64url rendering of the binary frame instead, which is a strictly worse
  debugging experience and a real regression for anyone diagnosing a transfer.
- **Two formats to maintain, or a flag day.** Every receiver that has to
  interoperate with an existing sender needs both parsers. rvQR is a static page
  with no deployment coupling between the two devices, so "both sides update"
  is not something the protocol can arrange.
- **1.48× does not change the character of the channel.** 3.6 KB/s instead of
  2.44 KB/s still makes 100 MB an overnight job. This is a necessary step
  underneath [ADR-003](./ADR-003-rvqr-adaptive-compression.md) and
  [ADR-004](./ADR-004-rvqr-multi-symbol-lanes.md), not a fix on its own.
- **The 8-byte transport-hash prefix costs 4 bytes more than v1's `h`** and
  buys binding strength nobody has complained about. It is the honest field to
  shrink if a future version needs the room.
- **None of this is implemented.** There is no v2 encoder, no v2 parser, and no
  test vector. Everything above is a specification.

### Still open

Whether repair frames (type 2) carry the fountain codec's symbol id in the
existing index field or need their own tuple; that depends on wiring
`artifacts/fountain.js` into the transport, which has not happened
([ADR-001](./ADR-001-rvqr-optical-transport.md), "Still roadmap").

## 4. Acceptance criteria

1. **Golden byte vectors.** A manifest frame and a data frame for the 40,989-byte
   demo module, checked in as hex, with a test that fails on any byte change.
   Little-endianness is asserted explicitly by a vector whose fields differ under
   the two byte orders.
2. **Size.** The header is exactly 28 bytes; a default data frame is exactly
   788 bytes and encodes to a version 19 level L symbol. Both asserted, not
   assumed.
3. **Codec honesty.** A manifest declaring codec `0x0002` whose payload is
   Brotli is rejected at the transport hash, with a test that constructs exactly
   that mismatch.
4. **Unknown codec and unknown dictionary are rejected**, not skipped, not
   treated as `0x0000`.
5. **Reserved bytes.** A frame with non-zero reserved bits or a non-zero
   reserved field is rejected.
6. **Bomb bound.** A manifest declaring 256 MB original size with a 1 KB
   payload allocates no more than the declared bound before failing, and a
   payload that inflates past its declared original size is rejected mid-stream
   rather than at the end.
7. **Round trip through the existing receiver.** A v2 transfer of both demo
   artifacts reassembles byte-identically and passes the same SHA-256 acceptance
   rule as v1, with `core.admitArtifact` unchanged
   ([ADR-009](./ADR-009-rvqr-signature-admission.md)).
8. **Measured, not projected.** `bench/` reports v2 frames-per-artifact and
   wire efficiency for both demo payloads alongside v1's, and the 1.484× figure
   in this document is replaced by whatever the harness says.
