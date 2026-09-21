import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { LiveEvent } from "@nylorun/core/contracts";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => (value as any)[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, sequence);`);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T = any>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  all<T = any>(table: string): T[] {
    return this.db
      .prepare(`SELECT body FROM ${table}`)
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  put(table: string, id: string, body: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      )
      .run(id, JSON.stringify(body));
  }
  event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
  ): LiveEvent {
    const base = {
      eventId: randomUUID(),
      sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      type,
      payload,
    };
    const result = this.db
      .prepare("INSERT INTO events(session_id,body) VALUES(?,?)")
      .run(sessionId, "{}");
    const event = {
      ...base,
      cursor: Buffer.from(`${sessionId}:${result.lastInsertRowid}`).toString(
        "base64url",
      ),
    };
    this.db
      .prepare("UPDATE events SET body=? WHERE sequence=?")
      .run(JSON.stringify(event), result.lastInsertRowid);
    return event;
  }
  history(
    sessionId: string,
    cursor?: string,
  ): { items: LiveEvent[]; cursor: string | null } {
    let sequence = 0;
    if (cursor) {
      const decoded = Buffer.from(cursor, "base64url").toString();
      const prefix = `${sessionId}:`;
      if (
        !decoded.startsWith(prefix) ||
        !/^\d+$/.test(decoded.slice(prefix.length))
      )
        throw new Error("Invalid cursor");
      sequence = Number(decoded.slice(prefix.length));
    }
    const items = this.db
      .prepare(
        "SELECT body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence",
      )
      .all(sessionId, sequence)
      .map((r) => JSON.parse(String(r.body)) as LiveEvent);
    const last = this.db
      .prepare(
        "SELECT body FROM events WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(sessionId);
    return {
      items,
      cursor: last ? JSON.parse(String(last.body)).cursor : null,
    };
  }
}
