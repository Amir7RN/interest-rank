/** Tiny inline sparkline. Path data only — one string swap per update, no SVG
 *  node churn, which matters when 20+ rows redraw every second. */
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1e-6;
  const step = w / (values.length - 1);
  let d = '';
  for (let i = 0; i < values.length; i++) {
    const x = (i * step).toFixed(1);
    const y = (h - ((values[i] - min) / span) * h).toFixed(1);
    d += (i === 0 ? 'M' : 'L') + x + ' ' + y;
  }
  return d;
}
