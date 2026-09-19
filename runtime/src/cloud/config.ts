import type { AgentsApiAuthMode } from "./types.js";

export type CloudCredentials = {
  readonly token: string;
  readonly mode: AgentsApiAuthMode;
};

export type CloudConfig = {
  /** Project regional base URL, e.g. https://acme.nylorun.app */
  readonly baseUrl: string;
  readonly credentials: CloudCredentials;
  /** Optional fetch override (tests / custom runtimes). */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional request-id factory. */
  readonly createRequestId?: () => string;
  /** Optional idempotency-key factory. */
  readonly createIdempotencyKey?: () => string;
};

export type CloudEnv = {
  readonly NYLORUN_MODE?: string;
  readonly NYLORUN_URL?: string;
  readonly NYLORUN_CLOUD_URL?: string;
  readonly NYLORUN_SECRET_KEY?: string;
  readonly NYLORUN_API_KEY?: string;
  readonly NYLORUN_JWT?: string;
  readonly NYLORUN_EXECUTOR_CREDENTIAL?: string;
  readonly NYLORUN_QUIET?: string;
};

export function resolveCloudConfig(
  env: CloudEnv = typeof process === "undefined" ? {} : process.env,
  overrides: Partial<CloudConfig> = {},
): CloudConfig | undefined {
  if (overrides.baseUrl && overrides.credentials)
    return {
      baseUrl: trimSlash(overrides.baseUrl),
      credentials: overrides.credentials,
      fetch: overrides.fetch,
      createRequestId: overrides.createRequestId,
      createIdempotencyKey: overrides.createIdempotencyKey,
    };

  const mode = (env.NYLORUN_MODE ?? "").toLowerCase();
  const baseUrl = trimSlash(
    overrides.baseUrl ?? env.NYLORUN_URL ?? env.NYLORUN_CLOUD_URL ?? "",
  );
  const credentials =
    overrides.credentials ?? resolveCredentials(env);
  if (!baseUrl || !credentials) return undefined;
  if (mode && mode !== "cloud" && !overrides.baseUrl) return undefined;
  // Explicit URL+key without mode still enables cloud when caller passes config,
  // or when NYLORUN_MODE=cloud.
  if (mode !== "cloud" && !overrides.baseUrl) return undefined;
  return {
    baseUrl,
    credentials,
    fetch: overrides.fetch,
    createRequestId: overrides.createRequestId,
    createIdempotencyKey: overrides.createIdempotencyKey,
  };
}

export function isCloudDestination(
  env: CloudEnv = typeof process === "undefined" ? {} : process.env,
  config?: CloudConfig,
): boolean {
  if (config) return true;
  return resolveCloudConfig(env) !== undefined;
}

function resolveCredentials(env: CloudEnv): CloudCredentials | undefined {
  if (env.NYLORUN_SECRET_KEY || env.NYLORUN_API_KEY)
    return {
      token: env.NYLORUN_SECRET_KEY ?? env.NYLORUN_API_KEY!,
      mode: "server_key",
    };
  if (env.NYLORUN_JWT)
    return { token: env.NYLORUN_JWT, mode: "end_user_jwt" };
  if (env.NYLORUN_EXECUTOR_CREDENTIAL)
    return {
      token: env.NYLORUN_EXECUTOR_CREDENTIAL,
      mode: "executor",
    };
  return undefined;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function newIdempotencyKey(): string {
  return `idem_${crypto.randomUUID()}`;
}
