/**
 * Time-decayed exponentially weighted mean and variance.
 *
 *   lambda = exp(-dt / tau)
 *   mu_t     = lambda * mu_{t-1} + (1 - lambda) * x_t
 *   sigma2_t = lambda * sigma2_{t-1} + (1 - lambda) * (x_t - mu_{t-1})^2
 *
 * O(1) per update and per ticker, which is what makes 8k symbols at 1 Hz
 * affordable. Using dt-based lambda (rather than a fixed per-sample lambda)
 * keeps the time constant honest when a ticker goes quiet for a while.
 */
export class Ewma {
  mean = 0;
  variance = 0;
  count = 0;
  private lastT = 0;

  tau: number;

  constructor(tau: number) {
    this.tau = tau;
  }

  push(x: number, t: number): void {
    if (!Number.isFinite(x)) return;
    if (this.count === 0) {
      this.mean = x;
      this.variance = 0;
      this.lastT = t;
      this.count = 1;
      return;
    }
    const dt = Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;
    const lambda = Math.exp(-dt / this.tau);
    const prev = this.mean;
    this.mean = lambda * prev + (1 - lambda) * x;
    this.variance = lambda * this.variance + (1 - lambda) * (x - prev) * (x - prev);
    this.count++;
  }

  get sd(): number {
    return Math.sqrt(Math.max(this.variance, 0));
  }

  /** Standardized score. Returns 0 until the estimator has warmed up. */
  z(x: number, sdFloor = 1e-9): number {
    if (this.count < 8) return 0;
    const s = this.sd;
    return s > sdFloor ? (x - this.mean) / s : 0;
  }

  setTau(tau: number): void {
    this.tau = tau;
  }
}
