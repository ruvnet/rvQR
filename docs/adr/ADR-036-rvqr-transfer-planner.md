# ADR-036: The Transfer Planner — Filter Before Score

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-08-03 |
| Scope | The structure of the thing that picks a transfer strategy: what it may range over, what scores it, and why the safety rules are not terms in the score |
| Value / effort / risk | 4 / 3 / 2 |
| Implementation | **Not inspected for this record.** `artifacts/planner.js` was being written concurrently with this ADR and is deliberately not read here, so nothing below is a claim about what it does. What a planner would range *over* exists and is measured: `chooseDelta` in `artifacts/semdelta.js`, `spanPlan` and `diff` in `artifacts/delta.js`, the v1 and v2 framings in `artifacts/proto2.js`, and `artifacts/fountain.js` |
| Related | [ADR-015](./ADR-015-rvqr-adaptive-control.md), [ADR-013](./ADR-013-rvqr-byte-minimisation.md), [ADR-016](./ADR-016-rvqr-verified-execution.md), [ADR-017](./ADR-017-rvqr-transport-modes.md), [ADR-019](./ADR-019-rvdrop-bulk-transport.md), [ADR-021](./ADR-021-rvqr-device-attestation.md), [ADR-025](./ADR-025-rvqr-zero-copy-pipeline.md), [ADR-027](./ADR-027-rvqr-non-goals.md), [ADR-035](./ADR-035-rvqr-signature-admission.md) |

> This is an **rvQR-local** ADR. Most other files in this directory are mirrored
> from RuVector and keep their upstream numbers; rvQR's own decisions start at
> 001 in a separate numbering space and are the files whose slug begins with
> `rvqr-`. See [README.md](./README.md).

## 1. Context

[ADR-015](./ADR-015-rvqr-adaptive-control.md) decides that something adaptive
chooses the transfer parameters, states the objective **J = 0.45·T + 0.20·E +
0.20·B + 0.15·R**, and states that hard rules always override learning. It does
not say how. "Overrides" is a word, and the difference between a system where
that word is true and one where it is merely intended is a difference in
structure, not in emphasis.

This ADR fixes that structure, and it exists because the obvious implementation
of "override" is the one that does not work.

There is also a working precedent in the tree to build on rather than
re-derive. `chooseDelta` already makes a strategy choice by building both
candidate payloads and comparing their real byte lengths, and
[docs/benchmarks.md](../benchmarks.md) §7 measures it choosing correctly in all
seven scenarios, including the two constructed so the finer strategy loses. It
also measures what that costs: about 49 ms on a 1.13 MB container, under 2 ms on
every other scenario. A planner is that idea widened from two candidates to a
handful, and the cost figure is what makes widening it affordable on a channel
where the transfer itself takes seconds to minutes.

## 2. Decision

### 2.1 The filter runs first, and it is not part of the score

**A hard rule is expressed as a filter over candidates, never as a term in J.**
The planner is two stages with a one-way dependency:

```
candidates → admissible = filter(candidates) → argmax J over admissible
```

`filter` is total, not learned, and returns a subset. The scorer never sees a
candidate the filter rejected, so *the score of a violating candidate is not a
quantity that exists anywhere in the system*. That is the whole property. It is
the same shape as `core.admitArtifact`
([ADR-035](./ADR-035-rvqr-signature-admission.md)) — a pure total function
placed so no other code path can reach around it — one layer up.

The four rules, unchanged from [ADR-015](./ADR-015-rvqr-adaptive-control.md)
§2.3:

| Rule | Source | Evaluated at plan time as |
|---|---|---|
| Trust must pass | [ADR-035](./ADR-035-rvqr-signature-admission.md), [ADR-012](./ADR-012-rvqr-post-quantum-manifest.md) | the verdict the admission function will be given; pending and unknown reject |
| Projected peak working memory under 128 MiB | [ADR-025](./ADR-025-rvqr-zero-copy-pipeline.md) | **a projection**, computed from the candidate's chunk size, stream count and buffer plan |
| Radio use satisfies policy | [ADR-017](./ADR-017-rvqr-transport-modes.md) | the mode in force; strict admits no radio candidate at all |
| Commit requires complete verification | [ADR-016](./ADR-016-rvqr-verified-execution.md) | rejects any candidate whose completion path writes before verifying |

**If `filter` returns the empty set, the planner returns no plan and the
transfer does not start.** It never falls back to the best rejected candidate,
and it never relaxes a rule to make the set non-empty. An empty admissible set is
a refusal with a named rule, which is a debuggable outcome; a relaxed rule is an
undebuggable one.

The memory row is the one that needs care, because it is the only rule the
planner evaluates against a number it computed rather than a verdict it was
handed. §9 measures the current pipeline at **87.9 MiB peak RSS on
`standalone.html` (572,166 B), of which 39.9 MiB is the pipeline above an empty
Node process** — inside the 128 MiB budget, so on today's artifacts this rule
binds nothing. It is also the rule most likely to be wrong later, because §9
measures a Node process rather than a browser tab, and because the same section
measures the receiver at **2.78 payload copies for v1 and 2.56 for v2 against
ADR-025's budget of fewer than two**. A planner that projects memory from a copy
model the pipeline already violates is projecting from the wrong model. The
projection is labelled as one everywhere it appears, and the acceptance criteria
in §4 require it to be validated against the probe rather than trusted.

### 2.2 Why a penalty term is not a substitute

The tempting alternative is one number: fold each rule in as a large negative
weight, keep a single scoring function, and call the largest penalty an
override. It is tempting because it is less code, and it is wrong for a reason
that is arithmetic rather than stylistic.

**Any finite penalty is a price, and a scorer's job is to find candidates worth
paying it.** Write the score as `J − λ·violation`. The claim "λ is large enough"
is a claim about the range of the *other* terms — and the other terms are
learned, so their range moves as the policy learns. There is no λ that is
provably larger than every future bonus, and the only λ that would be is ∞,
which is not a number in a weighted sum. It is a filter written in the wrong
notation.

Three further problems, each independent of the first:

- **The failure is silent and gradual.** Nothing announces the moment a learned
  term's range grows past λ. The first symptom is a transfer that violated a
  safety rule and scored well doing it.
- **The property becomes untestable.** With a filter, the assertion is "no
  returned plan violates a rule", checked directly. With a penalty, the
  equivalent assertion is "no assignment of learned weights makes a violating
  candidate win", which is a search over an unbounded space.
  [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.2 asks for exactly the first
  test — an adversarial driver that asserts the gate refuses every violating
  configuration *with the policy's score irrelevant to the outcome*. "Score
  irrelevant" is not a thing a penalty term can be.
- **Summing requires normalisation, and normalisation caps the penalty.** J's
  four terms have different units and must be scaled to a common range before
  they can be added at all. A penalty inside that sum is bounded by construction
  — which is to say the notation that makes J well-formed is the same notation
  that makes λ finite.

[ADR-027](./ADR-027-rvqr-non-goals.md) §2.6 is the non-goal with no falsifier:
*a learned policy that can override a trust gate is not a policy, it is a
vulnerability.* A safety property expressed as a number is a safety property
someone can outbid. This section is that non-goal turned into a structural
requirement rather than restated.

### 2.3 The weights are a judgement, and are recorded as one

**0.45 / 0.20 / 0.20 / 0.15 is a judgement. It was not fitted to anything.** No
measurement in this repository produces those four numbers, and none could
today: [docs/benchmarks.md](../benchmarks.md) §16 records that there is no
camera, no screen and no optics behind any figure in the document, and §17
records **P, the decode success probability, as not measurable here at all**.
They are a starting point, exactly as
[ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.2 says — "a starting point to
be tuned against measurement, not derived constants" — and this ADR's only
addition is to refuse to let them harden by repetition.

The reasoning behind the shape, offered as reasoning and not as evidence:

- **T dominates because the channel is slow enough that a person is waiting.**
  rvQR measures 2.44 KB/s at its defaults and 9.53 KB/s at its ceiling, and the
  40 KB demo module takes 15.2 seconds at version 19-L and 5 fps under v1
  uncompressed (§10). Seconds are the unit the user experiences.
- **R is small partly because it is already inside T.** §10 measures the
  fountain transports within 0.99×–1.02× of exact 1/P scaling across seven loss
  rates, which means on a rateless transport a reliability loss *is* a time
  loss and is already counted in T. That argument does not hold for v1's indexed
  cycling, which pays **up to 3.90× more slots than 1/P scaling predicts at 60%
  loss** — so R's weight is arguably too small for one of the two framings the
  planner can pick. This is a rationalisation of a chosen constant, offered as
  one.
- **E and B carry 0.40 of the objective between them and nothing in this
  repository can evaluate either.** There is no energy or battery measurement
  anywhere in `bench/`. That is the sharpest honest thing to say about these
  weights: two fifths of the objective is currently unmeasurable, so the
  practical planner ranks on T and R and the weights on E and B are not yet
  doing work.

**What would change them**, stated so the question is answerable rather than
perennial:

1. A fit against measured J on real device pairs across the condition matrix,
   which requires the optics and the hardware that
   [ADR-018](./ADR-018-rvqr-device-physics.md) says nobody has yet.
2. Any energy or battery instrumentation at all, which would move E and B from
   asserted to measured and could reasonably move their weights in either
   direction.
3. Evidence that users rank a slower, cheaper transfer above a faster, costlier
   one — which is a product question, not a benchmark, and would lower T.

Until one of those lands, these are four numbers in a document, and the ADR says
so rather than presenting them as a result.

### 2.4 The letters currently mean two different things, and that must be fixed

This is a contradiction found while writing this record, reported rather than
smoothed.

| Source | T | E | B | R |
|---|---|---|---|---|
| [ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.2 | throughput | energy | battery | reliability |
| This ADR | time | energy | bytes | risk |

Same formula, same weights, four terms whose expansions disagree in three
places. A weighted sum whose terms are ambiguous is a weighted sum nobody can
reproduce, and this is the same class of defect as the codec identifier that
does not determine the decoder ([ADR-027](./ADR-027-rvqr-non-goals.md) §2.2).
**This ADR adopts the second row**, for reasons that are measurable rather than
editorial:

- **Time and throughput are not the same ordering**, because the planner also
  chooses how many bytes to send. §7 measures the 1.13 MB container moving
  **40,285 bytes semantically against 1,125,630 bytes span-wise**. A candidate
  that sends 40,285 bytes at a lower rate beats one that sends 1,125,630 bytes
  at a higher rate, and only a time-shaped T ranks them that way. Ranking on
  throughput would prefer the fast full transfer.
- **Bytes and battery keep the four terms independent; energy and battery do
  not.** Energy and battery are close to the same physical quantity measured
  twice, which would put 0.40 of the weight on one thing. Bytes-on-the-wire is
  separately meaningful on a metered or shared link and in the fleet case, and
  it is the one term this repository can already compute exactly.
- **Risk needs a sign that reliability does not.** J adds all four terms with
  positive weights, so every term must be a quantity where larger is better.
  Risk is not. It enters as **R = 1 − normalised risk**, and writing the letter
  without that definition is how a term ends up added when it should be
  subtracted.

**Resolving the divergence means amending one of the two documents, not letting
both stand.** That amendment has been made: ADR-015 §2.2 now carries a note
naming this section as authoritative and stating the three substitutions, so a
reader arriving at the older record — the likelier entry point — is told which
reading governs instead of silently taking the wrong one. The original sentence
is left in place beneath the note rather than rewritten, because a decision
record that quietly changes what it decided is no longer a record.

### 2.5 What the planner ranges over, and how much of it is built rather than estimated

The candidate space is the enumerated cross-product of the axes below. It is
small on purpose: [ADR-015](./ADR-015-rvqr-adaptive-control.md) §2.2's argument
for a bounded stage first — an enumerated set can be exhaustively validated and
a continuous one cannot — applies to the planner's candidate list as well as to
its policy.

| Axis | Values | Cost model |
|---|---|---|
| Delta strategy | full / span / semantic | **built and measured**, per `chooseDelta` |
| Codec | none / Brotli / Zstd, per [ADR-003](./ADR-003-rvqr-adaptive-compression.md) | **built and measured** — §2 shows why estimating is unsafe |
| Framing | v1 JSON / v2 armoured | estimated exactly: a table lookup |
| Symbol version and rate | the measured blur-safe set | estimated exactly: capacity table × fps |
| Transport | optical / rvDrop, where policy admits it | filtered before scoring ([ADR-017](./ADR-017-rvqr-transport-modes.md)) |

**Build and measure where estimation is known to be wrong; estimate only where
the estimate is a table lookup.** §2 measures the break-even for compression as
content-dependent across two orders of magnitude — text clears the 8% envelope
gate at 64–256 bytes while **synthetic float32 vectors do not clear it until
6,144 bytes and actively lose at or below 128 bytes** — and float vectors are
what an RVF container is mostly made of. A size-based codec heuristic would be
wrong for exactly the payload this project carries. The delta axis has the same
property and the same remedy, already implemented.

Building costs what §7 measures: about 15 ms to plan, 27 ms to inventory and
49 ms in `chooseDelta` on the 1.13 MB container, roughly 120 ms for the whole
plan-inventory-choose-apply sequence, and about 4 ms for that sequence on the
41 KB WASM container. Against a transfer measured in seconds to minutes, an
exhaustive build over a handful of candidates is affordable — but the cost is a
product, not a sum, so the axes that are built stay two and the rest stay table
lookups.

One consequence worth stating because a fixed constant is provably wrong: §5
measures the optimal manifest repaint interval at **4 slots at K=5 and 32 slots
at K=81**, with `clamp(K/2, 4, 32)` matching both ends. That is the smallest
concrete thing a planner buys, and it is a property of the harness's framing
choice rather than of `artifacts/fountain.js`. (ADR-015 §1 cites this
measurement as benchmarks §3; in the current document it is §5.)

### 2.6 What this does not do

Recorded here rather than left to inference, because each is a thing a planner
looks like it should do.

- **It does not learn compression schemes.** Codec choice is a selection among
  named, standardised codecs with explicit identifiers, per
  [ADR-027](./ADR-027-rvqr-non-goals.md) §2.2. A learned codec is a model both
  ends must hold at matching versions forever, and the receiver is by
  construction offline and cannot fetch it — which turns a decompression failure
  into permanent data loss for an artifact that has already crossed the gap. The
  planner picks *between* codecs; it never invents one.
- **It does not stripe across paths.** [ADR-027](./ADR-027-rvqr-non-goals.md)
  §2.3 and [ADR-019](./ADR-019-rvdrop-bulk-transport.md) §2.1 both settle this:
  the IETF multipath QUIC extension is still completing standardisation and
  **deliberately does not define path scheduling**, leaving it to
  implementations, so adopting it means taking a non-final wire format *and*
  inventing the scheduler the draft declined to specify — on paths whose rates
  differ by orders of magnitude, which is where naive schedulers behave worst.
  What comes first is **path racing, single-path selection, failover and
  resumable chunks**. The planner selects one path; it does not schedule across
  several.
- **It does not consume attestation as authorization.**
  [ADR-021](./ADR-021-rvqr-device-attestation.md) states the invariant:
  **attestation is evidence, not authorization.** A measured boot state is an
  input to the filter's evidence, never a substitute for the capability policy,
  which stays authoritative. A planner that treated a good attestation as
  permission would be the penalty-term mistake in §2.2 wearing different clothes
  — a trust decision reached by accumulating favourable signals.
- **It does not pick the fountain codec.**
  [ADR-014](./ADR-014-rvqr-fountain-selection.md) is Open with three candidates
  and no winner asserted, because the evidence to choose does not exist. The
  planner ranges over what ships. Wirehair's N+0.02 reception overhead, which
  appears in that comparison, is **Wirehair's own published claim** and is
  unrelated to this repository's measured +0.0155 beyond both being small.

## 3. Consequences

### What this buys

- **The safety property is checkable in one assertion.** "No returned plan
  violates a rule" is a test over the planner's output, not a search over weight
  space, which is what makes [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.2
  a criterion someone can actually satisfy.
- **The weights can be wrong without being dangerous.** Getting 0.45 wrong costs
  time. Getting a penalty coefficient wrong costs the invariant. Separating the
  two means the tuning that will certainly happen touches only the first.
- **Refusals name a rule.** An empty admissible set reports which filter emptied
  it, which is the difference between "the planner declined, radio policy" and a
  transfer that silently did something else.
- **It composes with what is measured.** The delta axis is `chooseDelta`
  unchanged, and its 2.41×–27.94× spread across seven byte-exact scenarios is
  the largest single lever the planner has access to — larger than the 3.17×
  §10 measures from framing and compression combined.

### What it costs, honestly

- **Two-stage evaluation is more code than one score**, and the filter has to be
  reachable from every path that can start a transfer or it is decorative. A
  filter that one code path skips is worse than no filter, for the reason
  [ADR-035](./ADR-035-rvqr-signature-admission.md) gives about advisory
  controls: it manufactures confidence it does not supply.
- **The memory rule is enforced against a projection.** Every other rule is a
  verdict handed to the planner; this one is arithmetic the planner does itself,
  over a copy model that §9 already measures the pipeline violating at 2.78× and
  2.56× against a budget of fewer than two. It is the rule most likely to be
  confidently wrong.
- **0.40 of the objective is currently unevaluable**, so in practice the planner
  ranks on two of four terms and the other two are structure waiting for
  instrumentation.
- **Building candidates costs a product, not a sum.** Two built axes at three
  values each is already six real payload constructions, and §7's 49 ms is one
  of them on one container.
- **It is another thing that cannot be validated offline.** Its value shows up
  in conditions the harness does not model — the same objection
  [ADR-015](./ADR-015-rvqr-adaptive-control.md) records about itself, inherited
  in full.

## 4. The measured defect this inherits, and where it actually lives

The planner inherits a measured cost from the layer beneath it, and being exact
about which function is at fault is the point of recording it here.

`semanticInventory` in `artifacts/semdelta.js` builds a unit table
**unconditionally**, for every container, before anyone knows what changed. The
receiver therefore pays for unit granularity even when the sender will decline
it. §7 measures the bill arriving: on the scenario where the demo container's
vector dimension is halved 16 → 8, every record is rewritten, and summing both
hops the semantic path costs **2,177 B against the span path's 1,308 B**. The
semantic machinery loses overall on that scenario. The inventory is larger in
every case measured — **667 B against 134 B for the demo container, 44,235 B
against 190 B for the 1.13 MB container**, larger by between 402 B and 44,045 B
across the six scenarios with a base inventory.

**`chooseDelta` is not at fault, and folding the inventory into its comparison
would be a bug.** It receives the receiver's inventory as an argument: by the
time it runs, that hop has already crossed the wire and its cost is sunk.
Comparing payloads alone is the *correct* comparison at that call site, because
the inventory's size cannot change which of the two remaining payloads is
cheaper to send. Charging it to both candidates equally changes no ordering;
charging it to one is a sunk-cost error. §7 confirms the narrower question is
answered correctly: on all six scenarios with a base inventory, the payload-only
comparison reaches the same verdict as the two-hop total — **which is a property
of those seven scenarios and not a proof.**

**The missing decision belongs upstream, at the receiver.** No granularity rule
exists anywhere in the module. A receiver cannot know what changed, but it can
bound what a unit table could possibly save given the container it holds, and it
currently does not try. That is a decision about whether to spend the bytes,
made before they are spent — which makes it a planning decision at the
receiver's hop, not a scoring decision at the sender's. The planner this ADR
describes does not fix it and must not pretend to: a sender-side chooser cannot
un-send an inventory. Recorded so the fix lands where the cost is incurred.

## 5. Acceptance criteria

1. **No plan the planner returns violates any of the four rules**, asserted by
   an adversarial test that drives the scorer toward each violation in turn and
   checks the returned plan, with the score of the rejected candidates
   irrelevant to the assertion. This is
   [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.2 made checkable.
2. **The filter is total and the empty result is a refusal.** A test constructs
   a situation where every candidate is inadmissible and asserts the planner
   returns no plan and names the rule, rather than returning the best rejected
   candidate.
3. **No hard rule appears as a coefficient anywhere.** Asserted structurally —
   the scoring function's inputs do not include a violation indicator, so there
   is no term for a weight to attach to.
4. **The memory projection is validated against the probe**, not asserted:
   `node --expose-gc bench/lib/memprobe.mjs` measures what the projection
   predicted, and the discrepancy is reported. A projection nobody checks is an
   assumption with better typography.
5. **Every plan is logged with its inputs, its candidate set, its scores and the
   filter's verdict per candidate**, and is replayable offline — the same
   requirement as [ADR-015](./ADR-015-rvqr-adaptive-control.md) §4.3, extended
   to the rejected candidates, because "why did it not choose X" is the question
   that actually gets asked.
6. **The planner beats every fixed default on measured J across the condition
   matrix, or it is not adopted.** Specifically it picks 4-slot manifest repaint
   at K=5 and 32-slot at K=81, the case §5 already proved a constant gets wrong.
7. **The weights are carried as data with their provenance**, marked as a
   judgement rather than a measurement, so a future fit replaces a labelled
   placeholder instead of arguing with a constant that has acquired the
   authority of age.
8. **A receiver-side granularity rule is specified before the semantic
   inventory is enabled by default**, per §4. Until it exists, the measured
   2,177 B against 1,308 B is a cost this system pays without deciding to.
