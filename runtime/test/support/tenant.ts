import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { hashToken, mintBearerToken } from "../../src/core/executors.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { bootstrapPrincipal } from "../../src/tenant/principals.js";
import { createTenantLogger } from "../../src/tenant/logger.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import {
  openTenantRuntime,
  type TenantOpenHooks,
} from "../../src/tenant/runtime.js";
import { createKekFile } from "../../src/vault/kek.js";
import type { TenantConfig, TenantHandle } from "../../src/tenant/types.js";
import { Store } from "../../src/core/store.js";

export type StartTestTenantOptions = Partial<TenantConfig> & {
  executors?: readonly {
    token: string;
    agentId: string;
    implementationVersion: string;
    manifestHash?: string;
  }[];
  modelProvider?: ModelProvider;
  vaultKek?: Buffer | string | null;
  useHostModel?: boolean;
  /** Reuse an existing Host root (restart tests). */
  hostRoot?: string;
  applicationKey?: string;
  principalId?: string;
  /** When true, close() does not delete the Host root. */
  retainRoot?: boolean;
};

/**
 * Minimal in-process HTTP shim over \`openTenantRuntime\` for runtime tests (§5.5).
 */
export async function startTestTenant(
  options: StartTestTenantOptions = {},
): Promise<{
  url: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  principalId: string;
  headers(key?: string): Record<string, string>;
  root: string;
  handle: TenantHandle;
  close(): Promise<void>;
}> {
  const hostRoot =
    options.hostRoot ?? (await mkdtemp(join(tmpdir(), "nylorun-test-tenant-")));
  const tenantId = options.tenantId ?? newTenantId();
  const paths = options.paths ?? tenantPaths(hostRoot, tenantId);
  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.sandboxes,
    paths.pluginData,
    paths.logs,
  ])
    mkdirSync(dir, { recursive: true });

  const applicationKey = options.applicationKey ?? mintBearerToken();
  const principalId =
    options.principalId ?? `principal_${randomBytes(8).toString("hex")}`;
  const credentialHash = hashToken(applicationKey);
  const now = new Date().toISOString();

  if (!existsSync(paths.envelope)) {
    const envelope: TenantEnvelope = {
      id: tenantId,
      name: "test",
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    writeFileSync(paths.envelope, JSON.stringify(envelope, null, 2) + "\n");
  }

  if (!existsSync(paths.database)) {
    const store = new Store(paths.database, tenantId);
    bootstrapPrincipal(store.db, {
      principalId,
      credentialHash,
      idempotencyKey: `boot-${tenantId}`,
    });
    store.db.close();
  }

  const mode = options.mode ?? "test";
  let model = options.model ?? { kind: "scripted" as const, output: "ok" };
  if (options.useHostModel) model = { kind: "vault" };
  if (
    (model.kind === "fixture" || model.kind === "scripted") &&
    mode === "shared"
  )
    throw new Error("fixture/scripted models require ephemeral or test mode");

  const logger =
    options.logger ?? createTenantLogger({ tenantId, logPath: paths.log });

  const childEnv = options.childEnv ?? {
    // Tests may read ambient PATH; Runtime code must not.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: paths.tmp,
  };

  const config: TenantConfig = {
    tenantId,
    mode,
    paths,
    sandbox: options.sandbox ?? { backend: "virtual" },
    model,
    childEnv,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.vaultFetch === undefined
      ? {}
      : { vaultFetch: options.vaultFetch }),
    logger,
  };

  const hooks: TenantOpenHooks = {
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    createKekIfMissing: true,
  };
  if (options.vaultKek === null) {
    hooks.vaultKek = null;
  } else if (options.vaultKek !== undefined) {
    writeFileSync(
      paths.kek,
      Buffer.isBuffer(options.vaultKek)
        ? options.vaultKek.toString("base64") + "\n"
        : options.vaultKek.endsWith("\n")
          ? options.vaultKek
          : options.vaultKek + "\n",
      { mode: 0o600 },
    );
    hooks.vaultKek = options.vaultKek;
  } else if (!existsSync(paths.kek)) {
    createKekFile(paths.kek);
  }

  const handle = await openTenantRuntime(config, hooks);
  const server = createServer((req, res) => {
    void handle.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("failed to bind test tenant listener");
  const url = `http://127.0.0.1:${address.port}`;

  const headers = (key?: string): Record<string, string> => ({
    authorization: `Bearer ${key ?? applicationKey}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  });

  if (options.executors?.length) {
    const response = await fetch(`${url}/v1/executors`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ executors: options.executors }),
    });
    if (!response.ok)
      throw new Error(
        `Failed to seed test executors: ${response.status} ${await response.text()}`,
      );
  }

  const adminKey = randomBytes(32).toString("hex");
  const retainRoot = options.retainRoot === true || !!options.hostRoot;
  return {
    url,
    tenantId,
    applicationKey,
    adminKey,
    principalId,
    headers,
    root: hostRoot,
    handle,
    async close() {
      await handle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (!retainRoot) await rm(hostRoot, { recursive: true, force: true });
    },
  };
}
