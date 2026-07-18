/**
 * Storage interface + two implementations:
 *  - MemoryStorage: full in-memory implementation, used in dev and tests.
 *  - D1Storage: real Cloudflare D1 binding, backed by schema.sql
 *    (tables `keys`, `events`). Used in production (`wrangler deploy`).
 */

import type { D1Database } from "@cloudflare/workers-types";

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

interface KeyRow {
  key: string;
  email: string;
  created_at: number;
}

interface EventRow {
  id: string;
  type: TelemetryEventType;
  key: string;
  email: string | null;
  validator_type: string | null;
  valid: number | null;
  latency_ms: number | null;
  timestamp: number;
}

function keyRowToRecord(row: KeyRow): KeyRecord {
  return { key: row.key, email: row.email, created_at: row.created_at };
}

function eventRowToRecord(row: EventRow): TelemetryEvent {
  return {
    id: row.id,
    type: row.type,
    key: row.key,
    email: row.email ?? undefined,
    validator_type: row.validator_type ?? undefined,
    valid: row.valid === null ? undefined : row.valid === 1,
    latency_ms: row.latency_ms ?? undefined,
    timestamp: row.timestamp,
  };
}

/** Cloudflare D1 implementation, backed by schema.sql (`keys`, `events`). */
export class D1Storage implements Storage {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async createKey(record: KeyRecord): Promise<void> {
    await this.d1
      .prepare("INSERT INTO keys (key, email, created_at) VALUES (?, ?, ?)")
      .bind(record.key, record.email, record.created_at)
      .run();
  }

  async getKey(key: string): Promise<KeyRecord | null> {
    const row = await this.d1
      .prepare("SELECT key, email, created_at FROM keys WHERE key = ?")
      .bind(key)
      .first<KeyRow>();
    return row ? keyRowToRecord(row) : null;
  }

  async listKeys(): Promise<KeyRecord[]> {
    const { results } = await this.d1.prepare("SELECT key, email, created_at FROM keys").all<KeyRow>();
    return results.map(keyRowToRecord);
  }

  async recordEvent(event: TelemetryEvent): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO events (id, type, key, email, validator_type, valid, latency_ms, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.id,
        event.type,
        event.key,
        event.email ?? null,
        event.validator_type ?? null,
        event.valid === undefined ? null : event.valid ? 1 : 0,
        event.latency_ms ?? null,
        event.timestamp
      )
      .run();
  }

  async listEvents(filter?: EventFilter): Promise<TelemetryEvent[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.type) {
      clauses.push("type = ?");
      params.push(filter.type);
    }
    if (filter?.key) {
      clauses.push("key = ?");
      params.push(filter.key);
    }
    if (filter?.since !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const stmt = this.d1.prepare(
      `SELECT id, type, key, email, validator_type, valid, latency_ms, timestamp FROM events${where} ORDER BY timestamp ASC`
    );
    const { results } = await (params.length > 0 ? stmt.bind(...params) : stmt).all<EventRow>();
    return results.map(eventRowToRecord);
  }
}
