import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceHistory, FAST_SPAN_SEC, SLOW_STEP_SEC } from '../src/engine/pricehistory.ts';

test('short lookbacks are exact', () => {
  const h = new PriceHistory();
  for (const p of [100, 101, 102, 103, 104]) h.push(p);
  // 104 vs the sample 3 steps back (101)
  assert.equal(h.changeOver(3), 104 / 101 - 1);
  assert.equal(h.changeOver(1), 104 / 103 - 1);
});

test('a lookback longer than the history returns null, not zero', () => {
  const h = new PriceHistory();
  for (let i = 0; i < 30; i++) h.push(100 + i);
  assert.equal(h.changeOver(3600), null, 'an hourly change after 30s must not be fabricated');
  assert.equal(h.changeOver(10), 129 / 119 - 1);
});

test('no history at all reports null rather than a change of zero', () => {
  const h = new PriceHistory();
  assert.equal(h.changeOver(3), null);
  assert.equal(h.last, null);
});

test('long lookbacks resolve from the coarse ring', () => {
  const h = new PriceHistory();
  // 90 minutes of steady 1-per-second pushes, price climbing 1 per minute.
  for (let s = 0; s <= 90 * SLOW_STEP_SEC; s++) h.push(100 + Math.floor(s / SLOW_STEP_SEC));
  const hourAgo = h.changeOver(3600);
  assert.ok(hourAgo !== null, 'an hour of history should answer an hourly lookback');
  // price rose 1 unit per minute: 60 minutes ago it was 60 lower
  assert.ok(Math.abs(hourAgo - (190 / 130 - 1)) < 1e-9, `got ${hourAgo}`);
});

test('the fine ring keeps its full span before falling back to coarse', () => {
  const h = new PriceHistory();
  for (let i = 0; i < FAST_SPAN_SEC + 50; i++) h.push(100);
  assert.equal(h.changeOver(FAST_SPAN_SEC - 1), 0, 'flat prices are a real 0% change');
});

test('zero and negative prices are ignored rather than poisoning the ratio', () => {
  const h = new PriceHistory();
  h.push(100);
  h.push(0);
  h.push(-5);
  h.push(110);
  assert.equal(h.changeOver(1), 110 / 100 - 1, 'bad prints must not become samples');
});

test('reported span grows with the history held', () => {
  const h = new PriceHistory();
  assert.equal(h.spanSec, 0);
  for (let i = 0; i < 11; i++) h.push(100);
  assert.equal(h.spanSec, 10);
});
