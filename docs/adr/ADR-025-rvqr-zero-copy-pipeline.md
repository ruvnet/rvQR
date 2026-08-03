# ADR-025: Zero-Copy Rust Pipeline

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | One bounded pipeline from read to send, and the memory budget every other ADR inherits |
| Value / effort / risk | 4 / 3 / 2 |
| Implementation | None as a pipeline. BLAKE3 and Zstd exist; `artifacts/offload.js` is the JavaScript analogue and currently measures slower |
| Related | [ADR-033](./ADR-033-rvqr-decode-worker-pool.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-019](./ADR-019-rvdrop-bulk-transport.md) targets 25–100 MB/s sustained. At
that rate the bottleneck stops being the radio and becomes whatever the host does
to each byte on its way there: read, hash, delta, compress, encrypt, send. Five
stages, and a naive implementation copies at every boundary.

There is already a measured example of exactly this failure in this project, one
layer down. [ADR-033](./ADR-033-rvqr-decode-worker-pool.md) found that offloading
to a worker made `sha256` **15% slower** and the keyframe `signature` job **59%
slower**, entirely because `artifacts/offload.js` copies buffers across the
boundary by default. Moving work to another thread and paying a copy to do it is
a net loss, and it was a net loss in measurement, not in theory.

The Rust pipeline is where that lesson gets applied at the scale it matters.

## 2. Decision

### 2.1 One pipeline, pooled buffers, no incidental copies

**read → hash → delta → compress → encrypt → send**, as a single bounded pipeline
with pooled buffers, memory mapping where the platform allows it, SIMD BLAKE3,
SIMD compression, and **4–8 bounded streams** matching
[ADR-019](./ADR-019-rvdrop-bulk-transport.md)'s stream count.

Buffers are pooled rather than allocated per chunk, because at 100 MB/s with 1 MB
chunks that is a hundred allocations a second of a megabyte each, and the
allocator becomes the throughput ceiling.

### 2.2 Three numeric budgets, treated as contracts

| Budget | Value | Why |
|---|---|---|
| Internal throughput | **≥ 2× the radio ceiling** | so the pipeline is never the constraint, and so the measured rate is a property of the link rather than of our code |
| Full payload copies | **fewer than 2** | one unavoidable read, one unavoidable write; anything else is a defect |
| Working memory | **under 128 MiB** | it is a hard rule in [ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.3, which the controller may not trade away |

The memory budget is the one with teeth elsewhere: it is listed among the
invariants a learned policy cannot override, alongside trust and verification.
That places it in the same category as "commit requires complete verification" —
not a performance goal, a constraint.

### 2.3 Streaming verification, not buffered verification

The digest is computed as bytes flow, not over a fully materialised artifact.
This matters because the alternative contradicts §2.2 directly: verifying a 1 GB
container by first assembling it in memory blows a 128 MiB budget by a factor of
eight.

It also constrains [ADR-016](./ADR-016-rvqr-verified-execution.md)'s pipeline
order in a way worth stating: bytes are hashed on the way to disk, and admission
happens once the streamed digest matches — the artifact is never simultaneously
complete and unverified in memory.

**Bounded decompression is part of this**: inflation is capped against the
declared original size before the first inflated byte exists
([ADR-003](./ADR-003-rvqr-adaptive-compression.md)), which is both a security
property and a memory one.

### 2.4 The 128 MiB budget covers the whole system, not the pipeline

Stated because it is the easy mistake: a pipeline that fits 128 MiB while the
chunk store, the delta index and the decode workers each take their own share is
not a 128 MiB system. The budget is measured at the process, under load, with
everything running.

## 3. Consequences

### What this buys

- **The link becomes the limit**, which is what makes
  [ADR-019](./ADR-019-rvdrop-bulk-transport.md)'s targets meaningful — otherwise
  a disappointing measurement cannot be attributed.
- **It runs on the devices that matter.** A 128 MiB working set is a phone, a
  Raspberry Pi and a Cognitum Seed; a gigabyte-scale one is a workstation.
- **Streaming verification removes a whole class of memory failure** on large
  artifacts.

### What it costs, honestly

- **It is the least glamorous item here and the easiest to skip**, right up to
  the point where every throughput number is wrong for a reason nobody can
  locate.
- **Zero-copy is a discipline, not a feature.** It degrades silently: one
  well-meaning `.to_vec()` in a hot path costs a budget nobody notices until a
  benchmark regresses. [ADR-033](./ADR-033-rvqr-decode-worker-pool.md)'s 59%
  regression is what that looks like when it does get measured.
- **Memory mapping is platform-specific** and interacts badly with some
  filesystems and with encrypted volumes; the fallback path must exist and must
  be measured, not assumed equivalent.
- **SIMD paths multiply the build and test matrix**, and a scalar fallback that
  is never exercised is a scalar fallback that is broken.
- **The budget will be argued with.** 128 MiB is tight for a 1 GB container with
  a delta index and a chunk store, and the pressure will be to raise it rather
  than to fix the design.

## 4. Acceptance criteria

1. **Copy count is asserted, not inspected.** An instrumented build counts full
   payload copies per transfer and fails the test above 2.
2. **Peak RSS under 128 MiB for a 1 GB transfer**, measured at the process with
   chunk store, delta index and workers all live — §2.4.
3. **Internal throughput at least 2× the measured radio ceiling** on each target
   platform, or the pipeline is the bottleneck and the ADR has not been met.
4. **The regression that started this is gone.** `sha256` and the keyframe
   `signature` are at least as fast on the offloaded path as inline — the
   criterion [ADR-033](./ADR-033-rvqr-decode-worker-pool.md) §4.1 sets, carried
   here because it is the same defect.
5. **Streaming verification is byte-exact against the buffered result**, on both
   demo artifacts and on a 1 GB container.
6. **The scalar fallback is exercised in CI** on every SIMD path.
7. **The budget is checked in CI**, so it degrades loudly rather than silently.
