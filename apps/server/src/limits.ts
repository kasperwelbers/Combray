/** Fixed-window rate limits, in memory. Keys (client IPs, email hashes) are never stored or logged. */
export class RateLimit {
  private windows = new Map<string, { start: number; count: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowSecs: number) {
    this.max = max;
    this.windowMs = windowSecs * 1000;
  }

  /** Count one request for `key`. Returns the seconds to wait when the window is full. */
  hit(key: string): number | undefined {
    const now = Date.now();
    if (this.windows.size > 100_000) {
      for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
    }
    if (entry.count >= this.max) return Math.max(1, Math.floor((this.windowMs - (now - entry.start)) / 1000));
    entry.count += 1;
    return undefined;
  }
}
