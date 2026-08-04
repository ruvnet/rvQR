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

> **Where this list stands at [e9d276b](https://github.com/ruvnet/rvQR/commit/e9d276b).**
> Four criteria are demonstrated, two are not met and were not attempted.
> `artifacts/swarm.describeCriteria()` reports the same at runtime, so the state
> is discoverable from the code and not only from this file.
>
> | # | State | Evidence |
> |---|---|---|
> | 1 Fleet-10 | **not met, not attempted** | Needs TEN PHYSICAL DEVICES on one site and a wall clock. There is no device fleet here. The simulation can run ten simulated receivers, but its tick count is not a second and must never be quoted as one. |
> | 2 Fleet-100 | **not met, not attempted** | Needs ONE HUNDRED physical devices. Fails for criterion 1's reason and one order of magnitude more of it. |
> | 3 Per-device verification | **demonstrated** | A peer serving genuinely signed chunks from a DIFFERENT artifact is refused by every receiver, because each derives its expectation from the manifest *it* verified. A manifest for another artifact is refused as FOREIGN even when the pin names its own digest, and foreign deliveries never reach the digest function at all. |
> | 4 Malicious peers measured | **demonstrated in simulation** | Advertise-and-withhold, slow-drip and corrupt-chunk, each with its effect on completion in SIMULATION TICKS against a no-adversary baseline, and `wrongChunksStored: 0` for every one. Advertise-and-withhold and corrupt-chunk fall below the scheduling floor after one attempt. |
> | 5 Broadcast codec named | **met** | Named through a single constant that carries its own qualification — "RaptorQ-structured (NOT RFC 6330 conformant; interoperates with nothing)" — so it cannot be quoted without the caveat. `describeBroadcastTier()` reports `rfc6330Conformant: false`, and no broadcast tier is wired into the transfer at all. |
> | 6 Source traffic measured directly | **demonstrated in simulation** | The meter sits on the line that emits the bytes, and the report carries what chunk accounting *would* have claimed beside it, so the size of that error is visible rather than assumed away. |
>
> **The distinction this ADR's numbers rest on.** A deterministic simulation
> produces real measurements *of the simulation* — byte counts, chunk counts,
> rejection outcomes are all genuinely measured. Its **timings are not
> measurements of any fleet**. Every timing reports `simulation: true`,
> `wallClockMeasured: false`, `timingUnit: "ticks"`. The §2.1 target of "under
> 3 GB of source traffic for 100 devices × 1 GB" is described by this ADR itself
> as a target rather than a measurement, and nothing here promotes it to one.
>
> **Not reachable from the app, and deliberately so.** `swarm.js` distributes an
> artifact across a fleet exchanging chunks over a peer transport. rvQR is a
> two-device optical tool, and `p2p.js` — the WebRTC transport that would carry
> such an exchange — is itself unwired: no script tag, no call site. Adding a
> swarm panel would imply a fleet capability the application does not have, so
> the module ships as a measured, tested library that the page does not load.
> The standing rule that "a module the app cannot reach is not shipped" exists to
> stop orphaned code being counted as delivered; satisfying it theatrically here
> would mislead a user, which is the opposite of its purpose.
