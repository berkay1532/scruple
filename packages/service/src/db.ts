import Database from "better-sqlite3";

export interface DomainEvent {
  id: string;
  type: string;
  blockNumber: bigint | null;
  payload: Record<string, string>;
  at: number;
}

export interface Endpoint { id: number; url: string; secret: string }

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

export class Store {
  private db: Database.Database;
  private readonly insertEventTx: (e: DomainEvent) => boolean;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.insertEventTx = this.db.transaction((e: DomainEvent): boolean => {
      const res = this.db
        .prepare("INSERT OR IGNORE INTO events (id, type, block_number, payload, at) VALUES (?, ?, ?, ?, ?)")
        .run(e.id, e.type, e.blockNumber === null ? null : e.blockNumber.toString(), JSON.stringify(e.payload), e.at);
      if (res.changes === 0) return false;
      const enqueue = this.db.prepare(
        "INSERT OR IGNORE INTO deliveries (event_id, endpoint_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
      );
      for (const ep of this.listEndpoints()) enqueue.run(e.id, ep.id, e.at);
      return true;
    });
  }

  insertEvent(e: DomainEvent): boolean {
    return this.insertEventTx(e);
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

  addEndpoint(url: string, secret: string): number {
    const res = this.db.prepare("INSERT INTO endpoints (url, secret) VALUES (?, ?)").run(url, secret);
    return Number(res.lastInsertRowid);
  }

  listEndpoints(): Endpoint[] {
    return this.db.prepare("SELECT id, url, secret FROM endpoints WHERE active = 1").all() as Endpoint[];
  }

  duePending(now: number): DueDelivery[] {
    const rows = this.db
      .prepare(`
        SELECT d.event_id, d.endpoint_id, d.attempts, ep.url, ep.secret, ev.type, ev.payload, ev.at
        FROM deliveries d
        JOIN endpoints ep ON ep.id = d.endpoint_id AND ep.active = 1
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

  close(): void {
    this.db.close();
  }
}
