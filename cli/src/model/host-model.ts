import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { configureProvider, type PromptedModel } from "./configure.js";

/** Wire shape of GET/PUT `/v1/tenant/model` — local copy so CLI stays off `@nylorun/core`. */
type HostModelView =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly provider: string;
      readonly model: string;
      readonly authType: "api_key" | "oauth";
      readonly baseUrl?: string;
    };

function tenantHeaders(serverKey: string): Record<string, string> {
  const tenant = process.env.NYLORUN_TENANT?.trim();
  if (!tenant) {
    throw new Error(
      "Set NYLORUN_TENANT (or pass tenant via Project link) before calling Tenant model routes",
    );
  }
  return {
    authorization: `Bearer ${serverKey}`,
    "Nylorun-Tenant": tenant,
    "Nylorun-Protocol": "2",
  };
}

export async function getHostModel(
  runtimeUrl: string,
  serverKey: string,
): Promise<HostModelView> {
  const response = await fetch(`${runtimeUrl}/v1/tenant/model`, {
    headers: tenantHeaders(serverKey),
  });
  if (!response.ok)
    throw new Error(`Runtime model status returned ${response.status}`);
  return response.json() as Promise<HostModelView>;
}

export async function putHostModel(
  runtimeUrl: string,
  serverKey: string,
  model: PromptedModel,
): Promise<HostModelView> {
  const response = await fetch(`${runtimeUrl}/v1/tenant/model`, {
    method: "PUT",
    headers: {
      ...tenantHeaders(serverKey),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: model.provider,
      model: model.model,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      auth: model.auth,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  if (!response.ok)
    throw new Error(
      body.message ?? `Runtime rejected the model provider (${response.status})`,
    );
  return body as HostModelView;
}

export async function ensureHostModel(options: {
  runtimeUrl: string;
  serverKey: string;
  root?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const current = await getHostModel(options.runtimeUrl, options.serverKey);
  if (current.configured) return;
  const seeded = seedFromProject(options.root ?? process.cwd());
  if (seeded) {
    await putHostModel(options.runtimeUrl, options.serverKey, seeded);
    return;
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompted = await configureProvider({
      root: options.root,
      signal: options.signal,
    });
    await putHostModel(options.runtimeUrl, options.serverKey, prompted);
    return;
  }
  throw new Error(
    "Model provider is not configured. Run nylorun dev in a terminal to set it up, or open Studio.",
  );
}

function seedFromProject(root: string): PromptedModel | undefined {
  const provider = process.env.MODEL_PROVIDER?.trim();
  const model = process.env.MODEL?.trim();
  if (!provider || !model) return undefined;
  const baseUrl = process.env.MODEL_PROVIDER_BASE_URL?.trim();
  const key = process.env.MODEL_PROVIDER_API_KEY;
  const auth = key
    ? ({ type: "api_key", key } as const)
    : legacyCredential(root, provider);
  if (!auth) return undefined;
  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    auth,
  };
}

function legacyCredential(
  root: string,
  provider: string,
): Credential | undefined {
  for (const relative of [".nylorun/auth.json", ".env/auth.json"]) {
    try {
      const all = JSON.parse(readFileSync(join(root, relative), "utf8")) as Record<
        string,
        Credential
      >;
      const credential = all[provider];
      if (credential?.type === "api_key" || credential?.type === "oauth")
        return credential;
    } catch {
      /* A project without a legacy credential file is set up interactively. */
    }
  }
}
