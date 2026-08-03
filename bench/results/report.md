## rvQR benchmark run

| key | value |
|---|---|
| node | v22.22.1 |
| v8 | 12.4.254.21-node.35 |
| platform | Darwin 25.1.0 arm64 |
| cpu | Apple M4 Pro x12 |
| memory | 48.0 GB |
| commit | 59dbd1f (dirty) |
| seed | 20260802 |
| trials/cell | 500 |
| run at | 2026-08-03T00:54:28.635Z |

**Modules under test:**

| file | present | bytes |
|---|---|---|
| artifacts/core.js | yes | 35787 |
| artifacts/fountain.js | yes | 23053 |
| artifacts/delta.js | yes | 36577 |
| artifacts/resume.js | yes | 26571 |
| artifacts/vendor/qrcode.js | yes | 23673 |
| artifacts/vendor/qrdecode.js | yes | 36789 |

Fountain codec: artifacts/fountain.js (measured directly). Delta: artifacts/delta.js (measured directly). Decoder: artifacts/vendor/qrdecode.js.

---

### Loss suite — rvf_wasm_bg.wasm (40989 B), 512 B per frame

Channel: iid · 500 trials per cell · seed 20260802

**Frame slots the receiver must observe — mean / p95.** A slot is one frame period.

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 82 / 82 | 193 / 283 | 271 / 389 | 357 / 532 | 452 / 696 | 596 / 885 | 800 / 1156 |
| fountain (shipped) | 81 | 86 / 86 | 95 / 102 | 108 / 116 | 122 / 135 | 142 / 159 | 171 / 196 | 214 / 245 |
| fountain (rlf-sys) | 81 | 86 / 86 | 97 / 104 | 110 / 119 | 124 / 137 | 145 / 165 | 175 / 199 | 217 / 249 |
| fountain (rlf) | 81 | 87 / 87 | 97 / 105 | 110 / 119 | 124 / 137 | 145 / 164 | 175 / 200 | 218 / 249 |
| fountain (lt) | 81 | 124 / 124 | 139 / 164 | 158 / 179 | 178 / 213 | 204 / 243 | 245 / 299 | 308 / 391 |

**Reception overhead — payload frames delivered beyond the theoretical minimum (mean, and as a % of that minimum).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 0.0 (0.0%) | 90.5 (110.3%) | 132.0 (161.0%) | 165.4 (201.7%) | 187.3 (228.4%) | 212.0 (258.6%) | 235.6 (287.4%) |
| fountain (shipped) | 81 | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) |
| fountain (rlf-sys) | 81 | 0.0 (0.0%) | 1.6 (2.0%) | 1.6 (2.0%) | 1.6 (2.0%) | 1.8 (2.2%) | 1.7 (2.1%) | 1.5 (1.8%) |
| fountain (rlf) | 81 | 1.0 (1.2%) | 1.5 (1.8%) | 1.5 (1.8%) | 1.4 (1.8%) | 1.6 (2.0%) | 1.6 (2.0%) | 1.7 (2.1%) |
| fountain (lt) | 81 | 36.0 (44.4%) | 37.5 (46.3%) | 38.1 (47.0%) | 36.9 (45.6%) | 35.6 (43.9%) | 35.0 (43.2%) | 36.1 (44.6%) |

Note: for the fountain transports this figure includes symbols that landed while the receiver was waiting for a manifest it could not decode without. The code's own overhead, measured without any framing, is in the reception-overhead suite below.

**Receiver wall-clock, cold start to verified payload (mean ms).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 0.32 | 0.47 | 0.59 | 0.75 | 0.72 | 0.80 | 0.78 |
| fountain (shipped) | 81 | 3.74 | 3.25 | 3.75 | 4.14 | 3.57 | 3.10 | 3.01 |
| fountain (rlf-sys) | 81 | 0.35 | 0.49 | 0.60 | 0.70 | 0.80 | 0.89 | 1.44 |
| fountain (rlf) | 81 | 2.10 | 1.91 | 1.70 | 1.52 | 1.49 | 1.47 | 1.64 |
| fountain (lt) | 81 | 0.99 | 1.19 | 1.20 | 1.05 | 0.92 | 0.90 | 0.88 |

**Speedup of fountain (shipped) over rvQR v1 (indexed chunks), in slots.**

| loss | baseline slots | fountain slots | speedup |
|---|---|---|---|
| 0% | 82 | 86 | 0.95× |
| 10% | 193 | 95 | 2.03× |
| 20% | 271 | 108 | 2.52× |
| 30% | 357 | 122 | 2.92× |
| 40% | 452 | 142 | 3.18× |
| 50% | 596 | 171 | 3.47× |
| 60% | 800 | 214 | 3.75× |

Sanity check: the coupon-collector bound for 82 distinct frames is K·H_K = 409 deliveries if the sender emitted random indices; the cyclic sender does better than that but still pays a log-K factor.

**Coding overhead for fountain (shipped) (K=81) — extra symbols at the moment of full rank, ignoring any manifest wait:**

| loss | distribution | mean | worst |
|---|---|---|---|
| 0% | 0→500 | 0.000 | 0 |
| 10% | 0→498, 1→2 | 0.004 | 1 |
| 20% | 0→498, 1→2 | 0.004 | 1 |
| 30% | 0→495, 1→5 | 0.010 | 1 |
| 40% | 0→498, 1→2 | 0.004 | 1 |
| 50% | 0→498, 1→2 | 0.004 | 1 |
| 60% | 0→498, 1→2 | 0.004 | 1 |

**Frames observed versus loss rate:**

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

### Loss suite — rvf_wasm_bg.wasm (40989 B), 512 B per frame

Channel: gilbert (mean burst 4 frames) · 250 trials per cell · seed 20260802

**Frame slots the receiver must observe — mean / p95.** A slot is one frame period.

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 82 / 82 | 154 / 245 | 230 / 373 | 304 / 470 | 427 / 726 | 556 / 803 | 792 / 1157 |
| fountain (shipped) | 81 | 86 / 86 | 95 / 111 | 109 / 129 | 122 / 150 | 144 / 179 | 171 / 213 | 213 / 254 |

**Reception overhead — payload frames delivered beyond the theoretical minimum (mean, and as a % of that minimum).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 0.0 (0.0%) | 56.1 (68.4%) | 99.6 (121.5%) | 129.1 (157.5%) | 171.3 (208.9%) | 192.7 (235.0%) | 232.3 (283.3%) |
| fountain (shipped) | 81 | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.0 (0.0%) | 0.1 (0.1%) |

Note: for the fountain transports this figure includes symbols that landed while the receiver was waiting for a manifest it could not decode without. The code's own overhead, measured without any framing, is in the reception-overhead suite below.

**Receiver wall-clock, cold start to verified payload (mean ms).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 82 | 0.34 | 0.45 | 0.54 | 0.59 | 0.68 | 0.69 | 0.79 |
| fountain (shipped) | 81 | 3.23 | 3.08 | 3.13 | 3.86 | 3.88 | 3.56 | 3.10 |

**Speedup of fountain (shipped) over rvQR v1 (indexed chunks), in slots.**

| loss | baseline slots | fountain slots | speedup |
|---|---|---|---|
| 0% | 82 | 86 | 0.95× |
| 10% | 154 | 95 | 1.62× |
| 20% | 230 | 109 | 2.12× |
| 30% | 304 | 122 | 2.49× |
| 40% | 427 | 144 | 2.97× |
| 50% | 556 | 171 | 3.25× |
| 60% | 792 | 213 | 3.71× |

Sanity check: the coupon-collector bound for 82 distinct frames is K·H_K = 409 deliveries if the sender emitted random indices; the cyclic sender does better than that but still pays a log-K factor.

**Coding overhead for fountain (shipped) (K=81) — extra symbols at the moment of full rank, ignoring any manifest wait:**

| loss | distribution | mean | worst |
|---|---|---|---|
| 0% | 0→250 | 0.000 | 0 |
| 10% | 0→249, 1→1 | 0.004 | 1 |
| 20% | 0→249, 1→1 | 0.004 | 1 |
| 30% | 0→248, 1→2 | 0.008 | 1 |
| 40% | 0→250 | 0.000 | 0 |
| 50% | 0→246, 1→4 | 0.016 | 1 |
| 60% | 0→248, 1→2 | 0.008 | 1 |

**Frames observed versus loss rate:**

```
  792 |                                                      o
      |                                                    .. 
      |                                                  ..   
      |                                                ..     
      |                                              ..       
      |                                            .o         
      |                                         ...           
      |                                      ...              
  396 |                                  ..o.                 
      |                              ....                     
      |                         ..o..                         
      |                     ....                              
      |                ..o..                             ....*
      |            ....                         ....*....     
      |     ....o..           ....*........*....              
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

### Loss suite — ruvnet-demo.rvf (2304 B), 512 B per frame

Channel: iid · 500 trials per cell · seed 20260802

**Frame slots the receiver must observe — mean / p95.** A slot is one frame period.

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 6 | 6 / 6 | 8 / 15 | 11 / 20 | 13 / 24 | 17 / 32 | 21 / 41 | 31 / 59 |
| fountain (shipped) | 5 | 6 / 6 | 8 / 21 | 11 / 21 | 14 / 41 | 19 / 61 | 25 / 81 | 36 / 101 |

**Reception overhead — payload frames delivered beyond the theoretical minimum (mean, and as a % of that minimum).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 6 | 0.0 (0.0%) | 1.0 (17.0%) | 1.8 (30.0%) | 2.4 (39.3%) | 3.2 (54.0%) | 3.8 (63.7%) | 5.1 (84.3%) |
| fountain (shipped) | 5 | 0.0 (0.0%) | 1.4 (28.2%) | 2.5 (49.8%) | 4.2 (83.3%) | 5.3 (105.1%) | 6.4 (128.5%) | 8.5 (170.6%) |

Note: for the fountain transports this figure includes symbols that landed while the receiver was waiting for a manifest it could not decode without. The code's own overhead, measured without any framing, is in the reception-overhead suite below.

**Receiver wall-clock, cold start to verified payload (mean ms).**

| transport | needs | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 6 | 0.02 | 0.02 | 0.02 | 0.03 | 0.03 | 0.03 | 0.03 |
| fountain (shipped) | 5 | 0.10 | 0.09 | 0.09 | 0.09 | 0.10 | 0.10 | 0.11 |

**Speedup of fountain (shipped) over rvQR v1 (indexed chunks), in slots.**

| loss | baseline slots | fountain slots | speedup |
|---|---|---|---|
| 0% | 6 | 6 | 1.00× |
| 10% | 8 | 8 | 1.00× |
| 20% | 11 | 11 | 1.00× |
| 30% | 13 | 14 | 0.90× |
| 40% | 17 | 19 | 0.90× |
| 50% | 21 | 25 | 0.87× |
| 60% | 31 | 36 | 0.84× |

Sanity check: the coupon-collector bound for 6 distinct frames is K·H_K = 15 deliveries if the sender emitted random indices; the cyclic sender does better than that but still pays a log-K factor.

**Coding overhead for fountain (shipped) (K=5) — extra symbols at the moment of full rank, ignoring any manifest wait:**

| loss | distribution | mean | worst |
|---|---|---|---|
| 0% | 0→500 | 0.000 | 0 |
| 10% | 0→495, 1→5 | 0.010 | 1 |
| 20% | 0→495, 1→5 | 0.010 | 1 |
| 30% | 0→492, 1→8 | 0.016 | 1 |
| 40% | 0→486, 1→14 | 0.028 | 1 |
| 50% | 0→478, 1→22 | 0.044 | 1 |
| 60% | 0→483, 1→17 | 0.034 | 1 |

**Frames observed versus loss rate:**

```
   36 |                                                      *
      |                                                    .. 
      |                                                   .   
      |                                                 ..  .o
      |                                                .  ..  
      |                                              .. ..    
      |                                           ..* ..      
      |                                       ......o.        
   18 |                                  ..*......            
      |                              ......o..                
      |                         ..*......                     
      |                     ......o..                         
      |              ....*....                                
      |     ....*....                                         
      |*....                                                  
      |                                                       
      |                                                       
    0 |                                                       
      +-------------------------------------------------------
       0%      10%      20%      30%      40%      50%      60%
       frame loss rate

  o = rvQR v1 (indexed chunks)
  * = fountain (shipped)
  y axis: mean frame slots observed
```

### Manifest repaint interval — ruvnet-demo.rvf (2304 B, K=5)

Mean slots to completion, 500 trials per cell. Shipped fountain codec throughout.

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| 4 slots | 7 / 7 | 9 / 12 | 12 / 18 | 18 / 30 |
| 8 slots | 6 / 6 | 8 / 12 | 12 / 25 | 20 / 41 |
| 16 slots | 6 / 6 | 10 / 17 | 16 / 49 | 32 / 97 |
| 20 slots | 6 / 6 | 11 / 21 | 19 / 61 | 36 / 101 |
| 32 slots | 6 / 6 | 13 / 33 | 25 / 65 | 54 / 161 |

Cells are mean / p95 slots. The p95 column is the one that matters: it is the tail where a missed manifest costs a full repaint interval.

### Manifest repaint interval — rvf_wasm_bg.wasm (40989 B, K=81)

Mean slots to completion, 500 trials per cell. Shipped fountain codec throughout.

| manifest every | 0% | 20% | 40% | 60% |
|---|---|---|---|---|
| 4 slots | 108 / 108 | 136 / 148 | 180 / 203 | 270 / 306 |
| 8 slots | 93 / 93 | 117 / 127 | 155 / 174 | 232 / 263 |
| 16 slots | 87 / 87 | 109 / 119 | 144 / 163 | 216 / 247 |
| 20 slots | 86 / 86 | 108 / 116 | 142 / 159 | 214 / 245 |
| 32 slots | 84 / 84 | 106 / 115 | 140 / 158 | 211 / 244 |

Cells are mean / p95 slots. The p95 column is the one that matters: it is the tail where a missed manifest costs a full repaint interval.

---

### Reception overhead at the codec (no framing, no manifest)

2200 decodes, K ∈ {4, 8, 16, 32, 64, 81, 128, 200, 320, 500, 800}, 512 B symbols, 45% independent loss, every result verified against SHA-256 (0 verification failures).

| K | decodes | at exactly K | by K+1 | by K+2 | mean overhead | worst | decode p50 |
|---|---|---|---|---|---|---|---|
| 4 | 200 | 94.50% | 100.00% | 100.00% | 0.0550 | 1 | 0.06 ms |
| 8 | 200 | 98.00% | 100.00% | 100.00% | 0.0200 | 1 | 0.13 ms |
| 16 | 200 | 97.00% | 100.00% | 100.00% | 0.0300 | 1 | 0.33 ms |
| 32 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 0.88 ms |
| 64 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 2.51 ms |
| 81 | 200 | 98.50% | 100.00% | 100.00% | 0.0150 | 1 | 3.13 ms |
| 128 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 6.50 ms |
| 200 | 200 | 100.00% | 100.00% | 100.00% | 0.0000 | 0 | 13.17 ms |
| 320 | 200 | 98.50% | 100.00% | 100.00% | 0.0150 | 1 | 28.94 ms |
| 500 | 200 | 99.50% | 100.00% | 100.00% | 0.0050 | 1 | 60.39 ms |
| 800 | 200 | 100.00% | 100.00% | 100.00% | 0.0000 | 0 | 137.36 ms |

**Aggregate over all 2200 decodes:** 98.45% at exactly K, 100.00% by K+1, 100.00% by K+2. Mean overhead 0.0155 symbols, worst case +1.

**Decode cost against symbol size, 40989 B payload:**

| symbol size | K | encoder setup | decode (systematic) | decode (repair only) |
|---|---|---|---|---|
| 1024 B | 41 | 0.80 ms | 1.95 ms | 1.68 ms |
| 512 B | 81 | 0.77 ms | 2.43 ms | 2.26 ms |
| 256 B | 161 | 4.51 ms | 5.10 ms | 4.52 ms |
| 128 B | 321 | 5.92 ms | 11.01 ms | 12.04 ms |
| 64 B | 641 | 22.38 ms | 33.44 ms | 30.72 ms |

The systematic column is the clean-channel case, where the receiver got the source symbols verbatim. The repair-only column is the worst case a lossy channel can produce: every source symbol missed, every one reconstructed.

---

### Real payloads

**ruvnet-demo.rvf** — 2304 B, detected as RVF container (Starts with the RVF segment magic 53 46 56 52.)

| rate | chunk | fps | frames | QR ver (L) | QR ver (M) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|---|---|---|
| default | 512 B | 5 | 6 | 8–19 | 9–22 | 3534 | 65.2% | 1.2 | 1.88 KB/s | 2.50 KB/s |
| ceiling | 1024 B | 10 | 4 | 8–27 | 10–31 | 3423 | 67.3% | 0.4 | 5.63 KB/s | 10.00 KB/s |

QR versions are the smallest that fits each frame; the app's default error-correction level is L. Fountain source-block sizes for the same payload: K=5 at 512 B, K=3 at 1024 B.

**rvf_wasm_bg.wasm** — 40989 B, detected as WASM module (Starts with the WebAssembly magic \0asm.)

| rate | chunk | fps | frames | QR ver (L) | QR ver (M) | wire bytes | wire eff. | seconds | goodput | nominal |
|---|---|---|---|---|---|---|---|---|---|---|
| default | 512 B | 5 | 82 | 5–19 | 6–22 | 59551 | 68.8% | 16.4 | 2.44 KB/s | 2.50 KB/s |
| ceiling | 1024 B | 10 | 42 | 5–27 | 6–31 | 57232 | 71.6% | 4.2 | 9.53 KB/s | 10.00 KB/s |

QR versions are the smallest that fits each frame; the app's default error-correction level is L. Fountain source-block sizes for the same payload: K=81 at 512 B, K=41 at 1024 B.

---

### Delta transfer

Driving artifacts/delta.js end to end on ruvnet-demo.rvf (2304 B).

| changed span | span bytes | spans sent | delta payload | inventory | wire ratio | exact? |
|---|---|---|---|---|---|---|
| #0 MANIFEST | 162 | 1/4 | 306 B | 134 B | 5.24× | yes |
| #1 VEC | 1798 | 1/4 | 1942 B | 134 B | 1.11× | yes |
| #2 WITNESS | 132 | 1/4 | 276 B | 134 B | 5.62× | yes |
| #3 MANIFEST | 212 | 1/4 | 356 B | 134 B | 4.70× | yes |

A ratio above 1× means the delta path moved less than a full transfer.

**Projection, not measurement — 1 GB container, 1% of spans changed, 4 MB spans:**

| rate | full frames | delta frames | full time | delta time | ratio |
|---|---|---|---|---|---|
| 512 B @ 5 fps | 2,097,153 | 24,588 | 116.5 h | 1.4 h | 85× |
| 1024 B @ 10 fps | 1,048,577 | 12,295 | 29.1 h | 20 min | 85× |

**Span-size sensitivity for the same 1 GB projection** (still arithmetic):

| span size | spans | inventory | inventory time @ 512 B/5 fps | ratio |
|---|---|---|---|---|
| 4096 KB | 256 | 5 KB | 0.0 min | 85× |
| 1024 KB | 1,024 | 20 KB | 0.1 min | 102× |
| 256 KB | 4,096 | 80 KB | 0.5 min | 99× |
| 64 KB | 16,384 | 320 KB | 2.1 min | 97× |

---

### QR encode and decode cost

JS decoder found at artifacts/vendor/qrdecode.js; decode timings below are from it.

| chunk | ECC | frame bytes | QR ver | modules | encode p50 | decodeMatrix p50 | decodeImage 640x480 p50 | decodeImage 1280x720 p50 |
|---|---|---|---|---|---|---|---|---|
| 256 B | L | 400 | 13 | 69² | 2.19 ms | 0.32 ms | 4.0 ms (247.0 fps) | 11.5 ms (87.3 fps) |
| 256 B | M | 400 | 15 | 77² | 2.73 ms | 0.34 ms | 3.9 ms (258.8 fps) | 11.2 ms (89.2 fps) |
| 512 B | L | 740 | 19 | 93² | 4.32 ms | 0.25 ms | 4.4 ms (229.7 fps) | 12.0 ms (83.6 fps) |
| 512 B | M | 740 | 22 | 105² | 5.09 ms | 0.22 ms | 4.8 ms (207.1 fps) | 11.6 ms (86.3 fps) |
| 768 B | L | 1081 | 23 | 109² | 5.71 ms | 0.26 ms | 4.2 ms (240.8 fps) | 10.7 ms (93.9 fps) |
| 768 B | M | 1081 | 27 | 125² | 7.36 ms | 0.36 ms | 5.3 ms (188.8 fps) | 12.2 ms (82.3 fps) |
| 1024 B | L | 1423 | 27 | 125² | 7.54 ms | 0.36 ms | 5.3 ms (189.8 fps) | 12.1 ms (82.6 fps) |
| 1024 B | M | 1423 | 31 | 141² | 9.72 ms | 0.45 ms | 4.6 ms (215.9 fps) | 10.6 ms (94.6 fps) |

**Encode cost by QR version, payload sized to fill the version (ECC M):**

| version | capacity | modules | encode p50 | bytes/s |
|---|---|---|---|---|
| 5 | 84 B | 37² | 0.56 ms | 146 KB/s |
| 10 | 213 B | 57² | 1.40 ms | 149 KB/s |
| 15 | 412 B | 77² | 2.63 ms | 153 KB/s |
| 20 | 666 B | 97² | 4.31 ms | 151 KB/s |
| 25 | 997 B | 117² | 6.42 ms | 152 KB/s |
| 30 | 1370 B | 137² | 8.95 ms | 150 KB/s |
| 35 | 1809 B | 157² | 11.71 ms | 151 KB/s |
| 40 | 2331 B | 177² | 15.08 ms | 151 KB/s |

**Decode cost and robustness by QR version** (ECC L, 1280x720 synthetic capture):

| version | capacity | modules | decode p50 | max fps | min px/module sharp | blur r=1 | blur r=2 | frame share needed (r=1) |
|---|---|---|---|---|---|---|---|---|
| 5 | 106 B | 37² | 10.1 ms | 99 | 1 | 4 | 5 | 25% |
| 10 | 271 B | 57² | 11.2 ms | 89 | 1 | 5 | 6 | 45% |
| 13 | 425 B | 69² | 12.0 ms | 84 | 1 | 6 | fail | 64% |
| 16 | 586 B | 81² | 11.5 ms | 87 | 1 | 8 | fail | 99% |
| 19 | 792 B | 93² | 11.0 ms | 91 | 1 | 6 | fail | 84% |
| 22 | 1003 B | 105² | 10.8 ms | 92 | 1 | fail | fail | — |
| 25 | 1273 B | 117² | 11.8 ms | 85 | 1 | fail | fail | — |
| 27 | 1465 B | 125² | 12.2 ms | 82 | 1 | fail | fail | — |
| 31 | 1840 B | 141² | 10.9 ms | 92 | 1 | fail | fail | — |
| 35 | 2303 B | 157² | 14.7 ms | 68 | 1 | fail | fail | — |
| 40 | 2953 B | 177² | 13.7 ms | 73 | 1 | fail | fail | — |

Min px/module is the smallest number of capture pixels per QR module at which the bundled JS decoder still read the symbol. "Frame share needed" converts that into how much of the capture's short side the symbol must occupy — the practical question when someone is holding a phone over another screen. Synthetic, square-on, noiseless frames with a box blur: these are lower bounds on difficulty, not predictions of real camera behaviour.

Raw results written to /private/tmp/claude-501/-Users-cohen-GitHub-ruvnet-ruvector/05d2576d-2dee-4999-b6a3-ce2701279e05/scratchpad/rvqr/bench/results/full.json
