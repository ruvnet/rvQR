# ADR-013: Byte Minimisation — Semantic Delta, Content-Defined Chunking and Dictionaries

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Not sending bytes at all, which beats sending them efficiently |
| Implementation | `artifacts/delta.js` exists and is measured. FastCDC and content addressing do not exist anywhere in the tree; Zstd dictionaries are unused |
| Related | [ADR-003](./ADR-003-rvqr-adaptive-compression.md), [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md), [ADR-004: RVF Cognitive Container Format](./ADR-004-rvf-format.md) (mirrored), [ADR-029: RVF as Canonical Binary Format](./ADR-029-rvf-canonical-format.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-003](./ADR-003-rvqr-adaptive-compression.md) measured what a codec can do:
2.464× on a WASM module, **1.320× on an RVF container of float vectors**, 3.535×
on an HTML page. The middle number is the one that matters, because float
vectors are what rvQR exists to carry, and no choice of codec improves it much —
Zstd-6 managed 1.289× on the same bytes.

Delta does far better on the same payload class.
[docs/benchmarks.md](../benchmarks.md) §5 records `delta.js`'s author measuring a
**1.65 MB container with 1% of its segments rewritten producing a 19,400-byte
delta — 85.1×**, on a real container, cross-checked against this repository's own
projection of 85×.

**So for recurring deliveries, dedup and delta beat codec choice by more than an
order of magnitude, and the gap is widest exactly where the codec is weakest.**
That reordering is this ADR's whole content.

What exists and what does not, checked in the RuVector tree:

| Piece | Status |
|---|---|
| RVF segment delta | `artifacts/delta.js` in rvQR; `rvf-types/src/delta.rs`, `rvf-wire/src/delta.rs`, `ruvector-delta-core` upstream |
| RVCOW / agenticow membership maps | present — see §2.4 |
| BLAKE3 | present: `prime-radiant`, `rvm`, `rvm-witness`, `ruvector-graph`, `photonlayer-core`, `cognitum-gate-tilezero` |
| Zstd | present but optional: `ruvector-delta-core` and `ruvector-graph`, behind a `compression` feature, alongside `lz4_flex` |
| Zstd **dictionaries** | not used anywhere |
| **Content-defined chunking** | **absent from the entire tree** — no FastCDC, no Rabin, nothing |
| Content-addressed chunk store | absent |

## 2. Decision

### 2.1 The order of preference is: don't send it, send a diff, then compress

1. **Content addressing** — a chunk the receiver already holds is never sent.
2. **Semantic delta** — send changed RVF structures, not changed bytes.
3. **Dictionary compression** — for what is left, exploit similarity to a corpus
   both ends already have.
4. **Plain compression** — [ADR-003](./ADR-003-rvqr-adaptive-compression.md)'s
   8% envelope rule, as the floor.

Each stage is subject to the same test as stage 4: it must shrink the **complete
transport envelope**, counted in whole frames, or it is skipped.

### 2.2 FastCDC for content-defined chunking

Chunk boundaries are content-defined rather than fixed-offset, so an insertion
early in a container does not shift every subsequent boundary and invalidate
every subsequent chunk. Chunks are addressed by **BLAKE3**, which is already in
the tree and already the hash `rvm-witness` chains with.

FastCDC is chosen over Rabin-based chunking on its published result: Xia et al.,
*FastCDC: a Fast and Efficient Content-Defined Chunking Approach for Data
Deduplication*, USENIX ATC '16, report roughly **10× the chunking throughput of
Rabin-based CDC at comparable deduplication ratios**. That is their measurement,
not ours; nothing in this repository has run either.

This is a **new build, not an integration** — there is no content-defined
chunking anywhere in the tree to extend.

### 2.3 Zstd dictionaries for repeated artifact families

Zstandard supports dictionaries trained on a corpus and reused across payloads,
which is precisely the "many similar small artifacts" case where a general codec
has nothing to work with
([facebook.github.io/zstd](https://facebook.github.io/zstd/)). RVF containers
from one family share segment headers, manifest layout and the magic constants
[ADR-009](./ADR-009-rvf-v1-wire-contract.md) pins down.

[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) already carries a dictionary
id in every frame header, and [ADR-003](./ADR-003-rvqr-adaptive-compression.md)
§2.4 already decided that 0 means "none" explicitly. What is missing is a corpus,
a trained dictionary, a distribution mechanism, and a measurement — **none of
which exist**, and the measured 1.320× on a small RVF container is the number a
dictionary would have to beat.

### 2.4 Diff RVF structures, not compressed byte streams — and RVCOW is agenticow

The delta operates on **RVF segments, vector slabs, tensor boundaries, WASM
components, indexes and RVCOW membership maps**. Not on the output of a
compressor, where a one-byte change decorrelates everything downstream and the
delta degenerates to a full send.

**A naming correction that belongs in the record.** RVCOW and `agenticow` are
**one mechanism with two names**:

- In-tree, as format and runtime: `rvf-runtime/src/cow.rs`,
  `cow_map.rs`, `cow_compact.rs`; `rvf-types/src/cow_map.rs` and `refcount.rs`;
  `SegmentType::CowMap`; `rvf-cli`'s `rebuild_refcounts`; and four integration
  suites (`cow_branching.rs`, `cow_ann_recall.rs`, `cow_benchmarks.rs`,
  `cow_crash_recovery.rs`). `crates/rvf/README.md` records a measured CowMap
  lookup of **28 ns**.
- Published, as an npm surface: `agenticow` v0.2.4
  ([github.com/ruvnet/agenticow](https://github.com/ruvnet/agenticow)),
  describing itself as copy-on-write vector branching that branches a base
  memory in about 0.5 ms and 162 bytes regardless of base size — its claim, not
  a measurement of ours.

Any ADR, comment or interface naming one **must name both**. Two undocumented
names for one mechanism is the same class of defect as
[ADR-009](./ADR-009-rvf-v1-wire-contract.md)'s "RVFS"/"RVM0" mnemonics and the
`SEED_COMPRESSED` flag in
[ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) §1: a label that does not
track the thing. This set does not get to introduce a fresh instance while
documenting two others.

Note that `agenticow` is **not** in `npm/packages/` in this monorepo. The
published surface living outside the tree that defines the format is the
mechanical reason the two names drifted, and it is worth fixing at the source
rather than in prose. If the two have diverged in *behaviour* rather than only
in name, that is a separate finding and needs its own investigation — nothing
here establishes that they have not.

### 2.5 The receiver inventory is encrypted

To send only what is missing, the receiver must say what it holds. That
inventory is **a list of the models, agents and memory a device is running**,
and it is sensitive on its own — an observer who reads it learns the device's
entire deployed configuration without receiving a single artifact byte.

The inventory is therefore encrypted under the session established in
[ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), and is never sent in the
clear even though it is "only metadata". This applies to the optical inventory
QR as much as to the radio path: [docs/benchmarks.md](../benchmarks.md) §5 notes
the demo container's inventory is 134 base64url bytes — a version 6-L symbol
anybody in the room can photograph.

## 3. Consequences

### What this buys

- **An order of magnitude where compression offers 32%.** The measured 85.1×
  against a measured 1.320× on the same class of payload.
- **It scales with how boring the delivery is.** Fleet updates, model refreshes
  and credential rotation are mostly-unchanged artifacts, which is the best case
  here and the worst case for a codec.
- **The chunk store is shared with [ADR-019](./ADR-019-rvdrop-bulk-transport.md)
  and [ADR-024](./ADR-024-rvqr-fleet-swarm.md).** Content addressing is what
  makes peer-to-peer chunk exchange and resume-across-transport possible at all.

### What it costs, honestly

- **Almost all of it is a new build.** Content-defined chunking does not exist in
  the tree; neither does a content-addressed store or a trained dictionary. Only
  the delta half has code, and only in JavaScript in rvQR.
- **The 85.1× is one measurement on one container.**
  [docs/benchmarks.md](../benchmarks.md) §5 is blunt about the limits: the
  measured ratios on the 2.3 KB demo container are **1.11×–5.62×**, the large
  figures are projections, and the projection assumes edits confined to whole
  spans that do not change length. A length-changing edit shifts every subsequent
  offset and **none of the numbers apply to it** — which is, incidentally, the
  strongest argument for content-defined chunking in §2.2.
- **A receiver inventory is a new attack surface** even encrypted: its size and
  timing leak, and it is parsed from an unauthenticated channel before a session
  exists in the optical case.
- **Dictionaries have to be distributed and versioned**, and a receiver without
  the dictionary cannot decode at all — a hard failure where plain compression
  degrades to slower.
- **Span size is a free parameter that cuts both ways** (§5 again: large spans
  waste payload inside a changed span, small spans make the inventory itself
  expensive), and nothing has tuned it for real containers.

## 4. Acceptance criteria

1. **Measured against the codec on the same corpus.** For a recurring-delivery
   corpus — successive versions of the demo container and the WASM module —
   report bytes on the wire for: plain, compressed, delta, delta+CDC,
   delta+CDC+dictionary. If dedup does not beat
   [ADR-003](./ADR-003-rvqr-adaptive-compression.md) on this corpus, this ADR is
   wrong and should be withdrawn.
2. **Length-changing edits are measured**, not just body mutations —
   [docs/benchmarks.md](../benchmarks.md) §8 records that gap explicitly, and it
   is the case CDC is supposed to fix.
3. **FastCDC's chunking throughput is reproduced locally**, at least in order of
   magnitude, rather than cited from ATC '16 alone.
4. **A dictionary beats no dictionary on small RVF containers**, measured
   against the 1.320× baseline, or dictionaries are dropped.
5. **The inventory is never observable in clear**, asserted for both the optical
   and radio paths.
6. **RVCOW and agenticow are named together** everywhere either appears, and a
   check confirms the two surfaces agree on branch semantics — or records
   precisely where they do not.
7. **Byte-exactness is preserved end to end** through every stage, verified by
   the artifact content hash and not by the chunk hashes that produced it.
