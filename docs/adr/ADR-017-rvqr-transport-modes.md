# ADR-017: Strict and Hybrid Transport Modes

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | Whether radios may be used at all, expressed as a mode the operator chooses rather than a fallback the code takes |
| Implementation | None. rvQR is strict-mode-only today by accident of not having the other transports |
| Related | [ADR-006](./ADR-006-rvqr-p2p-escalation.md), [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md), [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-006](./ADR-006-rvqr-p2p-escalation.md) established that escalating to
WebRTC is not radio-silent and must be opt-in.
[ADR-019](./ADR-019-rvdrop-bulk-transport.md) adds WiFi Aware, shared-LAN QUIC
and a fallback chain. [ADR-015](./ADR-015-rvqr-adaptive-control.md) adds a
controller that picks among transports automatically.

Those three together create a specific hazard: **a chain of sensible fallbacks
ends with a radio transmitting, and nobody decided that.** Each individual step
is reasonable — try the fast path, fall back, fall back again — and the
aggregate silently discards the property that makes rvQR worth using in the
settings [ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.3 names: segmented
networks, air-gapped provisioning, devices that must not associate.

## 2. Decision

### 2.1 Two modes, chosen by the operator, visible at all times

| | **Strict** | **Hybrid** |
|---|---|---|
| Media | light and sound only | optical/ultrasonic for trust, radio for bulk |
| Radios | **disabled** | enabled after trust is established |
| Rate | 2.44–9.53 KB/s measured today | MB/s over the link, unmeasured here |
| Observability | nothing on any network | associates two devices, observable, logged by infrastructure |
| Trust root | optical | **optical** |

**The trust root is optical in both modes.** In hybrid, the radio is a
replaceable accelerator carrying bytes whose acceptance was decided by a manifest
that crossed the gap as light. Swapping the accelerator does not change the
acceptance rule
([ADR-016](./ADR-016-rvqr-verified-execution.md) §2.1,
[ADR-006](./ADR-006-rvqr-p2p-escalation.md) §2.2).

### 2.2 Mode is a mode, never a fallback

**The controller may not change mode.** Within hybrid it may race transports,
fail over, and pick the fastest trusted path
([ADR-019](./ADR-019-rvdrop-bulk-transport.md) §2.2). Within strict it may vary
symbol version, lanes, frame rate and redundancy. It may never move between
them, and no failure — including total failure to transfer — promotes strict to
hybrid.

This is the hard-rules-override-learning invariant from
[ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.3 applied to the one parameter
whose wrong value is not a performance problem but a policy breach. "Radio use
must satisfy policy" is listed there as outside the objective function; this ADR
is what that sentence means operationally.

### 2.3 Strict mode is enforced, not merely selected

Strict mode is a claim about what the device did, so it has to be checkable:

- No `RTCPeerConnection` is constructed, no candidate is gathered, no socket is
  opened. Asserted structurally, not by configuration.
- The mode is displayed continuously during a transfer, not only at the moment of
  choosing.
- Entering hybrid requires an explicit action naming the local network, per
  [ADR-006](./ADR-006-rvqr-p2p-escalation.md) §2.3.
- The mode in force is recorded in the session transcript and therefore in the
  witness receipt ([ADR-016](./ADR-016-rvqr-verified-execution.md) §2.3), so an
  auditor can later establish which medium carried a given deployment.

That last point is what makes strict mode worth more than a checkbox: in the
regulated settings this is aimed at, "this artifact never touched a network" is
the claim being made, and a claim in an audit trail is worth more than a claim in
a UI.

### 2.4 Ultrasound belongs to strict mode

[ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md)'s acoustic back channel
is available in **both** modes, because sound crosses the same physical gap light
does and joins no network. It is what makes strict mode tolerable rather than
merely principled — it is the difference between a sender that loops forever and
one that stops when the receiver is done.

Its own optionality is unchanged: microphone denied, device muted or room too
noisy all fall back to open-loop fountain, and that fallback is *within* strict
mode, not out of it.

## 3. Consequences

### What this buys

- **The air-gap property survives contact with a fallback chain.** Which is the
  entire point, and is not achievable by making each fallback individually
  careful.
- **An auditable claim.** The medium is in the receipt.
- **A clean division of labour for the controller.** It optimises inside a box
  somebody else drew.

### What it costs, honestly

- **Strict mode is 2.44 KB/s measured, and stays that way.** Every projection in
  [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) applies to it, and none of them
  is measured. A user in strict mode with a 100 MB container has an eleven-hour
  problem this ADR does not solve.
- **Two modes double the test matrix** for every transport-touching change, and
  the acceptance bar in [ADR-010](./ADR-010-rvqr-acceptance-bar.md) already
  requires radios disabled — meaning the bar tests strict and says nothing about
  hybrid.
- **A mode the user must choose is a mode the user will choose wrongly**, and the
  safe default (strict) is the slow one, so the pressure is all in one direction.
- **"Radios disabled" is a stronger claim than a web page can make.** rvQR cannot
  turn off a device's radio; it can only decline to use it. On a phone that is
  also running other software, strict mode means "this app opened no
  connections", and the UI must not overstate it.

## 4. Acceptance criteria

1. **Strict mode opens nothing.** A network-request assertion over a complete
   transfer sees zero connections, zero candidates, zero sockets — the test in
   [ADR-006](./ADR-006-rvqr-p2p-escalation.md) §4.8, extended to every transport
   added since.
2. **No path promotes strict to hybrid.** An adversarial test fails every
   transport in turn and asserts the mode never changes and the transfer either
   completes optically or fails.
3. **The controller cannot emit a mode change**, asserted structurally per
   [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.6.
4. **The mode is in the transcript and the receipt**, and a receipt verifier can
   report which medium carried the artifact.
5. **The mode is visible throughout**, not only at selection — checked in the UI,
   since this is a claim users act on.
6. **Ultrasound works in both modes** and its absence degrades within the mode
   rather than across it.
7. **The wording of the strict-mode claim is reviewed against what the page can
   actually guarantee**, per the last cost bullet.
