# ADR-014: Fountain Code Selection

| Field | Value |
|---|---|
| Status | **Open** — three options stated, no winner asserted |
| Date | 2026-08-03 |
| Scope | Which rateless erasure code the transport uses, and whether interoperability is worth its cost |
| Implementation | `artifacts/fountain.js` exists, passes its tests, and is **not wired into the transport** |
| Related | [ADR-001](./ADR-001-rvqr-optical-transport.md), [ADR-010](./ADR-010-rvqr-acceptance-bar.md), [ADR-024](./ADR-024-rvqr-fleet-swarm.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

The optical link is an erasure channel — a QR symbol either passes its own
Reed–Solomon check and yields exact bytes, or yields nothing
([docs/benchmarks.md](../benchmarks.md), "The channel is an erasure channel") —
and there is no back channel, so a rateless code is the right shape of answer.

rvQR already has one, and it measures well.
[docs/benchmarks.md](../benchmarks.md) §2, over 2,200 decodes at 45% loss with
every result SHA-256 verified: **98.45% of decodes needed exactly K symbols,
100% needed no more than K+1, mean overhead +0.0155**. The codec's author
independently reports 98.20% at exactly K, 99.95% by K+1, 100% by K+2, mean
+0.0185 over 2,000 decodes. The two agree to within sample-size luck. Against
the transport, that is 2.52× fewer slots than indexed chunks at 20% loss and
3.75× at 60% (§1).

**But it interoperates with nothing.** `artifacts/fountain.js` is
RaptorQ-*structured* and deliberately not RFC 6330 conformant: it derives the
per-K′ parameters `(S, H, W, P1)`, the systematic index `J(K′)` and
`Rand[]`/`G_HDPC` rather than using the RFC's published tables, because a
misremembered table yields a subtly broken codec that still appears to work.
Symbol streams from that module decode only with that module.

That was the right call when the only consumer was rvQR's own receiver. It stops
being obviously right once [ADR-024](./ADR-024-rvqr-fleet-swarm.md) proposes
RaptorQ broadcast to a fleet of devices that may not all be running rvQR's
JavaScript.

## 2. Decision

**No winner is asserted, because the evidence to pick one does not exist yet.**
This ADR records the three options, what each buys, and the measurement that
would decide between them. Deciding on the basis of published claims alone would
be exactly the failure [ADR-011](./ADR-011-rvqr-deployment-plane.md) §2.4 sets
out to avoid.

### Option A — keep `artifacts/fountain.js`

**Buys:** a measured 98.45%-at-exactly-K, already written, already tested,
already characterised on both demo payloads, with a decode cost of 3.19 ms at
K=81 and 168 ms at K=800 measured on the test machine. Zero migration cost.
K is capped at 4096 because the solve is O(K²·(K+T)).

**Costs:** interoperates with nothing, in either direction. Every future consumer
must run this JavaScript or a port of it, and a port is a second implementation
of a codec whose parameters are derived rather than tabulated — which is the
precise failure mode its own header warns about. It also blocks
[ADR-024](./ADR-024-rvqr-fleet-swarm.md)'s broadcast tier from using anything
off-the-shelf.

### Option B — adopt Wirehair

**Buys:** Wirehair reports average recovery near **N + 0.02 packets** — that is
the project's published claim, not our measurement — against the roughly 15%
extra frames an LT-style code needs, and it is designed for large block counts
where the Gaussian-elimination cost of option A grows. A maintained C
implementation exists.

**Costs:** it is also not a standard, so "interoperates with nothing" becomes
"interoperates with Wirehair", which is a different dependency rather than
fewer. Its overhead figure is *statistically the same claim* as our measured
+0.0155 mean, so on the evidence available **Wirehair's advantage over our codec
is not demonstrated** — the 15% comparison is against LT codes, which is a
comparison our codec also wins. Adopting it means a WASM build on the receive
path of a page whose promise is that it works from a `file://` URL.

### Option C — become RFC 6330 conformant

**Buys:** real interoperability. RaptorQ is a published standard with published
tables, and a conformant stream can be decoded by any conformant implementation
— which is what a fleet, a partner device, or a hardware wallet-style consumer
would need. It ends the "describe it as RaptorQ-structured, never RaptorQ"
caveat that currently has to appear in every document.

**Costs:** the three things the current implementation derives — Table 2 across
477 K′ values, the systematic index J(K′), and the `Rand[]`/`G_HDPC`
construction — must be tabulated exactly, and getting them subtly wrong produces
a codec that passes its own round-trip tests and fails against everyone else's.
Conformance cannot be established by self-testing; it needs the RFC's test
vectors. There may also be patent considerations around RaptorQ that this
document does not evaluate and that anyone choosing option C must.

### What decides it

A single measurement, on the same harness that produced §2 of the benchmarks:
**reception overhead, decode latency, and memory, for all three, at K ∈ {5, 81,
800, 4096}, on the phone-class budget rather than an M4 Pro.** Plus, for option
C only, a pass against RFC 6330's published test vectors — because that is the
only thing conformance means.

Until that exists, **option A remains in force by default**, since it is what is
written and what everything measured so far describes.

## 3. Consequences

### What this buys

- **The comparison is written down**, so the choice stops being made implicitly
  by whoever wires the transport first.
- **The interoperability question is separated from the performance question.**
  On overhead, all three are close to the floor; the real difference is who else
  can decode the stream, and that is a product decision.

### What it costs, honestly

- **Leaving it open blocks [ADR-024](./ADR-024-rvqr-fleet-swarm.md).** A fleet
  broadcast tier cannot be designed against an undecided codec, and that ADR
  currently assumes RFC 6330.
- **Option A is winning by inertia**, which is a weak reason for a wire-format
  decision that later consumers inherit.
- **All three options share one unmeasured risk:** none of the numbers above
  come from a phone. Decode cost at K=800 is 168 ms on an Apple M4 Pro, and
  [docs/benchmarks.md](../benchmarks.md) §8 puts phones five to ten times slower
  — 0.8 to 1.7 seconds, which is several frame periods.
- **The fountain layer is still not wired into the transport at all**, so this is
  a choice about code nobody is running.

## 4. Acceptance criteria

1. **The three-way comparison is run** on the terms in §2 and lands in `bench/`.
   No option is adopted on published claims alone.
2. **Phone-class decode is measured** for the chosen option at K=800 and at the
   implementation's ceiling, because that is where the O(K²) term bites and
   where the M4 Pro figures mislead.
3. **If option C is chosen, RFC 6330's test vectors pass** — self-consistency is
   not conformance, and the current implementation's own header explains why.
4. **If option A or B is chosen, the non-interoperability is stated** in
   [docs/protocol.md](../protocol.md) and in
   [ADR-024](./ADR-024-rvqr-fleet-swarm.md), which then cannot assume a standard
   broadcast codec.
5. **Whichever is chosen is wired into the transport and re-measured through
   it**, since [docs/benchmarks.md](../benchmarks.md) §3 already showed the
   framing around the codec — the manifest repaint schedule — mattering more than
   the codec did on small objects.
6. **[ADR-010](./ADR-010-rvqr-acceptance-bar.md)'s p95 criterion is met with the
   chosen codec in place**, which §2.3 of that ADR shows is unreachable without
   one.
