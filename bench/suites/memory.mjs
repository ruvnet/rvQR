/*!
 * Suite 11 — working memory and payload copies.
 *
 * The budget under test: under 128 MiB of working memory and fewer than two
 * full copies of the payload live at once, on the largest artifact in the
 * repository.
 *
 * The measurement runs in a child process under `--expose-gc` — see
 * bench/lib/memprobe.mjs for why both of those are necessary. This file only
 * spawns it, reads the JSON back, and annotates the result with the allocation
 * sites the source actually contains, so a retained-bytes figure can be
 * attributed to code rather than left as a number.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(HERE, '..', 'lib', 'memprobe.mjs');

/**
 * The allocation sites, read out of the source rather than inferred from the
 * numbers. Each entry is what the code does; the measured `copies` column in
 * the probe's output is what it cost. Where the two disagree, the report says
 * which one it believes and why.
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
    site: '`core.assemble` allocates the output buffer; SHA-256 streams over it',
    cost: '1× the artifact; the hash itself is O(1) in space'
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
    site: '`toTransport` appends one character at a time, so V8 leaves a cons-string rope',
    cost: 'nominally ≈1.14× the frame bytes; measured far higher, because an unflattened rope costs a node per concatenation'
  },
  {
    stage: 'v2 receiver: ingest (frames drained)',
    site: '`proto2.fromTransport` allocates a frame buffer; `payload` is a subarray VIEW of it',
    cost: '≈1.04× the artifact — the whole 693-byte frame stays alive behind each 665-byte payload view'
  },
  {
    stage: 'v2 receiver: finalize (assemble + SHA-256)',
    site: '`proto2.assemble` allocates the output buffer',
    cost: '1× the artifact'
  }
];

export function runMemorySuite({ timeoutMs = 120000 } = {}) {
  let raw;
  try {
    raw = execFileSync(process.execPath, ['--expose-gc', PROBE], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (err) {
    return { available: false, reason: `memory probe failed: ${String(err.message || err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, reason: 'memory probe produced unparseable output' };
  }
  if (!parsed.available) return parsed;

  const byStage = new Map(ALLOCATION_SITES.map((s) => [s.stage, s]));
  parsed.stages = parsed.stages.map((s) => ({ ...s, allocation: byStage.get(s.name) || null }));
  parsed.probePath = PROBE;
  return parsed;
}
