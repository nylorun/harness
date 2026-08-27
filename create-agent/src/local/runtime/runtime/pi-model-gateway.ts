import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { ModelGatewayError, type ChatMessage, type ModelGatewayAdapter, type ModelGatewayChunk, type ModelGatewayRequest, type ModelGatewayUsage } from "./contracts.js";
import type { ModelAccessMode, ModelConnectionCapabilities, ModelGatewayProtocol } from "./model.js";

type Fetch = typeof fetch;

export type RetryPolicy = Readonly<{
  maxAttempts: number;
  maxElapsedMs: number;
}>;

export type PiModelGatewayAdapterOptions = Readonly<{
  baseUrl: string;
  model: string;
  upstreamModel?: string;
  protocol: ModelGatewayProtocol;
  accessMode?: ModelAccessMode;
  capabilities?: ModelConnectionCapabilities;
  credential?: () => Promise<string | undefined>;
  credentialRequired?: boolean;
  credentialHeader?: string;
  credentialPrefix?: string;
  headers?: Readonly<Record<string, string>>;
  requestIdHeader?: string;
  retry?: RetryPolicy;
  gateway?: string;
  gatewayProfile?: string;
  fetch?: Fetch;
  now?: () => number;
  retryDelay?: (attempt: number, milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, maxElapsedMs: 120_000 };
const PLACEHOLDER_API_KEY = "nylorun-runtime-managed";

type PiStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
type PiToolCall = Readonly<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>;
type PiAssistantMessage = Readonly<{
  content: readonly (Readonly<{ type: string }> | PiToolCall)[];
  model: string;
  responseModel?: string;
  stopReason: PiStopReason;
  errorMessage?: string;
  usage: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cost: Readonly<{ total: number }>;
  }>;
}>;
type PiEvent = Readonly<{
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: PiAssistantMessage;
  toolCall?: PiToolCall;
  message?: PiAssistantMessage;
  error?: PiAssistantMessage;
}>;
type PiStream = (model: never, context: never, options: never) => AsyncIterable<PiEvent>;

/**
 * The provider serializer and stream parser are Pi AI. Nylorun deliberately retains connection
 * resolution, credential refresh, the retry budget, normalized event evidence, and the agent loop.
 */
export class PiModelGatewayAdapter implements ModelGatewayAdapter {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #upstreamModel: string;
  readonly #protocol: ModelGatewayProtocol;
  readonly #accessMode: ModelAccessMode | undefined;
  readonly #capabilities: ModelConnectionCapabilities | undefined;
  readonly #credential: () => Promise<string | undefined>;
  readonly #credentialRequired: boolean;
  readonly #credentialHeader: string;
  readonly #credentialPrefix: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #requestIdHeader: string | undefined;
  readonly #retry: RetryPolicy;
  readonly #gateway: string | undefined;
  readonly #gatewayProfile: string | undefined;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #retryDelay: (attempt: number, milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: PiModelGatewayAdapterOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#model = options.model;
    this.#upstreamModel = options.upstreamModel ?? options.model;
    this.#protocol = options.protocol;
    this.#accessMode = options.accessMode;
    this.#capabilities = options.capabilities;
    this.#credential = options.credential ?? (async () => undefined);
    this.#credentialRequired = options.credentialRequired ?? false;
    this.#credentialHeader = options.credentialHeader ?? "authorization";
    this.#credentialPrefix = options.credentialPrefix ?? "Bearer ";
    this.#headers = options.headers ?? {};
    this.#requestIdHeader = options.requestIdHeader;
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.#gateway = options.gateway;
    this.#gatewayProfile = options.gatewayProfile;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => performance.now());
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  async *complete(request: ModelGatewayRequest, signal: AbortSignal): AsyncIterable<ModelGatewayChunk> {
    if (request.model !== this.#model) {
      throw new ModelGatewayError(`Provider route for ${this.#model} cannot serve request for ${request.model}`, {
        code: "protocol_error"
      });
    }

    const credential = await this.#credential();
    if (credential === undefined && this.#credentialRequired) {
      throw new ModelGatewayError("The selected model gateway credential is unavailable.", { code: "authentication_failed" });
    }

    const startedAt = this.#now();
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      const remaining = this.#retry.maxElapsedMs - (this.#now() - startedAt);
      if (remaining <= 0) {
        throw new ModelGatewayError("Provider call exceeded its elapsed-time budget", {
          code: "timeout",
          retryable: true,
          cause: lastFailure
        });
      }

      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
      const attemptSignal = AbortSignal.any([signal, timeoutSignal]);
      let acceptedOutput = false;
      let firstOutputAt: number | undefined;
      let responseHeaders: Readonly<Record<string, string>> = {};
      try {
        const stream = streamFor(this.#protocol)(
          piModel(this.#protocol, this.#upstreamModel, this.#baseUrl, request.maxOutputTokens),
          piContext(this.#protocol, this.#upstreamModel, request),
          {
            apiKey: PLACEHOLDER_API_KEY,
            headers: this.#headers,
            fetch: authenticatedFetch(this.#fetch, credential, this.#credentialHeader, this.#credentialPrefix),
            signal: attemptSignal,
            maxRetries: 0,
            timeoutMs: Math.max(1, Math.ceil(remaining)),
            onResponse: (response: Readonly<{ headers: Readonly<Record<string, string>> }>) => {
              responseHeaders = response.headers;
            }
          } as never
        );
        const result = streamResult();
        for await (const chunk of normalizeStream(stream, result)) {
          if (chunk.type === "text" || chunk.type === "tool-call") {
            acceptedOutput = true;
            firstOutputAt ??= this.#now();
          }
          yield chunk;
        }

        const message = result.message;
        if (message === undefined) throw new ModelGatewayError("Provider stream ended without a terminal response", { code: "protocol_error" });
        const totalLatencyMs = Math.max(0, this.#now() - startedAt);
        const requestId = this.#requestIdHeader === undefined
          ? responseHeaders["x-request-id"]
          : header(responseHeaders, this.#requestIdHeader);
        yield {
          type: "done",
          finishReason: finishReason(message.stopReason),
          usage: usage(message),
          model: message.responseModel ?? message.model,
          evidence: {
            resolvedModel: message.responseModel ?? message.model,
            ...(this.#gateway === undefined ? {} : { gateway: this.#gateway }),
            ...(this.#gatewayProfile === undefined ? {} : { gatewayProfile: this.#gatewayProfile }),
            ...(requestId === undefined ? {} : { requestId }),
            ...(this.#accessMode === undefined ? {} : { accessMode: this.#accessMode }),
            protocol: this.#protocol,
            ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
            attempts: attempt,
            ...(firstOutputAt === undefined ? {} : { timeToFirstTokenMs: Math.max(0, firstOutputAt - startedAt) }),
            totalLatencyMs
          }
        };
        return;
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        const failure = asGatewayError(cause, timeoutSignal.aborted);
        lastFailure = failure;
        if (acceptedOutput || !failure.retryable || !this.#canRetry(attempt, startedAt)) throw failure;
        await this.#wait(attempt, startedAt, signal);
      }
    }
    throw lastFailure;
  }

  #canRetry(attempt: number, startedAt: number): boolean {
    return attempt < this.#retry.maxAttempts && this.#now() - startedAt < this.#retry.maxElapsedMs;
  }

  async #wait(attempt: number, startedAt: number, signal: AbortSignal): Promise<void> {
    const remaining = Math.max(0, this.#retry.maxElapsedMs - (this.#now() - startedAt));
    const milliseconds = Math.min(attempt === 1 ? 250 : 1_000, remaining);
    if (milliseconds > 0) await this.#retryDelay(attempt, milliseconds, signal);
  }
}

function streamFor(protocol: ModelGatewayProtocol): PiStream {
  switch (protocol) {
    case "openai-chat-completions":
      return streamOpenAICompletions as PiStream;
    case "openai-responses":
      return streamOpenAIResponses as PiStream;
    case "anthropic-messages":
      return streamAnthropicMessages as PiStream;
  }
}

function piModel(protocol: ModelGatewayProtocol, id: string, baseUrl: string, maxTokens: number): never {
  const api = protocol === "openai-chat-completions"
    ? "openai-completions"
    : protocol;
  return {
    id,
    name: id,
    api,
    provider: "nylorun",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: Math.max(16, maxTokens)
  } as never;
}

function piContext(protocol: ModelGatewayProtocol, model: string, request: ModelGatewayRequest): never {
  const names = new Map<string, string>();
  const system: string[] = [];
  const messages: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    messages.push(piMessage(protocol, model, message, names));
  }
  return {
    ...(system.length === 0 ? {} : { systemPrompt: system.join("\n\n") }),
    messages,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: Type.Unsafe(tool.inputSchema)
          }))
        })
  } as never;
}

function piMessage(protocol: ModelGatewayProtocol, model: string, message: ChatMessage, names: Map<string, string>): unknown {
  const now = Date.now();
  if (message.role !== "assistant" && message.role !== "tool") {
    return { role: "user", content: [{ type: "text", text: message.content }], timestamp: now };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: names.get(message.toolCallId) ?? "unknown_tool",
      content: [{ type: "text", text: message.content }],
      timestamp: now
    };
  }
  const calls = message.toolCalls ?? [];
  for (const call of calls) names.set(call.id, call.name);
  return {
    role: "assistant",
    content: [
      ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
      ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: parsedArguments(call.arguments) }))
    ],
    api: protocol === "openai-chat-completions" ? "openai-completions" : protocol,
    provider: "nylorun",
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: calls.length === 0 ? "stop" : "toolUse",
    timestamp: now
  };
}

function parsedArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function authenticatedFetch(fetchImpl: Fetch, credential: string | undefined, credentialHeader: string, credentialPrefix: string): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "x-api-key"]) {
      const value = headers.get(name);
      if (value === `Bearer ${PLACEHOLDER_API_KEY}` || value === PLACEHOLDER_API_KEY) headers.delete(name);
    }
    if (credential !== undefined) {
      headers.delete(credentialHeader);
      headers.set(credentialHeader, `${credentialPrefix}${credential}`);
    }
    return fetchImpl(new Request(request, { headers }));
  };
}

function streamResult(): { message?: PiAssistantMessage } {
  return {};
}

async function* normalizeStream(
  stream: AsyncIterable<PiEvent>,
  result: { message?: PiAssistantMessage }
): AsyncIterable<Exclude<ModelGatewayChunk, { type: "done" }>> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of stream) {
    if (event.type === "text_delta") {
      const delta = event.delta ?? "";
      if (delta !== "") yield { type: "text", text: delta };
      continue;
    }
    if (event.type === "toolcall_start") {
      if (event.contentIndex === undefined) throw new ModelGatewayError("Provider tool call has no content index", { code: "protocol_error" });
      const call = event.partial === undefined ? undefined : toolAt(event.partial, event.contentIndex);
      const current = calls.get(event.contentIndex) ?? { id: "", name: "", arguments: "" };
      const next = { id: call?.id ?? current.id, name: call?.name ?? current.name, arguments: current.arguments };
      calls.set(event.contentIndex, next);
      yield {
        type: "tool-call",
        index: event.contentIndex,
        ...(next.id === "" ? {} : { id: next.id }),
        ...(next.name === "" ? {} : { name: next.name })
      };
      continue;
    }
    if (event.type === "toolcall_delta") {
      if (event.contentIndex === undefined) throw new ModelGatewayError("Provider tool call has no content index", { code: "protocol_error" });
      const delta = event.delta ?? "";
      const current = calls.get(event.contentIndex) ?? { id: "", name: "", arguments: "" };
      current.arguments += delta;
      calls.set(event.contentIndex, current);
      if (delta !== "") yield { type: "tool-call", index: event.contentIndex, arguments: delta };
      continue;
    }
    if (event.type === "toolcall_end") {
      if (event.contentIndex === undefined || event.toolCall === undefined) {
        throw new ModelGatewayError("Provider tool call ended without complete metadata", { code: "protocol_error" });
      }
      const current = calls.get(event.contentIndex) ?? { id: "", name: "", arguments: "" };
      const argumentsText = JSON.stringify(event.toolCall.arguments);
      const suffix = argumentsText.startsWith(current.arguments) ? argumentsText.slice(current.arguments.length) : argumentsText;
      calls.set(event.contentIndex, { id: event.toolCall.id, name: event.toolCall.name, arguments: argumentsText });
      yield {
        type: "tool-call",
        index: event.contentIndex,
        ...(current.id === "" ? { id: event.toolCall.id } : {}),
        ...(current.name === "" ? { name: event.toolCall.name } : {}),
        ...(suffix === "" ? {} : { arguments: suffix })
      };
      continue;
    }
    if (event.type === "done") {
      if (event.message === undefined) throw new ModelGatewayError("Provider stream ended without a response", { code: "protocol_error" });
      result.message = event.message;
      continue;
    }
    if (event.type === "error") {
      throw new ModelGatewayError(event.error?.errorMessage ?? "Provider stream failed", { code: "provider_error" });
    }
  }
}

function toolAt(message: PiAssistantMessage, index: number): Readonly<{ id: string; name: string }> | undefined {
  const item = message.content[index];
  return item !== undefined && item.type === "toolCall" && "id" in item && "name" in item
    ? { id: item.id, name: item.name }
    : undefined;
}

function usage(message: PiAssistantMessage): ModelGatewayUsage {
  return {
    tokensIn: message.usage.input,
    tokensOut: message.usage.output,
    ...(message.usage.cost.total === 0 ? {} : { costUsd: message.usage.cost.total }),
    ...(message.usage.cacheRead === 0 ? {} : { cachedTokens: message.usage.cacheRead })
  };
}

function finishReason(value: PiStopReason): Extract<ModelGatewayChunk, { type: "done" }>["finishReason"] {
  if (value === "stop") return "stop";
  if (value === "toolUse") return "tool_calls";
  if (value === "length") return "length";
  return "error";
}

function asGatewayError(cause: unknown, timedOut: boolean): ModelGatewayError {
  if (isGatewayError(cause)) return cause;
  const candidate = cause as Readonly<{ message?: unknown; status?: unknown }>;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const detail = typeof candidate?.message === "string" ? redactProviderDiagnostic(candidate.message) : "Provider request failed";
  if (timedOut || status === 408) return new ModelGatewayError("Provider request exceeded its elapsed-time budget", { code: "timeout", retryable: true, status, cause });
  if (status === 401 || status === 403) return new ModelGatewayError(detail, { code: "authentication_failed", status, cause });
  if (status === 404 || /model.*(not found|unavailable)|unknown.model/iu.test(detail)) return new ModelGatewayError(detail, { code: "model_unavailable", status, cause });
  if (status === 429) return new ModelGatewayError(detail, { code: "rate_limited", retryable: true, status, cause });
  return new ModelGatewayError(detail, { code: status !== undefined && status < 500 ? "protocol_error" : "provider_error", retryable: status === undefined || status >= 500, status, cause });
}

function isGatewayError(value: unknown): value is ModelGatewayError {
  return value instanceof Error && "code" in value && "retryable" in value;
}

function redactProviderDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/giu, "[redacted URL]")
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]+\b/giu, "[redacted credential]");
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

async function defaultRetryDelay(_attempt: number, milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handle = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(handle); reject(signal.reason); }, { once: true });
  });
}
