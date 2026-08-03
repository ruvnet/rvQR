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
  const files = [
    'artifacts/core.js',
    'artifacts/fountain.js',
    'artifacts/delta.js',
    'artifacts/resume.js',
    'artifacts/vendor/qrcode.js',
    'artifacts/vendor/qrdecode.js'
  ];
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

  if (args.json) {
    const out = path.resolve(args.json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    say(`Raw results written to ${out}`);
  }

  return results;
}

main();
