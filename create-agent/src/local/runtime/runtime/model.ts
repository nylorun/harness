import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { readDotenv, resolveCredential, type ResolvedCredential } from "./credentials.js";

export const OPENROUTER_VARIABLE = "OPENROUTER_API_KEY";
export const MODEL_GATEWAY_URL_VARIABLE = "NYLO_MODEL_GATEWAY_URL";
export const MODEL_GATEWAY_API_KEY_VARIABLE = "NYLO_MODEL_GATEWAY_API_KEY";
export const MODEL_GATEWAY_PROTOCOL_VARIABLE = "NYLO_MODEL_GATEWAY_PROTOCOL";
export const MODEL_GATEWAY_ACCESS_MODE_VARIABLE = "NYLO_MODEL_GATEWAY_ACCESS_MODE";
const LEGACY_BASE_URL_VARIABLE = "NYLO_PROVIDER_BASE_URL";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const MODEL_GATEWAY_PROTOCOLS = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages"
] as const;

export type ModelGatewayProtocol = (typeof MODEL_GATEWAY_PROTOCOLS)[number];
export type ModelAccessMode = "external-gateway" | "direct-inference-provider" | "private-or-local-endpoint";
export type ModelConnectionCapabilities = Readonly<{
  portableHistory: true;
  providerState: false;
  hostedTools: false;
}>;

const PORTABLE_HISTORY_CAPABILITIES: ModelConnectionCapabilities = Object.freeze({
  portableHistory: true,
  providerState: false,
  hostedTools: false
});

const DIRECT: Readonly<Record<string, Readonly<{ baseUrl: string; variable: string; protocol: ModelGatewayProtocol; credentialHeader?: string; credentialPrefix?: string }>>> = Object.freeze({
  openai: { baseUrl: "https://api.openai.com/v1", variable: "OPENAI_API_KEY", protocol: "openai-chat-completions" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", variable: "GROQ_API_KEY", protocol: "openai-chat-completions" },
  mistralai: { baseUrl: "https://api.mistral.ai/v1", variable: "MISTRAL_API_KEY", protocol: "openai-chat-completions" },
  deepseek: { baseUrl: "https://api.deepseek.com", variable: "DEEPSEEK_API_KEY", protocol: "openai-chat-completions" },
  xai: { baseUrl: "https://api.x.ai/v1", variable: "XAI_API_KEY", protocol: "openai-chat-completions" },
  togethercomputer: { baseUrl: "https://api.together.xyz/v1", variable: "TOGETHER_API_KEY", protocol: "openai-chat-completions" },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    variable: "ANTHROPIC_API_KEY",
    protocol: "anthropic-messages",
    credentialHeader: "x-api-key",
    credentialPrefix: ""
  }
});

const LOCAL_ORIGINS = Object.freeze([
  { baseUrl: "http://127.0.0.1:1234/v1", route: "local-lm-studio" as const },
  { baseUrl: "http://127.0.0.1:11434/v1", route: "local-ollama" as const }
]);

export type ResolvedModel = Readonly<{
  model: string;
  upstreamModel: string;
  baseUrl: string;
  route: "model-gateway" | "openrouter" | "direct" | "local-lm-studio" | "local-ollama";
  accessMode: ModelAccessMode;
  protocol: ModelGatewayProtocol;
  capabilities: ModelConnectionCapabilities;
  credential?: ResolvedCredential;
  credentialVariables: readonly string[];
  credentialRequired: boolean;
  credentialHeader: string;
  credentialPrefix: string;
  headers: Readonly<Record<string, string>>;
  requestIdHeader?: string;
  /** The deprecated base-url alias is accepted for one release and reported at readiness. */
  deprecatedConfiguration?: "NYLO_PROVIDER_BASE_URL";
}>;

export type ResolveModelOptions = Readonly<{
  projectRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}>;

export async function resolveModel(model: string, options: ResolveModelOptions): Promise<ResolvedModel> {
  const settings = await settingsFor(options);
  const separator = model.indexOf("/");
  const creator = separator > 0 ? model.slice(0, separator) : "";
  const suffix = separator > 0 ? model.slice(separator + 1) : "";
  // `local/<model>` is deliberately non-portable authoring identity. The local endpoint receives
  // its actual loaded-model name, never the reserved Nylorun `local/` prefix.
  const upstreamModel = creator === "local" ? suffix : model;
  const configuredGatewayUrl = settings.get(MODEL_GATEWAY_URL_VARIABLE);
  const legacyGatewayUrl = settings.get(LEGACY_BASE_URL_VARIABLE);
  const gatewayUrl = configuredGatewayUrl || legacyGatewayUrl;
  if (gatewayUrl !== undefined && gatewayUrl !== "") {
    const credential = await resolveCredential([MODEL_GATEWAY_API_KEY_VARIABLE], options);
    const requestIdHeader = settings.get("NYLO_MODEL_GATEWAY_REQUEST_ID_HEADER");
    const protocol = parseProtocol(settings.get(MODEL_GATEWAY_PROTOCOL_VARIABLE));
    const accessMode = parseAccessMode(settings.get(MODEL_GATEWAY_ACCESS_MODE_VARIABLE), gatewayUrl);
    return Object.freeze({
      model,
      upstreamModel,
      baseUrl: gatewayUrl,
      route: "model-gateway",
      accessMode,
      protocol,
      capabilities: PORTABLE_HISTORY_CAPABILITIES,
      ...(credential === undefined ? {} : { credential }),
      credentialVariables: Object.freeze([MODEL_GATEWAY_API_KEY_VARIABLE]),
      credentialRequired: false,
      credentialHeader: settings.get("NYLO_MODEL_GATEWAY_AUTH_HEADER") || "authorization",
      credentialPrefix: settings.get("NYLO_MODEL_GATEWAY_AUTH_PREFIX") ?? "Bearer ",
      headers: parseHeaders(settings.get("NYLO_MODEL_GATEWAY_HEADERS")),
      ...(requestIdHeader === undefined ? {} : { requestIdHeader }),
      ...(configuredGatewayUrl === undefined && legacyGatewayUrl !== undefined
        ? { deprecatedConfiguration: LEGACY_BASE_URL_VARIABLE }
        : {})
    });
  }

  const openrouter = await resolveCredential([OPENROUTER_VARIABLE], options);
  if (openrouter !== undefined) {
    return standard(model, model, OPENROUTER_BASE_URL, "openrouter", [OPENROUTER_VARIABLE], openrouter, {
      accessMode: "external-gateway",
      protocol: "openai-chat-completions"
    });
  }

  const direct = DIRECT[creator];
  if (direct !== undefined) {
    const credential = await resolveCredential([direct.variable], options);
    if (credential !== undefined) {
      return standard(model, suffix, direct.baseUrl, "direct", [direct.variable], credential, {
        accessMode: "direct-inference-provider",
        protocol: direct.protocol,
        ...(direct.credentialHeader === undefined ? {} : { credentialHeader: direct.credentialHeader }),
        ...(direct.credentialPrefix === undefined ? {} : { credentialPrefix: direct.credentialPrefix })
      });
    }
  }

  const local = await detectLocalOrigin(options.fetch);
  if (local !== undefined) {
    return standard(model, upstreamModel, local.baseUrl, local.route, [], undefined, {
      accessMode: "private-or-local-endpoint",
      protocol: "openai-chat-completions"
    });
  }

  throw new NyloBuildError(
    diagnostic(
      "NYLO_RUN_MODEL_GATEWAY_UNRESOLVED",
      "run",
      "error",
      ".env",
      `No model gateway can serve "${model}".`,
      `Start a local OpenAI-compatible server, set ${MODEL_GATEWAY_URL_VARIABLE} (and ${MODEL_GATEWAY_API_KEY_VARIABLE} when needed), or set ${direct?.variable ?? OPENROUTER_VARIABLE}.`
    )
  );
}

function standard(
  model: string,
  upstreamModel: string,
  baseUrl: string,
  route: ResolvedModel["route"],
  credentialVariables: readonly string[],
  credential: ResolvedCredential | undefined,
  connection: Readonly<{
    accessMode: ModelAccessMode;
    protocol: ModelGatewayProtocol;
    credentialHeader?: string;
    credentialPrefix?: string;
  }>
): ResolvedModel {
  return Object.freeze({
    model,
    upstreamModel,
    baseUrl,
    route,
    accessMode: connection.accessMode,
    protocol: connection.protocol,
    capabilities: PORTABLE_HISTORY_CAPABILITIES,
    ...(credential === undefined ? {} : { credential }),
    credentialVariables: Object.freeze([...credentialVariables]),
    credentialRequired: credentialVariables.length > 0,
    credentialHeader: connection.credentialHeader ?? "authorization",
    credentialPrefix: connection.credentialPrefix ?? "Bearer ",
    headers: Object.freeze({})
  });
}

function parseProtocol(value: string | undefined): ModelGatewayProtocol {
  if (value === undefined || value === "") return "openai-chat-completions";
  if ((MODEL_GATEWAY_PROTOCOLS as readonly string[]).includes(value)) return value as ModelGatewayProtocol;
  throw new NyloBuildError(
    diagnostic(
      "NYLO_RUN_MODEL_GATEWAY_PROTOCOL_INVALID",
      "run",
      "error",
      ".env",
      `${MODEL_GATEWAY_PROTOCOL_VARIABLE} must be one of ${MODEL_GATEWAY_PROTOCOLS.join(", ")}.`,
      `Set ${MODEL_GATEWAY_PROTOCOL_VARIABLE} to a supported protocol, or remove it to use openai-chat-completions.`
    )
  );
}

function parseAccessMode(value: string | undefined, baseUrl: string): ModelAccessMode {
  if (value === undefined || value === "") return isLoopback(baseUrl) ? "private-or-local-endpoint" : "external-gateway";
  if (value === "external-gateway" || value === "private-or-local-endpoint") return value;
  throw new NyloBuildError(
    diagnostic(
      "NYLO_RUN_MODEL_GATEWAY_ACCESS_MODE_INVALID",
      "run",
      "error",
      ".env",
      `${MODEL_GATEWAY_ACCESS_MODE_VARIABLE} must be external-gateway or private-or-local-endpoint.`,
      `Set ${MODEL_GATEWAY_ACCESS_MODE_VARIABLE} to one of those values, or remove it to infer from the endpoint.`
    )
  );
}

function isLoopback(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
}

async function settingsFor(options: ResolveModelOptions): Promise<ReadonlyMap<string, string | undefined>> {
  const dotenv = await readDotenv(options.projectRoot);
  const env = options.env ?? process.env;
  const values = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(dotenv)) values.set(name, value);
  for (const [name, value] of Object.entries(env)) if (value !== undefined) values.set(name, value);
  return values;
}

function parseHeaders(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value === "") return Object.freeze({});
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(parsed)) {
      if (typeof header !== "string") throw new Error("value is not a string");
      headers[name] = header;
    }
    return Object.freeze(headers);
  } catch {
    throw new NyloBuildError(
      diagnostic(
        "NYLO_RUN_MODEL_GATEWAY_HEADERS_INVALID",
        "run",
        "error",
        ".env",
        "NYLO_MODEL_GATEWAY_HEADERS must be a JSON object with string values.",
        "Set it to a JSON object such as {\"x-tenant\":\"example\"}, or remove it."
      )
    );
  }
}

async function detectLocalOrigin(fetchImpl = globalThis.fetch): Promise<(typeof LOCAL_ORIGINS)[number] | undefined> {
  for (const origin of LOCAL_ORIGINS) {
    try {
      const response = await fetchImpl(`${origin.baseUrl}/models`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return origin;
    } catch {
      // Local discovery is optional; unavailable endpoints are not errors.
    }
  }
  return undefined;
}
