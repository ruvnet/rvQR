# rvQR in the RuVector ecosystem

rvQR is one surface among several that touch the same binary format. This
document explains where it sits, what it borrows, and — honestly — what is
sketch rather than shipped.

A rule for reading it: everything under **Today** is running code you can
execute right now. Everything under **Planned** is design, and the function
names in those sections are real APIs that exist upstream, not invented ones.
Nothing in the Planned sections is wired into the app.

---

## The three surfaces

### 1. Browser — `artifacts/` (this repository)

A single self-contained page: an IndexedDB artifact vault, an animated QR
sender, a camera receiver, and compile-only WASM inspection. No build step, no
CDN, no framework. It is the only surface that can move an artifact between two
devices with no shared network.

### 2. Rust crates — [`ruvnet/RuVector`](https://github.com/ruvnet/RuVector), `crates/rvf/`

| Crate | What it gives you |
|-------|-------------------|
| [`rvf-types`](https://github.com/ruvnet/RuVector/tree/main/crates/rvf/rvf-types) | The wire constants and header structs. Exports `SEGMENT_MAGIC_BYTES` (`53 46 56 52`) and `ROOT_MANIFEST_MAGIC_BYTES` (`30 4D 56 52`) precisely so nobody hand-writes an ASCII literal and misparses the format — see [ADR-009](./adr/ADR-009-rvf-v1-wire-contract.md). |
| [`rvf-wire`](https://github.com/ruvnet/RuVector/tree/main/crates/rvf/rvf-wire) | The segment codec and the tail scan. `find_latest_manifest` is the canonical "where does this file say it is" routine, and `tests/wire_contract_golden.rs` pins the exact bytes the writer emits, gated in CI by `.github/workflows/rvf-wire-contract.yml`. |
| [`rvf-runtime`](https://github.com/ruvnet/RuVector/tree/main/crates/rvf/rvf-runtime) | The store: open, ingest, query, copy-on-write derive, compaction, durable metadata ([ADR-280](./adr/ADR-280-rvf-durable-self-contained-metadata.md)). Also carries its own zero-dependency QR encoder in `src/qr_encode.rs` — versions 1 through 5 only, for rendering single-symbol seeds. |
| [`rvf-crypto`](https://github.com/ruvnet/RuVector/tree/main/crates/rvf/rvf-crypto) | Signing, verification, attestation, lineage and the witness chain. This is the crate that will supply rvQR's roadmap signature layer. |

Worth noting the overlap in the third row: RuVector already contains a QR
encoder. It tops out at version 5 (37×37 modules) because its job is rendering
one seed symbol, per [ADR-034](./adr/ADR-034-qr-cognitive-seed.md). rvQR's
browser encoder goes to version 40 and streams many frames, because its job is
arbitrary payloads. Same Reed-Solomon field, same mask rules, different problem.
Neither replaces the other.

### 3. npm packages

| Package | What it gives you |
|---------|-------------------|
| [`@ruvector/rvf-wasm`](https://www.npmjs.com/package/@ruvector/rvf-wasm) `0.1.9` | The RVF WebAssembly runtime, 40,989 bytes (published as "39 KB"). **rvQR's demo artifact is this exact binary** — the app carries it as cargo, never loads it. |
| [`@ruvector/rvf`](https://www.npmjs.com/package/@ruvector/rvf) | The Node.js RVF store: the same open/ingest/query surface with native bindings. |
| [`ruvector`](https://www.npmjs.com/package/ruvector) | The full vector database — HNSW, quantization, the works. RVF is its portable format. |

---

## Client-side RVF parsing

### What runs today

rvQR parses RVF containers in the browser with the real microkernel. When you
open an `.rvf` artifact in the vault, the app instantiates
`rvf_wasm_bg.wasm` — the published `@ruvector/rvf-wasm` 0.1.9 binary, which
imports nothing, so an empty import object is the whole contract — and uses it
to walk the container:

| Call | What rvQR does with it |
|------|------------------------|
| `rvf_parse_header` | Header magic, version, and the type of the first segment. |
| `rvf_verify_header` | Confirms the v1 segment magic `53 46 56 52` at offset 0. |
| `rvf_segment_count` / `rvf_segment_info` | The full segment table: index, id, type, size and offset for every segment. |
| `rvf_crc32c` | A CRC fingerprint per segment payload. |
| `rvf_store_open` / `rvf_store_count` / `rvf_store_dimension` | The kernel's own reading of the container, kept as a cross-check. |
| `rvf_store_close`, `rvf_free` | Every handle closed, every buffer freed. |

Alongside that, `artifacts/rvf.js` reads `Vec` segment payloads directly. The
layout is `u16 dim | u16 count | u16 flags`, then `count` records of
`u64 id` followed by `dim` little-endian floats. That accounts for the demo
container's 1,734-byte vector segment exactly: 6 + 24 × (8 + 16 × 4).

On top of that the app runs an exhaustive nearest-neighbour search with cosine,
euclidean and inner-product metrics. Query a container with one of its own
stored vectors and its id comes back at distance zero.

The demo container parses as: four segments — `Manifest`, `Vec`, `Witness`,
`Manifest` — accounting for all 2,304 bytes, holding 24 unit-length vectors of
16 dimensions with ids 1 through 24.

### What the kernel does not do

Three findings from testing the published 0.1.9 build against real and
deliberately corrupted input. All three are surfaced in the UI rather than
papered over.

**`rvf_verify_checksum` does not detect corruption.** It returns success for a
pristine container, for a container with a flipped payload byte, for a
container with a mangled header, and for 2,304 bytes of random noise. Only an
empty buffer produces an error. rvQR therefore reports checksum verification as
`unavailable` and shows per-segment CRC32C values as fingerprints, which is what
they honestly are — the container carries no reference checksum to compare them
against.

**`rvf_witness_count` rejects every chain length.** The demo container has a
68-byte `Witness` segment, but no length passed to `rvf_witness_count` returns
anything but `-1`. The segment is listed in the table; the chain is reported as
unverifiable here.

**`rvf_store_open` transposes the vector header.** It reports 16 vectors of 24
dimensions for a container that holds 24 of 16, and its `rvf_store_query`
consequently strides through the records at the wrong size and returns ids that
are fragments of vector data. The container is unambiguous — ids 1..24 in
sequence, unit norms, and a byte count that only works out at 24 × 16 — so
rvQR uses its own reader for ids, dimensions and search, and displays the
disagreement as a warning next to the segment table.

`rvf_store_open` also returns a valid-looking handle for *any* input, including
random noise and the wasm binary itself, so nothing in rvQR treats opening a
store as evidence that a file is a container.

### Still planned

Signature verification through `rvf-crypto`, and using the kernel's witness
machinery once a build lands where those entry points work on real chains.

## Delta transfer and segment enumeration

The killer feature is not sending a 1 GB artifact; it is *not* sending the 99%
of it the other device already has. Sending only the changed 1% of a 1 GB
container moves about 10.7 MB instead of 1 GB — roughly 100× less data.

Be careful with the absolute numbers here. Earlier research expressed this as
"two hours down to 75 seconds at 140 KB/s"; that rate is about 14× what a single
animated QR stream actually achieves (2.5 KB/s at the app's defaults, 10 KB/s at
its ceiling), so it describes a denser optical channel than anything implemented
today. At the real ceiling the same delta is roughly 29 hours down to 18
minutes. The ratio is the durable claim; the wall-clock figures move with
whatever channel is underneath.

RVF makes this tractable because it was built append-only. A container is an
ordered stream of independently verifiable segments, each with its own header
and checksum, and the root manifest is the directory. So "what changed" is
answerable without diffing bytes:

1. **Receiver advertises.** It enumerates its own copy — the same
   `rvf_segment_count` / `rvf_segment_info` walk described above, or
   `rvf-runtime`'s store enumeration natively — and encodes its root manifest
   hash plus a compact segment map into a single QR.
2. **Sender diffs.** It compares that map against its own segment list. Because
   segments are content-addressed and append-only, set difference is the whole
   algorithm. No rolling hashes, no block alignment problem.
3. **Sender transmits only the difference**, framed exactly as today's protocol
   frames it.
4. **Receiver appends and re-verifies.** Appending is the format's native
   operation, and copy-on-write derive in `rvf-runtime` means the prior version
   need not be destroyed to build the new one.

The honest caveat: today's protocol has no reverse channel at all. Step 1
requires the sender to be able to *scan*, which means both devices need a
camera and the UI needs a second mode. That is a real change in shape, not a
parameter tweak.

---

## Where signature verification slots in

Today the receive pipeline is:

```
frames → reassemble → SHA-256 vs manifest → store, or discard everything
```

The hash proves the bytes are *intact*. It proves nothing about who produced
them. Anyone who can put a screen in front of your camera can produce a
perfectly valid transfer.

`rvf-crypto` closes that gap. The planned pipeline inserts one gate:

```
frames → reassemble → SHA-256 vs manifest → signature vs pinned key → store
                            │                        │
                            └── mismatch ────────────┴── discard, no vault write
```

Concretely:

- The manifest frame gains a detached signature over the `(name, size, sha256)`
  tuple, produced by `rvf-crypto`'s signing path.
- The receiver holds a set of pinned public keys. Verification happens *after*
  the hash check — verifying a signature over bytes you have not yet confirmed
  is theatre.
- An unsigned or unverifiable artifact is not necessarily rejected; it is
  **marked**. The distinction that matters is not "did it arrive" but "may it
  leave quarantine", and only verified artifacts may.

That last point is the whole security model in one sentence: the hash decides
whether bytes are *stored*, the signature decides whether they may be
*activated*, and those are different questions with different answers.

---

### 4. rupixel — the sibling browser-first project

[rupixel](https://github.com/ruvnet/rupixel) is the other browser-first project
on this substrate: pixel-native visual RAG. It embeds document *images* with
CLIP rather than extracting their text, runs the model in the browser over
WebGPU, ships from GitHub Pages, and carries its own metaharness benchmark CLI.
It self-badges as early-stage work in progress; read its numbers accordingly.

**What rvQR borrowed.** The keyframe gate. rupixel downsamples each camera frame
to a 16×16 grayscale signature and compares successive signatures by mean
absolute difference, skipping work when the scene has not meaningfully changed
(`docs/live.js`, MIT, threshold 9 on a 0-255 mean-absolute scale). rvQR uses the
same signature and the same threshold to decide when to spend a decode, with the
sense inverted — see [ADR-001 §2.8](./adr/ADR-001-rvqr-optical-transport.md).

**The natural pairing.** rupixel *produces* vector indexes; rvQR *moves* them.
Index a corpus on a laptop, carry the resulting RVF container to an air-gapped
machine by pointing one screen at another camera, and search it there. That is
the payload story with real stakes: the reason to care about moving a vector
index optically is that the destination is somewhere a network cannot reach,
which is exactly where an index is otherwise unobtainable.

**Deliberately not a code dependency.** rupixel needs CLIP, WebGPU and hundreds
of megabytes of model weights. rvQR's whole property is a ~150 KB page that
works with nothing installed, on a phone, offline, from a filesystem. Importing
either into the other would destroy the thing that makes it worth having. The
relationship is at the level of file formats and documentation: both speak RVF,
and that is enough.

---

## metaharness: gating the acceptance bar

[metaharness](https://github.com/ruvnet/metaharness) is the evaluation and
governance layer — benchmark definitions, scoring, drift detection, audit
trails.

**There is no metaharness integration in this repository today: no gate
definitions, no scoring hooks, no emitted witnesses.** What follows is the shape
it should take, written down so it can be argued with before it is built.

That shape does not have to be imagined from scratch. rupixel already ships a
metaharness benchmark CLI on this same substrate, so there is a working
reference for what benchmarks defined, scored and tracked by metaharness look
like in a browser-first ruvector project — including how a project whose quality
is genuinely hard to measure structures the measurement. rvQR's gates below
should follow that precedent rather than invent one.

### The bar, as gates

[`protocol.md`](./protocol.md) states an acceptance bar. Each line of it is a
gate with a pass condition that a harness can evaluate mechanically:

| Gate | Pass condition | Notes |
|------|----------------|-------|
| `rvqr.integrity.no_false_accept` | 100 transfers of 100 MB, **zero** incorrectly accepted files | The only gate with a zero tolerance. A single false accept is a hard fail, not a score reduction — accepting corrupt bytes is categorically worse than accepting none. |
| `rvqr.resilience.frame_loss_20pct` | Successful reconstruction with 20% of frames dropped | Meaningless until erasure-coded frames are wired into the transport; today's loop-until-complete behaviour passes it only by taking longer, which the gate should measure separately as time-to-complete rather than credit as resilience. |
| `rvqr.durability.resume` | Transfer resumes after browser termination | Requires persisted receiver state. |
| `rvqr.throughput.effective_rate` | Sustained bytes/second at a fixed frame rate and chunk size | Scored, not pass/fail. Today's baseline is 2.5 KB/s at the defaults and 10 KB/s at the ceiling — the number that makes delta transfer worth building. |

Framing them this way makes the asymmetry explicit: correctness gates are
binary, performance gates are scored, and no amount of throughput compensates
for a false accept.

### Attestation and witness composition

The natural join between the two systems is the witness record.

rvQR's receive path already produces exactly the material a witness wants: a
manifest hash, a computed hash, an accept-or-reject verdict, a frame count, a
duplicate count, and a timestamp. Emitting that as a witness record — through
`rvf-crypto`'s witness chain, the same machinery `rvf_witness_verify` in the
bundled runtime already reads — would give every transfer an auditable trace,
and would let a metaharness run be scored over *attested* outcomes rather than
self-reported ones.

The composition to aim for:

1. Each transfer emits a signed witness on accept **and on reject**. Rejections
   are the more interesting data — an integrity gate you cannot see failing is
   an integrity gate you cannot trust.
2. metaharness scores over the witness chain, not over the app's own logs.
3. Activation, when it exists, appends its own witness, so the chain records
   both "these bytes arrived and verified" and "these bytes were later
   authorized to run" as separate, separately attributable events.

Keeping those two events distinct in the audit trail is the same boundary the
security model draws everywhere else in this project: transport authority and
execution authority are not the same authority, and the record should never
blur them.
