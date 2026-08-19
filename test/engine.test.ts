import assert from 'node:assert/strict';
import test from 'node:test';
import { Ewma } from '../src/engine/ewma.ts';
import { RollingWindow, quantileSorted } from '../src/engine/window.ts';
import { percentileRank, topK } from '../src/engine/crosssection.ts';
import { tally, type Member } from '../src/engine/vote.ts';
import { bucketOf, seedShape, BUCKET_COUNT } from '../src/engine/profile.ts';
import { Engine } from '../src/engine/engine.ts';
import { DEFAULT_CONFIG, type Bar } from '../src/types.ts';

test('ewma converges to a constant and reports ~zero dispersion', () => {
  const e = new Ewma(10);
  let t = 0;
  for (let i = 0; i < 500; i++) e.push(7, (t += 1000));
  assert.ok(Math.abs(e.mean - 7) < 1e-6, `mean=${e.mean}`);
  assert.ok(e.sd < 1e-6, `sd=${e.sd}`);
});

test('ewma z-score flags a surge against its own baseline', () => {
  const e = new Ewma(60);
  let t = 0;
  // baseline noise around 100
  for (let i = 0; i < 400; i++) e.push(100 + ((i * 37) % 11) - 5, (t += 1000));
  const z = e.z(160);
  assert.ok(z > 5, `expected a large z for a 60% jump, got ${z}`);
});

test('ewma respects elapsed time, not sample count', () => {
  const fast = new Ewma(10);
  const slow = new Ewma(10);
  fast.push(0, 0);
  slow.push(0, 0);
  fast.push(100, 1_000); // 1 s later
  slow.push(100, 100_000); // 100 s later -> nearly full weight on the new value
  assert.ok(slow.mean > fast.mean * 5, `${slow.mean} vs ${fast.mean}`);
});

test('rolling window: mean, median, MAD, and outlier resistance', () => {
  const w = new RollingWindow(11);
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) w.push(v);
  assert.equal(w.mean, 6);
  assert.equal(w.median(), 6);
  w.push(1000); // evicts 1, median barely moves; the mean does not survive
  assert.equal(w.median(), 7);
  assert.ok(w.mean > 90, `mean=${w.mean} — the mean does not survive one outlier`);
  assert.ok(w.mad() < 5, `mad=${w.mad()} should ignore the outlier`);
});

test('rolling window evicts oldest beyond capacity', () => {
  const w = new RollingWindow(3);
  for (const v of [1, 2, 3, 4, 5]) w.push(v);
  assert.equal(w.size, 3);
  assert.deepEqual(Array.from(w.toArray()), [3, 4, 5]);
  assert.equal(w.last, 5);
});

test('rolling window slope is positive on a ramp, ~zero on noise', () => {
  const up = new RollingWindow(60);
  for (let i = 0; i < 60; i++) up.push(i * 0.01);
  assert.ok(Math.abs(up.slopePerSample(5) - 0.01) < 1e-9);

  const flat = new RollingWindow(60);
  for (let i = 0; i < 60; i++) flat.push(0.5 + ((i * 13) % 7) * 0.001);
  assert.ok(Math.abs(flat.slopePerSample(5)) < 0.002);
});

test('quantileSorted interpolates', () => {
  const a = Float64Array.from([0, 1, 2, 3]);
  assert.equal(quantileSorted(a, 4, 0.5), 1.5);
  assert.equal(quantileSorted(a, 4, 0), 0);
  assert.equal(quantileSorted(a, 4, 1), 3);
});

test('percentile rank bounds a fat tail to 1.0', () => {
  const values = Float64Array.from([0, 1, 2, 3, 40]);
  const active = Int32Array.from([0, 1, 2, 3, 4]);
  const out = new Float64Array(5);
  percentileRank(values, active, 5, out, new Int32Array(5));
  assert.deepEqual(Array.from(out), [0, 0.25, 0.5, 0.75, 1]);
});

test('percentile rank averages ties', () => {
  const values = Float64Array.from([5, 5, 5, 9]);
  const out = new Float64Array(4);
  percentileRank(values, Int32Array.from([0, 1, 2, 3]), 4, out, new Int32Array(4));
  assert.deepEqual(Array.from(out).slice(0, 3), [1 / 3, 1 / 3, 1 / 3]);
  assert.equal(out[3], 1);
});

test('topK returns the k largest, descending', () => {
  const values = Float64Array.from([0.1, 0.9, 0.5, 0.7, 0.3]);
  const got = topK(values, Int32Array.from([0, 1, 2, 3, 4]), 5, 3);
  assert.deepEqual(Array.from(got), [1, 3, 2]);
});

test('ensemble reports full agreement when members agree', () => {
  const n = 6;
  const values = Float64Array.from([0.9, 0.8, 0.7, 0.2, 0.1, 0.05]);
  const slopes = new Float64Array(n);
  const members: Member[] = ['a', 'b', 'c'].map((name) => ({ name, values, slopes }));
  const r = tally(Int32Array.from([0, 1, 2, 3, 4, 5]), n, members, 3, 30);
  assert.equal(r.robust[0], 1);
  assert.equal(r.robust[1], 1);
  assert.equal(r.robust[5], 0);
});

test('ensemble reports partial agreement when members disagree', () => {
  const n = 4;
  const a = Float64Array.from([0.9, 0.1, 0.8, 0.2]);
  const b = Float64Array.from([0.1, 0.9, 0.8, 0.2]);
  const zero = new Float64Array(n);
  const r = tally(
    Int32Array.from([0, 1, 2, 3]),
    n,
    [
      { name: 'a', values: a, slopes: zero },
      { name: 'b', values: b, slopes: zero },
    ],
    1,
    30,
  );
  assert.equal(r.robust[0], 0.5);
  assert.equal(r.robust[1], 0.5);
  assert.equal(r.robust[2], 0);
});

test('ensemble forecast votes UP for a riser', () => {
  const n = 3;
  const values = Float64Array.from([0.5, 0.9, 0.8]);
  const slopes = Float64Array.from([0.02, 0, 0]); // index 0 climbs fast
  const r = tally(Int32Array.from([0, 1, 2]), n, [{ name: 'a', values, slopes }], 2, 30);
  assert.equal(r.pred[0], 1);
  assert.equal(r.predConf[0], 1);
});

test('intraday shape peaks at the open and troughs midday', () => {
  const s = seedShape();
  assert.equal(s.length, BUCKET_COUNT);
  const open = bucketOf(Date.parse('2026-08-17T13:31:00Z')); // 09:31 ET
  const noon = bucketOf(Date.parse('2026-08-17T17:00:00Z')); // 13:00 ET
  const close = bucketOf(Date.parse('2026-08-17T19:55:00Z')); // 15:55 ET
  assert.ok(s[open] > s[noon] * 3, `open=${s[open]} noon=${s[noon]}`);
  assert.ok(s[close] > s[noon], `close=${s[close]} noon=${s[noon]}`);
});

/* ---- end-to-end: the engine must surface the ticker that actually surged ---- */

function bar(sym: string, t: number, price: number, v: number): Bar {
  return { sym, t, o: price, h: price * 1.001, l: price * 0.999, c: price, v, n: Math.round(v / 200), q: 0 };
}

test('engine ranks a volume surge above a quiet peer', () => {
  const engine = new Engine();
  engine.configure({ ...DEFAULT_CONFIG, minPrice: 1, minAdv: 0, topN: 5, thetaIn: 0, thetaOut: 0, windowSec: 30 });
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  let t = Date.parse('2026-08-17T15:00:00Z'); // 11:00 ET, quiet part of the day

  // 200 s of calm to warm the baselines
  for (let i = 0; i < 200; i++) {
    engine.ingest(syms.map((s, k) => bar(s, t, 20 + k, 1000 + ((i * 7 + k) % 50))));
    engine.step(t);
    t += 1000;
  }
  // CCC's volume goes 30x for 20 s
  let snap = engine.step(t);
  for (let i = 0; i < 20; i++) {
    engine.ingest(syms.map((s, k) => bar(s, t, 20 + k + (s === 'CCC' ? i * 0.05 : 0), s === 'CCC' ? 30000 : 1000)));
    snap = engine.step(t);
    t += 1000;
  }
  assert.ok(snap.rows.length > 0, 'expected a published ranking');
  assert.equal(snap.rows[0].sym, 'CCC');
  assert.ok(snap.rows[0].rvol > 5, `rvol=${snap.rows[0].rvol}`);
  assert.ok(snap.rows[0].robust >= 0.6, `robust=${snap.rows[0].robust}`);
  assert.ok(snap.rows[0].score > snap.rows[1].score);
});

test('engine hysteresis stops the top of the list from chattering', () => {
  const engine = new Engine();
  engine.configure({ ...DEFAULT_CONFIG, minPrice: 1, minAdv: 0, topN: 3, windowSec: 30 });
  const syms = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
  let t = Date.parse('2026-08-17T15:00:00Z');
  let churn = 0;
  let steps = 0;
  for (let i = 0; i < 400; i++) {
    engine.ingest(
      syms.map((s, k) => {
        // every ticker gets independent noise; nobody has a real edge, so a
        // naive sort would reshuffle the list constantly
        const noise = 900 + (((i * 31 + k * 17) % 23) - 11) * 40;
        return bar(s, t, 10 + k, noise);
      }),
    );
    const snap = engine.step(t);
    if (i > 250) {
      churn += snap.stats.churn;
      steps++;
    }
    t += 1000;
  }
  const avgChurn = churn / steps;
  assert.ok(avgChurn < 1.0, `mean |rank change| per second was ${avgChurn.toFixed(2)}, expected < 1`);
});

test('engine liquidity floor excludes cheap illiquid names', () => {
  const engine = new Engine();
  engine.configure({ ...DEFAULT_CONFIG, minPrice: 5, minAdv: 500_000, topN: 5, thetaIn: 0, thetaOut: 0 });
  let t = Date.parse('2026-08-17T15:00:00Z');
  for (let i = 0; i < 120; i++) {
    engine.ingest([
      bar('PENNY', t, 2, 50_000), // huge volume but $2
      bar('THIN', t, 50, 5), // expensive but ~117k ADV
      bar('REAL', t, 50, 2_000),
    ]);
    engine.step(t);
    t += 1000;
  }
  const snap = engine.step(t);
  const syms = snap.rows.map((r) => r.sym);
  assert.ok(!syms.includes('PENNY'), 'sub-$5 name should be filtered');
  assert.ok(!syms.includes('THIN'), 'sub-ADV name should be filtered');
  assert.ok(syms.includes('REAL'));
});

test('sorting by change orders the board by the chosen lookback, not the score', () => {
  const engine = new Engine();
  engine.configure({
    ...DEFAULT_CONFIG,
    minPrice: 1,
    minAdv: 0,
    topN: 5,
    windowSec: 30,
    sortBy: 'change',
    sortHorizon: '10s',
  });
  const syms = ['AAA', 'BBB', 'CCC'];
  let t = Date.parse('2026-08-17T15:00:00Z');

  // Warm up flat, so nothing has a change yet.
  for (let i = 0; i < 60; i++) {
    engine.ingest(syms.map((s, k) => bar(s, t, 20 + k, 1000)));
    engine.step(t);
    t += 1000;
  }
  // BBB rises hard over the next 15 s, AAA falls, CCC stays put.
  let snap = engine.step(t);
  for (let i = 1; i <= 15; i++) {
    engine.ingest([
      bar('AAA', t, 20 - i * 0.1, 1000),
      bar('BBB', t, 21 + i * 0.3, 1000),
      bar('CCC', t, 22, 1000),
    ]);
    snap = engine.step(t);
    t += 1000;
  }

  assert.equal(snap.rows[0].sym, 'BBB', 'the biggest riser must lead a change sort');
  assert.equal(snap.rows[snap.rows.length - 1].sym, 'AAA', 'the faller must sit last');
  assert.ok(snap.rows[0].chgSel !== null && snap.rows[0].chgSel > 0, `chgSel=${snap.rows[0].chgSel}`);
  // The score ordering is genuinely different, which is the point of the option.
  assert.ok(snap.rows.some((r, i) => i > 0 && r.score > snap.rows[0].score), 'expected score order to differ');
});

test('a lookback the tape cannot reach yet publishes nothing rather than zeros', () => {
  const engine = new Engine();
  engine.configure({
    ...DEFAULT_CONFIG,
    minPrice: 1,
    minAdv: 0,
    topN: 5,
    windowSec: 30,
    sortBy: 'change',
    sortHorizon: '1h',
  });
  const syms = ['AAA', 'BBB'];
  let t = Date.parse('2026-08-17T15:00:00Z');
  let snap = engine.step(t);
  for (let i = 0; i < 90; i++) {
    engine.ingest(syms.map((s, k) => bar(s, t, 20 + k + i * 0.01, 1000)));
    snap = engine.step(t);
    t += 1000;
  }
  assert.equal(snap.rows.length, 0, 'ninety seconds of tape cannot answer an hourly change');
});

test('long-horizon changes supplied from outside the tape drive the sort', () => {
  const engine = new Engine();
  engine.configure({
    ...DEFAULT_CONFIG,
    minPrice: 1,
    minAdv: 0,
    topN: 5,
    windowSec: 30,
    sortBy: 'change',
    sortHorizon: '1d',
  });
  const syms = ['AAA', 'BBB', 'CCC'];
  let t = Date.parse('2026-08-17T15:00:00Z');
  engine.setLongChanges('1d', { AAA: 0.01, BBB: 0.09, CCC: 0.05 });

  let snap = engine.step(t);
  for (let i = 0; i < 40; i++) {
    engine.ingest(syms.map((s, k) => bar(s, t, 20 + k, 1000)));
    snap = engine.step(t);
    t += 1000;
  }
  assert.deepEqual(
    snap.rows.map((r) => r.sym),
    ['BBB', 'CCC', 'AAA'],
    'daily closes must order the board when the horizon exceeds the tape',
  );
  assert.ok(Math.abs((snap.rows[0].chgSel ?? 0) - 0.09) < 1e-9);
});
