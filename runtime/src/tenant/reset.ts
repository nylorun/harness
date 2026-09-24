import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.js";
import type { ExecutorRegistry } from "../core/executors.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { TenantPaths } from "./types.js";

export type ResetScope = "sessions" | "sandboxes" | "all";

export interface ResetTenantContext {
  store: Store;
  registry: ExecutorRegistry;
  sandbox: SandboxManager;
  paths: TenantPaths;
  /** Clear in-memory session observers after DB wipe. */
  clearSessionState: () => void;
  /** Clear executor SSE streams when registrations are removed. */
  clearExecutorStreams: () => void;
}

const SESSION_TABLES = [
  "sessions",
  "commands",
  "checkpoints",
  "effects",
  "actions",
] as const;

/**
 * Rename `dir` to a sibling, delete the sibling, recreate an empty `dir`.
 * Failure before rename leaves the original intact; after rename the empty
 * target is restored so the Tenant layout stays valid (A17).
 */
function replaceDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const sibling = `${dir}.resetting`;
  if (existsSync(sibling)) rmSync(sibling, { recursive: true, force: true });
  renameSync(dir, sibling);
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(sibling, { recursive: true, force: true });
  } catch (error) {
    // Best-effort restore if recreation failed.
    if (!existsSync(dir) && existsSync(sibling)) {
      try {
        renameSync(sibling, dir);
      } catch {
        /* leave sibling for operator inspection */
      }
    }
    throw error;
  }
}

function clearSessionTables(store: Store): void {
  for (const table of SESSION_TABLES) {
    store.db.prepare(`DELETE FROM ${table}`).run();
  }
  store.db.prepare("DELETE FROM events").run();
}

function clearSandboxRows(store: Store): void {
  store.db.prepare("DELETE FROM sandboxes").run();
}

function clearDefinitions(store: Store): void {
  store.db.prepare("DELETE FROM definitions").run();
}

function clearExecutors(store: Store, registry: ExecutorRegistry): void {
  for (const row of registry.list()) registry.remove(row.agentId);
  store.db.prepare("DELETE FROM executors").run();
}

/** Delete user-scoped vaults; keep the host vault (model credentials). */
function clearUserVaults(store: Store): void {
  const userVaults = store.db
    .prepare(`SELECT id FROM vaults WHERE scope != 'host'`)
    .all() as { id: string }[];
  for (const vault of userVaults) {
    store.db
      .prepare(`DELETE FROM vault_credentials WHERE vault_id=?`)
      .run(vault.id);
    store.db.prepare(`DELETE FROM vaults WHERE id=?`).run(vault.id);
  }
  // Drop audit / idempotency rows that referenced user vaults only when all.
  // Keep host-model idempotency so seed replay stays stable.
}

/**
 * Reset Tenant durable state for `scope` (A17).
 * Caller must have already drained (`activeWork`). Runs SQLite work in one
 * transaction, then filesystem rename+delete for sandboxes / log as needed.
 */
export async function resetTenant(
  ctx: ResetTenantContext,
  scope: ResetScope,
): Promise<void> {
  const clearSessions = scope === "sessions" || scope === "all";
  const clearSandboxes = scope === "sandboxes" || scope === "all";
  const clearAll = scope === "all";

  if (clearSandboxes) {
    await ctx.sandbox.reconcile(() => false);
  }

  ctx.store.tx(() => {
    if (clearSessions) clearSessionTables(ctx.store);
    if (clearSandboxes) clearSandboxRows(ctx.store);
    if (clearAll) {
      clearDefinitions(ctx.store);
      clearExecutors(ctx.store, ctx.registry);
      clearUserVaults(ctx.store);
    }
  });

  if (clearSessions) ctx.clearSessionState();
  if (clearAll) ctx.clearExecutorStreams();

  if (clearSandboxes) replaceDirectory(ctx.paths.sandboxes);

  if (clearAll) {
    mkdirSync(ctx.paths.logs, { recursive: true });
    const logSibling = join(ctx.paths.logs, "tenant.log.resetting");
    if (existsSync(ctx.paths.log)) {
      if (existsSync(logSibling)) rmSync(logSibling, { force: true });
      renameSync(ctx.paths.log, logSibling);
      try {
        writeFileSync(ctx.paths.log, "");
        rmSync(logSibling, { force: true });
      } catch (error) {
        if (!existsSync(ctx.paths.log) && existsSync(logSibling)) {
          try {
            renameSync(logSibling, ctx.paths.log);
          } catch {
            /* leave sibling */
          }
        }
        throw error;
      }
    } else {
      writeFileSync(ctx.paths.log, "");
    }
  }
}
