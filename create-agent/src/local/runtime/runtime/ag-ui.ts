import type { TranscriptEntry } from "@nylorun/harness";
import type { WireSessionEvent } from "./contracts.js";

/** The intentionally small AG-UI subset Nylo v1 can truthfully support. */
export type AgUiRunInput = Readonly<{
  threadId: string;
  runId: string;
  messages: readonly Readonly<{ id?: string; role: string; content: unknown }> [];
  state?: unknown;
  tools?: readonly unknown[];
  context?: readonly unknown[];
  forwardedProps?: unknown;
}>;

export type AgUiEvent = Readonly<Record<string, unknown>>;

/** Stateful projector used both for a live SSE response and deterministic wire tests. */
export class AgUiEventMapper {
  #textId: string | undefined;
  #textOpen = false;
  #errored = false;

  constructor(private readonly threadId: string, private readonly runId: string) {}

  started(): AgUiEvent { return { type: "RUN_STARTED", threadId: this.threadId, runId: this.runId }; }
  finished(): readonly AgUiEvent[] {
    const close = this.closeText();
    // AG-UI RunError is terminal. Emitting RunFinished afterwards makes compliant clients reject
    // the stream and hides the useful failure from Studio.
    return Object.freeze([...(close === undefined ? [] : [close]), ...(this.#errored ? [] : [{ type: "RUN_FINISHED", threadId: this.threadId, runId: this.runId }])]);
  }
  event(event: WireSessionEvent): readonly AgUiEvent[] {
    if (event.type === "final") {
      const events: AgUiEvent[] = [];
      if (!this.#textOpen) {
        this.#textId = `nylo-${this.threadId}-${event.seq}`;
        this.#textOpen = true;
        events.push({ type: "TEXT_MESSAGE_START", messageId: this.#textId, role: "assistant" });
      }
      if (typeof event.payload.output === "string" && event.payload.output !== "") events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: this.#textId, delta: event.payload.output });
      return Object.freeze(events);
    }
    if (event.type === "model.call") {
      const events: AgUiEvent[] = [];
      const close = this.closeText(); if (close !== undefined) events.push(close);
      const calls = Array.isArray(event.payload.tool_calls) ? event.payload.tool_calls : [];
      for (const call of calls) {
        if (typeof call !== "object" || call === null) continue;
        const item = call as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.name !== "string") continue;
        events.push({ type: "TOOL_CALL_START", toolCallId: item.id, toolCallName: item.name });
        if (typeof item.arguments === "string" && item.arguments !== "") events.push({ type: "TOOL_CALL_ARGS", toolCallId: item.id, delta: item.arguments });
        events.push({ type: "TOOL_CALL_END", toolCallId: item.id });
      }
      return Object.freeze(events);
    }
    if (event.type === "tool.call" && typeof event.payload.tool_call_id === "string") return Object.freeze([{ type: "TOOL_CALL_RESULT", toolCallId: event.payload.tool_call_id, content: typeof event.payload.model_result === "string" ? event.payload.model_result : "" }]);
    if (event.type === "error") {
      this.#errored = true;
      return Object.freeze([{ type: "RUN_ERROR", message: typeof event.payload.message === "string" ? event.payload.message : "Agent run failed.", code: typeof event.payload.code === "string" ? event.payload.code : undefined }]);
    }
    return Object.freeze([]);
  }
  private closeText(): AgUiEvent | undefined {
    if (!this.#textOpen || this.#textId === undefined) return undefined;
    this.#textOpen = false;
    return { type: "TEXT_MESSAGE_END", messageId: this.#textId };
  }
}

export function parseAgUiRun(value: Record<string, unknown>): AgUiRunInput | undefined {
  if (typeof value.threadId !== "string" || value.threadId.trim() === "" || typeof value.runId !== "string" || value.runId.trim() === "" || !Array.isArray(value.messages)) return undefined;
  if ((Array.isArray(value.tools) && value.tools.length > 0) || (Array.isArray(value.context) && value.context.length > 0)) return undefined;
  const messages = value.messages.filter((item): item is Readonly<{ id?: string; role: string; content: unknown }> => typeof item === "object" && item !== null && typeof (item as { role?: unknown }).role === "string");
  if (messages.length !== value.messages.length) return undefined;
  return Object.freeze({ threadId: value.threadId, runId: value.runId, messages, ...(value.state === undefined ? {} : { state: value.state }), ...(value.tools === undefined ? {} : { tools: value.tools as readonly unknown[] }), ...(value.context === undefined ? {} : { context: value.context as readonly unknown[] }), ...(value.forwardedProps === undefined ? {} : { forwardedProps: value.forwardedProps }) });
}

export function latestUserMessage(input: AgUiRunInput): string | undefined {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim() !== "") return message.content;
  }
  return undefined;
}

/** Projects Nylo's append-only events into the standard AG-UI stream used by HttpAgent. */
export function* agUiEvents(events: readonly WireSessionEvent[], threadId: string, runId: string): Generator<AgUiEvent> {
  const mapper = new AgUiEventMapper(threadId, runId);
  yield mapper.started();
  for (const event of events) yield* mapper.event(event);
  yield* mapper.finished();
}

export function agUiHistory(events: readonly WireSessionEvent[]): readonly Readonly<Record<string, unknown>>[] {
  const messages: Array<Readonly<Record<string, unknown>>> = [];
  let assistant = "";
  const commit = (): void => { if (assistant !== "") { messages.push({ id: `nylo-history-${messages.length}`, role: "assistant", content: assistant }); assistant = ""; } };
  for (const event of events) {
    if ((event.type === "session.started" || event.type === "session.run.started") && typeof event.payload.input === "string") { commit(); messages.push({ id: `nylo-history-${messages.length}`, role: "user", content: event.payload.input }); }
    else if (event.type === "final" && typeof event.payload.output === "string") assistant += event.payload.output;
    else if (event.type === "model.call") commit();
  }
  commit();
  return Object.freeze(messages);
}

/** Rebuilds AG-UI history from a durable step transcript after the process that ran it is gone. */
export function agUiHistoryFromTranscript(transcript: readonly TranscriptEntry[]): readonly Readonly<Record<string, unknown>>[] {
  const messages: Array<Readonly<Record<string, unknown>>> = [];
  for (const entry of transcript) {
    if (entry.kind === "input" && (entry.event.kind === "user-message" || entry.event.kind === "interrupt") && entry.event.text.trim() !== "") {
      messages.push({ id: `nylo-history-${messages.length}`, role: "user", content: entry.event.text });
    } else if (entry.kind === "final" && entry.output !== "") {
      messages.push({ id: `nylo-history-${messages.length}`, role: "assistant", content: entry.output });
    }
  }
  return Object.freeze(messages);
}
