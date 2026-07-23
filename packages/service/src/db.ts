import Database from "better-sqlite3";

export interface DomainEvent {
  id: string;
  type: string;
  blockNumber: bigint | null;
  payload: Record<string, string>;
  at: number;
}

export interface Endpoint { id: number; url: string; secret: string }

export interface EndpointAdmin {
  id: number;
  url: string;
  secretPreview: string;
  paused: boolean;
  createdAtKnown: false;
}

export type DeliveryStatus = "delivered" | "retrying" | "pending" | "dead";

export interface DeliveryAdmin {
  eventId: string;
  endpointId: number;
  url: string;
  type: string;
  attempts: number;
  lastStatus: number | null;
  nextAttemptAt: number | null;
  deliveredAt: number | null;
  status: DeliveryStatus;
}

export interface DueDelivery {
  eventId: string;
  endpointId: number;
  attempts: number;
  url: string;
  secret: string;
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  block_number BIGINT,
  payload TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, last_block TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  delivered_at BIGINT,
  last_status INTEGER,
  PRIMARY KEY (event_id, endpoint_id)
);
CREATE TABLE IF NOT EXISTS subs (sub_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS at_risk_emitted (
  sub_id TEXT NOT NULL,
  next_charge_at BIGINT NOT NULL,
  PRIMARY KEY (sub_id, next_charge_at)
);
`;

export interface InsertEventSideEffects {
  trackSub?: string;
  deactivateSub?: string;
}

// Single source of truth for delivery status derivation (Global Constraints):
//   delivered: delivered_at set
//   retrying:  next_attempt_at set, attempts >= 1
//   pending:   next_attempt_at set, attempts 0
//   dead:      delivered_at null AND next_attempt_at null
const DELIVERY_STATUS_CASE = `
  CASE
    WHEN d.delivered_at IS NOT NULL THEN 'delivered'
    WHEN d.next_attempt_at IS NOT NULL AND d.attempts >= 1 THEN 'retrying'
    WHEN d.next_attempt_at IS NOT NULL THEN 'pending'
    ELSE 'dead'
  END
`;

export class Store {
  private db: Database.Database;
  private readonly insertEventTx: (e: DomainEvent, sideEffects?: InsertEventSideEffects) => boolean;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.ensurePausedColumn();
    this.insertEventTx = this.db.transaction((e: DomainEvent, sideEffects?: InsertEventSideEffects): boolean => {
      const res = this.db
        .prepare("INSERT OR IGNORE INTO events (id, type, block_number, payload, at) VALUES (?, ?, ?, ?, ?)")
        .run(e.id, e.type, e.blockNumber === null ? null : e.blockNumber.toString(), JSON.stringify(e.payload), e.at);
      if (res.changes === 0) return false;
      const enqueue = this.db.prepare(
        "INSERT OR IGNORE INTO deliveries (event_id, endpoint_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
      );
      for (const ep of this.listEndpoints()) enqueue.run(e.id, ep.id, e.at);
      if (sideEffects?.trackSub !== undefined) {
        this.db
          .prepare("INSERT INTO subs (sub_id, active) VALUES (?, 1) ON CONFLICT(sub_id) DO UPDATE SET active = 1")
          .run(sideEffects.trackSub);
      }
      if (sideEffects?.deactivateSub !== undefined) {
        this.db.prepare("UPDATE subs SET active = 0 WHERE sub_id = ?").run(sideEffects.deactivateSub);
      }
      return true;
    });
  }

  insertEvent(e: DomainEvent, sideEffects?: InsertEventSideEffects): boolean {
    return this.insertEventTx(e, sideEffects);
  }

  getCursor(key: string): bigint | null {
    const row = this.db.prepare("SELECT last_block FROM cursors WHERE key = ?").get(key) as { last_block: string } | undefined;
    return row ? BigInt(row.last_block) : null;
  }

  setCursor(key: string, block: bigint): void {
    this.db
      .prepare("INSERT INTO cursors (key, last_block) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_block = excluded.last_block")
      .run(key, block.toString());
  }

  private ensurePausedColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(endpoints)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "paused")) {
      this.db.exec("ALTER TABLE endpoints ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    }
  }

  addEndpoint(url: string, secret: string): number {
    const res = this.db.prepare("INSERT INTO endpoints (url, secret) VALUES (?, ?)").run(url, secret);
    return Number(res.lastInsertRowid);
  }

  createEndpoint(url: string, secret: string): number {
    return this.addEndpoint(url, secret);
  }

  listEndpoints(): Endpoint[] {
    return this.db.prepare("SELECT id, url, secret FROM endpoints WHERE active = 1").all() as Endpoint[];
  }

  listEndpointsAdmin(): EndpointAdmin[] {
    const rows = this.db
      .prepare("SELECT id, url, secret, paused FROM endpoints ORDER BY id ASC")
      .all() as Array<{ id: number; url: string; secret: string; paused: number }>;
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      secretPreview: `${r.secret.slice(0, 8)}…${r.secret.slice(-2)}`,
      paused: r.paused === 1,
      createdAtKnown: false,
    }));
  }

  deleteEndpoint(id: number): boolean {
    const tx = this.db.transaction((endpointId: number): boolean => {
      this.db.prepare("DELETE FROM deliveries WHERE endpoint_id = ?").run(endpointId);
      const res = this.db.prepare("DELETE FROM endpoints WHERE id = ?").run(endpointId);
      return res.changes > 0;
    });
    return tx(id);
  }

  setEndpointPaused(id: number, paused: boolean): boolean {
    const res = this.db.prepare("UPDATE endpoints SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
    return res.changes > 0;
  }

  rotateEndpointSecret(id: number, secret: string): boolean {
    const res = this.db.prepare("UPDATE endpoints SET secret = ? WHERE id = ?").run(secret, id);
    return res.changes > 0;
  }

  duePending(now: number): DueDelivery[] {
    const rows = this.db
      .prepare(`
        SELECT d.event_id, d.endpoint_id, d.attempts, ep.url, ep.secret, ev.type, ev.payload, ev.at
        FROM deliveries d
        JOIN endpoints ep ON ep.id = d.endpoint_id AND ep.active = 1 AND ep.paused = 0
        JOIN events ev ON ev.id = d.event_id
        WHERE d.delivered_at IS NULL AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
        ORDER BY d.next_attempt_at ASC
      `)
      .all(now) as Array<{
        event_id: string; endpoint_id: number; attempts: number;
        url: string; secret: string; type: string; payload: string; at: number;
      }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      endpointId: r.endpoint_id,
      attempts: r.attempts,
      url: r.url,
      secret: r.secret,
      body: JSON.stringify({ id: r.event_id, type: r.type, at: r.at, data: JSON.parse(r.payload) }),
    }));
  }

  markAttempt(
    eventId: string,
    endpointId: number,
    opts: { ok: boolean; status: number | null; now: number; nextAttemptAt: number | null },
  ): void {
    if (opts.ok) {
      this.db
        .prepare("UPDATE deliveries SET delivered_at = ?, last_status = ?, next_attempt_at = NULL WHERE event_id = ? AND endpoint_id = ?")
        .run(opts.now, opts.status, eventId, endpointId);
    } else {
      this.db
        .prepare("UPDATE deliveries SET attempts = attempts + 1, last_status = ?, next_attempt_at = ? WHERE event_id = ? AND endpoint_id = ?")
        .run(opts.status, opts.nextAttemptAt, eventId, endpointId);
    }
  }

  listDeliveries(opts?: { limit?: number; status?: DeliveryStatus }): DeliveryAdmin[] {
    const raw = opts?.limit ?? 100;
    const n = Number.isFinite(raw as number) ? Math.trunc(raw as number) : 100;
    const limit = Math.min(Math.max(n, 1), 500);
    const rows = (opts?.status
      ? this.db
          .prepare(`
            SELECT d.event_id, d.endpoint_id, ep.url, ev.type, d.attempts, d.last_status, d.next_attempt_at, d.delivered_at,
              ${DELIVERY_STATUS_CASE} AS status
            FROM deliveries d
            JOIN endpoints ep ON ep.id = d.endpoint_id
            JOIN events ev ON ev.id = d.event_id
            WHERE ${DELIVERY_STATUS_CASE} = ?
            ORDER BY ev.at DESC, d.event_id DESC
            LIMIT ?
          `)
          .all(opts.status, limit)
      : this.db
          .prepare(`
            SELECT d.event_id, d.endpoint_id, ep.url, ev.type, d.attempts, d.last_status, d.next_attempt_at, d.delivered_at,
              ${DELIVERY_STATUS_CASE} AS status
            FROM deliveries d
            JOIN endpoints ep ON ep.id = d.endpoint_id
            JOIN events ev ON ev.id = d.event_id
            ORDER BY ev.at DESC, d.event_id DESC
            LIMIT ?
          `)
          .all(limit)
    ) as Array<{
      event_id: string; endpoint_id: number; url: string; type: string; attempts: number;
      last_status: number | null; next_attempt_at: number | null; delivered_at: number | null;
      status: DeliveryStatus;
    }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      endpointId: r.endpoint_id,
      url: r.url,
      type: r.type,
      attempts: r.attempts,
      lastStatus: r.last_status,
      nextAttemptAt: r.next_attempt_at,
      deliveredAt: r.delivered_at,
      status: r.status,
    }));
  }

  reviveDelivery(eventId: string, endpointId: number, now: number): boolean {
    const res = this.db
      .prepare("UPDATE deliveries SET next_attempt_at = ? WHERE event_id = ? AND endpoint_id = ? AND delivered_at IS NULL")
      .run(now, eventId, endpointId);
    return res.changes > 0;
  }

  trackSub(subId: string): void {
    this.db.prepare("INSERT INTO subs (sub_id, active) VALUES (?, 1) ON CONFLICT(sub_id) DO UPDATE SET active = 1").run(subId);
  }

  deactivateSub(subId: string): void {
    this.db.prepare("UPDATE subs SET active = 0 WHERE sub_id = ?").run(subId);
  }

  listActiveSubs(): string[] {
    return (this.db.prepare("SELECT sub_id FROM subs WHERE active = 1").all() as Array<{ sub_id: string }>).map((r) => r.sub_id);
  }

  markAtRiskEmitted(subId: string, nextChargeAt: number): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO at_risk_emitted (sub_id, next_charge_at) VALUES (?, ?)")
      .run(subId, nextChargeAt);
    return res.changes > 0;
  }

  latestAttentionPeriod(subId: string): string | null {
    const row = this.db
      .prepare(`
        SELECT payload
        FROM events
        WHERE type IN ('subscription.at_risk', 'payment.attempt_failed', 'payment.overdue')
          AND json_extract(payload, '$.subId') = ?
        ORDER BY at DESC, id DESC
        LIMIT 1
      `)
      .get(subId) as { payload: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload) as Record<string, string>;
    return payload.nextChargeAt ?? null;
  }

  listRecentEvents(opts?: { limit?: number; type?: string }): DomainEvent[] {
    const raw = opts?.limit ?? 100;
    const n = Number.isFinite(raw) ? Math.trunc(raw as number) : 100;
    const limit = Math.min(Math.max(n, 1), 500);
    const rows = (opts?.type
      ? this.db
          .prepare("SELECT id, type, block_number, payload, at FROM events WHERE type = ? ORDER BY at DESC, id DESC LIMIT ?")
          .safeIntegers(true)
          .all(opts.type, limit)
      : this.db
          .prepare("SELECT id, type, block_number, payload, at FROM events ORDER BY at DESC, id DESC LIMIT ?")
          .safeIntegers(true)
          .all(limit)
    ) as Array<{ id: string; type: string; block_number: number | bigint | null; payload: string; at: number | bigint }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      blockNumber: r.block_number === null ? null : BigInt(r.block_number),
      payload: JSON.parse(r.payload),
      at: Number(r.at),
    }));
  }

  close(): void {
    this.db.close();
  }
}
