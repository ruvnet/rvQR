# ADR-003: Adaptive Compression

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Whether, and with what, an artifact is compressed before it enters the frame stream |
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
saves 559 bytes, which at 760 payload bytes per frame
([ADR-002](./ADR-002-rvqr-binary-frame-protocol.md)) is worth one frame out of
five. Compressing a payload that is already compressed — a `.zip`, a PNG, an
encrypted blob — costs encode time, adds a codec dependency to the receive path,
and saves nothing.

## 2. Decision

### 2.1 Zstandard is the default; Brotli is the maximum-ratio option

**Zstandard ([RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.html)) is the
default codec**, at codec id `0x0002`. **Brotli
([RFC 7932](https://www.rfc-editor.org/rfc/rfc7932.html)) is selected for WASM
modules, HTML, and metadata**, at codec id `0x0003`.

Those two ids are not rvQR's. They are RuVector's, from the compression contract
in [ADR-004 §5.1](./ADR-004-rvf-format.md), which already enumerates None
`0x00`, LZ4 `0x01`, Zstd `0x02` and Brotli `0x03` and already assigns Brotli to
WASM in its tiered strategy (§5.2). **rvQR reuses that vocabulary rather than
inventing one**, and reuses RuVector's Rust implementation compiled to WASM
rather than shipping a second JavaScript codec that could disagree with it. The
alternative — an rvQR-specific codec table — is how the RVQS defect recorded in
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) §1 happened: a builder
reaching for a bespoke LZ implementation while the format's own contract named
something else.

Zstd is the default rather than Brotli because the ratio difference is under 4%
on every artifact measured while the encode difference on the largest was 2×,
and because Zstd is what the rest of RuVector already uses for storage. Brotli
is kept for the cases where its window and static dictionary genuinely pay:
WASM, HTML and text metadata are where the measured 2.46× and 3.54× came from,
and those are also the artifacts a bootstrap transfer is most likely to carry.

### 2.2 Compress only when the complete transport envelope shrinks by ≥ 8%

The comparison is not "did the payload get smaller". It is **did the whole thing
a receiver has to observe get smaller** — compressed payload, plus the manifest,
plus the frame headers, rounded up to whole frames, because a transfer costs
frames and not bytes.

If that envelope does not shrink by at least **8%**, the artifact is sent with
codec `0x0000` and the transport hash equals the content hash.

8% is a chosen margin, not a derived constant, and the reasoning is worth
stating so it can be argued with. At 760 payload bytes per frame and 5 fps, 8%
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
  demo module goes from a measured 82 frames and 16.4 seconds to a projected 23
  frames and 4.6 seconds at the same 5 fps — 3.6× — because 16,636 compressed
  bytes at 760 bytes per frame is 22 data frames plus a manifest. That is
  arithmetic on measured inputs, not a measurement.
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
