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
 *         fleet, closures, memory, semdelta, planner, attest, closure, swarm,
 *         presence.
 *
 * `closures` and `closure` differ by one letter and are different suites.
 * `closures` (suite 10) is a MODEL of how long a split artifact takes to
 * arrive and runs no module; `closure` (suite 15) drives artifacts/closure.js
 * with the real SHA-256 and Ed25519 from artifacts/crypto.js and measures what
 * the split costs in bytes and in verification time.
 *
 * `presence` (suite 17) drives artifacts/presence.js. NONE of ADR-023's three
 * presence channels is implemented anywhere in this repository — there is no
 * acoustic code, no ranging code, and no browser exposes a UWB API at all — so
 * every signal it feeds the module comes from an INJECTED STUB READER and the
 * suite measures the FUSION RULE and nothing about physical presence. ADR-023
 * §4's criterion 4 needs a measured relay attempt with two devices and two
 * rooms, and criterion 6 needs a UI; both are unmet and neither is simulated.
 *
 * `swarm` (suite 16) is the only suite here whose timings are SIMULATION TICKS
 * rather than anything measured off a clock. Its byte and chunk counts are real
 * measurements of the simulation; its tick counts measure nothing about any
 * fleet, and ADR-024's Fleet-10 and Fleet-100 criteria need physical devices
 * and are not met by running it.
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
import { runAttestSuite } from './suites/attest.mjs';
import { runClosureModuleSuite, runSignatureBackends } from './suites/closure.mjs';
import { runSwarmSuite } from './suites/swarm.mjs';
import { runPresenceSuite } from './suites/presence.mjs';
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
    '**Do not read the receiver rows of that table as the copy budget.** "Live copies" is RETAINED ' +
      'memory at the END of each stage, so it cannot see a buffer that is allocated and freed inside ' +
      'one — and the shipped receiver allocates exactly such a buffer, a padded copy of the whole ' +
      `artifact, inside \`finalize\`. That is why this table said ${fmt(res.v1.receiverPeakCopies, 2)}× ` +
      `and ${fmt(res.v2.receiverPeakCopies, 2)}× while \`artifacts/pipeline.test.js\` said 3.00× for the ` +
      'same two receivers. The receiver section below is that measurement done properly, under three ' +
      'named accountings; these stage rows are kept because the SENDER figures and the `toTransport` ' +
      'result are still what they measure.'
  );
  say('');
  say(
    `Sender side, v1 holds ${fmt(res.v1.senderCopies, 2)}× as base64url text and v2 ` +
      `${fmt(res.v2.senderCopiesOneFrame, 2)}× with one armoured frame retained. Both transfers ` +
      `verified byte-exact (v1 ${res.v1Verified ? 'yes' : 'NO'}, v2 ${res.v2.verified ? 'yes' : 'NO'}). ` +
      `Peak RSS for this stage process is ${fmt(res.peakRssMiB, 1)} MiB, of which ` +
      `${fmt(res.peakRssAboveBaselineMiB, 1)} MiB is the pipeline above an empty Node process — ` +
      `${res.withinBudget ? 'inside' : 'OVER'} the ${res.budgetMiB} MiB budget. It runs both senders ` +
      'and both receivers back to back, so it is the highest figure in this suite and is not a ' +
      "receiver's cost; the twelve isolated receiver cells below are."
  );
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
  printReceiverComparison(res);
}

/**
 * The receiver comparison: the shipped buffered receivers against
 * `artifacts/pipeline.js`'s streaming one, on every artifact and both
 * protocols, under three accountings that do not agree — and the reconciliation
 * that says which one the budget is about.
 */
function printReceiverComparison(res) {
  if (!res.cells || !res.cells.length) return;
  const led = res.ledger && res.ledger.available ? res.ledger : null;

  say('#### Shipped receiver against the streaming receiver, ADR-025 §2.2');
  say('');
  say(
    'Every artifact in the repository, both protocols, both receive paths. `shipped` is ' +
      '`core.js`/`proto2.js` — ingest into a chunk list, `assemble`, then a one-shot SHA-256. ' +
      '`streaming` is `artifacts/pipeline.js` — one preallocated output buffer, payloads written at ' +
      'their offset and dropped, and a digest that advances over a hash frontier. v2 frames are fed ' +
      'as BINARY on both paths; `toTransport` is a sender cost and is measured as one, above.'
  );
  say('');
  say('**Three ways to count a copy. They do not agree, and each column says what it counts.**');
  say('');
  say(
    markdownTable(
      ['artifact', 'proto', 'path', 'ledger peak', 'ledger handover', 'retained (± band)', 'write/read passes', 'peak RSS', 'ms', 'MiB/s'],
      res.cells.map((c) => [
        `${c.artifact} (${c.artifactBytes} B)`,
        c.protocol,
        c.path,
        `${fmt(c.ledgerPeakCopies, 4)}×${c.ledgerWithinBudget === false ? ' **OVER**' : ''}`,
        fmt(c.ledgerHandoverCopies, 4) + '×',
        c.retainedResolvable
          ? `${fmt(c.retainedCopies, 3)}× ± ${fmt(c.retainedBandCopies, 3)}`
          : `*unresolvable (± ${fmt(c.retainedBandCopies, 2)}×)*`,
        `${fmt(c.writePasses, 0)} / ${fmt(c.hashPasses, 0)}`,
        `${fmt(c.peakRssMiB, 1)} MiB`,
        fmt(c.medianMs, 3),
        fmt(c.mibPerSec, 1)
      ])
    )
  );
  say('');
  say(
    '**`ledger peak`** is the peak of live receiver-held bytes over the transfer, in exact payload ' +
      'byte lengths, from the ledger inside `artifacts/pipeline.js`. **`ledger handover`** is the ' +
      'subset of that still live when the artifact is handed over. **`retained`** is heapUsed + ' +
      'external after a forced collection with the result held, median of five cycles after three ' +
      'warm-ups and a discarded first cycle; the band beside it is the spread of a CONTROL cycle — ' +
      'the identical transfer with the result discarded, which should retain zero. Where the band is ' +
      'comparable to the answer the cell says *unresolvable* rather than printing a ratio that ' +
      'measures the collector.'
  );
  say('');

  const rec = res.reconciliation;
  if (rec && rec.rows.length) {
    const shipped = rec.rows.find((r) => r.path === 'shipped');
    const streamed = rec.rows.find((r) => r.path === 'streaming');
    const hp = rec.hashPadding && rec.hashPadding.length ? rec.hashPadding[0] : null;
    say(`**The two disagreements, resolved on \`${rec.artifact}\`.**`);
    say('');
    if (shipped) {
      say(
        `The ledger rates the shipped receiver at **${fmt(shipped.ledgerPeakCopies, 2)}×** and the heap ` +
          `at **${fmt(shipped.retainedCopies, 2)}×**, a gap of ${fmt(shipped.peakMinusRetained, 2)}×. ` +
          'The gap is one whole copy of the artifact and the ledger is right: `core.sha256Bytes` ' +
          'allocates a 64-byte-aligned PADDED COPY of its entire input, hashes it and drops it, so at ' +
          'the moment of verification the chunk list, the assembled output and the padded copy are all ' +
          'live. The retained measurement is taken after that copy is garbage, and cannot see it. ' +
          (hp
            ? `That copy is not modelled here, it is weighed: live bytes sampled either side of the ` +
              `one-shot hash with no collection in between come out at **${fmt(hp.observedCopies, 4)}× ` +
              `the artifact** against a modelled ${fmt(hp.modelledCopies, 4)}×, a ratio of ` +
              `${fmt(hp.observedOverModelled, 4)}. `
            : '') +
          `ADR-025 §2.2 bounds copies that COEXIST, so the peak is the number the budget is about.`
      );
      say('');
      say(
        `The second disagreement runs the other way: the heap reads ` +
          `${fmt(shipped.retainedMinusHandover, 2)}× ABOVE the ledger's handover figure of ` +
          `${fmt(shipped.ledgerHandoverCopies, 2)}×. That gap is allocator overhead the exact-byte ` +
          'ledger does not model — `core.js` keeps its chunks in a dictionary-mode ' +
          '`Object.create(null)`, and the per-entry cost of that is real memory. The ledger counts ' +
          'what the code asked for; the heap counts what the allocator handed back. Neither is wrong ' +
          'about its own quantity, and reporting either one alone was what produced two different ' +
          'answers for one receiver.'
      );
      say('');
    }
    if (streamed) {
      say(
        `On the streaming receiver the three accountings converge: peak ` +
          `${fmt(streamed.ledgerPeakCopies, 4)}×, handover ${fmt(streamed.ledgerHandoverCopies, 4)}×, ` +
          `retained ${fmt(streamed.retainedCopies, 3)}× ± ${fmt(streamed.retainedBandCopies, 3)}. There ` +
          'is no transient copy for the peak to catch and no chunk dictionary for the allocator to ' +
          'charge for, so the three numbers agree to inside the heap method\'s own resolution.'
      );
      say('');
    }
  }

  if (led) {
    const streamCells = res.cells.filter((c) => c.path === 'streaming');
    const worst = streamCells.reduce((a, b) => (b.ledgerPeakCopies > a.ledgerPeakCopies ? b : a), streamCells[0]);
    const best = streamCells.reduce((a, b) => (b.ledgerPeakCopies < a.ledgerPeakCopies ? b : a), streamCells[0]);
    say('**Where the fixed overhead bites: the smallest artifact has the worst ratio.**');
    say('');
    say(
      'The streaming receiver holds the output, one in-flight frame payload, one byte per frame of ' +
        'index, and a 64-byte hash carry. Only the first of those scales with the payload, so the ' +
        'ratio is 1 + (fixed overhead)/N. The overhead does not shrink when the payload does: ' +
        `${worst.artifact} at ${worst.artifactBytes} B pays **${fmt(worst.ledgerPeakCopies, 4)}×** on ` +
        `${worst.protocol} — ${worst.overheadBytes} B of it fixed — where ${best.artifact} at ` +
        `${best.artifactBytes} B pays ${fmt(best.ledgerPeakCopies, 4)}×. Quoting only the megabyte ` +
        'figure would flatter the result by a factor of ' +
        `${fmt((worst.ledgerPeakCopies - 1) / (best.ledgerPeakCopies - 1), 0)} on the part that is ` +
        'not the artifact itself. Every row below is a real transfer through the real receiver, not ' +
        'the overhead formula evaluated.'
    );
    say('');
    say(
      markdownTable(
        ['artifact size', 'v1 (512 B chunks)', 'v2 (665 B chunks)'],
        led.ladder.map((r) => [
          `${r.bytes} B`,
          fmt(r.v1, 4) + '×',
          fmt(r.v2, 4) + '×'
        ])
      )
    );
    say('');
    say(
      markdownTable(
        ['protocol', 'chunk', 'drops below', 'at artifact size', 'copies there', 'one byte smaller', 'true crossing?'],
        led.crossovers.map((c) => [
          c.protocol,
          `${c.chunk} B`,
          fmt(c.threshold, 2) + '×',
          c.bytes === null ? '—' : `**${c.bytes} B**`,
          c.bytes === null ? '—' : fmt(c.copiesAtCrossover, 6) + '×',
          c.bytes === null ? '—' : fmt(c.copiesOneByteSmaller, 6) + '×',
          c.isTrueCrossing ? 'yes' : 'NO'
        ])
      )
    );
    say('');
    say(
      'Found by bisection over real transfers, then verified: the size one byte smaller is still at ' +
        'or above the threshold, and every one of 24 sampled sizes above it is still below. The ' +
        'crossover is mostly a statement about the CHUNK SIZE — the in-flight frame payload is the ' +
        'largest single term in the overhead — so it moves with the sender\'s choice of chunk, and ' +
        'both chunk sizes are named in the table rather than left implicit.'
    );
    say('');
    say('**What the streaming receiver allocates, read out of the source:**');
    say('');
    say(
      markdownTable(
        ['ledger kind', 'what allocates', 'cost'],
        (res.streamingSites || []).map((s) => [s.kind, s.site, s.cost])
      )
    );
    say('');
  }

  const overRss = res.cells.filter((c) => c.withinRssBudget === false);
  say(
    `**Peak RSS across all twelve receiver cells: ${fmt(res.receiverPeakRssMiB, 1)} MiB against the ` +
      `128 MiB budget — ${res.receiverWithinRssBudget ? 'inside' : 'OVER'}` +
      `${overRss.length ? `, but ${overRss.length} cell(s) are over` : ''}; ` +
      `${fmt(res.suitePeakRssMiB, 1)} MiB is the highest anywhere in this suite, in the stage process ` +
      `that runs both senders and both receivers back to back. Each receiver cell is measured COLD ` +
      'and alone in its own process, because peak RSS is a high-water mark that never comes back ' +
      'down: two receivers in one process and the second inherits the first\'s peak. The streaming ' +
      'receiver did not move this budget and does not claim to — it was green before ' +
      '`artifacts/pipeline.js` existed, and the copy count was the red number.**'
  );
  say('');

  const t = res.throughput;
  if (t && t.available) {
    const big = res.cells.filter((c) => c.artifact === 'standalone.html');
    const sV1 = big.find((c) => c.protocol === 'v1' && c.path === 'shipped');
    const rV1 = big.find((c) => c.protocol === 'v1' && c.path === 'streaming');
    say(
      '**Streaming is not slower, which was not a given.** On the 1.18 MB artifact the streaming ' +
        (sV1 && rV1
          ? `receiver runs v1 in ${fmt(rV1.medianMs, 1)} ms against the shipped receiver's ` +
            `${fmt(sV1.medianMs, 1)} ms — ${fmt(sV1.medianMs / rV1.medianMs, 2)}× faster — `
          : 'receiver is the faster of the two — ') +
        'because it never runs the `assemble` pass and never allocates the padded hash input. On the ' +
        'two small artifacts the two paths are within noise of each other. Frame BUILDING is the ' +
        'sender\'s cost and is excluded from every timing above; it is reported separately by the ' +
        'probe. These are receive-path rates in a Node process, not link rates: the optical channel ' +
        'measured elsewhere in this document runs at 2.44 KB/s, five orders of magnitude below.'
    );
    say('');
  }

  if (led && led.criteria) {
    say('**ADR-025\'s seven acceptance criteria, including the three this repository cannot meet:**');
    say('');
    say(
      markdownTable(
        ['#', 'criterion', 'status', 'where / why'],
        led.criteria.map((c) => [
          String(c.id),
          c.title,
          c.status === 'met' ? '**met**' : c.status,
          c.where || c.reason || '—'
        ])
      )
    );
    say('');
    say(
      'Those reasons are read out of `ADR025_CRITERIA` in the running `artifacts/pipeline.js`, not ' +
        'restated here, so a criterion cannot quietly disappear from this report. One figure inside ' +
        'them is stale and is corrected rather than passed through: criterion 2 cites 75.2 MiB of ' +
        `128 MiB for the peak-RSS budget, from an earlier run of this suite. This run measured ` +
        `${fmt(res.suitePeakRssMiB, 1)} MiB as the suite peak and ${fmt(res.receiverPeakRssMiB, 1)} MiB ` +
        'as the highest receiver cell. The verdict is unchanged — green, with room — and the ' +
        'not-applicable reasoning is unaffected.'
    );
    say('');
  }
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

function printAttestSuite(res) {
  say('### Device attestation: the gate that decides, and the hardware it has never touched');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }

  // The disclaimer comes first, before any number, because a reader who takes
  // the tables below for hardware attestation has been misled by this report
  // and not by the module — `attest.js` says the same thing in its own docblock.
  const unexercised = res.roots.filter((r) => r.status === 'unexercised');
  say(
    `**No root of trust is exercised anywhere in this suite, and none exists in this repository.** ` +
      `\`describeRoots()\` reports ${unexercised.length} of ${res.roots.length} as \`unexercised\` — ` +
      res.roots.map((r) => `${r.label} (\`${r.status}\`)`).join(', ') +
      '. So this section measures the **verdict-and-gate logic** and nothing at all about real ' +
      'hardware attestation. Wherever a chain verifier is needed below it is an ' +
      `**${res.chainVerifier}**, and every table built with one says so in the table. ` +
      'On this platform, today, the `attested` state is unreachable without a verifier nothing here has.'
  );
  say('');
  say(
    `The signing identity has not moved either: \`describeKeyCustody()\` reports the key in ` +
      `\`${res.keyCustody.store}\` under \`${res.keyCustody.key}\`, readable by page script ` +
      `(\`hardwareBacked: ${res.keyCustody.hardwareBacked}\`, \`demonstrated: ${res.keyCustody.demonstrated}\`), ` +
      `so ADR-035 is **not** superseded. This environment ` +
      (res.hardwareKeys.webAuthnPresent
        ? 'does expose WebAuthn, which is an API being present and not a key having signed anything'
        : 'exposes no WebAuthn at all') +
      `, and nothing in the module reads that result.`
  );
  say('');

  say(
    `Driving ${path.relative(REPO_ROOT, res.path)} end to end — ${res.exports} exports, ` +
      `${res.states.length} attestation states, ${res.artifactClasses.length} artifact classes. ` +
      'Every verdict in the matrix below is produced by handing real evidence to the real ' +
      '`verifyAttestation`; none is written by hand. Measurements in the fixtures are lowercase hex of ' +
      'even length, because `parseEvidence` refuses anything else as malformed.'
  );
  say('');

  say(
    '**The state matrix.** Every state the module defines, against a policy that requires attestation ' +
      'and one that does not. The capability grant covers both identities in both columns, so the only ' +
      'thing varying across a row is the evidence bar:'
  );
  say('');
  say(
    markdownTable(
      ['state', 'how it was reached', 'stub verifier', 'facts published', 'requiring policy → code', 'admits?', 'permitting policy → code', 'admits?'],
      res.verdicts.map((v) => {
        const strict = v.cells.find((c) => c.policy === 'requires');
        const lax = v.cells.find((c) => c.policy === 'permits');
        return [
          `\`${v.state}\`${v.reachedIntendedState ? '' : ' **(recipe missed)**'}`,
          v.how,
          v.stub ? `yes, ${v.stub}` : 'none',
          v.publishesFacts ? 'yes' : 'no',
          `\`${strict.code}\``,
          strict.admit ? '**YES**' : 'no',
          `\`${lax.code}\``,
          lax.admit ? '**yes**' : 'no'
        ];
      })
    )
  );
  say('');
  const missed = res.verdicts.filter((v) => !v.reachedIntendedState);
  say(
    (missed.length
      ? `**${missed.length} recipe(s) did not reach the state they were built to reach — ` +
        `${missed.map((v) => v.state).join(', ')} — so those rows measure something other than what they name.**`
      : `All ${res.verdicts.length} recipes reached the state they were built to reach, so every row ` +
        'measures the state it names.') +
      ' ' +
      (res.wrongAdmissions.length
        ? `**${res.wrongAdmissions.length} cell(s) admit a non-attested state under a policy that ` +
          `requires attestation: ${res.wrongAdmissions.map((w) => `${w.state} → ${w.code}`).join(', ')}. ` +
          'That is a defect and it is reported here rather than fixed by adjusting the fixture.**'
        : 'No cell admits a non-attested state under a policy that requires attestation, which is the ' +
          'property the whole matrix exists to test.')
  );
  say('');
  say(
    '**The `attested` row is the only one that publishes the measured facts**, and that is the ' +
      'information barrier rather than a convention: `measurement`, `policyEpoch`, `signerSetId` and ' +
      '`storageClasses` are null on every other state, so a device\'s own claims cannot reach a policy ' +
      'comparison through any ordering mistake in the gate — there is no such field on the object to ' +
      'compare.'
  );
  say('');
  say(
    (res.downgrade.kept
      ? '**Malformed evidence is refused rather than treated as absent**, which is the cell that ' +
        'prevents a downgrade: under the permitting policy `unattested` admits with ' +
        `\`${res.downgrade.unattestedCode}\` and \`malformed\` refuses with ` +
        `\`${res.downgrade.malformedCode}\`. A device that could reach the unattested path by sending ` +
        'garbage would have found the widest permission in the system by making its evidence worse.'
      : '**Malformed and absent evidence are NOT kept apart under a permitting policy** — malformed ' +
        `${res.downgrade.malformedAdmitted ? 'admits' : 'refuses'} and unattested ` +
        `${res.downgrade.unattestedAdmitted ? 'admits' : 'refuses'}, so a device can change its ` +
        'treatment by corrupting its own evidence.')
  );
  say('');

  say(
    '**The separation, quantified.** ADR-021 §2.2 says attestation is evidence and never ' +
      'authorization. Here that is counted rather than asserted: every state crossed with every policy ' +
      'and three grant shapes. `full` grants both identities for the requested class, `other-class` ' +
      'grants both for a different class, `none` grants nothing:'
  );
  say('');
  const grantIds = ['full', 'other-class', 'none'];
  say(
    markdownTable(
      ['state', 'policy', ...grantIds.map((g) => `grant: ${g}`)],
      res.verdicts.flatMap((v) =>
        ['requires', 'permits'].map((p) => [
          `\`${v.state}\``,
          p,
          ...grantIds.map((g) => {
            const c = res.combos.find((x) => x.state === v.state && x.policy === p && x.grant === g);
            if (!c) return '—';
            if (c.outcome === 'threw') return '**THREW**';
            return c.admit ? `**admit** (\`${c.code}\`)` : `refuse (\`${c.code}\`)`;
          })
        ])
      )
    )
  );
  say('');
  const s = res.separation;
  say(
    `**${s.admitted} of ${s.total} combinations admit and ${s.refused} refuse**` +
      (s.threw ? `, and ${s.threw} threw` : ', and none threw') +
      '. ' +
      (s.attestedUngrantedAdmitted === 0
        ? `**Not one of the ${s.attestedUngranted} combinations carrying a valid attestation without a ` +
          `covering grant is admitted**, and every one of them refuses with ` +
          s.ungrantedCodes.map((c) => `\`${c}\``).join(' or ') +
          ' — the capability code, not a measurement or an epoch code, so the refusal is the capability ' +
          'rule and not another rule reaching the same answer first.'
        : `**${s.attestedUngrantedAdmitted} of ${s.attestedUngranted} combinations carrying a valid ` +
          'attestation without a covering grant were ADMITTED. That is the exact failure ADR-021 §2.2 ' +
          'forbids.**') +
      ` And the control: the same attested verdict with the grant restored is admitted in ` +
      `${s.controlAdmitted} of ${s.controlTotal} cases. Without that column the refusals above could ` +
      'have been caused by anything at all.'
  );
  say('');
  say(
    'The admitting combinations, in full: ' +
      (s.admittedCombinations.length
        ? s.admittedCombinations
            .map((c) => `\`${c.state}\` + ${c.policy} + ${c.grant} → \`${c.code}\``)
            .join('; ')
        : 'none') +
      '. Two states admit and no others, and both of them go through the capability check to get there ' +
      '— `unattested` included, because a sender that does not require attestation has relaxed its ' +
      'evidence bar and not its authority model.'
  );
  say('');
  say(
    '**Which identity the grant was matched against**, read back off the decision rather than assumed. ' +
      'ADR-021 §2.3 is explicit that the two are not equivalent — an attested device id is a claim the ' +
      'device made about itself and had checked, a pinned peer id rests on a key that still lives in ' +
      '`localStorage` — so the decision and the receipt name which was used instead of letting them ' +
      'read alike:'
  );
  say('');
  say(
    markdownTable(
      ['admitting path', 'subject matched', 'identity source', 'receipt: sender required attestation', 'receipt summary'],
      res.identity.map((i) => [
        `\`${i.state}\` under a policy that ${i.policy === 'requires' ? 'requires' : 'permits'}`,
        `\`${i.subject}\``,
        `**${i.identitySource}**`,
        String(i.receiptSenderRequired),
        i.receiptSummary
      ])
    )
  );
  say('');
  const pi = res.peerIgnoredWhenAttested;
  say(
    '**On the attested path the peer id is not read at all**, which is worth stating because it decides ' +
      'what a malformed-peer test can measure: an attested verdict with `peerId` absent is ' +
      `${pi.absentAdmitted ? 'admitted' : 'refused'} and one with \`peerId: '../../etc'\` is ` +
      `${pi.hostileAdmitted ? 'admitted' : 'refused'}, both matched against \`${pi.absentSubject}\` by ` +
      `**${pi.absentIdentitySource}**. Corrupting a field nobody reads measures nothing, so the two ` +
      'peer cases in the fail-closed table below run against the *unattested* verdict, where the peer ' +
      'id is the only identity there is.'
  );
  say('');

  const c = res.coverage;
  say(
    `**Fail-closed coverage.** ${c.total} malformed or under-specified inputs — absent fields, wrong ` +
      'types, oversized fields, states that do not exist, verdicts a caller fabricated, and policies ' +
      'that declared nothing. Three outcomes are counted and not two, because a security path that ' +
      'throws is as broken as one that admits:'
  );
  say('');
  say(
    markdownTable(
      ['group', 'cases', 'refused under both policies', 'admitted', 'threw'],
      ['malformed evidence', 'fabricated verdict', 'policy or request shape'].map((group) => {
        const rows = res.failClosed.filter((r) => r.group === group);
        const ref = rows.filter((r) => r.strictOutcome === 'refused' && r.laxOutcome === 'refused');
        const adm = rows.filter((r) => r.strictOutcome === 'admitted' || r.laxOutcome === 'admitted');
        const thr = rows.filter((r) => r.strictOutcome === 'threw' || r.laxOutcome === 'threw' || r.parseThrew || r.verifyThrew);
        return [
          group,
          String(rows.length),
          `${ref.length} (${fmt((ref.length / rows.length) * 100, 1)}%)`,
          adm.length ? `**${adm.length}**` : '0',
          thr.length ? `**${thr.length}**` : '0'
        ];
      })
    )
  );
  say('');
  say(
    `**${c.refusedUnderBoth} of ${c.total} malformed inputs — ${fmt(c.fraction * 100, 1)}% — produce a ` +
      'refusal rather than a throw or an admission.** ' +
      (c.admitted
        ? `**${c.admitted} ${c.admitted === 1 ? 'was' : 'were'} admitted: ${c.admittedNames.join(', ')}` +
          ' — dealt with below rather than left in a percentage.**'
        : 'None was admitted.') +
      ' ' +
      (c.threw ? `**${c.threw} threw: ${c.threwNames.join(', ')}.**` : 'None threw.') +
      ' `parseEvidence` is documented never to throw on hostile input; over these cases it ' +
      `${c.parseNeverThrew ? 'never did' : '**did**'}, and it accepted ` +
      `${c.parseAlwaysRefused ? 'none of them' : '**at least one**'}. Every malformed blob landed on ` +
      `\`malformed\`${c.allMalformedState ? '' : ' **except at least one, which did not**'} rather than ` +
      'on `unattested`.'
  );
  say('');
  const fa = res.fabricatedAttested;
  say(
    '**The one admission, and it is the most interesting result in this section.** A verdict object a ' +
      'caller wrote by hand — `state: "attested"` with every measured fact filled in and ' +
      `\`chainVerified: ${JSON.stringify(fa.chainVerifiedOnAdmittedVerdict)}\` — is ` +
      (fa.withFactsAdmitted
        ? `**admitted**, with code \`${fa.withFactsCode}\`. `
        : `refused with \`${fa.withFactsCode}\`. `) +
      'The same fabrication *without* the facts is ' +
      (fa.withoutFactsAdmitted
        ? 'also admitted, so the barrier does no work at all here.'
        : `refused with \`${fa.withoutFactsCode}\`, which is where the structural barrier does its ` +
          'work: the four preconditions read facts that are not there and report them unmet, so a ' +
          'caller who copied only the state field gets nothing.')
  );
  say('');
  say(
    'That pair is the exact boundary of the claim `attest.js` makes for itself, and the claim survives ' +
      'it. The gate cannot be fed raw **claims** — the verifier publishes a measurement only on ' +
      '`attested`, so no ordering mistake inside `admitTransfer` can reach one, which is what its ' +
      'docblock says and what the state matrix above confirms. What the gate cannot do is tell a ' +
      'verdict its verifier produced from an object someone constructed: nothing on a verdict is ' +
      'authenticated, and there is no field on it that could be. ' +
      `\`chainVerified: ${JSON.stringify(fa.chainVerifiedOnAdmittedVerdict)}\` beside ` +
      '`state: "attested"` is a pair the real verifier can never emit — it sets `chainVerified: true` ' +
      'on exactly that state — and the gate does not check the pairing. ' +
      (fa.receiptChainVerified === null
        ? '**And the receipt records the inconsistency rather than hiding it**: `chainVerified` comes ' +
          'through as `null` on an admitted transfer, so an auditor reading the receipt can see that ' +
          'nothing verified a chain even though the decision says attested-and-approved.'
        : '**The receipt does not surface the inconsistency**, so the admission is not detectable after ' +
          'the fact either.') +
      ' This is a property of the trust boundary rather than a defect inside it — `admitTransfer` is ' +
      'documented as taking a verdict and nothing else — but it is the property a caller most needs to ' +
      'know, and it is the reason the verifier and the gate have to be reached through one code path ' +
      'rather than two.'
  );
  say('');
  const pendingRows = res.failClosed.filter((r) => r.strictCode === 'pending');
  say(
    'One distinction in that group is easy to miss and matters to a caller: a **falsy** state — `\'\'`, ' +
      `and a verdict with no state field at all — is refused as \`pending\` rather than as ` +
      `\`unknown-attestation-state\`, because the gate's first test is \`!verdict.state\`. ` +
      `${pendingRows.length} of the fabricated verdicts land there. Both codes refuse, so nothing is ` +
      'admitted either way, but they mean opposite things to a caller acting on the code: `pending` ' +
      'invites a retry when the check completes and `unknown-attestation-state` is final.'
  );
  say('');
  say(
    '**An undeclared policy is refused by design, and that is the rule most likely to be mistaken for ' +
      'a bug.** ADR-021 §2.3 makes whether an unattested device is acceptable the sender\'s decision ' +
      `"not a default", so a policy that has not said is refused with \`policy-undeclared\` — which ` +
      `happened for ${c.undeclaredRefused.length} of the policy-shape cases here: ` +
      c.undeclaredRefused.join(', ') +
      '. Both truthy-but-not-`true` spellings are in that list, which is the shape a policy loaded ' +
      'from JSON or a form field arrives in.'
  );
  say('');
  say(
    markdownTable(
      ['group', 'case', 'what it is', 'state reached', 'requiring policy', 'permitting policy'],
      res.failClosed.map((r) => [
        r.group,
        r.name,
        r.what,
        r.state ? `\`${r.state}\`` : '—',
        r.strictOutcome === 'refused' ? `refuse (\`${r.strictCode}\`)` : `**${r.strictOutcome.toUpperCase()}**`,
        r.laxOutcome === 'refused' ? `refuse (\`${r.laxCode}\`)` : `**${r.laxOutcome.toUpperCase()}**`
      ])
    )
  );
  say('');
  say(
    '**A chain verifier that fails is a check that did not happen.** Injecting one that throws yields ' +
      `\`${res.verifierFailure.state}\`` +
      (res.verifierFailure.isRefusingState
        ? ' — a refusing state, never `unattested` and never a pass. That distinction is the whole of ' +
          'the difference between an error and a feature being off, and it is the defect ADR-035 §2.2 ' +
          'records one layer down.'
        : ' — **which is not the refusing state it should be.**') +
      ' A verifier returning something that is neither `true` nor `false` is treated the same way: ' +
      res.oddVerifier.map((o) => `\`${o.answer}\` → \`${o.state}\``).join(', ') +
      `, ${res.oddVerifier.every((o) => o.refusing) ? 'all of them refusing' : '**not all of them refusing**'}.`
  );
  say('');
  const n = res.oversizedNonceList;
  say(
    `**The consumed-nonce ceiling is a correctness boundary, not only a cost one.** The list is capped ` +
      `at ${n.ceiling.toLocaleString('en-US')} entries and sliced, so a nonce past the cut is a nonce ` +
      `the replay check never sees: the same challenge yields \`${n.pastTheCutState}\` when it sits past ` +
      `the ceiling and \`${n.withinTheCutState}\` when it sits inside it. ` +
      (n.cutIsVisible
        ? '**A sender that lets its consumed list grow past the ceiling stops detecting replays of ' +
          'anything it consumed early**, which is a property of the bound rather than a defect in it — ' +
          'but it is a property a caller has to know, and the module does not say it.'
        : 'The two agree, so the ceiling is not observable here.')
  );
  say('');

  const k = res.cost;
  say(
    `**What deciding costs.** Per-call figures are the mean within a batch of ${k.batch.toLocaleString('en-US')} ` +
      `calls and the median across ${k.reps} batches — batched because these run in single-digit ` +
      'microseconds and a clock read costs tens of nanoseconds, so timing one call at a time would fold ' +
      'timer overhead into every figure:'
  );
  say('');
  say(
    markdownTable(
      ['function', 'p50', 'p95', 'min', 'max'],
      [
        ['`parseEvidence` (well-formed)', k.parseEvidence],
        ['`verifyAttestation` → attested (stub verifier)', k.verifyAttested],
        ['`verifyAttestation` → unattested (no evidence)', k.verifyUnattested],
        ['`admitTransfer` (attested, four preconditions, grant table)', k.admitTransfer],
        ['`attestationReceipt`', k.attestationReceipt]
      ].map(([label, st]) => [
        label,
        `${fmt(st.p50, 3)} µs`,
        `${fmt(st.p95, 3)} µs`,
        `${fmt(st.min, 3)} µs`,
        `${fmt(st.max, 3)} µs`
      ])
    )
  );
  say('');
  // One anchor, and a round one, so the claim is checkable by hand. This suite
  // measures no transfer, so quoting a transfer range from another suite here
  // would be borrowing a number the harness cannot produce at this point in the
  // run; the report's own transfer sections supply the range around this anchor.
  const anchorSeconds = 1;
  const orders = Math.floor(Math.log10(anchorSeconds / (k.perTransferUs / 1e6)));
  say(
    `One transfer pays all three once: **${fmt(k.perTransferUs, 2)} µs**, which is ` +
      `${Math.round(k.decisionsPerFramePeriod).toLocaleString('en-US')} decisions inside a single ` +
      `${k.framePeriodMs} ms frame period at the app's default 5 fps. Against a transfer of ` +
      `${anchorSeconds} second the gate is **${orders} orders of magnitude cheaper than the transfer ` +
      'it gates**, and every real transfer is longer than that, so the ratio only grows. That is the ' +
      'claim these numbers support; "negligible" on its own is not. The 5 fps is a configured constant ' +
      'of this application and not a measurement, and the microseconds are of this machine and this ' +
      'run — the `--quick` batch size moves them by a factor of three.'
  );
  say('');
  say(
    '**What this suite does not establish.** It says nothing about DICE, TPM 2.0, Secure Enclave or ' +
      'Android hardware-backed keys, because it runs none of them and neither does anything else in ' +
      'this repository. It says nothing about whether a real device would produce evidence this format ' +
      'can carry. Binding is checked here as a field comparison, exactly as the module checks it — in a ' +
      'real root of trust the nonce is inside the signed quote, so binding and chain verification are ' +
      'one check and not two, and that is precisely the part that is unexercised. What the tables above ' +
      'establish is narrower and worth having on its own: that the decision procedure refuses in every ' +
      'state it should, that no evidence buys an ungranted transfer, and that it costs microseconds.'
  );
  say('');
}

function pct(x, digits = 2) {
  return `${fmt(x * 100, digits)}%`;
}

function printClosureModuleSuite(res, backends) {
  say('### Progressive activation: what four signed closures cost — `artifacts/closure.js`');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }

  const k = res.constants;
  say(
    '**This is not the closure suite above it.** `--suite closures` is a model of how long a split ' +
      'artifact takes to *arrive* and runs no module. This is `--suite closure`, which drives ' +
      `\`artifacts/closure.js\` end to end — \`beginActivation\` → \`offerClosure\` ×n → \`completion\` → ` +
      '`activationReceipt` — with `opts.digest` wired to `crypto.sha256` and `opts.verifySignature` wired ' +
      'to `crypto.verifySync`. Every signature below was produced by ' +
      `${res.signatureName} and verified by it; every digest is ${res.digestName}. Two suites whose ` +
      'selectors differ by one letter is a trap, so it is stated here rather than left to be discovered.'
  );
  say('');
  say(
    'This exists for **ADR-022 acceptance criterion 7**: *"Signature and closure overhead is reported in ' +
      '`bench/` as a fraction of the artifact, since on small artifacts it may exceed the payload."* ' +
      'That sentence says **may**, so what follows measures whether it does, by how much, and at what ' +
      'size it stops.'
  );
  say('');
  say(
    `**Two signature regimes, and they are never mixed in one number.** Ed25519 at ` +
      `${k.ed25519SignatureBytes} B is what this repository has and every Ed25519 figure below is ` +
      `MEASURED. ADR-012's hybrid at ${k.hybridPerClosure.toLocaleString('en-US')} B per closure ` +
      `(ML-DSA-65's ${k.mldsa65SignatureBytes.toLocaleString('en-US')} plus Ed25519's ` +
      `${k.ed25519SignatureBytes}) is an **arithmetic PROJECTION** — there is no ML-DSA-65 anywhere in ` +
      'this repository, nothing here has produced or verified one, and ADR-022 §4.5 is explicit that an ' +
      'Ed25519 measurement presented as a hybrid result "would flatter the result". So the hybrid column ' +
      'carries byte counts and no milliseconds: a projected size is arithmetic, a projected time would ' +
      'be an invention.'
  );
  say('');

  const absent = res.unimplemented.filter((u) => u.status === 'absent');
  const injected = res.unimplemented.filter((u) => u.status === 'injected-absent');
  say(
    `**What the module says about itself.** \`describeUnimplemented()\` is read out of the running ` +
      `module rather than restated here, and reports **${absent.length} things absent** — ` +
      absent.map((u) => `\`${u.id}\``).join(', ') +
      ` — and **${injected.length} injected and absent by default** — ` +
      injected.map((u) => `\`${u.id}\``).join(', ') +
      '. The first list is why **criterion 5 is unmeetable here**: there is no radio tier, no QUIC and ' +
      'no radio transport, so "under 3 s at p95 on the radio tier" is not measured below and no p95 is ' +
      'quoted for it. Simulating a radio and reporting the result as observed would be the dishonest ' +
      'option and is not taken.'
  );
  say('');

  // --- the ladder ------------------------------------------------------------
  const L = res.ladder;
  say(
    `**The overhead ladder.** Real four-closure artifacts, built and activated to \`complete\` before ` +
      'each row is reported — an overhead row for a split the gate would refuse is a row about nothing, ' +
      'and the failure is quiet. Closure 1 is the manifest and carries no artifact content, so the ' +
      'artifact itself lives in closures 2–4, split ' +
      `${Math.round(res.split.runtime * 100)}/${Math.round(res.split.code * 100)}/` +
      `${Math.round(res.split.cold * 100)}% across runtime, code and cold. **Digest bytes are a subset ` +
      'of manifest bytes, not an addition to them.**'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'source', 'content B', 'manifest B', 'of which digest', 'signature B (Ed25519)', 'overhead B', 'overhead / artifact', 'exceeds payload?', 'activated?'],
      L.rows.map((r) => [
        r.label,
        r.source,
        r.contentBytes.toLocaleString('en-US'),
        String(r.manifestBytes),
        String(r.digestBytes),
        String(r.ed25519SignatureBytes),
        r.ed25519OverheadBytes.toLocaleString('en-US'),
        `**${pct(r.ed25519Fraction)}**`,
        r.ed25519ExceedsPayload ? '**yes**' : 'no',
        r.verified ? 'complete' : '**NO**'
      ])
    )
  );
  say('');
  const exceeding = L.rows.filter((r) => r.ed25519ExceedsPayload);
  const manifestSpread = [Math.min(...L.rows.map((r) => r.manifestBytes)), Math.max(...L.rows.map((r) => r.manifestBytes))];
  say(
    `**The criterion's "may" is a yes, and the reason is that overhead barely moves.** Across a ` +
      `${(L.rows[L.rows.length - 1].bytes / L.rows[0].bytes).toLocaleString('en-US', { maximumFractionDigits: 0 })}× ` +
      `range of artifact size the manifest moves from ${manifestSpread[0]} B to ${manifestSpread[1]} B — ` +
      `${manifestSpread[1] - manifestSpread[0]} bytes, entirely the decimal digits of \`originalSize\` — ` +
      `and the signature total does not move at all, because it is one signature per closure and there ` +
      `are always four. So overhead is very nearly a **constant ` +
      `${L.rows[0].ed25519OverheadBytes.toLocaleString('en-US')}–` +
      `${L.rows[L.rows.length - 1].ed25519OverheadBytes.toLocaleString('en-US')} B**, and the fraction is ` +
      `the artifact size doing all the work. ${exceeding.length} of ${L.rows.length} rows have overhead ` +
      `exceeding the payload` +
      (exceeding.length
        ? ` — the worst is ${exceeding[0].label} at **${pct(exceeding[0].ed25519Fraction, 0)} of the ` +
          `artifact**, which is ${fmt(exceeding[0].ed25519Fraction, 1)}× more signature and manifest than ` +
          'content.'
        : '.')
  );
  say('');

  say(
    '**The same ladder under ADR-012 hybrid signing. Every figure in this table is an arithmetic ' +
      'PROJECTION over ADR-022 §3\'s own 3,309 bytes per ML-DSA-65 signature, and nothing in this ' +
      'repository has produced, verified or timed one.** The manifest column is unchanged and measured: ' +
      'a hybrid scheme changes what signs a closure, not what the manifest says about it.'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'content B', 'manifest B (measured)', 'signature B (projected)', 'overhead B (projected)', 'overhead / artifact (projected)', 'exceeds payload?'],
      L.rows.map((r) => [
        r.label,
        r.contentBytes.toLocaleString('en-US'),
        String(r.manifestBytes),
        r.hybridSignatureBytes.toLocaleString('en-US'),
        r.hybridOverheadBytes.toLocaleString('en-US'),
        `**${pct(r.hybridFraction)}**`,
        r.hybridExceedsPayload ? '**yes**' : 'no'
      ])
    )
  );
  say('');

  // --- crossover -------------------------------------------------------------
  const cross = (id) => res.crossovers.find((c) => c.regime === id);
  const ed = cross('ed25519');
  const edWire = cross('ed25519-wire');
  const hy = cross('hybrid');
  say(
    '**The crossover, found by bisection over real builds rather than read off the ladder.** The ' +
      'ladder\'s rungs are powers of two and the answer is not, so quoting the first rung that clears ' +
      'would report a bound as though it were the crossing:'
  );
  say('');
  say(
    markdownTable(
      ['signature regime', 'per closure', 'overhead exceeds payload at or below', 'first size where it does not', 'measured or projected'],
      [
        [
          'Ed25519, raw bytes',
          `${k.ed25519SignatureBytes} B`,
          `**${ed.lastExceeding.toLocaleString('en-US')} B**`,
          `**${ed.crossover.toLocaleString('en-US')} B**`,
          'measured'
        ],
        [
          'Ed25519, as this module puts it on a wire (hex)',
          `${k.ed25519SignatureBytes * 2} B`,
          `${edWire.lastExceeding.toLocaleString('en-US')} B`,
          `**${edWire.crossover.toLocaleString('en-US')} B**`,
          'measured'
        ],
        [
          'ADR-012 hybrid, raw bytes',
          `${k.hybridPerClosure.toLocaleString('en-US')} B`,
          `${hy.lastExceeding.toLocaleString('en-US')} B`,
          `**${hy.crossover.toLocaleString('en-US')} B**`,
          '**projection**'
        ]
      ]
    )
  );
  say('');
  say(
    `**An artifact below ${ed.crossover.toLocaleString('en-US')} bytes costs more to describe than to ` +
      `carry**, with the signatures this repository actually has. Under ADR-012's hybrid signing that ` +
      `figure becomes ${hy.crossover.toLocaleString('en-US')} bytes — a **projection**, ` +
      `${fmt(hy.crossover / ed.crossover, 1)}× further out — so the whole of this repository's demo ` +
      'container sits inside the region where the signatures outweigh the artifact. The middle row is ' +
      'not a third scheme: `parseOffer` requires `signature` to be a run of lowercase hex, so a ' +
      `${k.ed25519SignatureBytes}-byte signature occupies ${k.ed25519SignatureBytes * 2} bytes as ` +
      'offered, and this module\'s own encoding moves its own crossover by ' +
      `${(edWire.crossover - ed.crossover).toLocaleString('en-US')} bytes. ADR-022 does its arithmetic ` +
      'in raw bytes, so the raw row is the one comparable to the ADR and the hex row is the one ' +
      'comparable to a wire.'
  );
  say('');

  // --- the worked example ----------------------------------------------------
  const ex = res.example;
  say(
    `**Per closure, worked through on ${ex.name} (${ex.bytes.toLocaleString('en-US')} B)**, so the ` +
      'totals above can be checked by hand rather than inferred:'
  );
  say('');
  say(
    markdownTable(
      ['closure', 'role', 'in the activation set?', 'body B', 'digest B', 'digest sits', 'signature B (Ed25519, raw)', 'signature B (as offered, hex)', 'signature B (hybrid, projected)'],
      ex.closures.map((c) => [
        String(c.index),
        `\`${c.role}\``,
        c.activation ? 'yes' : 'no — cold',
        c.contentBytes.toLocaleString('en-US'),
        String(c.digestHexBytes),
        c.digestOnWire ? 'in the manifest' : '**in the pinned root**',
        String(c.signatureRawBytes),
        String(c.signatureHexBytes),
        c.hybridSignatureProjectedBytes.toLocaleString('en-US')
      ])
    )
  );
  say('');
  say(
    '**"Body" is not "content".** Closure 1\'s body is the manifest, which is overhead in the ladder ' +
      'above and is not part of the artifact; the artifact is closures 2–4. Both are digested and both ' +
      'are signed, which is why the verification table below counts all four and the overhead table ' +
      'counts three.'
  );
  say('');
  say(
    '**Closure 1\'s digest is not on the wire and the other three are**, which is the sort of off-by-one ' +
      'that turns a byte count into a wrong byte count. A manifest cannot contain its own digest, so the ' +
      'chain is: the pinned root commits closure 1 out of band, and closure 1 commits closures 2–4. A ' +
      'four-closure artifact therefore carries **three** digests in its manifest and pays **four** ' +
      `signatures. The receipt for this activation reads *"${ex.receipt ? ex.receipt.summary : '—'}"*.`
  );
  say('');

  // --- verification cost -----------------------------------------------------
  const V = res.verification;
  say(
    '**What verification costs, which is the number behind the "start sooner" claim.** Each closure is ' +
      `timed through the shipped \`offerClosure\` path, median of ${V.reps} runs, from a session that ` +
      'already holds everything before it — so closure 3\'s figure is the cost of closure 3 and not the ' +
      'cost of replaying 1 and 2:'
  );
  say('');
  say(
    markdownTable(
      ['artifact', 'bytes', 'closures 1–3', 'whole artifact', '**share of verification in 1–3**', 'share of bodies in 1–3', 'digest total', 'signature total', 'unattributed'],
      V.rows.filter((r) => !r.error).map((r) => [
        r.name,
        r.bytes.toLocaleString('en-US'),
        `${fmt(r.activationMs, 2)} ms`,
        `${fmt(r.wholeMs, 2)} ms`,
        `**${pct(r.activationShare, 1)}**`,
        pct(r.activationByteShare, 1),
        `${fmt(r.digestMs, 2)} ms`,
        `${fmt(r.signatureVerifyMs, 2)} ms`,
        `${r.moduleResidueMs >= 0 ? '+' : '−'}${fmt(Math.abs(r.moduleResidueMs), 2)} ms`
      ])
    )
  );
  say('');
  const p = V.primitives;
  const spread = V.rows.filter((r) => !r.error);
  const shareRange = spread.length
    ? [Math.min(...spread.map((r) => r.activationShare)), Math.max(...spread.map((r) => r.activationShare))]
    : [NaN, NaN];
  say(
    `**Closures 1–3 are ${pct(shareRange[0], 0)}–${pct(shareRange[1], 0)} of the verification work at ` +
      `every artifact size measured, and that is not because they are most of the bytes.** They are ` +
      'three of four signature checks, and a signature check does not care how large the closure is. ' +
      `SHA-256 costs ${fmt(p.sha256PerKiB * 1000, 2)} µs per KiB here; one Ed25519 verification costs ` +
      `**${fmt(p.ed25519Verify, 2)} ms**, which is the same as digesting ` +
      `${Math.round(p.ed25519Verify / p.sha256PerKiB).toLocaleString('en-US')} KiB. So on the ` +
      `${spread.length ? spread[spread.length - 1].bytes.toLocaleString('en-US') : '—'} B artifact the ` +
      'entire content digest is a minority of the cost and four signatures are the rest, and the share ' +
      'in closures 1–3 stays near three quarters however the artifact is split.'
  );
  say('');
  say(
    '**The unattributed column is a residue and its SIGN IS NOT MEANINGFUL.** It is the offer time minus ' +
      'two quantities measured in separate loops, each a median of a millisecond-scale operation, so a ' +
      'few percent of run-to-run drift in either lands there and it comes out negative as readily as ' +
      'positive — ' +
      (spread.some((r) => r.moduleResidueMs < 0)
        ? 'and it does, in the table above. '
        : 'in this run every row above happens to be positive, which is luck rather than a result. ') +
      `At |${spread.length ? fmt(Math.max(...spread.map((r) => Math.abs(r.moduleResidueMs))), 2) : '—'}| ms ` +
      'against a 5 ms signature check, what it establishes is that the module\'s own work — parsing, ' +
      'ordering, copying, freezing — is **inside the measurement noise of the cryptography**, not that it ' +
      'is negative. These are figures about cryptography rather than about JavaScript, and a reader who ' +
      'wants the module\'s own cost separated from Ed25519\'s will not get it from this harness.'
  );
  say('');
  say(
    `**Splitting therefore multiplies verification work by the closure count.** An unsplit artifact pays ` +
      `one signature check; four closures pay four, which is ` +
      `**+${fmt(3 * p.ed25519Verify, 2)} ms** of verification bought in exchange for starting before the ` +
      'cold state arrives — arithmetic over the measured per-verification figure above. Against the ' +
      'transfer times suite 10 models, that is a trade worth making by a wide margin; it is not free, ' +
      'and ADR-022 does not mention it.'
  );
  say('');

  if (backends && backends.available) {
    const b = backends;
    say(
      '**And the module\'s synchronous contract picks the slow verifier.** `verifyClosure` compares its ' +
        'verifier\'s answer against `true`, so an asynchronous verifier returns a promise, a promise is ' +
        `not \`true\`, and the closure is refused as \`unverified\` — measured: injecting one yields ` +
        `state \`${res.asyncInjection.state}\` and \`admit: ${res.asyncInjection.admitted}\`. That is the ` +
        'right failure mode and it is also a constraint on what may be injected, because `crypto.verify` ' +
        'is asynchronous precisely so it can reach WebCrypto and `crypto.verifySync` is the pure-JS path ' +
        'by definition:'
    );
    say('');
    say(
      markdownTable(
        ['Ed25519 verification', 'p50', 'p95', 'injectable into `closure.js`?'],
        [
          [`\`verifySync\` (pure JS)`, `${fmt(b.syncMs.p50, 3)} ms`, `${fmt(b.syncMs.p95, 3)} ms`, '**yes — this is what is measured above**'],
          b.asyncMs
            ? [`\`verify\` (WebCrypto \`subtle\`)`, `${fmt(b.asyncMs.p50, 3)} ms`, `${fmt(b.asyncMs.p95, 3)} ms`, '**no** — asynchronous, so the gate refuses']
            : ['`verify` (WebCrypto `subtle`)', 'unavailable', '—', 'no']
        ]
      )
    );
    say('');
    if (b.asyncMs && b.ratio) {
      say(
        `**The synchronous contract costs ${fmt(b.ratio, 0)}× on this platform** — ` +
          `${fmt(b.syncMs.p50, 2)} ms against ${fmt(b.asyncMs.p50, 3)} ms for the same key, message and ` +
          'signature. The WebCrypto row is **not a figure for this module**: nothing can inject it, and ' +
          'it is here only to turn "the sync contract costs something" into a number. Every verification ' +
          'millisecond in the tables above is the pure-JS path, because that is the only path the gate ' +
          'accepts.'
      );
      say('');
    }
  }

  // --- the optical verdict ---------------------------------------------------
  const O = res.optical;
  const R = O.rederived;
  say(
    '**The optical verdict — ADR-022 §4.6, which asks for the answer "including *not achievable at this ' +
      'artifact size* where that is the answer".** `opticalBudget()` computes it; this suite recomputes ' +
      'it independently from the module\'s exported constants and compares, because two calculations ' +
      `agreeing is worth more than one reported twice. They ${O.agrees ? '**agree**' : '**DISAGREE**'}:`
  );
  say('');
  say(
    markdownTable(
      ['', 'Ed25519 (measured signature size)', 'ADR-012 hybrid (**projection**)'],
      [
        ['rate', `${R.rateBytesPerSecond.toLocaleString('en-US')} B/s (measured, §6)`, `${R.rateBytesPerSecond.toLocaleString('en-US')} B/s (measured, §6)`],
        ['budget at 3 s', `${R.budgetBytes.toLocaleString('en-US')} B`, `${R.budgetBytes.toLocaleString('en-US')} B`],
        ['closures in the activation set', String(R.closures), String(R.closures)],
        ['signature per closure', `${k.ed25519SignatureBytes} B`, `${R.hybridPerClosure.toLocaleString('en-US')} B`],
        ['**signature floor**', `**${R.ed25519FloorBytes.toLocaleString('en-US')} B**`, `**${R.hybridFloorBytes.toLocaleString('en-US')} B**`],
        ['room left for content', `${R.ed25519ContentBytes.toLocaleString('en-US')} B`, `**${R.hybridContentBytes.toLocaleString('en-US')} B**`],
        ['achievable?', R.ed25519Achievable ? 'yes' : '**no**', R.hybridAchievable ? 'yes' : '**NO**']
      ]
    )
  );
  say('');
  say(
    `**Under ADR-012's hybrid signing the three-second optical target fails before a single content ` +
      `byte is considered.** ${R.closures} closures × ${R.hybridPerClosure.toLocaleString('en-US')} B is ` +
      `**${R.hybridFloorBytes.toLocaleString('en-US')} B of signature** against a whole budget of ` +
      `${R.budgetBytes.toLocaleString('en-US')} B — the floor exceeds the budget by ` +
      `**${pct(R.hybridOvershoot - 1, 0)}**. Content is what is left *after* the floor, so no artifact ` +
      'size helps: the answer ADR-022 §4.6 anticipates is "not achievable at this artifact size" and the ' +
      `honest answer is the stronger **"not achievable at any artifact size"**. Swept across ` +
      `${O.sweep.length} artifact sizes from ${O.sweep[0].artifactBytes.toLocaleString('en-US')} B to ` +
      `${O.sweep[O.sweep.length - 1].artifactBytes.toLocaleString('en-US')} B, ` +
      `**${O.anySizeAchievableHybrid ? 'some' : 'none'} fits**. Every figure in the hybrid column is a ` +
      'projection over ADR-022 §3\'s own 3,309 bytes; the rate is measured and the multiplication is not ' +
      'a measurement of anything.'
  );
  say('');
  say(
    `To make the floor alone fit, the transfer would need **${fmt(R.secondsNeededForFloor, 2)} s** at the ` +
      `measured rate, or **${R.rateNeededForFloor.toLocaleString('en-US')} B/s** inside three seconds — ` +
      `${fmt(R.rateNeededForFloor / R.rateBytesPerSecond, 2)}× the optical channel, and that buys zero ` +
      'bytes of artifact. With Ed25519 the same budget has ' +
      `${R.ed25519ContentBytes.toLocaleString('en-US')} B to spare, which is why ADR-022 §4.5 insists the ` +
      'criterion-5 measurement be taken with hybrid signatures in place: the two schemes do not differ ' +
      'by a margin, they differ by whether the thing is possible. And on this module\'s own wire the ' +
      `hybrid floor is hex, so it is ${R.hybridFloorOnWireBytes.toLocaleString('en-US')} B — ` +
      `${fmt(R.hybridFloorOnWireBytes / R.budgetBytes, 2)}× the budget rather than ` +
      `${fmt(R.hybridOvershoot, 2)}×.`
  );
  say('');

  // --- what this does not establish -----------------------------------------
  say(
    '**What this suite does not establish.** It does not measure criterion 5 and cannot: there is no ' +
      'radio tier in this repository, so no p95 on one is quoted anywhere above. It does not measure ' +
      'ML-DSA-65 — every hybrid figure is arithmetic over a size ADR-022 states, and there is no ' +
      'post-quantum signature in this repository to time. It does not split an artifact: ADR-022 §3 says ' +
      'that tooling does not exist, so the splits here are this harness\'s, and a different split moves ' +
      'the content column while leaving the overhead column within a few bytes — which is precisely why ' +
      'the fraction, rather than the byte count, is the quantity the criterion asks for. And nothing ' +
      'here executes: "activated" means the gate opened and the bytes are readable, not that any code ' +
      'ran. What the tables do establish is narrower and is what criterion 7 asked for: overhead is ' +
      `essentially constant, it exceeds the payload below ${ed.crossover.toLocaleString('en-US')} B with ` +
      `the signatures this repository has and below ${hy.crossover.toLocaleString('en-US')} B under the ` +
      'scheme ADR-012 selects, and the activation set is three quarters of the verification work at ' +
      'every size measured.'
  );
  say('');
}

function printSwarmSuite(res) {
  say('### Fleet swarm distribution: what a swarm saves and what a hostile peer costs — `artifacts/swarm.js`');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }

  const cfg = res.config;
  const cm = res.costModel;

  // --- what kind of numbers these are, before any of them --------------------
  say(
    '**Every timing below is a SIMULATION TICK and measures nothing about any fleet.** `simulateSwarm()` ' +
      'says so from inside itself — `simulation: true`, `wallClockMeasured: false`, `physicalDevices: 0`, ' +
      '`timingUnit: "ticks"` — and this suite carries those four fields rather than paraphrasing them. ' +
      'A tick is a unit `swarm.js` defines; nothing in this repository has calibrated one against a ' +
      'device, a radio or a clock. The **byte counts and chunk counts are real measurements OF THE ' +
      'SIMULATION**: every chunk in every table went through the shipped verification pipeline on every ' +
      'simulated receiver.'
  );
  say('');
  say(
    `**ADR-024 §4.1 Fleet-10 and §4.2 Fleet-100 are NOT MET and are not approached here.** They require ` +
      `TEN and ONE HUNDRED PHYSICAL DEVICES against wall-clock gates of 3 s and 60 s. ` +
      '`describeCriteria()` marks both `requires-device-fleet` and `met: false`, read out of the running ' +
      'module below, and this suite reports them the same way. A hundred simulated receivers is not ' +
      'Fleet-100: heterogeneity — different radios, different thermal limits, different older roots — is ' +
      'most of what that criterion tests and is exactly what a simulation cannot supply. **No seconds ' +
      'are quoted anywhere in this section.**'
  );
  say('');
  say(
    `**The broadcast tier is \`${res.broadcastCodec}\`.** ADR-024 §2.1's third mechanism is not ` +
      'implemented here at all — nothing in this suite encodes or decodes a fountain symbol — and the ' +
      'codec string is reproduced verbatim from the module\'s single `BROADCAST_CODEC` constant so the ' +
      'qualification cannot be dropped in one place and kept in another. What IS measured below is the ' +
      'second mechanism only: content-addressed peer transfer.'
  );
  say('');

  const cc = res.crossCheck;
  say(
    `**The injected digest and signer are \`artifacts/swarm.test.js\`'s stand-ins, and they are NOT ` +
      `CRYPTOGRAPHY.** \`swarm.js\` takes \`digest\`, \`sign\` and \`verifySignature\` as injected ` +
      'functions and requires the digest to return lowercase hex; one that returns bytes fails every ' +
      'comparison, every chunk is refused, and the run reports well-formed zeroes that look like a ' +
      'result. So the test file\'s FNV-based digest is used for the sweeps — and then ' +
      (cc.available
        ? `one whole configuration (${cc.devices} devices) is run a second time with **${cc.digestName}** ` +
          `and **${cc.signatureName}** wired in, requiring the counted quantities to be identical. ` +
          `Across ${cc.fields.length} compared fields they ` +
          (cc.identical
            ? '**are identical**, so nothing in this section is a report about FNV.'
            : `**disagree on ${cc.disagreements.join(', ')}**, which invalidates the sweeps below.`) +
          ' Ed25519 is HALF of ADR-012\'s hybrid scheme; there is no ML-DSA-65 in this repository and no ' +
          'post-quantum signature was produced, verified or timed anywhere here.'
        : `the cross-check could not run: ${cc.reason}.`)
  );
  say('');

  // --- 1 and 4: source traffic, and what the peer tier saves -----------------
  const L = res.ladder;
  say(
    `**Source traffic against ADR-024 §2.1's target.** The ADR wants **under 3× the artifact** off the ` +
      'source link for 100 devices, against **up to 100× point-to-point**. The meter is the one ' +
      '`swarm.js` writes on the line the bytes leave the source, which is criterion 6\'s "measured ' +
      `directly, not inferred from chunk accounting". Artifact ${(cfg.chunkSize * cfg.chunkCount).toLocaleString('en-US')} B ` +
      `in ${cfg.chunkCount} chunks of ${cfg.chunkSize} B, seed ${cfg.seed}, one request in flight per ` +
      'receiver and one response in flight per provider.'
  );
  say('');
  say(
    markdownTable(
      ['devices (simulated)', 'source B measured', '**× artifact**', 'under 3×?', 'point-to-point B (projected)', 'saving', 'chunks from source', 'chunks from peers', 'peer share', 'ticks to last complete', 'ticks to first complete'],
      L.rows.map((r) => [
        String(r.devices),
        r.sourceBytesMeasured.toLocaleString('en-US'),
        `**${fmt(r.ratioToArtifact, 3)}×**`,
        r.withinThreeTimesTarget ? 'yes' : '**NO**',
        r.pointToPointBytesProjected.toLocaleString('en-US'),
        `${fmt(r.savingVsPointToPoint, 1)}×`,
        String(r.chunksFromSource),
        r.chunksFromPeers.toLocaleString('en-US'),
        pct(r.peerShare, 1),
        String(r.ticksToComplete),
        String(r.ticksToFirstDeviceComplete)
      ])
    )
  );
  say('');
  const top = L.rows[L.rows.length - 1];
  say(
    `**The 3× target is met IN SIMULATION at every fleet size measured, and at ${top.devices} devices the ` +
      `measured figure is ${fmt(top.ratioToArtifact, 3)}× the artifact** — ` +
      `${top.sourceBytesMeasured.toLocaleString('en-US')} B off the source link against ` +
      `${top.pointToPointBytesProjected.toLocaleString('en-US')} B for the same fleet point-to-point, a ` +
      `**${fmt(top.savingVsPointToPoint, 1)}× reduction**. That sentence has to carry its qualifier: **a ` +
      'simulation result is not a fleet result.** What has been established is that this scheduling ' +
      'policy, run against the real verification pipeline over real bytes, sends the source link ' +
      `${fmt(top.ratioToArtifact, 2)}× the artifact. What has not been established is anything about a ` +
      'hundred devices on a site, because there are none.'
  );
  say('');
  say(
    `**The point-to-point column is a PROJECTION, and a narrow one.** It is a measured single-device ` +
      `run — which served **${L.pointToPointPerDeviceBytesMeasured.toLocaleString('en-US')} B, exactly ` +
      `the artifact, ${L.soloServedExactlyTheArtifact ? 'checked rather than assumed' : '**which is NOT the artifact size — the baseline is padded**'}` +
      '** — multiplied by the fleet size. The peer tier cannot be switched off by configuration: a ' +
      'device advertises what it has verified and `advertise()` is derived from the store, so there is ' +
      'no flag to clear. The one-device run is the only honest "peers off" arm available, and it is also ' +
      'exactly the quantity ADR-024 §1 quotes — "a 100-device site taking a 1 GB image is up to 100 GB ' +
      'of source traffic" — which is what makes it the right comparison rather than merely the available ' +
      'one.'
  );
  say('');
  say(
    `**The mechanism, measured directly.** At ${top.devices} devices, ` +
      `${top.chunksFromPeers.toLocaleString('en-US')} of the ` +
      `${(top.chunksFromPeers + top.chunksFromSource).toLocaleString('en-US')} admitted chunks — ` +
      `**${pct(top.peerShare, 1)}** — came from another device rather than from the source. That is ` +
      '"a chunk a peer already holds is a chunk the source never sends" as a count rather than as a ' +
      'sentence. The source still sends more than one copy of the artifact ' +
      `(${fmt(top.ratioToArtifact, 3)}×, ${top.sourceResponses} responses for ${top.chunkCount} chunks) ` +
      'because early in the run nobody holds anything and the source is the only holder there is.'
  );
  say('');
  say(
    `**What chunk accounting would have claimed instead — and the module's own note overstates this.** ` +
      `Criterion 6 wants the link measured rather than inferred, and \`sourceTraffic()\`'s note says ` +
      'chunk accounting "understates the link by roughly the fleet size". **It does not, here, and the ' +
      `measurement is what says so.** At ${top.devices} devices the meter reads ` +
      `${top.sourceBytesMeasured.toLocaleString('en-US')} B and "distinct chunks served × chunk size" ` +
      `would have claimed ${top.bytesInferredFromChunkAccounting.toLocaleString('en-US')} B — an ` +
      `understatement of ${top.inferenceUnderstatesByBytes.toLocaleString('en-US')} B, only ` +
      `${fmt(top.sourceBytesMeasured / top.bytesInferredFromChunkAccounting, 2)}× low rather than ` +
      `${top.devices}× low. The inference saturates: every chunk is served at least once, so distinct ` +
      `chunks reach ${top.chunkCount} of ${top.chunkCount} and the inferred figure is pinned at exactly ` +
      'the artifact size no matter what the link did. The fleet-size error the note describes is the ' +
      'POINT-TO-POINT case, where the source serves every chunk to every device; **in a working swarm ' +
      'the inference is nearly right precisely because the swarm works.** That is an argument for ' +
      'measuring rather than inferring even so — the inference is bounded above by the artifact size and ' +
      'therefore can never report the overshoot the target is about — but the size of the error is ' +
      'small here and is reported as measured rather than as the module predicts.'
  );
  say('');

  // --- the ratio is not one number ------------------------------------------
  const S1 = res.seedSpread;
  say(
    `**One seed is one draw of a rarest-first schedule, so the top row is repeated under ` +
      `${S1.rows.length} seeds.** Ratio ${fmt(S1.minRatio, 3)}–${fmt(S1.maxRatio, 3)}×, ticks ` +
      `${S1.minTicks}–${S1.maxTicks}, and ${S1.allWithinTarget ? 'every seed stays under 3×' : '**not every seed stays under 3×**'}. ` +
      'The spread is small, which is worth showing rather than asserting.'
  );
  say('');
  say(
    markdownTable(
      ['seed', 'source B measured', '× artifact', 'ticks to last complete', 'peer share'],
      S1.rows.map((r) => [
        String(r.seed),
        r.sourceBytesMeasured.toLocaleString('en-US'),
        fmt(r.ratioToArtifact, 3),
        String(r.ticksToComplete),
        pct(r.peerShare, 1)
      ])
    )
  );
  say('');

  const shape = res.shapeSweep;
  say(
    `**The ratio tracks chunk COUNT, not artifact size, and that is what carries to ADR-024's own ` +
      `example.** The ADR's case is 100 devices × 1 GB; the artifacts here are kilobytes. What transfers ` +
      'between the two is granularity: a swarm trades chunks, and a fleet with more of them has more to ' +
      `trade. At ${S1.devices} devices the ratio falls monotonically from ` +
      `${fmt(shape[0].ratioToArtifact, 3)}× at ${shape[0].chunkCount} chunks to ` +
      `${fmt(shape[shape.length - 1].ratioToArtifact, 3)}× at ${shape[shape.length - 1].chunkCount}. A ` +
      '1 GB image chunked at any practical size has thousands, so the trend runs in the direction that ' +
      'helps — **which is a trend, not a measurement of a 1 GB transfer, and there is no such transfer ' +
      'here.**'
  );
  say('');
  say(
    markdownTable(
      ['chunks', 'artifact B', 'source B measured', '× artifact', 'peer share', 'ticks to last complete'],
      shape.map((r) => [
        String(r.chunkCount),
        r.artifactBytes.toLocaleString('en-US'),
        r.sourceBytesMeasured.toLocaleString('en-US'),
        fmt(r.ratioToArtifact, 3),
        pct(r.peerShare, 1),
        String(r.ticksToComplete)
      ])
    )
  );
  say('');

  const conc = res.concurrency;
  const oneOne = conc.find((c) => c.deviceSlots === 1 && c.peerSlots === 1);
  say(
    '**Concurrency moves the two quantities in opposite directions, and every other table on this page ' +
      'is the pessimistic corner of it.** `deviceSlots` is how many requests a receiver has outstanding; ' +
      '`peerSlots` is how many a device will serve. Giving receivers more requests without giving ' +
      'providers more responses finishes sooner AND costs the source more, because a receiver with two ' +
      'requests in flight finds peers busy and falls back to the source. This is a trade the ADR does ' +
      'not discuss; it is reported as measured and not as a recommendation.'
  );
  say('');
  say(
    markdownTable(
      ['deviceSlots', 'peerSlots', 'ticks to last complete', 'source B measured', '× artifact', 'peer share'],
      conc.map((r) => [
        String(r.deviceSlots),
        String(r.peerSlots),
        String(r.ticksToComplete),
        r.sourceBytesMeasured.toLocaleString('en-US'),
        fmt(r.ratioToArtifact, 3),
        pct(r.peerShare, 1)
      ])
    )
  );
  say('');

  // --- 2: the three behaviours ----------------------------------------------
  say(
    `**ADR-024 criterion 4: the three named behaviours, each with its effect on completion.** Each row ` +
      `is one adversarial seed peer added to the fleet, against ${cm.timeoutTicks} ticks per timeout, ` +
      `${cm.chunkTicks} tick per prompt delivery and ${cm.slowTicks} ticks per slow one — passed into ` +
      'the configuration by this suite rather than inherited from a default, so the tick columns can be ' +
      'read against the numbers that produced them.'
  );
  say('');
  say(
    '**Two comparators, and neither is "the" cost.** `baseline` is the same swarm with no extra peer at ' +
      'all, which is what `compareBehaviours()` returns — but adding ANY peer changes the holder counts ' +
      'a rarest-first scheduler sorts on, so that difference contains a reordering as well as an attack. ' +
      '`control` is the identical run with one extra **honest** peer in the same slot, holding the whole ' +
      'artifact from the start, which is exactly what each adversary claims to be. The control is not a ' +
      'noise floor — an honest seed really does supply bytes — so the difference against it is the ' +
      '**opportunity cost**: what the fleet lost by that slot holding a liar rather than the seeder it ' +
      'advertised itself as.'
  );
  say('');

  for (const b of res.behaviours) {
    say(
      `**${b.devices} simulated devices.** Baseline: ${b.baseline.ticksToComplete} ticks, ` +
        `${b.baseline.sourceBytesMeasured.toLocaleString('en-US')} B off the source. Control (one extra ` +
        `honest seed peer): ${b.control.ticksToComplete} ticks ` +
        `(${b.control.ticksVsBaseline >= 0 ? '+' : ''}${b.control.ticksVsBaseline} vs baseline), ` +
        `${b.control.sourceBytesMeasured.toLocaleString('en-US')} B ` +
        `(${b.control.sourceBytesVsBaseline >= 0 ? '+' : ''}${b.control.sourceBytesVsBaseline.toLocaleString('en-US')} B), ` +
        `serving ${b.control.accepted} chunks itself.`
    );
    say('');
    say(
      markdownTable(
        ['behaviour', 'completed?', 'ticks', 'Δ ticks vs baseline', 'Δ ticks vs control', 'source B', 'Δ source B vs control', 'chunks rejected', 'chunks timed out', 'bytes accepted from it', '**wrong chunks stored**'],
        b.rows.map((r) => [
          `\`${r.behaviour}\``,
          r.completed ? 'yes' : '**NO**',
          String(r.ticksToComplete),
          `${r.extraTicksVsBaseline >= 0 ? '+' : ''}${r.extraTicksVsBaseline}`,
          `${r.extraTicksVsControl >= 0 ? '+' : ''}${r.extraTicksVsControl}`,
          r.sourceBytesMeasured.toLocaleString('en-US'),
          `${r.extraSourceBytesVsControl >= 0 ? '+' : ''}${r.extraSourceBytesVsControl.toLocaleString('en-US')}`,
          String(r.chunksRejected),
          String(r.chunksTimedOut),
          r.bytesAcceptedFromAdversary.toLocaleString('en-US'),
          r.wrongChunksStored === 0 ? '**0**' : `**${r.wrongChunksStored}**`
        ])
      )
    );
    say('');
  }

  const big = res.behaviours[res.behaviours.length - 1];
  const bySlow = big.rows.find((r) => r.behaviour === 'slow-drip');
  const byHold = big.rows.find((r) => r.behaviour === 'advertise-and-withhold');
  const byBad = big.rows.find((r) => r.behaviour === 'corrupt-chunk');
  say(
    `**The zero that is the security claim is \`wrong chunks stored\`, and it is shown rather than ` +
      `asserted.** Every device's every stored chunk was re-digested after the run against the source's ` +
      `manifest, by \`auditReceivers()\` and independently of the path that stored it — ` +
      `${big.rows.map((r) => r.chunksAudited).reduce((a, x) => Math.max(a, x), 0).toLocaleString('en-US')} ` +
      `chunks at ${big.devices} devices — and every complete device's reassembled artifact was compared ` +
      `byte for byte against the source's. ` +
      (big.allWrongChunksZero && big.allReassembledCorrect
        ? '**Zero wrong chunks and zero wrong reassemblies under all three behaviours.**'
        : '**A wrong chunk or a wrong reassembly was recorded — see the table.**') +
      ' A test of the storage path that read the storage path\'s own bookkeeping would test nothing, ' +
      'which is why the audit re-derives the digests.'
  );
  say('');
  say(
    `**"Bytes accepted from it" is NOT required to be zero, and for slow-drip it is the whole ` +
      `artifact.** At ${big.devices} devices the slow peer contributed ` +
      `${bySlow.bytesAcceptedFromAdversary.toLocaleString('en-US')} B of accepted data while the ` +
      `withholder and the corrupter contributed ${byHold.bytesAcceptedFromAdversary} and ` +
      `${byBad.bytesAcceptedFromAdversary}. That is not a defect and the module names the field so it ` +
      'cannot be read as one: a slow peer\'s chunks digest to the value the signed manifest commits, so ' +
      'they were admitted **because they are the right bytes and not because of who sent them** — which ' +
      'is what "a peer is a transport, not an authority" means when it is working. ADR-024 §4.1\'s "one ' +
      'malicious peer contributes zero accepted data" is carried by `wrong chunks stored`, not by this ' +
      'column, and conflating the two would report a false claim in one direction and a false alarm in ' +
      'the other.'
  );
  say('');
  const signed = (n) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n}`);
  say(
    `**The ordering is not the intuitive one and it sharpens ADR-024 §2.2.** The cost of a behaviour ` +
      'tracks **how detectably wrong it is**, and slow-drip is never wrong at all. A corrupter is ' +
      'refused by one digest comparison and drops below the score floor on its first delivery; a ' +
      'withholder costs one timeout and then the same floor; a slow peer delivers correct, correctly ' +
      `digesting chunks, so nothing refuses it. At ${big.devices} devices slow-drip cost ` +
      `**${signed(bySlow.extraTicksVsControl)} ticks against the control** while corrupt-chunk cost ` +
      `**${signed(byBad.extraTicksVsControl)}** and advertise-and-withhold ` +
      `**${signed(byHold.extraTicksVsControl)}**. \`swarm.js\` deliberately does not refuse the slow ` +
      'peer: refusing a peer for being slow would refuse a device with a weak radio, which in a real ' +
      'fleet is the ordinary case rather than the attack.'
  );
  say('');
  // The two detectable behaviours produce tick differences of the same order as
  // the reordering the control itself produces, and at large fleets some of them
  // are negative. Reporting a negative as a cost, or a positive of the same
  // magnitude as an effect, would both be reading noise as signal.
  const reorder = Math.abs(big.control.ticksVsBaseline);
  const detectable = [byBad, byHold];
  const separable = detectable.every((r) => Math.abs(r.extraTicksVsControl) > reorder);
  say(
    `**And the tick cost of the two DETECTABLE behaviours is not separable from scheduling noise at ` +
      `this fleet size.** Merely adding an honest peer moves the run by ${reorder} ticks; ` +
      `corrupt-chunk and advertise-and-withhold move it by ` +
      `${detectable.map((r) => Math.abs(r.extraTicksVsControl)).join(' and ')} against that control and ` +
      `by ${detectable.map((r) => Math.abs(r.extraTicksVsBaseline)).join(' and ')} against the baseline` +
      (detectable.some((r) => r.extraTicksVsBaseline < 0 || r.extraTicksVsControl < 0)
        ? ' — **some of them negative**, which is a swarm finishing in fewer ticks with an adversary in ' +
          'it and is a rarest-first schedule reordering rather than an attack that helps.'
        : '.') +
      ` ${separable ? 'They are' : '**They are not**'} larger than the reordering, so ` +
      `${separable ? 'the tick column separates them from it' : 'the tick column does NOT establish a cost for either'}. ` +
      'What does separate them is the byte columns, which no reordering moves in the adversary\'s ' +
      `favour: ${signed(byBad.extraSourceBytesVsControl)} and ${signed(byHold.extraSourceBytesVsControl)} B ` +
      `off the source link, and ${byBad.bytesDiscardedOnArrival.toLocaleString('en-US')} B the corrupter ` +
      'put on a peer link that were discarded on arrival. Slow-drip is the one behaviour whose tick ' +
      'cost clears the noise by two orders of magnitude, which is the finding.'
  );
  say('');

  // --- 3: what the defence costs --------------------------------------------
  const F = res.floor;
  say(
    '**What the defence costs, which is the question a defence with no measured cost has not answered.** ' +
      'Deprioritisation is not free: a peer is dropped for failing, and finding out that it fails means ' +
      'giving it work. How many attempts it gets is re-derived here from the exported `peerScore` and ' +
      `\`rankProviders\` rather than inferred from a run. The score is (accepted − ${F.failureWeight} × ` +
      `failures) / requested and the floor is ${F.scoreFloor}, so one failure against one request scores ` +
      `${F.timeouts[0].score} and the peer is ineligible from then on: **` +
      `${F.attemptsBeforeDroppedOnTimeout} attempt on a timeout, ` +
      `${F.attemptsBeforeDroppedOnRejection} on a rejection — per device.** Per device, because a ledger ` +
      'belongs to one receiver and reputation is never shared: a reputation arriving from a peer would ' +
      'be a claim, and this design does not act on claims. The fleet therefore pays the discovery once ' +
      'per receiver, which is the expensive direction and the deliberate one.'
  );
  say('');
  say(
    `**And a peer that is never WRONG is never dropped, however slow.** Walked through the same ` +
      `functions: after four accepted deliveries at ${F.slowPeer.meanTicks} ticks each the slow peer ` +
      `scores ${F.slowPeer.score} and is ${F.slowPeer.eligible ? 'still eligible' : 'ineligible'} — only ` +
      'its latency demotes it, behind faster peers, and it keeps its place in the tail. That asymmetry ' +
      'is the whole reason slow-drip is the expensive behaviour.'
  );
  say('');

  for (const d of res.defenceCost) {
    say(`**What those attempts cost, at ${d.devices} simulated devices.**`);
    say('');
    say(
      markdownTable(
        ['behaviour', 'floor fires?', 'attempts measured (fleet)', 'attempts per device', 'device-slot ticks spent on it', 'bytes discarded on arrival', 'Δ source B vs control', 'Δ ticks vs control', 'attempts without a floor (projected)'],
        d.rows.map((r) => [
          `\`${r.behaviour}\``,
          r.floorFires ? 'yes' : 'no — it is never wrong',
          String(r.attemptsMeasured),
          fmt(r.attemptsPerDevice, 2),
          String(r.wastedTickSlots),
          r.bytesDiscardedOnArrival.toLocaleString('en-US'),
          `${r.extraSourceBytesVsControl >= 0 ? '+' : ''}${r.extraSourceBytesVsControl.toLocaleString('en-US')}`,
          `${r.criticalPathTicksVsControl >= 0 ? '+' : ''}${r.criticalPathTicksVsControl}`,
          r.projection ? `${r.attemptsWithoutFloorProjected.toLocaleString('en-US')} (projection)` : '— (the floor never fires)'
        ])
      )
    );
    say('');
  }

  const dSmall = res.defenceCost[0];
  const dTop = res.defenceCost[res.defenceCost.length - 1];
  const pick = (d, name) => d.rows.find((r) => r.behaviour === name);
  const dHold = pick(dTop, 'advertise-and-withhold');
  const dBad = pick(dTop, 'corrupt-chunk');
  const sSlow = pick(dSmall, 'slow-drip');
  const sHold = pick(dSmall, 'advertise-and-withhold');
  const sBad = pick(dSmall, 'corrupt-chunk');
  say(
    `**What the floor bought, and where a different cap takes over.** At ${dSmall.devices} devices the ` +
      `floor is what binds: the two behaviours it drops were asked ${fmt(sBad.attemptsPerDevice, 2)} and ` +
      `${fmt(sHold.attemptsPerDevice, 2)} times per device — the bound is 1 — while slow-drip, on which ` +
      `the floor never fires because the peer is never wrong, drew ${fmt(sSlow.attemptsPerDevice, 1)} ` +
      'per device. **That is the value of the floor as a measurement rather than as arithmetic**, and it ' +
      'is the only measured no-deprioritisation arm available, because the floor is not configurable and ' +
      'this suite does not modify `swarm.js`.'
  );
  say('');
  say(
    `**At ${dTop.devices} devices that contrast disappears, and the reason is worth more than the ` +
      `contrast was.** Slow-drip drew ${pick(dTop, 'slow-drip').attemptsMeasured} attempts at ` +
      `${dTop.devices} devices — the same ${sSlow.attemptsMeasured} it drew at ${dSmall.devices} — ` +
      `because an adversary with \`peerSlots: ${cm.peerSlots}\` can hold exactly one request open at a ` +
      'time. **Its own concurrency limit, not the floor, is what caps it**, and the same cap explains ' +
      `why the withholder drew only ${dHold.attemptsMeasured} requests across ${dTop.devices} devices: ` +
      `it holds each one for the full ${cm.timeoutTicks}-tick timeout, so a run of a few hundred ticks ` +
      `has room for barely a dozen. The corrupter answers in ` +
      `${cm.chunkTicks} tick and has no such cap, so there the floor is the binding constraint and it ` +
      `shows: ${dBad.attemptsMeasured} attempts across ${dTop.devices} devices, ` +
      `${fmt(dBad.attemptsPerDevice, 2)} each. **A defence and a bottleneck can produce the same number, ` +
      'and only one of them is the defence.**'
  );
  say('');
  say(
    `**What the attempts cost, in the units they are spent in.** At ${dTop.devices} devices the ` +
      `withholder consumed ${dHold.wastedTickSlots} device-slot ticks — ${dHold.attemptsMeasured} ` +
      `timeouts × ${cm.timeoutTicks} ticks — during which those receivers had nothing else in flight, ` +
      `and cost ${signed(dHold.extraSourceBytesVsControl)} B off the source link. The corrupter ` +
      `consumed ${dBad.wastedTickSlots} device-slot ticks and made the fleet receive and throw away ` +
      `**${dBad.bytesDiscardedOnArrival.toLocaleString('en-US')} B — ` +
      `${fmt(dBad.bytesDiscardedOnArrival / (cfg.chunkSize * cfg.chunkCount), 2)}× the artifact** — on ` +
      `peer links, plus ${signed(dBad.extraSourceBytesVsControl)} B off the source. Those bytes crossed ` +
      'a link and were discarded on arrival, before they were stored and therefore before they could be ' +
      'forwarded: `advertise()` is derived from the store, so there is no container a refused chunk ' +
      `could be forwarded out of. The projection column is the counterfactual: with no floor, ` +
      `devices × chunks = ${dHold.attemptsWithoutFloorProjected.toLocaleString('en-US')} attempts, ` +
      `${dHold.wastedTickSlotsWithoutFloorProjected.toLocaleString('en-US')} device-slot ticks for a ` +
      `withholder and ${dBad.bytesDiscardedWithoutFloorProjected.toLocaleString('en-US')} B discarded ` +
      'for a corrupter. **That column is arithmetic and nothing in this repository ran with the floor ' +
      'disabled.**'
  );
  say('');

  // --- the module's own honesty, read out of it ------------------------------
  const met = res.criteria.filter((c) => c.met);
  const unmet = res.criteria.filter((c) => !c.met);
  say(
    `**ADR-024's six acceptance criteria, read out of \`describeCriteria()\` in the running module** ` +
      'rather than restated here — for the reason `attest.js`\'s `describeRoots()` exists: a caveat that ' +
      `lives only in a report is a caveat that stops being read. **${met.length} of ${res.criteria.length} ` +
      `met**, and the ${unmet.length} that are not are the two that need a site.`
  );
  say('');
  say(
    markdownTable(
      ['#', 'criterion', 'status', 'met?'],
      res.criteria.map((c) => [
        String(c.criterion),
        c.label,
        `\`${c.status}\``,
        c.met ? 'yes' : '**no**'
      ])
    )
  );
  say('');
  const absent = res.unimplemented.filter((u) => u.status === 'absent');
  const injected = res.unimplemented.filter((u) => u.status === 'injected-absent');
  say(
    `**And what ADR-024 asks for that this build does not have**, from ` +
      `\`describeUnimplemented()\`: **${absent.length} absent** — ` +
      absent.map((u) => `\`${u.id}\``).join(', ') +
      ` — and **${injected.length} injected and absent by default** — ` +
      injected.map((u) => `\`${u.id}\``).join(', ') +
      '. The first list is why most of ADR-024 is not measurable here at all: there is no BitChat, so ' +
      'peer discovery and the pre-link control channel sit outside the module and the peer set arrives ' +
      'as data; there is no chunk store, so store-and-carry across a reboot and "interrupted receivers ' +
      'resend at most one chunk" are properties of something that does not exist; and there is no device ' +
      'fleet.'
  );
  say('');

  say(
    '**What this suite does not establish.** It measures no seconds and evaluates neither wall-clock ' +
      'gate. It measures no radio, no site, no reboot and no interruption. It does not exercise the ' +
      `broadcast tier, which is \`${res.broadcastCodec}\` and is not wired into \`swarm.js\` at all. It ` +
      'does not test store-and-carry, custody receipts or witness lineage, none of which exist here. Its ' +
      'digest and signer are stand-ins, and the one configuration re-run with real SHA-256 and real ' +
      'Ed25519 shows only that the choice does not move a counted quantity — not that anything here is ' +
      'cryptographically evaluated. And it does not establish a tick cost for corrupt-chunk or ' +
      'advertise-and-withhold: at the largest fleet measured both move the run by less than the ' +
      'reordering an honest peer causes, so the honest reading of that column is that it is below this ' +
      'instrument\'s resolution rather than that the attacks are free.\n\n' +
      'What the tables do establish is narrower and is what criteria 4 and ' +
      `6 asked for: source traffic **measured at the link** stays at ${fmt(top.ratioToArtifact, 2)}× the ` +
      `artifact for ${top.devices} simulated devices against a projected ` +
      `${fmt(top.savingVsPointToPoint, 0)}× point-to-point; each of the three named behaviours has a ` +
      'stated, measured effect — in source bytes and discarded bytes for all three, and in ticks for ' +
      'slow-drip, which clears the noise by two orders of magnitude; the cost of deprioritising is one ' +
      'attempt per device, bounded by the score floor, and the slot-ticks and bytes that attempt ' +
      'consumes; and no hostile peer put one wrong byte on one device under any of them.'
  );
  say('');
}

function printPresenceSuite(res) {
  say('### Physical presence fusion: a rule over three channels that do not exist — `artifacts/presence.js`');
  say('');
  if (!res.available) {
    say(`Not measured: ${res.reason}.`);
    say('');
    return;
  }

  // The disclaimer comes first, before any number. A reader who takes the tables
  // below for evidence that rvQR senses proximity has been misled by this
  // report, not by the module — `presence.js` says the same in its own docblock
  // and `describeChannels()` says it from inside the running system.
  const unimplemented = res.channels.filter((c) => c.status === 'unimplemented');
  say(
    `**None of the three channels is implemented. Not one.** \`describeChannels()\` reports ` +
      `${unimplemented.length} of ${res.channels.length} as \`status: "unimplemented"\` with ` +
      '`readerSupplied: false` — ' +
      res.channels.map((c) => `${c.label} (\`${c.status}\`)`).join(', ') +
      '. There is no ultrasonic code in this repository at all — no AudioContext, no oscillator, no ' +
      'encoder, no decoder — there is no ranging code and **no browser exposes a UWB API**, and the ' +
      'optical transport exists while measuring nothing whatever about presence. So this section ' +
      'measures **the fusion rule** and nothing about physical presence. **rvQR does not sense ' +
      'proximity.**'
  );
  say('');
  say(
    `Every channel takes its answer from \`opts.readers[channel]\`, an injected function supplied by a ` +
      `caller that has hardware. There is no such caller, so the reader everywhere below is an ` +
      `**${res.reader}**: every signal in every table is a *simulation of a signal* and never a signal, ` +
      'and where a table says a channel passed, what passed was a stub returning `true`. Run as this ' +
      `repository stands — a perfect report on all three channels and no reader anywhere — the verdict ` +
      `is \`${res.fixtureCheck.asShippedState}\` with **${res.fixtureCheck.asShippedPasses} of 3 ` +
      `channels passing** and all three \`${res.fixtureCheck.asShippedOutcomes[0]}\`. \`corroborated\` ` +
      'is unreachable on this platform, and that is the honest state rather than a limitation of the suite.'
  );
  say('');

  const c4 = res.acceptance.find((a) => a.criterion === 4);
  const c6 = res.acceptance.find((a) => a.criterion === 6);
  say(
    `**ADR-023 §4 criteria 4 and 6 are NOT MET and nothing here approaches them.** Criterion 4 asks for ` +
      'a relay attempt to be **measured** — two devices, two rooms, a relay in between, and a report of ' +
      `which channels it defeats. That is hardware; \`describeAcceptance()\` marks it \`${c4.status}\` ` +
      'and **no relay is simulated anywhere in this suite**, because simulating one and reporting which ' +
      'channels it defeated would be reporting an invention as an observation. What the module does ' +
      'publish is which channels a relay would have to defeat *simultaneously* for a claim to exist ' +
      `under the pair relation, and it labels itself \`evidence: "${res.relay.evidence}"\`, ` +
      `\`measured: ${res.relay.measured}\` — that is **reasoning about the rule, not a measurement of an ` +
      `attack**. Criterion 6 is \`${c6.status}\` too: nothing is wired to a UI, so there is no wording ` +
      'to review against §3\'s over-claiming risk.'
  );
  say('');
  say(
    markdownTable(
      ['ADR-023 §4', 'status', 'why'],
      res.acceptance.map((a) => [
        String(a.criterion),
        a.status === 'unmet' ? '**unmet**' : a.status,
        a.note
      ])
    )
  );
  say('');
  say(
    '**Which channels a relay would have to defeat at once — REASONING, not measurement.** No relay ' +
      'has been built, run or observed by this repository:'
  );
  say('');
  say(
    markdownTable(
      ['corroborating pair', 'a relay must defeat, simultaneously and each against its own fresh challenge'],
      res.relay.pairs.map((p) => [`\`${p.pair.join(' + ')}\``, p.mustDefeatSimultaneously.join(' **and** ')])
    )
  );
  say('');
  say(`*${res.relay.residual}*`);
  say('');

  say(
    `Driving ${path.relative(REPO_ROOT, res.path)} end to end — ${res.exports} exports, ` +
      `${res.states.length} fused states, ${res.outcomes.length} per-channel outcomes, ` +
      `${res.pairRelation.declaredPairs.length} corroborating pairs. ` +
      (res.testSuite.available
        ? `The fixtures are \`artifacts/presence.test.js\`'s, reproduced exactly, and that test file is ` +
          `run against the same module in this same process: **${res.testSuite.passed}/${res.testSuite.total} ` +
          `passed**` +
          (res.testSuite.failed
            ? `, ${res.testSuite.failed} FAILED — ${res.testSuite.failures.join('; ')}.`
            : '. So the copied fixtures are not drifting from the ones the module is tested with.')
        : `The test file could not be run (${res.testSuite.reason}), so the copied fixtures are ` +
          'unchecked against it.') +
      ' The three challenges are **per channel**, which is the part that cannot be simplified: one ' +
      'shared challenge would leave two of three channels `unbound` on every row and the matrix would ' +
      'report a very strict module instead of an untested one.'
  );
  say('');
  const fc = res.fixtureCheck;
  say(
    `Fixture self-check before any table is built on them: the two-channel recipe reaches ` +
      `\`${fc.corroboratedState}\` with ${fc.corroboratedPairs} pair, the one-channel recipe reaches ` +
      `\`${fc.singleState}\` with ${fc.singlePassed} channel passing, and the control — the same ` +
      `corroborated verdict under a policy that requires presence and grants this peer — ` +
      `${fc.controlAdmitted ? `**admits** with \`${fc.controlCode}\`` : `**does not admit** (\`${fc.controlCode}\`), so every refusal below could have been caused by the fixture and proves nothing`}.`
  );
  say('');

  // --- 1. The decision matrix ------------------------------------------------

  say(
    '**The decision matrix.** Each of the three channels driven to each of the seven outcomes the ' +
      'module defines, with the other two channels absent, so a row measures that channel in that ' +
      'outcome and not a mixture. Every verdict is produced by the shipped `verifyPresence`; none is ' +
      'written by hand. The six policy columns are the shapes a sender can take:'
  );
  say('');
  say(
    markdownTable(
      ['policy shape', 'what it says'],
      res.policyShapes.map((s) => [`\`${s.id}\``, s.label])
    )
  );
  say('');
  const shapeIds = res.policyShapes.map((s) => s.id);
  say(
    markdownTable(
      ['channel', 'outcome', 'fused state', 'passed', 'pairs', ...shapeIds.map((s) => `\`${s}\``)],
      res.isolation.map((row) => [
        row.channel,
        `\`${row.outcome}\`${row.reachedIntendedOutcome ? '' : ` **(recipe reached ${row.actualOutcome})**`}`,
        `\`${row.fusedState}\``,
        String(row.passed),
        String(row.pairs),
        ...shapeIds.map((id) => {
          const cell = row.cells.find((x) => x.policy === id);
          if (cell.outcome === 'threw') return '**THREW**';
          return cell.admit ? `**ADMIT** \`${cell.code}\`` : `\`${cell.code}\``;
        })
      ])
    )
  );
  say('');
  const missedRecipes = res.isolation.filter((r) => !r.reachedIntendedOutcome);
  const isolationAdmits = res.isolation.flatMap((r) => r.cells.filter((c) => c.admit).map((c) => ({ ...r, cell: c })));
  say(
    (missedRecipes.length
      ? `**${missedRecipes.length} recipe(s) did not reach the outcome they name, so those rows measure ` +
        `something else: ${missedRecipes.map((r) => `${r.channel}/${r.outcome}→${r.actualOutcome}`).join(', ')}.**`
      : `All ${res.isolation.length} recipes reached the outcome they name, so every row measures the ` +
        'outcome it names.') +
      ' ' +
      `${isolationAdmits.length} of the ${res.isolation.length * shapeIds.length} cells admit, and ` +
      (isolationAdmits.every((a) => a.cell.code === 'presence-not-required')
        ? '**every one of them is `presence-not-required`** — the `permits` column, where the sender is ' +
          'not relying on presence at all. Not one admission anywhere in this table is attributable to ' +
          'a channel, which is the property the whole matrix exists to test.'
        : `**${isolationAdmits.filter((a) => a.cell.code !== 'presence-not-required').length} of them ` +
          'carry a presence-based code on a single channel, which is a defect and is reported here ' +
          'rather than adjusted away.**')
  );
  say('');
  say(
    'The `undeclared` and `incoherent` columns never admit on any row and that is the point of them: a ' +
      'policy that has not said whether it requires presence is refused rather than handed a default, ' +
      'and a policy naming a required channel while saying presence is not required is refused rather ' +
      'than letting one of its two statements silently win.'
  );
  say('');

  // --- The exhaustive product ------------------------------------------------

  const sw = res.sweep;
  say(
    `**And the whole product.** Every combination of the ${res.outcomes.length} per-channel outcomes ` +
      `over the ${res.channelNames.length} channels — **${sw.total} verdicts**, each driven through the ` +
      `shipped verifier, then through the gate under all six policy shapes for ` +
      `**${sw.decisions.toLocaleString('en-US')} decisions**. The fused state each combination reaches:`
  );
  say('');
  say(
    markdownTable(
      ['fused state', 'combinations', 'share'],
      res.states.map((s) => [
        `\`${s}\``,
        String(sw.byState[s] || 0),
        pct((sw.byState[s] || 0) / sw.total, 1)
      ])
    )
  );
  say('');
  say(
    (sw.mismatches.length
      ? `**${sw.mismatches.length} of ${sw.total} combinations reached a state the module's documented ` +
        'precedence does not predict** — ' +
        sw.mismatches.slice(0, 5).map((m) => `${m.outcomes.join('/')} → \`${m.got}\` (predicted \`${m.predicted}\`)`).join(', ') +
        '.'
      : `All ${sw.total} combinations reached the state an independent reading of the module's ` +
        'precedence predicts — a refusing outcome anywhere refuses the fusion, then two passing ' +
        'channels corroborate, then nothing attempted is absent — so the sweep and the rule agree.') +
      ' ' +
      (sw.threw ? `**${sw.threw} call(s) threw.**` : 'Nothing threw.') +
      ' ' +
      (sw.singlePassCorroborated.length === 0
        ? '**Not one combination with fewer than two passing channels reached `corroborated`.**'
        : `**${sw.singlePassCorroborated.length} combination(s) reached \`corroborated\` on fewer than ` +
          'two passing channels. That is the defect this suite exists to find.**') +
      ' ' +
      (sw.singlePassAdmittedOnPresence.length === 0
        ? `Of the ${sw.admissions.toLocaleString('en-US')} admissions across all six policy shapes, ` +
          '**none carries `corroborated-and-approved` on one channel or fewer**.'
        : `**${sw.singlePassAdmittedOnPresence.length} admission(s) carry a presence-based code on one ` +
          'channel or fewer.**') +
      ' ' +
      (sw.pairsOnRefusingState.length === 0
        ? 'No refusing state publishes a pair list, so a hand-built gate reading `pairs` off a refused ' +
          'verdict finds nothing there to match.'
        : `**${sw.pairsOnRefusingState.length} refusing state(s) publish a pair list.**`)
  );
  say('');
  say(
    markdownTable(
      ['policy shape', 'admissions', 'of', 'codes'],
      res.policyShapes.map((s) => {
        const p = sw.perShape[s.id];
        return [
          `\`${s.id}\``,
          p.admitted.toLocaleString('en-US'),
          sw.total.toLocaleString('en-US'),
          Object.entries(p.byCode).map(([code, n]) => `\`${code}\` ×${n}`).join(', ') || '—'
        ];
      })
    )
  );
  say('');

  // --- 2. The pair relation is not a count -----------------------------------

  say(
    '**Corroboration is a pair relation, and there is nothing in it to set to one.** `presence.js` ' +
      'enumerates `CORROBORATING_PAIRS` from every combination of two *distinct* channel indices rather ' +
      'than comparing a tally against a bound, and the reason is stated in the module: a number that ' +
      `can be set to 2 can be set to 1. The declared list is ` +
      res.pairRelation.declaredPairs.map((p) => `\`${p.join('+')}\``).join(', ') +
      ` — ${res.pairRelation.declaredPairs.length} pairs, ${res.pairRelation.declaredSelfPairs} of them ` +
      'self-pairs, which is what `i < j` construction guarantees.'
  );
  say('');
  say(
    `Read off the shipped \`passingPairs\` over all ${res.pairRelation.combos} outcome combinations: a ` +
      'pair is produced ' +
      (res.pairRelation.disagreements.length === 0
        ? '**exactly when two distinct channels passed, and never otherwise** — ' +
          `${res.pairRelation.disagreements.length} disagreements, ${res.pairRelation.selfPairs} ` +
          'self-pairs emitted.'
        : `in **${res.pairRelation.disagreements.length} cases where the passing count does not justify ` +
          'it**, which contradicts the rule.')
  );
  say('');
  const ns = res.normalizedShape;
  say(
    `**A caller-supplied threshold is DROPPED, and here is it being dropped.** \`normalizePolicy\` ` +
      `returns a fixed key set — \`${ns.keys.join('`, `')}\` — of which ` +
      `${ns.numericFields.length} are numbers and ${ns.knobNamedFields.length} read as a knob. Each ` +
      'invented field below was offered on an otherwise valid policy and the returned key set inspected:'
  );
  say('');
  say(
    markdownTable(
      ['field a caller invented', 'value offered', 'survived normalisation?', 'key set after'],
      ns.droppedRows.map((r) => [
        `\`${r.field}\``,
        `\`${r.value}\``,
        r.survived ? '**YES — the policy carries it**' : 'no',
        r.keysUnchanged ? 'unchanged' : `**${r.keysAfter}**`
      ])
    )
  );
  say('');
  const th = res.threshold;
  say(
    (ns.allDropped
      ? `**All ${ns.droppedRows.length} were dropped and the key set never moved.** There is no field ` +
        'on a normalised policy for a threshold to live in.'
      : '**At least one invented field survived normalisation.**') +
      ' That is the structural claim; the behavioural one is the sweep beneath it. ' +
      `**${th.policyInputs} policy inputs** — every combination of ${th.requireValues} ` +
      `\`requirePresence\` values, ${th.requiredSets} \`requiredChannels\` sets, ${th.grantSets} grant ` +
      `tables and ${th.inventedShapes} invented-knob shapes — were ` +
      `crossed with four request shapes and the three one-perfect-channel verdicts, for ` +
      `**${th.decisions.toLocaleString('en-US')} decisions**. ` +
      (th.presenceCodedAdmissions === 0
        ? `${th.admissions.toLocaleString('en-US')} of them admit and **not one carries ` +
          '`corroborated-and-approved`**: no policy input anyone can write, invented fields included, ' +
          'turns one channel into an authorization.'
        : `**${th.presenceCodedAdmissions} of them admit with a presence-based code on a single ` +
          'channel. That is the failure the pair relation exists to prevent.**')
  );
  say('');
  say(
    '**The counterfactual, which is the stronger form of the same question.** Counting refusals proves ' +
      'little on its own — a module that refused everything would score perfectly. So each of those ' +
      'decisions is compared against what the **empty report** gets under the identical policy and ' +
      `request: ${th.comparisons.toLocaleString('en-US')} comparisons, of which the baseline admits ` +
      `${th.baselineAdmissions.toLocaleString('en-US')}. ` +
      (th.flips.length === 0
        ? '**Adding one perfect channel changed `admit` in exactly 0 of them.** If a channel never ' +
          'changes the decision, it never authorized anything — and the baseline admitting in some of ' +
          'them is what makes that a measurement rather than a module that says no to everything.'
        : `**${th.flips.length} of them flipped**, so one channel does move a decision: ` +
          th.flips.slice(0, 5).map((f) => `${f.verdict} under requirePresence=${f.requirePresence} (${f.code})`).join('; ') +
          '.')
  );
  say('');
  const mr = res.mutatedRule;
  say(
    '**And the rule itself, corrupted on purpose.** `CORROBORATING_PAIRS` is exported by reference and ' +
      `is \`Object.isFrozen\` **${mr.frozen}**, so a page script sharing this module can push a ` +
      'self-pair straight into the fusion rule. That is not hypothetical, so it is measured: a ' +
      `\`['optical', 'optical']\` pair was pushed onto the live list, one perfect optical channel was ` +
      `run through the verifier, and the verifier did reach \`${mr.verifierState}\` with ` +
      `${mr.verifierPairs} pair. ` +
      (mr.admitted
        ? '**The gate then admitted it**, so a mutated pair list is a complete bypass of ADR-023 §2.2.'
        : `**The gate refused it anyway** — \`${mr.code}\`, unmet: ` +
          `${mr.unmet.map((u) => `\`${u}\``).join(', ')} — because \`unmetRequirements\` re-checks ` +
          '`pair[0] !== pair[1]` against the channel records rather than trusting the list. The ' +
          'distinctness rule is enforced twice, in the construction and in the gate, and only the ' +
          'second one is reachable by a caller. The list was restored afterwards and the restoration ' +
          `verified: **${mr.restored}**.`)
  );
  say('');

  // --- 3. Fail-closed --------------------------------------------------------

  const cov = res.coverage;
  say(
    `**Fail-closed coverage.** ${cov.total} inputs a hostile or broken device, a confused caller or an ` +
      'unfinished policy could produce, each run under a policy that requires presence and one that ' +
      'does not. Three outcomes are counted and not two, because a security path that throws is as ' +
      'broken as one that admits, just louder:'
  );
  say('');
  say(
    markdownTable(
      ['group', 'cases', 'refused under both policies', 'threw', 'admitted'],
      ['malformed report', 'fabricated verdict', 'policy or request shape'].map((g) => {
        const rows = res.failClosed.filter((r) => r.group === g);
        return [
          g,
          String(rows.length),
          String(rows.filter((r) => r.strictOutcome === 'refused' && r.laxOutcome === 'refused').length),
          String(rows.filter((r) => r.strictOutcome === 'threw' || r.laxOutcome === 'threw' || r.parseThrew || r.verifyThrew).length),
          String(rows.filter((r) => r.strictOutcome === 'admitted' || r.laxOutcome === 'admitted').length)
        ];
      })
    )
  );
  say('');
  say(
    `**${cov.refusedUnderBoth} of ${cov.total} — ${pct(cov.fraction, 1)} — produce a refusal under both ` +
      `policies, ${cov.threw} throw and ${cov.admitted} are admitted.** ` +
      (cov.admitted
        ? 'The admitted rows are: ' +
          cov.admittedNames.map((a) => `**${a.name}** (\`${a.strict}\` / \`${a.lax}\`)`).join('; ') + '.'
        : 'Nothing malformed is admitted anywhere.') +
      ' ' +
      (cov.parseNeverThrew
        ? '`parseReport` is documented never to throw and it never did, on any of these.'
        : '**`parseReport` threw**, which contradicts its own docblock.')
  );
  say('');
  say(
    `**Where each one was caught, which is not the same question as whether it was caught.** ` +
      `\`parseReport\` reads the CONTAINER and \`parseSignal\` reads each signal separately, ` +
      'deliberately, so that one broken signal does not erase the other two from the transcript. Of the ' +
      `${res.failClosed.filter((r) => r.group === 'malformed report').length} reports in that group, ` +
      `**${cov.parseRefused} were refused by \`parseReport\` outright** and ` +
      `**${cov.parseAcceptedThenRefused.length} passed the container check and were then refused at the ` +
      `signal** — ` +
      cov.parseAcceptedThenRefused.map((a) => `${a.name} → \`${a.state}\``).join(', ') +
      `. The remaining ${cov.parseAcceptedAsAbsent.length} are **not malformed at all** and are named ` +
      'rather than counted as parser misses: ' +
      cov.parseAcceptedAsAbsent.map((a) => `**${a.name}** → \`${a.state}\``).join(', ') +
      ' — well-formed reports that declare and attempt nothing, which is the ordinary case for two web ' +
      'pages and a state rather than a failure. ' +
      (cov.refusedParseReachesMalformed
        ? 'Every report `parseReport` refused reached `malformed`, and none of them landed on `absent`, ' +
          'which is the distinction the downgrade paragraph below turns on.'
        : '**At least one refused report landed on a state other than `malformed`.**')
  );
  say('');
  say(
    (res.downgrade.kept
      ? '**A malformed report is refused rather than treated as an absent one**, which is the pair of ' +
        'cells that prevents a downgrade: under the *same* permitting policy, `absent` admits with ' +
        `\`${res.downgrade.absentCode}\` and \`malformed\` refuses with \`${res.downgrade.malformedCode}\`. ` +
        'A pair that could reach the absent path by sending garbage would have found the widest ' +
        'permission in the system by making its evidence worse.'
      : '**Malformed and absent are NOT kept apart under a permitting policy**, so a pair can change ' +
        'its treatment by corrupting its own report.') +
      ' `uncorroborated` under the same permitting policy ' +
      (res.downgrade.uncorroboratedAdmitted
        ? `admits with \`${res.downgrade.uncorroboratedCode}\` — deliberately, and it is the same code ` +
          '`absent` gets: a sender not relying on presence must not treat a partial report as *worse* ' +
          'than no report, which would only teach devices to send nothing.'
        : `refuses with \`${res.downgrade.uncorroboratedCode}\`.`)
  );
  say('');
  say(
    '**The three fabricated `corroborated` verdicts are the ones worth reading**, because they are what ' +
      'a caller who copied the state field and built the rest would produce. A bare `state: ' +
      '"corroborated"`, a pair list over channels whose own records say `passed: false`, and a channel ' +
      'corroborating itself:'
  );
  say('');
  say(
    markdownTable(
      ['fabricated verdict', 'what it is', 'requiring policy', 'permitting policy'],
      res.failClosed
        .filter((r) => r.group === 'fabricated verdict' && /corroborated/.test(r.name))
        .map((r) => [
          r.name,
          r.what,
          r.strictOutcome === 'admitted' ? `**ADMITTED** \`${r.strictCode}\`` : `\`${r.strictCode}\``,
          r.laxOutcome === 'admitted' ? `**ADMITTED** \`${r.laxCode}\`` : `\`${r.laxCode}\``
        ])
    )
  );
  say('');
  say(
    'The last row of that table is the one to read carefully, because it is admitted and it is not a ' +
      'bypass: `uncorroborated` with a pair list bolted on is admitted **under the permitting policy ' +
      'only**, with `presence-not-required` and not `corroborated-and-approved`. The permitting policy ' +
      'admits every `uncorroborated` verdict, with or without a pair list; the bolted-on list bought ' +
      'nothing, and that is visible in the code rather than having to be argued.'
  );
  say('');

  // A defect this suite found and is reporting rather than adjusting away.
  say(
    '**A stated channel requirement that is silently dropped — reported here rather than smoothed ' +
      'over.** `normalizePolicy` filters `requiredChannels` through the channel vocabulary and keeps ' +
      'what survives, so a name that is not one of the three is **discarded and the policy proceeds as ' +
      'though the sender had asked for nothing**. Measured against a corroborated verdict carrying ' +
      'optical and acoustic:'
  );
  say('');
  say(
    markdownTable(
      ['sender asked for', 'what it is', 'policy kept', 'dropped', 'decision'],
      res.requiredChannelDrop.map((r) => [
        `\`${r.asked.join(', ')}\``,
        r.what,
        r.kept.length ? `\`${r.kept.join(', ')}\`` : '*nothing*',
        r.dropped.length ? `**\`${r.dropped.join(', ')}\`**` : '—',
        r.admitted ? `**ADMIT** \`${r.code}\`` : `\`${r.code}\``
      ])
    )
  );
  say('');
  say(
    (res.silentDrops.length
      ? `**${res.silentDrops.length} of these ${res.requiredChannelDrop.length} policies had a channel ` +
        'requirement silently dropped and were then ADMITTED.** That is the same failure mode the ' +
        '`policy-incoherent` refusal exists to prevent one step earlier — the module refuses a policy ' +
        'that names a required channel while saying presence is not required, on the stated grounds ' +
        'that neither of two colliding statements may silently win, and then quietly discards a ' +
        'required channel it does not recognise. A sender that writes `requiredChannels: ' +
        "['ultrasonic']` — the ADR's own word for the acoustic channel, and not the module's — gets an " +
        'activation it believes was gated on a channel that was never checked. ' +
        '**This is not a violation of ADR-023 §2.2:** every one of these admissions still required two ' +
        'distinct channels to corroborate, so no single channel authorized anything, and the pair ' +
        'relation is intact. It is a security setting being ignored without saying so, which is worth ' +
        'a refusal or at least a field on the receipt. The receipt does record ' +
        '`senderRequiredChannels` — but it records the *normalised* list, so it agrees with the gate ' +
        'and not with what the sender wrote, and an auditor reading it would never see the drop.'
      : 'No policy had a channel requirement silently dropped.')
  );
  say('');
  const js = res.junkSweep;
  say(
    `And the blunt instrument: ${js.shapes} junk shapes in every argument position of ` +
      `\`admitActivation\`, \`verifyPresence\`, \`presenceTranscript\` and \`presenceReceipt\` — ` +
      `**${js.calls.toLocaleString('en-US')} calls** over ${js.triples.toLocaleString('en-US')} argument ` +
      `triples. ${js.threw} threw, ${js.admitted} admitted, ${js.corroborated} reached ` +
      '`corroborated`' +
      (js.threw || js.admitted || js.corroborated
        ? `. **Throw sites: ${js.throwSites.join(', ') || 'none'}.**`
        : '. Total functions over hostile input, which is what lets the matrix above be read as ' +
          'exhaustive rather than as the cases that happened not to crash.')
  );
  say('');
  const rc = res.receipts;
  say(
    '**The receipt never conflates "corroborated and approved" with "nobody asked".** Both end in an ' +
      'activation proceeding and they are entirely different claims, so they are carried in separate ' +
      'named fields:'
  );
  say('');
  say(
    markdownTable(
      ['', 'presence', 'report presented', 'sender required presence', 'pairs', 'decision', 'summary'],
      [
        ['corroborated', rc.corroborated],
        ['nobody asked', rc.nobodyAsked]
      ].map(([label, r]) => [
        label,
        `\`${r.presence}\``,
        String(r.reportPresented),
        String(r.requiredPresence),
        String(r.pairs),
        `\`${r.code}\``,
        r.summary
      ])
    )
  );
  say('');
  say(
    rc.distinguished
      ? '`admitted: true` alone says nothing, which is exactly why it is never recorded alone.'
      : '**The two read the same**, so a reader of the receipt cannot tell them apart.'
  );
  say('');

  // --- 4. Cost ---------------------------------------------------------------

  const k = res.cost;
  say(
    `**What deciding costs.** Per-call figures are the mean within a batch of ` +
      `${k.batch.toLocaleString('en-US')} calls and the median across ${k.reps} batches — batched ` +
      'because these run in single-digit microseconds and a clock read costs tens of nanoseconds:'
  );
  say('');
  say(
    markdownTable(
      ['function', 'p50', 'p95', 'min', 'max'],
      [
        ['`parseReport` (well-formed, two channels)', k.parseReport],
        ['`verifyPresence` → corroborated (two stub readers)', k.verifyCorroborated],
        ['`verifyPresence` as this repository stands (three channels, no reader)', k.verifyAsShipped],
        ['`verifyPresence` → absent (no report)', k.verifyAbsent],
        ['`admitActivation` (corroborated, three stages, grant table)', k.admitActivation],
        ['`presenceTranscript`', k.presenceTranscript],
        ['`presenceReceipt`', k.presenceReceipt]
      ].map(([label, st]) => [
        label,
        `${fmt(st.p50, 3)} µs`,
        `${fmt(st.p95, 3)} µs`,
        `${fmt(st.min, 3)} µs`,
        `${fmt(st.max, 3)} µs`
      ])
    )
  );
  say('');
  const anchorSeconds = 1;
  const orders = Math.floor(Math.log10(anchorSeconds / (k.perActivationUs / 1e6)));
  say(
    `A **fusion decision** — verify once, gate once — costs **${fmt(k.fusionDecisionUs, 2)} µs**. ` +
      `Building the **transcript and the receipt** costs a further **${fmt(k.transcriptAndReceiptUs, 2)} µs**. ` +
      `One activation pays all four once: **${fmt(k.perActivationUs, 2)} µs**, which is ` +
      `${Math.round(k.decisionsPerFramePeriod).toLocaleString('en-US')} activations inside a single ` +
      `${k.framePeriodMs} ms frame period at the app's default 5 fps, or ${pct(k.shareOfFramePeriod, 4)} ` +
      `of one frame. Against a transfer of ${anchorSeconds} second that is **${orders} orders of ` +
      'magnitude cheaper than the transfer it gates**. One second is a round anchor chosen so the ' +
      'arithmetic is checkable by hand and not a transfer this suite measured — this suite measures no ' +
      'transfer at all, and borrowing a duration from another suite here would be quoting a number the ' +
      'harness has not produced at this point in the run; the report\'s own transfer sections supply ' +
      'the range around this anchor. That is the claim these numbers support; "negligible" on its own ' +
      'is not. The 5 fps is a configured constant of this ' +
      'application and not a measurement, and the microseconds are of this machine and this run — the ' +
      '`--quick` batch size moves them.'
  );
  say('');
  say(
    '**What this suite does not establish.** It says nothing about optical presence, ultrasound or ' +
      'radio ranging, because it runs none of them and neither does anything else in this repository — ' +
      'and two of the three could not be run from a web page at all today. It has not measured a relay ' +
      'and does not simulate one. It has not reviewed a UI wording, because there is no UI. Binding is ' +
      'checked here as a plain field comparison, exactly as the module checks it, and in a real channel ' +
      'the challenge is *inside* the measurement — a tone that answers, a ranging exchange that ' +
      'completes — so binding and reading would be one check and not two, and that is precisely the ' +
      'part no reader implements. What the tables above establish is narrower and worth having on its ' +
      `own: that across ${res.sweep.total} outcome combinations and ` +
      `${res.threshold.policyInputs} policy inputs, no single channel and no invented threshold ever ` +
      'reaches an authorization; that every admission passes the capability check; that ' +
      `${pct(res.coverage.fraction, 0)} of hostile inputs refuse rather than throw or admit; and that ` +
      `it costs ${fmt(k.perActivationUs, 1)} µs. ` +
      (res.silentDrops.length
        ? `It also found one thing the module gets wrong, stated above rather than tidied away: a ` +
          `\`requiredChannels\` entry the module does not recognise is dropped without a refusal in ` +
          `${res.silentDrops.length} of ${res.requiredChannelDrop.length} probes.`
        : '')
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

  if (want('attest')) {
    say('---');
    say('');
    // Batched rather than trial-counted: these are microsecond-scale pure
    // functions, so the harness's --trials knob is the wrong dial and --quick
    // moves the batch instead.
    results.attest = runAttestSuite({
      batch: args.quick ? 200 : 2000,
      reps: args.quick ? 5 : 25
    });
    printAttestSuite(results.attest);
  }

  if (want('closure')) {
    say('---');
    say('');
    // Not --trials either: this suite's cost is dominated by pure-JS Ed25519 at
    // milliseconds a call, so the dial is repetitions of a handful of expensive
    // operations rather than trials of a cheap one.
    results.closure = runClosureModuleSuite({
      reps: args.quick ? 3 : 15,
      seed: args.seed
    });
    // Asynchronous solely because `crypto.verify` has no synchronous form, and
    // the point of measuring it is that `closure.js` cannot use it.
    results.closureBackends = await runSignatureBackends({ reps: args.quick ? 10 : 40 });
    printClosureModuleSuite(results.closure, results.closureBackends);
  }

  if (want('swarm')) {
    say('---');
    say('');
    // Not --trials: the cost here is the simulation itself, which is quadratic
    // in devices × chunks, so the dial is fleet size and chunk count rather
    // than repetitions. --quick drops the 100-device rows, which are most of
    // the runtime; it also drops the only rows that speak to ADR-024's own
    // hundred-device example, so the report says which dial produced it.
    results.swarm = runSwarmSuite({
      deviceCounts: args.quick ? [2, 10, 25] : [2, 10, 25, 50, 100],
      behaviourAt: args.quick ? [10] : [10, 100],
      seeds: args.quick ? [args.seed, 7] : [7, 1234, 4321, args.seed, 99],
      chunkCounts: args.quick ? [16, 32] : [16, 32, 64, 128],
      crossCheckDevices: args.quick ? 5 : 10
    });
    printSwarmSuite(results.swarm);
  }

  if (want('presence')) {
    say('---');
    say('');
    // Batched rather than trial-counted, for the same reason the attestation
    // suite is: these are microsecond-scale pure functions, so --trials is the
    // wrong dial and --quick moves the batch instead. The coverage sweeps are
    // exhaustive over the module's own vocabularies and do not vary with either.
    results.presence = runPresenceSuite({
      batch: args.quick ? 200 : 2000,
      reps: args.quick ? 5 : 25
    });
    printPresenceSuite(results.presence);
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
