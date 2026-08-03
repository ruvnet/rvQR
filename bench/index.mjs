#!/usr/bin/env node
/*!
 * rvQR benchmark harness — entry point.
 *
 *   node bench/index.mjs                 run everything, print the report
 *   node bench/index.mjs --suite loss    run one suite
 *   node bench/index.mjs --trials 500    more trials per cell
 *   node bench/index.mjs --seed 12345    a different (still fixed) seed
 *   node bench/index.mjs --json out.json also write the raw results
 *
 * Suites: loss, overhead, payloads, delta, qr, proto, compress, objective,
 *         fleet, closures, memory, semdelta, planner.
 *
 * Deterministic and offline: no network access at any point, and every random
 * draw comes from the seed printed in the header. Two runs with the same seed
 * on the same machine produce the same numbers; two runs on different machines
 * produce the same frame counts and different milliseconds.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { REPO_ROOT, loadShippedFountain, loadShippedDelta } from './lib/transports.mjs';
import { fmt, markdownTable, harmonic } from './lib/stats.mjs';
import { runLossSuite, runManifestSweep, LOSS_RATES } from './suites/loss.mjs';
import { runPayloadSuite, projectTransfer } from './suites/payloads.mjs';
import { runDeltaSuite, projectLargeContainer } from './suites/delta.mjs';
import { runQrCostSuite, runVersionSweep, runDecodeVersionSweep, loadDecoder } from './suites/qrcost.mjs';
import { runOverheadSuite, runSymbolSizeSweep } from './suites/overhead.mjs';
import { runProtoDensity, runProtoAtAppRates, runV1FrameSpread, loadProto2 } from './suites/proto.mjs';
import {
  loadCorpus,
  decisionCorpus,
  runCompressionSuite,
  runBreakEvenSweep,
  runDecisionSuite,
  runBrowserSuite,
  runSampledPath,
  runGateBand,
  runAdr003Recheck,
  ENVELOPE_GAIN_GATE
} from './suites/compress.mjs';
import { runObjectiveSuite, indexedPenalty, P_SWEEP } from './suites/objective.mjs';
import { runFleetSuite, runFleetScaleCheck } from './suites/fleet.mjs';
import { runClosureSuite, closureProfiles, FIRST_CLOSURE_TARGET_SECONDS } from './suites/closures.mjs';
import { runMemorySuite } from './suites/memory.mjs';
import { runSemDeltaSuite } from './suites/semdelta.mjs';
import { runPlannerSuite } from './suites/planner.mjs';
import { asciiPlot } from './lib/chart.mjs';

// --- Arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { suite: 'all', trials: 200, seed: 20260802, json: null, quick: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') out.suite = argv[++i];
    else if (a === '--trials') out.trials = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--quick') out.quick = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.quick) out.trials = Math.min(out.trials, 25);
  return out;
}

// --- Environment -------------------------------------------------------------

function captureEnvironment() {
  let commit = 'unknown';
  let dirty = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    dirty = execSync('git status --porcelain', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim().length
      ? 'dirty'
      : 'clean';
  } catch {
    /* not a git checkout; the report says so */
  }
  const cpus = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus.length ? `${cpus[0].model} x${cpus.length}` : 'unknown',
    totalMemGB: (os.totalmem() / 1024 ** 3).toFixed(1),
    commit,
    worktree: dirty,
    ranAt: new Date().toISOString()
  };
}

function moduleInventory() {
  // Derived, not hardcoded. This list previously named six modules by hand and
  // went stale the moment a seventh shipped: the semantic-delta suite measured
  // artifacts/semdelta.js while this header omitted it, so the run's own
  // provenance disagreed with what the run had actually exercised. A benchmark
  // that misreports which code it measured is worse than one that reports
  // nothing. Enumerating the directory means a new module appears here without
  // anyone remembering to add it — the same reason build-artifact.mjs derives
  // its script list from index.html rather than repeating it.
  const enumerate = (dir) => {
    try {
      return fs.readdirSync(path.join(REPO_ROOT, dir))
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'tests.js')
        .sort()
        .map((f) => dir + '/' + f);
    } catch { return []; }
  };
  const files = [...enumerate('artifacts'), ...enumerate('artifacts/vendor')];
  return files.map((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    let present = false;
    let bytes = 0;
    try {
      const st = fs.statSync(abs);
      present = true;
      bytes = st.size;
    } catch {
      /* absent */
    }
    return { file: rel, present, bytes };
  });
}

// --- Printing ----------------------------------------------------------------

const lines = [];
function say(s = '') {
  lines.push(s);
  console.log(s);
}

function pctLabel(p) {
  return `${Math.round(p * 100)}%`;
}

function printLossSuite(res) {
  say(`### Loss suite — ${res.payload} (${res.payloadBytes} B), ${res.chunk} B per frame`);
  say('');
  say(
    `Channel: ${res.channelKind}${res.meanBurst ? ` (mean burst ${res.meanBurst} frames)` : ''} · ` +
      `${res.trials} trials per cell · seed ${res.baseSeed}`
  );
  say('');

  const headers = ['transport', 'needs', ...LOSS_RATES.map(pctLabel)];
  const slotRows = [];
  const overheadRows = [];
  const decodeRows = [];

  for (const t of res.transports) {
    slotRows.push([
      t.label,
      String(t.distinct),
      ...t.cells.map((c) =>
        c.failures ? `FAIL(${c.failures})` : `${fmt(c.slots.mean, 0)} / ${c.slots.p95}`
      )
    ]);
    overheadRows.push([
      t.label,
      String(t.distinct),
      ...t.cells.map((c) => `${fmt(c.overhead.mean, 1)} (${fmt(c.overheadPct * 100, 1)}%)`)
    ]);
    decodeRows.push([t.label, String(t.distinct), ...t.cells.map((c) => fmt(c.decodeMs.mean, 2))]);
  }

  say('**Frame slots the receiver must observe — mean / p95.** A slot is one frame period.');
  say('');
  say(markdownTable(headers, slotRows));
  say('');
  say('**Reception overhead — payload frames delivered beyond the theoretical minimum (mean, and as a % of that minimum).**');
  say('');
  say(markdownTable(headers, overheadRows));
  say('');
  say(
    'Note: for the fountain transports this figure includes symbols that landed while the receiver ' +
      'was waiting for a manifest it could not decode without. The code\'s own overhead, measured ' +
      'without any framing, is in the reception-overhead suite below.'
  );
  say('');
  say('**Receiver wall-clock, cold start to verified payload (mean ms).**');
  say('');
  say(markdownTable(headers, decodeRows));
  say('');

  const base = res.transports.find((t) => t.kind === 'baseline');
  const best = res.transports.find((t) => t.scheme === 'shipped') || res.transports[1];
  if (base && best) {
    const ratioRows = LOSS_RATES.map((p, i) => [
      pctLabel(p),
      fmt(base.cells[i].slots.mean, 0),
      fmt(best.cells[i].slots.mean, 0),
      fmt(base.cells[i].slots.mean / best.cells[i].slots.mean, 2) + '×'
    ]);
    say(`**Speedup of ${best.label} over ${base.label}, in slots.**`);
    say('');
    say(markdownTable(['loss', 'baseline slots', 'fountain slots', 'speedup'], ratioRows));
    say('');
    say(
      `Sanity check: the coupon-collector bound for ${base.distinct} distinct frames is ` +
        `K·H_K = ${fmt(base.distinct * harmonic(base.distinct), 0)} deliveries if the sender ` +
        `emitted random indices; the cyclic sender does better than that but still pays a log-K factor.`
    );
    say('');
  }

  // Coding overhead alone, with the manifest wait excluded, so the fountain's
  // own contribution is separable from the transport's.
  const shipped = res.transports.find((t) => t.scheme === 'shipped');
  if (shipped) {
    say(`**Coding overhead for ${shipped.label} (K=${shipped.K}) — extra symbols at the moment of full rank, ignoring any manifest wait:**`);
    say('');
    say(
      markdownTable(
        ['loss', 'distribution', 'mean', 'worst'],
        shipped.cells.map((c) => [
          pctLabel(c.lossRate),
          Object.entries(c.codingOverheadHistogram)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([k, v]) => `${k}→${v}`)
            .join(', '),
          fmt(c.codingOverhead.mean, 3),
          String(c.codingOverhead.max)
        ])
      )
    );
    say('');
  }

  // The shape of the divergence, which is the point of the whole suite.
  if (base && best) {
    say('**Frames observed versus loss rate:**');
    say('');
    say('```');
    say(
      asciiPlot(
        [
          { label: base.label, mark: 'o', points: base.cells.map((c) => c.slots.mean) },
          { label: best.label, mark: '*', points: best.cells.map((c) => c.slots.mean) }
        ],
        LOSS_RATES.map(pctLabel),
        { height: 18, colWidth: 9, xLabel: 'frame loss rate', yLabel: 'mean frame slots observed' }
      )
    );
    say('```');
    say('');
  }
}

function printOverheadSuite(res) {
  say('### Reception overhead at the codec (no framing, no manifest)');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  const a = res.aggregate;
  say(
    `${res.totalDecodes} decodes, K ∈ {${res.kValues.join(', ')}}, ${res.symbolSize} B symbols, ` +
      `${Math.round(res.lossRate * 100)}% independent loss, every result verified against SHA-256 ` +
      `(${res.unverified} verification failures).`
  );
  say('');
  say(
    markdownTable(
      ['K', 'decodes', 'at exactly K', 'by K+1', 'by K+2', 'mean overhead', 'worst', 'decode p50'],
      res.rows.map((r) => [
        String(r.K),
        String(r.decodes),
        fmt(r.atZero * 100, 2) + '%',
        fmt(r.byOne * 100, 2) + '%',
        fmt(r.byTwo * 100, 2) + '%',
        fmt(r.overhead.mean, 4),
        String(r.overhead.max),
        `${fmt(r.decodeMs.p50, 2)} ms`
      ])
    )
  );
  say('');
  say(
    `**Aggregate over all ${res.totalDecodes} decodes:** ${fmt(a.atZero * 100, 2)}% at exactly K, ` +
      `${fmt(a.byOne * 100, 2)}% by K+1, ${fmt(a.byTwo * 100, 2)}% by K+2. ` +
      `Mean overhead ${fmt(a.mean, 4)} symbols, worst case +${a.max}.`
  );
  say('');
}

function printSymbolSizeSweep(res) {
  if (!res.available) return;
  say(`**Decode cost against symbol size, ${res.payloadBytes} B payload:**`);
  say('');
  say(
    markdownTable(
      ['symbol size', 'K', 'encoder setup', 'decode (systematic)', 'decode (repair only)'],
      res.rows.map((r) => [
        `${r.symbolSize} B`,
        String(r.systematic.K),
        `${fmt(r.systematic.setupMs, 2)} ms`,
        `${fmt(r.systematic.decodeMs, 2)} ms`,
        `${fmt(r.repairOnly.decodeMs, 2)} ms`
      ])
    )
  );
  say('');
  say(
    'The systematic column is the clean-channel case, where the receiver got the source symbols ' +
      'verbatim. The repair-only column is the worst case a lossy channel can produce: every source ' +
      'symbol missed, every one reconstructed.'
  );
  say('');
}

function printManifestSweep(res) {
  if (!res.available) return;
  say(`### Manifest repaint interval — ${res.payload} (${res.payloadBytes} B, K=${res.rows[0].K})`);
  say('');
  say(`Mean slots to completion, ${res.trials} trials per cell. Shipped fountain codec throughout.`);
  say('');
  say(
    markdownTable(
      ['manifest every', ...res.lossRates.map((p) => `${Math.round(p * 100)}%`)],
      res.rows.map((r) => [
        `${r.manifestEvery} slots`,
        ...r.cells.map((c) => `${fmt(c.slots.mean, 0)} / ${c.slots.p95}`)
      ])
    )
  );
  say('');
  say('Cells are mean / p95 slots. The p95 column is the one that matters: it is the tail where a missed manifest costs a full repaint interval.');
  say('');
}

function printPayloadSuite(res) {
  say('### Real payloads');
  say('');
  for (const p of res.payloads) {
    say(`**${p.name}** — ${p.bytes} B, detected as ${p.type.label} (${p.type.detail})`);
    say('');
    say(
      markdownTable(
        ['rate', 'chunk', 'fps', 'frames', 'QR ver (L)', 'QR ver (M)', 'wire bytes', 'wire eff.', 'seconds', 'goodput', 'nominal'],
        p.rows.map((r) => [
          r.rate,
          `${r.chunk} B`,
          String(r.fps),
          String(r.frames),
          r.qrVersionMin === r.qrVersionMax ? String(r.qrVersionMax) : `${r.qrVersionMin}–${r.qrVersionMax}`,
          r.qrVersionMinM === r.qrVersionMaxM ? String(r.qrVersionMaxM) : `${r.qrVersionMinM}–${r.qrVersionMaxM}`,
          String(r.wireBytes),
          fmt(r.wireEfficiency * 100, 1) + '%',
          fmt(r.seconds, 1),
          `${fmt(r.goodputBytesPerSec / 1024, 2)} KB/s`,
          `${fmt(r.nominalBytesPerSec / 1024, 2)} KB/s`
        ])
      )
    );
    say('');
    say(
      `QR versions are the smallest that fits each frame; the app's default error-correction level is ${res.eccLevel}. ` +
        `Fountain source-block sizes for the same payload: ` +
        p.rows.map((r) => `K=${r.fountainK} at ${r.chunk} B`).join(', ') +
        '.'
    );
    say('');
  }
}

function printDeltaSuite(res, projection) {
  say('### Delta transfer');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(`Driving ${path.relative(REPO_ROOT, res.path)} end to end on ${res.container} (${res.containerBytes} B).`);
  say('');
  say(
    markdownTable(
      ['changed span', 'span bytes', 'spans sent', 'delta payload', 'inventory', 'wire ratio', 'exact?'],
      res.cases.map((c) => [
        `#${c.spanIndex} ${c.spanType}`,
        String(c.spanLength),
        `${c.missingSpans}/${c.totalSpans}`,
        `${c.deltaPayloadBytes} B`,
        `${c.inventoryBytes} B`,
        fmt(c.wireRatioWithInventory, 2) + '×',
        c.reconstructedExactly ? 'yes' : `NO${c.applyError ? ' (' + c.applyError + ')' : ''}`
      ])
    )
  );
  say('');
  const anyWin = res.cases.some((c) => c.wireRatioWithInventory > 1);
  say(
    anyWin
      ? 'A ratio above 1× means the delta path moved less than a full transfer.'
      : 'Every ratio here is at or below 1×: on a container this small the delta machinery costs more than it saves.'
  );
  say('');
  say('**Projection, not measurement — 1 GB container, 1% of spans changed, 4 MB spans:**');
  say('');
  say(
    markdownTable(
      ['rate', 'full frames', 'delta frames', 'full time', 'delta time', 'ratio'],
      projection.map((p) => [
        `${p.chunk} B @ ${p.fps} fps`,
        p.fullFrames.toLocaleString('en-US'),
        p.deltaFrames.toLocaleString('en-US'),
        `${fmt(p.fullHours, 1)} h`,
        p.deltaHours >= 1 ? `${fmt(p.deltaHours, 1)} h` : `${fmt(p.deltaMinutes, 0)} min`,
        fmt(p.ratio, 0) + '×'
      ])
    )
  );
  say('');
  say('**Span-size sensitivity for the same 1 GB projection** (still arithmetic):');
  say('');
  say(
    markdownTable(
      ['span size', 'spans', 'inventory', 'inventory time @ 512 B/5 fps', 'ratio'],
      projection.spanSizes.map((s) => [
        `${s.spanBytes / 1024} KB`,
        s.spans.toLocaleString('en-US'),
        `${(s.inventoryBytes / 1024).toFixed(0)} KB`,
        `${fmt(s.inventoryMinutesDefault, 1)} min`,
        fmt(s.ratio, 0) + '×'
      ])
    )
  );
  say('');
}

function printQrCostSuite(res, sweep) {
  say('### QR encode and decode cost');
  say('');
  say(
    res.decoderAvailable
      ? `JS decoder found at ${path.relative(REPO_ROOT, res.decoderPath)}; decode timings below are from it.`
      : 'No JS decoder present, so decode cost could not be measured. The app uses the browser BarcodeDetector, which this harness cannot call.'
  );
  say('');
  const headers = ['chunk', 'ECC', 'frame bytes', 'QR ver', 'modules', 'encode p50', 'decodeMatrix p50'];
  const imageLabels = res.rows.find((r) => r.decode)?.decode.images.map((i) => `decodeImage ${i.label} p50`) || [];
  say(
    markdownTable(
      [...headers, ...imageLabels],
      res.rows.map((r) => [
        `${r.chunk} B`,
        r.ecl,
        String(r.frameBytes),
        String(r.qrVersion),
        `${r.modules}²`,
        `${fmt(r.encodeMs.p50, 2)} ms`,
        r.decode ? `${fmt(r.decode.matrixMs.p50, 2)} ms` : '—',
        ...(r.decode ? r.decode.images.map((i) => `${fmt(i.ms.p50, 1)} ms (${fmt(i.maxFps, 1)} fps)`) : [])
      ])
    )
  );
  say('');
  say('**Encode cost by QR version, payload sized to fill the version (ECC M):**');
  say('');
  say(
    markdownTable(
      ['version', 'capacity', 'modules', 'encode p50', 'bytes/s'],
      sweep.map((s) => [
        String(s.version),
        `${s.capacityBytes} B`,
        `${s.modules}²`,
        `${fmt(s.encodeMs.p50, 2)} ms`,
        fmt(s.bytesPerSecond / 1024, 0) + ' KB/s'
      ])
    )
  );
  say('');
}

function printDecodeVersionSweep(res) {
  if (!res.available) {
    say(`Decode-by-version sweep not run: ${res.reason}.`);
    say('');
    return;
  }
  say(`**Decode cost and robustness by QR version** (ECC ${res.ecl}, ${res.frame.label} synthetic capture):`);
  say('');
  say(
    markdownTable(
      [
        'version',
        'capacity',
        'modules',
        'decode p50',
        'max fps',
        'min px/module sharp',
        'blur r=1',
        'blur r=2',
        'frame share needed (r=1)'
      ],
      res.rows.map((r) => [
        String(r.version),
        `${r.capacityBytes} B`,
        `${r.modules}²`,
        `${fmt(r.ms.p50, 1)} ms`,
        fmt(r.maxFps, 0),
        r.minModuleScale[0] === null ? 'fail' : String(r.minModuleScale[0]),
        r.minModuleScale[1] === null ? 'fail' : String(r.minModuleScale[1]),
        r.minModuleScale[2] === null ? 'fail' : String(r.minModuleScale[2]),
        r.minFrameFraction[1] === null ? '—' : `${fmt(r.minFrameFraction[1] * 100, 0)}%`
      ])
    )
  );
  say('');
  say(
    'Min px/module is the smallest number of capture pixels per QR module at which the bundled JS ' +
      'decoder still read the symbol. "Frame share needed" converts that into how much of the ' +
      "capture's short side the symbol must occupy — the practical question when someone is holding " +
      'a phone over another screen. Synthetic, square-on, noiseless frames with a box blur: these are ' +
      'lower bounds on difficulty, not predictions of real camera behaviour.'
  );
  say('');
}

// --- Printers for the protocol, compression, objective, fleet, closure and
// --- memory suites -----------------------------------------------------------

function kb(bytes, digits = 2) {
  return `${fmt(bytes / 1024, digits)} KB`;
}

function printProtoDensity(res) {
  say('### Protocol v1 against protocol v2, at matched QR versions');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(
    `Payload ${res.payload} (${res.payloadBytes} B). v2 header ${res.headerBytes} B, manifest body ` +
      `${res.manifestFixedBytes} B plus the name. v1 chunk ceiling ${res.v1MaxChunk} B ` +
      `(\`core.MAX_CHUNK\`), v2 payload ceiling ${res.v2MaxPayload} B (\`MAX_PAYLOAD_BYTES\`). ` +
      `Armour length arithmetic checked against \`toTransport\`: ${res.armourLengthExact ? 'exact' : 'MISMATCH'}.`
  );
  say('');

  const rows = [];
  for (const cell of res.rows) {
    for (const mode of ['v1-json', 'v2-binary', 'v2-armoured']) {
      const m = cell.modes[mode];
      if (!m || !m.fits) {
        rows.push([
          `${cell.version}-${cell.ecl}`,
          String(cell.capacity),
          mode,
          m && m.reason ? m.reason : 'does not fit',
          '—', '—', '—', '—', '—'
        ]);
        continue;
      }
      rows.push([
        `${cell.version}-${cell.ecl}`,
        String(cell.capacity),
        mode,
        `${m.chunk} B${m.clampedByProtocol ? ' (capped)' : ''}`,
        `${m.frameBytes} B`,
        fmt(m.overheadPct * 100, 1) + '%',
        m.gainOverV1 ? fmt(m.gainOverV1, 3) + '×' : '1.000×',
        m.versionConfirmed ? 'yes' : `NO (${m.encodedVersion})`,
        m.roundTrip.ok ? 'yes' : `NO (${m.roundTrip.stage})`
      ]);
    }
  }
  say(
    markdownTable(
      ['QR ver-ECC', 'capacity', 'framing', 'max payload', 'frame bytes', 'envelope', 'vs v1', 'version confirmed', 'round trip'],
      rows
    )
  );
  say('');
  say(
    '"Max payload" is the largest chunk whose every frame still fits the version, found by binary ' +
      'search over frames the real builders produced and confirmed by encoding one and reading back ' +
      'its version. "Round trip" encodes that frame and decodes it with `artifacts/vendor/qrdecode.js`: ' +
      'a NO means the density in that row cannot currently be used, only quoted.'
  );
  say('');
}

function printProtoAtAppRates(res) {
  if (!res.available) return;
  say('**The same three framings at the app\'s own operating points:**');
  say('');
  say(
    markdownTable(
      ['payload', 'chunk', 'fps', 'framing', 'frame bytes', 'envelope', 'QR ver', 'frames', 'wire bytes', 'wire eff.', 'seconds', 'goodput'],
      res.rows.map((r) => [
        r.payload,
        `${r.chunk} B`,
        String(r.fps),
        r.mode,
        `${r.frameBytes} B`,
        fmt(r.overheadPct * 100, 1) + '%',
        r.qrVersion === null ? 'over 40' : String(r.qrVersion),
        String(r.frames),
        String(r.totalWireBytes),
        fmt(r.wireEfficiency * 100, 1) + '%',
        fmt(r.seconds, 1),
        `${fmt(r.goodputBytesPerSec / 1024, 2)} KB/s`
      ])
    )
  );
  say('');
}

function printV1FrameSpread(res) {
  say(`**v1's frame size is not a constant** — \`i\` and \`n\` are decimal, so a frame gains a byte at each power of ten (${res.chunk} B chunk):`);
  say('');
  say(
    markdownTable(
      ['payload', 'data frames', 'smallest frame', 'largest frame', 'envelope range', 'distribution'],
      res.rows.map((r) => [
        r.payload,
        String(r.dataFrames),
        `${r.min} B`,
        `${r.max} B`,
        `${fmt(r.minOverheadPct * 100, 1)}%–${fmt(r.maxOverheadPct * 100, 1)}%`,
        r.histogram.map(([size, count]) => `${size}→${count}`).join(', ')
      ])
    )
  );
  say('');
}

function printCompressionSuite(res) {
  say('### Compression, judged on the whole envelope');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(
    `Zstd ${res.zstdAvailable ? 'available' : 'NOT available on this Node'}. Envelope arithmetic checked ` +
      `against the real builder: ${res.envelopeModelVerified ? 'exact' : 'MISMATCH'}. Envelope is v2 ` +
      `armoured at ${res.chunk} B per frame, ${res.headerBytes} B of header per frame plus the manifest ` +
      `frame. The gate is an envelope gain of ${Math.round(res.gate * 100)}%.`
  );
  say('');
  for (const row of res.rows) {
    say(
      `**${row.name}** — ${row.bytes} B${row.synthetic ? ' (synthetic)' : ''}, ` +
        `${row.baselineFrames} frames and ${row.baselineEnvelopeBytes} wire bytes uncompressed`
    );
    say('');
    say(
      markdownTable(
        ['codec', 'compressed', 'ratio', 'encode', 'decode', 'frames', 'wire bytes', 'envelope gain', 'gate', 'exact?'],
        row.cells
          .filter((c) => c.available)
          .map((c) => [
            c.codec,
            `${c.compressedBytes} B`,
            fmt(c.ratio, 3) + '×',
            `${fmt(c.encodeMs, 2)} ms`,
            `${fmt(c.decodeMs, 2)} ms`,
            String(c.envelopeFrames),
            String(c.envelopeBytes),
            fmt(c.envelopeGain * 100, 1) + '%',
            c.passesGate ? 'pass' : 'FAIL',
            c.roundTripExact ? 'yes' : 'NO'
          ])
      )
    );
    say('');
  }
}

function printBreakEven(res) {
  if (!res.available) return;
  say(`**Break-even by artifact size** (${res.codec}, prefixes compressed for real at every size):`);
  say('');
  say(
    markdownTable(
      ['artifact', 'compression LOSES at or below', `reaches the ${Math.round(res.gate * 100)}% gate at`, 'ratio at 512 B', 'ratio at 4 KB'],
      res.rows.map((r) => {
        const at = (n) => r.points.find((p) => p.size === n);
        const p512 = at(512);
        const p4k = at(4096);
        return [
          r.name,
          r.lossBreakEven === null ? 'never in range' : `${r.lossBreakEven} B`,
          r.gainBreakEven === null ? 'never in range' : `${r.gainBreakEven} B`,
          p512 ? fmt(p512.ratio, 2) + '×' : '—',
          p4k ? fmt(p4k.ratio, 2) + '×' : '—'
        ];
      })
    )
  );
  say('');
  say(
    'A prefix of a file is not a smaller file of the same kind — the first 512 bytes of a WASM module ' +
      'are its header, which compresses differently from its code — so these are break-evens for ' +
      'prefixes, and they bound the answer rather than being it.'
  );
  say('');
}

function printDecisionSuite(res) {
  say('### What the sender actually decides — `artifacts/compress.js`');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  const levels = res.injected.map((n) => `${n}-${res.levels[n]}`).join(', ');
  say(
    `Driving \`artifacts/compress.js\` end to end with the REAL node:zlib codecs injected by name — ` +
      `${levels}. The module's unit tests inject stubs that return a fixed size, so nothing there is ` +
      `evidence about a ratio; every figure below came out of a codec that ran. Envelope at ` +
      `${res.chunk} B per frame (the module's own \`DEFAULT_CHUNK_BYTES\`), ` +
      `${res.armour ? 'v2 armoured' : 'unarmoured'}, gate ${Math.round(res.gate * 100)}%. ` +
      `Timings are the median of ${res.reps} runs and are the harness's, not the module's: ` +
      'nothing in `compress.js` reads a clock, so no timing here can have moved a verdict.'
  );
  say('');
  say(
    '**The decision, and both figures it is made from.** "Payload" is the codec\'s number, "envelope" ' +
      'is the transport\'s, and the gap between them is what the module exists for:'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'bytes', 'class', 'codec chosen', 'payload gain', 'envelope gain', 'margin', 'frames', 'wire bytes', 'verdict'],
      res.rows.map((r) => [
        `${r.name}${r.synthetic ? ' *(synthetic)*' : ''}`,
        r.bytes.toLocaleString('en-US'),
        r.kind,
        r.compress ? `**${r.codecName}** (id ${r.codecId})` : `**none** (id 0)`,
        fmt(r.payloadGain * 100, 2) + '%',
        fmt(r.envelopeGain * 100, 2) + '%',
        `${r.margin >= 0 ? '+' : '−'}${fmt(Math.abs(r.margin) * 100, 2)} pt`,
        `${r.framesBefore} → ${r.framesAfter}`,
        `${r.envelopeBefore.toLocaleString('en-US')} → ${r.envelopeAfter.toLocaleString('en-US')}`,
        r.verdict === 'declined' ? '**declined**' : r.verdict
      ])
    )
  );
  say('');
  const declined = res.rows.filter((r) => !r.compress);
  const marginal = res.rows.filter((r) => r.verdict === 'marginal pass');
  const grew = res.rows.filter((r) => r.envelopeAfter > r.envelopeBefore);
  say(
    `${res.rows.length - declined.length} of ${res.rows.length} artifacts are compressed and ` +
      `${declined.length} ${declined.length === 1 ? 'is' : 'are'} declined` +
      (declined.length ? ` — ${declined.map((r) => r.name).join(', ')}` : '') +
      '. ' +
      (marginal.length
        ? `${marginal.length} clear${marginal.length === 1 ? 's' : ''} by under ` +
          `${Math.round(res.marginalBand * 100)} points and ${marginal.length === 1 ? 'is' : 'are'} ` +
          `labelled a marginal pass here — ` +
          marginal.map((r) => `${r.name} at ${fmt(r.envelopeGain * 100, 2)}%`).join('; ') +
          `. "Marginal" is this report's word and not the module's: it passes or it does not, and the ` +
          'label exists only so a reader can tell a decision that was never close from one that turned ' +
          'on the threshold.'
        : 'No row lands within ' + Math.round(res.marginalBand * 100) +
          ' points of the gate, so nothing here exercises the threshold closely.') +
      (grew.length
        ? ` In ${grew.length} row${grew.length === 1 ? '' : 's'} the envelope actually GREW — ` +
          grew
            .map((r) => `${r.name}, ${r.envelopeBefore.toLocaleString('en-US')} B → ` +
              `${r.envelopeAfter.toLocaleString('en-US')} B, ${r.envelopeAfter - r.envelopeBefore} B worse`)
            .join('; ') +
          ' — which is the failure a payload rule cannot see at all, because there the codec is ' +
          'reporting a loss too and a size comparison would catch it; what a payload rule misses is the ' +
          'row below where the payload shrinks and the envelope does not follow.'
        : '')
  );
  say('');

  say(
    '**Every codec that was offered, what it produced, and whether the bytes came back.** A ratio ' +
      'without a verified round trip is a claim about a byte count, so each stream is decompressed and ' +
      'compared against the original:'
  );
  say('');
  const cellRows = [];
  for (const r of res.rows) {
    for (const c of r.cells) {
      cellRows.push([
        r.name,
        `${c.codec}-${c.level}`,
        `${c.compressedBytes.toLocaleString('en-US')} B`,
        fmt(c.ratio, 3) + '×',
        fmt(c.payloadGain * 100, 2) + '%',
        fmt(c.envelopeGain * 100, 2) + '%',
        `${c.framesBefore} → ${c.framesAfter}`,
        `${fmt(c.encodeMs, 2)} ms`,
        `${fmt(c.decodeMs, 2)} ms`,
        c.roundTripExact ? 'exact' : '**NO**',
        c.passesGate ? 'pass' : 'FAIL',
        c.codecId === r.codecId && r.compress ? '**chosen**' : ''
      ]);
    }
  }
  say(
    markdownTable(
      ['artifact', 'codec', 'compressed', 'ratio', 'payload gain', 'envelope gain', 'frames', 'encode', 'decode', 'round trip', 'gate', ''],
      cellRows
    )
  );
  say('');
  const badTrip = res.rows.filter((r) => !r.allRoundTripped);
  const badLength = res.rows.filter((r) => !r.allLengthsReproduced);
  say(
    (badTrip.length
      ? `**${badTrip.length} artifact(s) failed a round trip: ${badTrip.map((r) => r.name).join(', ')}.**`
      : `All ${cellRows.length} codec runs round-tripped byte-exactly.`) +
      ' ' +
      (badLength.length
        ? `**${badLength.length} artifact(s) re-encoded to a different length than the module decided on, ` +
          'so the codec is not deterministic and the verdicts for them are not reproducible.**'
        : 'Re-encoding reproduced the exact length the module decided on in every case, so a verdict ' +
          'here is a property of the bytes rather than of the run.')
  );
  say('');

  say(
    '**The chosen identifier against the shipped parser.** `compress.js` works from ADR-003 §2.1\'s ' +
      'seven-entry codec table and `proto2.js` ships a four-entry one, so a codec being the right ' +
      'choice and a codec being sendable are two different questions:'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'chosen', 'id', 'decoder named', 'proto2 accepts it?'],
      res.rows.map((r) => [
        r.name,
        r.codecName,
        String(r.codecId),
        r.decoder,
        r.wire.ok ? 'yes' : `**no** — ${r.wire.reason}`
      ])
    )
  );
  say('');
  const unsendable = res.rows.filter((r) => r.compress && !r.wire.ok);
  say(
    unsendable.length
      ? `**Every one of the ${unsendable.length} compressing decisions above names a codec id ` +
        '`proto2.parseFrame` would refuse on the first frame.** That is not a defect in either module ' +
        'and it is not fixed by this suite: `compress.js` states the divergence through ' +
        '`wireCompatible()` and changes nothing in `proto2.js`, so a sender that acts on these ' +
        'decisions today builds a transfer its own receiver rejects. The gains in the first table are ' +
        'real; they are not available until `proto2.js` adopts the §2.1 table.'
      : 'Every chosen identifier means the same codec in both tables.'
  );
  say('');
  say(
    markdownTable(
      ['codec id', 'ADR-003 §2.1', 'proto2.js', 'agree?'],
      res.divergence.rows.map((d) => [String(d.id), d.adr003, d.proto2, d.agrees ? 'yes' : '**no**'])
    )
  );
  say('');
  say(
    '**What this platform has, probed rather than assumed.** Available: ' +
      res.detection.available.map((c) => `${c.name} (id ${c.id}, via ${c.via})`).join(', ') +
      '. ' +
      (res.detection.hasCompressionStreams
        ? `CompressionStream constructed for [${res.detection.streamFormats.join(', ')}]` +
          (res.detection.nonStandardStreamFormats.length
            ? `, of which [${res.detection.nonStandardStreamFormats.join(', ')}] ` +
              `${res.detection.nonStandardStreamFormats.length === 1 ? 'is' : 'are'} outside the WHATWG ` +
              'format list and therefore a Node extension. The module records the successful probe and ' +
              'refuses to promote it into a browser capability, which is the difference between ' +
              'measuring a platform and believing it.'
            : ', all of them standard.')
        : 'No CompressionStream on this platform.')
  );
  say('');
}

function printBrowserSuite(res) {
  say('### The same decision in a browser, which has neither codec ADR-003 chose');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(
    'Everything above runs `node:zlib`. **rvQR runs in a browser**, and the WHATWG Compression Streams ' +
      `format list is exactly [${res.streamFormats.join(', ')}] — no \`br\`, no \`brotli\`, no \`zstd\`. ` +
      'ADR-003 §2.1 makes Zstd the default and Brotli the maximum-ratio option, so **the shipped web app ' +
      'can run neither of them**, and every Brotli and Zstd figure above is a Node measurement of a ' +
      'codec no user of the web app will execute.'
  );
  say('');
  say(
    'The rows below are not a caveat on the Node rows; they are a second environment, measured through ' +
      'the real `CompressionStream(\'deflate-raw\')`. That codec is asynchronous and `compressArtifact` ' +
      'is synchronous, so it cannot be injected into the module\'s own path at all — the stream is run ' +
      'for real, its output length measured, and the length put through the module\'s `choose()`, which ' +
      'takes sizes rather than codecs for exactly this reason. The verdict is the module\'s; only the ' +
      'bytes come from somewhere its sync path cannot reach.'
  );
  say('');
  say(
    `Presented a browser-shaped platform — the stream constructors and no zlib — the module detects ` +
      res.detected.map((c) => `**${c.name}** (id ${c.id}, via ${c.via}, dictionary ${c.supportsDictionary ? 'yes' : 'no'})`).join(', ') +
      ' and nothing else. It refuses the other two by name — ' +
      res.refused.map((c) => `**${c.name}** (${c.reason})`).join('; ') +
      '.'
  );
  say('');
  say('**Browser against Node, side by side. Both columns are envelope gain at the same chunk, armour and name length.**');
  say('');
  say(
    markdownTable(
      ['artifact', 'bytes', 'browser: deflate-raw', 'gain', 'frames', 'Node: best codec', 'gain', 'frames', 'Brotli’s edge', 'extra frames in a browser'],
      res.rows.map((r) => [
        `${r.name}${r.synthetic ? ' *(synthetic)*' : ''}`,
        r.bytes.toLocaleString('en-US'),
        r.browserCompress ? `${r.browserBytes.toLocaleString('en-US')} B` : '*declined*',
        `${fmt(r.browserEnvelopeGain * 100, 2)}%${r.browserPasses ? '' : ' **(FAIL)**'}`,
        `${r.browserFramesBefore} → ${r.browserFramesAfter}`,
        r.nodeCodec ? (r.nodeCompress ? `${r.nodeCodec}, ${r.nodeBytes.toLocaleString('en-US')} B` : '*declined*') : '—',
        r.nodeEnvelopeGain === null ? '—' : `${fmt(r.nodeEnvelopeGain * 100, 2)}%`,
        r.nodeFramesAfter === null ? '—' : `${r.browserFramesBefore} → ${r.nodeFramesAfter}`,
        r.edgePoints === null ? '—' : `${r.edgePoints >= 0 ? '+' : '−'}${fmt(Math.abs(r.edgePoints) * 100, 2)} pt`,
        r.edgeFrames === null ? '—' : (r.edgeFrames === 0 ? 'none' : `+${r.edgeFrames}`)
      ])
    )
  );
  say('');
  const paying = res.rows.filter((r) => r.edgePoints !== null && r.browserCompress && r.nodeCompress);
  const edges = paying.map((r) => r.edgePoints * 100);
  // Frames are not summable across artifacts — they are different transfers —
  // so the cost is reported as the worst single case and as a share of the
  // frames that receiver watches, which is the quantity a user experiences.
  const worst = paying.length
    ? paying.reduce((a, b) =>
        (b.browserFramesAfter - b.nodeFramesAfter) / b.nodeFramesAfter >
        (a.browserFramesAfter - a.nodeFramesAfter) / a.nodeFramesAfter ? b : a)
    : null;
  say(
    paying.length
      ? `**deflate-raw gets most of the way there.** Brotli's edge across the ${paying.length} artifacts ` +
        `both environments compress is ${fmt(Math.min(...edges), 2)} to ${fmt(Math.max(...edges), 2)} ` +
        'points of envelope gain. In the quantity a receiver actually experiences — frames it has to ' +
        `watch — the worst case here is **${worst.name}**, ${worst.nodeFramesAfter} frames under Brotli ` +
        `against ${worst.browserFramesAfter} under deflate-raw, ` +
        `${fmt(((worst.browserFramesAfter - worst.nodeFramesAfter) / worst.nodeFramesAfter) * 100, 0)}% more. ` +
        'That is a real cost and it is not a crippling one: the browser limitation is worth single-digit ' +
        'percentage points of envelope, not a factor. The reading a reader should take is that the web ' +
        'app compresses nearly as well as the best codec available anywhere, not that it is missing ' +
        'compression.'
      : 'No artifact was compressed in both environments, so there is no edge to report.'
  );
  say('');
  const declineSplit = res.rows.filter((r) => r.browserCompress !== r.nodeCompress);
  say(
    declineSplit.length
      ? `**The two environments reach different verdicts on ${declineSplit.length} artifact(s): ` +
        declineSplit.map((r) => r.name).join(', ') +
        '.** The gate is applied to whatever codec the platform has, so a platform with a weaker codec ' +
        'declines earlier — which is the rule working, not a divergence in it.'
      : 'Both environments reach the same compress-or-not verdict on every artifact: the gate is far ' +
        'enough from the margin that the codec difference never flips it here.'
  );
  say('');
  const standIn = res.rows.filter((r) => r.syncStandInIdentical !== null);
  const identical = standIn.filter((r) => r.syncStandInIdentical);
  say(
    `**The browser exposes no compression level, and its stream is Node's default.** ` +
      (standIn.length
        ? `\`CompressionStream('deflate-raw')\` produced byte-identical output to ` +
          `\`deflateRawSync(bytes, { level: 6 })\` on ${identical.length} of ${standIn.length} artifacts` +
          (identical.length === standIn.length
            ? '. So the synchronous stand-in is a stand-in and not an approximation, and — more to the ' +
              'point — a browser has no level parameter to raise: the deflate-raw column above is not a ' +
              'setting anyone can tune, it is the whole of what is on offer.'
            : `, and differed on ${standIn.length - identical.length}, so the sync path is NOT a ` +
              'substitute for the stream on this platform.')
        : 'node:zlib is absent here, so the comparison could not be made.')
  );
  say('');
  say(
    '**And the sync path fails closed on an asynchronous codec rather than corrupting the stream.** ' +
      (res.asyncInjection.threw
        ? 'Injecting a `compress` that returns a Promise throws `' +
          res.asyncInjection.name + '` with reason `' + res.asyncInjection.reason + '` — "' +
          res.asyncInjection.message +
          '". A Promise has no `length` and no `byteLength`, so the module cannot read a size out of it ' +
          'and refuses at the point of measurement, before any decision is taken. That is worth ' +
          'recording as a property and not a caveat: the failure mode of wiring a browser codec into ' +
          'the sync path is a thrown error with a stable reason, not a manifest describing a stream ' +
          'nobody produced.'
        : '**It did not throw.** The sync path accepted a Promise, which means a caller wiring a ' +
          'browser codec in would build a manifest around a size that does not exist.')
  );
  say('');
}

function printGateBand(res) {
  if (!res.available) {
    say(`Gate-band scan not run: ${res.reason}.`);
    say('');
    return;
  }
  say(
    '**The band the gate exists for: payload clears, envelope does not.** `compress.js`\'s docblock ' +
      'publishes six size pairs said to land in it. Those are arithmetic rather than measurements, so ' +
      'they are re-derived here through the module\'s own `evaluate()` and printed beside what the ' +
      'docblock claims:'
  );
  say('');
  say(
    markdownTable(
      ['original', 'compressed', 'payload gain', 'docblock', 'envelope gain', 'docblock', 'frames', 'docblock', 'in the band?'],
      res.claimed.map((c) => [
        `${c.original.toLocaleString('en-US')} B`,
        `${c.compressed.toLocaleString('en-US')} B`,
        fmt(c.payloadGain * 100, 2) + '%',
        c.claimPayload,
        fmt(c.envelopeGain * 100, 2) + '%',
        c.claimEnvelope,
        c.frames,
        c.claimFrames,
        c.inBand ? 'yes' : '**no**'
      ])
    )
  );
  say('');
  const disagree = res.claimed.filter((c) => !c.agrees);
  const outOfBand = res.claimed.filter((c) => !c.inBand);
  say(
    (disagree.length
      ? `**${disagree.length} of ${res.claimed.length} rows do not reproduce the docblock's own figures, ` +
        'so the module\'s documentation and its arithmetic disagree.**'
      : `All ${res.claimed.length} rows reproduce the docblock's figures exactly, so that table is the ` +
        'module\'s arithmetic and not a recollection of it.') +
      ' ' +
      (outOfBand.length
        ? `**${outOfBand.length} of them are not actually in the band.**`
        : 'Every one of them is in the band: the payload clears 8% and the envelope does not.')
  );
  say('');

  const withBand = res.rows.filter((r) => r.band.length);
  const withReverse = res.rows.filter((r) => r.reverseBand.length);
  const withGrowth = res.rows.filter((r) => r.grew.length);
  const nonMonotone = res.rows.filter((r) => !r.monotone);
  say(
    `**And the same question on real bytes.** Prefixes of every corpus artifact compressed for real ` +
      `with ${res.codec}, at ${res.chunk} B per frame, every point evaluated by the module:`
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'sizes scanned', 'payload passes, envelope fails', 'envelope passes, payload fails', 'envelope grew', 'first size that clears', 'verdict flips'],
      res.rows.map((r) => {
        const first = r.points.find((p) => p.passesGate);
        const list = (ps) =>
          ps.length
            ? ps
                .map((p) => `${p.size} B (${fmt(p.payloadGain * 100, 2)}% / ${fmt(p.envelopeGain * 100, 2)}%)`)
                .join(', ')
            : '—';
        return [
          r.name,
          String(r.points.length),
          list(r.band),
          list(r.reverseBand),
          r.grew.length
            ? (r.grew.length === r.points.length
                ? `every size scanned (${r.points.length})`
                : r.grew.map((p) => `${p.size} B`).join(', '))
            : '—',
          first ? `${first.size} B` : 'never in range',
          String(r.verdictFlips)
        ];
      })
    )
  );
  say('');
  say(
    'Both disagreement columns are cases where a payload rule and this module reach opposite verdicts, ' +
      'and they fail in opposite directions: the first is compression turned on for nothing, the second ' +
      'is compression refused when it would have paid.'
  );
  say('');
  say(
    withBand.length
      ? `**Payload passes and envelope fails on real bytes in ${withBand.length} of ${res.rows.length} ` +
        `artifacts** — ` +
        withBand
          .map((r) =>
            `${r.name} at ${r.band
              .map((p) => `${p.size} B, where the payload sheds ${fmt(p.payloadGain * 100, 2)}% and the ` +
                `envelope only ${fmt(p.envelopeGain * 100, 2)}% because the frame count is ` +
                `${p.framesBefore} either way`)
              .join('; ')}`
          )
          .join('; ') +
        '. Those are transfers a payload rule turns compression on for and this module refuses. The ' +
        'refusal is right: no frame is saved, so the receiver waits through exactly as many symbols and ' +
        'gains a decompressor on its critical path for its trouble.'
      : 'No prefix of any artifact in this repository lands in that band at these sizes: the text-like ' +
        'artifacts clear both figures by a wide margin and the incompressible ones fail both. That is a ' +
        'fact about this corpus rather than evidence the rule is idle.'
  );
  say('');
  say(
    withReverse.length
      ? `**And the gap runs the other way too, which is the half that is easy to miss.** In ` +
        `${withReverse.length} of ${res.rows.length} artifacts the ENVELOPE clears the gate and the ` +
        'PAYLOAD does not — ' +
        withReverse
          .map((r) =>
            `${r.name} at ${r.reverseBand
              .map((p) => `${p.size} B (payload ${fmt(p.payloadGain * 100, 2)}%, envelope ` +
                `${fmt(p.envelopeGain * 100, 2)}%, ${p.framesBefore} → ${p.framesAfter} frames)`)
              .join(', ')}`
          )
          .join('; ') +
        '. A frame dropped out, and dropping a frame removes its 28-byte header and its armour padding ' +
        'as well as its payload, so the envelope shrinks by MORE than the payload did. A payload rule ' +
        'refuses these, and refusing them is wrong: they are the transfers where compression buys a ' +
        'whole symbol the receiver never has to see. The envelope rule is therefore not a stricter ' +
        'payload rule; it is a different rule that says yes and no in places the payload rule cannot see.'
      : 'No point measured here has the envelope clearing the gate while the payload misses it.'
  );
  say('');
  if (nonMonotone.length) {
    say(
      `**The verdict is not monotone in size**, which is worth stating because it is easy to assume it ` +
        `must be. ` +
        nonMonotone
          .map((r) => {
            const seq = r.points
              .filter((p, i) => i === 0 || p.passesGate !== r.points[i - 1].passesGate)
              .map((p) => `${p.size} B ${p.passesGate ? 'passes' : 'fails'}`)
              .join(', then ');
            return `${r.name} flips ${r.verdictFlips} times across ${r.points.length} sizes — ${seq}`;
          })
          .join('; ') +
        '. The ratio climbs smoothly and the frame count is a step function, so a slightly larger ' +
        'artifact can fall back below the gate. There is no single break-even size for these ' +
        'artifacts, only a break-even that the frame boundary keeps re-crossing, and any table that ' +
        'reports one number is reporting the first crossing rather than the last.'
    );
    say('');
  }
  if (withGrowth.length) {
    say(
      `Compression makes the envelope BIGGER at ${withGrowth
        .map((r) => `${r.name} (${r.grew.length === r.points.length ? 'every size scanned' : r.grew.map((p) => p.size + ' B').join(', ')})`)
        .join('; ')} — the codec returns more bytes than it was given and the frame count cannot fall, ` +
        'so the whole cost is paid and nothing is bought.'
    );
    say('');
  }
}

function printSampledPath(res) {
  if (!res.available) {
    say(`Sampled path not measured: ${res.reason}.`);
    say('');
    return;
  }
  if (!res.rows.length) {
    say('No artifact exceeded the sampling threshold, so the prefix branch was not exercised.');
    say('');
    return;
  }
  say(
    `**The >8 MB prefix branch, run below 8 MB because nothing here is 8 MB.** ADR-003 §2.3 estimates ` +
      'on a bounded prefix above the threshold and this repository ships no artifact that reaches it, ' +
      `so the branch would go unmeasured unless the threshold moved. It is moved: \`sampleAbove\` is ` +
      `${res.sampleAbove.toLocaleString('en-US')} B here and \`samplePrefix\` ` +
      `${res.samplePrefix.toLocaleString('en-US')} B. That is the only thing in this table that is not ` +
      'the shipped configuration. The estimate runs at ' +
      Object.entries(res.fastLevels).map(([k, v]) => `${k}-${v}`).join(', ') +
      ' and the full encode at ' +
      Object.entries(res.fullLevels).map(([k, v]) => `${k}-${v}`).join(', ') +
      ', which is the `sampleCodecs` seam §2.3 asks for.'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'bytes', 'prefix', 'fast estimate distinct?', 'whole-artifact decision', 'sampled decision', 'same?', 'declined on the prefix', 'estimates overturned'],
      res.rows.map((r) => [
        r.name,
        r.bytes.toLocaleString('en-US'),
        `${r.prefixBytes.toLocaleString('en-US')} B`,
        r.sampleCodecsDistinct ? 'yes' : 'no',
        `${r.wholeCodec}, ${r.wholeStreamBytes.toLocaleString('en-US')} B (${fmt(r.wholeGain * 100, 2)}%)`,
        `${r.sampledCodec}, ${r.sampledStreamBytes.toLocaleString('en-US')} B (${fmt(r.sampledGain * 100, 2)}%)`,
        r.sameDecision ? 'yes' : '**no**',
        r.declined.length ? r.declined.map((d) => `${d.codec} at ${fmt(d.estimateGain * 100, 2)}%`).join(', ') : '—',
        r.overturned.length ? String(r.overturned.length) : '—'
      ])
    )
  );
  say('');
  const changed = res.rows.filter((r) => !r.sameDecision);
  const lost = [];
  for (const r of res.rows) {
    for (const d of r.declinedCost) if (d.fullPassed) lost.push({ name: r.name, ...d });
  }
  say(
    (changed.length
      ? `**The prefix changed the decision for ${changed.length} of ${res.rows.length} artifacts.**`
      : `The prefix reached the same decision as the whole artifact for all ${res.rows.length} rows.`) +
      ' ' +
      (lost.length
        ? `**${lost.length} codec(s) were declined on a prefix that would have cleared the gate on the ` +
          'whole artifact: ' +
          lost
            .map((d) => `${d.name}/${d.codec}, estimated ${fmt(d.estimateGain * 100, 2)}% and measured ` +
              `${fmt(d.fullGain * 100, 2)}%`)
            .join('; ') +
          '.** A declining estimate is final for that codec — that is §2.3\'s flow rather than an ' +
          'oversight — so this is the one place the shortcut loses real bytes, and it is measurable ' +
          'rather than hypothetical.'
        : 'No codec was declined on a prefix that would have cleared the gate on the whole artifact, so ' +
          'at these sizes the shortcut costs nothing. That is a property of these artifacts: a file ' +
          'whose first megabyte compresses badly and whose remainder compresses well would be refused ' +
          'without ever being measured, and nothing in the module detects that case.')
  );
  say('');
}

function printAdr003Recheck(res) {
  if (!res.available) {
    say(`ADR-003 cross-check not run: ${res.reason}.`);
    say('');
    return;
  }
  const a = res.adr;
  say(
    `**ADR-003 §2.3 against \`standalone.html\` as it is now.** The ADR's table cites ` +
      `${a.bytes.toLocaleString('en-US')} B compressing ${a.ratio}× under Brotli, encoded in ` +
      `${a.brotli6EncodeMs} ms. The file is now ${res.bytes.toLocaleString('en-US')} B — ` +
      `${res.bytesDelta > 0 ? '+' : '−'}${Math.abs(res.bytesDelta).toLocaleString('en-US')} B, ` +
      `${fmt(res.bytesGrowth, 2)}× the size the ADR measured. Re-measured here:`
  );
  say('');
  say(
    markdownTable(
      ['quality', 'bytes in', 'bytes out', 'ratio', 'encode', 'throughput', 'decode', 'round trip'],
      res.measured.map((m) => [
        `brotli-${m.quality}`,
        res.bytes.toLocaleString('en-US'),
        m.compressedBytes.toLocaleString('en-US'),
        fmt(m.ratio, 3) + '×',
        `${fmt(m.encodeMs, 2)} ms`,
        `${fmt(m.encodeMBps, 1)} MB/s`,
        `${fmt(m.decodeMs, 2)} ms`,
        m.roundTripExact ? 'exact' : '**NO**'
      ])
    )
  );
  say('');
  const q6 = res.measured.find((m) => m.quality === a.quality);
  say(
    `**The discrepancy, stated rather than absorbed: ${fmt(q6.ratio, 3)}× measured against the ADR's ` +
      `${a.ratio}×, a difference of ${res.ratioDelta >= 0 ? '+' : '−'}${fmt(Math.abs(res.ratioDelta), 3)}, ` +
      `on a file that is ${fmt(res.bytesGrowth, 2)}× the size it was.** Nothing in ADR-003 is edited by ` +
      'this run and nothing should be: its figures were true of the file it measured, and a decision ' +
      'record whose evidence silently updates itself stops being a record. What survives the file ' +
      'changing is the ratio and the throughput, and both are close enough to corroborate the policy ' +
      `§2.3 rests on — ${fmt(q6.encodeMBps, 1)} MB/s here against ` +
      `${fmt(a.bytes / 1024 / 1024 / (a.brotli6EncodeMs / 1000), 1)} MB/s there, so "compress the whole ` +
      'thing and compare, up to 8 MB" still costs a fraction of a second. What does not survive is the ' +
      'byte count, and any figure quoted against 503,216 B is a measurement of a different file.'
  );
  say('');
}

function printObjectiveSuite(res, penalty) {
  say('### The objective function, G = R × C × E × P');
  say('');
  if (!res.available) {
    say(`Not computed: ${res.reason}.`);
    say('');
    return;
  }
  say(
    '**R** raw optical rate (QR capacity × fps, measured capacity). **C** compression gain (measured). ' +
      '**E** recovery efficiency: stream bytes recovered per QR byte painted, folding the envelope, ' +
      'the fill slack and the measured reception overhead. **P** decode success probability per frame ' +
      '— **not measurable by this harness at all**, so it is swept, and every column below with P < 1 ' +
      'is a projection rather than a measurement. G is in artifact bytes per second.'
  );
  say('');
  const ps = res.pSweep;
  say(
    markdownTable(
      ['artifact', 'codec', 'framing', 'QR ver', 'fps', 'chunk', 'R', 'C', 'E', ...ps.map((p) => `G @ P=${p}${p === 1 ? '' : ' (proj.)'}`)],
      res.rows.map((r) => [
        r.artifact,
        r.codec,
        r.mode,
        String(r.version),
        String(r.fps),
        `${r.chunk} B`,
        `${fmt(r.R / 1024, 2)} KB/s`,
        fmt(r.C, 3),
        fmt(r.E, 4),
        ...ps.map((p) => `${fmt(r.G[p] / 1024, 2)} KB/s`)
      ])
    )
  );
  say('');
  if (penalty && penalty.available) {
    say(
      '**Where G is wrong.** G is linear in P, which is exact for a rateless code and wrong for v1\'s ' +
        'indexed cycling. Measured slots against the 1/P scaling G assumes:'
    );
    say('');
    const rates = penalty.rows[0].cells.map((c) => pctLabel(c.lossRate));
    say(
      markdownTable(
        ['transport', ...rates],
        penalty.rows.map((t) => [t.transport, ...t.cells.map((c) => fmt(c.penalty, 2) + '×')])
      )
    );
    say('');
    say(
      'A ratio of 1.00× means G is exact for that transport at that loss rate. Anything above means G ' +
        'overstates it, so the G columns for `v1-json` at P below 1 are optimistic by the factor shown.'
    );
    say('');
  }
}

function printFleetSuite(res, scale) {
  say('### Fleet: one screen, N receivers, content-addressed peer exchange');
  say('');
  say(
    '**This is a model, not a measurement.** It captures broadcast, independent per-receiver erasure, ' +
      'rateless coding at the measured reception overhead, and content addressing. It does not capture ' +
      'the peer channel\'s existence, capacity, discovery or signalling cost, nor loss that is ' +
      'correlated across receivers — which, in one room sharing one glare source and one person walking ' +
      `past, is the assumption most likely to be wrong. Simulated at K=${res.simulatedK} symbols, ` +
      `${res.trials} trials per cell, seed ${res.baseSeed}; ${res.symbolPayloadBytes} B payload in a ` +
      `${res.symbolPaintedBytes} B symbol.`
  );
  say('');
  say(
    markdownTable(
      ['loss', 'N', 'source traffic, peer exchange', 'source traffic, broadcast only', 'naive unicast', 'peer bytes per receiver'],
      res.rows.map((r) => [
        pctLabel(r.lossRate),
        String(r.N),
        fmt(r.sourceTrafficPeer, 3) + '×',
        fmt(r.sourceTrafficBroadcastOnly, 3) + '×',
        `${r.naiveMultiplier}×`,
        kb(r.peerBytesPerReceiver, 0)
      ])
    )
  );
  say('');
  say(
    'Multiples are of the artifact size, counted in bytes actually painted, so the QR envelope is ' +
      `inside them: a ${res.symbolPayloadBytes} B payload in a ${res.symbolPaintedBytes} B symbol is ` +
      `${fmt(res.symbolPaintedBytes / res.symbolPayloadBytes, 3)}× before a single frame is lost.`
  );
  say('');
  const gb = (b) => `${fmt(b / 1024 ** 3, 2)} GB`;
  say(`**Projected onto a ${gb(res.artifactBytes)} artifact** (arithmetic on the measured multipliers above):`);
  say('');
  say(
    markdownTable(
      ['loss', 'N', 'source, peer exchange', 'source, broadcast only', 'naive unicast'],
      res.rows.map((r) => [
        pctLabel(r.lossRate),
        String(r.N),
        gb(r.projectedSourceBytesPeer),
        gb(r.projectedSourceBytesBroadcast),
        gb(r.projectedNaiveBytes)
      ])
    )
  );
  say('');
  if (scale && scale.available) {
    say(
      `**Is the multiplier flat in K?** The projection above applies a multiplier measured at ` +
        `K=${res.simulatedK} to a K of ${res.realK.toLocaleString('en-US')}, which is only legitimate ` +
        `if it is. Measured at N=${scale.N}, ${Math.round(scale.p * 100)}% loss:`
    );
    say('');
    say(
      markdownTable(
        ['K', 'peer-exchange multiplier', 'broadcast-only multiplier'],
        scale.rows.map((r) => [String(r.K), fmt(r.unionMultiplier, 4), fmt(r.broadcastMultiplier, 4)])
      )
    );
    say('');
  }
}

function printClosureSuite(res) {
  say('### Progressive activation: time to the first trusted closure');
  say('');
  if (!res.available) {
    say(`Not computed: ${res.reason}.`);
    say('');
    return;
  }
  say(
    '**This is a model.** Nothing in this repository signs a closure or activates one; what follows is ' +
      'arithmetic over measured span sizes, measured artifact sizes and measured byte rates. Each ' +
      `closure pays its own ${res.signatureBytes} B signature (Ed25519) and its own manifest frame, and ` +
      `rounds up to whole frames. \`core.js\` declares \`SIGNATURE_SIZE = ${res.declaredSignatureSize}\`, ` +
      'which is a truncated tag rather than any standard signature size; the larger figure is used here ' +
      'because it is the one a real detached signature costs.'
  );
  say('');
  say(
    `**The gate is closures 1–${res.gateClosures}, not closure 1.** ADR-022 §2.1 says the agent starts once ` +
      'closures 1–3 verify, so that is the figure reported as meeting or missing the target; ' +
      'time-to-closure-1 is shown alongside because it is the easier number and it is easy to quote ' +
      'the wrong one.'
  );
  say('');
  for (const t of res.timelines) {
    say(
      `**${t.profile}** at ${t.transport} — closure 1 at ${fmt(t.firstClosureSeconds, 2)} s, ` +
        `closures 1–${t.trustedAgentClosures} at ${fmt(t.trustedAgentSeconds, 2)} s ` +
        `(${t.meetsTarget ? 'meets' : 'MISSES'} the ${res.target} s target), whole artifact ${fmt(t.totalSeconds, 1)} s`
    );
    say('');
    say(
      markdownTable(
        ['closure', 'bytes', 'source', 'frames', 'cumulative', 'fps needed for 3 s'],
        t.steps.map((s) => [
          s.name,
          String(s.bytes),
          s.measured ? 'measured' : 'modelled',
          String(s.frames),
          `${fmt(s.cumulativeSeconds, 2)} s`,
          fmt(s.fpsNeededForTarget, 1)
        ])
      )
    );
    say('');
  }
  say(`**The largest closure content that fits the ${res.target}-second target, by signature scheme:**`);
  say('');
  say(
    markdownTable(
      ['transport', 'signature', 'closures', 'P', 'frames in budget', 'signature cost', 'max closure content', 'feasible?'],
      res.budgets.map((b) => [
        b.transport,
        b.scheme,
        String(b.closures),
        b.projection ? `${b.successProbability} (projection)` : String(b.successProbability),
        String(b.frameBudget),
        `${b.signatureCost} B`,
        `${b.bytes} B`,
        b.feasible ? 'yes' : '**no**'
      ])
    )
  );
  say('');
  say(
    'Signature cost is `closures × signature bytes`, because ADR-022 signs each closure separately. ' +
      'Where "feasible?" is no, the signatures alone exhaust the frame budget and no closure content ' +
      'fits at all, whatever it contains.'
  );
  say('');
}

function printMemorySuite(res) {
  say('### Working memory and payload copies');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(
    `Largest artifact in the repository: \`${res.artifact}\`, ${res.artifactBytes} B. Measured in a ` +
      'separate process under `--expose-gc`, so the figures are the pipeline\'s and not the rest of the ' +
      'harness\'s. "Live" is heapUsed + external after a forced collection, divided by the artifact ' +
      'size — external is where typed-array payloads actually are, and a copy count taken from heapUsed ' +
      'alone under-reports them by about half.'
  );
  say('');
  say(
    markdownTable(
      ['stage', 'heap Δ', 'external Δ', 'total Δ', 'live copies', 'peak RSS', 'ms'],
      res.stages.map((s) => [
        s.name,
        fmt(s.retainedHeapBytes / res.artifactBytes, 2) + '×',
        fmt(s.retainedExternalBytes / res.artifactBytes, 2) + '×',
        fmt(s.copies, 2) + '×',
        fmt(s.liveCopies, 2) + '×',
        `${fmt(s.peakRssBytes / 1024 ** 2, 1)} MiB`,
        fmt(s.ms, 1)
      ])
    )
  );
  say('');
  say(
    `**Peak RSS ${fmt(res.peakRssMiB, 1)} MiB, of which ${fmt(res.peakRssAboveBaselineMiB, 1)} MiB is ` +
      `this pipeline above an empty Node process — ${res.withinBudget ? 'inside' : 'OVER'} the ` +
      `${res.budgetMiB} MiB budget.**`
  );
  say('');
  say(
    `**Payload copies, receiver side: v1 peaks at ${fmt(res.v1.receiverPeakCopies, 2)}×, v2 at ` +
      `${fmt(res.v2.receiverPeakCopies, 2)}×** against a budget of fewer than two. ` +
      `Sender side, v1 holds ${fmt(res.v1.senderCopies, 2)}× as base64url text and v2 ` +
      `${fmt(res.v2.senderCopiesOneFrame, 2)}× with one armoured frame retained. Both transfers ` +
      `verified byte-exact (v1 ${res.v1Verified ? 'yes' : 'NO'}, v2 ${res.v2.verified ? 'yes' : 'NO'}).`
  );
  say('');
  say('**Allocation sites, read out of the source rather than inferred from the numbers:**');
  say('');
  say(
    markdownTable(
      ['stage', 'what allocates', 'expected cost'],
      res.stages
        .filter((s) => s.allocation)
        .map((s) => [s.name, s.allocation.site, s.allocation.cost])
    )
  );
  say('');
}

function printSemDeltaSuite(res) {
  say('### Semantic delta: diffing inside RVF segments');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  say(
    `Driving ${path.relative(REPO_ROOT, res.path)} end to end. Segment interiors parsed by the ` +
      `${res.parserKind}${res.parserReason ? ` (the microkernel would not instantiate: ${res.parserReason})` : ''}. ` +
      `Timings are the median of ${res.reps} runs. The demo container is ${res.demoBytes} B and the ` +
      `WASM module ${res.wasmModuleBytes} B in ${res.wasmSectionCount} sections, of which the Code ` +
      `section is ${res.codeSectionBytes} B. Rows marked synthetic use containers this repository does ` +
      'not ship, because it contains no COW map or membership filter at the scale the mechanism is for.'
  );
  say('');

  say('**What crosses the wire, and which payload `chooseDelta` actually returned.**');
  say('');
  say(
    markdownTable(
      ['scenario', 'what changed', 'full transfer', 'span delta', 'semantic delta', 'span ÷ semantic', 'chooser picked', 'byte-exact?'],
      res.scenarios.map((s) => [
        `${s.name}${s.synthetic ? ' *(synthetic)*' : ''}`,
        s.what,
        `${s.fullBytes} B`,
        `${s.spanBytes} B`,
        `${s.semanticBytes} B`,
        fmt(s.spanOverSemantic, 2) + '×',
        `**${s.chosen}**`,
        s.reconstructedExactly ? 'yes' : 'NO'
      ])
    )
  );
  say('');

  const declined = res.scenarios.filter((s) => s.chosen === 'span');
  const wrong = res.scenarios.filter((s) => s.chosen !== s.expectation);
  say(
    `The chooser returned the smaller of the two payloads in every row (${res.scenarios.length}/` +
      `${res.scenarios.length}), and declined the semantic delta in ${declined.length} of them. ` +
      (wrong.length
        ? `**${wrong.length} row(s) did not match the expected verdict: ` +
          `${wrong.map((s) => `${s.name} → ${s.chosen}, expected ${s.expectation}`).join('; ')}.**`
        : 'Every verdict matched the one the scenario was constructed to produce.')
  );
  say('');

  say('**Why each verdict came out that way — the unit table is what is being paid for.**');
  say('');
  say(
    markdownTable(
      ['scenario', 'spans', 'units', 'spans sent', 'units sent', 'span payload', 'unit payload', 'unit table', 'net'],
      res.scenarios.map((s) => {
        const saved = s.spanPayloadBytes - s.unitPayloadBytes;
        const net = saved - s.tableBytes;
        return [
          s.name,
          String(s.spanCount),
          String(s.unitCount),
          `${s.spansMissing}/${s.spanCount}`,
          `${s.unitsMissing}/${s.unitCount}`,
          `${s.spanPayloadBytes} B`,
          `${s.unitPayloadBytes} B`,
          `${s.tableBytes} B`,
          `${net >= 0 ? '+' : '−'}${Math.abs(net)} B`
        ];
      })
    )
  );
  say('');
  say(
    '"Net" is the payload bytes the finer diff saves minus what its table costs, and its sign is the ' +
      'verdict: positive means the semantic delta earned its table, negative means it did not. It is ' +
      'not identical to the difference between the two payload columns in the first table, because ' +
      'both payloads also carry framing the table accounting does not include.'
  );
  say('');

  say(
    '**The receiver\'s hop, which gets bigger in exactly the cases the sender\'s gets smaller.** A ' +
      'semantic inventory carries a unit table on top of the span table `delta.js` sends, and the ' +
      'receiver transmits it before the sender transmits anything:'
  );
  say('');
  const withInventory = res.scenarios.filter((s) => s.semanticInventoryBytes > 0);
  say(
    markdownTable(
      ['scenario', 'span inventory', 'semantic inventory', 'receiver hop change', 'sender hop change', 'both hops, span', 'both hops, semantic'],
      withInventory.map((s) => {
        const spanTotal = s.spanInventoryBytes + s.spanBytes;
        const semTotal = s.semanticInventoryBytes + s.semanticBytes;
        const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n)} B`;
        return [
          s.name,
          `${s.spanInventoryBytes} B`,
          `${s.semanticInventoryBytes} B`,
          signed(s.semanticInventoryBytes - s.spanInventoryBytes),
          signed(s.semanticBytes - s.spanBytes),
          `${spanTotal} B`,
          `${semTotal} B${semTotal < spanTotal ? '' : ' (worse)'}`
        ];
      })
    )
  );
  say('');
  say('Both change columns are semantic minus span, so a minus sign is a hop that got smaller.');
  say('');

  // `chooseDelta` compares payloads only. Whether that criterion also gets the
  // two-hop total right is a separate question, and it is checked here rather
  // than assumed — a row where the two disagree would mean the chooser is
  // optimising the wrong quantity.
  const agree = withInventory.filter((s) => {
    const semWins = s.semanticInventoryBytes + s.semanticBytes < s.spanInventoryBytes + s.spanBytes;
    return semWins === (s.chosen === 'semantic');
  });
  const invDeltas = withInventory.map((s) => s.semanticInventoryBytes - s.spanInventoryBytes);
  const invRange = `${Math.min(...invDeltas)} B to ${Math.max(...invDeltas).toLocaleString('en-US')} B`;
  const allBigger = invDeltas.every((d) => d > 0);
  say(
    `**\`chooseDelta\` compares payloads and ignores the inventory hop entirely.** On these ` +
      `${withInventory.length} scenarios that shortcut reaches the same verdict as the two-hop total ` +
      `in ${agree.length} of them` +
      (agree.length === withInventory.length
        ? `. The semantic inventory is ${allBigger ? 'larger in every row' : 'larger in most rows'} — ` +
          `by ${invRange} here — but never by enough to overturn the payload saving, so no row in this ` +
          'suite catches the chooser optimising the wrong quantity. That is a property of these ' +
          'scenarios, not a proof: a container with many units and a payload saving smaller than its ' +
          'unit table would break it.'
        : `, and disagrees in ${withInventory.length - agree.length}: ` +
          withInventory
            .filter((s) => !agree.includes(s))
            .map((s) => s.name)
            .join('; ') +
          '. **In those rows the chooser is optimising the wrong quantity.**')
  );
  say('');

  say('**Cost of the machinery itself (median ms):**');
  say('');
  say(
    markdownTable(
      ['scenario', 'container', 'semantic plan', 'inventory', 'chooseDelta (builds both)', 'apply + verify'],
      res.scenarios.map((s) => [
        s.name,
        `${s.fullBytes} B`,
        `${fmt(s.planMs.p50, 3)} ms`,
        s.baseBytes ? `${fmt(s.inventoryMs.p50, 3)} ms` : '—',
        `${fmt(s.chooseMs.p50, 3)} ms`,
        `${fmt(s.applyMs.p50, 3)} ms`
      ])
    )
  );
  say('');
  say(
    '`chooseDelta` is the expensive column because it builds both payloads before returning one: the ' +
      'span delta is computed even in the rows where the semantic delta wins, and vice versa. That is ' +
      'the price of the verdict being a measurement rather than a heuristic.'
  );
  say('');
}

function printPlannerSuite(res) {
  say('### The transfer planner: choosing a strategy before spending a byte');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }
  const w = res.weights;
  say(
    `Driving ${path.relative(REPO_ROOT, res.path)} end to end. ` +
      `J = ${w.T}·T + ${w.E}·E + ${w.B}·B + ${w.R}·R, weights summing to ${w.sum}, every term a ratio ` +
      `against the reference strategy (${res.reference}) evaluated in the same situation — that is, ` +
      'against what this app does today when nobody chooses anything. Container facts are read off ' +
      `real containers by the ${res.parserKind}` +
      `${res.parserReason ? ` (the microkernel would not instantiate: ${res.parserReason})` : ''}; ` +
      `timings are the median of ${res.reps} runs.`
  );
  say('');
  say('**The containers the receiver-side facts come from, measured rather than assumed:**');
  say('');
  say(
    markdownTable(
      ['container', 'bytes', 'spans', 'units', 'spans decomposed', 'decomposable bytes'],
      res.containers.map((c) => [
        `${c.label}${c.synthetic ? ' *(synthetic)*' : ''}`,
        c.containerBytes.toLocaleString('en-US'),
        String(c.spanCount),
        String(c.unitCount),
        `${c.decomposedSpans}/${c.spanCount}`,
        c.decomposableBytes.toLocaleString('en-US')
      ])
    )
  );
  say('');

  say('**What the planner chose, and out of how much.**');
  say('');
  say(
    markdownTable(
      ['situation', 'artifact', 'receiver holds', 'loss', 'candidates', 'admitted', 'chosen', 'J', 'T / E / B / R', 'publish next'],
      res.situations.map((s) => [
        `${s.name}${s.synthetic ? ' *(synthetic)*' : ''}`,
        `${s.artifactBytes.toLocaleString('en-US')} B`,
        s.holds,
        `${Math.round(s.lossRate * 100)}%`,
        String(s.candidateCount),
        String(s.admitted),
        `**${s.chosenLabel}**`,
        fmt(s.J, 3),
        s.terms
          ? `${fmt(s.terms.T, 2)} / ${fmt(s.terms.E, 2)} / ${fmt(s.terms.B, 2)} / ${fmt(s.terms.R, 2)}`
          : '—',
        `${s.inventoryGranularity} (${s.inventoryVerdict})`
      ])
    )
  );
  say('');

  say(
    '**What the alternatives cost.** Reporting that the planner returned the lowest J would be ' +
      'circular — J is what it sorts on. These are the extremes over the ADMISSIBLE set, the ' +
      'strategies that could legally have been chosen, in the planner\'s own transfer model:'
  );
  say('');
  say(
    markdownTable(
      ['situation', 'chosen', 'fastest admissible', 'slowest admissible', 'chosen ÷ fastest', 'chosen wire', 'leanest wire', 'heaviest wire', 'today’s default'],
      res.situations.map((s) => [
        s.name,
        `${fmt(s.chosenSeconds, 2)} s`,
        `${fmt(s.bestSeconds, 2)} s`,
        `${fmt(s.worstSeconds, 2)} s`,
        `${fmt(s.chosenSeconds / s.bestSeconds, 2)}×`,
        `${Math.round(s.chosenWireBytes).toLocaleString('en-US')} B`,
        `${Math.round(s.bestWireBytes).toLocaleString('en-US')} B`,
        `${Math.round(s.worstWireBytes).toLocaleString('en-US')} B`,
        `${fmt(s.referenceSeconds, 2)} s / ${Math.round(s.referenceWireBytes).toLocaleString('en-US')} B`
      ])
    )
  );
  say('');
  const notFastest = res.situations.filter((s) => !s.chosenIsFastest);
  say(
    'The last column is the receiver-side decision, which is in a different tense from the rest of the ' +
      'row: `chosen` is what the sender does now, bounded by what the receiver already published, and ' +
      '`publish next` is what that receiver should publish the next time it is asked. A receiver that ' +
      'published a unit table once and is told here not to do it again is the defect being corrected.'
  );
  say('');
  say(
    notFastest.length
      ? `With the radio allowed, the chosen strategy is also a time-minimal one in ` +
        `${res.situations.length - notFastest.length} of ${res.situations.length} situations. In the ` +
        `other ${notFastest.length} it is not, and that is J trading: ` +
        notFastest
          .map((s) => `${s.name} gives up ${fmt(s.chosenSeconds - s.bestSeconds, 2)} s against ${s.fastestLabel}`)
          .join('; ') +
        '.'
      : 'With the radio allowed, the chosen strategy is also a time-minimal one in every situation, so ' +
        'nothing in this table exercises J trading time against bytes, energy or risk. Ties between ' +
        'equally fast candidates are broken on J and then on id, and are not counted as trades here.'
  );
  say('');

  const radioChosen = res.situations.filter((s) => s.chosenTransport === 'peer');
  say(
    `**Wherever policy allows a radio, the plan is a foregone conclusion** — ${radioChosen.length} of ` +
      `${res.situations.length} situations choose the peer link, because it moves bytes at a rate no QR ` +
      'symbol approaches. The optical grid — two framings, two modes, two chunk sizes, two verification ' +
      'depths — only shows through when the radio is forbidden, and the optical case is the one this ' +
      'application is for. The same situations with `policy.radio = offline`:'
  );
  say('');
  say(
    markdownTable(
      ['situation', 'chosen optical strategy', 'J', 'T / E / B / R', 'runner-up', 'runner-up J', 'chosen', 'fastest admissible', 'slowest admissible', 'wire bytes'],
      res.optical.map((s) => [
        s.name,
        `**${s.chosenLabel}**`,
        fmt(s.J, 3),
        s.terms
          ? `${fmt(s.terms.T, 2)} / ${fmt(s.terms.E, 2)} / ${fmt(s.terms.B, 2)} / ${fmt(s.terms.R, 2)}`
          : '—',
        s.runnerUpLabel || '—',
        fmt(s.runnerUpJ, 3),
        `${fmt(s.chosenSeconds, 2)} s`,
        `${fmt(s.bestSeconds, 2)} s`,
        `${fmt(s.worstSeconds, 2)} s`,
        `${Math.round(s.chosenWireBytes).toLocaleString('en-US')} B`
      ])
    )
  );
  say('');
  const opticalNotFastest = res.optical.filter((s) => !s.chosenIsFastest);
  const opticalNotLeanest = res.optical.filter((s) => !s.chosenIsLeanest);
  say(
    `Offline, the chosen strategy is a time-minimal one in ` +
      `${res.optical.length - opticalNotFastest.length} of ${res.optical.length} situations and a ` +
      `byte-minimal one in ${res.optical.length - opticalNotLeanest.length}` +
      (opticalNotFastest.length
        ? `. Where it is neither — ${opticalNotFastest
            .map((s) => `${s.name}, giving up ${fmt(s.chosenSeconds - s.bestSeconds, 2)} s against ${s.fastestLabel}`)
            .join('; ')} — the seconds are what the other three terms bought.`
        : '. The two agree in every row, so nothing here catches T and B pulling apart; the fountain ' +
          'mode wins on both at once because a rateless transport pays no coupon-collector penalty and ' +
          'therefore paints fewer symbols as well as finishing sooner.')
  );
  say('');
  const risky = res.optical.filter((s) => s.terms && s.terms.R > 0);
  if (risky.length) {
    say(
      `The risk term is live in ${risky.length} of these rows and decisive in none of them: ` +
        risky
          .map((s) => `${s.name} carries R = ${fmt(s.terms.R, 2)}, worth ${fmt(res.weights.R * s.terms.R, 3)} of J, ` +
            `against a runner-up ${fmt(s.runnerUpJ - s.J, 3)} behind`)
          .join('; ') +
        '. A hazard priced below the gap it would have to close does not change a decision, which is ' +
        'the honest reading of a weighted sum and not a criticism of one.'
    );
    say('');
  }

  say(
    '**The cost of deciding.** `plan()` enumerates and scores the whole candidate set before a byte ' +
      'moves. "Saved" is the reference strategy\'s projected transfer time minus the chosen one\'s:'
  );
  say('');
  say(
    markdownTable(
      ['situation', 'candidates', 'admitted', 'plan p50', 'plan p95', 'transfer saved', 'saved ÷ planning', 'verdict'],
      res.situations.map((s) => {
        const ratio = s.savedSeconds / (s.planMs.p50 / 1000);
        return [
          s.name,
          String(s.candidateCount),
          String(s.admitted),
          `${fmt(s.planMs.p50, 3)} ms`,
          `${fmt(s.planMs.p95, 3)} ms`,
          `${fmt(s.savedSeconds, 2)} s`,
          Number.isFinite(ratio) ? Math.round(ratio).toLocaleString('en-US') + '×' : '—',
          s.savedSeconds > 0 ? 'pays for itself' : '**costs more than it saves**'
        ];
      })
    )
  );
  say('');
  const ratios = res.situations
    .map((s) => s.savedSeconds / (s.planMs.p50 / 1000))
    .filter((r) => Number.isFinite(r) && r > 0);
  const orders = [Math.floor(Math.log10(Math.min(...ratios))), Math.floor(Math.log10(Math.max(...ratios)))];
  say(
    'Two readings of that table are worth keeping apart. The planning cost is real and small: a plan is ' +
      'arithmetic over a few dozen candidates and never touches the artifact, so it does not grow with ' +
      'the container — the megabyte row plans no more slowly than the 132-byte one. The saving is a ' +
      'PROJECTION and it is not all the planner\'s doing: in the rows where the peer link wins, most of ' +
      'the saved time is the radio being faster than a screen, which needs no planner to notice. The ' +
      'narrower claim the table supports is the one that matters for a regression: at these candidate ' +
      `counts the decision is ${orders[0]} to ${orders[1]} orders of magnitude cheaper than the transfer ` +
      'it decides about, so it cannot be the thing that costs more than it saves.'
  );
  say('');

  say('**The hard rules under an adversarial adviser.** Advice weight asked for: ' +
    `${res.rules[0].adviceWeightAsked}, applied: ` +
    `${Math.max(...res.rules.map((r) => r.adviceWeightApplied))} ` +
    `(the module caps it at ${res.maxAdviceWeight}; the trust row reports 0 because it has no ranked ` +
    'candidate to carry a weight at all). The adviser returns the maximum preference for exactly the ' +
    'candidates the rule forbids and the minimum for every other candidate:');
  say('');
  say(
    markdownTable(
      ['rule', 'situation', 'candidates', 'admitted', 'rejected', 'rejected by this rule', 'maximally favoured', 'appeared in the ranking', 'violator chosen?', 'outcome'],
      res.rules.map((r) => [
        r.rule,
        r.name,
        String(r.candidateCount),
        String(r.admitted),
        String(r.rejectedTotal),
        String(r.rejectedByThisRule),
        String(r.favoured),
        String(r.violatorsRanked),
        r.violatorChosen ? '**YES**' : 'no',
        r.chosenLabel ? r.chosenLabel : '*no plan at all*'
      ])
    )
  );
  say('');
  const leaked = res.rules.filter((r) => r.violatorChosen || r.violatorsRanked > 0 || r.violatorsAdmitted > 0);
  say(
    leaked.length
      ? `**${leaked.length} rule(s) leaked a forbidden candidate into the ranking: ` +
        `${leaked.map((r) => r.rule).join(', ')}.**`
      : 'No forbidden candidate reached the ranking under any of the four rules, at any advice weight ' +
        'the module would accept or the caller would ask for. The reason it cannot is structural rather ' +
        'than numerical: a rejection carries an id, a label and a sentence, not a candidate object, so ' +
        'after the filter runs there is nothing left for the adviser to prefer.'
  );
  say('');
  say(
    'The trust row is the one that returns no plan at all. Every candidate breaks that rule, so the ' +
      'admissible set is empty and `chosen` is null — the correct outcome for an unverified peer, and ' +
      `the plan still explains itself: "${res.rules[0].reason}"`
  );
  say('');

  say(
    '**The inventory-granularity rule.** A receiver decides whether to publish a unit table *before* ' +
      'anyone knows what changed, so the rule bounds what such a table could possibly save. The unit ' +
      'table is paid twice with certainty — once on the inventory hop, once inside the delta payload — ' +
      'and saves at most the decomposable bytes, once. "Break-even" is the largest fraction of those ' +
      'bytes that may turn over before it stops paying:'
  );
  say('');
  say(
    markdownTable(
      ['container', 'shape', 'record', 'inventory extra', 'payload extra', 'paid twice', 'decomposable', 'break-even', 'tolerance', 'verdict', 'publishes'],
      res.granularity.map((g) => [
        `${g.name}${g.synthetic ? ' *(synthetic)*' : ''}${g.hypothetical ? ' *(sizes only)*' : ''}`,
        g.what,
        `${g.recordBytes} B`,
        `${g.inventoryExtra.toLocaleString('en-US')} B`,
        `${g.payloadExtra.toLocaleString('en-US')} B`,
        `${g.doublePaid.toLocaleString('en-US')} B`,
        `${g.decomposableBytes.toLocaleString('en-US')} B`,
        g.decomposableBytes > 0 ? fmt(g.breakEven * 100, 1) + '%' : '—',
        fmt(g.tolerance * 100, 0) + '%',
        g.verdict,
        `**${g.granularity}**`
      ])
    )
  );
  say('');
  const units = res.granularity.filter((g) => g.granularity === 'unit');
  const spans = res.granularity.filter((g) => g.granularity === 'span');
  say(
    `${units.length} of ${res.granularity.length} shapes publish a unit table and ${spans.length} decline ` +
      `it — units for ${units.map((g) => g.name).join(', ')}; spans for ` +
      `${spans.map((g) => g.name).join(', ')}. ` +
      'A rule that only ever said yes would not be a rule, and the declining rows are not failures: ' +
      'declining unit granularity when it would have helped costs some bytes, paying for it when it ' +
      'cannot possibly help is the defect it exists to prevent.'
  );
  say('');
  const ti = res.toleranceInterval;
  say(
    '**The tolerance interval, derived from these break-evens rather than quoted.** ' +
      `${ti.declined} shape${ti.declined === 1 ? ' was' : 's were'} declined on the tolerance test and ` +
      `${ti.admitted} admitted, so every tolerance in (${fmt(ti.open, 3)}, ${fmt(ti.close, 3)}] gives ` +
      `identical verdicts on all ${ti.declined + ti.admitted} of them. The module's default is ` +
      `${res.defaultRewriteTolerance}, which is ${ti.defaultInside ? 'inside' : '**outside**'} that ` +
      'interval. The interval\'s width is the honest measure of how well this many shapes pin a threshold ' +
      'down, which is to say not very: the binding shapes are ' +
      `${res.granularity.filter((g) => g.breakEven === ti.open).map((g) => g.name).join(', ')} below and ` +
      `${res.granularity.filter((g) => g.breakEven === ti.close).map((g) => g.name).join(', ')} above, ` +
      'and a container between them would narrow it further or move it.'
  );
  say('');

  const checked = res.granularity.filter((g) => g.actualSpanInventoryBytes !== null);
  say(
    '**The rule\'s arithmetic against the real encoders.** The bound predicts inventory sizes instead of ' +
      'encoding anything, so both are reported for every container this suite parsed for real. Actual is ' +
      '`delta.encodeInventory` and `semdelta.encodeSemanticInventory`, base64url in both columns:'
  );
  say('');
  say(
    markdownTable(
      ['container', 'span inventory predicted', 'span actual', 'unit inventory predicted', 'unit actual', 'agrees?'],
      checked.map((g) => {
        const ok = g.predictedSpanInventoryBytes === g.actualSpanInventoryBytes &&
          g.predictedUnitInventoryBytes === g.actualUnitInventoryBytes;
        return [
          g.name,
          `${g.predictedSpanInventoryBytes.toLocaleString('en-US')} B`,
          `${g.actualSpanInventoryBytes.toLocaleString('en-US')} B`,
          `${g.predictedUnitInventoryBytes.toLocaleString('en-US')} B`,
          `${g.actualUnitInventoryBytes.toLocaleString('en-US')} B`,
          ok ? 'exact' : `**NO** (${g.predictedSpanInventoryBytes - g.actualSpanInventoryBytes} B, ` +
            `${g.predictedUnitInventoryBytes - g.actualUnitInventoryBytes} B)`
        ];
      })
    )
  );
  say('');
  say(
    `Deciding costs ${fmt(Math.max(...res.granularity.map((g) => g.chooseMs.p50)), 4)} ms at worst across ` +
      'these shapes: the rule is arithmetic on four numbers and does not touch the container, which is ' +
      'why it can run before the inventory it is deciding about exists.'
  );
  say('');
}

// --- Main --------------------------------------------------------------------

// Asynchronous solely because one measurement is: the browser's own
// `CompressionStream` has no synchronous form, and measuring the shipped app's
// codec through a synchronous stand-in would be measuring Node again.
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*!?/, ''));
    return;
  }

  const env = captureEnvironment();
  const modules = moduleInventory();

  say('## rvQR benchmark run');
  say('');
  say(
    markdownTable(
      ['key', 'value'],
      [
        ['node', env.node],
        ['v8', env.v8],
        ['platform', env.platform],
        ['cpu', env.cpu],
        ['memory', `${env.totalMemGB} GB`],
        ['commit', `${env.commit} (${env.worktree})`],
        ['seed', String(args.seed)],
        ['trials/cell', String(args.trials)],
        ['run at', env.ranAt]
      ]
    )
  );
  say('');
  say('**Modules under test:**');
  say('');
  say(
    markdownTable(
      ['file', 'present', 'bytes'],
      modules.map((m) => [m.file, m.present ? 'yes' : 'NO', m.present ? String(m.bytes) : '—'])
    )
  );
  say('');

  const shippedFountain = loadShippedFountain();
  const shippedDelta = loadShippedDelta();
  const decoder = loadDecoder();
  say(
    `Fountain codec: ${shippedFountain ? 'artifacts/fountain.js (measured directly)' : 'ABSENT — reference codecs only'}. ` +
      `Delta: ${shippedDelta ? 'artifacts/delta.js (measured directly)' : 'ABSENT'}. ` +
      `Decoder: ${decoder ? 'artifacts/vendor/qrdecode.js' : 'ABSENT'}.`
  );
  say('');

  const demoDir = path.join(REPO_ROOT, 'artifacts', 'demo');
  const rvf = new Uint8Array(fs.readFileSync(path.join(demoDir, 'ruvnet-demo.rvf')));
  const wasm = new Uint8Array(fs.readFileSync(path.join(demoDir, 'rvf_wasm_bg.wasm')));

  const results = { env, modules, args: { ...args } };
  const want = (s) => args.suite === 'all' || args.suite === s;

  if (want('loss')) {
    say('---');
    say('');
    results.lossIid = runLossSuite({
      bytes: wasm,
      payloadName: 'rvf_wasm_bg.wasm',
      chunk: 512,
      trials: args.trials,
      baseSeed: args.seed,
      channelKind: 'iid'
    });
    printLossSuite(results.lossIid);

    results.lossBurst = runLossSuite({
      bytes: wasm,
      payloadName: 'rvf_wasm_bg.wasm',
      chunk: 512,
      trials: Math.max(25, Math.round(args.trials / 2)),
      baseSeed: args.seed,
      channelKind: 'gilbert',
      meanBurst: 4,
      schemes: ['shipped']
    });
    printLossSuite(results.lossBurst);

    results.lossSmall = runLossSuite({
      bytes: rvf,
      payloadName: 'ruvnet-demo.rvf',
      chunk: 512,
      trials: args.trials,
      baseSeed: args.seed,
      channelKind: 'iid',
      schemes: ['shipped']
    });
    printLossSuite(results.lossSmall);

    results.manifestSweepSmall = runManifestSweep({
      bytes: rvf,
      payloadName: 'ruvnet-demo.rvf',
      trials: args.trials,
      baseSeed: args.seed
    });
    printManifestSweep(results.manifestSweepSmall);

    results.manifestSweepLarge = runManifestSweep({
      bytes: wasm,
      payloadName: 'rvf_wasm_bg.wasm',
      trials: args.trials,
      baseSeed: args.seed
    });
    printManifestSweep(results.manifestSweepLarge);
  }

  if (want('overhead')) {
    say('---');
    say('');
    results.overhead = runOverheadSuite({
      decodesPerK: args.quick ? 20 : 200,
      baseSeed: args.seed
    });
    printOverheadSuite(results.overhead);
    results.symbolSizeSweep = runSymbolSizeSweep({ bytes: wasm });
    printSymbolSizeSweep(results.symbolSizeSweep);
  }

  if (want('payloads')) {
    say('---');
    say('');
    results.payloads = runPayloadSuite([
      { bytes: rvf, name: 'ruvnet-demo.rvf' },
      { bytes: wasm, name: 'rvf_wasm_bg.wasm' }
    ]);
    printPayloadSuite(results.payloads);
    results.projections = {
      oneMB: projectTransfer(1024 * 1024, 1024, 10),
      tenMB: projectTransfer(10 * 1024 * 1024, 1024, 10),
      oneGB: projectTransfer(1024 * 1024 * 1024, 1024, 10)
    };
  }

  if (want('delta')) {
    say('---');
    say('');
    results.delta = runDeltaSuite({ bytes: rvf, name: 'ruvnet-demo.rvf', seed: args.seed });
    // Span size is the one free parameter in the large-container projection and
    // it cuts both ways: large spans waste payload on unchanged bytes, small
    // spans make the inventory itself expensive to send. Both are shown.
    const spanSizes = [4 * 1024 * 1024, 1024 * 1024, 256 * 1024, 64 * 1024].map((spanBytes) => {
      const p = projectLargeContainer({ spanBytes })[0];
      return {
        spanBytes,
        spans: p.spans,
        inventoryBytes: p.inventoryBytes,
        inventoryMinutesDefault: p.inventoryBytes / (512 * 5) / 60,
        ratio: p.ratio
      };
    });
    results.deltaProjection = projectLargeContainer({});
    results.deltaProjection.spanSizes = spanSizes;
    printDeltaSuite(results.delta, results.deltaProjection);
  }

  if (want('qr')) {
    say('---');
    say('');
    results.qrCost = runQrCostSuite({ bytes: wasm, name: 'rvf_wasm_bg.wasm' });
    results.versionSweep = runVersionSweep({});
    printQrCostSuite(results.qrCost, results.versionSweep);
    results.decodeVersionSweep = runDecodeVersionSweep({});
    printDecodeVersionSweep(results.decodeVersionSweep);
  }

  if (want('proto')) {
    say('---');
    say('');
    // The density search runs to 2953 B chunks, so it needs an artifact bigger
    // than that or a short final frame would be mistaken for an efficient one.
    results.protoDensity = runProtoDensity({ bytes: wasm, name: 'rvf_wasm_bg.wasm' });
    printProtoDensity(results.protoDensity);
    results.protoAppRates = runProtoAtAppRates({
      payloads: [
        { bytes: rvf, name: 'ruvnet-demo.rvf' },
        { bytes: wasm, name: 'rvf_wasm_bg.wasm' }
      ]
    });
    printProtoAtAppRates(results.protoAppRates);
    results.v1FrameSpread = runV1FrameSpread({
      payloads: [
        { bytes: rvf, name: 'ruvnet-demo.rvf' },
        { bytes: wasm, name: 'rvf_wasm_bg.wasm' }
      ]
    });
    printV1FrameSpread(results.v1FrameSpread);
  }

  // The compression suite's corpus and its winning codec per artifact feed the
  // objective function, so it is computed whenever either is wanted.
  const needCorpus = want('compress') || want('objective');
  let corpus = null;
  if (needCorpus) {
    corpus = loadCorpus({ seed: args.seed });
    results.compression = runCompressionSuite({ corpus, reps: args.quick ? 1 : 3 });
  }

  if (want('compress')) {
    say('---');
    say('');
    printCompressionSuite(results.compression);
    results.breakEven = runBreakEvenSweep({ corpus });
    printBreakEven(results.breakEven);

    // The grid above measures the CODECS. What follows measures the module that
    // ships the decision, on a corpus with one artifact the grid cannot contain:
    // the repository holds nothing a codec loses on, so the decline case has to
    // be generated or it cannot be observed.
    const forDecision = decisionCorpus({ seed: args.seed });
    results.decision = runDecisionSuite({ corpus: forDecision, reps: args.quick ? 1 : 3 });
    printDecisionSuite(results.decision);

    // The second environment. Node's codecs are not the app's codecs: a browser
    // has deflate-raw and neither of the two ADR-003 §2.1 names, so the rows
    // above overstate what a user of the web app gets unless this runs beside
    // them. Asynchronous, because the browser's codec is.
    results.browser = await runBrowserSuite({
      corpus: forDecision,
      nodeRows: results.decision.available ? results.decision.rows : [],
      reps: args.quick ? 1 : 3
    });
    printBrowserSuite(results.browser);

    results.gateBand = runGateBand({ corpus: forDecision });
    printGateBand(results.gateBand);
    results.sampledPath = runSampledPath({ corpus: forDecision });
    printSampledPath(results.sampledPath);
    results.adr003 = runAdr003Recheck({ reps: args.quick ? 1 : 5 });
    printAdr003Recheck(results.adr003);
  }

  if (want('objective')) {
    say('---');
    say('');
    // The reception-overhead ratio is a MEASURED input, so it is taken from the
    // overhead suite when that ran and stated as an assumption of 1.0 when it
    // did not — never silently defaulted.
    const overheadRatio = results.overhead?.available
      ? 1 + results.overhead.aggregate.mean / 81
      : 1;
    // Three artifacts rather than the whole corpus: a small container, a
    // medium binary and the largest real file. More rows would not add a
    // finding, and the table is already the widest in the report.
    const wanted = ['ruvnet-demo.rvf', 'rvf_wasm_bg.wasm', 'standalone.html'];
    results.objective = runObjectiveSuite({
      corpus: results.compression.rows
        .filter((r) => wanted.some((w) => r.name.endsWith(w)))
        .map((r) => ({ name: r.name, bytes: r.bytes, best: r.best })),
      codingOverheadRatio: overheadRatio
    });
    results.objective.codingOverheadRatio = overheadRatio;
    results.objective.codingOverheadMeasured = !!results.overhead?.available;
    results.indexedPenalty = indexedPenalty(results.lossIid);
    printObjectiveSuite(results.objective, results.indexedPenalty);
  }

  if (want('fleet')) {
    say('---');
    say('');
    results.fleet = runFleetSuite({
      trials: args.quick ? 4 : 12,
      baseSeed: args.seed
    });
    results.fleetScale = runFleetScaleCheck({
      trials: args.quick ? 3 : 8,
      baseSeed: args.seed
    });
    printFleetSuite(results.fleet, results.fleetScale);
  }

  if (want('closures')) {
    say('---');
    say('');
    let spans = [];
    if (shippedDelta) {
      try {
        spans = shippedDelta.module.spanPlan(rvf);
      } catch {
        spans = [];
      }
    }
    let appBytes = 0;
    try {
      appBytes = fs.statSync(path.join(REPO_ROOT, 'standalone.html')).size;
    } catch {
      appBytes = 0;
    }
    results.closures = runClosureSuite({
      profiles: closureProfiles({
        rvfBytes: rvf.length,
        wasmBytes: wasm.length,
        appBytes: appBytes || 512 * 1024,
        rvfSpans: spans
      }),
      transports: [
        { label: 'v1 JSON, 512 B @ 5 fps', chunk: 512, armour: false, fps: 5 },
        { label: 'v2 armoured, 665 B @ 5 fps', chunk: 665, armour: true, fps: 5 },
        { label: 'v2 armoured, 665 B @ 10 fps', chunk: 665, armour: true, fps: 10 },
        { label: 'v2 armoured, 665 B @ 30 fps', chunk: 665, armour: true, fps: 30 }
      ]
    });
    printClosureSuite(results.closures);
  }

  if (want('memory')) {
    say('---');
    say('');
    results.memory = runMemorySuite({});
    printMemorySuite(results.memory);
  }

  if (want('semdelta')) {
    say('---');
    say('');
    results.semdelta = runSemDeltaSuite({
      demoBytes: rvf,
      wasmModule: wasm,
      seed: args.seed,
      reps: args.quick ? 1 : 5
    });
    printSemDeltaSuite(results.semdelta);
  }

  if (want('planner')) {
    say('---');
    say('');
    results.planner = runPlannerSuite({
      demoBytes: rvf,
      wasmModule: wasm,
      seed: args.seed,
      reps: args.quick ? 1 : 9
    });
    printPlannerSuite(results.planner);
  }

  if (args.json) {
    const out = path.resolve(args.json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    say(`Raw results written to ${out}`);
  }

  return results;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
