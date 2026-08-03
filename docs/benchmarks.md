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
MEASURED on `standalone.html` (507,527 B) in a separate process under
`--expose-gc`: peak RSS 86.4 MiB, of which 38.4 MiB is the pipeline itself —
comfortably inside 128 MiB. But **the receiver peaks at 2.84 payload copies for
v1 and 2.58 for v2**, against a budget of fewer than two. Both overshoot for
the same structural reason: the decoded chunks and the assembled output are
alive at the same time.

**7. `proto2.toTransport` leaves a cons-string rope that costs about 30 bytes
per output byte.** MEASURED: armouring 765 frames retained 18.2 MiB for 605 KB
of output — 37.6× the artifact. Holding one frame at a time costs nothing
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
node bench/index.mjs --suite compress    # zstd and brotli, judged on the whole envelope
node bench/index.mjs --suite objective   # G = R × C × E × P
node bench/index.mjs --suite fleet       # N receivers, peer exchange (a model)
node bench/index.mjs --suite closures    # progressive activation (a model)
node bench/index.mjs --suite memory      # working memory and payload copies

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

**Two artifacts moved while these benchmarks were being taken.**
`standalone.html` was 503,216 bytes at the start of the session and 507,527 at
the time of this run; `artifacts/app.js` went from 91,487 to 111,853. Both are
under active development by other agents. Every measurement below records the
size it saw, and any figure quoted against a different size is a different
measurement of a different file.

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

### The corpus

| artifact | bytes | Brotli-6 | ratio | envelope gain | best codec | best ratio | best gain |
|---|---|---|---|---|---|---|---|
| `artifacts/demo/ruvnet-demo.rvf` | 2,304 | 1,745 B | 1.320× | 23.2% | brotli-9 | 1.326× | 23.5% |
| `artifacts/demo/rvf_wasm_bg.wasm` | 40,989 | 16,636 B | 2.464× | 59.3% | brotli-11 | 2.767× | 63.7% |
| `artifacts/core.js` | 51,683 | 15,851 B | 3.261× | 69.2% | brotli-11 | 3.679× | 72.7% |
| `artifacts/app.js` | 111,853 | 30,118 B | 3.714× | 73.0% | brotli-11 | 4.144× | 75.8% |
| `standalone.html` | 507,527 | 143,695 B | 3.532× | 71.7% | brotli-11 | 3.950× | 74.7% |
| synthetic float32 vectors | 16,384 | 14,929 B | 1.097× | 8.7% | brotli-11 | 1.103× | 9.1% |

**The three reference points this was asked to reproduce independently, all
reproduced.** 40,989 → 16,636 at Brotli-6, ratio 2.464× — the same byte count.
2,304 → 1,745, ratio 1.320× — the same byte count. The standalone app's ratio
reproduces at 3.532×, but the byte count does not: 143,695 against a previously
reported 142,368, because the file grew from 503,216 to 507,527 bytes between
the two measurements. The ratio is the reproducible quantity; the byte count is
a measurement of a file that has changed.

The float32 row is the case the corpus would otherwise flatter away. It is
synthetic, generated from the harness seed, in the shape an RVF `VEC` span
carries — IEEE-754 mantissas are close to incompressible and a corpus of only
source code and WASM would make compression look uniformly free.

### Encode and decode cost

| artifact | zstd-6 enc | zstd-6 dec | brotli-6 enc | brotli-6 dec | brotli-11 enc |
|---|---|---|---|---|---|
| `ruvnet-demo.rvf` (2.3 KB) | 0.03 ms | 0.01 ms | 0.05 ms | 0.01 ms | 2.3 ms |
| `rvf_wasm_bg.wasm` (41 KB) | 0.39 ms | 0.05 ms | 0.66 ms | 0.09 ms | 37.0 ms |
| `standalone.html` (508 KB) | 3.67 ms | 0.36 ms | 7.94 ms | 0.84 ms | 527.5 ms |

Decode is the number that matters, because it is on the receiver's critical
path, and it is negligible: under a millisecond for half a megabyte. Encode at
Brotli-11 is not — 527 ms for the standalone app — but it is a sender-side
one-off before the first frame is painted, against a transfer measured in
minutes.

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
| `artifacts/app.js` | never in range | 256 B | 1.68× | 2.68× |
| `standalone.html` | never in range | 64 B | 2.68× | 2.42× |
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
live at once, on the largest artifact in the repository — `standalone.html`,
507,527 bytes.

Measured in a separate process under `--expose-gc`, because both matter: without
a forced collection `heapUsed` is whatever the collector has not got round to
yet, and in the harness's own process the peak would be the other suites'. "Live"
is `heapUsed + external` after a forced collection, divided by the artifact size.
**`external` is where typed-array payloads actually are** — a copy count taken
from `heapUsed` alone under-reports them by about half, which is a mistake this
harness made and corrected.

| stage | heap Δ | external Δ | live copies | peak RSS |
|---|---|---|---|---|
| v1 sender: buildFrames | 1.73× | 0.08× | 1.81× | 54.3 MiB |
| v1 receiver: ingest (frames drained) | −0.99× | 1.00× | 1.82× | 55.4 MiB |
| v1 receiver: finalize (assemble + SHA-256) | 0.02× | 1.00× | **2.84×** | 56.8 MiB |
| v2 sender: buildFrames | 0.37× | 1.04× | 1.42× | 58.0 MiB |
| v2 sender: armour, one frame retained | 0.03× | 0.00× | 1.45× | 58.0 MiB |
| v2 harness: armour every frame, all retained | **37.60×** | 0.00× | 39.06× | 84.2 MiB |
| v2 receiver: ingest (frames drained) | −37.49× | 0.00× | 1.57× | 86.2 MiB |
| v2 receiver: finalize (assemble + SHA-256) | 0.01× | 1.00× | **2.58×** | 86.4 MiB |

Sender and receiver are measured as separate pipelines because they are separate
devices: holding the whole frame list is something this harness does and a
receiver never does, so the receiver stages drain the list as they consume it.

**Peak RSS 86.4 MiB, of which 38.4 MiB is the pipeline above an empty Node
process — inside the 128 MiB budget.**

**Both receivers are over the copy budget, and by roughly the same amount: v1
peaks at 2.84 payload copies, v2 at 2.58, against a budget of fewer than two.**
The cause is structural and identical in both: the per-frame chunks and the
assembled output are alive at the same time, so the floor for the current
`assemble`-then-verify design is 2.00 copies before any framing cost is counted.
v1 adds 0.84 on top because its base64url frame strings are not fully released;
v2 adds 0.58 because `proto2.ingest` stores `f.payload` as a **subarray view of
the whole frame buffer**, so all 693 bytes of a frame stay alive to keep 665
bytes of payload — 1.04× rather than 1.00×.

Getting under two copies means not materialising the assembled artifact
separately from the chunks: writing each chunk into its final position as it
arrives, and hashing incrementally. That is a design change, not a tuning knob.

**`proto2.toTransport` leaves a cons-string rope.** Armouring all 765 frames and
retaining them cost 18.2 MiB — 37.6× the artifact, for output that is 605 KB.
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
| `standalone.html` is 503,216 B, compressing to 142,368 B with Brotli-6 | 507,527 B compressing to 143,695 B, ratio 3.532× | The ratio reproduces exactly; the file grew during this session. Byte counts against a moving build artifact are not reproducible quantities. |
| ADR-025 §2.1 sets a budget of fewer than 2 full payload copies and calls anything more "a defect" | v1 receiver peaks at 2.84×, v2 at 2.58× | The current pipeline **fails ADR-025's acceptance test** in both protocols, for the same structural reason: chunks and assembled output coexist. 2.00× is the floor for an assemble-then-verify design, so the ADR's target needs incremental placement and incremental hashing, not tuning. |
| A whole artifact takes 20–40 s while the first closure takes under 3 s | A 1 MiB container takes 316 s at 5 fps and 158 s at 10 fps | 20–40 s at the default rate corresponds to a 66–133 KB artifact. ADR-022 attributes the 20–40 s figure to rvDrop, not to the optical channel, so the two targets describe different transports. |
| ADR-022 §2.1 gates on closures 1–3; ADR-012 sizes an ML-DSA-65 signature at 3,309 B | Three signatures cost 9,927 B against a 3-second optical budget of 7,980 B of usable capacity at 5 fps | **Jointly infeasible.** Neither ADR is wrong alone. One aggregate signature, or a hash chain committed in closure 1's signature, fixes it and stays inside ADR-022 §2.2. |
| ADR-003 §2.2 reasons about the 8% gate "at v2's measured 764 payload bytes per frame" | 764 B is the binary framing, which the shipped decoder cannot return (§1). The reachable figure at version 19-L is 665 B | The 8% rule is unaffected — §2 measures every corpus artifact clearing it — but the frame-budget arithmetic behind ADR-003's choice of margin is 15% optimistic. |
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
| Browser-side Brotli decode | **Not measurable.** `DecompressionStream` does not expose it. Node's timings stand in. |
| Peer-exchange link behaviour | **Not measured.** §11 counts bytes, not seconds, on the peer side, and models nothing about the medium. |
| Closure activation | **Not measured.** Nothing signs or activates a closure. |
| Colour or multi-symbol frames | **Not applicable.** rvQR sends one monochrome symbol per frame. This is the single largest throughput lever the comparators use. |
| RaptorQ interoperability | **Not applicable.** `artifacts/fountain.js` states it is not RFC 6330 conformant. |
| Signature verification cost | **Not measured.** There is no signing path in this repository to time. |
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
