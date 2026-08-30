import {
  Type,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  JsonObject,
  ModelAdapter as HarnessModelAdapter,
  ModelCall,
  ModelCandidate,
} from "@nylorun/harness";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ProviderConfig = Readonly<{
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  providerModule?: string;
}>;

/** Load `.env` into `process.env` without overriding values the process already has. */
export function loadDotEnv(): void {
  try {
    for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eq = assignment.indexOf("=");
      if (eq <= 0) continue;
      const key = assignment.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = assignment.slice(eq + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Server-only pi-ai configuration. The browser only receives provider and model identifiers. */
export function providerConfig(environment: NodeJS.ProcessEnv = process.env): ProviderConfig {
  if (environment === process.env) loadDotEnv();
  const provider = environment.NYLO_PROVIDER?.trim();
  const model = environment.NYLO_MODEL?.trim();
  if (!provider || !model)
    throw new Error("Set NYLO_PROVIDER and NYLO_MODEL in .env before starting the agent server.");
  const baseUrl = environment.NYLO_BASE_URL?.trim();
  const apiKeyEnv = environment.NYLO_API_KEY_ENV?.trim();
  const providerModule = environment.NYLO_PROVIDER_MODULE?.trim();
  return Object.freeze({
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(providerModule ? { providerModule } : {}),
  });
}

export async function createPiAdapter(config: ProviderConfig): Promise<HarnessModelAdapter> {
  const models = config.baseUrl === undefined ? builtinModels() : compatibleModels(config);
  await applyProviderModule(models, config.providerModule);
  const selected = models.getModel(config.provider, config.model);
  if (!selected)
    throw new Error(
      `pi-ai does not know model '${config.model}' for provider '${config.provider}'. Check NYLO_PROVIDER and NYLO_MODEL.`,
    );
  return async (call, { signal }): Promise<ModelCandidate> => {
    let compatibilityTools = false;
    let result;
    try {
      result = await models.complete(selected, toPiContext(call, false), {
        signal,
        maxTokens: 4096,
      });
    } catch (error) {
      if (
        !/does not support tools|tool.*not supported/iu.test(
          error instanceof Error ? error.message : "",
        )
      )
        throw error;
      compatibilityTools = true;
      result = await models.complete(selected, toPiContext(call, true), {
        signal,
        maxTokens: 4096,
      });
    }
    if (
      (result as unknown as { stopReason?: unknown }).stopReason === "error" &&
      /does not support tools|tool.*not supported/iu.test(errorMessage(result))
    ) {
      compatibilityTools = true;
      result = await models.complete(selected, toPiContext(call, true), {
        signal,
        maxTokens: 4096,
      });
    }
    const message = result as unknown as {
      content: readonly Record<string, unknown>[];
      stopReason: string;
      usage?: { input?: number; output?: number; cost?: { total?: number } };
      errorMessage?: string;
    };
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(redactProviderError(message.errorMessage ?? "Provider request failed."));
    }
    const nativeCalls = message.content.flatMap((part, index) =>
      part.type === "toolCall"
        ? [
            {
              type: "tool-call" as const,
              id: string(part.id, `call-${index}`),
              name: string(part.name, "unknown_tool"),
              args: jsonObject(part.arguments),
            },
          ]
        : [],
    );
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => string(part.text, ""))
      .join("");
    const compatible = compatibilityTools ? compatibilityCall(text, call) : undefined;
    const toolCalls = compatible === undefined ? nativeCalls : [compatible];
    return Object.freeze({
      output: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls],
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
      usage: {
        inputTokens: message.usage?.input ?? 0,
        outputTokens: message.usage?.output ?? 0,
        ...(message.usage?.cost?.total ? { costUsd: message.usage.cost.total } : {}),
      },
    });
  };
}

/** Server-only escape hatch for a pi-ai provider that has not shipped yet. */
async function applyProviderModule(models: unknown, modulePath: string | undefined): Promise<void> {
  if (modulePath === undefined) return;
  const specifier = pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const loaded = (await import(/* @vite-ignore */ specifier)) as { register?: unknown };
  if (typeof loaded.register !== "function")
    throw new Error("NYLO_PROVIDER_MODULE must export an async or sync register(models) function.");
  await loaded.register(models);
}

function compatibleModels(config: ProviderConfig) {
  const models = createModels();
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    provider: config.provider,
    api: "openai-completions",
    baseUrl: config.baseUrl!,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  models.setProvider(
    createProvider({
      id: config.provider,
      name: config.provider,
      baseUrl: config.baseUrl,
      // OpenAI-compatible clients insist on an Authorization value even when a local endpoint
      // ignores it. This sentinel is not a secret and is never sent to Studio or persisted.
      auth:
        config.apiKeyEnv === undefined
          ? {
              apiKey: {
                name: config.provider,
                resolve: async () => ({ auth: { apiKey: "local" }, source: "local endpoint" }),
              },
            }
          : { apiKey: envApiKeyAuth(`${config.provider} API key`, [config.apiKeyEnv]) },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}

function toPiContext(call: ModelCall, compatibilityTools: boolean): Context {
  const messages: Record<string, unknown>[] = [];
  for (const item of call.prompt) {
    const content = item.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    if (item.kind === "instructions") messages.push({ role: "system", content });
    else if (item.kind === "tool-result")
      messages.push(
        compatibilityTools
          ? {
              role: "user",
              content: `Tool result for ${item.toolCallId}: ${content}`,
              timestamp: Date.now(),
            }
          : {
              role: "toolResult",
              toolCallId: item.toolCallId,
              toolName: "tool",
              content: [{ type: "text", text: content }],
              isError: false,
              timestamp: Date.now(),
            },
      );
    else
      messages.push({
        role: item.role,
        content,
        timestamp: Date.now(),
        ...(item.role === "assistant"
          ? {
              content: item.content.map((part) =>
                part.type === "tool-call"
                  ? { type: "toolCall", id: part.id, name: part.name, arguments: part.args }
                  : { type: "text", text: part.text },
              ),
            }
          : {}),
      });
  }
  if (compatibilityTools && call.tools.length > 0)
    messages.unshift({
      role: "system",
      content: `Native tool calls are unavailable. To use a tool, respond with ONLY JSON: {"tool":"name","args":{...}}. Available tools: ${call.tools.map((item) => `${item.name} (${item.description ?? ""})`).join("; ")}. After a Tool result, answer normally.`,
      timestamp: Date.now(),
    });
  return {
    messages: messages as never,
    tools: compatibilityTools
      ? []
      : (call.tools.map((item) => ({
          name: item.name,
          ...(item.description === undefined ? {} : { description: item.description }),
          parameters: Type.Unsafe(item.inputSchema),
        })) as never),
  } as Context;
}

function compatibilityCall(
  text: string,
  call: ModelCall,
): { type: "tool-call"; id: string; name: string; args: JsonObject } | undefined {
  try {
    const parsed = JSON.parse(text) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== "string" || !call.tools.some((tool) => tool.name === parsed.tool))
      return undefined;
    return {
      type: "tool-call",
      id: `compat-${crypto.randomUUID()}`,
      name: parsed.tool,
      args: jsonObject(parsed.args),
    };
  } catch {
    return undefined;
  }
}

function jsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function errorMessage(result: unknown): string {
  const value = (result as { errorMessage?: unknown }).errorMessage;
  return typeof value === "string" ? value : "";
}

function redactProviderError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/giu, "[redacted URL]")
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]+\b/giu, "[redacted credential]");
}
