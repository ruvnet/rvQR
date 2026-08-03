## rvQR benchmark run

| key | value |
|---|---|
| node | v22.22.1 |
| v8 | 12.4.254.21-node.35 |
| platform | Darwin 25.1.0 arm64 |
| cpu | Apple M4 Pro x12 |
| memory | 48.0 GB |
| commit | f2f07f4 (dirty) |
| seed | 20260802 |
| trials/cell | 500 |
| run at | 2026-08-03T16:58:06.136Z |

**Modules under test:**

| file | present | bytes |
|---|---|---|
| artifacts/core.js | yes | 51683 |
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
| rvQR v1 (indexed chunks) | 82 | 0.31 | 0.44 | 0.51 | 0.58 | 0.63 | 0.71 | 0.75 |
| fountain (shipped) | 81 | 3.01 | 3.25 | 3.19 | 3.13 | 2.98 | 2.92 | 3.15 |
| fountain (rlf-sys) | 81 | 0.35 | 0.49 | 0.61 | 0.73 | 0.81 | 0.91 | 1.00 |
| fountain (rlf) | 81 | 1.47 | 1.45 | 1.51 | 1.49 | 1.43 | 1.48 | 1.55 |
| fountain (lt) | 81 | 0.89 | 0.88 | 0.85 | 0.82 | 0.82 | 0.84 | 0.84 |

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
| rvQR v1 (indexed chunks) | 82 | 0.32 | 0.42 | 0.49 | 0.55 | 0.64 | 0.68 | 0.79 |
| fountain (shipped) | 81 | 3.10 | 3.12 | 3.17 | 3.03 | 3.10 | 3.31 | 3.02 |

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
| rvQR v1 (indexed chunks) | 6 | 0.02 | 0.02 | 0.03 | 0.03 | 0.03 | 0.03 | 0.03 |
| fountain (shipped) | 5 | 0.09 | 0.08 | 0.09 | 0.09 | 0.09 | 0.09 | 0.10 |

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
| 4 | 200 | 94.50% | 100.00% | 100.00% | 0.0550 | 1 | 0.04 ms |
| 8 | 200 | 98.00% | 100.00% | 100.00% | 0.0200 | 1 | 0.10 ms |
| 16 | 200 | 97.00% | 100.00% | 100.00% | 0.0300 | 1 | 0.24 ms |
| 32 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 0.67 ms |
| 64 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 1.91 ms |
| 81 | 200 | 98.50% | 100.00% | 100.00% | 0.0150 | 1 | 2.60 ms |
| 128 | 200 | 99.00% | 100.00% | 100.00% | 0.0100 | 1 | 5.33 ms |
| 200 | 200 | 100.00% | 100.00% | 100.00% | 0.0000 | 0 | 12.61 ms |
| 320 | 200 | 98.50% | 100.00% | 100.00% | 0.0150 | 1 | 27.69 ms |
| 500 | 200 | 99.50% | 100.00% | 100.00% | 0.0050 | 1 | 58.64 ms |
| 800 | 200 | 100.00% | 100.00% | 100.00% | 0.0000 | 0 | 130.72 ms |

**Aggregate over all 2200 decodes:** 98.45% at exactly K, 100.00% by K+1, 100.00% by K+2. Mean overhead 0.0155 symbols, worst case +1.

**Decode cost against symbol size, 40989 B payload:**

| symbol size | K | encoder setup | decode (systematic) | decode (repair only) |
|---|---|---|---|---|
| 1024 B | 41 | 0.78 ms | 1.96 ms | 1.84 ms |
| 512 B | 81 | 0.77 ms | 2.39 ms | 2.30 ms |
| 256 B | 161 | 2.37 ms | 4.45 ms | 4.16 ms |
| 128 B | 321 | 5.59 ms | 11.23 ms | 11.78 ms |
| 64 B | 641 | 22.74 ms | 33.47 ms | 30.82 ms |

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
| 256 B | L | 400 | 13 | 69² | 2.16 ms | 0.32 ms | 3.9 ms (255.9 fps) | 10.9 ms (91.6 fps) |
| 256 B | M | 400 | 15 | 77² | 2.61 ms | 0.34 ms | 3.7 ms (266.8 fps) | 10.8 ms (92.6 fps) |
| 512 B | L | 740 | 19 | 93² | 4.04 ms | 0.20 ms | 3.8 ms (264.9 fps) | 10.7 ms (93.6 fps) |
| 512 B | M | 740 | 22 | 105² | 5.09 ms | 0.23 ms | 4.9 ms (202.7 fps) | 11.4 ms (88.0 fps) |
| 768 B | L | 1081 | 23 | 109² | 5.57 ms | 0.26 ms | 4.1 ms (244.5 fps) | 10.8 ms (92.7 fps) |
| 768 B | M | 1081 | 27 | 125² | 7.43 ms | 0.35 ms | 5.2 ms (191.3 fps) | 12.5 ms (80.3 fps) |
| 1024 B | L | 1423 | 27 | 125² | 7.41 ms | 0.35 ms | 5.3 ms (188.2 fps) | 12.2 ms (82.1 fps) |
| 1024 B | M | 1423 | 31 | 141² | 9.45 ms | 0.45 ms | 4.6 ms (219.0 fps) | 10.4 ms (95.8 fps) |

**Encode cost by QR version, payload sized to fill the version (ECC M):**

| version | capacity | modules | encode p50 | bytes/s |
|---|---|---|---|---|
| 5 | 84 B | 37² | 0.57 ms | 144 KB/s |
| 10 | 213 B | 57² | 1.39 ms | 150 KB/s |
| 15 | 412 B | 77² | 2.66 ms | 151 KB/s |
| 20 | 666 B | 97² | 4.33 ms | 150 KB/s |
| 25 | 997 B | 117² | 6.46 ms | 151 KB/s |
| 30 | 1370 B | 137² | 8.89 ms | 150 KB/s |
| 35 | 1809 B | 157² | 11.84 ms | 149 KB/s |
| 40 | 2331 B | 177² | 15.09 ms | 151 KB/s |

**Decode cost and robustness by QR version** (ECC L, 1280x720 synthetic capture):

| version | capacity | modules | decode p50 | max fps | min px/module sharp | blur r=1 | blur r=2 | frame share needed (r=1) |
|---|---|---|---|---|---|---|---|---|
| 5 | 106 B | 37² | 9.7 ms | 103 | 1 | 4 | 5 | 25% |
| 10 | 271 B | 57² | 11.4 ms | 88 | 1 | 5 | 6 | 45% |
| 13 | 425 B | 69² | 12.1 ms | 83 | 1 | 6 | fail | 64% |
| 16 | 586 B | 81² | 11.5 ms | 87 | 1 | 8 | fail | 99% |
| 19 | 792 B | 93² | 10.8 ms | 93 | 1 | 6 | fail | 84% |
| 22 | 1003 B | 105² | 11.0 ms | 91 | 1 | fail | fail | — |
| 25 | 1273 B | 117² | 11.7 ms | 86 | 1 | fail | fail | — |
| 27 | 1465 B | 125² | 11.8 ms | 85 | 1 | fail | fail | — |
| 31 | 1840 B | 141² | 10.9 ms | 92 | 1 | fail | fail | — |
| 35 | 2303 B | 157² | 12.8 ms | 78 | 1 | fail | fail | — |
| 40 | 2953 B | 177² | 13.4 ms | 75 | 1 | fail | fail | — |

Min px/module is the smallest number of capture pixels per QR module at which the bundled JS decoder still read the symbol. "Frame share needed" converts that into how much of the capture's short side the symbol must occupy — the practical question when someone is holding a phone over another screen. Synthetic, square-on, noiseless frames with a box blur: these are lower bounds on difficulty, not predictions of real camera behaviour.

---

### Protocol v1 against protocol v2, at matched QR versions

Payload rvf_wasm_bg.wasm (40989 B). v2 header 28 B, manifest body 47 B plus the name. v1 chunk ceiling 1024 B (`core.MAX_CHUNK`), v2 payload ceiling 2953 B (`MAX_PAYLOAD_BYTES`). Armour length arithmetic checked against `toTransport`: exact.

| QR ver-ECC | capacity | framing | max payload | frame bytes | envelope | vs v1 | version confirmed | round trip |
|---|---|---|---|---|---|---|---|---|
| 13-L | 425 | v1-json | 273 B | 424 B | 55.3% | 1.000× | yes | yes |
| 13-L | 425 | v2-binary | 397 B | 425 B | 7.1% | 1.454× | yes | NO (bytes-lost) |
| 13-L | 425 | v2-armoured | 343 B | 424 B | 23.6% | 1.256× | yes | yes |
| 16-L | 586 | v1-json | 394 B | 586 B | 48.7% | 1.000× | yes | yes |
| 16-L | 586 | v2-binary | 558 B | 586 B | 5.0% | 1.416× | yes | NO (bytes-lost) |
| 16-L | 586 | v2-armoured | 484 B | 586 B | 21.1% | 1.228× | yes | yes |
| 19-L | 792 | v1-json | 550 B | 792 B | 44.0% | 1.000× | yes | yes |
| 19-L | 792 | v2-binary | 764 B | 792 B | 3.7% | 1.389× | yes | NO (bytes-lost) |
| 19-L | 792 | v2-armoured | 665 B | 792 B | 19.1% | 1.209× | yes | yes |
| 22-L | 1003 | v1-json | 708 B | 1002 B | 41.5% | 1.000× | yes | yes |
| 22-L | 1003 | v2-binary | 975 B | 1003 B | 2.9% | 1.377× | yes | NO (bytes-lost) |
| 22-L | 1003 | v2-armoured | 849 B | 1003 B | 18.1% | 1.199× | yes | yes |
| 27-L | 1465 | v1-json | 1024 B (capped) | 1424 B | 39.1% | 1.000× | yes | yes |
| 27-L | 1465 | v2-binary | 1437 B | 1465 B | 1.9% | 1.403× | yes | NO (bytes-lost) |
| 27-L | 1465 | v2-armoured | 1253 B | 1464 B | 16.8% | 1.224× | yes | yes |
| 40-L | 2953 | v1-json | 1024 B (capped) | 1424 B | 39.1% | 1.000× | NO (27) | yes |
| 40-L | 2953 | v2-binary | 2925 B | 2953 B | 1.0% | 2.856× | yes | NO (bytes-lost) |
| 40-L | 2953 | v2-armoured | 2555 B | 2952 B | 15.5% | 2.495× | yes | yes |
| 13-M | 331 | v1-json | 203 B | 331 B | 63.1% | 1.000× | yes | yes |
| 13-M | 331 | v2-binary | 303 B | 331 B | 9.2% | 1.493× | yes | NO (bytes-lost) |
| 13-M | 331 | v2-armoured | 261 B | 331 B | 26.8% | 1.286× | yes | yes |
| 16-M | 450 | v1-json | 292 B | 450 B | 54.1% | 1.000× | yes | yes |
| 16-M | 450 | v2-binary | 422 B | 450 B | 6.6% | 1.445× | yes | NO (bytes-lost) |
| 16-M | 450 | v2-armoured | 365 B | 450 B | 23.3% | 1.250× | yes | yes |
| 19-M | 624 | v1-json | 424 B | 624 B | 47.2% | 1.000× | yes | yes |
| 19-M | 624 | v2-binary | 596 B | 624 B | 4.7% | 1.406× | yes | NO (bytes-lost) |
| 19-M | 624 | v2-armoured | 518 B | 624 B | 20.5% | 1.222× | yes | yes |
| 22-M | 779 | v1-json | 540 B | 778 B | 44.1% | 1.000× | yes | yes |
| 22-M | 779 | v2-binary | 751 B | 779 B | 3.7% | 1.391× | yes | NO (bytes-lost) |
| 22-M | 779 | v2-armoured | 653 B | 779 B | 19.3% | 1.209× | yes | yes |
| 27-M | 1125 | v1-json | 800 B | 1125 B | 40.6% | 1.000× | yes | yes |
| 27-M | 1125 | v2-binary | 1097 B | 1125 B | 2.6% | 1.371× | yes | NO (bytes-lost) |
| 27-M | 1125 | v2-armoured | 956 B | 1125 B | 17.7% | 1.195× | yes | yes |
| 40-M | 2331 | v1-json | 1024 B (capped) | 1424 B | 39.1% | 1.000× | NO (31) | yes |
| 40-M | 2331 | v2-binary | 2303 B | 2331 B | 1.2% | 2.249× | yes | NO (bytes-lost) |
| 40-M | 2331 | v2-armoured | 2011 B | 2331 B | 15.9% | 1.964× | yes | yes |

"Max payload" is the largest chunk whose every frame still fits the version, found by binary search over frames the real builders produced and confirmed by encoding one and reading back its version. "Round trip" encodes that frame and decodes it with `artifacts/vendor/qrdecode.js`: a NO means the density in that row cannot currently be used, only quoted.

**The same three framings at the app's own operating points:**

| payload | chunk | fps | framing | frame bytes | envelope | QR ver | frames | wire bytes | wire eff. | seconds | goodput |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ruvnet-demo.rvf | 512 B | 5 | v1-json | 739 B | 44.3% | 19 | 6 | 3534 | 65.2% | 1.2 | 1.88 KB/s |
| ruvnet-demo.rvf | 512 B | 5 | v2-binary | 540 B | 5.5% | 16 | 6 | 2534 | 90.9% | 1.2 | 1.88 KB/s |
| ruvnet-demo.rvf | 512 B | 5 | v2-armoured | 618 B | 20.7% | 17 | 6 | 2900 | 79.4% | 1.2 | 1.88 KB/s |
| ruvnet-demo.rvf | 1024 B | 10 | v1-json | 1422 B | 38.9% | 27 | 4 | 3423 | 67.3% | 0.4 | 5.63 KB/s |
| ruvnet-demo.rvf | 1024 B | 10 | v2-binary | 1052 B | 2.7% | 23 | 4 | 2478 | 93.0% | 0.4 | 5.63 KB/s |
| ruvnet-demo.rvf | 1024 B | 10 | v2-armoured | 1203 B | 17.5% | 25 | 4 | 2834 | 81.3% | 0.4 | 5.63 KB/s |
| rvf_wasm_bg.wasm | 512 B | 5 | v1-json | 741 B | 44.7% | 19 | 82 | 59551 | 68.8% | 16.4 | 2.44 KB/s |
| rvf_wasm_bg.wasm | 512 B | 5 | v2-binary | 540 B | 5.5% | 16 | 82 | 43348 | 94.6% | 16.4 | 2.44 KB/s |
| rvf_wasm_bg.wasm | 512 B | 5 | v2-armoured | 618 B | 20.7% | 17 | 82 | 49610 | 82.6% | 16.4 | 2.44 KB/s |
| rvf_wasm_bg.wasm | 1024 B | 10 | v1-json | 1424 B | 39.1% | 27 | 42 | 57232 | 71.6% | 4.2 | 9.53 KB/s |
| rvf_wasm_bg.wasm | 1024 B | 10 | v2-binary | 1052 B | 2.7% | 23 | 42 | 42228 | 97.1% | 4.2 | 9.53 KB/s |
| rvf_wasm_bg.wasm | 1024 B | 10 | v2-armoured | 1203 B | 17.5% | 25 | 42 | 48290 | 84.9% | 4.2 | 9.53 KB/s |

**v1's frame size is not a constant** — `i` and `n` are decimal, so a frame gains a byte at each power of ten (512 B chunk):

| payload | data frames | smallest frame | largest frame | envelope range | distribution |
|---|---|---|---|---|---|
| ruvnet-demo.rvf | 5 | 739 B | 739 B | 44.3%–44.3% | 398→1, 739→4 |
| rvf_wasm_bg.wasm | 81 | 740 B | 741 B | 44.5%–44.7% | 97→1, 740→9, 741→71 |

---

### Compression, judged on the whole envelope

Zstd available. Envelope arithmetic checked against the real builder: exact. Envelope is v2 armoured at 512 B per frame, 28 B of header per frame plus the manifest frame. The gate is an envelope gain of 8%.

**artifacts/demo/ruvnet-demo.rvf** — 2304 B, 6 frames and 2900 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 1800 B | 1.280× | 0.03 ms | 0.01 ms | 5 | 2291 | 21.0% | pass | yes |
| zstd-3 | 1811 B | 1.272× | 0.03 ms | 0.01 ms | 5 | 2304 | 20.6% | pass | yes |
| zstd-6 | 1787 B | 1.289× | 0.02 ms | 0.01 ms | 5 | 2276 | 21.5% | pass | yes |
| zstd-9 | 1786 B | 1.290× | 0.04 ms | 0.01 ms | 5 | 2275 | 21.6% | pass | yes |
| zstd-12 | 1760 B | 1.309× | 0.07 ms | 0.01 ms | 5 | 2245 | 22.6% | pass | yes |
| zstd-19 | 1756 B | 1.312× | 0.11 ms | 0.01 ms | 5 | 2241 | 22.7% | pass | yes |
| brotli-4 | 1772 B | 1.300× | 0.05 ms | 0.01 ms | 5 | 2259 | 22.1% | pass | yes |
| brotli-6 | 1745 B | 1.320× | 0.04 ms | 0.01 ms | 5 | 2228 | 23.2% | pass | yes |
| brotli-9 | 1737 B | 1.326× | 0.08 ms | 0.02 ms | 5 | 2219 | 23.5% | pass | yes |
| brotli-11 | 1746 B | 1.320× | 2.37 ms | 0.02 ms | 5 | 2229 | 23.1% | pass | yes |

**artifacts/demo/rvf_wasm_bg.wasm** — 40989 B, 82 frames and 49610 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 19167 B | 2.139× | 0.07 ms | 0.04 ms | 39 | 23257 | 53.1% | pass | yes |
| zstd-3 | 18185 B | 2.254× | 0.10 ms | 0.05 ms | 37 | 22069 | 55.5% | pass | yes |
| zstd-6 | 17193 B | 2.384× | 0.34 ms | 0.05 ms | 35 | 20870 | 57.9% | pass | yes |
| zstd-9 | 17075 B | 2.401× | 0.55 ms | 0.05 ms | 35 | 20735 | 58.2% | pass | yes |
| zstd-12 | 17076 B | 2.400× | 1.01 ms | 0.06 ms | 35 | 20736 | 58.2% | pass | yes |
| zstd-19 | 16252 B | 2.522× | 4.58 ms | 0.06 ms | 33 | 19729 | 60.2% | pass | yes |
| brotli-4 | 17639 B | 2.324× | 0.37 ms | 0.09 ms | 36 | 21412 | 56.8% | pass | yes |
| brotli-6 | 16636 B | 2.464× | 0.63 ms | 0.11 ms | 34 | 20200 | 59.3% | pass | yes |
| brotli-9 | 16599 B | 2.469× | 0.88 ms | 0.09 ms | 34 | 20158 | 59.4% | pass | yes |
| brotli-11 | 14815 B | 2.767× | 37.81 ms | 0.13 ms | 30 | 17988 | 63.7% | pass | yes |

**artifacts/core.js** — 51683 B, 102 frames and 62478 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 18561 B | 2.784× | 0.09 ms | 0.05 ms | 38 | 22522 | 64.0% | pass | yes |
| zstd-3 | 17517 B | 2.950× | 0.14 ms | 0.06 ms | 36 | 21263 | 66.0% | pass | yes |
| zstd-6 | 16549 B | 3.123× | 0.46 ms | 0.08 ms | 34 | 20091 | 67.8% | pass | yes |
| zstd-9 | 16296 B | 3.172× | 0.59 ms | 0.05 ms | 33 | 19769 | 68.4% | pass | yes |
| zstd-12 | 16165 B | 3.197× | 1.57 ms | 0.06 ms | 33 | 19619 | 68.6% | pass | yes |
| zstd-19 | 15659 B | 3.301× | 7.73 ms | 0.07 ms | 32 | 19008 | 69.6% | pass | yes |
| brotli-4 | 16926 B | 3.053× | 0.45 ms | 0.10 ms | 35 | 20555 | 67.1% | pass | yes |
| brotli-6 | 15851 B | 3.261× | 0.67 ms | 0.10 ms | 32 | 19228 | 69.2% | pass | yes |
| brotli-9 | 15739 B | 3.284× | 1.03 ms | 0.11 ms | 32 | 19100 | 69.4% | pass | yes |
| brotli-11 | 14047 B | 3.679× | 40.02 ms | 0.10 ms | 29 | 17067 | 72.7% | pass | yes |

**artifacts/app.js** — 112319 B, 221 frames and 135686 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 36292 B | 3.095× | 0.18 ms | 0.10 ms | 72 | 43902 | 67.6% | pass | yes |
| zstd-3 | 33779 B | 3.325× | 0.27 ms | 0.10 ms | 67 | 40866 | 69.9% | pass | yes |
| zstd-6 | 31679 B | 3.546× | 0.90 ms | 0.11 ms | 63 | 38334 | 71.7% | pass | yes |
| zstd-9 | 30920 B | 3.633× | 1.38 ms | 0.11 ms | 62 | 37434 | 72.4% | pass | yes |
| zstd-12 | 30514 B | 3.681× | 4.76 ms | 0.10 ms | 61 | 36937 | 72.8% | pass | yes |
| zstd-19 | 29343 B | 3.828× | 20.32 ms | 0.11 ms | 59 | 35533 | 73.8% | pass | yes |
| brotli-4 | 32849 B | 3.419× | 0.75 ms | 0.21 ms | 66 | 39770 | 70.7% | pass | yes |
| brotli-6 | 30286 B | 3.709× | 1.49 ms | 0.19 ms | 61 | 36677 | 73.0% | pass | yes |
| brotli-9 | 29895 B | 3.757× | 2.25 ms | 0.17 ms | 60 | 36197 | 73.3% | pass | yes |
| brotli-11 | 27141 B | 4.138× | 93.52 ms | 0.20 ms | 55 | 32885 | 75.8% | pass | yes |

**standalone.html** — 572166 B, 1119 frames and 690741 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 198194 B | 2.887× | 1.08 ms | 0.44 ms | 389 | 239359 | 65.3% | pass | yes |
| zstd-3 | 177130 B | 3.230× | 1.67 ms | 0.47 ms | 347 | 213905 | 69.0% | pass | yes |
| zstd-6 | 164767 B | 3.473× | 4.59 ms | 0.42 ms | 323 | 198988 | 71.2% | pass | yes |
| zstd-9 | 162080 B | 3.530× | 6.82 ms | 0.41 ms | 318 | 195753 | 71.7% | pass | yes |
| zstd-12 | 160845 B | 3.557× | 9.19 ms | 0.44 ms | 316 | 194275 | 71.9% | pass | yes |
| zstd-19 | 149625 B | 3.824× | 90.85 ms | 0.49 ms | 294 | 180730 | 73.8% | pass | yes |
| brotli-4 | 173098 B | 3.305× | 4.40 ms | 1.09 ms | 340 | 209067 | 69.7% | pass | yes |
| brotli-6 | 158868 B | 3.602× | 9.34 ms | 0.92 ms | 312 | 191885 | 72.2% | pass | yes |
| brotli-9 | 155474 B | 3.680× | 16.99 ms | 0.88 ms | 305 | 187776 | 72.8% | pass | yes |
| brotli-11 | 141571 B | 4.042× | 602.93 ms | 1.06 ms | 278 | 170999 | 75.2% | pass | yes |

**synthetic float32 vectors** — 16384 B (synthetic), 33 frames and 19891 wire bytes uncompressed

| codec | compressed | ratio | encode | decode | frames | wire bytes | envelope gain | gate | exact? |
|---|---|---|---|---|---|---|---|---|---|
| zstd-1 | 14948 B | 1.096× | 0.02 ms | 0.02 ms | 31 | 18184 | 8.6% | pass | yes |
| zstd-3 | 14948 B | 1.096× | 0.02 ms | 0.02 ms | 31 | 18184 | 8.6% | pass | yes |
| zstd-6 | 14948 B | 1.096× | 0.03 ms | 0.02 ms | 31 | 18184 | 8.6% | pass | yes |
| zstd-9 | 14948 B | 1.096× | 0.04 ms | 0.02 ms | 31 | 18184 | 8.6% | pass | yes |
| zstd-12 | 14975 B | 1.094× | 0.27 ms | 0.02 ms | 31 | 18215 | 8.4% | pass | yes |
| zstd-19 | 14970 B | 1.094× | 0.42 ms | 0.02 ms | 31 | 18209 | 8.5% | pass | yes |
| brotli-4 | 14927 B | 1.098× | 0.10 ms | 0.05 ms | 31 | 18160 | 8.7% | pass | yes |
| brotli-6 | 14929 B | 1.097× | 0.14 ms | 0.05 ms | 31 | 18162 | 8.7% | pass | yes |
| brotli-9 | 14930 B | 1.097× | 0.11 ms | 0.05 ms | 31 | 18163 | 8.7% | pass | yes |
| brotli-11 | 14858 B | 1.103× | 25.10 ms | 0.10 ms | 31 | 18081 | 9.1% | pass | yes |

**Break-even by artifact size** (brotli-6, prefixes compressed for real at every size):

| artifact | compression LOSES at or below | reaches the 8% gate at | ratio at 512 B | ratio at 4 KB |
|---|---|---|---|---|
| artifacts/demo/ruvnet-demo.rvf | never in range | 64 B | 1.40× | — |
| artifacts/demo/rvf_wasm_bg.wasm | never in range | 64 B | 1.45× | 2.29× |
| artifacts/core.js | 64 B | 128 B | 1.72× | 2.17× |
| artifacts/app.js | never in range | 256 B | 1.68× | 2.68× |
| standalone.html | never in range | 64 B | 2.68× | 2.42× |
| synthetic float32 vectors | 128 B | 6144 B | 1.06× | 1.09× |

A prefix of a file is not a smaller file of the same kind — the first 512 bytes of a WASM module are its header, which compresses differently from its code — so these are break-evens for prefixes, and they bound the answer rather than being it.

---

### The objective function, G = R × C × E × P

**R** raw optical rate (QR capacity × fps, measured capacity). **C** compression gain (measured). **E** recovery efficiency: stream bytes recovered per QR byte painted, folding the envelope, the fill slack and the measured reception overhead. **P** decode success probability per frame — **not measurable by this harness at all**, so it is swept, and every column below with P < 1 is a projection rather than a measurement. G is in artifact bytes per second.

| artifact | codec | framing | QR ver | fps | chunk | R | C | E | G @ P=1 | G @ P=0.9 (proj.) | G @ P=0.75 (proj.) | G @ P=0.5 (proj.) | G @ P=0.25 (proj.) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| artifacts/demo/ruvnet-demo.rvf | none | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 1.000 | 0.4848 | 1.88 KB/s | 1.69 KB/s | 1.41 KB/s | 0.94 KB/s | 0.47 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 1.000 | 0.4848 | 3.75 KB/s | 3.38 KB/s | 2.81 KB/s | 1.88 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 1.000 | 0.3932 | 2.81 KB/s | 2.53 KB/s | 2.11 KB/s | 1.41 KB/s | 0.70 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 1.000 | 0.3932 | 5.63 KB/s | 5.06 KB/s | 4.22 KB/s | 2.81 KB/s | 1.41 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 1.000 | 0.5817 | 2.25 KB/s | 2.02 KB/s | 1.69 KB/s | 1.12 KB/s | 0.56 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 1.000 | 0.5817 | 4.50 KB/s | 4.05 KB/s | 3.37 KB/s | 2.25 KB/s | 1.12 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 1.000 | 0.5241 | 3.75 KB/s | 3.37 KB/s | 2.81 KB/s | 1.87 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 1.000 | 0.5241 | 7.50 KB/s | 6.75 KB/s | 5.62 KB/s | 3.75 KB/s | 1.87 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 1.000 | 0.5817 | 2.25 KB/s | 2.02 KB/s | 1.69 KB/s | 1.12 KB/s | 0.56 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 1.000 | 0.5817 | 4.50 KB/s | 4.05 KB/s | 3.37 KB/s | 2.25 KB/s | 1.12 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 1.000 | 0.5241 | 3.75 KB/s | 3.37 KB/s | 2.81 KB/s | 1.87 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | none | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 1.000 | 0.5241 | 7.50 KB/s | 6.75 KB/s | 5.62 KB/s | 3.75 KB/s | 1.87 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 1.326 | 0.4386 | 2.25 KB/s | 2.03 KB/s | 1.69 KB/s | 1.13 KB/s | 0.56 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 1.326 | 0.4386 | 4.50 KB/s | 4.05 KB/s | 3.38 KB/s | 2.25 KB/s | 1.13 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 1.326 | 0.3952 | 3.75 KB/s | 3.38 KB/s | 2.81 KB/s | 1.88 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 1.326 | 0.3952 | 7.50 KB/s | 6.75 KB/s | 5.63 KB/s | 3.75 KB/s | 1.88 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 1.326 | 0.5482 | 2.81 KB/s | 2.53 KB/s | 2.11 KB/s | 1.41 KB/s | 0.70 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 1.326 | 0.5482 | 5.62 KB/s | 5.06 KB/s | 4.22 KB/s | 2.81 KB/s | 1.41 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 1.326 | 0.3951 | 3.75 KB/s | 3.37 KB/s | 2.81 KB/s | 1.87 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 1.326 | 0.3951 | 7.50 KB/s | 6.75 KB/s | 5.62 KB/s | 3.75 KB/s | 1.87 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 1.326 | 0.5482 | 2.81 KB/s | 2.53 KB/s | 2.11 KB/s | 1.41 KB/s | 0.70 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 1.326 | 0.5482 | 5.62 KB/s | 5.06 KB/s | 4.22 KB/s | 2.81 KB/s | 1.41 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 1.326 | 0.3951 | 3.75 KB/s | 3.37 KB/s | 2.81 KB/s | 1.87 KB/s | 0.94 KB/s |
| artifacts/demo/ruvnet-demo.rvf | brotli-9 | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 1.326 | 0.3951 | 7.50 KB/s | 6.75 KB/s | 5.62 KB/s | 3.75 KB/s | 1.87 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 1.000 | 0.6810 | 2.63 KB/s | 2.37 KB/s | 1.98 KB/s | 1.32 KB/s | 0.66 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 1.000 | 0.6810 | 5.27 KB/s | 4.74 KB/s | 3.95 KB/s | 2.63 KB/s | 1.32 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 1.000 | 0.6662 | 4.77 KB/s | 4.29 KB/s | 3.57 KB/s | 2.38 KB/s | 1.19 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 1.000 | 0.6662 | 9.53 KB/s | 8.58 KB/s | 7.15 KB/s | 4.77 KB/s | 2.38 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 1.000 | 0.8213 | 3.18 KB/s | 2.86 KB/s | 2.38 KB/s | 1.59 KB/s | 0.79 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 1.000 | 0.8213 | 6.35 KB/s | 5.72 KB/s | 4.76 KB/s | 3.18 KB/s | 1.59 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 1.000 | 0.8228 | 5.89 KB/s | 5.30 KB/s | 4.41 KB/s | 2.94 KB/s | 1.47 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 1.000 | 0.8228 | 11.77 KB/s | 10.59 KB/s | 8.83 KB/s | 5.89 KB/s | 2.94 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 1.000 | 0.9408 | 3.64 KB/s | 3.27 KB/s | 2.73 KB/s | 1.82 KB/s | 0.91 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 1.000 | 0.9408 | 7.28 KB/s | 6.55 KB/s | 5.46 KB/s | 3.64 KB/s | 1.82 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 1.000 | 0.9325 | 6.67 KB/s | 6.00 KB/s | 5.00 KB/s | 3.34 KB/s | 1.67 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | none | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 1.000 | 0.9325 | 13.34 KB/s | 12.01 KB/s | 10.01 KB/s | 6.67 KB/s | 3.34 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 2.767 | 0.6681 | 7.15 KB/s | 6.43 KB/s | 5.36 KB/s | 3.57 KB/s | 1.79 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 2.767 | 0.6681 | 14.30 KB/s | 12.87 KB/s | 10.72 KB/s | 7.15 KB/s | 3.57 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 2.767 | 0.6320 | 12.51 KB/s | 11.26 KB/s | 9.38 KB/s | 6.25 KB/s | 3.13 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 2.767 | 0.6320 | 25.02 KB/s | 22.52 KB/s | 18.76 KB/s | 12.51 KB/s | 6.25 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 2.767 | 0.7793 | 8.34 KB/s | 7.50 KB/s | 6.25 KB/s | 4.17 KB/s | 2.08 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 2.767 | 0.7793 | 16.68 KB/s | 15.01 KB/s | 12.51 KB/s | 8.34 KB/s | 4.17 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 2.767 | 0.7777 | 15.39 KB/s | 13.85 KB/s | 11.54 KB/s | 7.70 KB/s | 3.85 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 2.767 | 0.7777 | 30.79 KB/s | 27.71 KB/s | 23.09 KB/s | 15.39 KB/s | 7.70 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 2.767 | 0.8906 | 9.53 KB/s | 8.58 KB/s | 7.15 KB/s | 4.76 KB/s | 2.38 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 2.767 | 0.8906 | 19.06 KB/s | 17.15 KB/s | 14.29 KB/s | 9.53 KB/s | 4.76 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 2.767 | 0.8426 | 16.68 KB/s | 15.01 KB/s | 12.51 KB/s | 8.34 KB/s | 4.17 KB/s |
| artifacts/demo/rvf_wasm_bg.wasm | brotli-11 | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 2.767 | 0.8426 | 33.35 KB/s | 30.02 KB/s | 25.01 KB/s | 16.68 KB/s | 8.34 KB/s |
| standalone.html | none | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 1.000 | 0.6960 | 2.69 KB/s | 2.42 KB/s | 2.02 KB/s | 1.35 KB/s | 0.67 KB/s |
| standalone.html | none | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 1.000 | 0.6960 | 5.38 KB/s | 4.84 KB/s | 4.04 KB/s | 2.69 KB/s | 1.35 KB/s |
| standalone.html | none | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 1.000 | 0.6974 | 4.99 KB/s | 4.49 KB/s | 3.74 KB/s | 2.49 KB/s | 1.25 KB/s |
| standalone.html | none | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 1.000 | 0.6974 | 9.98 KB/s | 8.98 KB/s | 7.48 KB/s | 4.99 KB/s | 2.49 KB/s |
| standalone.html | none | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 1.000 | 0.8379 | 3.24 KB/s | 2.92 KB/s | 2.43 KB/s | 1.62 KB/s | 0.81 KB/s |
| standalone.html | none | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 1.000 | 0.8379 | 6.48 KB/s | 5.83 KB/s | 4.86 KB/s | 3.24 KB/s | 1.62 KB/s |
| standalone.html | none | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 1.000 | 0.8526 | 6.10 KB/s | 5.49 KB/s | 4.57 KB/s | 3.05 KB/s | 1.52 KB/s |
| standalone.html | none | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 1.000 | 0.8526 | 12.20 KB/s | 10.98 KB/s | 9.15 KB/s | 6.10 KB/s | 3.05 KB/s |
| standalone.html | none | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 1.000 | 0.9631 | 3.72 KB/s | 3.35 KB/s | 2.79 KB/s | 1.86 KB/s | 0.93 KB/s |
| standalone.html | none | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 1.000 | 0.9631 | 7.45 KB/s | 6.70 KB/s | 5.59 KB/s | 3.72 KB/s | 1.86 KB/s |
| standalone.html | none | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 1.000 | 0.9762 | 6.98 KB/s | 6.28 KB/s | 5.24 KB/s | 3.49 KB/s | 1.75 KB/s |
| standalone.html | none | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 1.000 | 0.9762 | 13.97 KB/s | 12.57 KB/s | 10.47 KB/s | 6.98 KB/s | 3.49 KB/s |
| standalone.html | brotli-11 | v1-json | 19 | 5 | 552 B | 3.87 KB/s | 4.042 | 0.6928 | 10.83 KB/s | 9.75 KB/s | 8.12 KB/s | 5.41 KB/s | 2.71 KB/s |
| standalone.html | brotli-11 | v1-json | 19 | 10 | 552 B | 7.73 KB/s | 4.042 | 0.6928 | 21.66 KB/s | 19.49 KB/s | 16.24 KB/s | 10.83 KB/s | 5.41 KB/s |
| standalone.html | brotli-11 | v1-json | 27 | 5 | 1024 B | 7.15 KB/s | 4.042 | 0.6903 | 19.96 KB/s | 17.96 KB/s | 14.97 KB/s | 9.98 KB/s | 4.99 KB/s |
| standalone.html | brotli-11 | v1-json | 27 | 10 | 1024 B | 14.31 KB/s | 4.042 | 0.6903 | 39.91 KB/s | 35.92 KB/s | 29.93 KB/s | 19.96 KB/s | 9.98 KB/s |
| standalone.html | brotli-11 | v2-armoured | 19 | 5 | 665 B | 3.87 KB/s | 4.042 | 0.8351 | 13.05 KB/s | 11.75 KB/s | 9.79 KB/s | 6.53 KB/s | 3.26 KB/s |
| standalone.html | brotli-11 | v2-armoured | 19 | 10 | 665 B | 7.73 KB/s | 4.042 | 0.8351 | 26.11 KB/s | 23.49 KB/s | 19.58 KB/s | 13.05 KB/s | 6.53 KB/s |
| standalone.html | brotli-11 | v2-armoured | 27 | 5 | 1253 B | 7.15 KB/s | 4.042 | 0.8475 | 24.50 KB/s | 22.05 KB/s | 18.38 KB/s | 12.25 KB/s | 6.13 KB/s |
| standalone.html | brotli-11 | v2-armoured | 27 | 10 | 1253 B | 14.31 KB/s | 4.042 | 0.8475 | 49.00 KB/s | 44.10 KB/s | 36.75 KB/s | 24.50 KB/s | 12.25 KB/s |
| standalone.html | brotli-11 | v2-binary | 19 | 5 | 764 B | 3.87 KB/s | 4.042 | 0.9557 | 14.94 KB/s | 13.44 KB/s | 11.20 KB/s | 7.47 KB/s | 3.73 KB/s |
| standalone.html | brotli-11 | v2-binary | 19 | 10 | 764 B | 7.73 KB/s | 4.042 | 0.9557 | 29.87 KB/s | 26.89 KB/s | 22.41 KB/s | 14.94 KB/s | 7.47 KB/s |
| standalone.html | brotli-11 | v2-binary | 27 | 5 | 1437 B | 7.15 KB/s | 4.042 | 0.9662 | 27.93 KB/s | 25.14 KB/s | 20.95 KB/s | 13.97 KB/s | 6.98 KB/s |
| standalone.html | brotli-11 | v2-binary | 27 | 10 | 1437 B | 14.31 KB/s | 4.042 | 0.9662 | 55.86 KB/s | 50.28 KB/s | 41.90 KB/s | 27.93 KB/s | 13.97 KB/s |

**Where G is wrong.** G is linear in P, which is exact for a rateless code and wrong for v1's indexed cycling. Measured slots against the 1/P scaling G assumes:

| transport | 0% | 10% | 20% | 30% | 40% | 50% | 60% |
|---|---|---|---|---|---|---|---|
| rvQR v1 (indexed chunks) | 1.00× | 2.12× | 2.64× | 3.04× | 3.31× | 3.63× | 3.90× |
| fountain (shipped) | 1.00× | 0.99× | 1.00× | 0.99× | 0.99× | 1.00× | 0.99× |
| fountain (rlf-sys) | 1.00× | 1.01× | 1.02× | 1.01× | 1.01× | 1.02× | 1.01× |
| fountain (rlf) | 1.00× | 1.00× | 1.01× | 1.00× | 1.00× | 1.00× | 1.00× |
| fountain (lt) | 1.00× | 1.01× | 1.02× | 1.00× | 0.99× | 0.99× | 0.99× |

A ratio of 1.00× means G is exact for that transport at that loss rate. Anything above means G overstates it, so the G columns for `v1-json` at P below 1 are optimistic by the factor shown.

---

### Fleet: one screen, N receivers, content-addressed peer exchange

**This is a model, not a measurement.** It captures broadcast, independent per-receiver erasure, rateless coding at the measured reception overhead, and content addressing. It does not capture the peer channel's existence, capacity, discovery or signalling cost, nor loss that is correlated across receivers — which, in one room sharing one glare source and one person walking past, is the assumption most likely to be wrong. Simulated at K=2000 symbols, 12 trials per cell, seed 20260802; 665 B payload in a 792 B symbol.

| loss | N | source traffic, peer exchange | source traffic, broadcast only | naive unicast | peer bytes per receiver |
|---|---|---|---|---|---|
| 10% | 1 | 1.326× | 1.326× | 1× | 0 KB |
| 10% | 2 | 1.203× | 1.326× | 2× | 117 KB |
| 10% | 5 | 1.191× | 1.335× | 5× | 130 KB |
| 10% | 10 | 1.191× | 1.336× | 10× | 129 KB |
| 10% | 25 | 1.191× | 1.342× | 25× | 130 KB |
| 10% | 50 | 1.191× | 1.346× | 50× | 130 KB |
| 10% | 100 | 1.191× | 1.348× | 100× | 130 KB |
| 30% | 1 | 1.701× | 1.701× | 1× | 0 KB |
| 30% | 2 | 1.307× | 1.710× | 2× | 301 KB |
| 30% | 5 | 1.194× | 1.722× | 5× | 386 KB |
| 30% | 10 | 1.191× | 1.733× | 10× | 389 KB |
| 30% | 25 | 1.191× | 1.740× | 25× | 389 KB |
| 30% | 50 | 1.191× | 1.748× | 50× | 389 KB |
| 30% | 100 | 1.191× | 1.752× | 100× | 390 KB |
| 50% | 1 | 2.368× | 2.368× | 1× | 0 KB |
| 50% | 2 | 1.586× | 2.401× | 2× | 432 KB |
| 50% | 5 | 1.231× | 2.422× | 5× | 628 KB |
| 50% | 10 | 1.192× | 2.449× | 10× | 647 KB |
| 50% | 25 | 1.191× | 2.466× | 25× | 650 KB |
| 50% | 50 | 1.191× | 2.468× | 50× | 649 KB |
| 50% | 100 | 1.191× | 2.476× | 100× | 650 KB |

Multiples are of the artifact size, counted in bytes actually painted, so the QR envelope is inside them: a 665 B payload in a 792 B symbol is 1.191× before a single frame is lost.

**Projected onto a 1.00 GB artifact** (arithmetic on the measured multipliers above):

| loss | N | source, peer exchange | source, broadcast only | naive unicast |
|---|---|---|---|---|
| 10% | 1 | 1.33 GB | 1.33 GB | 1.00 GB |
| 10% | 2 | 1.20 GB | 1.33 GB | 2.00 GB |
| 10% | 5 | 1.19 GB | 1.34 GB | 5.00 GB |
| 10% | 10 | 1.19 GB | 1.34 GB | 10.00 GB |
| 10% | 25 | 1.19 GB | 1.34 GB | 25.00 GB |
| 10% | 50 | 1.19 GB | 1.35 GB | 50.00 GB |
| 10% | 100 | 1.19 GB | 1.35 GB | 100.00 GB |
| 30% | 1 | 1.70 GB | 1.70 GB | 1.00 GB |
| 30% | 2 | 1.31 GB | 1.71 GB | 2.00 GB |
| 30% | 5 | 1.19 GB | 1.72 GB | 5.00 GB |
| 30% | 10 | 1.19 GB | 1.73 GB | 10.00 GB |
| 30% | 25 | 1.19 GB | 1.74 GB | 25.00 GB |
| 30% | 50 | 1.19 GB | 1.75 GB | 50.00 GB |
| 30% | 100 | 1.19 GB | 1.75 GB | 100.00 GB |
| 50% | 1 | 2.37 GB | 2.37 GB | 1.00 GB |
| 50% | 2 | 1.59 GB | 2.40 GB | 2.00 GB |
| 50% | 5 | 1.23 GB | 2.42 GB | 5.00 GB |
| 50% | 10 | 1.19 GB | 2.45 GB | 10.00 GB |
| 50% | 25 | 1.19 GB | 2.47 GB | 25.00 GB |
| 50% | 50 | 1.19 GB | 2.47 GB | 50.00 GB |
| 50% | 100 | 1.19 GB | 2.48 GB | 100.00 GB |

**Is the multiplier flat in K?** The projection above applies a multiplier measured at K=2000 to a K of 1,614,650, which is only legitimate if it is. Measured at N=100, 30% loss:

| K | peer-exchange multiplier | broadcast-only multiplier |
|---|---|---|
| 81 | 1.0000 | 1.6975 |
| 500 | 1.0000 | 1.5143 |
| 2000 | 1.0000 | 1.4720 |
| 8000 | 1.0000 | 1.4514 |

---

### Progressive activation: time to the first trusted closure

**This is a model.** Nothing in this repository signs a closure or activates one; what follows is arithmetic over measured span sizes, measured artifact sizes and measured byte rates. Each closure pays its own 64 B signature (Ed25519) and its own manifest frame, and rounds up to whole frames. `core.js` declares `SIGNATURE_SIZE = 16`, which is a truncated tag rather than any standard signature size; the larger figure is used here because it is the one a real detached signature costs.

**The gate is closures 1–3, not closure 1.** ADR-022 §2.1 says the agent starts once closures 1–3 verify, so that is the figure reported as meeting or missing the target; time-to-closure-1 is shown alongside because it is the easier number and it is easy to quote the wrong one.

**ruvnet-demo.rvf, split on its own spans** at v1 JSON, 512 B @ 5 fps — closure 1 at 0.40 s, closures 1–3 at 1.80 s (meets the 3 s target), whole artifact 1.8 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 374 | measured | 2 | 0.40 s | 0.7 |
| witness | 132 | measured | 2 | 0.80 s | 1.3 |
| vector payload | 1798 | measured | 5 | 1.80 s | 3.0 |

**ruvnet-demo.rvf, split on its own spans** at v2 armoured, 665 B @ 5 fps — closure 1 at 0.40 s, closures 1–3 at 1.60 s (meets the 3 s target), whole artifact 1.6 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 374 | measured | 2 | 0.40 s | 0.7 |
| witness | 132 | measured | 2 | 0.80 s | 1.3 |
| vector payload | 1798 | measured | 4 | 1.60 s | 2.7 |

**ruvnet-demo.rvf, split on its own spans** at v2 armoured, 665 B @ 10 fps — closure 1 at 0.20 s, closures 1–3 at 0.80 s (meets the 3 s target), whole artifact 0.8 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 374 | measured | 2 | 0.20 s | 0.7 |
| witness | 132 | measured | 2 | 0.40 s | 1.3 |
| vector payload | 1798 | measured | 4 | 0.80 s | 2.7 |

**ruvnet-demo.rvf, split on its own spans** at v2 armoured, 665 B @ 30 fps — closure 1 at 0.07 s, closures 1–3 at 0.27 s (meets the 3 s target), whole artifact 0.3 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 374 | measured | 2 | 0.07 s | 0.7 |
| witness | 132 | measured | 2 | 0.13 s | 1.3 |
| vector payload | 1798 | measured | 4 | 0.27 s | 2.7 |

**1 MiB agent container (modelled split, real runtime size)** at v1 JSON, 512 B @ 5 fps — closure 1 at 0.60 s, closures 1–3 at 94.20 s (MISSES the 3 s target), whole artifact 411.2 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 3 | 0.60 s | 1.0 |
| minimal RVM runtime | 40989 | measured | 82 | 17.00 s | 28.3 |
| required code + hot state | 196608 | modelled | 386 | 94.20 s | 157.0 |
| cold indexes + optional assets | 810467 | modelled | 1585 | 411.20 s | 685.3 |

**1 MiB agent container (modelled split, real runtime size)** at v2 armoured, 665 B @ 5 fps — closure 1 at 0.40 s, closures 1–3 at 72.40 s (MISSES the 3 s target), whole artifact 316.4 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.40 s | 0.7 |
| minimal RVM runtime | 40989 | measured | 63 | 13.00 s | 21.7 |
| required code + hot state | 196608 | modelled | 297 | 72.40 s | 120.7 |
| cold indexes + optional assets | 810467 | modelled | 1220 | 316.40 s | 527.3 |

**1 MiB agent container (modelled split, real runtime size)** at v2 armoured, 665 B @ 10 fps — closure 1 at 0.20 s, closures 1–3 at 36.20 s (MISSES the 3 s target), whole artifact 158.2 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.20 s | 0.7 |
| minimal RVM runtime | 40989 | measured | 63 | 6.50 s | 21.7 |
| required code + hot state | 196608 | modelled | 297 | 36.20 s | 120.7 |
| cold indexes + optional assets | 810467 | modelled | 1220 | 158.20 s | 527.3 |

**1 MiB agent container (modelled split, real runtime size)** at v2 armoured, 665 B @ 30 fps — closure 1 at 0.07 s, closures 1–3 at 12.07 s (MISSES the 3 s target), whole artifact 52.7 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.07 s | 0.7 |
| minimal RVM runtime | 40989 | measured | 63 | 2.17 s | 21.7 |
| required code + hot state | 196608 | modelled | 297 | 12.07 s | 120.7 |
| cold indexes + optional assets | 810467 | modelled | 1220 | 52.73 s | 527.3 |

**standalone.html (modelled 4-way split, real total)** at v1 JSON, 512 B @ 5 fps — closure 1 at 0.60 s, closures 1–3 at 65.40 s (MISSES the 3 s target), whole artifact 225.0 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 3 | 0.60 s | 1.0 |
| minimal RVM runtime | 32768 | modelled | 66 | 13.80 s | 23.0 |
| required code + hot state | 131072 | modelled | 258 | 65.40 s | 109.0 |
| cold indexes + optional assets | 407814 | modelled | 798 | 225.00 s | 375.0 |

**standalone.html (modelled 4-way split, real total)** at v2 armoured, 665 B @ 5 fps — closure 1 at 0.40 s, closures 1–3 at 50.40 s (MISSES the 3 s target), whole artifact 173.4 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.40 s | 0.7 |
| minimal RVM runtime | 32768 | modelled | 51 | 10.60 s | 17.7 |
| required code + hot state | 131072 | modelled | 199 | 50.40 s | 84.0 |
| cold indexes + optional assets | 407814 | modelled | 615 | 173.40 s | 289.0 |

**standalone.html (modelled 4-way split, real total)** at v2 armoured, 665 B @ 10 fps — closure 1 at 0.20 s, closures 1–3 at 25.20 s (MISSES the 3 s target), whole artifact 86.7 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.20 s | 0.7 |
| minimal RVM runtime | 32768 | modelled | 51 | 5.30 s | 17.7 |
| required code + hot state | 131072 | modelled | 199 | 25.20 s | 84.0 |
| cold indexes + optional assets | 407814 | modelled | 615 | 86.70 s | 289.0 |

**standalone.html (modelled 4-way split, real total)** at v2 armoured, 665 B @ 30 fps — closure 1 at 0.07 s, closures 1–3 at 8.40 s (MISSES the 3 s target), whole artifact 28.9 s

| closure | bytes | source | frames | cumulative | fps needed for 3 s |
|---|---|---|---|---|---|
| manifest + policy | 512 | modelled | 2 | 0.07 s | 0.7 |
| minimal RVM runtime | 32768 | modelled | 51 | 1.77 s | 17.7 |
| required code + hot state | 131072 | modelled | 199 | 8.40 s | 84.0 |
| cold indexes + optional assets | 407814 | modelled | 615 | 28.90 s | 289.0 |

**The largest closure content that fits the 3-second target, by signature scheme:**

| transport | signature | closures | P | frames in budget | signature cost | max closure content | feasible? |
|---|---|---|---|---|---|---|---|
| v1 JSON, 512 B @ 5 fps | Ed25519 | 1 | 1 | 15 | 64 B | 7104 B | yes |
| v1 JSON, 512 B @ 5 fps | Ed25519 | 3 | 1 | 15 | 192 B | 5952 B | yes |
| v1 JSON, 512 B @ 5 fps | Ed25519 | 1 | 0.75 (projection) | 11 | 64 B | 5056 B | yes |
| v1 JSON, 512 B @ 5 fps | Ed25519 | 3 | 0.75 (projection) | 11 | 192 B | 3904 B | yes |
| v1 JSON, 512 B @ 5 fps | Ed25519 | 1 | 0.5 (projection) | 7 | 64 B | 3008 B | yes |
| v1 JSON, 512 B @ 5 fps | Ed25519 | 3 | 0.5 (projection) | 7 | 192 B | 1856 B | yes |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 1 | 15 | 3309 B | 3859 B | yes |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 1 | 15 | 9927 B | 0 B | **no** |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 0.75 (projection) | 11 | 3309 B | 1811 B | yes |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 0.75 (projection) | 11 | 9927 B | 0 B | **no** |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 0.5 (projection) | 7 | 3309 B | 0 B | **no** |
| v1 JSON, 512 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 0.5 (projection) | 7 | 9927 B | 0 B | **no** |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 1 | 1 | 15 | 64 B | 9246 B | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 3 | 1 | 15 | 192 B | 7788 B | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 1 | 0.75 (projection) | 11 | 64 B | 6586 B | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 3 | 0.75 (projection) | 11 | 192 B | 5128 B | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 1 | 0.5 (projection) | 7 | 64 B | 3926 B | yes |
| v2 armoured, 665 B @ 5 fps | Ed25519 | 3 | 0.5 (projection) | 7 | 192 B | 2468 B | yes |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 1 | 15 | 3309 B | 6001 B | yes |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 1 | 15 | 9927 B | 0 B | **no** |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 0.75 (projection) | 11 | 3309 B | 3341 B | yes |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 0.75 (projection) | 11 | 9927 B | 0 B | **no** |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 1 | 0.5 (projection) | 7 | 3309 B | 681 B | yes |
| v2 armoured, 665 B @ 5 fps | ML-DSA-65 (ADR-012) | 3 | 0.5 (projection) | 7 | 9927 B | 0 B | **no** |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 1 | 1 | 30 | 64 B | 19221 B | yes |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 3 | 1 | 30 | 192 B | 17763 B | yes |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 1 | 0.75 (projection) | 22 | 64 B | 13901 B | yes |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 3 | 0.75 (projection) | 22 | 192 B | 12443 B | yes |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 1 | 0.5 (projection) | 15 | 64 B | 9246 B | yes |
| v2 armoured, 665 B @ 10 fps | Ed25519 | 3 | 0.5 (projection) | 15 | 192 B | 7788 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 1 | 1 | 30 | 3309 B | 15976 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 3 | 1 | 30 | 9927 B | 8028 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 1 | 0.75 (projection) | 22 | 3309 B | 10656 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 3 | 0.75 (projection) | 22 | 9927 B | 2708 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 1 | 0.5 (projection) | 15 | 3309 B | 6001 B | yes |
| v2 armoured, 665 B @ 10 fps | ML-DSA-65 (ADR-012) | 3 | 0.5 (projection) | 15 | 9927 B | 0 B | **no** |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 1 | 1 | 90 | 64 B | 59121 B | yes |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 3 | 1 | 90 | 192 B | 57663 B | yes |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 1 | 0.75 (projection) | 67 | 64 B | 43826 B | yes |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 3 | 0.75 (projection) | 67 | 192 B | 42368 B | yes |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 1 | 0.5 (projection) | 45 | 64 B | 29196 B | yes |
| v2 armoured, 665 B @ 30 fps | Ed25519 | 3 | 0.5 (projection) | 45 | 192 B | 27738 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 1 | 1 | 90 | 3309 B | 55876 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 3 | 1 | 90 | 9927 B | 47928 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 1 | 0.75 (projection) | 67 | 3309 B | 40581 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 3 | 0.75 (projection) | 67 | 9927 B | 32633 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 1 | 0.5 (projection) | 45 | 3309 B | 25951 B | yes |
| v2 armoured, 665 B @ 30 fps | ML-DSA-65 (ADR-012) | 3 | 0.5 (projection) | 45 | 9927 B | 18003 B | yes |

Signature cost is `closures × signature bytes`, because ADR-022 signs each closure separately. Where "feasible?" is no, the signatures alone exhaust the frame budget and no closure content fits at all, whatever it contains.

---

### Working memory and payload copies

Largest artifact in the repository: `standalone.html`, 572166 B. Measured in a separate process under `--expose-gc`, so the figures are the pipeline's and not the rest of the harness's. "Live" is heapUsed + external after a forced collection, divided by the artifact size — external is where typed-array payloads actually are, and a copy count taken from heapUsed alone under-reports them by about half.

| stage | heap Δ | external Δ | total Δ | live copies | peak RSS | ms |
|---|---|---|---|---|---|---|
| v1 sender: buildFrames | 1.70× | 0.07× | 1.78× | 1.78× | 54.6 MiB | 14.5 |
| v1 receiver: ingest (frames drained) | -1.01× | 1.00× | -0.01× | 1.77× | 55.9 MiB | 7.9 |
| v1 receiver: finalize (assemble + SHA-256) | 0.01× | 1.00× | 1.01× | 2.78× | 56.5 MiB | 5.3 |
| v2 sender: buildFrames | 0.36× | 1.04× | 1.41× | 1.41× | 58.4 MiB | 11.6 |
| v2 sender: armour, one frame retained | 0.04× | 0.00× | 0.04× | 1.45× | 58.7 MiB | 3.8 |
| v2 harness: armour every frame, all retained | 37.60× | 0.00× | 37.60× | 39.05× | 83.3 MiB | 18.7 |
| v2 receiver: ingest (frames drained) | -37.50× | 0.00× | -37.50× | 1.55× | 87.4 MiB | 15.9 |
| v2 receiver: finalize (assemble + SHA-256) | 0.01× | 1.00× | 1.01× | 2.56× | 87.9 MiB | 2.1 |

**Peak RSS 87.9 MiB, of which 39.9 MiB is this pipeline above an empty Node process — inside the 128 MiB budget.**

**Payload copies, receiver side: v1 peaks at 2.78×, v2 at 2.56×** against a budget of fewer than two. Sender side, v1 holds 1.78× as base64url text and v2 1.45× with one armoured frame retained. Both transfers verified byte-exact (v1 yes, v2 yes).

**Allocation sites, read out of the source rather than inferred from the numbers:**

| stage | what allocates | expected cost |
|---|---|---|
| v1 sender: buildFrames | `core.b64uEncode` per chunk, then `JSON.stringify` per frame | ≈1.33× the artifact as base64url text plus the JSON envelope, all retained as the frame list |
| v1 receiver: ingest (frames drained) | `core.b64uDecode` per frame into `state.chunks` | 1× the artifact, as one Uint8Array per frame |
| v1 receiver: finalize (assemble + SHA-256) | `core.assemble` allocates the output buffer; SHA-256 streams over it | 1× the artifact; the hash itself is O(1) in space |
| v2 sender: buildFrames | `proto2.encodeFrame` allocates header+payload and copies the slice in | 1× the artifact plus 28 B per frame — proto2 copies rather than aliasing the source |
| v2 sender: armour, one frame retained | `proto2.toTransport` builds one string; only the current one is held | one frame, ≈0 |
| v2 harness: armour every frame, all retained | `toTransport` appends one character at a time, so V8 leaves a cons-string rope | nominally ≈1.14× the frame bytes; measured far higher, because an unflattened rope costs a node per concatenation |
| v2 receiver: ingest (frames drained) | `proto2.fromTransport` allocates a frame buffer; `payload` is a subarray VIEW of it | ≈1.04× the artifact — the whole 693-byte frame stays alive behind each 665-byte payload view |
| v2 receiver: finalize (assemble + SHA-256) | `proto2.assemble` allocates the output buffer | 1× the artifact |

Raw results written to /private/tmp/claude-501/-Users-cohen-GitHub-ruvnet-ruvector/05d2576d-2dee-4999-b6a3-ce2701279e05/scratchpad/rvqr/bench/results/full.json
