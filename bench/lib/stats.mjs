/*!
 * Summary statistics for the rvQR benchmark harness.
 *
 * Every cell in the results tables is a distribution over trials, never a
 * single run. These are the functions that turn a trial vector into the
 * mean / p50 / p95 / stdev quadruple that gets reported.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Sample standard deviation (n-1 denominator). We are estimating the spread of
 * an underlying process from a finite sample of trials, so Bessel's correction
 * is the right one.
 */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Nearest-rank percentile on the sorted sample: the smallest observed value at
 * or above which q of the sample lies. No interpolation — with integer-valued
 * metrics like "frames observed" an interpolated percentile reports a frame
 * count that never actually occurred.
 */
export function percentile(xs, q) {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(xs) {
  return {
    n: xs.length,
    mean: mean(xs),
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    stdev: stdev(xs),
    min: xs.length ? Math.min(...xs) : NaN,
    max: xs.length ? Math.max(...xs) : NaN
  };
}

/** Harmonic number H_n, the coupon-collector constant. Exact for small n. */
export function harmonic(n) {
  let h = 0;
  for (let i = 1; i <= n; i++) h += 1 / i;
  return h;
}

export function fmt(x, digits = 1) {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

/** Renders an array of row objects as a GitHub-flavoured markdown table. */
export function markdownTable(headers, rows) {
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const row of rows) lines.push('| ' + row.join(' | ') + ' |');
  return lines.join('\n');
}
