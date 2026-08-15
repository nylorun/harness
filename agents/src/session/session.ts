import { createHash } from "node:crypto";

import { fold, initialState } from "./fold.js";
import { ProviderError } from "./provider-error.js";
import { SKILL_TOOL_NAME } from "./types.js";
import type {
  ChatMessage,
  Clock,
  CreateSessionOptions,
  ExitReason,
  HostSessionEventType,
  Json,
  JsonSchema,
  ProviderChunk,
  ProviderCallEvidence,
  ProviderUsage,
  Session,
  SessionEvent,
  SessionEventType,
  SessionLimits,
  SessionSafePoint,
  SessionSkill,
  SessionState,
  ToolCall,
  ToolRegistration
} from "./types.js";

const DEFAULT_LIMITS: SessionLimits = {
  timeoutMs: 60 * 60 * 1000,
  maxTokens: 200_000,
  maxTurns: 25,
  maxToolResultBytes: 64 * 1024
};

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

type PendingToolCall = { id: string; name: string; arguments: string };

/**
 * Level 1 of the Agent Skills progressive-disclosure model: every discovered
 * skill contributes one name-and-description line to the system prompt, and
 * nothing more. Bodies enter context only when the model calls `load_skill`,
 * so this cost does not grow with a skill's instruction length.
 */
function skillCatalog(skills: readonly SessionSkill[]): string {
  const listing = [...skills]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
  return [
    "",
    "",
    "## Available skills",
    "",
    `Call the \`${SKILL_TOOL_NAME}\` tool with a skill's name to load its full instructions when a task matches its description.`,
    "",
    listing
  ].join("\n");
}

function skillTool(skills: readonly SessionSkill[]): ToolRegistration {
  return {
    name: SKILL_TOOL_NAME,
    description: "Load the full instructions for a named skill into context.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    async *execute(input) {
      const requested = (input as { name: string }).name;
      const skill = skills.find((candidate) => candidate.name === requested);
      if (skill === undefined) {
        const known = skills.map((candidate) => candidate.name).join(", ");
        yield { text: `No skill named "${requested}". Available skills: ${known}`, exitCode: 1 };
        return;
      }
      yield { text: skill.body, exitCode: 0 };
    }
  };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      }
    };
  }
}

export function createSession(options: CreateSessionOptions): Session {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const skills = options.definition.skills ?? [];
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  if (skills.length > 0) tools.set(SKILL_TOOL_NAME, skillTool(skills));
  const abortController = new AbortController();
  const queue = new AsyncQueue<SessionEvent>();
  const safePointQueue = new AsyncQueue<SessionSafePoint>();
  let state = options.resumeFrom ?? initialState(options.sessionId);
  if (state.session !== options.sessionId) throw new Error("The resume state belongs to a different session");
  if (state.status === "completed" || state.status === "failed") {
    throw new Error("A terminal session cannot be resumed");
  }
  let started = false;
  let timedOut = false;
  let abortReason = "aborted";
  let abortCode = "aborted";

  async function emit(type: SessionEventType, payload: Record<string, Json>): Promise<SessionEvent> {
    const event: SessionEvent = {
      session: options.sessionId,
      seq: state.seq + 1,
      ts: clock.now().toISOString(),
      type,
      payload
    };
    await options.sink.append(event);
    state = fold(state, event);
    queue.push(event);
    return event;
  }

  async function end(exitReason: ExitReason, failed: boolean, details: Record<string, Json> = {}): Promise<void> {
    if (state.status === "completed" || state.status === "failed") return;
    await emit("session.ended", {
      state: failed ? "failed" : "completed",
      exit_reason: exitReason,
      tokens_in: state.tokensIn,
      tokens_out: state.tokensOut,
      cost_usd: state.costUsd,
      ...details
    });
  }

  async function executeTool(call: ToolCall): Promise<ChatMessage> {
    const startedAt = clock.now().getTime();
    const tool = tools.get(call.name);
    let parsed: Json = null;
    let error: string | undefined;
    try {
      parsed = JSON.parse(call.arguments) as Json;
    } catch {
      error = "Tool arguments were not valid JSON.";
    }
    if (error === undefined && tool === undefined) error = `Unknown tool: ${call.name}`;
    if (error === undefined && tool !== undefined) error = validate(tool.inputSchema, parsed, "$input");

    const argsDigest = createHash("sha256").update(call.arguments).digest("hex");
    let stdout = "";
    let stderr = "";
    let exitCode = error === undefined ? 0 : 1;
    if (error === undefined && tool !== undefined) {
      await emit("tool.call.started", {
        tool: call.name,
        tool_call_id: call.id,
        args_digest: argsDigest
      });
      try {
        for await (const chunk of tool.execute(parsed, {
          sessionId: options.sessionId,
          toolCallId: call.id,
          signal: abortController.signal
        })) {
          if (chunk.stream === "stderr") stderr += chunk.text ?? "";
          else stdout += chunk.text ?? "";
          if (chunk.exitCode !== undefined) exitCode = chunk.exitCode;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Tool execution failed.";
        exitCode = 1;
      }
    }
    const fullResult = error === undefined ? `${stdout}${stderr}` : error;
    const modelResult = truncateUtf8(fullResult, limits.maxToolResultBytes);
    await emit("tool.call", {
      tool: call.name,
      tool_call_id: call.id,
      args_digest: argsDigest,
      duration_ms: Math.max(0, clock.now().getTime() - startedAt),
      exit: exitCode,
      stdout,
      stderr,
      model_result: modelResult.value,
      truncated: modelResult.truncated,
      ...(error === undefined ? {} : { error })
    });
    // A skill's instructions entering context is a first-class Run event in the
    // builder's own vocabulary, distinct from the generic tool-call pair that
    // carried it (PRD-04.R07/R08). Emitted through `emit` so `seq` stays gap-free.
    if (call.name === SKILL_TOOL_NAME && error === undefined && exitCode === 0) {
      await emit("skill.invocation", { skill: (parsed as { name: string }).name });
    }
    return { role: "tool", toolCallId: call.id, content: modelResult.value };
  }

  function systemMessage(): ChatMessage {
    return {
      role: "system",
      content:
        skills.length === 0
          ? options.definition.instructions
          : `${options.definition.instructions}${skillCatalog(skills)}`
    };
  }

  function resumeMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [systemMessage()];
    for (const entry of state.transcript) {
      if (entry.kind === "input") messages.push({ role: "user", content: entry.content });
      else if (entry.kind === "assistant") {
        messages.push({
          role: "assistant",
          content: entry.content,
          ...(entry.toolCalls.length === 0 ? {} : { toolCalls: entry.toolCalls })
        });
      } else messages.push({ role: "tool", toolCallId: entry.toolCallId, content: entry.content });
    }
    return messages;
  }

  async function run(input: string | undefined, resuming: boolean): Promise<SessionState> {
    if (started) throw new Error("A session can only be started once");
    if (resuming && options.resumeFrom === undefined) throw new Error("No resume state was supplied");
    if (!resuming && (input === undefined || input.length === 0)) throw new Error("A new session requires input");
    started = true;
    const timeoutHandle = clock.setTimeout(() => {
      timedOut = true;
      abortReason = "timeout";
      abortController.abort(new Error("Session timed out"));
    }, limits.timeoutMs);
    const messages: ChatMessage[] = resuming
      ? resumeMessages()
      : [systemMessage(), { role: "user", content: input! }];

    try {
      if (resuming) {
        if (options.resumeInterruption !== undefined) {
          await emit("session.interrupted", {
            reason: options.resumeInterruption.reason,
            ...(options.resumeInterruption.previousOrdinal === undefined
              ? {}
              : { previous_episode_ordinal: options.resumeInterruption.previousOrdinal })
          });
        }
        await emit("session.resumed", { from_seq: options.resumeFrom!.seq });
      } else {
        await emit("session.started", {
          agent: options.definition.name,
          model: options.definition.model,
          input: input!,
          harness_version: options.harnessVersion ?? "0.1.0"
        });
      }
      if (options.episode !== undefined) {
        await emit("session.episode.started", {
          ordinal: options.episode.ordinal,
          fencing_epoch: options.episode.fencingEpoch
        });
      }

      while (!abortController.signal.aborted) {
        const callStartedAt = clock.now().getTime();
        let content = "";
        let usage: ProviderUsage = { tokensIn: 0, tokensOut: 0 };
        let finishReason: Extract<ProviderChunk, { type: "done" }>["finishReason"] = "error";
        let resolvedModel = options.definition.model;
        let providerEvidence: ProviderCallEvidence | undefined;
        const pending = new Map<number, PendingToolCall>();

        for await (const chunk of options.provider.complete(
          {
            model: options.definition.model,
            messages: [...messages],
            tools: [...tools.values()],
            maxOutputTokens: Math.max(1, limits.maxTokens - state.tokensIn - state.tokensOut)
          },
          abortController.signal
        )) {
          if (chunk.type === "text") {
            content += chunk.text;
            await emit("harness.message", { delta: chunk.text });
          } else if (chunk.type === "tool-call") {
            const current = pending.get(chunk.index) ?? { id: "", name: "", arguments: "" };
            pending.set(chunk.index, {
              id: chunk.id ?? current.id,
              name: `${current.name}${chunk.name ?? ""}`,
              arguments: `${current.arguments}${chunk.arguments ?? ""}`
            });
          } else {
            usage = chunk.usage;
            finishReason = chunk.finishReason;
            providerEvidence = chunk.evidence;
            resolvedModel = chunk.evidence?.resolvedModel ?? chunk.model ?? resolvedModel;
          }
        }

        const toolCalls = [...pending.entries()]
          .sort(([left], [right]) => left - right)
          .map(([index, call]) => ({
            id: call.id || `call-${state.turns + 1}-${index}`,
            name: call.name,
            arguments: call.arguments
          }));
        await emit("model.call", {
          model: options.definition.model,
          resolved_model: resolvedModel,
          tokens_in: usage.tokensIn,
          tokens_out: usage.tokensOut,
          cost_usd: usage.costUsd ?? 0,
          cached_tokens: usage.cachedTokens ?? 0,
          latency_ms: Math.max(0, clock.now().getTime() - callStartedAt),
          finish_reason: finishReason,
          content,
          tool_calls: toolCalls as unknown as Json,
          ...(providerEvidence?.gateway === undefined ? {} : { gateway: providerEvidence.gateway }),
          ...(providerEvidence?.gatewayProfile === undefined
            ? {}
            : { gateway_profile: providerEvidence.gatewayProfile }),
          ...(providerEvidence?.requestId === undefined ? {} : { request_id: providerEvidence.requestId }),
          ...(providerEvidence?.provider === undefined ? {} : { provider: providerEvidence.provider }),
          ...(providerEvidence === undefined ? {} : { attempts: providerEvidence.attempts }),
          ...(providerEvidence?.timeToFirstTokenMs === undefined
            ? {}
            : { time_to_first_token_ms: providerEvidence.timeToFirstTokenMs }),
          ...(providerEvidence === undefined ? {} : { total_latency_ms: providerEvidence.totalLatencyMs }),
          ...(providerEvidence?.fallback === undefined ? {} : { fallback: providerEvidence.fallback })
        });
        messages.push({ role: "assistant", content, ...(toolCalls.length === 0 ? {} : { toolCalls }) });

        const tokenLimitReached = state.tokensIn + state.tokensOut >= limits.maxTokens;
        const turnLimitReached = state.turns >= limits.maxTurns;
        if (toolCalls.length > 0) {
          for (const toolCall of toolCalls) messages.push(await executeTool(toolCall));
          if (tokenLimitReached || turnLimitReached) {
            await end("budget", false, { limit: tokenLimitReached ? "tokens" : "turns" });
            break;
          }
          const safePoint: SessionSafePoint = {
            session: options.sessionId,
            seq: state.seq,
            turns: state.turns,
            tokensIn: state.tokensIn,
            tokensOut: state.tokensOut,
            payloadBytes: Buffer.byteLength(JSON.stringify(state.transcript)),
            reason: "tool_results_committed"
          };
          safePointQueue.push(safePoint);
          if ((await options.onSafePoint?.(safePoint)) === true) break;
          continue;
        }
        if (tokenLimitReached || turnLimitReached) {
          await end("budget", false, { limit: tokenLimitReached ? "tokens" : "turns" });
          break;
        }
        if (finishReason === "length") {
          await emit("error", { code: "context_overflow", message: "The model context limit was reached." });
          await end("error", true, { code: "context_overflow" });
          break;
        }
        if (finishReason === "content_filter" || finishReason === "error") {
          await emit("error", { code: "provider_error", message: `Model ended with ${finishReason}.` });
          await end("error", true, { code: "provider_error" });
          break;
        }
        await end("done", false);
        break;
      }

      if (abortController.signal.aborted && state.status !== "completed" && state.status !== "failed") {
        if (timedOut) await end("timeout", false);
        else {
          await emit("error", { code: abortCode, message: abortReason });
          await end("error", true, { code: abortCode });
        }
      }
    } catch (cause) {
      if (timedOut) await end("timeout", false);
      else {
        const message = cause instanceof Error ? cause.message : "Session execution failed.";
        const code = cause instanceof ProviderError ? cause.code : "execution_error";
        await emit("error", { code, message });
        await end("error", true, { code });
      }
    } finally {
      clock.clearTimeout(timeoutHandle);
      queue.close();
      safePointQueue.close();
    }
    return state;
  }

  return {
    start: (input) => run(input, false),
    resume: () => run(undefined, true),
    abort: (reason = "aborted", code = "aborted") => {
      abortReason = reason;
      abortCode = code;
      abortController.abort(new Error(reason));
    },
    state: () => state,
    events: () => queue,
    safePoints: () => safePointQueue,
    appendHostEvent: (type: HostSessionEventType, payload: Readonly<Record<string, Json>>) =>
      emit(type, { ...payload }),
    appendInterruptedToolResult: (input) =>
      emit("tool.call", {
        tool: input.tool,
        tool_call_id: input.toolCallId,
        args_digest: input.argsDigest,
        duration_ms: 0,
        exit: 1,
        stdout: "",
        stderr: "",
        model_result: "Tool outcome is unknown because execution was interrupted after dispatch.",
        truncated: false,
        error: "interrupted_outcome_unknown",
        outcome: "interrupted_outcome_unknown"
      })
  };
}

function validate(schema: JsonSchema, value: Json, path: string): string | undefined {
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object.`;
    const record = value as Record<string, Json>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) return `${path}.${required} is required.`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {}))) return `${path}.${key} is not allowed.`;
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const failure = validate(child, record[key]!, `${path}.${key}`);
        if (failure !== undefined) return failure;
      }
    }
  } else if (schema.type === "string" && typeof value !== "string") return `${path} must be a string.`;
  else if (schema.type === "number" && typeof value !== "number") return `${path} must be a number.`;
  else if (schema.type === "integer" && (!Number.isInteger(value))) return `${path} must be an integer.`;
  else if (schema.type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean.`;
  else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validate(schema.items, value[index]!, `${path}[${index}]`);
        if (failure !== undefined) return failure;
      }
    }
  }
  return undefined;
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return { value, truncated: false };
  const marker = "\n[tool output truncated]";
  const available = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  return { value: `${bytes.subarray(0, available).toString("utf8")}${marker}`, truncated: true };
}
