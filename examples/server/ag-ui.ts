import type { CanonicalEvent } from "../services/journal.js";

/** Minimal truthful AG-UI projection from the same canonical events Studio displays. */
export function agUiEvents(
  events: readonly CanonicalEvent[],
  threadId: string,
  runId: string,
): readonly Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [{ type: "RUN_STARTED", threadId, runId }];
  for (const event of events) {
    if (event.type === "tool.sealed") {
      const calls = Array.isArray(
        (event.payload.attributes as Record<string, unknown> | undefined)?.executable,
      )
        ? ((event.payload.attributes as Record<string, unknown>).executable as readonly Record<
            string,
            unknown
          >[])
        : [];
      for (const call of calls) {
        const id = typeof call.callId === "string" ? call.callId : undefined;
        const name = typeof call.toolName === "string" ? call.toolName : undefined;
        if (!id || !name) continue;
        output.push(
          { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
          { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(call.args ?? {}) },
          { type: "TOOL_CALL_END", toolCallId: id },
        );
      }
    } else if (event.type === "tool.completed" && typeof event.payload.callId === "string") {
      output.push({
        type: "TOOL_CALL_RESULT",
        toolCallId: event.payload.callId,
        content: JSON.stringify(
          event.payload.attributes ?? { outcome: event.payload.outcome ?? "completed" },
        ),
      });
    } else if (event.type === "final" && typeof event.payload.output === "string") {
      const messageId = `nylorun-${threadId}-${event.seq}`;
      output.push(
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: event.payload.output },
        { type: "TEXT_MESSAGE_END", messageId },
      );
    } else if (event.type === "error") {
      output.push({
        type: "RUN_ERROR",
        message:
          typeof event.payload.message === "string" ? event.payload.message : "Agent run failed.",
      });
    }
  }
  output.push({ type: "RUN_FINISHED", threadId, runId });
  return Object.freeze(output);
}

/**
 * Preserve headers installed by the Hono host (notably loopback CORS) when a
 * route returns a raw streaming Response instead of `context.json()`.
 */
export function sse(events: readonly Record<string, unknown>[], inherited?: HeadersInit): Response {
  const headers = new Headers(inherited);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers,
  });
}
