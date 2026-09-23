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
export interface ExecutorRow {
  agentId: string;
  tokenHash: string;
  implementationVersion: string;
  manifestHash?: string;
  createdAt: string;
  updatedAt: string;
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
      CREATE TABLE IF NOT EXISTS sandboxes(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS vaults(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user'
      );
      CREATE INDEX IF NOT EXISTS vaults_owner ON vaults(owner_user_id);
      CREATE TABLE IF NOT EXISTS vault_credentials(
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        kek_id TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        wrapped_dek BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vault_credentials_vault ON vault_credentials(vault_id);
      CREATE TABLE IF NOT EXISTS vault_audit(
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        vault_id TEXT,
        credential_id TEXT,
        session_id TEXT,
        target TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_idempotency(
        id TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        response TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executors(
        agent_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        implementation_version TEXT NOT NULL,
        manifest_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    migrateVaultScope(this.db);
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
  delete(table: string, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  // Executors carry a bearer secret, so they use typed columns with a database-enforced unique
  // token hash instead of flowing through the generic JSON document helpers above.
  allExecutors(): ExecutorRow[] {
    return this.db
      .prepare(
        "SELECT agent_id,token_hash,implementation_version,manifest_hash,created_at,updated_at FROM executors",
      )
      .all()
      .map((r) => ({
        agentId: String(r.agent_id),
        tokenHash: String(r.token_hash),
        implementationVersion: String(r.implementation_version),
        manifestHash: r.manifest_hash == null ? undefined : String(r.manifest_hash),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      }));
  }
  putExecutor(row: Omit<ExecutorRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO executors(agent_id,token_hash,implementation_version,manifest_hash,created_at,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(agent_id) DO UPDATE SET
           token_hash=excluded.token_hash,
           implementation_version=excluded.implementation_version,
           manifest_hash=excluded.manifest_hash,
           updated_at=excluded.updated_at`,
      )
      .run(
        row.agentId,
        row.tokenHash,
        row.implementationVersion,
        row.manifestHash ?? null,
        row.updatedAt,
        row.updatedAt,
      );
  }
  deleteExecutor(agentId: string): void {
    this.db.prepare("DELETE FROM executors WHERE agent_id=?").run(agentId);
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
  credentialCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM vault_credentials")
      .get() as { n: number };
    return Number(row.n);
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

function migrateVaultScope(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(vaults)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "scope"))
    db.exec(
      "ALTER TABLE vaults ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'",
    );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS vaults_one_host ON vaults(scope) WHERE scope = 'host'",
  );
}
