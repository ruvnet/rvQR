/*!
 * Suite 11 — working memory and payload copies.
 *
 * The budgets under test, both from
 * [ADR-025](../../docs/adr/ADR-025-rvqr-zero-copy-pipeline.md) §2.2: **under
 * 128 MiB of working memory**, and **fewer than two full payload copies live at
 * once**. The memory budget is not a performance goal — ADR-015 §2.3 lists it
 * among the invariants a learned control policy may not trade away, alongside
 * trust and verification — so it is measured rather than argued.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED HERE, AND WHY THE OLD NUMBERS WERE TOO KIND
 * ---------------------------------------------------------------------------
 *
 * Until 2026-08-03 this suite reported the shipped receivers at **2.59× on v1
 * and 2.42× on v2**, from `bench/lib/memprobe.mjs`'s retained-bytes
 * measurement. `artifacts/pipeline.test.js`'s instrument rated the SAME
 * receivers at **3.00×**. Two suites, one subject, two numbers — and the gap is
 * not rounding.
 *
 * THE GAP IS ONE WHOLE COPY OF THE ARTIFACT, AND THE INSTRUMENT IS RIGHT.
 *
 * `core.sha256Bytes` allocates `new Uint8Array(total)` where `total` is the
 * 64-byte-aligned padded length of its input, copies the entire message into
 * it, hashes it and drops it. At the moment that buffer exists, so do the chunk
 * list and the assembled output. Three full copies coexist. The retained
 * measurement cannot see it, because retained bytes are sampled AFTER the
 * transfer, and by then the padded copy is garbage — `memprobe.mjs`'s own
 * docblock says as much: "It cannot see a buffer that was allocated and freed
 * inside one stage."
 *
 * ADR-025 §2.2 bounds copies that COEXIST. So the peak is the quantity the
 * budget is about, the retained figure was measuring something else, and this
 * suite now reports three numbers under three names rather than one number
 * under an ambiguous one:
 *
 *   ledger peak       peak coexisting receiver-held bytes, exact byte lengths,
 *                     from `artifacts/pipeline.js`'s ledger.   shipped 3.00×
 *   ledger handover   the subset still live when the artifact is handed over,
 *                     from the same ledger.                    shipped 2.00×
 *   retained          real bytes after a forced collection, allocator overhead
 *                     included, result held.        shipped 2.39× (v1, 1.18 MB)
 *
 * They disagree in BOTH directions and each direction has a cause. The ledger
 * reads 1.00× HIGHER than retained because it catches the transient padded
 * copy. Retained reads 0.39× higher than the ledger's handover figure because
 * it counts what the allocator handed back — `core.js` keeps its chunks in a
 * dictionary-mode `Object.create(null)`, and that per-entry overhead is real
 * memory the ledger's exact-byte arithmetic does not model.
 *
 * The transient copy is not taken on trust in either direction. `memprobe.mjs`
 * WEIGHS it: live bytes are sampled immediately before and immediately after
 * the one-shot hash with no collection in between, so the padded buffer is
 * still uncollected at the second sample. It comes out at 1.0055× the artifact
 * against a modelled 1.0000×, which is the ledger's third copy, measured.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND IN HOW MANY PROCESSES
 * ---------------------------------------------------------------------------
 *
 * Twenty-seven child processes, because four of the quantities here are
 * mutually contaminating:
 *
 *   1  `--mode stages`     the send and receive pipelines stage by stage, on
 *                          the largest artifact. Unchanged in method; this is
 *                          where the sender figures and the `toTransport` rope
 *                          come from.
 *   1  `--mode ledger`     exact byte accounting over every artifact, both
 *                          protocols, both receivers; the weighed hash copy;
 *                          the crossover scan; the size ladder.
 *  12  `--mode cell --measure retained`  one receiver alone in a process, warmed,
 *                          five measured cycles, WITH A MEASURED ERROR BAR.
 *  12  `--mode cell --measure rss`       the same twelve, cold, for peak RSS —
 *                          which is a high-water mark that never comes back
 *                          down, so two receivers cannot share a process
 *                          without the second inheriting the first's peak.
 *   1  `--mode throughput` wall time, so "streaming" is not assumed free.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE RETAINED MEASUREMENT STOPS WORKING, STATED UP FRONT
 * ---------------------------------------------------------------------------
 *
 * The heap method has a floor. A CONTROL cycle — the identical transfer with
 * the result discarded before the collection — should retain zero and instead
 * lands anywhere in a band 7–30 KB wide, run to run. That band is measured per
 * cell and travels with every retained figure. On `standalone.html` it is under
 * 2.5% and the retained column is a measurement; on the 2,304-byte demo
 * container it is several times the artifact and the retained column is not a
 * measurement of anything, so it is reported as unresolvable rather than
 * printed as a ratio. This is precisely why the exact-byte ledger is the
 * primary instrument here and the heap is the corroboration.
 *
 * ---------------------------------------------------------------------------
 * THREE ADR-025 CRITERIA THIS REPOSITORY CANNOT MEET, AND WILL NOT PRETEND TO
 * ---------------------------------------------------------------------------
 *
 * ADR-025 specifies a RUST pipeline — memory mapping, SIMD BLAKE3, SIMD
 * compression, 4–8 bounded streams. rvQR is a JavaScript static site.
 *
 *   2. Peak RSS under 128 MiB for a 1 GB transfer — NOT APPLICABLE. The optical
 *      channel runs at 2.44 KB/s, so 1 GB is 4.7 days of continuous transfer.
 *      There is no such run and inventing one would be a fabricated
 *      measurement. The budget itself IS measured, on every artifact that
 *      exists here.
 *   3. Internal throughput ≥ 2× the radio ceiling — NOT APPLICABLE. There is no
 *      radio tier in this repository, so there is no ceiling to be twice. The
 *      throughput table below is a comparison between two receivers, not a
 *      claim against a ceiling that does not exist.
 *   6. Scalar fallback exercised on every SIMD path — NOT APPLICABLE. There are
 *      no SIMD paths: no intrinsics, no wasm-simd, no build matrix.
 *
 * The reasons live in `artifacts/pipeline.js`'s `ADR025_CRITERIA` and are read
 * out of the running module into the report, so the omission cannot become
 * silent later.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(HERE, '..', 'lib', 'memprobe.mjs');

const ARTIFACTS = ['ruvnet-demo.rvf', 'rvf_wasm_bg.wasm', 'standalone.html'];
const PROTOCOLS = ['v1', 'v2'];
const PATHS = ['shipped', 'streaming'];

/**
 * The allocation sites, read out of the source rather than inferred from the
 * numbers. Each entry is what the code does; the measured columns are what it
 * cost. Where the two disagree, the report says which one it believes and why.
 */
export const ALLOCATION_SITES = [
  {
    stage: 'v1 sender: buildFrames',
    site: '`core.b64uEncode` per chunk, then `JSON.stringify` per frame',
    cost: '≈1.33× the artifact as base64url text plus the JSON envelope, all retained as the frame list'
  },
  {
    stage: 'v1 receiver: ingest (frames drained)',
    site: '`core.b64uDecode` per frame into `state.chunks`',
    cost: '1× the artifact, as one Uint8Array per frame'
  },
  {
    stage: 'v1 receiver: finalize (assemble + SHA-256)',
    site: '`core.assemble` allocates the output buffer; `core.sha256Bytes` allocates a PADDED COPY of it',
    cost: '1× the artifact for the output, and 1× more for the padded hash input — the copy the retained column cannot see'
  },
  {
    stage: 'v2 sender: buildFrames',
    site: '`proto2.encodeFrame` allocates header+payload and copies the slice in',
    cost: '1× the artifact plus 28 B per frame — proto2 copies rather than aliasing the source'
  },
  {
    stage: 'v2 sender: armour, one frame retained',
    site: '`proto2.toTransport` builds one string; only the current one is held',
    cost: 'one frame, ≈0'
  },
  {
    stage: 'v2 harness: armour every frame, all retained',
    site: '`toTransport` builds into a preallocated array and joins once',
    cost: '≈1.03 B retained per output byte. It appended one character at a time until 6374266, which left V8 an unflattened cons-string rope costing 31.6 B per output byte — about 37× the artifact when every frame was held'
  },
  {
    stage: 'v2 receiver: ingest (frames drained)',
    site: '`proto2.fromTransport` copies the payload out of the frame buffer',
    cost: 'owned 1.296× against 1.341× for the view it replaced — 29.9 B saved per frame, which is the 28-byte header plus slack. The view pinned a whole 693-byte frame behind each 665-byte payload'
  },
  {
    stage: 'v2 receiver: finalize (assemble + SHA-256)',
    site: '`proto2.assemble` allocates the output buffer, then the same one-shot digest pads a copy of it',
    cost: '1× the artifact for the output, 1× more for the padded hash input'
  }
];

/**
 * What the streaming receiver allocates instead, and what each one costs. These
 * are the three handles still open at handover — `pipeline.test.js` asserts
 * there are exactly three — plus the one that is opened and closed per frame.
 */
export const STREAMING_SITES = [
  {
    kind: 'output',
    site: '`new Uint8Array(m.size)` once, when the manifest arrives',
    cost: '1× the artifact. The only allocation of the transfer that scales with the payload'
  },
  {
    kind: 'frame-payload',
    site: 'the parser\'s owned payload, written into `out` at its offset and released in a `finally`',
    cost: 'one chunk — 512 B on v1, 665 B on v2 — live for the duration of one `ingest` call'
  },
  {
    kind: 'frame-index',
    site: '`new Uint8Array(state.total)` — one byte per frame, so duplicates can be refused',
    cost: 'one byte per frame. Not payload, and charged to the receiver anyway'
  },
  {
    kind: 'hash-carry',
    site: '`createSha256`\'s 64-byte carry block',
    cost: '64 B, fixed. The frontier absorbs whole blocks, so it stays empty until the final run'
  },
  {
    kind: 'pending-payload',
    site: 'data frames that arrive before the manifest, capped at a FRACTION of the transfer',
    cost: 'up to 0.25× the artifact, and zero on an in-order transfer. A flat 256 KiB cap measured 2.0036× on a 40 KB artifact, which is why the cap is relative'
  }
];

function probe(args, timeoutMs) {
  let raw;
  try {
    raw = execFileSync(process.execPath, ['--expose-gc', PROBE, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (err) {
    return { available: false, reason: `memory probe failed (${args.join(' ')}): ${String(err.message || err)}` };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { available: false, reason: `memory probe produced unparseable output (${args.join(' ')})` };
  }
}

export function runMemorySuite({ timeoutMs = 120000 } = {}) {
  const stages = probe(['--mode', 'stages'], timeoutMs);
  if (!stages.available) return stages;

  const byStage = new Map(ALLOCATION_SITES.map((s) => [s.stage, s]));
  stages.stages = stages.stages.map((s) => ({ ...s, allocation: byStage.get(s.name) || null }));

  const ledger = probe(['--mode', 'ledger'], timeoutMs);
  const throughput = probe(['--mode', 'throughput'], timeoutMs);

  // One child per cell per measure. The two measures need opposite treatments —
  // one warmed, one cold — so they cannot share a process, and peak RSS cannot
  // share a process with anything at all.
  const cells = [];
  for (const artifact of ARTIFACTS) {
    for (const protocol of PROTOCOLS) {
      for (const p of PATHS) {
        const base = ['--mode', 'cell', '--artifact', artifact, '--proto', protocol, '--path', p];
        const retained = probe([...base, '--measure', 'retained'], timeoutMs);
        const rss = probe([...base, '--measure', 'rss'], timeoutMs);
        if (!retained.available && !rss.available) continue;
        const l = ledgerCell(ledger, artifact, protocol);
        const side = l ? l[p] : null;
        cells.push({
          artifact,
          artifactBytes: retained.artifactBytes ?? rss.artifactBytes ?? null,
          protocol,
          path: p,
          chunk: retained.chunk ?? rss.chunk ?? null,
          frames: retained.frames ?? rss.frames ?? null,
          verified: !!(retained.verified && rss.verified),
          // exact byte accounting
          ledgerPeakCopies: side ? side.peakCopies : NaN,
          ledgerHandoverCopies: side ? side.handoverCopies : NaN,
          ledgerWithinBudget: side ? side.withinBudget : null,
          writePasses: side ? side.writePasses : NaN,
          hashPasses: side ? side.hashPasses : NaN,
          overheadBytes: side && side.overheadBytes !== undefined ? side.overheadBytes : null,
          // weighed heap
          retainedCopies: retained.available ? retained.retainedCopies : NaN,
          retainedMinCopies: retained.available ? retained.retainedMinCopies : NaN,
          retainedMaxCopies: retained.available ? retained.retainedMaxCopies : NaN,
          retainedBandCopies: retained.available ? retained.controlBandCopies : NaN,
          retainedResolvable: retained.available ? retained.retainedResolvable : null,
          // peak RSS, cold, alone in a process
          peakRssMiB: rss.available ? rss.peakRssMiB : NaN,
          peakRssAboveBaselineMiB: rss.available ? rss.peakRssAboveBaselineMiB : NaN,
          withinRssBudget: rss.available ? rss.withinBudget : null
        });
      }
    }
  }

  // Attach the throughput rows to their cells, so one table can carry both.
  if (throughput.available) {
    for (const c of cells) {
      const t = throughput.rows.find(
        (r) => r.artifact === c.artifact && r.protocol === c.protocol && r.path === c.path
      );
      if (t) {
        c.medianMs = t.medianMs;
        c.mibPerSec = t.mibPerSec;
        c.reps = t.reps;
      }
    }
  }

  // Two peaks, kept apart. The receiver peak is the highest of the twelve
  // isolated receive-only processes; the suite peak also includes the `stages`
  // process, which runs both senders AND both receivers back to back and is
  // therefore always the larger of the two. Reporting the suite peak as though
  // it were a receiver's would overstate the receiver.
  const receiverPeakRssMiB = Math.max(
    ...cells.map((c) => c.peakRssMiB).filter((n) => Number.isFinite(n))
  );
  const suitePeakRssMiB = Math.max(receiverPeakRssMiB, stages.peakRssMiB);

  return {
    ...stages,
    ledger,
    throughput,
    cells,
    streamingSites: STREAMING_SITES,
    reconciliation: reconcile(ledger, cells),
    receiverPeakRssMiB,
    receiverWithinRssBudget: receiverPeakRssMiB <= 128,
    suitePeakRssMiB,
    suiteWithinRssBudget: suitePeakRssMiB <= 128,
    probePath: PROBE
  };
}

function ledgerCell(ledger, artifact, protocol) {
  if (!ledger || !ledger.available) return null;
  return ledger.cells.find((c) => c.artifact === artifact && c.protocol === protocol) || null;
}

/**
 * The three accountings, side by side, on the one artifact where all three are
 * meaningful — plus the weighed hash copy that explains the largest of the
 * three gaps. This is the object the report's reconciliation paragraph is built
 * from, so the argument cannot drift from the numbers.
 */
function reconcile(ledger, cells) {
  const big = cells.filter((c) => c.artifact === 'standalone.html');
  const pick = (protocol, p) => big.find((c) => c.protocol === protocol && c.path === p) || null;
  const rows = [];
  for (const protocol of PROTOCOLS) {
    for (const p of PATHS) {
      const c = pick(protocol, p);
      if (!c) continue;
      rows.push({
        protocol,
        path: p,
        ledgerPeakCopies: c.ledgerPeakCopies,
        ledgerHandoverCopies: c.ledgerHandoverCopies,
        retainedCopies: c.retainedCopies,
        retainedBandCopies: c.retainedBandCopies,
        // The two gaps, each with the cause the report names.
        peakMinusRetained: c.ledgerPeakCopies - c.retainedCopies,
        retainedMinusHandover: c.retainedCopies - c.ledgerHandoverCopies
      });
    }
  }
  return {
    artifact: 'standalone.html',
    rows,
    hashPadding: ledger && ledger.available ? ledger.hashPadding : [],
    // The conclusion, in the form a test could assert rather than a sentence.
    verdict: 'ledger-peak',
    verdictReason:
      'ADR-025 §2.2 bounds copies that coexist. The transient padded hash input coexists with ' +
      'the chunk list and the assembled output, so it counts; the retained measurement is taken ' +
      'after it has been collected, so it cannot see it. The peak is the number the budget is about.'
  };
}
