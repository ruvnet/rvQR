# rvQR benchmarks

What the optical channel actually does, measured rather than asserted, and how
it compares to the prior art in screen-to-camera data transfer.

Every number below is either **measured** by the harness in [`bench/`](../bench/)
— in which case the method and the seed are given — or **cited** to a source,
in which case it is somebody else's claim and is labelled as theirs. A handful
are **projections**, which is to say arithmetic; those say so in the same
sentence. There are no numbers here that are none of those three things.

---

## Headline findings

**1. The fountain layer is worth 2×–3.8× under frame loss, and costs 5% when
there is none.** Transferring the 40 KB demo WASM module at the app's default
512 bytes per frame, the receiver must observe 800 frame slots at 60% loss with
rvQR v1's indexed chunks, and 214 with `artifacts/fountain.js`. At 0% loss the
fountain is *slower* — 86 slots against 82 — because it repaints the manifest
periodically and v1 gets it for free as frame zero.

**2. The shipped fountain codec's reception overhead is essentially zero, and
an independent reproduction agrees with its author to within noise.** Measured
at the codec with no framing in the way — 2,200 decodes, K from 4 to 800, 45%
loss, every result SHA-256 verified — **98.45% of decodes needed exactly K
symbols, 100% needed no more than K+1, mean overhead +0.0155, worst case +1.**
`fountain.js`'s author independently reports 98.20% / 99.95% by K+1 / 100% by
K+2, mean +0.0185, max +2 over 2,000 decodes. The two agree; the only visible
difference is that their sample caught one +2 event and ours caught none, which
is what sample-size luck looks like at this rate. For scale, a textbook LT code
at K=81 needs 44% overhead, which the same harness measures directly.

**3. On small objects the fountain currently loses, and the coding is not the
reason — the manifest schedule is.** For the 2304-byte demo container (K=5) the
fountain needs *more* slots than v1 from 30% loss upward on the mean, and its
p95 is worse from 10% upward: 101 slots against 59 at 60% loss. The cause is
that a receiver which has all five symbols still cannot finish until a manifest
arrives, and the harness's fountain stream repaints one only every 20 slots. A
sweep over the repaint interval fixes it: at K=5, repainting every 4 slots cuts
the 60%-loss p95 from 101 slots to 30.

**4. rvQR's throughput is roughly 13× below the best comparable browser tool,
and our own decode measurements say that gap is a policy choice, not a compute
limit.** rvQR moves a measured 9.53 KB/s at its ceiling settings. Decimen
Optical Transfer, the closest direct comparator, reports 128 KB/s phone-to-phone
in its README. The difference is almost entirely that rvQR caps frames at 1024
bytes and 10 fps while Decimen uses 2953-byte version-40 symbols at 60 fps.
Decoding one rvQR frame from a clean 1280×720 image costs 10.7 ms on the test
machine, which leaves a great deal of headroom at 10 fps.

**5. The README's own performance claims check out.** It says the 40 KB demo
takes "about 16 seconds" at 5 fps and that the app moves "2.5 KB/s at the
defaults and 10 KB/s flat out". Measured: 82 frames, 16.4 seconds, 2.44 KB/s
goodput at the defaults and 9.53 KB/s at the ceiling. The screenshot caption
"frame 19 / 82 · QR version 19" is also exactly right.

---

## Reproducing this

```bash
# Everything, as reported here.
node bench/index.mjs --trials 500 --seed 20260802 --json bench/results/full.json

# One suite at a time.
node bench/index.mjs --suite loss       # baseline vs fountain under frame loss
node bench/index.mjs --suite overhead   # reception overhead at the codec
node bench/index.mjs --suite payloads   # the two real demo artifacts
node bench/index.mjs --suite delta      # delta transfer end to end
node bench/index.mjs --suite qr         # QR encode and decode cost

# A fast pass for checking the harness still runs (25 trials, noisy).
node bench/index.mjs --quick
```

The harness makes no network requests, reads nothing outside the repository,
and takes about 90 seconds for the full 500-trial run. It prints a markdown
report on stdout and optionally writes the raw per-cell statistics as JSON.

**Machine and versions used for every measured number in this document:**

| | |
|---|---|
| Node | v22.22.1 |
| V8 | 12.4.254.21-node.35 |
| Platform | Darwin 25.1.0 arm64 |
| CPU | Apple M4 Pro ×12 |
| Memory | 48 GB |
| Seed | 20260802 |
| Trials per cell | 500 (250 for the burst channel) |

Frame counts, slot counts and overhead figures are machine-independent: they
are determined by the seed and will reproduce exactly anywhere. Millisecond
figures are not, and an Apple M4 Pro is several times faster at JavaScript than
the phones this app is designed for.

---

## Methodology

### The channel is an erasure channel

A QR symbol either decodes or it does not. If enough modules are misread the
symbol fails its own Reed–Solomon check and the decoder returns nothing; it does
not return wrong bytes. So the optical link is an *erasure* channel, not a noisy
one, which is exactly the setting fountain codes were designed for.

The harness models it as a slotted channel. One **slot** is one frame period —
one symbol painted on the sender's screen, whether or not the camera got it.
Slots are the metric that matters to a person holding a phone: slots times the
frame period is how long they have to hold still. Two models are used:

- **iid** — each slot is dropped independently with probability *p*. The
  textbook case, and the one with a closed form to check the simulation against.
- **Gilbert** — a two-state burst model, average loss rate *p*, mean burst
  length 4 frames. Real camera loss clusters: a hand shakes, autofocus hunts,
  the phone is moved.

### What is real code and what is not

| Component | Status |
|---|---|
| rvQR v1 sender and receiver | **Real.** The baseline transport calls `artifacts/core.js` for frame construction, parsing, reassembly and SHA-256 verification. It is not a model of v1; it is v1. |
| Fountain codec | **Real.** `artifacts/fountain.js`, the systematic GF(256) codec, measured directly. See the conformance note below before reading any number about it. |
| Delta transfer | **Real.** `artifacts/delta.js` driven end to end: inventory, diff, payload build, apply. |
| QR encoder | **Real.** `artifacts/vendor/qrcode.js`. |
| QR decoder | **Real.** `artifacts/vendor/qrdecode.js`, the JS fallback decoder. |
| Reference codecs (`lt`, `rlf`, `rlf-sys`) | **Harness-owned**, in `bench/lib/fountain-ref.mjs`. Present only as reference points to score the shipped codec against — see below. |
| Camera, screen, optics | **Not modelled at all.** See "Threats to validity". |

### What `artifacts/fountain.js` is, and what it is not

Everywhere this report says "the shipped fountain", it means a codec that is
**RaptorQ-structured, not RaptorQ**. It borrows RFC 6330's architecture — the
`A = [LDPC | HDPC | LT]` block layout, the circulant `G_LDPC,1`, the tuple
shape, the degree distribution's shape and cut points — but derives three things
the RFC pins down with published tables: the per-K′ parameters `(S, H, W, P1)`,
the systematic index `J(K′)`, and `Rand[]`/`G_HDPC`. Its own header says so.

The consequence that matters for this document: **symbol streams from this
module decode only with this module.** It will not interoperate with an RFC 6330
codec, and no measurement here tests or implies that it would. Where the
comparison table sets it beside txqr — which uses a real fountain library,
`google/gofountain` — the two are alike in *scheme* and not at all in *wire
format*. Nothing in this report should be read as a claim of conformance, and
the phrases "RFC 6330" and unqualified "RaptorQ" are never used for it.

Where RaptorQ's *published* behaviour appears below, it is as an external
yardstick for how good a rateless erasure code can be, in the same way the
reference codecs are internal yardsticks. It is not a statement about what rvQR
ships.

### The three reference codecs

They exist to bracket the shipped one:

- **`lt`** — Luby Transform with the robust soliton distribution and a peeling
  decoder ([Luby, "LT Codes", FOCS 2002](https://doi.org/10.1109/SFCS.2002.1181950)).
  Poor at small block sizes, so it is a *pessimistic* reference.
- **`rlf`** — random linear fountain over GF(2) with Gaussian elimination.
  Near the information-theoretic floor for reception overhead, so it is an
  *optimistic* reference. Its decoding is O(K³/word), so it is not a reference
  for speed.
- **`rlf-sys`** — the same, made systematic: symbol IDs 0…K−1 are the source
  symbols. The closest structural analogue to what rvQR ships.

A correct fountain layer should land between `lt` and `rlf` on overhead. The
shipped one lands *at or slightly better than* `rlf`.

### Every trial is verified, not just completed

A trial is only counted if the reconstructed bytes hash to the manifest's
SHA-256. Across the 103 cells in the full run — every codec, every loss rate,
both channel models, both payloads, and the manifest sweep — there were **zero
failures to complete within the slot cap and zero completions that failed
verification**. All four delta cases reconstructed byte-identical containers.

### Two passes per trial

Each trial runs the slot pattern once to find out how many slots the receiver
needed and which frames arrived, then replays only the delivered frames into a
fresh receiver with a clock around it. That keeps sender-side work out of the
decode timing and per-call timer overhead out of the slot counting. Receiver
construction is inside the timed region, because for the shipped fountain that
means inserting the LDPC and HDPC constraint rows, which is real work.

---

## 1. Baseline versus fountain under loss

Payload: `artifacts/demo/rvf_wasm_bg.wasm`, 40,989 bytes, 512 bytes per frame.
Baseline needs 82 distinct frames; the fountain block is K=81 symbols.
Independent (iid) erasures, 500 trials per cell.

### Frame slots the receiver must observe — mean / p95

| transport | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 / 82 | 193 / 283 | 271 / 389 | 357 / 532 | 452 / 696 | 596 / 885 | 800 / 1156 |
| **fountain (shipped)** | **86 / 86** | **95 / 102** | **108 / 116** | **122 / 135** | **142 / 159** | **171 / 196** | **214 / 245** |
| fountain (`rlf-sys`, reference) | 86 / 86 | 97 / 104 | 110 / 119 | 124 / 137 | 145 / 165 | 175 / 199 | 217 / 249 |
| fountain (`rlf`, reference) | 87 / 87 | 97 / 105 | 110 / 119 | 124 / 137 | 145 / 164 | 175 / 200 | 218 / 249 |
| fountain (`lt`, reference) | 124 / 124 | 139 / 164 | 158 / 179 | 178 / 213 | 204 / 243 | 245 / 299 | 308 / 391 |

### Speedup, shipped fountain over rvQR v1

| loss | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| iid channel | 0.95× | 2.03× | 2.52× | 2.92× | 3.18× | 3.47× | 3.75× |
| burst channel (mean burst 4) | 0.95× | 1.62× | 2.12× | 2.49× | 2.97× | 3.25× | 3.71× |

The speedup grows with loss and does not saturate in the measured range. It is
slightly smaller under bursts at low loss, because a burst that lands on a
contiguous run of indices is *easier* for a cyclic sender to repair on the next
pass than the same number of scattered losses would be — the baseline benefits
from clustering more than the fountain does.

**Why the baseline degrades the way it does.** rvQR v1 cycles through a fixed
list, so a frame the receiver missed can only be replaced by that same frame
coming round again. Every distinct index must survive at least one pass, so the
number of passes is the maximum of 82 geometric variables — it grows like
log(K)/log(1/p). At 60% loss that is roughly ten passes. The classic
coupon-collector bound for a sender emitting *random* indices would be
K·H_K ≈ 409 deliveries; the cyclic sender does better than that but still pays
the same log-K factor. A fountain pays no such factor: any K interchangeable
symbols will do.

### The shape of it

```
  800 |                                                     .o
      |                                                   ..
      |                                                 ..
      |                                               ..
      |                                            .o.
      |                                         ...
      |                                      ...
      |                                  ..o.
  400 |                              ....
      |                         ..o..
      |                     ....
      |                ..o..
      |            ....                                  ....*
      |       ..o..                             ....*....
      |   ....                ....*........*....
      |*........*........*....
      |
    0 |
      +-------------------------------------------------------
       0%      10%      20%      30%      40%      50%      60%
       frame loss rate

  o = rvQR v1 (indexed chunks)
  * = fountain (shipped)
  y axis: mean frame slots observed
```

The baseline curves upward because it is fighting a coupon-collector problem
that gets worse as loss rises. The fountain line is close to the hyperbola
`K/(1−p)` — the number of slots it takes to deliver K frames through a channel
that drops a fraction *p* of them — which is the floor for any scheme.

### Reception overhead

Two different things get called "overhead" here and the report keeps them apart.

**Coding overhead** is what the code costs: payload frames the receiver had to
see beyond the minimum *at the moment it could first reconstruct*. Mean extra
frames per transfer:

| transport | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| rvQR v1 | 0.00 | 131.94 | 187.08 | 235.05 |
| **fountain (shipped)** | **0.000** | **0.004** | **0.004** | **0.004** |
| `rlf-sys` (reference) | 0.00 | 1.58 | 1.80 | 1.45 |
| `rlf` (reference) | 1.00 | 1.48 | 1.62 | 1.71 |
| `lt` (reference) | 36.00 | 38.07 | 35.57 | 36.09 |

Across all 3,500 iid trials at K=81, the shipped codec needed zero extra symbols
in 3,485 and exactly one in the remaining 15. No trial anywhere in the run needed
two. The reference codecs bracket it exactly as
predicted: the near-optimal random linear fountain costs ~1.5 symbols, and a
textbook LT code costs 36.

**Finishing overhead** is what the *transport* costs: frames seen beyond the
minimum by the time the transfer actually completed, which includes symbols that
arrived while the receiver held full rank but was still waiting for a manifest.
For the shipped fountain at K=81 the two are almost identical, but on a small
object they diverge violently — see section 3. An earlier draft of this report
conflated them and reported outliers of +6 and +11 symbols as coding overhead;
they were manifest waits, and the corrected figure is +1.

### Receiver wall-clock, cold start to verified payload (mean ms, Apple M4 Pro)

| transport | 0% | 30% | 60% |
|---|---|---|---|
| rvQR v1 | 0.31 | 0.56 | 0.67 |
| fountain (shipped) | 2.85 | 2.76 | 2.72 |
| `rlf-sys` (reference) | 0.31 | 0.62 | 0.93 |
| `lt` (reference) | 0.74 | 0.74 | 0.75 |

The fountain costs about 2.5 ms more than plain reassembly for a 40 KB object,
and that cost is flat in the loss rate — the Gaussian elimination runs over the
same L×L system regardless of which symbols arrived. Against a 200 ms frame
period at 5 fps this is not a consideration. It would become one for much larger
K, since the solve is O(K²·(K+T)); the codec caps K at 4096 for that reason.

---

## 2. Reception overhead at the codec, and an independent reproduction

The loss suite measures the codec through a transport. This suite measures it
directly: encoding symbols are handed to a decoder across a lossy channel with
no frame envelope and no manifest, and the only question is how many symbols
past K it needed. The configuration deliberately mirrors the one
`artifacts/fountain.js`'s author reports, so the two are comparable.

2,200 decodes, K ∈ {4, 8, 16, 32, 64, 81, 128, 200, 320, 500, 800}, 512-byte
symbols, 45% independent loss, every result verified against SHA-256 of the
source. Zero verification failures.

| K | decodes | at exactly K | by K+1 | mean overhead | worst | decode p50 |
|---|---|---|---|---|---|---|
| 4 | 200 | 94.50% | 100% | 0.0550 | +1 | 0.06 ms |
| 8 | 200 | 98.00% | 100% | 0.0200 | +1 | 0.14 ms |
| 16 | 200 | 97.00% | 100% | 0.0300 | +1 | 0.34 ms |
| 32 | 200 | 99.00% | 100% | 0.0100 | +1 | 0.90 ms |
| 64 | 200 | 99.00% | 100% | 0.0100 | +1 | 2.37 ms |
| 81 | 200 | 98.50% | 100% | 0.0150 | +1 | 3.19 ms |
| 128 | 200 | 99.00% | 100% | 0.0100 | +1 | 9.21 ms |
| 200 | 200 | 100.00% | 100% | 0.0000 | 0 | 18.14 ms |
| 320 | 200 | 98.50% | 100% | 0.0150 | +1 | 38.12 ms |
| 500 | 200 | 99.50% | 100% | 0.0050 | +1 | 74.62 ms |
| 800 | 200 | 100.00% | 100% | 0.0000 | 0 | 168.09 ms |

**Aggregate: 98.45% at exactly K, 100% by K+1, mean +0.0155, worst +1.**

### Cross-check against the author's own measurements

`artifacts/fountain.js`'s author measured the same property independently. Both
sets of numbers are below; neither was derived from the other.

| | author (2,000 decodes) | this harness (2,200 decodes) |
|---|---|---|
| decoded at exactly K | 98.20% | 98.45% |
| by K+1 | 99.95% | 100% |
| by K+2 | 100% | 100% |
| mean overhead | +0.0185 | +0.0155 |
| worst case | +2 | +1 |

They agree. The only divergence is a single +2 event in their sample and none in
ours, which at a rate of roughly 1 in 2,000 is exactly what two samples of this
size should be expected to disagree about. Treating the two runs as one pool of
4,200 decodes gives ~98.3% at exactly K and one +2 event overall.

That rate is also in line with what RaptorQ publishes for itself — >99%
recovery at zero overhead, >99.99% at one symbol, >99.9999% at two
([Raptor code](https://en.wikipedia.org/wiki/Raptor_code); these figures
originate with Luby et al. and are **not** tabulated in
[RFC 6330](https://www.rfc-editor.org/rfc/rfc6330.html) itself, which only says
the decoder recovers "from almost any set of encoding symbols of cardinality
only slightly larger than the number of source symbols"). rvQR's codec sits a
little below the zero-overhead figure and comfortably above the K+1 one. As
section "What `artifacts/fountain.js` is" says, this is a structural analogue
being compared against a standard's published behaviour, not a conformance claim.

### Decode cost against symbol size

The same 40,989-byte payload, split into progressively smaller symbols. This is
the trade the app's chunk-size slider makes: smaller symbols mean more of them,
and the decoder solves a system that grows as K²·(K+T).

| symbol size | K | encoder setup | decode (systematic) | decode (repair only) | author's figure |
|---|---|---|---|---|---|
| 1024 B | 41 | 1.04 ms | 2.65 ms | 2.16 ms | 1.9 ms |
| 512 B | 81 | 1.72 ms | 3.86 ms | 3.19 ms | 2.72 ms |
| 256 B | 161 | 3.01 ms | 6.59 ms | 5.96 ms | 7.8 ms |
| 128 B | 321 | 7.76 ms | 15.11 ms | 13.63 ms | 12.2 ms |
| 64 B | 641 | 28.64 ms | 51.28 ms | 46.18 ms | 31 ms |

"Systematic" is the clean-channel case where the source symbols arrived
verbatim; "repair only" is the worst case a lossy channel can produce, with
every source symbol missed and every one reconstructed.

Our timings run 15–20% above the author's at small K and about 50% above at
K=641. The likely cause is a methodology difference rather than a disagreement
about the code: this harness starts its clock *before* constructing the decoder,
so building and inserting the LDPC and HDPC constraint rows is inside the
measurement. That setup is O(L²) dense work and grows fastest exactly where the
gap is widest. Both sets of numbers are self-consistent; they are measuring
slightly different boundaries around the same operation.

The practical reading is that K=800 costs 168 ms to decode, which is most of a
frame period at 5 fps. The codec's own ceiling of K=4096 would be far beyond
what a phone could absorb between frames — but a QR channel at 512 bytes a
symbol reaches K=800 only at about 400 KB, which is 27 minutes of transfer at
the default rate, so the constraint that binds first is patience, not compute.

---

## 3. Where the fountain loses: small objects and the manifest

Payload: `artifacts/demo/ruvnet-demo.rvf`, 2304 bytes, 512 bytes per frame.
Baseline needs 6 frames; the fountain block is K=5.

| transport | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| rvQR v1 | 6 / 6 | 11 / 20 | 17 / 32 | 31 / 59 |
| fountain (shipped) | 6 / 6 | 11 / 21 | 19 / 61 | 36 / 101 |

The fountain is level at 20% and worse by 16% (mean) and 71% (p95) at 60%. This
is not a coding failure. The receiver reaches full rank after five symbols and
then *waits*, because it cannot verify or name the object without the manifest,
and the harness's fountain stream repaints the manifest only every 20 slots.
Miss it and you wait up to twenty slots for the next one — which, on an object
that only needs five symbols, is the entire transfer.

The finishing overhead for this payload reaches 8.5 extra symbols at 60% loss,
which looks alarming until you separate the two meanings: measured at the moment
the receiver reached full rank, the **coding** overhead is 0.03 symbols. Every
one of those 8.5 frames arrived while the receiver already held the whole object
and was waiting to be told what it was.

Sweeping the repaint interval confirms the diagnosis. Mean / p95 slots:

**K=5 (2304-byte container)**

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| **4 slots** | 7 / 7 | **9 / 12** | **12 / 18** | **18 / 30** |
| 8 slots | 6 / 6 | 8 / 12 | 12 / 25 | 20 / 41 |
| 16 slots | 6 / 6 | 10 / 17 | 16 / 49 | 32 / 97 |
| 20 slots | 6 / 6 | 11 / 21 | 19 / 61 | 36 / 101 |
| 32 slots | 6 / 6 | 13 / 33 | 25 / 65 | 54 / 161 |

**K=81 (40,989-byte module)**

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| 4 slots | 108 / 108 | 136 / 148 | 180 / 203 | 270 / 306 |
| 8 slots | 93 / 93 | 117 / 127 | 155 / 174 | 232 / 263 |
| 16 slots | 87 / 87 | 109 / 119 | 144 / 163 | 216 / 247 |
| 20 slots | 86 / 86 | 108 / 116 | 142 / 159 | 214 / 245 |
| **32 slots** | **84 / 84** | **106 / 115** | **140 / 158** | **211 / 244** |

The optimum moves in opposite directions at the two ends: frequent repaints at
K=5, sparse repaints at K=81. Any fixed constant is wrong at one end or the
other. A repaint interval that scales with the block size — something on the
order of `clamp(K/2, 4, 32)`, which picks 4 at K=5 and 32 at K=81 — matches the
measured optimum at both. Folding the manifest fields into the repair-symbol
header would remove the problem entirely at the cost of per-frame bytes.

**This finding is about the harness's framing choice, not about
`artifacts/fountain.js`.** The codec does not specify how the manifest travels;
the transport does. What the sweep shows is that whoever builds that transport
should not pick a constant.

---

## 4. Real payloads

QR versions are the smallest that fits each frame. Error-correction level L is
the app's default (`artifacts/app.js`, `send.ecl = 'L'`); M is shown because it
is what a user picks when scanning is unreliable, and it costs symbol versions.

**`ruvnet-demo.rvf`** — 2304 B, detected as an RVF container (segment magic
`53 46 56 52` at offset 0). Four spans: MANIFEST(162), VEC(1798), WITNESS(132),
MANIFEST(212).

| rate | frames | QR ver (L) | QR ver (M) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|---|
| 512 B @ 5 fps | 6 | 8–19 | 9–22 | 3534 | 65.2% | 1.2 | 1.88 KB/s | 2.50 KB/s |
| 1024 B @ 10 fps | 4 | 8–27 | 10–31 | 3423 | 67.3% | 0.4 | 5.63 KB/s | 10.00 KB/s |

**`rvf_wasm_bg.wasm`** — 40,989 B, `@ruvector/rvf-wasm` 0.1.9, detected as a
WASM module.

| rate | frames | QR ver (L) | QR ver (M) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|---|
| 512 B @ 5 fps | 82 | 5–19 | 6–22 | 59,551 | 68.8% | 16.4 | 2.44 KB/s | 2.50 KB/s |
| 1024 B @ 10 fps | 42 | 5–27 | 6–31 | 57,232 | 71.6% | 4.2 | 9.53 KB/s | 10.00 KB/s |

Fountain block sizes for the same objects: K=5 and K=3 for the RVF container at
512 and 1024 bytes; K=81 and K=41 for the WASM module.

Three things worth naming:

- **"Wire efficiency" is 65–72%**, not 100%. Every frame carries a JSON envelope
  (`{"v":1,"t":…,"h":…,"i":…,"n":…,"p":…}`) and the payload is base64url, which
  costs 4 bytes for every 3. A 512-byte chunk becomes a 740-byte frame. That
  gap is the difference between the "nominal" and "goodput" columns, along with
  the manifest frame.
- **Goodput is close to the README's figures but slightly under them.** 2.44
  against 2.5 KB/s, 9.53 against 10 KB/s. The README's numbers are chunk × fps;
  the measured ones divide the file size by the real elapsed time including the
  manifest frame. The README is right to two significant figures.
- **Small objects are worse off proportionally.** The 2304-byte container gets
  1.88 KB/s at the defaults because one of its six frames is pure manifest.

**Projections** (arithmetic, not measurements) at 1024 B @ 10 fps: 1 MB takes
1025 frames and 1.7 minutes; 10 MB takes 10,241 frames and 17 minutes; 1 GB
takes 1,048,577 frames and 29.1 hours. The README's characterisation of this as
"a channel for kilobytes and low megabytes" is accurate.

---

## 5. Delta transfer

`artifacts/delta.js` driven end to end on the 2304-byte demo container: build a
receiver inventory, mutate the body of one span, build a sender inventory, diff,
build the delta payload, apply it, and check the result is byte-identical.

| changed span | span bytes | spans sent | delta payload | inventory | wire ratio | byte-exact? |
|---|---|---|---|---|---|---|
| #0 MANIFEST | 162 | 1/4 | 306 B | 134 B | 5.24× | yes |
| #1 VEC | 1798 | 1/4 | 1942 B | 134 B | 1.11× | yes |
| #2 WITNESS | 132 | 1/4 | 276 B | 134 B | 5.62× | yes |
| #3 MANIFEST | 212 | 1/4 | 356 B | 134 B | 4.70× | yes |

"Wire ratio" counts both optical hops — the inventory the receiver must display
*and* the delta the sender streams — against a full transfer of the same
container.

**The honest reading of this table is that it is a small-container result and
the ratios are correspondingly small.** Changing the VEC segment, which is 78%
of the container, saves 11%. Changing the WITNESS segment, which is 6% of it,
saves 82%. The 5.6× best case here is real but it is a statement about a
2.3 KB file with four spans, and it does not generalise upward on its own.

**Projection for a large container** — arithmetic, not a measurement, assuming
4 MB spans and that the changed fraction lands on whole spans:

| rate | full frames | delta frames | full time | delta time | ratio |
|---|---|---|---|---|---|
| 512 B @ 5 fps | 2,097,153 | 24,588 | 116.5 h | 1.4 h | 85× |
| 1024 B @ 10 fps | 1,048,577 | 12,295 | 29.1 h | 20 min | 85× |

This lands just under the README's "~100× less data … about 29 hours down to 18
minutes". The gap is mostly granularity: with 4 MB spans a 1 GB container has
256 of them, and "1% changed" rounds up to 3 spans, i.e. 1.17%. The receiver's
inventory also has to cross the channel, which the README's figure omits.

Span size is the free parameter, and it cuts both ways — large spans waste
payload on unchanged bytes inside a changed span, small spans make the inventory
itself expensive to send:

| span size | spans | inventory | inventory time @ 512 B / 5 fps | ratio |
|---|---|---|---|---|
| 4 MB | 256 | 5 KB | 0.0 min | 85× |
| 1 MB | 1,024 | 20 KB | 0.1 min | 102× |
| 256 KB | 4,096 | 80 KB | 0.5 min | 99× |
| 64 KB | 16,384 | 320 KB | 2.1 min | 97× |

So ~100× is achievable and the README's figure is defensible; it just needs a
span size around 1 MB rather than any span size. Assuming 20 bytes per span
record, which matches what `delta.js` produces for the demo container.

The projection is *optimistic* in one way worth naming: it assumes the edit is
confined to whole spans and does not change their lengths. A length-changing
edit shifts every subsequent offset, and none of the numbers above apply to it.

---

## 6. QR encode and decode cost

Encoding is measured on real rvQR frames with `artifacts/vendor/qrcode.js`.
Decoding uses `artifacts/vendor/qrdecode.js`, the JS fallback the app uses when
`BarcodeDetector` is unavailable. `decodeMatrix` is the symbol decode alone
(format bits, de-interleaving, Reed–Solomon); `decodeImage` is the whole
pipeline from an image — binarize, find finder patterns, fit a perspective
transform, sample the grid, then decode.

| chunk | ECC | frame bytes | QR ver | modules | encode p50 | decodeMatrix p50 | decodeImage 640×480 | decodeImage 1280×720 |
|---|---|---|---|---|---|---|---|---|
| 256 B | L | 400 | 13 | 69² | 2.12 ms | 0.31 ms | 4.0 ms (250 fps) | 11.5 ms (87 fps) |
| **512 B** | **L** | **740** | **19** | **93²** | **3.95 ms** | **0.25 ms** | **3.8 ms (264 fps)** | **10.7 ms (93 fps)** |
| 512 B | M | 740 | 22 | 105² | 5.03 ms | 0.22 ms | 4.9 ms (205 fps) | 11.3 ms (89 fps) |
| 768 B | L | 1081 | 23 | 109² | 5.49 ms | 0.26 ms | 4.1 ms (243 fps) | 10.8 ms (93 fps) |
| **1024 B** | **L** | **1423** | **27** | **125²** | **7.44 ms** | **0.36 ms** | **5.4 ms (184 fps)** | **12.0 ms (83 fps)** |
| 1024 B | M | 1423 | 31 | 141² | 9.32 ms | 0.47 ms | 4.8 ms (210 fps) | 10.6 ms (94 fps) |

Encode cost is linear in symbol area and works out to a flat ~150 KB/s of QR
payload across the whole version range (0.56 ms at version 5, 14.99 ms at
version 40, ECC M).

Two observations:

- **`decodeImage` cost is set by the image, not the symbol.** It barely moves
  between version 13 and version 31, because finder-pattern search dominates and
  that scales with pixel count. Halving the capture resolution roughly triples
  the achievable rate.
- **Decode is not what limits rvQR's frame rate on this hardware.** At the
  default 512 B / 5 fps the budget is 200 ms per frame and the JS decoder uses
  10.7 ms of it at 720p. Even allowing a phone to be five to ten times slower at
  JavaScript, the ceiling of 10 fps in the app is a policy limit, not a
  computational one.

**These decode timings are a lower bound, not an estimate.** The images are
rendered from the encoder's own module grid: perfectly square-on, evenly lit, no
motion blur, no rolling shutter, no glare, and exactly one symbol in frame. A
real camera frame is harder in every one of those respects, and the app's
primary path is the native `BarcodeDetector`, which this harness cannot call.

---

## 7. State of the art

### First, a category distinction that matters

A large fraction of "send a file with a QR code" tools do not send the file with
a QR code. [qrcp](https://github.com/claudiodangelis/qrcp) encodes
`http://{address}:{port}/{random_path}` into a single QR symbol; the phone's
browser then downloads the file over HTTP from a web server bound to the
sender's Wi-Fi interface. LocalSend, Snapdrop and PairDrop work the same way.
The QR code is a bootstrap for a network transfer, and the throughput on offer
is Wi-Fi throughput.

That is a fine design and a much faster one. It is also a different thing: it
needs both devices on the same network, and it does not work across an air gap.
Putting its throughput in the same column as an optical channel's would be
meaningless, so the table below marks the category rather than tabulating a
number.

### Comparison

Cells marked **[M]** are measured by this harness. Cells marked **[C]** are the
comparator's own published claim, reproduced as theirs. **[?]** is unknown or
unverifiable from available sources.

| system | channel | coding | throughput | loss resilience | network? | install? | integrity / authenticity |
|---|---|---|---|---|---|---|---|
| **rvQR** (this project) | optical, single monochrome QR | systematic GF(256) fountain, **RaptorQ-structured, not RFC 6330 conformant, interoperates with nothing** | **2.44 KB/s default, 9.53 KB/s ceiling [M]** | **exactly K symbols in 98.45% of 2,200 decodes, never more than K+1; 3.75× fewer slots than indexed chunks at 60% loss [M]** | no | no (static web page) | SHA-256 over the whole object, mandatory, all-or-nothing. **No authenticity** — the manifest is unauthenticated. Signatures are roadmap. |
| [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/) | optical, QR v40 (+ multi-code grids, colour) | LT codes, robust soliton | 128 KB/s phone-to-phone; 129.2 KB/s on a 2 MB image [C]. ~186 KB/s "propped" is a projection in the README [C] | needs ~K·1.15 distinct frames [C] | no | no (browser, offline via service worker) | SHA-256 in a 20-byte frame header; no encryption, no signatures [C] |
| [txqr](https://github.com/divan/txqr) | optical, single QR | LT codes via `google/gofountain`, a real fountain library — **no wire compatibility with rvQR's codec in either direction** | ~13 KB in 501 ms at 1850 B/frame, 12 fps, ECC L [C] — see units note below | rateless; frames may be skipped or reordered [C] | no | yes (Go CLI; iOS and GopherJS builds exist) | [?] — no integrity guarantee documented in the README |
| [BC-UR multipart](https://developer.blockchaincommons.com/animated-qrs/) (hardware wallets) | optical, animated QR | hybrid: first `seqLen` parts fixed-rate, then rateless LT [C] | [?] — no throughput figure published | rateless; "individual frames to be missed without requiring all the frames to be resent" [C] | no | depends on wallet | CRC on parts; authenticity comes from the signed payload (PSBT), not the transport |
| [qrcp](https://github.com/claudiodangelis/qrcp) / LocalSend / PairDrop | **not optical** — QR carries a URL, data goes over Wi-Fi | n/a | Wi-Fi throughput; not comparable | n/a (TCP) | **yes** | binary or app | TLS optional; scope is the LAN |
| [COBRA](https://dl.acm.org/doi/10.1145/2307636.2307645) (MobiSys '12) | optical, custom 2D colour barcode | colour symbology + blur-tolerant decoding | secondary sources give 153–598 kbps and 900 kbps [?] — see note | designed for blur in handheld use | no | research prototype | n/a (research) |
| [Strata](https://dl.acm.org/doi/10.1145/2639108.2639132) (MobiCom '14) | optical, layered colour code | hierarchical modulation, layers independently decodable | [?] — not found in accessible sources | extends operational range vs single-layer codes [C] | no | research prototype | n/a (research) |
| LightSync (MobiCom '14), InFrame++ (MobiSys '15), HiLight (2015) | optical, mostly *unobtrusive* (data hidden in displayed video) | various | secondary sources give ~8 kbps (LightSync), 22 kbps goodput (HiLight hybrid), 150–360 kbps (InFrame++) [?] | varies | no | research prototypes | n/a (research) |

### Notes on the cited numbers

**txqr's units.** The blog post states: *"The record time for transferring ~13KB
of data is now is half a second or 501ms to be precise – it's almost 25kbps."*
13 KB in 501 ms is 26 KB/s, i.e. about 208 kbps, so "kbps" there appears to be a
slip for KB/s. Cross-checking against the same post's configuration — 1850 bytes
per QR at 12 fps — gives 22 KB/s, which agrees with the KB/s reading and not the
kbps one. The earlier, pre-fountain post reports a best of *"1.4 secs, which is
almost 9KB/s"* for the same 13 KB, with optimal parameters found at 6–7 fps and
550 or 900-byte chunks. So txqr's own before/after for adopting fountain codes is
roughly 9 KB/s → 22–26 KB/s.

**Decimen's press coverage overstates its own README.** A [Tom's Hardware
headline](https://www.tomshardware.com/networking/streaming-qr-codes-at-60-fps-achieves-nearly-190-kb-s-data-rate-in-phone-to-phone-tests-browser-based-method-requires-no-app-no-networking-no-pairing-and-no-permissions-beyond-camera-access)
says the method "achieves nearly 190 KB/s". The project's README describes 128
KB/s as the measured phone-to-phone figure and ~186 KB/s as a projected ceiling
with a ProMotion sender and the device propped up. The 190 KB/s in the headline
is the projection. This is the same failure mode rvQR's README explicitly warns
against, and the comparison table above uses the README's measured number.

**COBRA's throughput is not reliably citable from where I sit.** The paper is
behind the ACM paywall and three secondary summaries give three different
figures (up to 598 kbps, 518 kbps, and 900 kbps). Rather than pick one, the
table records the disagreement. What is safe to say is that COBRA is a colour
barcode system on 2012 smartphone hardware and its rates are in the hundreds of
kbps, which is tens of KB/s — the same order as txqr and an order below Decimen.

**Research throughputs are not comparable to ours anyway.** Most of the
screen-camera literature after COBRA is about *unobtrusive* communication:
embedding data in video a human is simultaneously watching, where the design
constraint is imperceptibility and single-digit kbps is a good result. Comparing
that to a dedicated black-and-white QR stream, which is allowed to look like
whatever it wants, is comparing two different problems. They are in the table for
context on what the research community reports, not as competitors.

### Where rvQR loses, plainly

- **Throughput.** 9.53 KB/s measured at the ceiling against Decimen's claimed
  128 KB/s is roughly 13× behind. The arithmetic of the gap is not mysterious:
  rvQR caps a frame at 1024 bytes (`MAX_CHUNK` in `artifacts/core.js`) and the
  app at 10 fps; Decimen uses 2953-byte version-40 symbols at 60 fps. That is
  2.9× on density and 6× on rate. txqr, from 2018, also beats rvQR by roughly
  2–3× using 1850-byte frames at 12 fps.
- **The caps look conservative rather than necessary.** Section 6 measures the
  bundled JS decoder at 10.7 ms per frame at 720p, well inside a 100 ms budget.
  The binding constraints in practice are display refresh rate, camera capture
  rate, and how small a module a phone camera can resolve at arm's length —
  none of which this harness measures, and all of which deserve a real
  device test before the caps are raised.
- **rvQR is not first, and it is not novel.** Animated-QR fountain transfer was
  published by txqr in 2018 and is deployed at scale in hardware wallets via
  BC-UR. Browser-based, install-free optical transfer already exists in Decimen.
- **No authenticity.** The manifest travels in the same unauthenticated stream
  as the payload, so integrity does not imply provenance. The README says this
  clearly; it is still a real limitation relative to a signed transport.
- **Delta transfer's dramatic number is a projection.** The measured saving on
  a real container is 1.11×–5.62×.

### Where rvQR is genuinely different

Not faster — different. The honest list is short:

- **RVF-native.** It recognises RVF containers by wire magic per ADR-009 and,
  with `artifacts/delta.js`, diffs them span by span. None of the comparators
  know what an RVF container is; to them it is opaque bytes. The delta path is
  the only one in this comparison that can exploit structure in the payload.
- **Integrity is mandatory and all-or-nothing.** A single-bit error discards the
  whole transfer. Several comparators verify; not all do, and none of them make
  rejection the only alternative to acceptance.
- **Zero install, zero network, static files.** Shared with Decimen; not shared
  with txqr (Go binary) or the qrcp family (needs a LAN).
- **The fountain layer measures at the top of its class.** 99.46% of transfers
  at zero reception overhead is better than txqr's and Decimen's LT codes can
  do — an LT code at this block size needs ~44% overhead, which the harness also
  measures directly. rvQR moves fewer bytes per second than either, but it
  wastes fewer of the frames it does move.

---

## 8. Threats to validity

**No camera, no screen, no optics.** This is the big one. The harness models
frame loss as a probability and says nothing about where that probability comes
from. Real failures are correlated with symbol density, module size in pixels,
display refresh versus camera exposure, rolling shutter, glare, motion blur, and
distance. A denser QR version raises throughput *and* the loss rate, and this
harness cannot see the second half of that trade — so it cannot tell you the
optimal chunk size, which is precisely the question txqr's author spent four
hours of automated testing on with real devices.

**Goodput figures assume the receiver keeps up.** Section 4's KB/s numbers are
frame counts divided by frame periods. If a phone's decode loop misses frames,
the real rate is lower. Section 6 argues there is headroom on this hardware; it
does not prove it on a phone.

**Millisecond figures come from an Apple M4 Pro.** Treat them as a floor for
phone performance, not an estimate of it.

**The burst model is one shape of burst.** A two-state Gilbert channel with mean
burst 4 is a reasonable stand-in for a shaky hand at 5 fps. It is not a model of
autofocus hunting, of a user walking away and coming back, or of the
partial-occlusion case.

**Reception-overhead tails are undersampled.** 2,200 decodes put the
zero-overhead rate at 98.45% with a 95% interval of roughly ±0.5 points, which
is fine. They say almost nothing about the K+2 tail: our sample saw no such
event and the author's saw one. Establishing a failure probability of 10⁻⁴ would
need on the order of 10⁵ decodes, and neither run is close.

**The overhead sweep uses one loss rate and one symbol size.** 45% loss at 512-byte
symbols, chosen to match the author's configuration for comparability. Reception
overhead should be nearly independent of loss rate for a rateless code — the loss
suite's per-rate figures at K=81 support that — but this suite does not test it
across rates.

**The delta suite mutates span bodies, not span lengths.** Length-changing edits
shift every subsequent offset and are the harder case. They are not measured.

**The fountain transport's framing is the harness's, not the app's.** rvQR does
not yet have a fountain send path in `artifacts/app.js`. The JSON envelope and
manifest schedule used in Section 1 are a reasonable design chosen here, and
Section 3 shows the schedule choice matters a great deal. Real integration may
differ, and the slot counts would move with it.

---

## 9. What could not be measured, and why

| Wanted | Status |
|---|---|
| Real end-to-end phone-to-phone throughput | **Not measured.** Needs two devices, a camera and a human. Every KB/s figure here is derived from frame counts and the nominal frame period. |
| Optimal chunk size / QR version for a real camera | **Not measurable here.** Requires the density-versus-loss trade-off, which needs optics. |
| `BarcodeDetector` decode cost | **Not measurable in Node.** It is a browser API. Only the JS fallback decoder was timed. |
| Colour or multi-symbol frames | **Not applicable.** rvQR sends one monochrome symbol per frame. This is the single largest throughput lever the comparators use and rvQR does not. |
| RaptorQ interoperability | **Not applicable.** `artifacts/fountain.js` states plainly that it is not RFC 6330 conformant and will not interoperate with a conformant codec. Nothing here tests interoperability, and nothing here should be read as claiming it. |
| Signature verification cost | **Not measured.** `rvf-crypto` signing is roadmap; there is no signing path in this repository to time. |
| Resume-after-termination behaviour | **Not measured.** `artifacts/resume.js` landed while these benchmarks were being written and is not covered by this harness. |
| COBRA's published throughput | **Could not verify.** Paywalled; secondary sources disagree. |
| Strata's published throughput | **Not found** in accessible sources. |

---

## Sources

- Ivan Danyliuk, ["Fountain codes and animated QR"](https://divan.dev/posts/fountaincodes/), 1 December 2018 — txqr's fountain-coded throughput, chunk-size and FPS experiments.
- Ivan Danyliuk, ["Animated QR data transfer with Gomobile and Gopherjs"](https://divan.dev/posts/animatedqr/), 18 November 2018 — txqr's pre-fountain baseline.
- [divan/txqr](https://github.com/divan/txqr) — source and build targets.
- [bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/) — README performance claims, coding scheme, frame header.
- [Tom's Hardware, "Streaming QR codes at 60 FPS achieves nearly 190 KB/s…"](https://www.tomshardware.com/networking/streaming-qr-codes-at-60-fps-achieves-nearly-190-kb-s-data-rate-in-phone-to-phone-tests-browser-based-method-requires-no-app-no-networking-no-pairing-and-no-permissions-beyond-camera-access)
- [claudiodangelis/qrcp](https://github.com/claudiodangelis/qrcp) — confirms the QR-bootstraps-HTTP model.
- Blockchain Commons, ["Animated QRs"](https://developer.blockchaincommons.com/animated-qrs/) and [BCR-2024-001, Multipart UR](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md), 9 January 2024 — hybrid fixed-rate/rateless LT for air-gapped wallets.
- [RFC 6330, "RaptorQ Forward Error Correction Scheme for Object Delivery"](https://www.rfc-editor.org/rfc/rfc6330.html), August 2011.
- [Raptor code (Wikipedia)](https://en.wikipedia.org/wiki/Raptor_code) — the >99% / >99.99% / >99.9999% recovery figures at 0/1/2 overhead symbols, which do not appear in RFC 6330 itself.
- M. Luby, ["LT Codes"](https://doi.org/10.1109/SFCS.2002.1181950), FOCS 2002 — the robust soliton distribution used by the harness's `lt` reference codec.
- T. Hao, R. Zhou, G. Xing, ["COBRA: color barcode streaming for smartphone systems"](https://dl.acm.org/doi/10.1145/2307636.2307645), MobiSys '12.
- W. Hu et al., ["Strata: layered coding for scalable visual communication"](https://dl.acm.org/doi/10.1145/2639108.2639132), MobiCom '14.
- Coupon collector's problem: E[draws to collect all K coupons] = K·H_K ≈ K ln K + γK. Standard; see Motwani & Raghavan, *Randomized Algorithms* (Cambridge, 1995), §3.6.

---

*Harness: [`bench/`](../bench/). Raw per-cell statistics: `bench/results/full.json`
after a run with `--json`. Generated report: `bench/results/report.md`.*
