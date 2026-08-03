# ADR-007: Ultrasonic Reverse Control Channel

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | A low-rate acoustic back channel from receiver to sender, and the two safety findings that constrain it |
| Implementation | Nothing. No acoustic code exists in this repository |
| Related | [ADR-001: rvQR Optical Transport](./ADR-001-rvqr-optical-transport.md), [ADR-002: Binary Frame Protocol v2](./ADR-002-rvqr-binary-frame-protocol.md), [ADR-031: Multi-Symbol Spatial Lanes](./ADR-031-rvqr-multi-symbol-lanes.md), [ADR-006: QR-Bootstrapped Escalation](./ADR-006-rvqr-p2p-escalation.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

Almost every unpleasant property of rvQR traces to one fact: **there is no back
channel.** The sender never learns what the receiver missed, so it loops forever
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.1). It never learns when the
receiver is done, so it keeps painting. It never learns what the receiver's
camera can resolve, so the lane profile in
[ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) §2.2 has to be a user setting. It
never learns the block size, so the manifest repaint interval is a constant that
[docs/benchmarks.md](../benchmarks.md) §3 measures to be wrong at one end or the
other — at K=5 a 4-slot repaint cuts the 60%-loss p95 from 101 slots to 30, and
at K=81 that same interval is the worst choice on the table.

Delta transfer has the same shape of problem stated more starkly:
[ADR-001](./ADR-001-rvqr-optical-transport.md) calls the receiver advertising
what it holds "a change in shape, not a parameter", and the measured prize is
large — a 1.65 MB container with 1% of its segments rewritten sends 19,400 bytes,
an **85.1×** reduction ([docs/benchmarks.md](../benchmarks.md) §5).

[ADR-006](./ADR-006-rvqr-p2p-escalation.md) solves this by joining a network,
and gives up the air gap to do it. An acoustic channel does not. Sound crosses
the same physical gap the light does, needs no pairing, no account and no
network, and both devices already have a speaker and a microphone.

`ruvnet/ultrasonic` is the obvious starting point. Read at `main` for this
document, its encoder defaults are `freq_0 = 18500`, `freq_1 = 19500`,
`sample_rate = 48000`, `bit_duration = 0.01`
(`src/embed/ultrasonic_encoder.py`) — **binary FSK at 100 symbols per second** —
and `_add_error_correction` prefixes a 16-bit length and then **repeats every bit
three times** for majority voting, which leaves about **33 useful bits per
second**. `src/crypto/cipher.py` frames payloads as AES-256-GCM with a 16-byte
IV and a 16-byte tag (**32 bytes fixed**) and `add_obfuscation` appends a length
byte plus 1–32 random bytes (**2–33 bytes**). The project's README quotes
"100-1000 bps depending on configuration" and an 18–20 kHz band.

What that costs for a 16-byte command, at the defaults:

| Step | Bits |
|---|---:|
| 16-byte plaintext → GCM ciphertext + 16-byte IV + 16-byte tag = 48 bytes | 384 |
| Obfuscation, 2–33 bytes | +16 … +264 |
| 16-bit length prefix | +16 |
| 3× repetition over everything above | ×3 |
| 24-bit preamble (added after error correction, not repeated) | +24 |
| **Total at 100 symbols/s** | **12.7 s … 20.2 s** |

That is fine for "start", "approve", "cancel". It is useless for anything
per-frame: a per-frame acknowledgement at 5 fps needs five messages a second and
this channel delivers one every fifteen seconds.

**And the ceiling is low even done well.** Google's robust near-ultrasound
system for consumer hardware achieved **94.5 raw bit/s**
([doi:10.1109/TMM.2017.2766049](https://doi.org/10.1109/TMM.2017.2766049)) —
their measurement, on unmodified phones, from a team with substantial resources.
Against our ~33 useful bit/s that is a factor of three, not a factor of a
thousand.

That number should settle the category question rather than motivate an
optimisation programme: **near-ultrasound is a proximity token and a control
channel, and it is not a data channel at any effort level anyone has
demonstrated.** [ADR-027](./ADR-027-rvqr-non-goals.md) §2.1 records that as a
decision. Everything below is designed to fit inside roughly 100 bit/s rather
than to escape it.

## 2. Decision

### 2.1 Forward optical, reverse acoustic — and the speed comes from omission

rvQR keeps its data plane on light. Ultrasound carries only receiver → sender
control: capability negotiation, fountain rank, signal quality, and
pause / resume / cancel / complete.

**The throughput gain is not acoustic bandwidth.** 33 bits per second, or even
1000, contributes nothing to moving an artifact. The gain is that the sender
stops painting frames nobody needs:

- **Stop on completion.** Today the sender loops forever and the human decides
  when to stop. A receiver that says "rank 81 of 81" ends the transfer at the
  moment it is done.
- **Repaint the manifest on request** rather than on a constant. This directly
  addresses the finding in [docs/benchmarks.md](../benchmarks.md) §3, where the
  optimum interval moves in opposite directions between K=5 and K=81 and *any*
  fixed constant is wrong at one end.
- **Pick the lane profile from the receiver's actual camera**, which is the
  problem [ADR-031](./ADR-031-rvqr-multi-symbol-lanes.md) §2.2 otherwise leaves
  to a user-visible setting with a conservative default.
- **Advertise the segment inventory**, which is what delta transfer needs and
  has never had.

### 2.2 A compact RVU1 control frame, ~20 bytes

The `ultrasonic` defaults are built for sending a command string, not a
telemetry tick, and 48 bytes of AEAD framing around a 16-byte message is why a
command takes a quarter of a minute. rvQR proposes a distinct **RVU1 binary
control mode**:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Message type: hello, capability, rank, quality, pause, resume, cancel, complete |
| 1 | 1 | Flags |
| 2 | 4 | Session id — the transfer id from the [ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) header, so a control frame belongs to exactly one optical transfer |
| 6 | 2 | Monotonic counter |
| 8 | 2 | Fountain rank (symbols held) |
| 10 | 1 | Signal quality, 0–255 |
| 11 | 1 | Suggested QR profile — version and lane count |
| 12 | 8 | Authentication tag, truncated |
| | **20** | |

Carried over **4-tone FSK** — two bits per symbol — at **500–1000 raw bit/s**,
within the "100-1000 bps" range the project already publishes. 160 payload bits
under a rate-½ code plus a 24-bit preamble is 344 bits, which is **344 ms at
1000 bit/s and 688 ms at 500**. The design target is **300–750 ms of feedback
latency**, against 12.7–20.2 s for the same information through the default
encoder.

A rate-½ code rather than 3× repetition because repetition is the least
efficient way to spend redundancy, and because the honest state of the published
error tolerance is §2.5 below.

### 2.3 Event-driven, never per-frame

Control frames are emitted on state change and on a rank *stride* — every 16
symbols of progress — not per optical frame. At K=81 that is five rank reports
across a whole transfer; at K=5, one. Sixteen is a starting value to be tuned
against measurement, not a derived constant.

Attempting per-frame acknowledgement would make the acoustic channel the
bottleneck for the optical one, which is the failure this design exists to
avoid.

### 2.4 Safety finding: AES-GCM does not stop replay of a recording

AES-256-GCM authenticates and encrypts. It does **not** prevent someone from
recording a control message off the air and playing it back later, because a
replayed message is a genuine message and verifies perfectly. Sound is trivially
recordable at a distance and a phone is a recorder.

Concretely, an attacker with a recorder can replay "cancel" to kill a transfer,
replay "complete" to make a sender stop before the receiver has the object, or
replay a stale "suggested profile" to force a sender onto a slow lane profile.
The mitigation is not cryptographic strength; it is binding and ordering:

- Every control frame carries the **session id** of a specific optical transfer,
  and a frame naming any other session is discarded without processing.
- Every control frame carries a **monotonic counter**, and a sender rejects a
  counter it has already seen or one lower than the highest it has accepted for
  that session.
- The session id is fresh per send, exactly as v1's transfer id already is
  ([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.5), so a recording is
  useless against the next transfer.

**And a bound on authority, which is the real defence.** The ultrasonic channel
can only influence *scheduling*. It cannot cause a byte to be accepted: the
content hash in the optical manifest remains the acceptance rule
([ADR-001](./ADR-001-rvqr-optical-transport.md) §2.2), and admission still runs
through `core.admitArtifact`
([ADR-035](./ADR-035-rvqr-signature-admission.md)). The worst a perfect acoustic
attacker achieves is denial of progress — which a person watching two screens
will notice.

The truncated 8-byte tag is a deliberate size trade and should be read in that
light: 64 bits of forgery resistance per attempt, on a channel whose authority
is limited to scheduling and whose messages are already session-bound and
counter-ordered.

### 2.5 Safety finding: the published 20% error tolerance is not evidence about FSK

`ultrasonic`'s headline robustness claim rests on
`src/tests/test_enhanced_error_correction.py`, whose main requirement test
injects a 20% bit error rate. Its `inject_bit_errors()` corrupts a bit by
negating the samples of that bit period:

```python
# Flip the frequency by inverting the signal
corrupted_signal[start_idx:end_idx] *= -1
```

**Negating a sinusoid is a 180° phase shift, not a change of frequency.** The
comment describes an intent the code does not carry out. And the decoder is
blind to it: `src/decode/ultrasonic_decoder.py` decides bits with

```python
correlation = np.abs(np.dot(windowed_segment, windowed_reference))
```

— the absolute value of a correlation, so the sign flip cancels — and its
simpler path takes an FFT magnitude, which is likewise sign-blind. The injected
"errors" change nothing either decision function measures.

So the test demonstrates that a signal survives a transformation its decoder
cannot see. It says nothing about tolerance to real acoustic impairment: room
reverberation, speaker roll-off above 18 kHz, microphone AGC, Doppler from a
moving hand, or another device's ultrasound. **Before any of this is relied
upon, the error tolerance must be re-established with real speakers and
microphones**, with impairments that alter what the decoder actually measures —
band-limited noise, multipath, frequency offset, and dropouts.

This is recorded as a finding about a dependency, not as a criticism of using
it. The rest of the module is a reasonable base; this one number should not be
carried forward.

### 2.6 Ultrasound is optional, and open-loop fountain remains the floor

The transport must work with the microphone permission denied, the device muted,
the speaker unable to reach 19 kHz, or the room too noisy. In every one of those
cases rvQR falls back to the behaviour it has today: an open-loop fountain
stream that the sender loops and the human stops, which
[docs/benchmarks.md](../benchmarks.md) §1 measures at 2.5× fewer slots than
indexed chunks at 20% loss and 3.75× at 60%.

A closed loop is an optimisation on top of a transport that already works
without one. It is never a dependency.

## 3. Consequences

### What this buys

- **A back channel that does not join a network.** Unlike
  [ADR-006](./ADR-006-rvqr-p2p-escalation.md), the air gap survives: no
  association, no addresses, no logs on infrastructure the user does not own.
- **The end of guessing.** Manifest repaint interval, lane profile, and when to
  stop all become answers rather than constants — and
  [docs/benchmarks.md](../benchmarks.md) §3 measures a 3.4× p95 improvement at
  K=5 from getting just the first of those right.
- **Delta transfer's precondition, without a second camera.** Today advertising
  a segment inventory needs the receiver to display a QR and the sender to scan
  it, which means both devices need cameras and the UI needs a second mode.
- **A cancel that works.** A receiver can currently only stop by looking away.

### What it costs, honestly

- **A dependency whose published robustness number does not survive reading
  the test.** §2.5. That is not a reason to avoid the project; it is a reason
  the acceptance criteria below start with re-measuring.
- **Microphone permission.** rvQR asks for a camera today and explains why; a
  second permission is a real cost in a tool whose pitch is that it needs
  almost nothing, and a microphone prompt reads worse than a camera prompt to
  many people.
- **Ultrasound is not silent, it is inaudible to *some*.** 18–20 kHz is above
  most adult hearing and well within the range of children, some adults, and
  many animals. A device emitting it for minutes is doing something the user
  cannot perceive and should be told about.
- **Acoustic environments vary far more than optical ones.** A quiet room and a
  workshop are different channels; two phones flat on a table and two phones
  held facing each other are different channels.
- **Replay is only bounded, not eliminated.** §2.4's mitigations depend on
  session freshness and counter state being kept correctly; a bug in either
  reopens the hole silently.
- **More concurrent state.** A sender that reacts to feedback has modes; modes
  have transitions; transitions have races. The current sender is a loop, and a
  loop is very hard to get wrong.
- **Nothing is implemented.** No encoder, no decoder, no permission flow, no
  RVU1 frame.

## 4. Acceptance criteria

1. **Re-establish the error tolerance on real hardware first.** Two phones, real
   speakers and microphones, at 0.5 m and 2 m, in a quiet room and with
   background speech. Report the raw symbol error rate and the frame delivery
   rate. Impairments must be ones the decoder can observe — band-limited noise,
   frequency offset, multipath, dropouts — and explicitly **not** sample
   negation. Until this exists, no throughput or reliability claim about the
   acoustic channel may be published.
2. **Latency.** Median receiver → sender control latency under 750 ms and p95
   under 1.5 s at the chosen rate, measured end to end including capture and
   detection, not computed from the bit rate.
3. **Replay is refused.** A recorded control frame replayed into a live session
   is discarded; replayed into a *new* session it is discarded on session id; a
   counter equal to or lower than the highest accepted is discarded. Each of the
   three has its own test.
4. **Bounded authority, demonstrated.** A test drives an adversarial control
   stream — forged ranks, forged completes, forged profiles — and asserts the
   vault contents are unchanged and no artifact is admitted that would not have
   been admitted with the acoustic channel absent.
5. **Optional, provably.** With microphone permission denied and with the device
   muted, a full transfer still completes over the open-loop fountain path, with
   no user-visible error beyond a notice that feedback is unavailable.
6. **The gain is measured as frames saved.** Report slots observed with and
   without the control channel for both demo artifacts at 0%, 20% and 40% loss.
   If the saving is not visible in slot counts, the channel is not earning its
   permission prompt.
7. **Manifest scheduling on request beats the constant**, measured against the
   sweep in [docs/benchmarks.md](../benchmarks.md) §3 at both K=5 and K=81.
8. **Audibility is disclosed.** The UI states that the device will emit sound
   above the normal range of adult hearing, before the microphone is requested.
