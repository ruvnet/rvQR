/*!
 * A very small ASCII line plot, for the one figure in this report that is
 * genuinely easier to read as a shape than as a table: frames observed versus
 * loss rate, baseline against fountain.
 *
 * Deliberately plain characters — the output goes into a markdown code fence in
 * docs/benchmarks.md and has to survive being read in a terminal, on GitHub,
 * and in a diff.
 *
 * MIT License. Copyright (c) 2026 rUv.
 */

/**
 * @param {Array<{label:string, mark:string, points:number[]}>} series
 * @param {string[]} xLabels one per point
 * @param {object} opts { height, colWidth, yLabel, xLabel }
 */
export function asciiPlot(series, xLabels, opts = {}) {
  const height = opts.height || 18;
  const colWidth = opts.colWidth || 8;
  const gutter = 7;

  const all = series.flatMap((s) => s.points);
  const yMax = Math.max(...all);
  const yMin = 0;
  const n = xLabels.length;
  const width = (n - 1) * colWidth + 1;

  // Blank canvas, then paint each series onto it. Later series win a shared
  // cell, so the legend lists them in painting order.
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));

  const rowFor = (v) => {
    const t = (v - yMin) / (yMax - yMin || 1);
    return Math.min(height - 1, Math.max(0, Math.round((1 - t) * (height - 1))));
  };

  for (const s of series) {
    for (let i = 0; i < n; i++) {
      const col = i * colWidth;
      const row = rowFor(s.points[i]);
      grid[row][col] = s.mark;
      // Join consecutive points with a straight run so the trend is visible
      // even where the two series are far apart vertically.
      if (i < n - 1) {
        const nextRow = rowFor(s.points[i + 1]);
        for (let c = col + 1; c < col + colWidth; c++) {
          const frac = (c - col) / colWidth;
          const r = Math.round(row + (nextRow - row) * frac);
          if (grid[r][c] === ' ') grid[r][c] = '.';
        }
      }
    }
  }

  const lines = [];
  for (let r = 0; r < height; r++) {
    // Label the axis at the top, the bottom and the midpoint only; a number on
    // every row is noise at this size.
    let tick = '';
    if (r === 0) tick = String(Math.round(yMax));
    else if (r === height - 1) tick = String(yMin);
    else if (r === Math.floor((height - 1) / 2)) tick = String(Math.round(yMax / 2));
    lines.push(tick.padStart(gutter - 2) + ' |' + grid[r].join(''));
  }
  lines.push(' '.repeat(gutter - 1) + '+' + '-'.repeat(width));

  let axis = ' '.repeat(gutter);
  for (let i = 0; i < n; i++) {
    const lbl = xLabels[i];
    const target = gutter + i * colWidth;
    const start = Math.max(axis.length, target - Math.floor(lbl.length / 2));
    axis = axis.padEnd(start) + lbl;
  }
  lines.push(axis);

  if (opts.xLabel) lines.push(' '.repeat(gutter) + opts.xLabel);
  lines.push('');
  for (const s of series) lines.push(`  ${s.mark} = ${s.label}`);
  if (opts.yLabel) lines.push(`  y axis: ${opts.yLabel}`);

  return lines.join('\n');
}
