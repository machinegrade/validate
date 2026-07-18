/**
 * Keys + limits: issuing API keys, resolving the caller from X-Api-Key, and
 * enforcing the naive rate limit (60/min) and free-tier monthly limit
 * (500/mo). Both limits are computed from "call" telemetry events already
 * in storage, so there is no separate counter to keep in sync.
 */
import { invalidKeyError, limitExceededError, rateLimitedError } from "./errors.js";
import { recordLimitHit } from "./telemetry.js";
import type { KeyRecord, Storage } from "./storage.js";

export interface AuthConfig {
  /** Free-tier calls allowed per calendar month, per key. Injectable for tests. */
  monthlyLimit: number;
  /** Naive rate limit, calls allowed per rolling 60s window, per key. */
  rateLimitPerMinute: number;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  monthlyLimit: 500,
  rateLimitPerMinute: 60,
};

function randomKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sk_${hex}`;
}

function startOfMonthUtc(timestamp: number): number {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export class AuthService {
  private readonly storage: Storage;
  private readonly config: AuthConfig;

  constructor(storage: Storage, config: AuthConfig = DEFAULT_AUTH_CONFIG) {
    this.storage = storage;
    this.config = config;
  }

  async issueKey(email: string): Promise<string> {
    const key = randomKey();
    await this.storage.createKey({ key, email, created_at: Date.now() });
    return key;
  }

  async requireKey(headerValue: string | undefined | null): Promise<KeyRecord> {
    if (!headerValue) throw invalidKeyError();
    const record = await this.storage.getKey(headerValue);
    if (!record) throw invalidKeyError();
    return record;
  }

  /**
   * Enforce rate limit + monthly limit for `key`. Throws RATE_LIMITED or
   * LIMIT_EXCEEDED (and records a `limit_hit` event in the latter case).
   * Returns the number of calls remaining in the free tier *after* this
   * call is counted, for the X-Calls-Remaining header.
   *
   * Must be called before recording the current call's "call" event.
   */
  async checkLimits(key: string, now: number = Date.now()): Promise<{ remaining: number }> {
    const events = await this.storage.listEvents({ type: "call", key });

    const oneMinuteAgo = now - 60_000;
    const callsLastMinute = events.filter((e) => e.timestamp >= oneMinuteAgo).length;
    if (callsLastMinute >= this.config.rateLimitPerMinute) {
      throw rateLimitedError(this.config.rateLimitPerMinute);
    }

    const monthStart = startOfMonthUtc(now);
    const callsThisMonth = events.filter((e) => e.timestamp >= monthStart).length;
    if (callsThisMonth >= this.config.monthlyLimit) {
      await recordLimitHit(this.storage, key);
      throw limitExceededError(this.config.monthlyLimit);
    }

    return { remaining: this.config.monthlyLimit - callsThisMonth - 1 };
  }
}
