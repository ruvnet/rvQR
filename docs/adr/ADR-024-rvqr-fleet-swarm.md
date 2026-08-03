# ADR-024: Fleet Swarm Distribution

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Delivering one artifact to many devices without sending it many times |
| Value / effort / risk | 5 / 4 / 3 |
| Implementation | None. BitChat is absent from the tree; the fountain codec exists but is unwired and non-conformant |
| Related | [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-014](./ADR-014-rvqr-fountain-selection.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md), [ADR-022](./ADR-022-rvqr-progressive-activation.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

The deployment case in [ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.3 is
rarely one device. It is a site: a hundred appliances taking a firmware image, a
fleet of Cognitum Seeds taking a model update, a segmented network where the
source is a laptop somebody carried in.

Point-to-point, **a 100-device site taking a 1 GB image is up to 100 GB of source
traffic** — which the source link cannot supply and the person holding it cannot
wait for. The devices, meanwhile, are next to each other and idle.

## 2. Decision

### 2.1 Three mechanisms, each for a different regime

| Mechanism | Used for | Why |
|---|---|---|
| **BitChat** | peer discovery, custody, rank exchange, receipts | low-rate control that must work before any link exists |
| **Content-addressed peer transfer** | bulk, on normal links | a chunk a peer already holds is a chunk the source never sends |
| **RaptorQ** ([RFC 6330](https://www.rfc-editor.org/rfc/rfc6330.html)) | lossy broadcast | one transmission serves every receiver, and each needs any K+ε symbols |

**Target: under 3 GB of source traffic for 100 devices × 1 GB**, against up to
100 GB point-to-point. That is a target, not a measurement.

The content-addressed store this depends on is the one
[ADR-013](./ADR-013-rvqr-byte-minimisation.md) builds, and it is the reason that
ADR pays for itself twice: chunk addressing makes resume cheap *and* makes peer
exchange possible.

### 2.2 Verification is per-device and never delegated

**A peer is a transport, not an authority.** Every receiving device runs the full
[ADR-016](./ADR-016-rvqr-verified-execution.md) pipeline against the *source's*
signed manifest — digest, signature, admission — regardless of which peer handed
over the bytes.

This is the property that makes swarm distribution safe at all. A malicious peer
in the swarm can waste bandwidth and it cannot cause a wrong artifact to be
accepted anywhere, because the chunks it offers are content-addressed and the
whole is signed by a key it does not hold. Chunks that do not hash correctly are
discarded on arrival, before they are stored or forwarded.

The failure mode to design against is not corruption but denial: a peer that
offers plausible chunk *advertisements* and never delivers, or delivers slowly.
That is a scheduling problem, and peers that fail to deliver are deprioritised on
measured behaviour rather than on claims.

### 2.3 Store-and-carry and offline sync

A device that received an artifact can carry it to a site with no link to the
source and serve it there. Custody receipts — who held what, when — travel with
the artifact and land in the witness lineage
([ADR-016](./ADR-016-rvqr-verified-execution.md) §2.3), so a device that appears
with a signed image can show where it came from.

This is the mechanism that makes the segmented-network case work end to end: the
artifact crosses the gap once, optically or by rvDrop, and then propagates
laterally without ever touching the boundary again.

### 2.4 RaptorQ for broadcast depends on
[ADR-014](./ADR-014-rvqr-fountain-selection.md)

Broadcast is the one place a *standard* codec matters, because the receivers may
not all be rvQR. rvQR's shipped codec is RaptorQ-**structured** and explicitly
not RFC 6330 conformant — it interoperates with nothing.

So this ADR has a dependency it cannot resolve on its own: **either
[ADR-014](./ADR-014-rvqr-fountain-selection.md) chooses conformance (its option
C), or this broadcast tier is rvQR-only and must say so.** Writing "RaptorQ" here
without settling that would be exactly the mislabelling
[docs/benchmarks.md](../benchmarks.md) §"What `artifacts/fountain.js` is"
forbids.

## 3. Consequences

### What this buys

- **Roughly 33× less source traffic** at the target, which is the difference
  between a site update being feasible and not.
- **Time-to-fleet stops scaling with fleet size**, because the constraint moves
  from the source link to local links.
- **Lateral propagation across boundaries**, which the point-to-point model
  cannot express at all.
- **It composes with [ADR-022](./ADR-022-rvqr-progressive-activation.md)**: a
  fleet can activate on the minimal closures while cold state still circulates.

### What it costs, honestly

- **BitChat does not exist in this tree.** Neither does the chunk store. This is
  a large new build on top of another large new build.
- **The blocked codec decision in §2.4** means the broadcast third of this design
  is not currently specifiable.
- **Malicious-peer handling is a scheduling problem with no measurement behind
  it.** "Deprioritise peers that do not deliver" is easy to write and easy to
  get wrong in ways that only show up at scale, under contention, with a peer
  that is adversarial rather than merely slow.
- **A 100-device test needs 100 devices.** The acceptance test below cannot be
  run in simulation and cannot be run without a site — which puts it behind
  [ADR-028](./ADR-028-rvqr-swarm-delivery-structure.md)'s conformance lab.
- **Custody receipts grow with hops** and are a privacy surface: they record
  which devices were near which others, and when.

## 4. Acceptance criteria

1. **Fleet-10.** Ten isolated devices on one site, nine holding an older RVF
   root. Pass when the first verified execution closure activates within **3 s**,
   the full fleet finishes within **60 s**, source traffic stays under **3×
   artifact size**, interrupted receivers resend at most one chunk, **one
   malicious peer contributes zero accepted data**, and every receiver produces a
   valid witness receipt.
2. **Fleet-100.** One hundred heterogeneous devices, 99 holding different older
   roots. Same gates, plus: **30% interruption recovers without restarting**,
   rollback attempts fail, and all 100 devices emit **matching witness lineage**.
3. **Verification is per-device**, demonstrated by a peer serving chunks from a
   *different* signed artifact and every receiver rejecting them.
4. **Malicious peers are measured, not assumed away** — at minimum:
   advertise-and-withhold, slow-drip, and corrupt-chunk behaviours, each with a
   stated effect on completion time.
5. **The broadcast codec is named accurately**, per §2.4, and if it is not RFC
   6330 conformant that is stated wherever the tier is described.
6. **Source traffic is measured directly**, not inferred from chunk accounting.
