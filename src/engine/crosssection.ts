/**
 * Cross-sectional percentile ranking.
 *
 * Stage 2 of the two-stage normalization: within-ticker z-scores are already
 * comparable in principle, but they have fat tails — a halted microcap can
 * print z = 40 and swamp a weighted sum. Converting to percentile rank inside
 * the active cross-section bounds every input to [0, 1] before the blend.
 */

/**
 * Percentile rank in [0, 1] of each active entry, written into `out` at the
 * same index. Ties share the average rank. Inactive entries are left at 0.
 *
 * @param values  full-universe value array
 * @param active  indices participating in the cross-section
 * @param out     destination, same length as `values`
 * @param order   scratch index array, length >= active.length
 */
export function percentileRank(
  values: Float64Array,
  active: Int32Array,
  n: number,
  out: Float64Array,
  order: Int32Array,
): void {
  if (n === 0) return;
  if (n === 1) {
    out[active[0]] = 0.5;
    return;
  }
  for (let i = 0; i < n; i++) order[i] = active[i];
  const view = order.subarray(0, n);
  view.sort((a, b) => values[a] - values[b]);

  const denom = n - 1;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    const v = values[view[i]];
    while (j < n && values[view[j]] === v) j++;
    // average rank across the tie group
    const avg = (i + j - 1) / 2 / denom;
    for (let k = i; k < j; k++) out[view[k]] = avg;
    i = j;
  }
}

/**
 * Indices of the `k` largest entries of `values` among `active`, descending.
 * Partial selection so the shortlist step stays cheap on a big universe.
 */
export function topK(values: Float64Array, active: Int32Array, n: number, k: number): Int32Array {
  const kk = Math.min(k, n);
  const idx = active.slice(0, n);
  // Full sort is ~n log n; at n <= ~10k this is well under a millisecond and
  // avoids the bookkeeping of a heap. Revisit if the universe grows.
  idx.sort((a, b) => values[b] - values[a]);
  return idx.subarray(0, kk);
}
