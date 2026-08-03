# ADR-027: Non-Goals

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | Things this programme has decided not to do, recorded so they are not revisited by default |
| Related | [ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

Each of the following is a reasonable-sounding idea that someone will propose
again — because in isolation each *is* reasonable. Recording them as decisions
rather than as absences means the next proposal starts from "here is why that was
rejected and what would change it", instead of from zero.

A non-goal is not a prohibition. It is a default that requires evidence to
overturn, and each entry names the evidence.

## 2. Decisions

### 2.1 Ultrasonic bulk transfer — no

Sound is a **control** channel. Measured at the defaults of the encoder rvQR
would build on, it delivers about **33 useful bit/s**
([ADR-007](./ADR-007-rvqr-ultrasonic-control-channel.md)), and the best
consumer-hardware result in the literature is **94.5 raw bit/s** — Google's
robust near-ultrasound system,
[doi:10.1109/TMM.2017.2766049](https://doi.org/10.1109/TMM.2017.2766049), their
measurement.

That figure is the reason this is a decision rather than an engineering target:
the *state of the art on consumer hardware*, from a team with considerable
resources, is under 100 bit/s. Against that, rvQR's measured optical ceiling of
9.53 KB/s is roughly **three orders of magnitude** faster and WiFi is **six to
seven**. Near-ultrasound is a proximity token and a control channel, and
treating it as a data lane is the striping error
[ADR-019](./ADR-019-rvdrop-bulk-transport.md) §2.1 exists to prevent.

**What would change this:** a measured acoustic channel above roughly 10 kbit/s
on unmodified phone hardware. Nothing in the literature suggests that is close.

### 2.2 Arbitrary learned compression — no

Compression stays on named, standardised codecs with explicit identifiers:
Zstd ([RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.html)) and Brotli
([RFC 7932](https://www.rfc-editor.org/rfc/rfc7932.html)), per
[ADR-003](./ADR-003-rvqr-adaptive-compression.md).

A learned codec is a model that both ends must hold, at matching versions,
forever — because an artifact compressed by model v3 is undecodable to a receiver
holding v2, and the receiver is by construction offline and cannot fetch it. That
turns a decompression failure into permanent data loss for an artifact that has
already crossed the gap.

It also reintroduces exactly the defect this set keeps documenting: a codec
identifier that does not fully determine the decoder. `SEED_COMPRESSED`
([ADR-002](./ADR-002-rvqr-binary-frame-protocol.md) §1) and `Custom = 3`
([ADR-003](./ADR-003-rvqr-adaptive-compression.md) §2.1) are both instances of
that, and a learned model is the same failure with a version number attached.

**What would change this:** a measured ratio substantially beyond the 2.46–3.54×
already available on our own artifacts, *plus* a model-distribution story that
works for a device that has been offline for a year.

### 2.3 Uncontrolled multipath striping — no

v1 does **path racing, single-path selection, failover and resumable chunks**.
Not simultaneous striping across paths.

The IETF multipath QUIC extension is
[still completing standardisation](https://datatracker.ietf.org/doc/draft-ietf-quic-multipath/)
and deliberately **does not define path scheduling**, leaving it to
implementations. Adopting it now means taking a non-final wire format *and*
inventing the scheduler the draft declined to specify — on paths whose rates
differ by orders of magnitude ([ADR-019](./ADR-019-rvdrop-bulk-transport.md)
§2.1), which is where naive schedulers behave worst.

Application-level resumable chunks give most of the benefit — a failed path costs
one chunk — at a fraction of the risk.

**What would change this:** the draft reaching RFC, plus a scheduler with
measured behaviour on heterogeneous paths.

### 2.4 Interoperating with Apple AirDrop — no

[ADR-019](./ADR-019-rvdrop-bulk-transport.md) is AirDrop-*class*, not
AirDrop-compatible. rvDrop provides sovereign identity, post-quantum protection
and signed activation, none of which AirDrop has and none of which survive
speaking its protocol. The claim is never made and the name is not used in a way
that implies it.

### 2.5 Making rvQR competitive on raw optical throughput — no

[ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.4 and
[ADR-026](./ADR-026-rvqr-optical-turbo.md) §2.2 both record this: the optical
layer is not where the project is defensible, rvQR is roughly 13× behind
Decimen's published figure, and closing that gap wins nothing that matters. The
optical work is justified by strict mode
([ADR-017](./ADR-017-rvqr-transport-modes.md)), not by the comparison.

### 2.6 Learned policies with authority over trust — no

Stated in [ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.3 and repeated here
because it is the one non-goal that is a safety property rather than a priority
call: **a learned policy that can override a trust gate is not a policy, it is a
vulnerability.** No evidence overturns this one.

## 3. Consequences

### What this buys

- **Proposals start from a written position**, which is cheaper than
  re-litigating.
- **Each entry names its own falsifier**, so the list is arguable rather than
  dogmatic — except §2.6, which is deliberately not.

### What it costs, honestly

- **Written-down non-goals ossify.** The measurements behind §2.1 and §2.3 will
  age, and nobody is assigned to notice. The falsifiers are the mitigation and
  they are not automatic.
- **§2.5 is a strategic judgement, not a measurement**, and it could be wrong if
  a customer's requirement turns out to be raw optical rate.
- **A non-goals list can be used to refuse thinking.** It is a default, and the
  falsifier clauses are there to be used.

## 4. Acceptance criteria

1. **Every entry except §2.6 names the evidence that would overturn it**, and
   those falsifiers are stated in measurable terms.
2. **Reversal happens by amending this ADR**, not by a decision made elsewhere —
   so the record shows what changed and why.
3. **§2.6 is enforced in code**, not only recorded here — see
   [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.2 and §4.6.
4. **The list is reviewed when its cited measurements are superseded**,
   particularly §2.1's acoustic figures and §2.3's draft status.
