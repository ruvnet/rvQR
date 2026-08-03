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
 *         fleet, closures, memory, semdelta.
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
  runCompressionSuite,
  runBreakEvenSweep,
  ENVELOPE_GAIN_GATE
} from './suites/compress.mjs';
import { runObjectiveSuite, indexedPenalty, P_SWEEP } from './suites/objective.mjs';
import { runFleetSuite, runFleetScaleCheck } from './suites/fleet.mjs';
import { runClosureSuite, closureProfiles, FIRST_CLOSURE_TARGET_SECONDS } from './suites/closures.mjs';
import { runMemorySuite } from './suites/memory.mjs';
import { runSemDeltaSuite } from './suites/semdelta.mjs';
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

// --- Main --------------------------------------------------------------------

function main() {
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

  if (args.json) {
    const out = path.resolve(args.json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    say(`Raw results written to ${out}`);
  }

  return results;
}

main();
