const THRESHOLD = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BASE_MS = 1000;
const CEILING_MS = 60_000;
// One failed login per distinct source IP, never repeated, would otherwise
// grow the Map forever: entries are only evicted when the same IP comes back
// after its window expires. This server is now internet-facing, so a cap.
const MAX_ENTRIES = 10_000;

interface Attempt {
  failures: number;
  at: number;
}

/**
 * Per process and in memory, which is right for one container and one person.
 * A table would survive a restart, and a restart is not the attack.
 */
export class LoginBackoff {
  readonly #now: () => number;
  readonly #attempts = new Map<string, Attempt>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  delayFor(ip: string): number {
    const attempt = this.#current(ip);
    if (attempt === null || attempt.failures < THRESHOLD) return 0;
    const steps = attempt.failures - THRESHOLD;
    return Math.min(BASE_MS * 2 ** steps, CEILING_MS);
  }

  recordFailure(ip: string): void {
    const attempt = this.#current(ip);
    if (!attempt && this.#attempts.size >= MAX_ENTRIES) this.#evict();
    this.#attempts.set(ip, {
      failures: (attempt?.failures ?? 0) + 1,
      at: this.#now(),
    });
  }

  recordSuccess(ip: string): void {
    this.#attempts.delete(ip);
  }

  /** Exposed for the cap test; nothing in the request path reads it. */
  get size(): number {
    return this.#attempts.size;
  }

  /**
   * There is no timer to hang a sweep on for one small server, so it rides
   * along on the failure path instead: sweep expired windows first, and if the
   * Map is still at the cap after that, drop the single oldest entry. A recent
   * offender's count always survives, because it cannot be the oldest.
   */
  #evict(): void {
    const at = this.#now();
    for (const [ip, attempt] of this.#attempts) {
      if (at - attempt.at > WINDOW_MS) this.#attempts.delete(ip);
    }
    if (this.#attempts.size < MAX_ENTRIES) return;
    const oldest = this.#attempts.keys().next();
    if (!oldest.done) this.#attempts.delete(oldest.value);
  }

  /** Null once the window has passed, which is how the count decays. */
  #current(ip: string): Attempt | null {
    const attempt = this.#attempts.get(ip);
    if (!attempt) return null;
    if (this.#now() - attempt.at > WINDOW_MS) {
      this.#attempts.delete(ip);
      return null;
    }
    return attempt;
  }
}
