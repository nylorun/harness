import { describe, expect, it } from "vitest";
import type { ModelCall, ModelRequest } from "@nylorun/harness";
import { GatewayModelAdapter } from "../../src/local/runtime/runtime/model-adapter.js";
import type {
  ChatMessage,
  ModelGatewayRequest,
} from "../../src/local/runtime/runtime/contracts.js";

describe("GatewayModelAdapter", () => {
  it("lowers typed prompt items in harness order", async () => {
    let seen: ChatMessage[] | undefined;
    const adapter = new GatewayModelAdapter("test-model", {
      async *complete(request: ModelGatewayRequest) {
        seen = [...request.messages];
        yield { type: "text" as const, text: "ok" };
        yield {
          type: "done" as const,
          finishReason: "stop" as const,
          usage: { tokensIn: 1, tokensOut: 1 },
        };
      },
    });
    const call: ModelCall = {
      sessionId: "durable-session",
      tools: [],
      prompt: [
        {
          kind: "instructions",
          role: "system",
          content: [{ type: "text", text: "Be brief." }],
        },
        {
          kind: "message",
          role: "user",
          content: [{ type: "text", text: "Hi" }],
        },
        {
          kind: "tool-result",
          toolCallId: "call_1",
          toolName: "echo",
          status: "completed",
          content: [{ type: "text", text: '{"ok":true}' }],
        },
        {
          kind: "context",
          role: "user",
          content: [{ type: "text", text: "Current runtime context." }],
        },
      ],
    };
    await adapter.invoke(call, {
      request: { sessionId: "durable-session" } as ModelRequest,
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "tool", toolCallId: "call_1", content: '{"ok":true}' },
      { role: "user", content: "Current runtime context." },
    ]);
  });
});
