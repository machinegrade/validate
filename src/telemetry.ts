/**
 * Funnel telemetry: thin recording helpers around Storage.recordEvent, plus
 * the /stats funnel aggregation.
 */
import { nextEventId, type Storage, type TelemetryEvent } from "./storage.js";

export async function recordKeyIssued(storage: Storage, key: string, email: string): Promise<void> {
  const event: TelemetryEvent = {
    id: nextEventId(),
    type: "key_issued",
    key,
    email,
    timestamp: Date.now(),
  };
  await storage.recordEvent(event);
}

export async function recordCall(
  storage: Storage,
  key: string,
  validator_type: string,
  valid: boolean,
  latency_ms: number
): Promise<void> {
  const event: TelemetryEvent = {
    id: nextEventId(),
    type: "call",
    key,
    validator_type,
    valid,
    latency_ms,
    timestamp: Date.now(),
  };
  await storage.recordEvent(event);
}

export async function recordLimitHit(storage: Storage, key: string): Promise<void> {
  const event: TelemetryEvent = {
    id: nextEventId(),
    type: "limit_hit",
    key,
    timestamp: Date.now(),
  };
  await storage.recordEvent(event);
}

export async function recordPaidRequest(storage: Storage, key: string): Promise<void> {
  const event: TelemetryEvent = {
    id: nextEventId(),
    type: "paid_request",
    key,
    timestamp: Date.now(),
  };
  await storage.recordEvent(event);
}

export interface Funnel {
  keys_issued: number;
  active_callers: number;
  repeat_callers_7d: number;
  limit_hits: number;
  paid_requests: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

function dayBucket(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Compute the funnel counters from raw events. Nothing here is persisted —
 * `/stats` recomputes it on every call, as specified.
 */
export async function computeFunnel(storage: Storage, now: number = Date.now()): Promise<Funnel> {
  const [keyIssuedEvents, callEvents, limitHitEvents, paidRequestEvents] = await Promise.all([
    storage.listEvents({ type: "key_issued" }),
    storage.listEvents({ type: "call" }),
    storage.listEvents({ type: "limit_hit" }),
    storage.listEvents({ type: "paid_request" }),
  ]);

  const activeCallers = new Set(callEvents.map((e) => e.key));

  const since = now - SEVEN_DAYS_MS;
  const daysByKey = new Map<string, Set<string>>();
  for (const event of callEvents) {
    if (event.timestamp < since) continue;
    const bucket = dayBucket(event.timestamp);
    const set = daysByKey.get(event.key) ?? new Set<string>();
    set.add(bucket);
    daysByKey.set(event.key, set);
  }
  let repeatCallers7d = 0;
  for (const days of daysByKey.values()) {
    if (days.size >= 2) repeatCallers7d += 1;
  }

  return {
    keys_issued: keyIssuedEvents.length,
    active_callers: activeCallers.size,
    repeat_callers_7d: repeatCallers7d,
    limit_hits: limitHitEvents.length,
    paid_requests: paidRequestEvents.length,
  };
}
