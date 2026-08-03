# ADR-019: rvDrop — The Bulk Transport Tier

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | An AirDrop-class local transfer mode sharing rvQR's trust root; explicitly **not** interoperating with Apple AirDrop |
| Implementation | **Almost none.** QUIC, WiFi Aware, BitChat and content-defined chunking are absent from the entire tree; BLAKE3, Zstd, the Merkle/witness gate and WebRTC exist |
| Related | [ADR-006](./ADR-006-rvqr-p2p-escalation.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-017](./ADR-017-rvqr-transport-modes.md), [ADR-024](./ADR-024-rvqr-fleet-swarm.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR moves 2.44–9.53 KB/s, measured. A 1 GB RVF container is 29 hours at the
ceiling ([docs/benchmarks.md](../benchmarks.md) §4). No amount of optical
engineering fixes that; [ADR-006](./ADR-006-rvqr-p2p-escalation.md) already
concluded that the payload has to move over a radio when one is permitted.

rvDrop is that tier, given the shape users already understand — pick a nearby
device, send, done — plus the things AirDrop does not have: sovereign identity,
post-quantum protection, resumable transfers, and signed RVF/RVM activation.
It is the **bulk-transport tier of the same deployment plane**
([ADR-011](./ADR-011-rvqr-deployment-plane.md)), not a replacement for rvQR:
optical and ultrasonic establish identity and proximity, radio moves the payload,
and the verification gate is identical whichever path the bytes took.

**What exists in the tree, checked rather than assumed:**

| Piece | Status |
|---|---|
| QUIC | **absent.** No `quinn`, `s2n-quic`, `msquic` or WebTransport anywhere in `crates/` or `npm/`. The only near-match is `quickcheck`, a property-testing library |
| WiFi Aware | **absent** |
| BitChat | **absent** |
| Content-defined chunking | **absent** ([ADR-013](./ADR-013-rvqr-byte-minimisation.md)) |
| BLAKE3 | present — `prime-radiant`, `rvm`, `rvm-witness`, `ruvector-graph`, and others |
| Zstd | present, optional, behind a `compression` feature in `ruvector-delta-core` and `ruvector-graph` |
| Merkle root + witness receipt | **present** — `rvm-witness`, ADR-134 |
| WebRTC | present and tested — `artifacts/p2p.js` |

**So QUIC is greenfield, not an integration.** Anyone costing this work should
read the first row as "write and harden a QUIC integration from nothing",
not "wire up the existing one".

## 2. Decision

### 2.1 Do not stripe every medium as an equal data lane

This is the central design correction and it deserves to be stated before any
transport detail.

The tempting architecture treats optical, acoustic and radio as three lanes of
one pipe. The measured rates make that absurd:

| Medium | Rate | Role |
|---|---|---|
| Ultrasound | ~33 useful bit/s measured at the defaults ([ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md)) | **control** |
| Optical | 0.0024–0.0095 MB/s measured; 0.10–0.19 MB/s is the aspiration ([ADR-026](./ADR-026-rvqr-optical-turbo.md)) | **bootstrap, or strict mode** |
| WiFi | MB/s | **bulk** |

Ultrasound is six to seven orders of magnitude below WiFi, and roughly three
below optical. Striping across them means the
slowest lane sets the completion time for whatever fraction it was given, and
any scheduler that adapts to that will simply route everything to WiFi — having
paid for a striping implementation to discover it.

**Instead: race eligible transports, select the fastest trusted path, and
preserve application-level resume state across a switch.** Resume state is
application-level precisely so a switch costs nothing but the chunk in flight.

### 2.2 Transport scoring, and why shared-LAN QUIC is the v1 target

Assurance / speed / reach / maturity, out of 5:

| Transport | A | S | R | M |
|---|---|---|---|---|
| WiFi Aware + QUIC | 4 | 5 | 3 | 3 |
| **Shared-LAN QUIC** | 4 | 5 | **5** | **5** |
| Browser WebRTC | 3 | 4 | 5 | 4 |
| Strict optical + ultrasonic | **5** | 1 | 3 | 4 |

**Shared-LAN QUIC scores highest on reach and maturity, so it is the pragmatic
v1 target.** WiFi Aware is the differentiator and ships once its availability is
proven — not before, because §2.5 says that availability is not a given.

Note the assurance column: strict optical scores 5 and is 1 on speed. That is
[ADR-017](./ADR-017-rvqr-transport-modes.md)'s trade in one row.

### 2.3 The stack

1. **Proximity and keys.** QR or ultrasound confirms proximity and binds an
   X25519 + ML-KEM-768 session ([ADR-012](./ADR-012-rvqr-post-quantum-manifest.md)).
2. **Discovery and link.** WiFi Aware where available; Apple private-peer WiFi
   and Android WiFi Direct as compatibility adapters. Apple exposed
   standards-based WiFi Aware at
   [WWDC25](https://developer.apple.com/videos/play/wwdc2025/228/); Android has
   had it since API 26, with
   [hardware support optional](https://developer.android.com/reference/android/net/wifi/aware/package-summary).
3. **Transfer.** QUIC carrying 1 MB content-addressed chunks over 4–8 bounded
   streams.
4. **Byte minimisation.** FastCDC, BLAKE3, receiver inventory, RVF delta,
   adaptive Zstd ([ADR-013](./ADR-013-rvqr-byte-minimisation.md)).
5. **Control and discovery messaging.** BitChat for receipts and fallback.
6. **Trust plane unchanged.** rvQR stays the strict radio-free transport;
   ultrasound stays the authenticated reverse channel.
7. **Release gate.** The receiver verifies the complete Merkle root **and** the
   signature before exposing, vaulting or executing anything.

Step 7 is [ADR-016](./ADR-016-rvqr-verified-execution.md) verbatim, and it binds
to `rvm-witness`'s existing Merkle sealing rather than defining a second root
format.

### 2.4 Multipath QUIC waits

The IETF multipath extension is
[still completing standardisation](https://datatracker.ietf.org/doc/draft-ietf-quic-multipath/)
and deliberately leaves path scheduling to implementations — which means adopting
it now buys a non-final wire format *and* an unsolved scheduling problem.

v1 uses **path racing, failover and resumable chunks**. Uncontrolled multipath
striping is an explicit non-goal
([ADR-027](./ADR-027-rvqr-non-goals.md)).

### 2.5 The fallback chain is the feature

**WiFi Aware hardware support is optional on Android and unproven across specific
Apple/Android combinations.** That is an availability risk, not an
implementation detail, and the mitigation is runtime capability detection with
guaranteed fallbacks:

WiFi Aware → shared LAN → temporary hotspot → **WebRTC** (`artifacts/p2p.js`,
which exists and is tested) → BitChat → **rvQR optical**.

Every step degrades speed and none degrades trust, because the release gate is
the same at every level. The chain terminating in optical is what makes rvDrop a
tier of this system rather than a separate product: the slowest fallback is the
thing that already works.

### 2.6 Engineering targets

Discovery under 500 ms; authenticated session under 1.5 s; first byte under 2 s;
sustained 25–100 MB/s on modern native devices; 1 GB in roughly 10–41 s; resume
retransmits at most one chunk; no cloud relay, transfer charge or infrastructure
dependency. **All targets, none measured** — there is no QUIC implementation to
measure.

## 3. Consequences

### What this buys

- **The 29-hour problem becomes a 10–41-second one**, if the targets hold.
- **One trust root across six transports.** The verification gate does not care
  which medium delivered the bytes.
- **A shape users already understand**, without AirDrop's constraints — no single
  vendor, no account, and signed activation at the far end.
- **Content addressing pays twice.** The chunk store that makes resume cheap is
  the same one [ADR-024](./ADR-024-rvqr-fleet-swarm.md) needs for peer exchange.

### What it costs, honestly

- **The largest single piece is greenfield.** A QUIC integration is not a
  dependency bump; it is a protocol implementation with its own security
  surface, and nothing in the tree has one.
- **Four of the seven stack layers do not exist**: QUIC, WiFi Aware, BitChat,
  content-defined chunking.
- **Platform permissions and entitlements are external dependencies** on Apple's
  and Google's timelines, not the team's.
- **WiFi Aware may simply not be available** on the device pairs that matter, in
  which case the differentiator collapses to shared-LAN QUIC — which is a good
  product and not a novel one.
- **rvDrop is not radio-silent, by construction**, and therefore is unavailable
  in strict mode ([ADR-017](./ADR-017-rvqr-transport-modes.md)). The users with
  the strongest reason to want sovereign transfer are the ones this tier cannot
  serve.
- **Six transports is six times the fuzzing surface**, and each accepts input
  from an untrusted peer.

## 4. Acceptance criteria

1. **The headline test.** Disconnect both devices from the internet and from any
   access point. Pair via QR. Transfer a signed 1 GB RVF. Interrupt at 60%.
   Reconnect. Require: completion within **45 s total transfer time**, no more
   than **1 MB retransmitted**, an **identical BLAKE3 root**, and **zero
   committed bytes** when the signature is deliberately corrupted.
2. **The fallback chain is exercised end to end**, each step forced in turn, with
   the transfer completing at every level and the release gate identical at each.
3. **Capability detection is real.** On a device without WiFi Aware the code
   detects rather than fails, and the chosen transport is reported.
4. **No committed bytes before verification**, tested on every transport, not
   only the fast one — [ADR-016](./ADR-016-rvqr-verified-execution.md) §4.1
   applied per adapter.
5. **Resume is application-level**, demonstrated by interrupting on one transport
   and completing on another with at most one chunk resent.
6. **Targets in §2.6 are measured or struck.** Any that has not been measured on
   hardware after v1 is removed from this document rather than carried as
   aspiration.
7. **The greenfield QUIC work is fuzzed and reviewed independently** of the team
   that wrote it ([ADR-028](./ADR-028-rvqr-swarm-delivery-structure.md)'s
   verification domain).
8. **Interoperability with Apple AirDrop is never claimed** anywhere, and the
   name is not used in a way that implies it.
