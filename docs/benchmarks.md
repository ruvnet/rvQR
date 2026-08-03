# rvQR benchmarks

What the optical channel actually does, measured rather than asserted, and how
it compares to the prior art in screen-to-camera data transfer.

Every number in this document is one of exactly three things, and which one it
is is stated where the number appears:

| | |
|---|---|
| **MEASURED** | Produced by the harness in [`bench/`](../bench/) on the machine and seed recorded below. The command that produces it is given with each table. |
| **MODELLED** | Arithmetic or simulation over measured inputs, describing something that does not exist yet or cannot be observed here. Marked as a model in the same sentence as the number, never in a footnote. |
| **CITED** | Somebody else's published claim, reproduced as theirs with a link. No third-party figure appears anywhere in this document as ours. |

There are no numbers here that are none of those three things.

---

## Headline findings

**1. v2 gets 1.21× more artifact through a version 19-L symbol than v1 — and
1.39× is on the table but not reachable with the shipped decoder.** MEASURED at
matched QR versions: a 792-byte version 19-L symbol carries 550 bytes of
artifact under v1's JSON+base64url framing (44.0% envelope), 665 bytes under v2
armoured (19.1%), and 764 bytes under v2 binary (3.7%). But encoding a raw v2
binary frame and decoding it with `artifacts/vendor/qrdecode.js` **does not
return the bytes**: 792 bytes in, 830 bytes back, `parseFrame` rejects it.
The armoured path round-trips byte-exact. So v2's usable gain today is 1.21×,
not 1.39×.

**2. Compression is worth far more than framing, and the envelope gate is the
right way to decide it.** MEASURED: the 40,989-byte demo WASM compresses 2.46×
with Brotli-6 and 2.77× with Brotli-11; once the v2 header, the manifest frame
and the armour are all counted, the **complete transport envelope** shrinks
59.3% and 63.7% respectively. Compare that with v2 framing's 1.21×. The
break-even, however, is content-dependent and one of the cases is bad: for
float32 vectors compression **loses** at and below 128 bytes and does not reach
an 8% envelope gain until **6,144 bytes**, where for source code it reaches it
at 128.

**3. G = R × C × E × P ranks configurations, and it is exact only for a
rateless transport.** MEASURED at P = 1 on the demo WASM: v1 uncompressed
delivers 2.63 KB/s, v2 armoured 3.18 KB/s, v2 armoured with Brotli-11
8.34 KB/s — a 3.2× improvement from the same optics. G is linear in P, which
the loss suite confirms is right for every fountain transport (measured
penalty 0.99×–1.02× across seven loss rates) and **wrong for v1's indexed
cycling, which pays up to 3.90× more slots than 1/P scaling predicts at 60%
loss**. Every G figure at P < 1 is a projection, because P is a property of a
camera and there is no camera here.

**4. The 100-device site target is met with room to spare, and broadcast rather
than peer exchange is what does it.** MODELLED: 100 receivers, 30% independent
loss, taking a 1 GB artifact — source traffic is **1.19 GB with
content-addressed peer exchange and 1.75 GB with no peer exchange at all**,
against 100 GB for naive unicast. Both are inside the 3 GB target. The peer
layer is worth 1.75× → 1.19×; the other 57× is broadcast, which is a property
of pointing a hundred cameras at one screen and needs no protocol at all. At
N = 100 the residual 1.19× is almost entirely the QR envelope (792-byte symbol
carrying 665 bytes = 1.19×), not loss.

**5. ADR-012 and ADR-022 are individually reasonable and jointly infeasible
optically.** MODELLED: ADR-022's gate is closures 1–3, each separately signed;
ADR-012 selects ML-DSA-65 at 3,309 bytes per signature. Three signatures cost
**9,927 bytes**, and the entire 3-second budget at the app's default 5 fps is 15
frames — 9,975 bytes of QR capacity, of which three go to the closures' own
manifests. **The signatures alone do not fit, before a byte of closure
content.** With 64-byte Ed25519 the budget is a comfortable 7,788 bytes. Neither
ADR reaches this conclusion because it is a product of the two.

**6. The pipeline is inside its memory budget and outside its copy budget.**
MEASURED on `standalone.html` (572,166 B) in a separate process under
`--expose-gc`: peak RSS 87.9 MiB, of which 39.9 MiB is the pipeline itself —
comfortably inside 128 MiB. But **the receiver peaks at 2.78 payload copies for
v1 and 2.56 for v2**, against ADR-025's budget of fewer than two. Both overshoot
for the same structural reason: the decoded chunks and the assembled output are
alive at the same time.

**7. `proto2.toTransport` leaves a cons-string rope that costs about 30 bytes
per output byte.** MEASURED: armouring every frame and retaining them cost
37.6× the artifact in heap, against the 1.14× the armour's own expansion
accounts for. Holding one frame at a time costs nothing
(0.03×), so this only bites a sender that pre-armours a batch. It is a
one-character-at-a-time `+=` loop that V8 never flattens.

**8. The fountain layer is worth 2×–3.8× under frame loss, and costs 5% when
there is none.** MEASURED and unchanged from the previous revision of this
document: transferring the demo WASM at 512 bytes per frame, the receiver must
observe 800 frame slots at 60% loss with v1's indexed chunks and 214 with
`artifacts/fountain.js`. At 0% loss the fountain is *slower* — 86 slots against
82 — because it repaints the manifest and v1 gets it free as frame zero.

**9. The shipped codec's reception overhead is essentially zero.** MEASURED:
2,200 decodes, K from 4 to 800, 45% loss, every result SHA-256 verified —
**98.45% needed exactly K symbols, 100% needed no more than K+1, mean overhead
+0.0155, worst case +1.**

**10. Diffing inside segments is worth 2.4×–27.9× over diffing between them, and
the module knows when it is not worth anything.** MEASURED on seven scenarios,
all seven reconstructing byte-exactly: a 1.13 MB container with 8 vector
records, one COW cluster, three membership bits and one WASM byte changed moves
**40,285 bytes semantically against 1,125,630 bytes span-wise**, and one changed
WASM function body moves 3,693 bytes against 41,155. But **a finer diff costs a
table row per unit, and two scenarios measure it losing**: halving the demo's
vector dimension rewrites every record, so the semantic payload is the span
payload plus a 392-byte 28-unit table — 1,510 B against 1,174 B — and
`chooseDelta` correctly returns the span delta. It also declines for a cold
receiver. The semantic *inventory* is larger in every case too (667 B against
134 B for the demo, 44,235 B against 190 B for the large container), which
`chooseDelta` does not look at and which no scenario here makes decisive.

**11. A learned model cannot buy a forbidden transfer, and the decision costs
four to seven orders of magnitude less than the transfer it decides.** MEASURED
on `artifacts/planner.js` with an adviser returning the maximum preference for
exactly the candidates each hard rule forbids and the minimum for every other
candidate, at an advice weight of 1000: across the trust, memory, radio and
verification rules, **18, 12, 2 and 9 forbidden candidates were rejected and
none of them appeared anywhere in the ranking** — the unverified peer
correctly produces no plan at all rather than a bad one. Planning itself is 0.018
to 0.104 ms over 18 to 54 candidates and does not grow with the artifact: the
1,125,950-byte container plans in 0.076 ms and the 132-byte one in 0.041 ms.
**The inventory-granularity rule closes the defect §7 measured**, publishing a
unit table for 4 of the 8 container shapes tried and declining it for the other
4 — including the demo container, whose table costs 869 B twice over against
1,798 decomposable bytes.

**12. The compression gate disagrees with a ratio rule in both directions, and
only on the content this project carries.** MEASURED by driving
`artifacts/compress.js` with the real `node:zlib` codecs on seven artifacts:
six compress and **the incompressible one is refused, its envelope growing from
47,553 to 47,558 bytes** with no frame saved. Float32 vectors clear by 1.26
points where every real file clears by 15 to 68, and scanning prefixes of them
finds the disagreement going both ways within 1,300 bytes of the same artifact —
at 2,816 B the payload sheds 8.20% and the envelope only 7.65% (a payload rule
compresses for nothing), at 2,304 B the payload sheds 7.81% and the **envelope
8.31%** because a frame dropped out (a payload rule refuses a real saving). The
verdict flips five times across eighteen sizes, so there is no single break-even
size at all. **And none of it is sendable today: every compressing decision
names codec id 4, which `proto2.parseFrame` rejects on the first frame.**

**13. The browser cannot run either codec ADR-003 selected, and it costs less
than that sounds.** The WHATWG Compression Streams list is `gzip`, `deflate`,
`deflate-raw` — Zstd is ADR-003 §2.1's default and Brotli its maximum-ratio
option, and **a browser has neither**, so every Brotli and Zstd figure in this
document is a Node measurement of a codec no user of the web app executes.
MEASURED through the real `CompressionStream('deflate-raw')`, with the module's
own `choose()` judging the bytes: the shipped app gets **55.91% envelope gain on
the demo WASM against Brotli's 63.69%, 21.07% on the demo container against
23.37%, and 70.12% on `standalone.html` against 76.40%** — an edge of 0.48 to
7.77 points, worst case 26% more frames for the receiver to watch. **deflate-raw
gets most of the way there**; the browser limitation is worth single-digit
percentage points, not a factor. A browser also has no level to raise: the
stream's output is byte-identical to `deflateRawSync` at level 6 on 7 of 7
artifacts.

---

## Reproducing this

```bash
# Everything in this document.
node bench/index.mjs --trials 500 --seed 20260802 --json bench/results/full.json

# One suite at a time. The first five are the original harness; the rest are new.
node bench/index.mjs --suite loss        # baseline vs fountain under frame loss
node bench/index.mjs --suite overhead    # reception overhead at the codec
node bench/index.mjs --suite payloads    # the two real demo artifacts
node bench/index.mjs --suite delta       # delta transfer end to end
node bench/index.mjs --suite qr          # QR encode and decode cost
node bench/index.mjs --suite proto       # protocol v1 against v2 at matched QR versions
node bench/index.mjs --suite compress    # codecs on the envelope, what compress.js decides, Node vs browser
node bench/index.mjs --suite objective   # G = R × C × E × P
node bench/index.mjs --suite fleet       # N receivers, peer exchange (a model)
node bench/index.mjs --suite closures    # progressive activation (a model)
node bench/index.mjs --suite memory      # working memory and payload copies
node bench/index.mjs --suite semdelta    # semantic delta, inside RVF segments
node bench/index.mjs --suite planner     # strategy choice, the hard rules, inventory granularity

# The memory suite spawns its own child process; to run that probe directly:
node --expose-gc bench/lib/memprobe.mjs

# A fast pass for checking the harness still runs (25 trials, noisy).
node bench/index.mjs --quick
```

The harness makes no network requests, reads nothing outside the repository,
and takes about 3 minutes 15 seconds for the full 500-trial run. It prints a
markdown report on stdout and optionally writes the raw per-cell statistics as
JSON.

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
| Run at | 2026-08-03T16:44:39Z |

Frame counts, slot counts, byte counts and overhead figures are
machine-independent: they are determined by the seed and will reproduce exactly
anywhere. Millisecond figures are not, and an Apple M4 Pro is several times
faster at JavaScript than the phones this app is designed for. Millisecond
figures also vary a few tens of percent *between runs on this machine*
depending on how warm the JIT is by the time a suite runs — see the note under
"Decode cost against symbol size".

**Two artifacts moved while these benchmarks were being taken, repeatedly, and
are still moving.** `standalone.html` was 503,216 bytes at the start of the
session, then 507,527, then 572,166 at the time of this run, and 849,284 and then
950,817 when §2 was re-run at 20:52:14Z. `artifacts/app.js` went from 91,487 to
112,319 for this run, and then to 182,189, 194,163, 204,901 and 206,829 across
four §2 re-runs over fourteen minutes. Both are under active development by other agents. Every measurement
below records the size it saw, and any figure quoted against a different size is
a measurement of a different file. Ratios and percentages survive this; absolute
byte counts do not, and are quoted with their size.

---

## Methodology

### The channel is an erasure channel

A QR symbol either decodes or it does not. If enough modules are misread the
symbol fails its own Reed–Solomon check and the decoder returns nothing; it does
not return wrong bytes. So the optical link is an *erasure* channel, not a noisy
one, which is exactly the setting fountain codes were designed for.

The harness models it as a slotted channel. One **slot** is one frame period —
one symbol painted on the sender's screen, whether or not the camera got it.
Slots are the metric that matters to a person holding a phone. Two models are
used:

- **iid** — each slot is dropped independently with probability *p*. The
  textbook case, and the one with a closed form to check the simulation against.
- **Gilbert** — a two-state burst model, average loss rate *p*, mean burst
  length 4 frames. Real camera loss clusters: a hand shakes, autofocus hunts,
  the phone is moved.

### What is real code and what is not

| Component | Status |
|---|---|
| rvQR v1 sender and receiver | **Real.** The baseline transport calls `artifacts/core.js` for frame construction, parsing, reassembly and SHA-256 verification. It is not a model of v1; it is v1. |
| rvQR v2 sender and receiver | **Real.** `artifacts/proto2.js` drives every v2 figure — `buildFrames`, `toTransport`, `parseFrame`, `ingest`, `finalize`. |
| Fountain codec | **Real.** `artifacts/fountain.js`, the systematic GF(256) codec, measured directly. See the conformance note below. |
| Delta transfer | **Real.** `artifacts/delta.js` driven end to end: inventory, diff, payload build, apply. |
| QR encoder and decoder | **Real.** `artifacts/vendor/qrcode.js` and `artifacts/vendor/qrdecode.js`. |
| Zstd and Brotli | **Real,** from `node:zlib`. Not the same builds a browser runs — see §2. |
| Reference codecs (`lt`, `rlf`, `rlf-sys`) | **Harness-owned**, in `bench/lib/fountain-ref.mjs`. Reference points to score the shipped codec against. |
| Fleet peer exchange | **Modelled.** No such system exists in this repository. See §11. |
| Progressive activation | **Modelled.** Nothing here signs or activates a closure. See §12. |
| Camera, screen, optics | **Not modelled at all.** See "Threats to validity". |

### What `artifacts/fountain.js` is, and what it is not

Everywhere this report says "the shipped fountain", it means a codec that is
**RaptorQ-structured, not RaptorQ**. It borrows RFC 6330's architecture — the
`A = [LDPC | HDPC | LT]` block layout, the circulant `G_LDPC,1`, the tuple
shape, the degree distribution's shape and cut points — but derives three things
the RFC pins down with published tables: the per-K′ parameters `(S, H, W, P1)`,
the systematic index `J(K′)`, and `Rand[]`/`G_HDPC`. Its own header says so.

**Symbol streams from this module decode only with this module.** Nothing here
tests or implies interoperability with an RFC 6330 codec.

### Every trial is verified, not just completed

A trial is counted only if the reconstructed bytes hash to the manifest's
SHA-256. Across the full run there were zero failures to complete within the
slot cap and zero completions that failed verification. All four delta cases
reconstructed byte-identical containers. Every compression round trip in §2 was
checked byte-for-byte, and all 60 passed. The v1 and v2 pipelines in §9 both
reconstructed `standalone.html` byte-exact.

---

# Part I — MEASURED

## 1. Protocol v1 against protocol v2

`node bench/index.mjs --suite proto`

v1 frames JSON with a base64url payload. v2 (`artifacts/proto2.js`) uses a
28-byte binary header and carries the payload raw, with an ASCII-armoured
variant that repacks the frame 7 bits at a time so it survives a decoder that
can only return a string.

The question is not how big a header is. It is: given a QR symbol of a fixed
version and error-correction level — which is what the optics actually
constrain — how many bytes of *artifact* does each framing get through it? The
largest chunk each framing can carry was found by binary search over frames the
real builders produced, then confirmed by encoding one and reading back
`qr.version`.

### Density at matched QR versions (payload `rvf_wasm_bg.wasm`, 40,989 B)

| QR ver-ECC | capacity | framing | max payload | frame bytes | envelope | vs v1 | round trip |
|---|---|---|---|---|---|---|---|
| 19-L | 792 B | v1 JSON | 550 B | 792 B | 44.0% | 1.000× | yes |
| 19-L | 792 B | **v2 armoured** | **665 B** | 792 B | **19.1%** | **1.209×** | **yes** |
| 19-L | 792 B | v2 binary | 764 B | 792 B | 3.7% | 1.389× | **NO — bytes lost** |
| 27-L | 1465 B | v1 JSON | 1024 B (capped) | 1424 B | 39.1% | 1.000× | yes |
| 27-L | 1465 B | v2 armoured | 1253 B | 1464 B | 16.8% | 1.224× | yes |
| 27-L | 1465 B | v2 binary | 1437 B | 1465 B | 1.9% | 1.403× | **NO — bytes lost** |
| 40-L | 2953 B | v1 JSON | 1024 B (capped) | 1424 B | 39.1% | 1.000× | yes, **at version 27** |
| 40-L | 2953 B | v2 armoured | 2555 B | 2952 B | 15.5% | 2.495× | yes |
| 40-L | 2953 B | v2 binary | 2925 B | 2953 B | 1.0% | 2.856× | **NO — bytes lost** |

The full table across versions 13, 16, 19, 22, 27 and 40 at both L and M is in
`bench/results/report.md`.

**Three things this table says.**

**The 665 and 764 figures reproduce independently.** A 792-byte version 19-L
symbol holds a 693-byte frame once armoured (⌈693 × 8/7⌉ = 792), leaving 665
after the 28-byte header; unarmoured it holds 792 − 28 = 764. Both were found
by search over real frames, not by that arithmetic, and both agree with it
exactly.

**v2 binary's density cannot currently be used.** Encoding the 792-byte binary
frame at version 19-L and decoding it with `artifacts/vendor/qrdecode.js`
returns 830 bytes, not 792, and `proto2.parseFrame` rejects the result.
`qrdecode.js`'s `readSegments` hands its byte-mode octets to a UTF-8 decoder, so
any byte that is not valid UTF-8 becomes a replacement character and the
original is gone. This corroborates `proto2.js`'s own docblock rather than
restating it, and it is why the armoured column is the one to design against.
The app's primary decode path is the browser's `BarcodeDetector`, which this
harness cannot call — but that API also returns a string, so the same problem
is likely to apply there.

**`core.MAX_CHUNK` stops v1 at version 27.** v1 clamps a chunk to 1,024 bytes,
which produces a 1,424-byte frame — version 27. A version 40 symbol holds 2,953
bytes and v1 cannot fill it at any setting. v2 clamps at `MAX_PAYLOAD_BYTES` =
2,953 instead, so the two protocols do not have the same reachable operating
range.

### At the app's own operating points

| payload | chunk | framing | frame bytes | envelope | QR ver | wire bytes | wire eff. |
|---|---|---|---|---|---|---|---|
| `rvf_wasm_bg.wasm` | 512 B | v1 JSON | 741 B | 44.7% | 19 | 59,551 | 68.8% |
| `rvf_wasm_bg.wasm` | 512 B | v2 armoured | 618 B | 20.7% | **17** | 49,610 | 82.6% |
| `rvf_wasm_bg.wasm` | 512 B | v2 binary | 540 B | 5.5% | **16** | 43,348 | 94.6% |
| `rvf_wasm_bg.wasm` | 1024 B | v1 JSON | 1424 B | 39.1% | 27 | 57,232 | 71.6% |
| `rvf_wasm_bg.wasm` | 1024 B | v2 armoured | 1203 B | 17.5% | **25** | 48,290 | 84.9% |
| `rvf_wasm_bg.wasm` | 1024 B | v2 binary | 1052 B | 2.7% | **23** | 42,228 | 97.1% |

Read this table the other way round and it is the more useful result: **at a
fixed 512-byte chunk, v2 armoured drops the symbol from version 19 to version
17.** §8's robustness sweep puts the blur cliff between versions 19 and 22, so a
smaller version at the same payload is bought robustness, not throughput. That
is a different and arguably better use of the same saving.

### The 739-versus-741 discrepancy, resolved

`proto2.js`'s docblock says a v1 data frame is 739 bytes for a 512-byte chunk,
44.3% overhead. Other notes in this project say 741 bytes, 44.7%. **Both are
right, and neither is a constant.** v1's `i` and `n` fields are decimal, so a
frame gains a byte at each power of ten:

| payload | data frames | full-frame range | envelope range | distribution |
|---|---|---|---|---|
| `ruvnet-demo.rvf` | 5 | 739 B | 44.3% | 398→1, 739→4 |
| `rvf_wasm_bg.wasm` | 81 | 740–741 B | 44.5%–44.7% | 97→1, 740→9, 741→71 |

739 is the six-frame transfer's figure and 741 is the 82-frame transfer's. Any
single "a v1 frame is N bytes" statement is a statement about one transfer size.
The last frame in each row is short because it carries the remainder, which is
why it is excluded from the percentage columns and kept in the histogram.

## 2. Compression, judged on the whole envelope

`node bench/index.mjs --suite compress`

A compression ratio is not a reason to compress. What decides it is whether the
**complete transport envelope** shrinks: compressed payload, plus the 28-byte
header on every frame, plus the manifest frame, plus the armour. Compression
removes payload bytes and leaves the per-frame cost alone, so a good ratio on a
small artifact can still lose.

Every cell reports both numbers. **Ratio** is the codec's. **Envelope gain** is
`1 − envelope(compressed)/envelope(original)` at 512 bytes per frame, v2
armoured — the transport's number, and the only one that should gate a decision.
The gate used here is an **envelope gain of at least 8%**; that threshold is a
policy choice, stated rather than buried, and the raw JSON allows re-reading
every table against a different one. The envelope arithmetic was checked against
frames the real `proto2.buildFrames` produced at 15 size/chunk combinations and
matched exactly, armoured and unarmoured.

**This section was re-run on its own at 2026-08-03T20:52:14Z**, after
`artifacts/compress.js` landed, and every number in §2 comes from that run. The
rest of this document is from the 16:44:39Z run recorded above. The two agree
on the machine, the seed and the demo artifacts, which have not changed; they
disagree on `artifacts/app.js` and `standalone.html`, which grew in between and
are reported below at the sizes this run saw them.

**Read the Node and browser figures as two environments, not one.** §2's codec
tables run `node:zlib`. The shipped app runs in a browser, which has neither
codec ADR-003 §2.1 selected — see "The same decision in a browser" below, which
is where the numbers a user of the web app would actually get are reported.

### The corpus

| artifact | bytes | Brotli-6 | ratio | envelope gain | best codec | best ratio | best gain |
|---|---|---|---|---|---|---|---|
| `artifacts/demo/ruvnet-demo.rvf` | 2,304 | 1,745 B | 1.320× | 23.2% | brotli-9 | 1.326× | 23.5% |
| `artifacts/demo/rvf_wasm_bg.wasm` | 40,989 | 16,636 B | 2.464× | 59.3% | brotli-11 | 2.767× | 63.7% |
| `artifacts/core.js` | 51,683 | 15,851 B | 3.261× | 69.2% | brotli-11 | 3.679× | 72.7% |
| `artifacts/app.js` | 206,829 | 55,314 B | 3.739× | 73.2% | brotli-11 | 4.176× | 76.0% |
| `standalone.html` | 950,817 | 253,636 B | 3.749× | 73.3% | brotli-11 | 4.239× | 76.4% |
| synthetic float32 vectors | 16,384 | 14,929 B | 1.097× | 8.7% | brotli-11 | 1.103× | 9.1% |

**The three reference points this was asked to reproduce independently, all
reproduced.** 40,989 → 16,636 at Brotli-6, ratio 2.464× — the same byte count.
2,304 → 1,745, ratio 1.320× — the same byte count. The standalone app reproduces
only approximately, and the reason is instructive: 3.749× against a previously
reported 3.53×, on a file that has now reached 950,817 bytes from the 503,216
the earlier figure was taken against. The ratio is the near-reproducible
quantity; the byte count is a measurement of a file that has been measured at
five different sizes across this session — 503,216, then 507,527, then 572,166,
then 849,284, and 950,817 here. `artifacts/app.js` moved during this section's
own measurements too: 182,189 bytes at 20:38:19Z, then 194,163, 204,901 and
206,829 at 20:52:14Z, which is the run reported. Its byte count moved by 14%
across those fourteen minutes and its Brotli-11 ratio by 0.012×, from 4.165 to
4.177 — which is the general shape of this problem in one artifact: the ratio is
the quantity that travels, the byte count is not.

The float32 row is the case the corpus would otherwise flatter away. It is
synthetic, generated from the harness seed, in the shape an RVF `VEC` span
carries — IEEE-754 mantissas are close to incompressible and a corpus of only
source code and WASM would make compression look uniformly free.

### Encode and decode cost

| artifact | zstd-6 enc | zstd-6 dec | brotli-6 enc | brotli-6 dec | brotli-11 enc |
|---|---|---|---|---|---|
| `ruvnet-demo.rvf` (2.3 KB) | 0.03 ms | 0.01 ms | 0.05 ms | 0.01 ms | 2.4 ms |
| `rvf_wasm_bg.wasm` (41 KB) | 0.37 ms | 0.06 ms | 0.64 ms | 0.10 ms | 37.0 ms |
| `artifacts/app.js` (207 KB) | 1.69 ms | 0.18 ms | 2.77 ms | 0.30 ms | 183.0 ms |
| `standalone.html` (951 KB) | 6.88 ms | 0.71 ms | 15.31 ms | 1.39 ms | 986.7 ms |

Decode is the number that matters, because it is on the receiver's critical
path, and it is negligible: 1.39 ms for 951 KB. Encode at Brotli-11 is not —
987 ms for the standalone app — but it is a sender-side one-off before the
first frame is painted, against a transfer measured in minutes.

ADR-003 §2.3 reports Brotli-6 encoding `standalone.html` at 503,216 bytes in
8.38 ms, about 57 MB/s. This harness measures 950,817 bytes in 15.31 ms, about
59 MB/s, on a file 1.89× the size the ADR measured — an independent
corroboration rather than a restatement, and close enough that ADR-003's
"compress the whole thing and compare up to 8 MB" policy is well founded. The
ADR's ratio is re-measured against the current file below, under "ADR-003's
figures against the file as it is now".

**These are Node's builds, and the browser does not have them.** A browser's
`DecompressionStream` supports `deflate`, `deflate-raw` and `gzip` only. Brotli
decompression is available to a browser for HTTP content encoding, not as a
JavaScript API. So the Brotli decode timings above stand in for a decoder the
app does not currently have; shipping `codecId 3` means shipping a Brotli
decoder in the payload or falling back to `deflate-raw`. `proto2.js` also
declares `CODEC_SCF1`, the zero-dependency LZ77 codec from the RVF runtime,
which has no JavaScript implementation in this repository and is therefore
absent from every table rather than estimated.

### Break-even: below what size does compression stop paying?

Prefixes of each artifact were compressed for real at every size, so the ratio
at each point is measured rather than extrapolated from the whole file's ratio.

| artifact | compression LOSES at or below | reaches the 8% gate at | ratio at 512 B | ratio at 4 KB |
|---|---|---|---|---|
| `ruvnet-demo.rvf` | never in range | 64 B | 1.40× | — |
| `rvf_wasm_bg.wasm` | never in range | 64 B | 1.45× | 2.29× |
| `artifacts/core.js` | **64 B** | 128 B | 1.72× | 2.17× |
| `artifacts/app.js` | never in range | 256 B | 1.61× | 2.31× |
| `standalone.html` | never in range | 64 B | 2.06× | 2.35× |
| synthetic float32 vectors | **128 B** | **6,144 B** | 1.06× | 1.09× |

**There is no single break-even size — there is a break-even per content
type,** and the spread is two orders of magnitude. Text-like content clears the
gate at 64–256 bytes. Float vectors, the thing an RVF container is mostly made
of, do not clear it until 6 KB and actively lose below 128 bytes. A codec
selector that switches on size alone would be wrong for exactly the payload
this project exists to carry; it has to switch on measured gain.

A prefix of a file is not a smaller file of the same kind — the first 512 bytes
of a WASM module are its header, which compresses differently from its code — so
these break-evens bound the answer rather than being it.

### What the sender actually decides

Everything above measures the **codecs**: this harness compresses with
`node:zlib` and applies the gate itself. Since `artifacts/compress.js` landed
there is a second question, and it is not the same one — not "how much does
Brotli save" but "what does the sender choose, and does it choose it for the
right reason". So the suite now also drives that module end to end.

**The module's own unit tests prove nothing about ratios, deliberately.** Most
of `compress.test.js` injects stub codecs that return a fixed size, so its
verdicts are arithmetic a reader can check by hand and are independent of what
the machine running them has installed. Everything in this subsection injects
the real `node:zlib` codecs, keyed by codec **name**, which is the key
`compressWith` looks up — a map keyed by numeric id fails with
`codec-unavailable`.

The levels are part of the measurement and not a property of the module:
`compressArtifact` takes its codecs as an injected map and has no parameter
that could turn Brotli-11 into Brotli-4. Injected here: **brotli-11, zstd-3,
deflate-raw-9**. The envelope is at **764 bytes per frame** — the module's own
`DEFAULT_CHUNK_BYTES`, not the 512 the tables above use — v2 armoured, gate 8%.
`nameLen` is each artifact's real basename length, because the manifest frame
carries the name and its length is a term in the envelope.

| artifact | bytes | class | codec chosen | payload gain | envelope gain | margin | frames | wire bytes | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `artifacts/demo/ruvnet-demo.rvf` | 2,304 | rvf | **brotli** (id 4) | 24.22% | 23.37% | +15.37 pt | 5 → 4 | 2,867 → 2,197 | pass |
| `artifacts/demo/rvf_wasm_bg.wasm` | 40,989 | wasm | **brotli** (id 4) | 63.86% | 63.69% | +55.69 pt | 55 → 21 | 48,722 → 17,692 | pass |
| `artifacts/core.js` | 51,683 | generic | **brotli** (id 4) | 72.82% | 72.68% | +64.68 pt | 69 → 20 | 61,394 → 16,772 | pass |
| `artifacts/app.js` | 206,829 | generic | **brotli** (id 4) | 76.05% | 76.02% | +68.02 pt | 272 → 66 | 245,373 → 58,829 | pass |
| `standalone.html` | 950,817 | html | **brotli** (id 4) | 76.41% | 76.40% | +68.40 pt | 1246 → 295 | 1,127,658 → 266,105 | pass |
| synthetic float32 vectors | 16,384 | generic | **brotli** (id 4) | 9.31% | 9.26% | +1.26 pt | 23 → 21 | 19,546 → 17,736 | **marginal pass** |
| incompressible random bytes | 40,000 | generic | **none** (id 0) | −0.01% | −0.01% | −8.01 pt | 54 → 54 | 47,553 → **47,558** | **declined** |

Six of seven are compressed and one is refused. Two rows are the ones worth
reading:

**The declined row grows the envelope.** 40,000 bytes of mulberry32 output from
the harness seed — deterministic, and reproducibly incompressible: the best of
the three codecs returns 40,004 bytes, four more than it was given. The
envelope goes from 47,553 to 47,558 bytes, five worse, and not one of the 54
frames is saved. The repository ships no artifact a codec loses on, so this
case is generated; without it the gate would never be observed saying no to
anything.

**The marginal row is the one the threshold actually decides.** Float32 vectors
clear by 1.26 points. "Marginal" is this document's word and not the module's —
it passes or it does not — and the label is here so a reader can tell a decision
that was never close from one that turned on the threshold. Every other real
artifact clears by 15 to 68 points, which is to say the gate is doing no work at
all on them.

**Every codec that was offered, and whether the bytes came back.** A ratio
without a verified round trip is a claim about a byte count, so each stream is
decompressed and compared against the original. Encode and decode are the
harness's medians over three runs, not the module's: nothing in `compress.js`
reads a clock, so no timing here can have moved a verdict.

| artifact | codec | compressed | ratio | payload gain | envelope gain | frames | encode | decode | round trip | gate |
|---|---|---|---|---|---|---|---|---|---|---|
| `ruvnet-demo.rvf` | zstd-3 | 1,811 B | 1.272× | 21.40% | 20.79% | 5 → 4 | 0.01 ms | 0.01 ms | exact | pass |
| `ruvnet-demo.rvf` | **brotli-11** | 1,746 B | 1.320× | 24.22% | 23.37% | 5 → 4 | 2.27 ms | 0.02 ms | exact | **chosen** |
| `ruvnet-demo.rvf` | deflate-raw-9 | 1,798 B | 1.281× | 21.96% | 21.31% | 5 → 4 | 0.05 ms | 0.01 ms | exact | pass |
| `rvf_wasm_bg.wasm` | **brotli-11** | 14,815 B | 2.767× | 63.86% | 63.69% | 55 → 21 | 36.74 ms | 0.14 ms | exact | **chosen** |
| `rvf_wasm_bg.wasm` | zstd-3 | 18,185 B | 2.254× | 55.63% | 55.51% | 55 → 25 | 0.11 ms | 0.04 ms | exact | pass |
| `rvf_wasm_bg.wasm` | deflate-raw-9 | 18,013 B | 2.276× | 56.05% | 55.92% | 55 → 25 | 0.53 ms | 0.07 ms | exact | pass |
| `core.js` | zstd-3 | 17,517 B | 2.950× | 66.11% | 66.01% | 69 → 24 | 0.11 ms | 0.05 ms | exact | pass |
| `core.js` | **brotli-11** | 14,047 B | 3.679× | 72.82% | 72.68% | 69 → 20 | 39.79 ms | 0.10 ms | exact | **chosen** |
| `core.js` | deflate-raw-9 | 16,584 B | 3.116× | 67.91% | 67.80% | 69 → 23 | 1.15 ms | 0.07 ms | exact | pass |
| `app.js` | zstd-3 | 62,305 B | 3.320× | 69.88% | 69.84% | 272 → 83 | 0.60 ms | 0.17 ms | exact | pass |
| `app.js` | **brotli-11** | 49,526 B | 4.176× | 76.05% | 76.02% | 272 → 66 | 183.38 ms | 0.40 ms | exact | **chosen** |
| `app.js` | deflate-raw-9 | 59,079 B | 3.501× | 71.44% | 71.40% | 272 → 79 | 5.74 ms | 0.21 ms | exact | pass |
| `standalone.html` | **brotli-11** | 224,300 B | 4.239× | 76.41% | 76.40% | 1246 → 295 | 997.11 ms | 1.69 ms | exact | **chosen** |
| `standalone.html` | zstd-3 | 282,712 B | 3.363× | 70.27% | 70.26% | 1246 → 372 | 2.59 ms | 0.75 ms | exact | pass |
| `standalone.html` | deflate-raw-9 | 283,233 B | 3.357× | 70.21% | 70.20% | 1246 → 372 | 26.20 ms | 1.41 ms | exact | pass |
| float32 vectors | zstd-3 | 14,948 B | 1.096× | 8.76% | 8.73% | 23 → 21 | 0.02 ms | 0.02 ms | exact | pass |
| float32 vectors | **brotli-11** | 14,858 B | 1.103× | 9.31% | 9.26% | 23 → 21 | 25.11 ms | 0.11 ms | exact | **chosen** |
| float32 vectors | deflate-raw-9 | 14,939 B | 1.097× | 8.82% | 8.78% | 23 → 21 | 0.11 ms | 0.05 ms | exact | pass |
| random bytes | zstd-3 | 40,010 B | 1.000× | −0.03% | −0.03% | 54 → 54 | 0.03 ms | 0.01 ms | exact | FAIL |
| random bytes | **brotli-11** | 40,004 B | 1.000× | −0.01% | −0.01% | 54 → 54 | 5.51 ms | 0.01 ms | exact | FAIL |
| random bytes | deflate-raw-9 | 40,015 B | 1.000× | −0.04% | −0.04% | 54 → 54 | 0.32 ms | 0.01 ms | exact | FAIL |

**All 21 codec runs round-tripped byte-exactly**, and re-encoding reproduced the
exact length the module had decided on in every case — so a verdict here is a
property of the bytes rather than of the run.

Brotli wins every artifact it is offered on, which is not a close contest at
these levels: it beats zstd-3 by 6 to 8 points of envelope on the text-like
artifacts and by 8 points on the WASM module, at 40× to 360× the encode time.
Whether that trade is right is a sender-side latency question this document does
not settle; what it settles is that the choice is not arbitrary and that the
loser is never wrong by a rounding error.

### The same decision in a browser, which has neither codec ADR-003 chose

Every figure above runs `node:zlib`. **rvQR runs in a browser**, and the WHATWG
Compression Streams format list is exactly `gzip`, `deflate`, `deflate-raw` —
no `br`, no `brotli`, no `zstd`. ADR-003 §2.1 makes Zstd the default and Brotli
the maximum-ratio option, so **the shipped web app can run neither of them**,
and every Brotli and Zstd number above is a Node measurement of a codec no user
of the web app will execute. (The format list is the specification's; a probe of
a real Chromium 140 outside this harness confirmed it, with `br`, `brotli` and
`zstd` all throwing on construction. That probe is not this harness's
measurement and is not reported as one — what this harness measures is the
consequence.)

So the rows below are a second environment, not a caveat on the first. They are
measured through the real `CompressionStream('deflate-raw')`. That codec is
asynchronous and `compressArtifact` is synchronous, so it cannot be injected
into the module's own path at all; the stream is run for real, its output length
measured, and the length put through the module's `choose()`, which takes sizes
rather than codecs for exactly this reason. The verdict is the module's, and
only the bytes come from somewhere its synchronous path cannot reach.

Presented a browser-shaped platform — the stream constructors and no `zlib` —
the module detects **deflate-raw** (id 6, via `CompressionStream`, dictionary
**no**) and nothing else, and refuses the other two by name rather than by
omission.

| artifact | bytes | browser: deflate-raw | gain | frames | Node: best codec | gain | frames | Brotli's edge | extra frames |
|---|---|---|---|---|---|---|---|---|---|
| `ruvnet-demo.rvf` | 2,304 | 1,804 B | 21.07% | 5 → 4 | brotli, 1,746 B | 23.37% | 5 → 4 | +2.30 pt | none |
| `rvf_wasm_bg.wasm` | 40,989 | 18,014 B | 55.91% | 55 → 25 | brotli, 14,815 B | 63.69% | 55 → 21 | +7.77 pt | +4 |
| `artifacts/core.js` | 51,683 | 16,619 B | 67.73% | 69 → 23 | brotli, 14,047 B | 72.68% | 69 → 20 | +4.95 pt | +3 |
| `artifacts/app.js` | 206,829 | 59,252 B | 71.32% | 272 → 79 | brotli, 49,526 B | 76.02% | 272 → 66 | +4.70 pt | +13 |
| `standalone.html` | 950,817 | 284,013 B | 70.12% | 1246 → 373 | brotli, 224,300 B | 76.40% | 1246 → 295 | +6.28 pt | +78 |
| float32 vectors | 16,384 | 14,939 B | 8.78% | 23 → 21 | brotli, 14,858 B | 9.26% | 23 → 21 | +0.48 pt | none |
| random bytes | 40,000 | *declined* | −0.04% | 54 → 54 | *declined* | −0.01% | 54 → 54 | — | none |

**deflate-raw gets most of the way there, and that is the headline.** Brotli's
edge across the six artifacts both environments compress is **0.48 to 7.77
points** of envelope gain. In the quantity a receiver actually experiences —
frames it has to sit and watch — the worst case is `standalone.html`, 295 frames
under Brotli against 373 under deflate-raw, **26% more**. That is a real cost
and it is not a crippling one. The browser limitation is worth single-digit
percentage points of envelope, not a factor, and the right reading is that the
web app compresses nearly as well as the best codec available anywhere — not
that it is missing compression.

Both environments reach the same compress-or-not verdict on every artifact: the
gate is far enough from the margin that the codec difference never flips it
here. Note that the float32 row clears by 0.78 points in a browser against 1.26
in Node — the marginal case gets more marginal, and a slightly weaker codec is
what would tip it.

**A browser has no compression level to raise.**
`CompressionStream('deflate-raw')` produced byte-identical output to
`deflateRawSync(bytes, { level: 6 })` on **7 of 7** artifacts. So the
deflate-raw column is not a setting anyone can tune; it is the whole of what is
on offer. The deflate-raw-9 rows in the Node table above are 0 to 780 bytes
smaller — 780 on `standalone.html`, 0 on both synthetic artifacts — and none of
that margin is reachable from a browser.

**And the synchronous path fails closed on an asynchronous codec.** Injecting a
`compress` that returns a Promise throws `CompressError` with reason
`bad-compressed-size` — "compressedBytes must be a size or a buffer". A Promise
has no `length` and no `byteLength`, so the module cannot read a size out of it
and refuses at the point of measurement, before any decision is taken. That is
worth recording as a property rather than a caveat: the failure mode of wiring a
browser codec into the sync path is a thrown error with a stable reason, not a
manifest describing a stream nobody produced.

### The chosen identifier is one `proto2.js` refuses

`compress.js` works from ADR-003 §2.1's seven-entry codec table. `proto2.js`
ships a four-entry one. They agree on exactly one id:

| codec id | ADR-003 §2.1 | `proto2.js` | agree? |
|---|---|---|---|
| 0 | none | none | yes |
| 1 | lz4 | scf1 | **no** |
| 2 | zstd | deflate-raw | **no** |
| 3 | custom | brotli | **no** |
| 4 | brotli | *(refused: unknown-codec)* | **no** |
| 5 | scf1 | *(refused: unknown-codec)* | **no** |
| 6 | deflate-raw | *(refused: unknown-codec)* | **no** |

**Every one of the six compressing decisions above names codec id 4, and
`proto2.parseFrame` rejects id 4 on the first frame with `unknown-codec`** —
its `CODEC_NAMES` has four entries, so 4 is out of range. Nor is there a codec
that would work instead: zstd is id 2 here and id 2 means deflate-raw in
`proto2.js`, which is the ADR-027 §2.2 defect exactly (a receiver decoding with
the wrong codec), and deflate-raw is id 6, also out of range. The only
wire-compatible decision available today is **id 0, no compression**.

Nothing in this suite changes either file. `compress.js` reports the divergence
itself through `wireCompatible()`, and this table is that function's output. The
gains in the tables above are real; they are not *available* until `proto2.js`
adopts the §2.1 table.

### The gate's two disagreements with a payload rule, both directions

The reason to gate on the envelope rather than on the ratio is that the two
disagree. `compress.js`'s docblock publishes six size pairs said to land in the
band where the payload clears 8% and the envelope does not. Those are
arithmetic, not measurements, so they were re-derived here through the module's
own `evaluate()` — **all six reproduce the docblock's figures exactly**,
including the frame counts, so that table is the module's arithmetic rather
than a recollection of it.

The more interesting question is whether the band occurs on real bytes. Prefixes
of every corpus artifact were compressed for real with brotli-11 at 20 sizes
from 512 B to 32 KB, each point evaluated by the module:

| artifact | sizes scanned | payload passes, envelope fails | envelope passes, payload fails | envelope grew | first size that clears | verdict flips |
|---|---|---|---|---|---|---|
| `ruvnet-demo.rvf` | 8 | — | — | — | 512 B | 0 |
| `rvf_wasm_bg.wasm` | 20 | — | — | — | 512 B | 0 |
| `artifacts/core.js` | 20 | — | — | — | 512 B | 0 |
| `artifacts/app.js` | 20 | — | — | — | 512 B | 0 |
| `standalone.html` | 20 | — | — | — | 512 B | 0 |
| synthetic float32 vectors | 18 | **2,816 B** (8.20% / 7.65%), **3,584 B** (8.29% / 7.80%) | **2,304 B** (7.81% / 8.31%) | — | 2,304 B | **5** |
| incompressible random bytes | 20 | — | — | every size scanned | never in range | 0 |

**The band is real on real bytes, in both directions, and only on the content
this project exists to carry.** At 2,816 bytes of float32 the payload sheds
8.20% and the envelope only 7.65%, because the frame count is 5 either way: a
payload rule turns compression on there and buys the receiver nothing but a
decompressor on its critical path. At 2,304 bytes it runs the other way — the
payload sheds 7.81% and the **envelope 8.31%**, because a frame dropped out, and
dropping a frame removes its 28-byte header and its armour padding as well as
its payload. A payload rule refuses that one, and refusing it is wrong.

So the envelope rule is not a stricter payload rule. It is a different rule,
which says yes and no in places the payload rule cannot see, and it disagrees in
both directions on the same 1,300-byte stretch of the same artifact.

**And the verdict is not monotone in size.** Float32 flips five times across
eighteen sizes: 512 B fails, 2,304 B passes, 2,560 B fails, 3,072 B passes,
3,584 B fails, 4,096 B passes and it stays passing. The ratio climbs smoothly
and the frame count is a step function, so a slightly *larger* artifact can fall
back below the gate. There is no single break-even size — the break-even table
above reports the first crossing, which for this content is not the last, and
the "6,144 B" it gives for float32 is a different measurement again (brotli-6 at
a 512-byte chunk, where this scan is brotli-11 at 764). Both are correct about
what they measured; neither is a break-even for the content in general.

### The >8 MB prefix branch, exercised below 8 MB

ADR-003 §2.3 compresses an artifact whole up to 8 MB and estimates on a bounded
prefix above it. **This repository ships nothing that reaches 8 MB**, so that
branch would go entirely unmeasured unless the threshold moved. It was moved —
`sampleAbove` 32,768 B, `samplePrefix` 16,384 B — and that is the only thing in
this table that is not the shipped configuration. The estimate runs at
brotli-4/zstd-1/deflate-1 and the full encode at brotli-11/zstd-3/deflate-9,
which is the `sampleCodecs` seam §2.3 asks for.

| artifact | bytes | whole-artifact decision | sampled decision | same? | declined on the prefix |
|---|---|---|---|---|---|
| `rvf_wasm_bg.wasm` | 40,989 | brotli, 14,815 B (63.69%) | brotli, 14,815 B (63.69%) | yes | — |
| `artifacts/core.js` | 51,683 | brotli, 14,047 B (72.68%) | brotli, 14,047 B (72.68%) | yes | — |
| `artifacts/app.js` | 206,829 | brotli, 49,526 B (76.02%) | brotli, 49,526 B (76.02%) | yes | — |
| `standalone.html` | 950,817 | brotli, 224,300 B (76.40%) | brotli, 224,300 B (76.40%) | yes | — |
| incompressible random bytes | 40,000 | none, 40,000 B | none, 40,000 B | yes | zstd −0.06%, brotli −0.03%, deflate-raw −0.04% |

The prefix reached the same decision as the whole artifact in all five rows, and
no codec was declined on a prefix that would have cleared the gate on the whole
artifact — so at these sizes the shortcut costs nothing. That is a property of
these artifacts and not a guarantee: a declining estimate is **final** for that
codec, which is §2.3's flow rather than an oversight, so a file whose first
megabyte compresses badly and whose remainder compresses well is refused without
ever being measured. Nothing in the module detects that case, and nothing here
constructs one.

### ADR-003's figures against the file as it is now

ADR-003 §2.3's table cites `standalone.html` at **503,216 bytes** compressing
**3.535×** under Brotli in 8.38 ms. The file is now 950,817 bytes — 447,601
more, 1.89× the size the ADR measured.

| quality | bytes in | bytes out | ratio | encode | throughput | decode | round trip |
|---|---|---|---|---|---|---|---|
| brotli-6 | 950,817 | 253,636 | **3.749×** | 15.02 ms | 60.4 MB/s | 1.31 ms | exact |
| brotli-11 | 950,817 | 224,300 | 4.239× | 994.10 ms | 0.9 MB/s | 1.71 ms | exact |

**The discrepancy, stated rather than absorbed: 3.749× measured against the
ADR's 3.535×, a difference of +0.214, on a file 1.89× the size.** Nothing in
ADR-003 has been edited by this run and nothing should be — its figures were
true of the file it measured, and a decision record whose evidence silently
updates itself stops being a record. What survives the file changing is the
ratio and the throughput: 60.4 MB/s here against 57.3 MB/s there, close enough
that §2.3's "compress the whole thing and compare, up to 8 MB" still costs a
fraction of a second on anything this repository holds. What does not survive is
the byte count, and any figure quoted against 503,216 bytes is a measurement of
a different file.

## 3. Baseline versus fountain under loss

`node bench/index.mjs --suite loss`

Payload `artifacts/demo/rvf_wasm_bg.wasm`, 40,989 bytes, 512 bytes per frame.
Baseline needs 82 distinct frames; the fountain block is K=81. Independent (iid)
erasures, 500 trials per cell.

| transport | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 / 82 | 193 / 283 | 271 / 389 | 357 / 532 | 452 / 696 | 596 / 885 | 800 / 1156 |
| **fountain (shipped)** | **86 / 86** | **95 / 102** | **108 / 116** | **122 / 135** | **142 / 159** | **171 / 196** | **214 / 245** |
| fountain (`rlf-sys`, reference) | 86 / 86 | 97 / 104 | 110 / 119 | 124 / 137 | 145 / 165 | 175 / 199 | 217 / 249 |
| fountain (`rlf`, reference) | 87 / 87 | 97 / 105 | 110 / 119 | 124 / 137 | 145 / 164 | 175 / 200 | 218 / 249 |
| fountain (`lt`, reference) | 124 / 124 | 139 / 164 | 158 / 179 | 178 / 213 | 204 / 243 | 245 / 299 | 308 / 391 |

Cells are mean / p95 frame slots.

| loss | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| speedup, iid channel | 0.95× | 2.03× | 2.52× | 2.92× | 3.18× | 3.47× | 3.75× |
| speedup, burst channel (mean burst 4) | 0.95× | 1.62× | 2.12× | 2.49× | 2.97× | 3.25× | 3.71× |

**Why the baseline degrades the way it does.** rvQR v1 cycles through a fixed
list, so a frame the receiver missed can only be replaced by that same frame
coming round again. Every distinct index must survive at least one pass, so the
number of passes is the maximum of 82 geometric variables — it grows like
log(K)/log(1/p). The classic coupon-collector bound for a sender emitting
*random* indices would be K·H_K ≈ 409 deliveries; the cyclic sender does better
than that but pays the same log-K factor. A fountain pays no such factor.

### Reception overhead — two different things, kept apart

**Coding overhead** is what the code costs: payload frames beyond the minimum
*at the moment the receiver could first reconstruct*.

| transport | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| rvQR v1 | 0.00 | 131.94 | 187.08 | 235.05 |
| **fountain (shipped)** | **0.000** | **0.004** | **0.004** | **0.004** |
| `rlf-sys` (reference) | 0.00 | 1.58 | 1.80 | 1.45 |
| `lt` (reference) | 36.00 | 38.07 | 35.57 | 36.09 |

Across all 3,500 iid trials at K=81 the shipped codec needed zero extra symbols
in 3,485 and exactly one in the remaining 15. **Finishing overhead** — frames
beyond the minimum by the time the transfer completed — includes symbols that
arrived while the receiver held full rank and waited for a manifest. On K=81
they are nearly identical; on a small object they diverge violently (§5).

## 4. Reception overhead at the codec

`node bench/index.mjs --suite overhead`

2,200 decodes, K ∈ {4, 8, 16, 32, 64, 81, 128, 200, 320, 500, 800}, 512-byte
symbols, 45% independent loss, every result verified against SHA-256 of the
source. Zero verification failures.

**Aggregate: 98.45% at exactly K, 100% by K+1, mean +0.0155, worst +1.**

### Cross-check against the author's own measurements

`artifacts/fountain.js`'s author measured the same property independently.
Neither set was derived from the other.

| | author, 2,000 decodes **[CITED]** | this harness, 2,200 decodes **[MEASURED]** |
|---|---|---|
| decoded at exactly K | 98.20% | 98.45% |
| by K+1 | 99.95% | 100% |
| by K+2 | 100% | 100% |
| mean overhead | +0.0185 | +0.0155 |
| worst case | +2 | +1 |

They agree. The only divergence is a single +2 event in their sample and none in
ours, which at a rate of roughly 1 in 2,000 is what two samples of this size
should be expected to disagree about.

That rate is in line with what RaptorQ publishes for itself — >99% recovery at
zero overhead, >99.99% at one symbol, >99.9999% at two ([Raptor code,
Wikipedia](https://en.wikipedia.org/wiki/Raptor_code); these figures originate
with Luby et al. and are **not** tabulated in
[RFC 6330](https://www.rfc-editor.org/rfc/rfc6330.html) itself) **[CITED]**.
This is a structural analogue compared against a standard's published behaviour,
not a conformance claim.

### Decode cost against symbol size

The 40,989-byte payload split into progressively smaller symbols — the trade the
chunk-size slider makes, since the decoder solves a system growing as K²·(K+T).

| symbol size | K | encoder setup | decode (systematic) | decode (repair only) | author's figure **[CITED]** |
|---|---|---|---|---|---|
| 1024 B | 41 | 0.68 ms | 1.98 ms | 1.73 ms | 1.9 ms |
| 512 B | 81 | 0.73 ms | 2.63 ms | 2.45 ms | 2.72 ms |
| 256 B | 161 | 2.36 ms | 4.72 ms | 4.32 ms | 7.8 ms |
| 128 B | 321 | 5.72 ms | 11.22 ms | 11.81 ms | 12.2 ms |
| 64 B | 641 | 21.78 ms | 33.85 ms | 30.80 ms | 31 ms |

**These timings moved between runs and the previous revision of this document
reported higher ones** — 2.65/3.86/6.59/15.11/51.28 ms for the systematic
column. Nothing about the code changed; this run executes five more suites
before reaching this one, so the JIT is warmer. The frame counts, symbol counts
and K values in the same table are identical across runs. Treat the millisecond
column as good to about ±40% on this machine and as a lower bound for a phone.

## 5. Where the fountain loses: small objects and the manifest

Payload `artifacts/demo/ruvnet-demo.rvf`, 2,304 bytes. Baseline needs 6 frames;
the fountain block is K=5.

| transport | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| rvQR v1 | 6 / 6 | 11 / 20 | 17 / 32 | 31 / 59 |
| fountain (shipped) | 6 / 6 | 11 / 21 | 19 / 61 | 36 / 101 |

This is not a coding failure. The receiver reaches full rank after five symbols
and then *waits*, because it cannot verify or name the object without the
manifest, which the harness's fountain stream repaints only every 20 slots.
Measured at the moment of full rank the coding overhead is 0.03 symbols; the
8.5-symbol finishing overhead at 60% loss is entirely manifest wait.

Sweeping the repaint interval, mean / p95 slots:

**K=5 (2,304-byte container)**

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| **4 slots** | 7 / 7 | **9 / 12** | **12 / 18** | **18 / 30** |
| 8 slots | 6 / 6 | 8 / 12 | 12 / 25 | 20 / 41 |
| 20 slots | 6 / 6 | 11 / 21 | 19 / 61 | 36 / 101 |
| 32 slots | 6 / 6 | 13 / 33 | 25 / 65 | 54 / 161 |

**K=81 (40,989-byte module)**

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| 4 slots | 108 / 108 | 136 / 148 | 180 / 203 | 270 / 306 |
| 20 slots | 86 / 86 | 108 / 116 | 142 / 159 | 214 / 245 |
| **32 slots** | **84 / 84** | **106 / 115** | **140 / 158** | **211 / 244** |

The optimum moves in opposite directions at the two ends. Any fixed constant is
wrong at one end or the other; something on the order of `clamp(K/2, 4, 32)`
matches the measured optimum at both. This is a finding about the harness's
framing choice, not about `artifacts/fountain.js` — the codec does not specify
how the manifest travels.

## 6. Real payloads

`node bench/index.mjs --suite payloads`

**`ruvnet-demo.rvf`** — 2,304 B, an RVF container (segment magic `53 46 56 52`
at offset 0). Four spans: MANIFEST(162), VEC(1798), WITNESS(132), MANIFEST(212).

| rate | frames | QR ver (L) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|
| 512 B @ 5 fps | 6 | 8–19 | 3,534 | 65.2% | 1.2 | 1.88 KB/s | 2.50 KB/s |
| 1024 B @ 10 fps | 4 | 8–27 | 3,423 | 67.3% | 0.4 | 5.63 KB/s | 10.00 KB/s |

**`rvf_wasm_bg.wasm`** — 40,989 B, `@ruvector/rvf-wasm` 0.1.9.

| rate | frames | QR ver (L) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|
| 512 B @ 5 fps | 82 | 5–19 | 59,551 | 68.8% | 16.4 | 2.44 KB/s | 2.50 KB/s |
| 1024 B @ 10 fps | 42 | 5–27 | 57,232 | 71.6% | 4.2 | 9.53 KB/s | 10.00 KB/s |

The README's claims check out: it says the 40 KB demo takes "about 16 seconds"
at 5 fps and that the app moves "2.5 KB/s at the defaults and 10 KB/s flat out".
Measured: 16.4 seconds, 2.44 KB/s and 9.53 KB/s.

## 7. Delta transfer

`node bench/index.mjs --suite delta`

`artifacts/delta.js` driven end to end on the 2,304-byte demo container.

| changed span | span bytes | delta payload | inventory | wire ratio | byte-exact? |
|---|---|---|---|---|---|
| #0 MANIFEST | 162 | 306 B | 134 B | 5.24× | yes |
| #1 VEC | 1798 | 1942 B | 134 B | 1.11× | yes |
| #2 WITNESS | 132 | 276 B | 134 B | 5.62× | yes |
| #3 MANIFEST | 212 | 356 B | 134 B | 4.70× | yes |

**This is a small-container result and the ratios are correspondingly small.**
Changing the VEC segment, 78% of the container, saves 11%. Changing WITNESS, 6%
of it, saves 82%. The 5.6× best case is a statement about a 2.3 KB file with
four spans and does not generalise upward on its own. The large-container
projection is in §13.

One figure confirmed independently: the demo container's inventory encodes to
**134 base64url bytes, exactly a version 6-L QR symbol's capacity**. The
receiver's half of a delta handshake is a single low-density symbol, which is
the part of the design that has to work on a shaky handheld camera.

### Semantic delta: diffing inside the segments

`node bench/index.mjs --suite semdelta`

`artifacts/semdelta.js` goes one level below the span plan above, decomposing
the segments it can parse safely into *units* — vector records, WASM sections
and function bodies, COW cluster-map blocks, membership-bitmap blocks. Segment
interiors here are parsed by the real `rvf_wasm_bg.wasm` microkernel, not the JS
fallback scanner.

Every row below reports three payloads that were all built for real, and then
which one `chooseDelta` returned. That last column is the point: a finer diff
costs a table row per unit, so it is not always the smaller one, and two of the
seven scenarios are constructed so that it loses.

| scenario | full transfer | span delta | semantic delta | span ÷ semantic | chooser picked |
|---|---|---|---|---|---|
| demo container, 1 record changed, 1 removed, 3 added | 2,448 B | 2,086 B | **866 B** | 2.41× | semantic |
| 1.13 MB container, 8 records + 1 COW cluster + 3 membership bits + 1 WASM byte † | 1,125,950 B | 1,125,630 B | **40,285 B** | 27.94× | semantic |
| WASM module, 1 byte in the 37,135 B Code section | 41,053 B | 41,155 B | **3,693 B** | 11.14× | semantic |
| RVCOW branch, 5 of 2,000 clusters flipped † | 18,163 B | 18,265 B | **2,284 B** | 8.00× | semantic |
| membership bitmap, 3 of 40,000 bits cleared † | 5,160 B | 5,262 B | **894 B** | 5.89× | semantic |
| demo container, vector dimension halved 16 → 8 | 1,536 B | **1,174 B** | 1,510 B | 0.78× | **span** |
| demo container, cold receiver | 2,304 B | **2,448 B** | 2,784 B | 0.88× | **span** |

† Synthetic containers. The repository ships no COW map or membership filter at
the scale the mechanism exists for, so those three are constructed; the demo and
WASM rows are the real container and the real microkernel off disk.

**All seven reconstructed byte-exactly**, checked by SHA-256 against the
sender's container rather than by length.

**The two span-wins rows are the ones that show the chooser working.** Halving
the vector dimension rewrites every record, so the semantic delta carries the
same 1,030 payload bytes as the span delta *plus* a 392-byte table describing 28
units, 25 of which changed — 1,510 B against 1,174 B, and the chooser correctly
declines it. The cold receiver is the same verdict for a different reason: with
nothing held, all 4 spans and all 28 units are missing, the table describes
bytes that were going to be sent anyway, and the semantic payload is 2,784 B
against 2,448 B. Neither is a failure mode; both are `chooseDelta` returning the
smaller of two payloads it actually built.

**A single-segment container is the case where the span delta cannot help at
all.** The WASM, RVCOW and membership rows each hold one segment, so their span
delta resends the whole container and its framing — 41,155 B, 18,265 B and
5,262 B against full transfers of 41,053 B, 18,163 B and 5,160 B respectively.
Each span delta is *larger than sending the file*. Only the unit decomposition
recovers anything, and what it recovers is the bulk of the transfer: one changed
WASM function body carries 1 of 71 units and 2,611 payload bytes out of a
37,135-byte Code section.

**The receiver's hop gets bigger in exactly the cases the sender's gets
smaller,** and both halves are counted here rather than one. A semantic
inventory carries a unit table on top of the span table `delta.js` sends: for
the demo container that is 667 B against 134 B, and for the 1.13 MB container
44,235 B against 190 B. Across the six scenarios with a base inventory the
semantic inventory is larger every time, by between 402 B and 44,045 B. It never
costs enough to overturn the payload saving — summing both hops, the demo
transfer is 1,533 B semantic against 2,220 B span, and the large container
84,520 B against 1,125,820 B — so on these scenarios `chooseDelta`'s
payload-only comparison reaches the same verdict as the two-hop total in all six
cases. **That is a property of these seven scenarios and not a proof.**

The gap this exposes is upstream of `chooseDelta`, and it is worth being exact
about which function is at fault. `chooseDelta` receives the receiver's
inventory as an argument: by the time it runs, that hop has already crossed the
wire and its cost is sunk. Comparing payloads alone is therefore the *correct*
comparison at that call site, and folding the inventory back in would be a
sunk-cost error — it cannot change which of the two remaining payloads is
cheaper to send. The unexamined decision belongs to `semanticInventory`, which
builds a unit table unconditionally, for every container, before anyone knows
what changed. The receiver pays for unit granularity even when the sender will
decline it, and the "every record rewritten" row is that bill arriving: summing
both hops it costs 2,177 B against the span path's 1,308 B, a case where the
semantic machinery loses overall while `chooseDelta` still returns the right
answer to the narrower question it was asked. No granularity rule exists
anywhere in `semdelta.js`. A receiver cannot know what changed, but it can bound
what a unit table can possibly save, and `semdelta.js` does not try.
**`artifacts/planner.js` now does**, from sizes and before any inventory is
built; the rule and its verdicts on eight container shapes — including this
container, where it declines the unit table and reproduces the 869 B figure
above from span and unit counts alone — are measured in the planner subsection
at the end of §10.

Cost of the machinery, median of 5 runs on the machine recorded above: the
1.13 MB container plans in about 15 ms, inventories in about 27 ms, and takes
about 49 ms in `chooseDelta` — which is the expensive call because it builds
*both* payloads before returning one, the span delta even in the rows where the
semantic delta wins. Applying and verifying it costs about 33 ms, for roughly
120 ms end to end. Every other scenario returns from `chooseDelta` in under
2 ms; the largest of them, the 41 KB WASM container, is about 4 ms for the whole
plan-inventory-choose-apply sequence.

## 8. QR encode and decode cost

`node bench/index.mjs --suite qr`

| chunk | ECC | frame bytes | QR ver | modules | encode p50 | decodeMatrix p50 | decodeImage 1280×720 |
|---|---|---|---|---|---|---|---|
| 256 B | L | 400 | 13 | 69² | 2.18 ms | 0.33 ms | 11.0 ms (91 fps) |
| **512 B** | **L** | **740** | **19** | **93²** | **4.11 ms** | **0.21 ms** | **10.9 ms (92 fps)** |
| 768 B | L | 1081 | 23 | 109² | 5.51 ms | 0.27 ms | 10.7 ms (93 fps) |
| **1024 B** | **L** | **1423** | **27** | **125²** | **7.58 ms** | **0.35 ms** | **11.9 ms (84 fps)** |

`decodeImage` cost is set by the image, not the symbol: it barely moves between
version 13 and version 31, because finder-pattern search dominates and that
scales with pixel count. **Decode is not what limits rvQR's frame rate on this
hardware** — at 5 fps the budget is 200 ms and the JS decoder uses 10.9 ms.

### Decode robustness by QR version

Each version encoded with five random payloads at ECC L, rendered into a
1280×720 frame at a range of scales, blurred with a box blur, decoded. The
reported minimum is the scale at which **every** sampled payload decoded.

| version | capacity | modules | decode p50 | sharp | blur r=1 | blur r=2 | frame share needed (r=1) |
|---|---|---|---|---|---|---|---|
| 5 | 106 B | 37² | 9.7 ms | 1 px | 4 px | 5 px | 25% |
| 10 | 271 B | 57² | 11.0 ms | 1 px | 5 px | 6 px | 45% |
| 13 | 425 B | 69² | 11.7 ms | 1 px | 6 px | fail | 64% |
| 16 | 586 B | 81² | 11.4 ms | 1 px | 8 px | fail | 99% |
| **19** | **792 B** | **93²** | **10.9 ms** | **1 px** | **6 px** | **fail** | **84%** |
| 22 | 1003 B | 105² | 10.6 ms | 1 px | **fail** | fail | — |
| **27** | **1465 B** | **125²** | **11.8 ms** | **1 px** | **fail** | **fail** | **—** |
| 40 | 2953 B | 177² | 13.6 ms | 1 px | fail | fail | — |

**Robustness falls off a cliff between version 19 and version 22.** rvQR's
512-byte default produces version 19, the last one still readable under blur;
its 1024-byte ceiling produces version 27, which failed at every scale under any
blur. This independently corroborates the bundled decoder's author, who
characterises it as reliable to about version 16 blurred and 19 sharp
**[CITED]**.

Three caveats, all of which matter. The "sharp" column is useless and is shown
only to be honest about that — a noiseless synthetic render decodes at one pixel
per module, which no camera will do. Version 16 needing 8 px where version 19
needs 6 is mask-pattern and payload luck surviving a five-payload sample, not a
real inversion. And **a box blur is not a lens**: no depth of field, no rolling
shutter, no noise, no glare, no motion.

## 9. Working memory and payload copies

`node bench/index.mjs --suite memory`

Budget: under 128 MiB of working memory and fewer than two full payload copies
live at once ([ADR-025](adr/ADR-025-rvqr-zero-copy-pipeline.md) §2.2), on the
largest artifact in the repository — `standalone.html`, 572,166 bytes at the
time of this run.

Measured in a separate process under `--expose-gc`, because both matter: without
a forced collection `heapUsed` is whatever the collector has not got round to
yet, and in the harness's own process the peak would be the other suites'. "Live"
is `heapUsed + external` after a forced collection, divided by the artifact size.
**`external` is where typed-array payloads actually are** — a copy count taken
from `heapUsed` alone under-reports them by about half, which is a mistake this
harness made and corrected.

| stage | heap Δ | external Δ | live copies | peak RSS |
|---|---|---|---|---|
| v1 sender: buildFrames | 1.70× | 0.07× | 1.78× | 54.6 MiB |
| v1 receiver: ingest (frames drained) | −1.01× | 1.00× | 1.77× | 55.9 MiB |
| v1 receiver: finalize (assemble + SHA-256) | 0.01× | 1.00× | **2.78×** | 56.5 MiB |
| v2 sender: buildFrames | 0.36× | 1.04× | 1.41× | 58.4 MiB |
| v2 sender: armour, one frame retained | 0.04× | 0.00× | 1.45× | 58.7 MiB |
| v2 harness: armour every frame, all retained | **37.60×** | 0.00× | 39.05× | 83.3 MiB |
| v2 receiver: ingest (frames drained) | −37.50× | 0.00× | 1.55× | 87.4 MiB |
| v2 receiver: finalize (assemble + SHA-256) | 0.01× | 1.00× | **2.56×** | 87.9 MiB |

Sender and receiver are measured as separate pipelines because they are separate
devices: holding the whole frame list is something this harness does and a
receiver never does, so the receiver stages drain the list as they consume it.

**Peak RSS 87.9 MiB, of which 39.9 MiB is the pipeline above an empty Node
process — inside the 128 MiB budget.** ADR-025 §2.4 is right that the budget is
a system budget rather than a pipeline budget, and this measures only the
pipeline; a browser tab's DOM, canvas backing store and camera buffers are
outside it.

**Both receivers are over the copy budget, and by roughly the same amount: v1
peaks at 2.78 payload copies, v2 at 2.56, against a budget of fewer than two.**
The cause is structural and identical in both: the per-frame chunks and the
assembled output are alive at the same time, so the floor for the current
`assemble`-then-verify design is 2.00 copies before any framing cost is counted.
v1 adds 0.78 on top because its base64url frame strings are not fully released;
v2 adds 0.56 because `proto2.ingest` stores `f.payload` as a **subarray view of
the whole frame buffer**, so all 693 bytes of a frame stay alive to keep 665
bytes of payload — 1.04× rather than 1.00×.

Getting under two copies means not materialising the assembled artifact
separately from the chunks: writing each chunk into its final position as it
arrives, and hashing incrementally. That is a design change, not a tuning knob.

**`proto2.toTransport` leaves a cons-string rope.** Armouring every frame and
retaining them cost 37.6× the artifact in heap, where the armour's own 8/7
expansion accounts for 1.14×.
`toTransport` appends one character at a time with `+=`, so V8 builds a
cons-string tree of ~792 nodes per frame and never flattens it until something
reads the string; each node costs more than the character it carries. The next
stage's `−37.49×` is those ropes collapsing as `fromTransport` reads them. A
sender that armours one frame per frame period pays nothing (0.03×); a sender
that pre-armours a batch pays about 30 bytes per output byte.

## 10. The objective function, G = R × C × E × P

`node bench/index.mjs --suite objective`

Every other section answers a local question. G is the scalar that ranks whole
configurations:

| term | meaning | source |
|---|---|---|
| **R** | raw optical rate, bytes/s — the QR version's byte capacity × frame rate | MEASURED (capacity from the real encoder's table) |
| **C** | compression / delta gain, ≥1 — artifact bytes per byte of stream framed | MEASURED (§2) |
| **E** | recovery efficiency, in (0,1] — stream bytes recovered per QR byte painted, folding the envelope, the fill slack and the erasure code's reception overhead | MEASURED (§1, §4) |
| **P** | decode success probability per painted frame | **NOT MEASURABLE HERE** — swept |

`G = R × C × E × P`, in artifact bytes per second. The reception-overhead term
in E is the measured 1.000191 from §4, not an assumption of ideality.

**P is a property of a camera pointed at a screen — module size in captured
pixels, focus, glare, refresh beat, motion — and there is no camera in this
harness. Every G figure below at P < 1 is a projection.**

### G on `rvf_wasm_bg.wasm` at version 19-L, 5 fps

| framing | codec | R | C | E | G @ P=1 (measured inputs) | G @ P=0.75 (projection) | seconds @ P=1 |
|---|---|---|---|---|---|---|---|
| v1 JSON | none | 3.87 KB/s | 1.000 | 0.6810 | 2.63 KB/s | 1.98 KB/s | 15.2 |
| v2 armoured | none | 3.87 KB/s | 1.000 | 0.8213 | 3.18 KB/s | 2.38 KB/s | 12.6 |
| v2 binary † | none | 3.87 KB/s | 1.000 | 0.9408 | 3.64 KB/s | 2.73 KB/s | 11.0 |
| v1 JSON | brotli-11 | 3.87 KB/s | 2.767 | 0.6681 | 7.15 KB/s | 5.36 KB/s | 5.6 |
| **v2 armoured** | **brotli-11** | 3.87 KB/s | 2.767 | 0.7793 | **8.34 KB/s** | 6.25 KB/s | **4.8** |
| v2 binary † | brotli-11 | 3.87 KB/s | 2.767 | 0.8906 | 9.53 KB/s | 7.15 KB/s | 4.2 |

† v2 binary does not survive the shipped decoder (§1), so its rows are what the
framing would be worth, not what is available today.

**The ranking is the finding.** Going from v1 to v2 armoured is worth 1.21×.
Adding compression is worth 2.62×. **Compression is the larger lever by more
than a factor of two**, and the two compose: v1 uncompressed to v2-armoured
compressed is 3.17×, which turns a 15.2-second transfer into a 4.8-second one at
unchanged optics.

The full table — three artifacts, three framings, versions 19 and 27, 5 and 10
fps, compressed and not, five P values — is in `bench/results/report.md`.

### Where G is wrong

G is linear in P. That is exact for a rateless code, where losing a fraction
(1−P) of frames costs exactly 1/P as many slots. It is not exact for v1's
indexed cycling. Measured slots against the 1/P scaling G assumes:

| transport | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| **rvQR v1 (indexed chunks)** | 1.00× | **2.12×** | **2.64×** | **3.04×** | **3.31×** | **3.63×** | **3.90×** |
| fountain (shipped) | 1.00× | 0.99× | 1.00× | 0.99× | 0.99× | 1.00× | 0.99× |
| fountain (`rlf-sys`) | 1.00× | 1.01× | 1.02× | 1.01× | 1.01× | 1.02× | 1.01× |
| fountain (`lt`) | 1.00× | 1.01× | 1.02× | 1.00× | 0.99× | 0.99× | 0.99× |

1.00× means G is exact. **G's v1 rows at P below 1 are optimistic by the factor
in this table** — at P = 0.5 the real v1 figure is roughly a third of what G
predicts. Every fountain transport, shipped and reference alike, sits within 2%
of exact across the whole range, which is the validation that the P term is the
right shape for a rateless transport and the warning that it is not a general
one.

### The transfer planner: choosing a strategy before spending a byte

`node bench/index.mjs --suite planner`

G above ranks *configurations* by goodput. `artifacts/planner.js` makes the
adjacent decision: given a situation — artifact size, what the receiver already
holds, what the link is doing, what the device can spare, what policy allows —
it enumerates concrete strategies, discards the ones the hard rules forbid,
ranks what is left by

    J = 0.45·T + 0.20·E + 0.20·B + 0.15·R      (a cost — lower is better)

and returns the winner with every loser and the reason it lost. Each of T, E and
B is a ratio against one fixed reference strategy — v1 JSON, indexed, 512 B
chunk, whole artifact, complete verification, which is what this app does today
when nobody chooses anything — evaluated in the same situation. R is already a
probability. **T's inputs are measured (§4, §10); E's are not, and there is no
power measurement anywhere in this document (§17), so the energy term is a
relative proxy in arbitrary units.**

This suite was run on the machine and seed recorded above but **at
2026-08-03T19:43:22Z, later than the run the rest of this document reports**.
Every byte count, candidate count, span count, unit count, verdict and J score
below is deterministic and reproduces from the seed; only the millisecond
columns are of that particular run, and they move a few tens of percent between
runs on this machine.

Receiver-side facts below are read off real containers by the real
`rvf_wasm_bg.wasm` microkernel — spans from `delta.spanPlan`, units from
`semdelta.semanticPlan`, decomposable bytes summed over the spans
`semdelta.decompositionReport` says it actually decomposed — rather than
asserted:

| container | bytes | spans | units | spans decomposed | decomposable bytes |
|---|---|---|---|---|---|
| demo container | 2,304 | 4 | 28 | 1/4 | 1,798 |
| WASM container | 41,053 | 1 | 71 | 1/1 | 41,053 |
| RVCOW cluster map † | 18,163 | 1 | 126 | 1/1 | 18,163 |
| membership bitmap † | 5,160 | 1 | 21 | 1/1 | 5,160 |
| large container † | 1,125,950 | 7 | 2,359 | 4/7 | 1,125,444 |

† Synthetic containers, constructed because the repository ships nothing at the
scale those mechanisms exist for. All three are parsed for real, by the same
parser and the same code path as the two that are not.

**What the planner chose, and what the alternatives would have cost.** Reporting
that it returned the lowest J would be circular — J is what it sorts on. The
spread columns are the extremes over the *admissible* set, the strategies that
could legally have been chosen, in the planner's own transfer model. The link is
version 19-L at 5 fps throughout.

| situation | artifact | receiver holds | candidates → admitted | chosen | J | chosen | fastest / slowest admissible | today's default |
|---|---|---|---|---|---|---|---|---|
| cold receiver, demo container | 2,304 B | nothing | 18 → 18 | peer link, whole artifact | 0.051 | 0.08 s | 0.08 s / 3.00 s | 3.00 s |
| receiver holds a near-identical copy | 2,304 B | units, 99% overlap | 54 → 54 | peer link, unit delta | 0.011 | 0.02 s | 0.02 s / 3.00 s | 3.00 s |
| lossy link, 45% loss | 40,989 B | nothing | 18 → 18 | peer link, whole artifact | 0.030 | 2.27 s | 2.27 s / 103.60 s | 103.60 s |
| tiny artifact | 132 B | nothing | 18 → 18 | peer link, whole artifact | 0.009 | 0.00 s | 0.00 s / 1.00 s | 1.00 s |
| large container, mostly unchanged † | 1,125,950 B | units, 99% overlap | 54 → 54 | peer link, unit delta | 0.003 | 1.51 s | 1.51 s / 1,037.00 s | 1,037.00 s |
| offline policy | 40,989 B | nothing | 18 → **16** | optical v2, fountain @ 1024 B, whole artifact | 0.327 | 14.40 s | 14.40 s / 38.80 s | 38.80 s |
| receiver has not declared v2 | 40,989 B | nothing | 18 → 18 | peer link, whole artifact | 0.070 | 1.39 s | 1.39 s / 38.80 s | 38.80 s |
| committing transfer | 40,989 B | spans, 90% overlap | 36 → **18** | peer link, whole artifact | 0.070 | 1.39 s | 1.39 s / 38.80 s | 38.80 s |

The slowest admissible strategy is 2.7× to 687× the chosen one across these
rows, and above 27× in seven of the eight, so the choice is not between
near-equivalents. Restricted to the optical strategies the spread narrows to
1.7×–66×, which is the honest figure for what choosing well is worth when there
is no radio to reach for. **And wherever policy allows a radio the answer is a
foregone conclusion**: 7 of the 8 situations pick the peer
link, because a peer link moves bytes at a rate no QR symbol approaches. The
optical grid — two framings, two modes, two chunk sizes, two verification depths
— only becomes visible when the radio is forbidden, and the optical case is the
one this application is for:

| situation, radio forbidden | chosen optical strategy | J | T / E / B / R | runner-up | runner-up J | chosen | slowest admissible |
|---|---|---|---|---|---|---|---|
| cold receiver, demo container | v2, fountain @ 1024 B, whole artifact | 0.411 | 0.47 / 0.54 / 0.47 / 0.00 | the same, partial verify | 0.448 | 1.40 s | 3.00 s |
| receiver holds a near-identical copy | v1, fountain @ 1024 B, unit delta | 0.176 | 0.20 / 0.23 / 0.20 / 0.00 | v1, fountain @ 512 B, unit delta | 0.176 | 0.60 s | 3.00 s |
| lossy link, 45% loss | v2, fountain @ 1024 B, whole artifact | 0.199 | 0.23 / 0.26 / 0.23 / 0.00 | the same, partial verify | 0.236 | 23.40 s | 103.60 s |
| tiny artifact | v1, fountain @ 1024 B, whole artifact | 0.528 | 0.60 / 0.69 / 0.60 / 0.00 | v1, fountain @ 512 B, whole artifact | 0.528 | 0.60 s | 1.00 s |
| large container, mostly unchanged † | v2, fountain @ 1024 B, unit delta | 0.013 | 0.02 / 0.02 / 0.02 / 0.00 | v1, fountain @ 1024 B, unit delta | 0.016 | 15.60 s | 1,037.00 s |
| receiver has not declared v2 | v2, fountain @ 1024 B, whole artifact | 0.372 | 0.37 / 0.43 / 0.37 / **0.30** | v1, fountain @ 1024 B, whole artifact | 0.395 | 14.40 s | 38.80 s |
| committing transfer | v2, fountain @ 1024 B, whole artifact | 0.327 | 0.37 / 0.43 / 0.37 / 0.00 | the same, span delta | 0.327 | 14.40 s | 38.80 s |

**The optical winner is a fountain stream in every one of those rows**, and in
each it is simultaneously the fastest and the leanest admissible strategy — which
is not a coincidence and not a trade: a rateless transport pays no
coupon-collector penalty, so it paints fewer symbols *and* finishes sooner, and
§3 measured both halves of that. Nothing in this suite therefore catches T and B
pulling apart. **The risk term is live in exactly one row and decisive in none.**
A v2 candidate aimed at a receiver that has not said it can read v2 carries
R = 0.30, worth 0.045 of J; the gap it would have to close is 0.023, so v2 still
wins. A hazard priced below the gap it would have to close changes nothing, which
is the honest reading of a weighted sum rather than a complaint about one.

**The cost of deciding.**

| situation | candidates | plan p50 | plan p95 | transfer saved against today's default | saved ÷ planning |
|---|---|---|---|---|---|
| cold receiver, demo container | 18 | 0.077 ms | 0.993 ms | 2.92 s | 37,988× |
| receiver holds a near-identical copy | 54 | 0.104 ms | 0.134 ms | 2.98 s | 28,669× |
| lossy link, 45% loss | 18 | 0.033 ms | 0.060 ms | 101.33 s | 3,039,800× |
| tiny artifact | 18 | 0.041 ms | 0.198 ms | 1.00 s | 24,455× |
| large container, mostly unchanged † | 54 | 0.076 ms | 0.120 ms | 1,035.49 s | 13,677,441× |
| offline policy | 18 | 0.018 ms | 0.059 ms | 24.40 s | 1,324,935× |
| receiver has not declared v2 | 18 | 0.020 ms | 0.033 ms | 37.41 s | 1,894,184× |
| committing transfer | 36 | 0.029 ms | 0.044 ms | 37.41 s | 1,306,904× |

Two readings of that table have to be kept apart. The planning cost is measured
and it is small, and it **does not grow with the artifact** — a plan is
arithmetic over a few dozen candidates and never touches the container. Compare
the two rows with the same 18 candidates and a 310× difference in size: the
40,989-byte module plans in 0.033 ms and the 132-byte segment in 0.041 ms, the
larger artifact being the *faster* of the two. What moves the column is candidate
count, which is why the 54-candidate rows are the slow ones at 0.076 and
0.104 ms. The saving is a **projection**, and it is not
all the planner's doing: in the rows where the peer link wins, most of the saved
time is a radio being faster than a screen, which needs no planner to notice. The
narrower claim, which is the one that matters for a regression, is that at these
candidate counts the decision is four to seven orders of magnitude cheaper than
the transfer it decides about, so it cannot be the thing that costs more than it
saves. The p95 column is where a first call pays for a cold JIT; the p50 is what
a running system sees.

**The hard rules under an adversarial adviser.** The learned component is
injected as `adviser.preference(candidate, situation)`. This run supplies one
that returns the maximum preference for exactly the candidates a rule forbids and
the minimum for every other candidate, and asks for an advice weight of 1000 —
which the module clamps to 0.35, but the request is what an unbounded learned
model would make.

| rule | situation | candidates | admitted | rejected by this rule | maximally favoured | reached the ranking | violator chosen? | outcome |
|---|---|---|---|---|---|---|---|---|
| trust | unverified peer | 18 | **0** | 18 | 18 | 0 | no | **no plan at all** |
| memory | 48 MiB artifact | 18 | 6 | 12 | 12 | 0 | no | peer link, whole artifact |
| radio | offline policy, 10 MB/s peer link | 18 | 16 | 2 | 2 | 0 | no | optical v2, indexed @ 1024 B, whole artifact |
| verification | committing transfer | 18 | 9 | 9 | 9 | 0 | no | peer link, whole artifact |

**Nothing forbidden reached the ranking, was admitted, or was chosen, under any
of the four rules.** The reason is structural rather than numerical, and that is
the point of the design: `admit()` returns candidate objects on one side and
report rows — an id, a label, a rule and a sentence — on the other, and `rank()`
is handed only the first list. There is no penalty to outbid because there is no
rejected candidate left in the world the ranking can see, so the ceiling on
advice weight bounds drift rather than safety.

**The unverified-peer row is the one that returns nothing at all**, and that is
correct rather than a failure: all 18 candidates break the trust rule, the
admissible set is empty, `chosen` is null, and the plan still explains itself —
*"no strategy passed the hard rules — 18 on trust; first: the peer is not
verified, and an unverified peer is not a transfer partner at any score"*. A
caller that treats a null plan as an error will report a shrug where the module
gave it a sentence.

**The inventory-granularity rule, which closes the defect §7 measured.**
`semanticInventory()` builds a unit table unconditionally, before anyone knows
what changed, so the receiver pays for unit granularity even in the transfers
where the sender will decline it. A receiver cannot know what changed, but it can
bound what a unit table could possibly save: the table is paid **twice** with
certainty — once on the inventory hop, once inside the delta payload — and saves
at most the decomposable bytes, once. "Break-even" below is the largest fraction
of those bytes that may turn over before it stops paying.

| container | shape | table paid twice | decomposable | break-even | verdict | publishes |
|---|---|---|---|---|---|---|
| demo container | 4 spans, 28 units | 533 + 336 = **869 B** | 1,798 B | 51.7% | marginal | **span** |
| WASM container | 1 span, 71 units | 1,336 + 980 = 2,316 B | 41,053 B | 94.4% | worth-it | **unit** |
| RVCOW cluster map † | 1 span, 126 units | 2,362 + 1,750 = 4,112 B | 18,163 B | 77.4% | worth-it | **unit** |
| membership bitmap † | 1 span, 21 units | 402 + 280 = 682 B | 5,160 B | 86.8% | worth-it | **unit** |
| large container † | 7 spans, 2,359 units | 44,045 + 32,928 = 76,973 B | 1,125,444 B | 93.2% | worth-it | **unit** |
| many tiny units ‡ | 2 spans, 40 units | 758 + 532 = 1,290 B | 900 B | −43.3% | **impossible** | **span** |
| opaque container ‡ | 5 spans, nothing parseable | 104 B | 0 B | — | nothing-to-decompose | **span** |
| cold receiver ‡ | nothing held | 11 B | 0 B | — | nothing-to-decompose | **span** |

‡ Sizes only — these three are shapes rather than containers, because the rule
takes four numbers and never sees a container. That is what lets it run before
the inventory it is deciding about exists, and it costs 0.0012 ms at worst here.

**Four shapes take unit granularity and four decline it**, which is the property
worth having: a rule that only ever said yes would not be a rule. The 869 B on
the demo row is the same 869 B §7 measured as the difference between the semantic
path's 2,177 B two-hop total and the span path's 1,308 B, reproduced here from
sizes rather than from payloads. The `impossible` row is a stronger verdict than
`marginal` and is stated separately for that reason: 1,290 B of table against
900 B of content cannot be saved by any edit however small, where the demo row is
merely a bet a receiver has no business taking.

**Declining costs bytes; paying when it cannot help is the defect.** §7 measured
two edits to the *same* demo container — one where unit granularity wins by 687 B
and one where it loses by 869 B. A receiver cannot tell those apart, and this
rule does not pretend to: the fraction rewritten appears only in deriving the
threshold, never in the decision.

**The threshold is pinned by 5 shapes, and loosely.** Of the shapes the tolerance
test actually decides, 1 is declined and 4 are admitted, so **every rewrite
tolerance in (0.517, 0.774] gives identical verdicts on all five**; the module's
default of 0.75 is inside it. The interval is bounded below by the demo container
and above by the RVCOW cluster map, and a container between them would narrow it
or move it. Five shapes is not many, and the interval's width is the honest
measure of that rather than a footnote to it.

**The rule's arithmetic against the real encoders.** The bound predicts inventory
sizes instead of encoding anything, which is the only reason it can run first.
Predicted against actual, base64url in both columns:

| container | span inventory predicted | actual | unit inventory predicted | actual |
|---|---|---|---|---|
| demo container | 134 B | **134 B** | 667 B | **667 B** |
| WASM container | 78 B | **78 B** | 1,414 B | **1,414 B** |
| RVCOW cluster map † | 78 B | **78 B** | 2,440 B | **2,440 B** |
| membership bitmap † | 78 B | **78 B** | 480 B | **480 B** |
| large container † | 190 B | **190 B** | 44,235 B | **44,235 B** |

Exact on all ten figures. Four of them are also §7's, reached independently: the
demo container's 134 B span inventory and 667 B semantic inventory, and the large
container's 190 B and 44,235 B, arrived at here by arithmetic on span and unit
counts rather than by encoding a table.

**What this suite does not establish.** A plan is a projection: every second in
these tables is the planner's own transfer model, not a stopwatch, and
`semdelta.chooseDelta()` measures the real payloads later and may disagree — when
it does, it is right and this was an estimate. The delta rows read the receiver's
*declared* overlap, and no hard rule catches a receiver that declares it wrongly.
The peer link's 32 KB/s default and the energy weights are modelled inputs, so
the rows where the radio wins are as good as those two numbers and no better. And
passing the hard rules means a strategy is *permitted*, never that it will work.

---

# Part II — MODELLED

Everything in this part is arithmetic or simulation over measured inputs. None
of it observes a running system, because none of these systems exists yet.

## 11. Fleet: N receivers on one site

`node bench/index.mjs --suite fleet`

**What the model captures:** broadcast — one painted symbol is offered to every
receiver in the same slot; a rateless code at the reception overhead measured in
§4; independent per-receiver erasure; content addressing, so a symbol a receiver
holds can serve a peer and two peers holding the same symbol are not counted
twice; and the real symbol size, so "source traffic" is bytes actually painted.

**What it does not capture, any of which could dominate:** whether the peer
channel exists at all — `artifacts/p2p.js` needs WebRTC signalling, and on an
air-gapped site that signalling has to cross the optical channel too, a cost not
counted here; peer link capacity, contention, range, battery, or the O(N²)
discovery problem; **loss correlated across receivers**, which in one room
sharing one glare source and one person walking past the screen is the most
optimistic assumption in the file; and any scheduling smarter than "paint the
next symbol".

Simulated at K=2,000 symbols, 12 trials per cell, seed 20260802, 665-byte
payload in a 792-byte version 19-L symbol.

| loss | N | source traffic, peer exchange | source traffic, broadcast only | naive unicast | peer bytes per receiver |
|---|---|---|---|---|---|
| 10% | 1 | 1.326× | 1.326× | 1× | 0 |
| 10% | 10 | 1.191× | 1.336× | 10× | 129 KB |
| 10% | 100 | 1.191× | 1.348× | 100× | 130 KB |
| 30% | 1 | 1.701× | 1.701× | 1× | 0 |
| 30% | 10 | 1.191× | 1.733× | 10× | 389 KB |
| **30%** | **100** | **1.191×** | **1.752×** | **100×** | **390 KB** |
| 50% | 1 | 2.368× | 2.368× | 1× | 0 |
| 50% | 10 | 1.192× | 2.449× | 10× | 647 KB |
| 50% | 100 | 1.191× | 2.476× | 100× | 650 KB |

Multiples are of artifact size in bytes actually painted, so the QR envelope is
inside them: 665 bytes of payload in a 792-byte symbol is **1.191× before a
single frame is lost**, which is the floor every row converges to.

**Projected onto a 1 GB artifact** — arithmetic on the measured multipliers
above:

| loss | N | source, peer exchange | source, broadcast only | naive unicast |
|---|---|---|---|---|
| 30% | 100 | **1.19 GB** | **1.75 GB** | 100.00 GB |
| 50% | 100 | 1.19 GB | 2.48 GB | 100.00 GB |

**The target — a 100-device site taking 1 GB for under 3 GB of source traffic —
is met at every loss rate simulated, and it is met without peer exchange at
all.** Broadcast alone gives 1.75 GB at 30% loss and 2.48 GB at 50%. Peer
exchange takes 30% loss from 1.75 GB to 1.19 GB, which is a real 32% saving and
is not the 33× the headline framing implies. The 84× between 100 GB and 1.19 GB
is overwhelmingly the fact that a hundred cameras can watch one screen at once.

At N=100 and 30% loss the model needs 390 KB of peer traffic per receiver on a
1.33 MB artifact — 29% of it, which is the loss rate, as it should be. That
traffic has to go somewhere, and the model says nothing about where.

**Is the multiplier flat in K?** The projection applies a multiplier measured at
K=2,000 to a K of 1,614,650, which is only legitimate if it is:

| K | peer-exchange multiplier | broadcast-only multiplier |
|---|---|---|
| 81 | 1.0000 | 1.6975 |
| 500 | 1.0000 | 1.5143 |
| 2,000 | 1.0000 | 1.4720 |
| 8,000 | 1.0000 | 1.4514 |

The peer-exchange multiplier is exactly flat. The broadcast-only one is not: it
falls with K toward 1/(1−p) = 1.4286 as the max over 100 receivers concentrates,
so **the broadcast-only projection at K=1.6 million is conservative by about
3%** — the real figure is nearer 1.70 GB than 1.75 GB. Reported the
unfavourable way round rather than the favourable one.

## 12. Progressive activation: time to a trusted agent

`node bench/index.mjs --suite closures`

**Nothing in this repository signs a closure or activates one.**
`artifacts/rvf.js` parses containers and `artifacts/delta.js` walks their spans,
but there is no closure signature and no partial activation. What follows is
arithmetic over measured span sizes, measured artifact sizes and measured byte
rates. Whether a partially transferred RVF can actually execute is a runtime
question this harness cannot answer.

The model accounts for the things that make small closures relatively expensive:
each closure pays its own signature and its own manifest frame, and closure
boundaries do not align with frame boundaries so each rounds up to whole frames.

**The gate is closures 1–3, not closure 1.**
[ADR-022](adr/ADR-022-rvqr-progressive-activation.md) §2.1 says "the agent
starts once closures 1–3 verify", so that is what is measured here.
Time-to-closure-1 is reported alongside because it is the easier number and it
is easy to quote the wrong one.

Two signature schemes are swept: 64-byte Ed25519, and the 3,309-byte ML-DSA-65
that [ADR-012](adr/ADR-012-rvqr-post-quantum-manifest.md) selects. `core.js`
declares `SIGNATURE_SIZE = 16`, which is a truncated tag rather than any
standard signature size — the discrepancy is noted rather than silently
resolved.

### The demo container, split on its own measured spans

| closure | bytes | source | frames | cumulative @ v2 armoured 5 fps |
|---|---|---|---|---|
| manifest + policy | 374 | measured | 2 | 0.40 s |
| witness | 132 | measured | 2 | 0.80 s |
| vector payload | 1,798 | measured | 4 | 1.60 s |

### A 1 MiB agent container (modelled split, real runtime size)

| closure | bytes | source | frames | cumulative @ 5 fps | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.40 s | 0.7 |
| **minimal RVM runtime** | **40,989** | **measured** | 63 | **13.0 s** | **21.7** |
| **required code + hot state** | 196,608 | modelled | 297 | **72.4 s ← the gate** | **120.7** |
| cold indexes + optional assets | 810,467 | modelled | 1,220 | 316.4 s | 527.3 |

### Time to a trusted agent (closures 1–3) against the 3-second target

| profile | transport | closure 1 | **closures 1–3** | meets 3 s? | whole artifact |
|---|---|---|---|---|---|
| 1 MiB agent | v1 JSON, 512 B @ 5 fps | 0.60 s | **94.2 s** | no | 411.2 s |
| 1 MiB agent | v2 armoured, 665 B @ 5 fps | 0.40 s | **72.4 s** | no | 316.4 s |
| 1 MiB agent | v2 armoured, 665 B @ 10 fps | 0.20 s | **36.2 s** | no | 158.2 s |
| 1 MiB agent | v2 armoured, 665 B @ 30 fps | 0.07 s | **12.1 s** | no | 52.7 s |
| `standalone.html` | v2 armoured, 665 B @ 5 fps | 0.40 s | **50.4 s** | no | 173.4 s |
| `standalone.html` | v2 armoured, 665 B @ 30 fps | 0.07 s | **8.4 s** | no | 28.9 s |

**Time-to-closure-1 is trivially inside 3 seconds and time-to-trusted-agent is
not close, at any rate this harness models.** The gap is 24× at the app's
default settings and still 4× at 30 fps, which is three times the app's own
ceiling. ADR-022 already concedes this — "on the optical channel at a measured
2.44 KB/s, three seconds is 7.3 KB, so this target is a radio-tier feature" —
and this measurement supports that concession precisely: the budget at v2
armoured and 5 fps is 7,788 bytes for closures 1–3, against a modelled 238 KB
of content.

### The largest closure content that fits 3 seconds

| transport | signature | closures | P | signature cost | max content | feasible? |
|---|---|---|---|---|---|---|
| v1 JSON, 512 B @ 5 fps | Ed25519 | 3 | 1 | 192 B | 5,952 B | yes |
| **v2 armoured, 665 B @ 5 fps** | **Ed25519** | **1** | **1** | 64 B | **9,246 B** | yes |
| **v2 armoured, 665 B @ 5 fps** | **Ed25519** | **3** | **1** | 192 B | **7,788 B** | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 3 | 0.5 (projection) | 192 B | 2,468 B | yes |
| v2 armoured, 665 B @ 5 fps | **ML-DSA-65** | 1 | 1 | 3,309 B | 6,001 B | yes |
| **v2 armoured, 665 B @ 5 fps** | **ML-DSA-65** | **3** | **1** | **9,927 B** | **0 B** | **NO** |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 | 3 | 1 | 9,927 B | 8,028 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 | 3 | 0.5 (projection) | 9,927 B | 0 B | **NO** |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 | 3 | 1 | 9,927 B | 47,928 B | yes |

**ADR-012 and ADR-022 are individually reasonable and jointly infeasible on the
optical channel.** Three separately signed closures at ML-DSA-65's 3,309 bytes
each cost **9,927 bytes of signature alone**. The entire 3-second budget at the
app's default 5 fps is 15 frames — 9,975 bytes of QR capacity, of which three go
to the closures' own manifests, leaving 7,980 bytes. **The signatures do not
fit, before a single byte of closure content.** At 10 fps and P = 1 they fit
with 8,028 bytes to spare; at a projected P = 0.5 they do not fit again.

Neither ADR reaches this conclusion, because it is a product of the two: ADR-012
sizes one signature and ADR-022 decides how many there are. The fixes are
arithmetic — one aggregate signature over the closure list instead of three
detached ones, or a hybrid where closures 2 and 3 are covered by a hash
committed in closure 1's single signature — and both are compatible with
ADR-022's §2.2 requirement that the manifest commit to the closure list and
order. What is not compatible is three full post-quantum signatures inside three
seconds of optical channel.

**The brief's premise that the whole artifact takes 20–40 seconds does not hold
for a 1 MiB container.** At 665 bytes per frame and 5 fps a 1 MiB artifact takes
316 seconds, and 158 seconds at 10 fps. Twenty to forty seconds at the app's
default rate corresponds to an artifact of roughly 66–133 KB. ADR-022's own
framing attributes the 20–40 s figure to rvDrop rather than to the optical
channel, which is consistent; the two targets simply describe different
transports and should not be read as one operating point.

## 13. Delta transfer at scale

**Projection, not measurement** — arithmetic assuming 4 MB spans and that the
changed fraction lands on whole spans:

| rate | full frames | delta frames | full time | delta time | ratio |
|---|---|---|---|---|---|
| 512 B @ 5 fps | 2,097,153 | 24,588 | 116.5 h | 1.4 h | 85× |
| 1024 B @ 10 fps | 1,048,577 | 12,295 | 29.1 h | 20 min | 85× |

Span size is the free parameter and it cuts both ways — large spans waste
payload on unchanged bytes inside a changed span, small spans make the inventory
itself expensive to send:

| span size | spans | inventory | inventory time @ 512 B / 5 fps | ratio |
|---|---|---|---|---|
| 4 MB | 256 | 5 KB | 0.0 min | 85× |
| 1 MB | 1,024 | 20 KB | 0.1 min | 102× |
| 256 KB | 4,096 | 80 KB | 0.5 min | 99× |
| 64 KB | 16,384 | 320 KB | 2.1 min | 97× |

So ~100× is achievable and the README's figure is defensible; it needs a span
size around 1 MB rather than any span size.

The projection is optimistic in one way worth naming: it assumes the edit is
confined to whole spans and does not change their lengths. A length-changing
edit shifts every subsequent offset and none of these numbers apply to it.

### Cross-check against `delta.js`'s author **[CITED]**

`delta.js`'s author measured a **1.65 MB container with 1% of its segments
rewritten and got 85.1× reduction, a 19,400-byte delta** — a real measurement
where the figures above are a projection. Both land on 85 from opposite
directions.

That agreement is worth a caveat rather than a victory lap. Our 85× assumed 4 MB
spans on a 1 GB container, a very different shape from 1.65 MB, and both land
near 85 because both are dominated by the changed fraction plus rounding rather
than by anything about span size. The ~85–100× family is robust to the details;
our projection did not predict their measurement.

---

# Part III — CITED

## 14. State of the art

### A category distinction that matters

A large fraction of "send a file with a QR code" tools do not send the file with
a QR code. [qrcp](https://github.com/claudiodangelis/qrcp) encodes
`http://{address}:{port}/{random_path}` into a single QR symbol; the phone's
browser then downloads over HTTP. LocalSend, Snapdrop and PairDrop work the same
way. The QR code is a bootstrap for a network transfer, and the throughput on
offer is Wi-Fi throughput. That is a fine design and a much faster one; it is
also a different thing, and it does not work across an air gap.

### Comparison

**[M]** is measured by this harness. **[C]** is the comparator's own published
claim, reproduced as theirs. **[?]** is unknown or unverifiable.

| system | channel | coding | throughput | loss resilience | network? | integrity |
|---|---|---|---|---|---|---|
| **rvQR** (this project) | optical, single monochrome QR | systematic GF(256) fountain, **RaptorQ-structured, not RFC 6330 conformant** | **2.44 KB/s default, 9.53 KB/s ceiling [M]**; 8.34 KB/s at 5 fps with v2 armoured + Brotli-11 [M] | **exactly K symbols in 98.45% of 2,200 decodes, never more than K+1; 3.75× fewer slots than indexed chunks at 60% loss [M]** | no | SHA-256 over the whole object, mandatory, all-or-nothing. **No authenticity** — the manifest is unauthenticated. |
| [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/) | optical, QR v40 (+ multi-code grids, colour) | LT codes, robust soliton | **Decimen's README claims** 128 KB/s phone-to-phone and 129.2 KB/s on a 2 MB image [C]; ~186 KB/s "propped" is a projection in that README [C] | **Decimen claims** it needs ~K·1.15 distinct frames [C] | no | SHA-256 in a 20-byte frame header; no encryption, no signatures [C] |
| [txqr](https://github.com/divan/txqr) | optical, single QR | LT codes via `google/gofountain` — **no wire compatibility with rvQR's codec** | **txqr's author reports** ~13 KB in 501 ms at 1850 B/frame, 12 fps, ECC L [C] — see units note | rateless; frames may be skipped or reordered [C] | no | [?] |
| [BC-UR multipart](https://developer.blockchaincommons.com/animated-qrs/) | optical, animated QR | hybrid: fixed-rate then rateless LT [C] | [?] — none published | rateless [C] | no | CRC on parts; authenticity from the signed payload, not the transport |
| [qrcp](https://github.com/claudiodangelis/qrcp) / LocalSend / PairDrop | **not optical** — QR carries a URL | n/a | Wi-Fi throughput; not comparable | n/a | **yes** | TLS optional; scope is the LAN |
| [COBRA](https://dl.acm.org/doi/10.1145/2307636.2307645) (MobiSys '12) | optical, colour barcode | colour symbology, blur-tolerant decoding | secondary sources give 153–598 kbps and 900 kbps [?] — see note | designed for handheld blur | no | n/a (research) |

### Notes on the cited numbers

**Decimen's 128 KB/s and 186 KB/s are Decimen's figures, not ours.** rvQR's
measured 9.53 KB/s at its ceiling is roughly 13× behind their claimed 128 KB/s.
The arithmetic of the gap is not mysterious: rvQR caps a frame at 1,024 bytes
and the app at 10 fps; Decimen uses 2,953-byte version-40 symbols at 60 fps.
That is 2.9× on density and 6× on rate. **[CITED]**

**Wirehair's N+0.02 reception overhead is Wirehair's published claim**, not a
measurement of anything in this repository. Where this document reports a
reception overhead of +0.0155 symbols, that is §4's measurement of
`artifacts/fountain.js` and has no relationship to Wirehair's codec or its
figure beyond both being small. **[CITED]**

**Decimen's press coverage overstates its own README.** A [Tom's Hardware
headline](https://www.tomshardware.com/networking/streaming-qr-codes-at-60-fps-achieves-nearly-190-kb-s-data-rate-in-phone-to-phone-tests-browser-based-method-requires-no-app-no-networking-no-pairing-and-no-permissions-beyond-camera-access)
says the method "achieves nearly 190 KB/s". The project's README describes 128
KB/s as measured and ~186 KB/s as a projected ceiling. The 190 KB/s is the
projection. This is the same failure mode rvQR's README warns against, and the
table above uses the README's measured number.

**txqr's units.** The blog post states: *"The record time for transferring ~13KB
of data is now is half a second or 501ms to be precise – it's almost 25kbps."*
13 KB in 501 ms is 26 KB/s, about 208 kbps, so "kbps" appears to be a slip for
KB/s. Cross-checking against the same post's configuration — 1,850 bytes per QR
at 12 fps — gives 22 KB/s, which agrees with the KB/s reading.

**COBRA's throughput is not reliably citable.** The paper is paywalled and three
secondary summaries give three different figures. The table records the
disagreement rather than picking one.

### Where rvQR loses, plainly

- **Throughput.** 9.53 KB/s measured at the ceiling against Decimen's claimed
  128 KB/s. Compression closes part of that — 8.34 KB/s measured at 5 fps with
  v2 armoured and Brotli-11, against 2.44 KB/s for v1 uncompressed at the same
  rate — but a 3.4× improvement on a 13× gap leaves a 4× gap.
- **The chunk cap is not conservative; the frame-rate cap might be.** §8 measures
  decode at 10–15 ms per frame regardless of version, so compute is not the
  limit. But it also measures version 22 and above failing under a one-pixel
  blur, and the 1024-byte ceiling already produces version 27.
- **rvQR is not first, and it is not novel.** Animated-QR fountain transfer was
  published by txqr in 2018 and is deployed at scale in hardware wallets via
  BC-UR.
- **No authenticity.** The manifest travels in the same unauthenticated stream as
  the payload. §12's closure signatures would fix this and do not exist.
- **v2's headline density is not reachable.** §1 measures the binary framing's
  1.39× and also measures that the shipped decoder destroys it.

### Where rvQR is genuinely different

- **RVF-native.** It recognises RVF containers by wire magic per ADR-009 and,
  with `artifacts/delta.js`, diffs them span by span. None of the comparators
  know what an RVF container is.
- **Integrity is mandatory and all-or-nothing.**
- **Zero install, zero network, static files.** Shared with Decimen; not with
  txqr or the qrcp family.
- **The fountain layer measures at the top of its class.** An LT code at this
  block size needs ~44% overhead, which the harness measures directly.

---

## 15. Contradictions found

Measurements that disagree with something stated elsewhere in this repository or
in the brief for this work. Reported rather than smoothed.

| claim | measurement | resolution |
|---|---|---|
| A v1 data frame is 739 B / 44.3% overhead (`proto2.js` docblock) vs 741 B / 44.7% (elsewhere) | Both, depending on transfer size: 739 B for a 6-frame transfer, 740–741 B for an 82-frame one | v1's `i` and `n` are decimal and grow by a byte at each power of ten. Neither figure is wrong; neither is a constant. |
| v2 binary carries 764 B/frame at version 19-L, 1.492× v1's default | 764 B confirmed, and 1.389× against v1's *measured maximum* of 550 B at that version. 1.49× is against the app's 512 B setting, which is not v1's maximum | Both ratios are defensible; they answer different questions. Against v1's best at the same symbol, v2 binary is 1.39× and v2 armoured 1.21×. |
| v2 binary is the dense path | The shipped `qrdecode.js` returns 830 bytes for a 792-byte binary frame and `parseFrame` rejects it | The binary path is unreachable with any decoder in this repository. `proto2.js`'s docblock says so; this measures it. The armoured path is the real one. |
| ADR-003 §2.3 cites `standalone.html` at 503,216 B compressing 3.535× with Brotli in 8.38 ms | 950,817 B compressing to 253,636 B at Brotli-6, ratio 3.749× in 15.02 ms — and it was 507,527 B, then 572,166 B, then 849,284 B, earlier in this session | The ratio is stable to about 6% and the throughput to about 5% (60.4 MB/s against 57.3); the byte counts are not, because the file has been measured at five different sizes this session. Byte counts against a moving build artifact are not reproducible quantities and should be quoted with their size. **ADR-003 is not edited to match** — its figures were true of the file it measured. |
| `compress.js` selects codec ids from ADR-003 §2.1; `proto2.js` ships `CODEC_NAMES = ['none','scf1','deflate-raw','brotli']` | The two tables agree on **id 0 alone**. Every compressing decision measured in §2 names id 4 (brotli), which `proto2.parseFrame` rejects with `unknown-codec`; zstd is id 2 here and id 2 is deflate-raw there; deflate-raw is id 6, also out of range | **No compressed transfer this module decides on can cross the wire today.** `compress.js` reports the divergence itself through `wireCompatible()` rather than working around it, and changes nothing in `proto2.js`. The gains in §2 are real and unavailable until `proto2.js` adopts the §2.1 table. This is ADR-027 §2.2's defect in its live form: id 2 means two different codecs in two files that have to agree. |
| ADR-003 §2.1 selects Zstd as the default codec and Brotli as the maximum-ratio option for WASM, HTML and metadata | A browser can run **neither**. The WHATWG Compression Streams format list is `gzip`, `deflate`, `deflate-raw`; a real Chromium 140 throws on `br`, `brotli` and `zstd` | **The ADR selects codecs for a platform that is not the one the app runs on.** Measured through the real `CompressionStream('deflate-raw')`, the reachable codec gives 55.91% envelope gain on the demo WASM against Brotli's 63.69%, and 70.12% against 76.40% on `standalone.html` — an edge of 0.48 to 7.77 points. The decision does not change (both environments compress or decline identically on every artifact here), so §2.1's *policy* survives; its *codec choice* describes Node. |
| `compressArtifact` is synchronous; the only codec a browser has is asynchronous | `CompressionStream` has no synchronous form, so the browser's codec cannot be injected into the module's own path at all. Injecting a Promise-returning `compress` throws `CompressError`/`bad-compressed-size` | **Fail-closed, and worth recording as a property.** A Promise has no `length` or `byteLength`, so the module refuses at the point of measurement rather than building a manifest around a size nobody produced. A browser caller must compress first and hand the measured length to `choose()`, which is the seam that path exists for. |
| §2's break-even table gives a single size at which each artifact clears the 8% gate — 6,144 B for float32 vectors | Scanning float32 prefixes at 18 sizes, the verdict **flips five times**: 2,304 B passes, 2,560 B fails, 3,072 B passes, 3,584 B fails, 4,096 B passes | Both are correct about what they measured (brotli-6 at a 512 B chunk against brotli-11 at 764 B), and neither is a break-even for the content. The ratio climbs smoothly and the frame count is a step function, so the gate is crossed repeatedly. A "break-even size" column reports the first crossing; for this content it is not the last. |
| ADR-025 §2.2 sets a budget of fewer than 2 full payload copies and calls anything more "a defect" | v1 receiver peaks at 2.78×, v2 at 2.56× | The current pipeline **fails ADR-025's acceptance test** in both protocols, for the same structural reason: chunks and assembled output coexist. 2.00× is the floor for an assemble-then-verify design, so the ADR's target needs incremental placement and incremental hashing, not tuning. |
| A whole artifact takes 20–40 s while the first closure takes under 3 s | A 1 MiB container takes 316 s at 5 fps and 158 s at 10 fps | 20–40 s at the default rate corresponds to a 66–133 KB artifact. ADR-022 attributes the 20–40 s figure to rvDrop, not to the optical channel, so the two targets describe different transports. |
| ADR-022 §2.1 gates on closures 1–3; ADR-012 sizes an ML-DSA-65 signature at 3,309 B | Three signatures cost 9,927 B against a 3-second optical budget of 7,980 B of usable capacity at 5 fps | **Jointly infeasible.** Neither ADR is wrong alone. One aggregate signature, or a hash chain committed in closure 1's signature, fixes it and stays inside ADR-022 §2.2. |
| ADR-003 §2.2 reasons about the 8% gate "at v2's measured 764 payload bytes per frame" | 764 B is the binary framing, which the shipped decoder cannot return (§1). The reachable figure at version 19-L is 665 B | The 8% rule survives — §2 measures every corpus artifact clearing it — but the supporting arithmetic is 15% optimistic: 8% of 40 KB is 5.0 frames and 1.0 s at 665 B, not the 4.3 frames and 0.9 s the ADR states. The conclusion does not move. |
| `core.SIGNATURE_SIZE = 16` | 16 bytes is not a signature size for any standard scheme | Modelled with 64 B (Ed25519) instead, with the discrepancy stated. Whatever 16 means, it is a truncated tag. |
| Decode cost at 512 B symbols is 3.86 ms (previous revision of this document) | 2.63 ms this run | Same code, same seed, warmer JIT. Millisecond figures on this machine vary by tens of percent between runs; byte and frame counts do not vary at all. |

---

## 16. Threats to validity

**No camera, no screen, no optics.** This is the big one. The harness models
frame loss as a probability and says nothing about where that probability comes
from. Real failures are correlated with symbol density, module size in pixels,
display refresh versus camera exposure, rolling shutter, glare, motion blur, and
distance. A denser QR version raises throughput *and* the loss rate, and this
harness cannot see the second half of that trade. **This is exactly the P term
in §10**, and it is why every G figure at P < 1 is labelled a projection.

**Goodput figures assume the receiver keeps up.** §6's KB/s numbers are frame
counts divided by frame periods. §8 argues there is headroom on this hardware;
it does not prove it on a phone.

**Millisecond figures come from an Apple M4 Pro,** and vary between runs on it —
see §4. Treat them as a floor for phone performance.

**The fleet model assumes independent loss across receivers.** A hundred devices
in one room share a glare source, a refresh beat, and a person walking in front
of the screen. Correlated loss would move the peer-exchange multiplier toward
the broadcast-only one, and the harness supports a `sharedLoss` parameter that
was not swept in this run.

**The fleet model does not count the peer channel's own cost.** WebRTC
signalling, discovery, and link capacity are all outside it. On an air-gapped
site the signalling has to cross the optical channel, which would be charged to
source traffic and is not.

**The closure model is arithmetic over a design that does not exist.** No
closure is signed, no partial activation is implemented, and whether a partially
transferred RVF can execute at all is unaddressed.

**The compression suite uses Node's zstd and Brotli.** The browser has neither
as a JavaScript API. Decode timings stand in for a decoder the app would have to
ship.

**Break-even sizes are measured on prefixes**, and a prefix is not a smaller
file of the same kind.

**Reception-overhead tails are undersampled.** 2,200 decodes put the
zero-overhead rate at 98.45% with a 95% interval of roughly ±0.5 points. They
say almost nothing about the K+2 tail; establishing a failure probability of
10⁻⁴ would need on the order of 10⁵ decodes.

**The overhead sweep uses one loss rate and one symbol size** — 45% at 512 bytes,
chosen to match the author's configuration for comparability.

**The delta suite mutates span bodies, not span lengths.** Length-changing edits
are the harder case and are not measured.

**The memory probe measures a Node process, not a browser tab.** V8's heap
behaviour is shared; the surrounding allocation, the DOM, the canvas backing
store and the camera buffers are not.

---

## 17. What could not be measured, and why

| Wanted | Status |
|---|---|
| Real end-to-end phone-to-phone throughput | **Not measured.** Needs two devices, a camera and a human. Every KB/s figure here is derived from frame counts and the nominal frame period. |
| **P, the decode success probability** | **Not measurable here at all.** It is the term in §10 that requires optics. It is swept, never assumed, and never folded into a headline number. |
| Optimal chunk size / QR version for a real camera | **Partly measured.** §8 gives decode cost and a blur-robustness floor per version on synthetic frames, which puts the cliff between version 19 and 22. The real density-versus-loss curve needs optics. |
| `BarcodeDetector` decode cost and byte fidelity | **Not measurable in Node.** It is the app's primary path. §1's binary round-trip failure is a property of the bundled JS decoder; whether `BarcodeDetector` behaves the same is untested, though it also returns a string. |
| SCF-1 compression | **Not measurable.** `proto2.js` declares `CODEC_SCF1` but there is no JavaScript implementation in this repository. Absent from every table rather than estimated. |
| Browser-side Brotli or Zstd, at all | **Not measurable, because it does not exist.** The WHATWG Compression Streams list is `gzip`, `deflate`, `deflate-raw`. Node *does* accept `new CompressionStream('brotli')` — that probe succeeds here and is recorded — but it is a Node extension and is not evidence of browser brotli; `compress.js` refuses to promote it into one. §2 reports the browser's `deflate-raw` as a separate environment rather than treating Node's codecs as the app's. |
| A browser codec inside `compressArtifact` | **Not possible, and it fails closed.** `CompressionStream` is asynchronous and the module is synchronous. §2 measures the stream for real and puts its output length through `choose()`; the end-to-end sync path is exercised with a `deflateRawSync` stand-in that was checked byte-identical to the stream on 7 of 7 artifacts. |
| A real browser, running any of this | **Not measured here.** This harness is Node. The browser rows model a browser's *capabilities* (constructors probed, WHATWG format list, real stream codec) on Node hardware; decode timings on a phone are the first row of this table. |
| The >8 MB compression branch, as configured | **Measured only with the threshold moved.** This repository ships nothing that reaches 8 MB, so §2 exercises the prefix path at `sampleAbove` 32,768 B. The branch works and agrees with the whole-artifact decision on these artifacts; whether it would on an 8 MB artifact is untested, and a declining prefix estimate is final for its codec. |
| A shared compression dictionary | **Not measurable — none exists.** `compress.js` ships an empty `DICTIONARIES` and every manifest it produces sets dictId 0. Its docblock quotes held-out dictionary figures; this harness measures the no-dictionary path only, which is the only path the shipped module can take. |
| Peer-exchange link behaviour | **Not measured.** §11 counts bytes, not seconds, on the peer side, and models nothing about the medium. |
| Closure activation | **Not measured.** Nothing signs or activates a closure. |
| Colour or multi-symbol frames | **Not applicable.** rvQR sends one monochrome symbol per frame. This is the single largest throughput lever the comparators use. |
| RaptorQ interoperability | **Not applicable.** `artifacts/fountain.js` states it is not RFC 6330 conformant. |
| Signature verification cost | **Not measured.** There is no signing path in this repository to time. |
| Energy, in joules | **Not measurable here at all.** No power measurement of any kind exists in this repository, which is why the planner's E term (§10, the planner subsection) is a relative proxy in arbitrary units against one optical slot, and why it is the only one of J's four terms whose weight buys a number nobody has checked against a battery. |
| Whether a plan was the *right* plan | **Not measured.** The planner subsection measures what is decided, what the alternatives would have cost in the same model, and what deciding costs. Whether the model ranks real transfers correctly needs the two devices in the first row of this table. |
| Resume-after-termination behaviour | **Not measured.** `artifacts/resume.js` is not covered by this harness. |
| COBRA's published throughput | **Could not verify.** Paywalled; secondary sources disagree. |

---

## Sources

- Ivan Danyliuk, ["Fountain codes and animated QR"](https://divan.dev/posts/fountaincodes/), 1 December 2018 — txqr's fountain-coded throughput and chunk-size experiments.
- Ivan Danyliuk, ["Animated QR data transfer with Gomobile and Gopherjs"](https://divan.dev/posts/animatedqr/), 18 November 2018 — txqr's pre-fountain baseline.
- [divan/txqr](https://github.com/divan/txqr) — source and build targets.
- [bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer/) — README performance claims, coding scheme, frame header.
- [Tom's Hardware, "Streaming QR codes at 60 FPS achieves nearly 190 KB/s…"](https://www.tomshardware.com/networking/streaming-qr-codes-at-60-fps-achieves-nearly-190-kb-s-data-rate-in-phone-to-phone-tests-browser-based-method-requires-no-app-no-networking-no-pairing-and-no-permissions-beyond-camera-access)
- [claudiodangelis/qrcp](https://github.com/claudiodangelis/qrcp) — confirms the QR-bootstraps-HTTP model.
- Blockchain Commons, ["Animated QRs"](https://developer.blockchaincommons.com/animated-qrs/) and [BCR-2024-001, Multipart UR](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-001-multipart-ur.md), 9 January 2024.
- [RFC 6330, "RaptorQ Forward Error Correction Scheme for Object Delivery"](https://www.rfc-editor.org/rfc/rfc6330.html), August 2011.
- [Raptor code (Wikipedia)](https://en.wikipedia.org/wiki/Raptor_code) — the >99% / >99.99% / >99.9999% recovery figures, which do not appear in RFC 6330 itself.
- [catid/wirehair](https://github.com/catid/wirehair) — the N+0.02 reception-overhead claim cited in §14, which is Wirehair's own published figure.
- M. Luby, ["LT Codes"](https://doi.org/10.1109/SFCS.2002.1181950), FOCS 2002 — the robust soliton distribution used by the harness's `lt` reference codec.
- T. Hao, R. Zhou, G. Xing, ["COBRA: color barcode streaming for smartphone systems"](https://dl.acm.org/doi/10.1145/2307636.2307645), MobiSys '12.
- [RFC 7932, "Brotli Compressed Data Format"](https://www.rfc-editor.org/rfc/rfc7932.html), July 2016.
- [RFC 8878, "Zstandard Compression and the 'application/zstd' Media Type"](https://www.rfc-editor.org/rfc/rfc8878.html), February 2021.
- [MDN, `DecompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream) — the supported formats, which are why §2's Brotli decode timings are Node's.
- Coupon collector's problem: E[draws to collect all K coupons] = K·H_K ≈ K ln K + γK. Motwani & Raghavan, *Randomized Algorithms* (Cambridge, 1995), §3.6.

---

*Harness: [`bench/`](../bench/). Raw per-cell statistics: `bench/results/full.json`.
Generated report: `bench/results/report.md`.*
