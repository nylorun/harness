import {
  ProviderError,
  type ChatMessage,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderUsage
} from "../session/index.js";

type Fetch = typeof fetch;

export type RetryPolicy = Readonly<{
  maxAttempts: number;
  maxElapsedMs: number;
}>;

/**
 * Every vendor-specific fact arrives through these options. The transport itself — SSE framing,
 * tool-call accumulation, usage extraction, error classification — is the same code locally and
 * hosted, which is what makes the parity claim structural rather than a matter of agreement.
 */
export type OpenAICompatibleProviderOptions = Readonly<{
  /** Origin and path prefix, without a trailing slash. `/chat/completions` is appended. */
  baseUrl: string;
  /** The identity the session asks for. A request for any other model is refused. */
  model: string;
  /** The identity sent upstream. Defaults to `model`. */
  upstreamModel?: string;
  apiKey: string;
  /** Defaults to `authorization: Bearer <apiKey>`. */
  credentialHeader?: string;
  credentialPrefix?: string;
  headers?: Readonly<Record<string, string>>;
  requestIdHeader?: string;
  retry?: RetryPolicy;
  /** Recorded in call evidence. Hosted supplies these; a direct local call has neither. */
  gateway?: string;
  gatewayProfile?: string;
  fetch?: Fetch;
  now?: () => number;
  retryDelay?: (attempt: number, milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, maxElapsedMs: 120_000 };

type StreamState = {
  finishReason: Extract<ProviderChunk, { type: "done" }>["finishReason"];
  usage: ProviderUsage;
  resolvedModel: string;
  provider?: string;
  fallback?: boolean;
};

type OpenAIChunk = {
  id?: string;
  model?: string;
  provider?: string;
  fallback?: boolean;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: string };
};

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #upstreamModel: string;
  readonly #apiKey: string;
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

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#model = options.model;
    this.#upstreamModel = options.upstreamModel ?? options.model;
    this.#apiKey = options.apiKey;
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

  async *complete(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    if (request.model !== this.#model) {
      throw new ProviderError(
        `Provider route for ${this.#model} cannot serve request for ${request.model}`,
        { code: "protocol_error" }
      );
    }
    const startedAt = this.#now();
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      const elapsed = this.#now() - startedAt;
      const remaining = this.#retry.maxElapsedMs - elapsed;
      if (remaining <= 0) {
        throw new ProviderError("Provider call exceeded its elapsed-time budget", {
          code: "timeout",
          retryable: true,
          cause: lastFailure
        });
      }

      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
      const attemptSignal = AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          signal: attemptSignal,
          headers: {
            "content-type": "application/json",
            ...this.#headers,
            [this.#credentialHeader]: `${this.#credentialPrefix}${this.#apiKey}`
          },
          body: JSON.stringify({
            model: this.#upstreamModel,
            messages: request.messages.map(message),
            ...(request.tools.length === 0
              ? {}
              : {
                  tools: request.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema
                    }
                  }))
                }),
            max_completion_tokens: request.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true }
          })
        });
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        lastFailure = new ProviderError(
          timeoutSignal.aborted
            ? "Provider request exceeded its elapsed-time budget"
            : "Provider request could not be established",
          {
            code: timeoutSignal.aborted ? "timeout" : "provider_error",
            retryable: true,
            cause
          }
        );
        if (!this.#canRetry(attempt, startedAt)) throw lastFailure;
        await this.#wait(attempt, startedAt, signal);
        continue;
      }

      if (!response.ok) {
        const failure = providerHttpError(response.status, await response.text());
        lastFailure = failure;
        if (!failure.retryable || !this.#canRetry(attempt, startedAt)) throw failure;
        await this.#wait(attempt, startedAt, signal);
        continue;
      }
      if (response.body === null) {
        throw new ProviderError("Provider returned an empty streaming response", { code: "protocol_error" });
      }

      const state: StreamState = {
        finishReason: "error",
        usage: { tokensIn: 0, tokensOut: 0 },
        resolvedModel: this.#upstreamModel
      };
      let acceptedOutput = false;
      let firstOutputAt: number | undefined;
      try {
        for await (const chunk of parseStream(response.body, state, attemptSignal)) {
          if (chunk.type === "text" || chunk.type === "tool-call") {
            acceptedOutput = true;
            firstOutputAt ??= this.#now();
          }
          yield chunk;
        }
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        const failure = isProviderError(cause)
          ? cause
          : new ProviderError(
              timeoutSignal.aborted
                ? "Provider stream exceeded its elapsed-time budget"
                : "Provider stream failed",
              {
                code: timeoutSignal.aborted ? "timeout" : "provider_error",
                retryable: true,
                cause
              }
            );
        lastFailure = failure;
        if (acceptedOutput || !failure.retryable || !this.#canRetry(attempt, startedAt)) throw failure;
        await this.#wait(attempt, startedAt, signal);
        continue;
      }

      const totalLatencyMs = Math.max(0, this.#now() - startedAt);
      const requestId = this.#requestIdHeader
        ? response.headers.get(this.#requestIdHeader) ?? undefined
        : response.headers.get("x-request-id") ?? undefined;
      yield {
        type: "done",
        finishReason: state.finishReason,
        usage: state.usage,
        model: state.resolvedModel,
        evidence: {
          resolvedModel: state.resolvedModel,
          ...(this.#gateway === undefined ? {} : { gateway: this.#gateway }),
          ...(this.#gatewayProfile === undefined ? {} : { gatewayProfile: this.#gatewayProfile }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(state.provider === undefined ? {} : { provider: state.provider }),
          attempts: attempt,
          ...(firstOutputAt === undefined ? {} : { timeToFirstTokenMs: Math.max(0, firstOutputAt - startedAt) }),
          totalLatencyMs,
          ...(state.fallback === undefined ? {} : { fallback: state.fallback })
        }
      };
      return;
    }
    throw lastFailure;
  }

  #canRetry(attempt: number, startedAt: number): boolean {
    return attempt < this.#retry.maxAttempts && this.#now() - startedAt < this.#retry.maxElapsedMs;
  }

  async #wait(attempt: number, startedAt: number, signal: AbortSignal): Promise<void> {
    const remaining = Math.max(0, this.#retry.maxElapsedMs - (this.#now() - startedAt));
    const milliseconds = Math.min(attempt === 1 ? 250 : 1_000, remaining);
    if (milliseconds <= 0) return;
    await this.#retryDelay(attempt, milliseconds, signal);
  }
}

/**
 * Structural rather than `instanceof`: a consumer can resolve a second copy of this package, and a
 * duplicated class identity would silently reclassify a retryable failure as an unknown one.
 */
function isProviderError(value: unknown): value is ProviderError {
  return value instanceof Error && "code" in value && "retryable" in value;
}

function message(value: ChatMessage): Record<string, unknown> {
  if (value.role === "assistant") {
    return {
      role: value.role,
      content: value.content,
      ...(value.toolCalls === undefined
        ? {}
        : {
            tool_calls: value.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          })
    };
  }
  if (value.role === "tool") {
    return { role: "tool", tool_call_id: value.toolCallId, content: value.content };
  }
  return { role: value.role, content: value.content };
}

function providerHttpError(status: number, detail: string): ProviderError {
  let vendorCode = "";
  let vendorMessage = detail.slice(0, 500);
  try {
    const body = JSON.parse(detail) as { error?: { code?: string; message?: string } };
    vendorCode = body.error?.code?.toLowerCase() ?? "";
    vendorMessage = body.error?.message ?? vendorMessage;
  } catch {
    // A non-JSON error body remains useful as bounded diagnostic text.
  }
  vendorMessage = redactProviderDiagnostic(vendorMessage);
  const combined = `${vendorCode} ${vendorMessage}`.toLowerCase();
  if (status === 404 || /model.*(not found|unavailable)|unknown.model/u.test(combined)) {
    return new ProviderError(vendorMessage || "The configured model is unavailable", {
      code: "model_unavailable",
      status
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError(vendorMessage || "Provider authentication failed", {
      code: "authentication_failed",
      status
    });
  }
  if (status === 429) {
    return new ProviderError(vendorMessage || "Provider rate limit exceeded", {
      code: "rate_limited",
      retryable: true,
      status
    });
  }
  if (status === 408) {
    return new ProviderError(vendorMessage || "Provider request timed out", {
      code: "timeout",
      retryable: true,
      status
    });
  }
  return new ProviderError(vendorMessage || `Provider request failed with status ${status}`, {
    code: status >= 500 ? "provider_error" : "protocol_error",
    retryable: status >= 500,
    status
  });
}

function redactProviderDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/giu, "[redacted URL]")
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]+\b/giu, "[redacted credential]");
}

async function defaultRetryDelay(_attempt: number, milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handle = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

async function* parseStream(
  stream: ReadableStream<Uint8Array>,
  state: StreamState,
  signal: AbortSignal
): AsyncIterable<Exclude<ProviderChunk, { type: "done" }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = next.done ? "" : frames.pop() ?? "";
      if (next.done && buffer.trim() !== "") frames.push(buffer);
      for (const frame of frames) {
        for (const chunk of decodeFrame(frame, state)) yield chunk;
      }
      if (next.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeFrame(frame: string, state: StreamState): Exclude<ProviderChunk, { type: "done" }>[] {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "" || data === "[DONE]") return [];
  let chunk: OpenAIChunk;
  try {
    chunk = JSON.parse(data) as OpenAIChunk;
  } catch (cause) {
    throw new ProviderError("Provider stream contained invalid JSON", { code: "protocol_error", cause });
  }
  if (chunk.error !== undefined) {
    const code = `${chunk.error.code ?? ""} ${chunk.error.message ?? ""}`.toLowerCase();
    throw new ProviderError(chunk.error.message ?? "Provider stream failed", {
      code: /model.*(not found|unavailable)|unknown.model/u.test(code)
        ? "model_unavailable"
        : "provider_error"
    });
  }
  state.resolvedModel = chunk.model ?? state.resolvedModel;
  state.provider = chunk.provider ?? state.provider;
  state.fallback = chunk.fallback ?? state.fallback;
  if (chunk.usage !== undefined) {
    state.usage = {
      tokensIn: chunk.usage.prompt_tokens ?? 0,
      tokensOut: chunk.usage.completion_tokens ?? 0,
      ...(chunk.usage.cost === undefined ? {} : { costUsd: chunk.usage.cost }),
      ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
        ? {}
        : { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens })
    };
  }
  const result: Exclude<ProviderChunk, { type: "done" }>[] = [];
  for (const choice of chunk.choices ?? []) {
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      state.finishReason = normalizeFinishReason(choice.finish_reason);
    }
    if (choice.delta?.content) result.push({ type: "text", text: choice.delta.content });
    for (const call of choice.delta?.tool_calls ?? []) {
      result.push({
        type: "tool-call",
        index: call.index ?? 0,
        ...(call.id === undefined ? {} : { id: call.id }),
        ...(call.function?.name === undefined ? {} : { name: call.function.name }),
        ...(call.function?.arguments === undefined ? {} : { arguments: call.function.arguments })
      });
    }
  }
  return result;
}

function normalizeFinishReason(value: string): Extract<ProviderChunk, { type: "done" }>["finishReason"] {
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") return value;
  return "error";
}
