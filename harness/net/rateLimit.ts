// Token bucket. The server allows 10 intents/s and 150/min per client; we
// refill continuously at `perMinute` with a burst of `burst`.
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number = 8,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
