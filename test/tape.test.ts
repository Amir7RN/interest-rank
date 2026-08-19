import assert from 'node:assert/strict';
import test from 'node:test';
import { etDate, sessionCandidates, sliceBars, MINUTE_MS, type MinuteBar } from '../src/feeds/tape.ts';

/** One minute starting at `t`, rising 100 -> 110, with a 120 high and an 90 low. */
function minute(t: number, o = 100, c = 110): MinuteBar {
  return { t, o, h: 120, l: 90, c, v: 6000, n: 60 };
}

test('etDate formats US market time as YYYY-MM-DD', () => {
  // 2026-08-18T02:00:00Z is still the 17th in New York.
  assert.equal(etDate(Date.parse('2026-08-18T02:00:00Z')), '2026-08-17');
  assert.equal(etDate(Date.parse('2026-08-18T14:00:00Z')), '2026-08-18');
});

test('sessionCandidates walks backwards and skips weekends', () => {
  // 2026-08-17 is a Monday, so the previous session candidate is Friday the 14th.
  assert.deepEqual(sessionCandidates('2026-08-17', 3), ['2026-08-14', '2026-08-13', '2026-08-12']);
});

test('slicing a whole minute reproduces the minute', () => {
  const bars = [minute(0)];
  const { slice } = sliceBars(bars, 0, MINUTE_MS);
  assert.ok(slice);
  assert.equal(slice.o, 100);
  assert.equal(slice.c, 110);
  assert.equal(slice.h, 120);
  assert.equal(slice.l, 90);
  assert.equal(slice.v, 6000);
  assert.equal(slice.n, 60);
});

test('volume and trades are prorated across sub-minute slices', () => {
  const bars = [minute(0)];
  let v = 0;
  let n = 0;
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const out = sliceBars(bars, i * 10_000, (i + 1) * 10_000, cursor);
    cursor = out.cursor;
    assert.ok(out.slice);
    v += out.slice.v;
    n += out.slice.n;
  }
  assert.equal(v, 6000);
  assert.equal(n, 60);
});

test('the minute high and low land in exactly one slice', () => {
  const bars = [minute(0)];
  let spikes = 0;
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const out = sliceBars(bars, i * 10_000, (i + 1) * 10_000, cursor);
    cursor = out.cursor;
    if (out.slice && out.slice.h === 120 && out.slice.l === 90) spikes++;
  }
  assert.equal(spikes, 1, 'range expansion must register once per minute, not once per slice');
});

test('price is interpolated open-to-close inside the minute', () => {
  const bars = [minute(0)];
  const { slice } = sliceBars(bars, 0, MINUTE_MS / 2);
  assert.ok(slice);
  assert.equal(slice.o, 100);
  assert.equal(slice.c, 105); // halfway from 100 to 110
});

test('a slice wider than a minute aggregates the minutes it spans', () => {
  const bars = [minute(0, 100, 110), minute(MINUTE_MS, 110, 130)];
  const { slice } = sliceBars(bars, 0, 2 * MINUTE_MS);
  assert.ok(slice);
  assert.equal(slice.o, 100);
  assert.equal(slice.c, 130);
  assert.equal(slice.v, 12000);
});

test('gaps in the tape produce no bar rather than a zero-volume one', () => {
  const bars = [minute(0), minute(5 * MINUTE_MS)];
  const { slice } = sliceBars(bars, 2 * MINUTE_MS, 3 * MINUTE_MS);
  assert.equal(slice, null);
});

test('the cursor rewinds when the tape loops back to the start', () => {
  const bars = [minute(0), minute(MINUTE_MS), minute(2 * MINUTE_MS)];
  const far = sliceBars(bars, 2 * MINUTE_MS, 3 * MINUTE_MS, 0);
  const looped = sliceBars(bars, 0, MINUTE_MS, far.cursor);
  assert.ok(looped.slice, 'a stale cursor must not swallow the first minute of the next lap');
  assert.equal(looped.slice.v, 6000);
});
