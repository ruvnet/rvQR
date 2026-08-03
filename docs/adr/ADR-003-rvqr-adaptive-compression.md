# ADR-003: Adaptive Compression

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Whether, and with what, an artifact is compressed before it enters the frame stream |
| Implementation | None. `artifacts/proto2.js` declares, carries and enforces a codec id but bundles no codec — the decoder is injected at `finalize()` |
| Related | [ADR-002: Binary Frame Protocol v2](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-004: RVF Cognitive Container Format](./ADR-004-rvf-format.md) (mirrored), [ADR-034: QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR sends artifacts uncompressed. At the measured 2.44 KB/s default
([docs/benchmarks.md](../benchmarks.md) §4) every byte the codec could have
removed is a byte someone holds a phone still for.

Compression is the cheapest lever available because it is entirely sender-side
and entirely testable offline — no optics, no second device, no protocol
negotiation. It is also the lever with the widest spread in outcome, because it
depends on what is being sent. Measured on this repository's own artifacts
(Node v22.22.1, Apple M4 Pro, `zlib` Brotli quality 6 and Zstd level 6):

| Artifact | Bytes | Brotli-6 | Ratio | Zstd-6 | Ratio |
|---|---:|---:|---:|---:|---:|
| `artifacts/demo/rvf_wasm_bg.wasm` | 40,989 | 16,636 | **2.464×** | 17,193 | 2.384× |
| `artifacts/demo/ruvnet-demo.rvf` | 2,304 | 1,745 | **1.320×** | 1,787 | 1.289× |
| `standalone.html` | 503,216 | 142,368 | **3.535×** | 147,866 | 3.403× |

Three things fall out of that table.

**Brotli wins on ratio, everywhere, and never by much.** The gap is 3.4% on the
WASM module, 2.4% on the RVF container, 3.9% on the standalone page. Zstd was
about twice as fast to encode on the large payload — 4.09 ms against 8.38 ms for
`standalone.html` — and the difference on the two small payloads was under a
millisecond either way, which is noise at this scale.

**Float vectors barely compress.** The 1.32× on the RVF container is not a
codec failing; it is what high-entropy float data does. Any design that assumes
"compression will roughly halve it" is wrong for exactly the payload rvQR exists
to carry.

**A single fixed choice is wrong somewhere.** Compressing the RVF container
saves 559 bytes, which at v2's measured 764 payload bytes per frame
([ADR-002](./ADR-002-rvqr-binary-frame-protocol.md)) is worth one frame out of
five. Compressing a payload that is already compressed — a `.zip`, a PNG, an
encrypted blob — costs encode time, adds a codec dependency to the receive path,
and saves nothing.

## 2. Decision

### 2.1 Zstandard is the default; Brotli is the maximum-ratio option

**Zstandard ([RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.html)) is the
default codec**, at codec id `2`. **Brotli
([RFC 7932](https://www.rfc-editor.org/rfc/rfc7932.html)) is selected for WASM
modules, HTML, and metadata**, at the extension id `4` — see the table below for
why it needs one.

Zstd's id is not rvQR's. It is RuVector's, from `CompressionAlgo` in
`crates/rvf/rvf-types/src/compression.rs`, which is also what the tiered strategy
in [ADR-004 §5.2](./ADR-004-rvf-format.md) assumes. **rvQR reuses that vocabulary
rather than inventing one**, and reuses RuVector's Rust implementation compiled
to WASM rather than shipping a second JavaScript codec that could disagree with
it. The alternative — an rvQR-specific codec table — is how the RVQS defect
recorded in [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) §1 happened: a
builder reaching for a bespoke LZ implementation while the format's own
documentation named something else.

Zstd is the default rather than Brotli because the ratio difference is under 4%
on every artifact measured while the encode difference on the largest was 2×,
and because Zstd is what the rest of RuVector already uses for storage. Brotli
is kept for the cases where its window and static dictionary genuinely pay:
WASM, HTML and text metadata are where the measured 2.46× and 3.54× came from,
and those are also the artifacts a bootstrap transfer is most likely to carry.

**Three codec tables currently exist and no two of them agree.** This was
checked against the RuVector tree rather than inferred:

| Source | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `rvf-types/src/compression.rs` — **the shipped enum** | None | Lz4 | Zstd | **Custom** |
| Mirrored [ADR-004 §5.1](./ADR-004-rvf-format.md) | None | LZ4 | Zstd | **Brotli** |
| `artifacts/proto2.js` | none | **scf1** | **deflate-raw** | brotli |

Two consequences follow, and the second is the more serious.

**The mirrored ADR has drifted from the code.** `CompressionAlgo` is a `#[repr(u8)]`
enum whose only values are 0–3, and 3 is `Custom`, not Brotli. Brotli has **no
identifier at all** in the shipped format. That is the same failure this ADR set
keeps finding: a document describing bytes it no longer matches.

**And `Custom = 3` is `SEED_COMPRESSED` one layer up.** It carries no
sub-identifier, so SCF-1, Brotli and any future codec are all `Custom` and
indistinguishable from one another on the wire. The RVQS defect in
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) §1 is not a slip in one
builder; it is what this enum permits.

The decision, therefore, is narrower than "reuse RuVector's ids" and more
defensible:

- **0, 1 and 2 mean exactly what `CompressionAlgo` says** — None, LZ4, Zstd —
  because those three are agreed by both the code and the ADR, and a frame and a
  segment must never disagree about them. This is the part that matters, and it
  is the part `proto2.js` currently violates.
- **3 stays `Custom` and rvQR does not use it**, because an identifier that does
  not identify is the defect.
- **Codecs RuVector does not name get ids above the shipped range**: `4` Brotli,
  `5` SCF-1, `6` deflate-raw. `proto2.js`'s codec id is a `u8`, so there is room,
  and each is a real need — Brotli for the measured ratios above, SCF-1 for RVQS
  interoperability, deflate-raw because it is available in every browser through
  `DecompressionStream` at no bundle cost.
- **RVF should extend `CompressionAlgo` to match**, so that the two tables stay
  one table. Until it does, rvQR's ids 4–6 are an extension rvQR defines and must
  say so wherever they appear.

This is worth doing now precisely because nothing is wired in yet. After that it
is a wire-format migration.

### 2.2 Compress only when the complete transport envelope shrinks by ≥ 8%

The comparison is not "did the payload get smaller". It is **did the whole thing
a receiver has to observe get smaller** — compressed payload, plus the manifest,
plus the frame headers, rounded up to whole frames, because a transfer costs
frames and not bytes.

If that envelope does not shrink by at least **8%**, the artifact is sent with
codec `0x0000` and the transport hash equals the content hash.

8% is a chosen margin, not a derived constant, and the reasoning is worth
stating so it can be argued with. At v2's measured 764 payload bytes per frame and 5 fps, 8%
of a 40 KB artifact is about 3.3 KB, which is 4.3 frames, which is 0.9 seconds
of somebody holding a phone. Below that the saving does not repay adding a
decompressor to the critical path of a receiver whose whole promise is that it
works from a `file://` URL with nothing installed. The measured 1.320× on the
RVF container is a 24% envelope shrink and passes comfortably; a payload that
compresses to 0.95× does not.

### 2.3 Decide by measuring, with sampling only where measuring is too slow

For artifacts up to 8 MB the sender **compresses the whole thing and compares**.
This is affordable: Brotli-6 encoded `standalone.html` at 503,216 bytes in
8.38 ms, about 60 MB/s, so an 8 MB artifact costs on the order of 130 ms once,
against a transfer measured in minutes.

Above 8 MB the sender compresses a bounded prefix — 1 MB, at a fast level — to
estimate the ratio, applies the 8% rule to the estimate, and then compresses in
full if it passed. An estimate can be wrong; if the full result misses the
threshold the sender falls back to uncompressed rather than sending a
compression that did not earn its place.

Codec selection is by artifact type, using the detection rvQR already performs
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.9, §2.10): WASM modules and
HTML get Brotli, everything else gets Zstd, and both are subject to the same 8%
test.

### 2.4 Dictionaries are specified now and trained later

[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md)'s manifest carries a
dictionary id. rvQR ships **no dictionary**, and every manifest sets it to
`0x0000`.

The field exists because RVF containers share a great deal of structure —
segment headers, manifest layout, the magic constants ADR-009 pins down — and a
dictionary trained on a corpus of them is the obvious next gain on small
containers, which is precisely where the measured ratio is worst. Adding the
field later would be another format change; carrying two zero bytes now is not.
No dictionary has been trained, no corpus has been assembled, and no ratio has
been measured with one.

## 3. Consequences

### What this buys

- **On the artifacts actually measured, more than the framing change does.**
  Combined with [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md), the 40,989-byte
  demo module goes from a measured 82 frames and 16.4 seconds to a projected
  **23 frames and 4.6 seconds** at the same 5 fps — 3.6× — because 16,636
  compressed bytes at v2's measured 764 bytes per frame is 22 data frames plus a
  manifest. Through v2's ASCII armour, which is what a receiver using either of
  the app's current decode paths would get, it is 26 frames and 5.2 seconds.
  Both are arithmetic on measured inputs, not measurements.
- **The failure mode is bounded and visible.** A payload that does not compress
  is sent uncompressed, and the manifest says so in a field a receiver reads
  rather than infers.
- **One codec vocabulary across the project.** A container that arrives by
  camera and a container that arrives over the network name their compression
  the same way.

### What it costs, honestly

- **A WASM decompressor on the receive path.** rvQR's whole shape is a static
  page that works offline from a filesystem; adding a codec adds bytes to that
  page and a failure mode to a receiver that currently has none beyond hashing.
  A receiver that cannot instantiate the codec cannot complete a compressed
  transfer at all.
- **Compression is all-or-nothing across the object.** The stream is one
  compressed unit, so it cannot be partially decoded, and a codec fault
  invalidates the whole transfer. This matches rvQR's existing all-or-nothing
  integrity rule ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2) rather
  than conflicting with it, but it does mean a compressed transfer has strictly
  more ways to end in nothing.
- **The gain is entirely payload-dependent and the worst case is the
  interesting one.** 1.32× on float vectors is the number to quote when someone
  asks what compression does for RVF containers, not 3.54×.
- **Sender-side latency before the first frame.** Up to ~130 ms at the 8 MB
  boundary, more if the estimate says compress and the full encode is slow. The
  UI has no "preparing" state today.
- **Nothing here is implemented.** No codec is bundled, no threshold is coded,
  no dictionary exists.

## 4. Acceptance criteria

1. **The measured table is reproduced by the harness.** `bench/` reports
   Brotli-6 and Zstd-6 ratios for both demo artifacts and for `standalone.html`,
   and the numbers in §1 are replaced by its output.
2. **Envelope arithmetic, not payload arithmetic.** A test asserts the decision
   is made on whole frames including the manifest: an artifact whose payload
   shrinks 10% but whose frame count does not change is sent uncompressed.
3. **The 8% rule holds at both edges.** Synthetic payloads at 7% and 9% envelope
   shrink take opposite branches.
4. **Incompressible input costs nothing on the wire.** Random bytes and an
   already-compressed file are both sent with codec `0x0000`, transport hash
   equal to content hash.
5. **Codec ids match RuVector's contract**, asserted against the values in
   [ADR-004 §5.1](./ADR-004-rvf-format.md) rather than against a local constant.
6. **Round trip under every codec**, including the case where the receiver's
   codec is unavailable: the transfer fails cleanly and stores nothing, rather
   than storing a compressed blob under the artifact's name.
7. **Decompression bounds.** A payload that inflates beyond the declared
   original size is rejected during decode, and peak allocation stays within the
   declared bound.
8. **End-to-end frame counts** for both demo artifacts, measured, with the 23
   frames / 4.6 seconds projection above confirmed or corrected.
