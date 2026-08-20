import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displacement,
  edge,
  expectedFalseLabels,
  fitRegime,
  normalCdf,
} from '../src/engine/reversion.ts';

/** Deterministic RNG, so a failure is a real failure and not an unlucky seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Box-Muller on a seeded uniform. */
function gauss(next: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
}

function randomWalk(n: number, seed: number, sigma = 0.001): number[] {
  const g = gauss(rng(seed));
  const out: number[] = [];
  let x = Math.log(100);
  for (let i = 0; i < n; i++) {
    x += sigma * g();
    out.push(Math.exp(x));
  }
  return out;
}

/** Ornstein-Uhlenbeck around a constant mean: the textbook reverting series. */
function reverting(n: number, seed: number, k = 0.25, sigma = 0.001): number[] {
  const g = gauss(rng(seed));
  const mean = Math.log(100);
  const out: number[] = [];
  let x = mean;
  for (let i = 0; i < n; i++) {
    x += k * (mean - x) + sigma * g();
    out.push(Math.exp(x));
  }
  return out;
}

/** Positively autocorrelated returns: moves extend rather than revert. */
function trending(n: number, seed: number, phi = 0.5, sigma = 0.001): number[] {
  const g = gauss(rng(seed));
  const out: number[] = [];
  let x = Math.log(100);
  let r = 0;
  for (let i = 0; i < n; i++) {
    r = phi * r + sigma * g();
    x += r;
    out.push(Math.exp(x));
  }
  return out;
}

test('a random walk is not mistaken for a regime', () => {
  // Across many seeds the statistic must stay near zero. If the Lo-MacKinlay
  // scaling constant were wrong this is the test that catches it.
  let flagged = 0;
  const zs: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const fit = fitRegime(randomWalk(600, seed), { q: 5, barSec: 15 });
    assert.ok(fit, 'a 600-point series should fit');
    zs.push(fit.vrZ);
    if (fit.regime !== 'random') flagged++;
  }
  const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
  assert.ok(Math.abs(mean) < 0.6, `mean vrZ over random walks should sit near 0, got ${mean.toFixed(3)}`);
  // At |z| > 2 a correctly scaled statistic mislabels about 5% of the time.
  assert.ok(flagged <= 6, `expected few false regime labels, got ${flagged}/40`);
});

test('a mean-reverting series is detected as reverting', () => {
  const fit = fitRegime(reverting(600, 7), { q: 5, barSec: 15 });
  assert.ok(fit);
  assert.ok(fit.vr < 1, `variance ratio should be below 1, got ${fit.vr.toFixed(3)}`);
  assert.ok(fit.vrZ < -2, `should be distinguishable from a random walk, got z=${fit.vrZ.toFixed(2)}`);
  assert.equal(fit.regime, 'reverting');
  assert.ok(fit.halfLifeBars !== null && fit.halfLifeBars > 0, 'a reverting series has a half-life');
});

test('a trending series is detected as trending', () => {
  const fit = fitRegime(trending(600, 11), { q: 5, barSec: 15 });
  assert.ok(fit);
  assert.ok(fit.vr > 1, `variance ratio should exceed 1, got ${fit.vr.toFixed(3)}`);
  assert.ok(fit.vrZ > 2, `should be distinguishable from a random walk, got z=${fit.vrZ.toFixed(2)}`);
  assert.equal(fit.regime, 'trending');
});

test('reversion strength is ordered — faster reversion means a shorter half-life', () => {
  const slow = fitRegime(reverting(600, 3, 0.05), { q: 5 });
  const fast = fitRegime(reverting(600, 3, 0.4), { q: 5 });
  assert.ok(slow?.halfLifeBars && fast?.halfLifeBars);
  assert.ok(
    fast.halfLifeBars < slow.halfLifeBars,
    `faster pull should decay sooner: fast=${fast.halfLifeBars.toFixed(1)} slow=${slow.halfLifeBars.toFixed(1)}`,
  );
});

test('too little history yields nothing rather than a fit on noise', () => {
  assert.equal(fitRegime(randomWalk(10, 1), { minSamples: 40 }), null);
  assert.equal(fitRegime([], {}), null);
  // Enough points, but not enough room for overlapping q-windows.
  assert.equal(fitRegime(randomWalk(41, 1), { minSamples: 40, q: 20 }), null);
});

test('a flat line has no regime rather than a divide-by-zero one', () => {
  assert.equal(fitRegime(new Array(200).fill(100), {}), null);
});

test('displacement is signed against the trailing mean and scaled by its own noise', () => {
  const fit = fitRegime(reverting(600, 5), { q: 5 });
  assert.ok(fit);
  const mean = Math.exp(fit.meanLog);

  const below = displacement(mean * 0.98, fit);
  const above = displacement(mean * 1.02, fit);
  assert.ok(below && above);
  assert.ok(below.dev < 0 && below.z < 0, 'a price under the mean is a negative displacement');
  assert.ok(above.dev > 0 && above.z > 0, 'a price over the mean is a positive displacement');
  assert.ok(Math.abs(below.z) > 1, `2% below a tight mean should be several sigma, got ${below.z.toFixed(2)}`);
});

test('edge points back toward the mean and is charged for costs', () => {
  // 2% below the mean: reverting halfway is worth ~1%.
  const up = edge(-0.02, 0.001);
  assert.equal(up.direction, 'up');
  assert.ok(up.expectedMove > 0);
  assert.ok(Math.abs(up.expectedMove - 0.01) < 1e-9);
  assert.ok(Math.abs(up.netEdge - 0.009) < 1e-9, 'round-trip cost comes off the top');

  const down = edge(0.02, 0.001);
  assert.equal(down.direction, 'down');
  assert.ok(down.expectedMove < 0);

  // A move that does not clear the spread is not an opportunity.
  assert.ok(edge(-0.0005, 0.001).netEdge < 0, 'a 5bp deviation cannot pay a 10bp round trip');
});

test('the false-label count reflects the universe being screened', () => {
  // Two-sided |z| > 1.96 is ~5%, so 80 pure-noise names yield about four labels.
  const n = expectedFalseLabels(80, 1.96);
  assert.ok(n > 3 && n < 5, `expected ~4 false labels, got ${n.toFixed(2)}`);
  assert.ok(expectedFalseLabels(80, 3) < expectedFalseLabels(80, 2), 'a stricter cut yields fewer');
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
});
