import type { Prediction } from '../types.ts';

/**
 * Ensemble agreement layer.
 *
 * The ranking published to the screen comes from one estimator (the smoothed
 * score). That single number is noisy, so on its own it says nothing about
 * whether a placement is real or an artifact of the smoothing constant. The
 * ensemble runs several deliberately different estimators of the same quantity
 * -- instantaneous, fast-smoothed, slow-smoothed, window mean, window median --
 * and reports:
 *
 *   robust_i = fraction of members that also place i in the top N
 *   pred_i   = majority vote over each member's projected rank change
 *
 * A ticker that every member agrees on is a real attention event; one that only
 * the fast member likes is a smoothing artifact, and the robustness column says
 * so instead of hiding it.
 */

export interface Member {
  name: string;
  /** value per ticker index, higher = more interest */
  values: Float64Array;
  /** per-second trend of `values`, used for the forecast */
  slopes: Float64Array;
}

export interface VoteResult {
  /** ticker index -> fraction of members placing it in top N, 0..1 */
  robust: Float64Array;
  /** ticker index -> majority-vote direction */
  pred: Int8Array; // -1 down, 0 hold, +1 up
  /** ticker index -> fraction of members backing the majority direction */
  predConf: Float64Array;
  /** per-member top-N sets, for diagnostics */
  memberTop: Int32Array[];
}

const scratch: { order: Int32Array } = { order: new Int32Array(0) };

function ranksDesc(candidates: Int32Array, values: Float64Array, out: Int32Array): void {
  const n = candidates.length;
  if (scratch.order.length < n) scratch.order = new Int32Array(n);
  const ord = scratch.order.subarray(0, n);
  ord.set(candidates);
  ord.sort((a, b) => values[b] - values[a]);
  for (let r = 0; r < n; r++) out[ord[r]] = r;
}

/**
 * @param candidates shortlist of ticker indices to score (a few hundred)
 * @param size       full universe length, sizing the output arrays
 * @param topN       list length the vote is about
 * @param horizonSec forecast horizon for the projected ranking
 */
export function tally(
  candidates: Int32Array,
  size: number,
  members: Member[],
  topN: number,
  horizonSec: number,
  /** rank improvement (in places) a member needs to see before it votes UP */
  deadband = 1.5,
): VoteResult {
  const robust = new Float64Array(size);
  const up = new Float64Array(size);
  const down = new Float64Array(size);
  const hold = new Float64Array(size);
  const memberTop: Int32Array[] = [];

  const curRank = new Int32Array(size);
  const projRank = new Int32Array(size);
  const projected = new Float64Array(size);
  const m = members.length || 1;

  for (const mem of members) {
    ranksDesc(candidates, mem.values, curRank);

    for (let i = 0; i < candidates.length; i++) {
      const idx = candidates[i];
      projected[idx] = mem.values[idx] + mem.slopes[idx] * horizonSec;
    }
    ranksDesc(candidates, projected, projRank);

    const top: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const idx = candidates[i];
      if (curRank[idx] < topN) {
        robust[idx] += 1 / m;
        top.push(idx);
      }
      // Rank numbers go the wrong way round: a smaller rank is better, so an
      // improvement is a negative delta.
      const delta = projRank[idx] - curRank[idx];
      if (delta <= -deadband) up[idx] += 1;
      else if (delta >= deadband) down[idx] += 1;
      else hold[idx] += 1;
    }
    top.sort((a, b) => curRank[a] - curRank[b]);
    memberTop.push(Int32Array.from(top));
  }

  const pred = new Int8Array(size);
  const predConf = new Float64Array(size);
  for (let i = 0; i < candidates.length; i++) {
    const idx = candidates[i];
    const u = up[idx];
    const d = down[idx];
    const h = hold[idx];
    const best = Math.max(u, d, h);
    pred[idx] = best === u && u > d ? 1 : best === d && d > u ? -1 : 0;
    predConf[idx] = best / m;
  }

  return { robust, pred, predConf, memberTop };
}

export function predLabel(v: number): Prediction {
  return v > 0 ? 'UP' : v < 0 ? 'DOWN' : 'HOLD';
}
