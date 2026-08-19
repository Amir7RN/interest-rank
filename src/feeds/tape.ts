/**
 * Pure helpers for replaying historical minute bars as a live-looking tape.
 *
 * Kept separate from the feed itself so the arithmetic that decides what a
 * ticker "did" in a given slice of tape is testable without a network.
 */

/** One vendor minute aggregate. `t` is the *start* of the minute, epoch ms. */
export interface MinuteBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** transactions in the minute */
  n: number;
}

/** The engine's bar, minus the symbol the caller already knows. */
export interface TapeSlice {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
}

export const MINUTE_MS = 60_000;

/** `YYYY-MM-DD` for an instant, in US market time rather than the viewer's. */
export function etDate(at: number | Date = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * Candidate session dates, most recent first, skipping weekends.
 *
 * Holidays are not encoded — a holiday simply comes back with no bars and the
 * caller walks to the next candidate, which costs one request and stays correct
 * without shipping a calendar that goes stale.
 */
export function sessionCandidates(from: string, count: number): string[] {
  const out: string[] = [];
  // Parse as UTC noon so the day arithmetic cannot be shifted by a DST edge.
  let ms = Date.parse(`${from}T12:00:00Z`);
  while (out.length < count) {
    ms -= 24 * 60 * 60 * 1000;
    const d = new Date(ms);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Collapse whatever happened in `[from, to)` into a single bar.
 *
 * Volume and trade count are prorated by how much of each minute the interval
 * covers, and the price path is interpolated open-to-close across the minute.
 * The minute's true high and low are only folded in when the interval contains
 * the middle of that minute, so a range expansion registers once rather than
 * once per slice — the same choice the Robinhood feed makes for its 15-second
 * bars, and for the same reason.
 *
 * Sub-minute shape is therefore synthetic: the minute aggregate is real, the
 * path inside it is not.
 *
 * `cursor` is an index into `bars` that the caller carries between calls so a
 * monotonically advancing tape stays O(1) per step. Pass 0 on the first call
 * and the returned cursor thereafter.
 */
export function sliceBars(
  bars: MinuteBar[],
  from: number,
  to: number,
  cursor = 0,
): { slice: TapeSlice | null; cursor: number } {
  let i = Math.max(0, Math.min(cursor, bars.length));
  // Rewind if the caller jumped backwards (a loop back to the tape start).
  while (i > 0 && bars[i - 1].t + MINUTE_MS > from) i--;
  // Skip minutes that ended before the interval opens.
  while (i < bars.length && bars[i].t + MINUTE_MS <= from) i++;

  let v = 0;
  let n = 0;
  let open = 0;
  let close = 0;
  let high = -Infinity;
  let low = Infinity;
  let touched = false;

  for (let j = i; j < bars.length; j++) {
    const b = bars[j];
    if (b.t >= to) break;
    const ov0 = Math.max(from, b.t);
    const ov1 = Math.min(to, b.t + MINUTE_MS);
    if (ov1 <= ov0) continue;

    const frac = (ov1 - ov0) / MINUTE_MS;
    const at = (ms: number) => b.o + (b.c - b.o) * ((ms - b.t) / MINUTE_MS);
    const a = at(ov0);
    const z = at(ov1);

    if (!touched) {
      open = a;
      touched = true;
    }
    close = z;
    v += b.v * frac;
    n += b.n * frac;

    const mid = b.t + MINUTE_MS / 2;
    const spansMid = ov0 <= mid && mid < ov1;
    high = Math.max(high, spansMid ? b.h : Math.max(a, z));
    low = Math.min(low, spansMid ? b.l : Math.min(a, z));
  }

  if (!touched) return { slice: null, cursor: i };
  return {
    slice: { o: open, h: high, l: low, c: close, v, n: Math.max(v > 0 ? 1 : 0, Math.round(n)) },
    cursor: i,
  };
}
