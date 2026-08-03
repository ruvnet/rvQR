# ADR-006: QR-Bootstrapped BitChat / WebRTC Escalation

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Using the optical channel to establish trust and identity, and a radio channel to move the payload |
| Implementation | `artifacts/p2p.js` implements the WebRTC half and is **not wired into the app**; BitChat is not implemented at all |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-035: Pinned-Fingerprint Admission](./ADR-035-rvqr-signature-admission.md), [ADR-034: QR Cognitive Seed](./ADR-034-qr-cognitive-seed.md) (mirrored), [ADR-057: Federated RVF Transfer Learning](./ADR-057-federated-rvf-transfer-learning.md) (mirrored) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR's real role is not bulk transport. It is the physical bootstrap and trust
plane for RuVector, RVM, BitChat and edge deployments: the thing you use when
two devices have never met, share no account, and cannot be assumed to be on the
same network — or when you have decided they must not be.

Every other decision in this set makes the optical channel faster. Together they
project tens of KB/s ([ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md)), which
turns a 40 KB module into a second and a 100 MB container into a bad afternoon
rather than eleven hours. That is a real improvement and it does not change the
shape of the problem. The measured ceiling today is 9.53 KB/s
([docs/benchmarks.md](../benchmarks.md) §4); a WebRTC data channel between two
devices on the same LAN moves megabytes per second. No amount of optical
engineering closes three orders of magnitude.

The reason this is not normally available without a server is signalling: two
browsers cannot find each other without something in the middle to relay an
offer and an answer. rvQR already owns that something. It is a camera pointed at
a screen.

`artifacts/p2p.js` implements this. It is a complete module with tests and it is
not reachable from the UI; `artifacts/app.js` and `artifacts/index.html` contain
no reference to it.

## 2. Decision

### 2.1 QR carries identity and control; the radio carries bytes

The optical channel keeps the jobs it is uniquely good at and gives up the one
it is bad at:

| Over QR | Over the data channel |
|---|---|
| Ephemeral public keys and DTLS fingerprints | Artifact payload |
| Manifests: name, sizes, codec, both hashes | Segment bodies for delta transfer |
| Segment inventories (which spans the receiver already holds) | |
| Session establishment and consent | |

That split is what makes escalation worth having rather than a shortcut. The
trust root stays physical: what crosses the air gap is what a human aimed a
camera at, and the payload's acceptance still depends on a manifest that arrived
optically.

Measured, the control plane fits comfortably. `artifacts/p2p.js`'s profile codec
turns a **549-byte SDP into 156 payload bytes**, plus a one-byte codec
identifier and a four-byte integrity tag — 214 base64url characters, 220 with
the tag, inside a **version 9 level L** symbol's 230-byte capacity. The
receiver's delta inventory for the demo container is **134 base64url bytes,
exactly a version 6-L symbol** ([docs/benchmarks.md](../benchmarks.md) §5). Both
are single, low-density, easily-scanned symbols — which is the half of the
design that has to work on a shaky handheld camera.

### 2.2 The transport changes; the acceptance rule does not

Bytes arriving over the data channel go through the identical receiver state
machine and the identical SHA-256 check as bytes arriving through the camera,
and through the identical admission control in
[ADR-035](./ADR-035-rvqr-signature-admission.md). **Changing the pipe does not
change the acceptance rule.** This is already how `artifacts/p2p.js` is built —
it drives `core.js`'s receiver rather than trusting the transport — and it is
the property that makes escalation a performance decision rather than a security
one.

### 2.3 This is explicitly NOT radio-silent, and the mode is opt-in

rvQR's promise is that the page makes no network calls to anyone. Escalation
breaks that, deliberately and visibly.

A WebRTC data channel is Wi-Fi traffic. It is observable, it is attributable, it
associates two devices on a network, and it exists in logs the user does not
control. Anyone whose reason for using rvQR is an air gap — a segregated
network, a device that must not join one, a situation where being seen to
transfer is the risk — must not get this by accident.

Therefore:

- The mode is **off by default** and requires an explicit action per session.
- The UI states, at the point of the choice and not in an About tab, that the
  transfer will use the local network.
- `iceServers` defaults to **empty**, which restricts the connection to host
  candidates and therefore to a LAN. No STUN, no TURN, no third party contacted.
  Supplying `iceServers` is a further explicit opt-in that gives up the LAN-only
  property, and nothing in the code adds one as a fallback.
- Falling back the other way is free: if the channel does not establish, the
  optical path is still there and still correct.

### 2.4 What the exchange defends, and what it does not

DTLS binds the channel to the `a=fingerprint` carried in the SDP, so once the
SDP has been exchanged faithfully the channel is confidential and
integrity-protected against anyone on the network path, including the LAN both
devices are sitting on. That part is WebRTC's and it is strong.

The exchange is the weak half, and it is weak in exactly the way the optical
channel is weak ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2):

- **Substitution.** An offer QR is unauthenticated. Someone who can put a screen
  in front of your camera becomes the peer, and every DTLS guarantee then holds
  faithfully to the wrong device.
- **Relay / MITM.** An attacker who can intercept *both* QR exchanges runs a
  peer on each side. There is no shared secret and no identity to bind to.
  Physical line-of-sight to both screens is what makes this hard, not
  cryptography.
- **Corruption, as distinct from attack.** The profile codec is tokenised, so a
  damaged payload can decode without error to a *different valid* SDP — another
  port, another address, one byte of a fingerprint — and pass a whitelist that
  asks whether the text is well-formed rather than whether it is the text that
  was sent. The four-byte tag closes that: about 1 in 4 billion. It detects
  corruption and **authenticates nothing**, being an unkeyed hash travelling
  inside the payload it covers.

Pinning a fingerprint ([ADR-035](./ADR-035-rvqr-signature-admission.md)) is what
turns "the human aiming the camera" into a checkable claim, and it applies to
this path unchanged.

### 2.5 BitChat is a second escalation target, not a variant

BitChat has no ADR to mirror; its design lives in the QuDAG repository. The
planned use — a bootstrap QR carrying an X25519 public key, HKDF-SHA256 deriving
session keys — is specified in [docs/protocol.md](../protocol.md) and is **not
implemented**. It matters here because it has a different radio profile from
WebRTC and therefore a different answer to §2.3, and because it is the target
that makes this an rvQR-shaped feature rather than a WebRTC demo. It is recorded
as a target and nothing in this document claims it works.

## 3. Consequences

### What this buys

- **The optical trust bootstrap is preserved while the payload stops being the
  bottleneck.** A 100 MB container becomes possible rather than theoretical.
- **No signalling server, no STUN, no TURN, no account.** The install-free,
  network-free character of the page survives at rest; only an explicitly chosen
  transfer uses the network.
- **A control plane that is already the right size.** 156-byte offers and
  134-byte inventories are the easiest symbols in the system to scan.
- **Delta transfer becomes reachable.** The measured 85.1× on a 1.65 MB
  container with 1% of segments changed ([docs/benchmarks.md](../benchmarks.md)
  §5) needs the receiver to advertise what it holds — a reverse channel
  [ADR-001](./ADR-001-rvqr-optical-transport.md) called "a change in shape, not
  a parameter". A QR inventory plus a data channel is that shape.

### What it costs, honestly

- **The air gap is gone whenever this is on.** That is the entire trade and it
  should never be softened. rvQR's most defensible use is the one this mode
  cannot serve.
- **Two devices on one network.** Which is exactly the precondition the
  comparison in [docs/benchmarks.md](../benchmarks.md) §7 says makes qrcp,
  LocalSend and PairDrop *not* comparable to an optical channel. Turning this on
  makes rvQR that category of tool, with a better bootstrap.
- **A much larger attack surface.** SDP parsing, ICE, DTLS, SCTP and a
  backpressure protocol, all fed from a camera. `p2p.js` bounds every length
  before use, caps inflation against a decompression bomb, and validates the
  reconstructed SDP line-by-line against a whitelist — and it is still far more
  code between an attacker and the receiver than parsing a JSON frame.
- **Relay MITM is undefended and is not detectable by the protocol.** Only
  fingerprint pinning or physical line-of-sight to both screens closes it.
- **Throughput is unmeasured in this repository.** "Megabytes per second" is the
  module's expectation and the general behaviour of a LAN data channel, not
  something `bench/` has observed. No end-to-end figure exists.
- **It is not wired in.** There is no UI, no consent flow, no mode switch. The
  module and the app do not know about each other.

## 4. Acceptance criteria

1. **Consent is explicit and per-session.** A test asserts no
   `RTCPeerConnection` is constructed and no candidate is gathered until the
   user has taken a specific action, and that the UI names "local network"
   before that action, not after.
2. **LAN-only by default, provably.** `iceServers` is empty unless supplied; a
   test asserts no code path adds one. Candidate types gathered in a real
   browser are host-only.
3. **One acceptance rule.** The same artifact delivered optically and over the
   data channel produces byte-identical vault contents, passes through the same
   `core.admitArtifact` verdict, and a corrupted data-channel payload is
   rejected by the manifest hash exactly as an optical one is.
4. **Pinning applies to both paths.** With a fingerprint pinned and the wrong
   signer, a data-channel transfer stores nothing —
   [ADR-035](./ADR-035-rvqr-signature-admission.md)'s Chromium check, repeated
   on this path.
5. **Hostile offer payloads.** A fuzz corpus of malformed and adversarial SDPs
   through `parseOfferPayload` produces rejection or a bounded allocation, never
   a hang and never an unbounded inflate.
6. **Fallback is real.** With the peer unreachable, the optical path completes
   the same transfer without a reset.
7. **Measured throughput** phone-to-phone on a LAN, reported alongside the
   optical figure so the trade is quantified rather than asserted.
8. **The radio-silence statement is tested as documentation**, not only as
   behaviour: with the mode off, a network-request assertion over a full
   transfer sees nothing.
