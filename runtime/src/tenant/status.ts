import type {
  SeedTenantConfigRequest,
  SeedTenantConfigResponse,
  TenantStatus,
} from "@nylorun/core/contracts";
import type { Store } from "../core/store.js";
import type { ExecutorRegistry } from "../core/executors.js";
import type { VaultService } from "../vault/service.js";
import type { SandboxManager } from "../sandbox/manager.js";
import {
  readTenantSetting,
  schemaVersionOf,
  TENANT_SCHEMA_VERSION,
  writeTenantSetting,
} from "./schema.js";
import type { TenantConfig } from "./types.js";
import type { TenantEnvelope } from "@nylorun/core/contracts";

export interface TenantStatusContext {
  envelope: TenantEnvelope;
  config: TenantConfig;
  store: Store;
  registry: ExecutorRegistry;
  vault: VaultService;
  sandbox: SandboxManager;
  closing: boolean;
  modelConfigured: boolean;
  executorStreams: Map<string, Set<unknown>>;
}

/** Build `TenantStatusSchema` with secrets redacted (A14). */
export async function buildTenantStatus(
  ctx: TenantStatusContext,
): Promise<TenantStatus> {
  const sessions = ctx.store.all<{ id: string; status: string }>("sessions");
  const runningSessions = sessions.filter(
    (s) => s.status === "running" || s.status === "runnable",
  ).length;
  const pendingActions = ctx.store
    .all<{ status: string }>("actions")
    .filter((a) => a.status === "pending" || a.status === "claimed").length;
  const uncertainEffects = ctx.store
    .all<{ status: string }>("effects")
    .filter((e) => e.status === "uncertain").length;

  let sqlite = false;
  try {
    ctx.store.db.prepare("SELECT 1").get();
    sqlite = true;
  } catch {
    sqlite = false;
  }

  const schemaOk = schemaVersionOf(ctx.store.db) === TENANT_SCHEMA_VERSION;
  const modelView = ctx.vault.getHostModel();
  const sandboxReport = await ctx.sandbox.report();
  const retained = ctx.store.all("sandboxes").length;

  const definitionIds = new Set(
    ctx.store
      .all<{ manifest?: { id?: string } }>("definitions")
      .map((d) => d.manifest?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const executorIds = new Set(ctx.registry.list().map((e) => e.agentId));
  const agentIds = new Set([...definitionIds, ...executorIds]);
  const agents = [...agentIds].sort().map((agentId) => {
    const record = ctx.registry.get(agentId);
    return {
      agentId,
      registered: definitionIds.has(agentId),
      connected:
        !!record &&
        (ctx.executorStreams.get(record.tokenHash)?.size ?? 0) > 0,
    };
  });

  return {
    tenant: ctx.envelope,
    path: ctx.config.paths.root,
    checks: {
      sqlite,
      scheduler: !ctx.closing,
      model: ctx.modelConfigured || modelView.configured,
      executors: true,
      schema: schemaOk,
    },
    model: modelView,
    agents,
    counts: {
      sessions: sessions.length,
      runningSessions,
      pendingActions,
      uncertainEffects,
    },
    sandbox: {
      backend: sandboxReport.backend,
      retained,
    },
  };
}

/**
 * Insert-if-absent Tenant configuration seed (A18).
 * Response lists field names only; never secret values.
 */
export function seedTenantConfig(
  ctx: {
    store: Store;
    vault: VaultService;
  },
  body: SeedTenantConfigRequest,
): SeedTenantConfigResponse {
  const applied: string[] = [];
  const kept: string[] = [];

  if (body.sandbox?.backend) {
    const existing = readTenantSetting(ctx.store.db, "sandbox.backend");
    if (existing === undefined) {
      writeTenantSetting(ctx.store.db, "sandbox.backend", body.sandbox.backend);
      applied.push("sandbox.backend");
    } else {
      kept.push("sandbox.backend");
    }
  }

  if (body.model) {
    const current = ctx.vault.getHostModel();
    if (current.configured) {
      kept.push("model");
    } else {
      ctx.vault.putHostModel({
        requestId: body.requestId,
        idempotencyKey: `seed-model:${body.requestId}`,
        ...body.model,
      });
      applied.push("model");
    }
  }

  return { applied, kept };
}
