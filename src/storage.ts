/**
 * Storage interface + two implementations:
 *  - MemoryStorage: full in-memory implementation, used in dev and tests.
 *  - D1Storage: stub for a Cloudflare D1 binding. Methods are present so the
 *    rest of the app can depend on the same interface, but every method
 *    throws until the binding is wired up at deploy time (phase P2).
 */

export type TelemetryEventType = "key_issued" | "call" | "limit_hit" | "paid_request";

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  /** API key this event pertains to (the issued key, or the caller's key). */
  key: string;
  email?: string;
  /** Validator type, only set for "call" events. */
  validator_type?: string;
  /** Verdict validity, only set for "call" events. */
  valid?: boolean;
  latency_ms?: number;
  timestamp: number;
}

export interface KeyRecord {
  key: string;
  email: string;
  created_at: number;
}

export interface EventFilter {
  type?: TelemetryEventType;
  key?: string;
  since?: number;
}

/**
 * Storage abstraction used by the rest of the service. Keep this interface
 * minimal — everything else (limits, rate limiting, funnel stats) is
 * computed on top of it, not baked into it.
 */
export interface Storage {
  createKey(record: KeyRecord): Promise<void>;
  getKey(key: string): Promise<KeyRecord | null>;
  listKeys(): Promise<KeyRecord[]>;

  recordEvent(event: TelemetryEvent): Promise<void>;
  listEvents(filter?: EventFilter): Promise<TelemetryEvent[]>;
}

let idCounter = 0;
export function nextEventId(): string {
  idCounter += 1;
  return `evt_${Date.now().toString(36)}_${idCounter}`;
}

/** Full in-memory implementation. Used in dev and in the test suite. */
export class MemoryStorage implements Storage {
  private keys = new Map<string, KeyRecord>();
  private events: TelemetryEvent[] = [];

  async createKey(record: KeyRecord): Promise<void> {
    this.keys.set(record.key, record);
  }

  async getKey(key: string): Promise<KeyRecord | null> {
    return this.keys.get(key) ?? null;
  }

  async listKeys(): Promise<KeyRecord[]> {
    return [...this.keys.values()];
  }

  async recordEvent(event: TelemetryEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(filter?: EventFilter): Promise<TelemetryEvent[]> {
    let result = this.events;
    if (filter?.type) result = result.filter((e) => e.type === filter.type);
    if (filter?.key) result = result.filter((e) => e.key === filter.key);
    if (filter?.since !== undefined) {
      const since = filter.since;
      result = result.filter((e) => e.timestamp >= since);
    }
    return [...result];
  }

  /** Test-only helper to reset state between test cases. */
  reset(): void {
    this.keys.clear();
    this.events = [];
  }
}

const D1_NOT_WIRED = "D1 storage not wired until deploy";

/**
 * Stub Cloudflare D1 implementation. Present so production code can depend
 * on the `Storage` interface uniformly; actual D1 binding + SQL wiring
 * happens in phase P2 (`wrangler deploy` with a real D1 database bound in
 * wrangler.toml).
 */
export class D1Storage implements Storage {
  private readonly d1: unknown;

  constructor(d1?: unknown) {
    this.d1 = d1;
  }

  async createKey(_record: KeyRecord): Promise<void> {
    throw new Error(D1_NOT_WIRED);
  }

  async getKey(_key: string): Promise<KeyRecord | null> {
    throw new Error(D1_NOT_WIRED);
  }

  async listKeys(): Promise<KeyRecord[]> {
    throw new Error(D1_NOT_WIRED);
  }

  async recordEvent(_event: TelemetryEvent): Promise<void> {
    throw new Error(D1_NOT_WIRED);
  }

  async listEvents(_filter?: EventFilter): Promise<TelemetryEvent[]> {
    throw new Error(D1_NOT_WIRED);
  }
}
