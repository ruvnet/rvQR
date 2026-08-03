# ADR-023: Physical Presence Fusion

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Combining optical line-of-sight, acoustic challenge-response and radio ranging into one presence claim |
| Value / effort / risk | 4 / 3 / 2 |
| Implementation | None. UWB and ranging are absent from the tree |
| Related | [ADR-006](./ADR-006-rvqr-p2p-escalation.md), [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md), [ADR-021](./ADR-021-rvqr-device-attestation.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

rvQR's authentication story has always been physical.
[ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2 and
`artifacts/p2p.js` both say it plainly: *the human aiming the camera is the
authentication*. The documented, undefended attacks are substitution — someone
puts a different screen in front of the camera — and relay, where an attacker
who intercepts both QR exchanges runs a peer on each side. Physical
line-of-sight to both screens is what makes relay hard, not cryptography.

That is a real property and a weak one, because it is asserted rather than
measured. Nothing in the protocol records *how far away* the peer was, or
whether the thing that answered was in the room at all.

Three independent physical signals are available, and each measures something
different: **optical line-of-sight** (the camera saw a screen), **ultrasonic
challenge-response** (something acoustically present answered a fresh challenge),
and **UWB ranging** (distance and direction). Android 16 supports unified ranging
across UWB, Bluetooth channel sounding and WiFi NAN RTT, with cross-platform UWB
interaction with iOS
([developer.android.com/develop/connectivity/ranging](https://developer.android.com/develop/connectivity/ranging)).

## 2. Decision

### 2.1 All three are bound into the session transcript

Optical, acoustic and ranging evidence become part of the transcript the session
in [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) commits to, so a later
auditor can see what physical evidence existed at the time — and so an attacker
cannot swap one channel's evidence for another's.

Each is bound to the **session id** and to a **fresh challenge**, for the reason
[ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.4 gives about replay:
a recording of a physical signal is a perfectly valid physical signal.

### 2.2 No single channel may independently authorize activation

**This is the decision.** UWB gives distance and direction; ultrasound gives
channel liveness; optical gives line-of-sight. Any one of them alone is a
measurement an attacker can arrange:

- UWB says a device is 0.4 m away. It does not say it is the device on the screen.
- Ultrasound says something answered. A speaker in the room answers.
- Optical says a screen was seen. Substitution is exactly that.

Fused, they are much harder to arrange simultaneously — a relay attacker must be
in line-of-sight, acoustically present, and at the measured range, at the same
moment, for the same session.

**Presence remains evidence, not authorization.** The capability policy decides,
exactly as in [ADR-021](./ADR-021-rvqr-device-attestation.md) §2.2 and
[ADR-035](./ADR-035-rvqr-signature-admission.md). Fusion raises the cost of an
attack; it does not turn proximity into permission, and a device that is
definitely in the room is still not necessarily a device that may receive a
credential.

### 2.3 Degradation is graceful and recorded

Most devices will have one or two of the three. The session records which were
available and which passed, and the sender's policy states what it requires.
Absent is absent, never assumed-good — the same rule as
[ADR-020](./ADR-020-rvqr-embedded-provenance.md) §2 and
[ADR-021](./ADR-021-rvqr-device-attestation.md) §2.3.

## 3. Consequences

### What this buys

- **Relay MITM gets materially harder**, which is currently the strongest
  undefended attack on both the optical and the WebRTC paths.
- **The presence claim becomes checkable after the fact**, because it is in the
  transcript and therefore in the receipt.
- **It composes with attestation**: attestation says *what* the receiver is,
  presence says *where*, and a policy can require both.

### What it costs, honestly

- **UWB is unavailable on most devices and absent from this tree entirely.** The
  cross-platform story is new and, on the Apple side, recent enough that its
  real-world behaviour across specific device pairs is unproven — the same
  availability risk as WiFi Aware in
  [ADR-019](./ADR-019-rvdrop-bulk-transport.md) §2.5.
- **Fusion invites over-claiming.** "Verified physical presence" reads as much
  stronger than "three correlated measurements, each individually spoofable",
  and the UI must not make that leap.
- **Ranging leaks.** A protocol that measures and records distance and direction
  is collecting location data about a person holding a device, and that belongs
  in the same privacy discussion as
  [ADR-021](./ADR-021-rvqr-device-attestation.md).
- **Three channels, three sets of failure modes**, and the acoustic one has the
  unresolved measurement problem in
  [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md) §2.5.
- **A determined relay is still possible**, with equipment in both rooms. This
  raises cost; it does not close the attack, and saying otherwise would repeat
  the mistake [ADR-035](./ADR-035-rvqr-signature-admission.md) exists to correct.

## 4. Acceptance criteria

1. **No channel authorizes alone**, asserted by three tests, one per channel,
   each supplying a perfect signal for that channel and nothing else.
2. **Replay is refused on every channel** — recorded acoustic response, recorded
   ranging exchange, photographed QR — each bound to session id and challenge.
3. **All three appear in the transcript and the receipt**, with available,
   attempted and passed distinguished.
4. **A relay attempt is measured, not argued.** Build one: two devices, two
   rooms, a relay in between, and report which channels it defeats.
5. **Degradation is tested** on device pairs missing one and two of the three.
6. **The UI wording is reviewed against §3's over-claiming risk** before this
   ships.
