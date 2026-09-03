import { describe, expect, it } from "vitest";
import { HarnessError } from "../src/errors.js";
import {
  anthropicAdapter,
  chatCompletionsAdapter,
  fromChatCompletions,
  fromMessages,
  fromResponses,
  responsesAdapter,
  toChatCompletions,
  toMessages,
  toResponses,
} from "../src/model/adapters.js";
import type { ModelAdapterContext, ModelCall, ModelRequest } from "../src/types/model.js";

const call: ModelCall = {
  sessionId: "session-1",
  model: { controls: { temperature: 0.2, maxOutputTokens: 256 } },
  prompt: [
    { kind: "instructions", role: "system", content: [{ type: "text", text: "Be brief." }] },
    { kind: "message", role: "user", content: [{ type: "text", text: "Weather?" }] },
    {
      kind: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool-call", id: "call-1", name: "weather", args: { city: "Delhi" } },
      ],
    },
    {
      kind: "tool-result",
      toolCallId: "call-1",
      toolName: "weather",
      status: "completed",
      content: [{ type: "text", text: '{"temp":30}' }],
    },
    {
      kind: "context",
      role: "user",
      content: [{ type: "text", text: "Current runtime context." }],
    },
  ],
  tools: [
    {
      name: "weather",
      description: "Look up weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};

const context = {
  request: {} as ModelRequest,
  invocationId: "invocation-1",
  signal: new AbortController().signal,
  reportPreparedCall: () => undefined,
} satisfies ModelAdapterContext;

describe("model adapter translators", () => {
  it("translates a projected call to Chat Completions", () => {
    expect(toChatCompletions(call)).toEqual({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Delhi"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"temp":30}' },
        { role: "user", content: "Current runtime context." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Look up weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      temperature: 0.2,
      max_completion_tokens: 256,
    });
  });

  it("maps portable output schemas without selecting provider strictness", () => {
    const structured = {
      ...call,
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    };
    expect(toChatCompletions(structured).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "harness_output", schema: structured.outputSchema },
    });
    expect(toResponses(structured).text).toEqual({
      format: { type: "json_schema", name: "harness_output", schema: structured.outputSchema },
    });
    expect(
      fromChatCompletions(
        { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] },
        structured,
      ).output,
    ).toEqual([{ type: "json", value: { ok: true } }]);
    expect(
      fromResponses(
        {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "nope" }] }],
        },
        structured,
      ).output,
    ).toEqual([{ type: "text", text: "nope" }]);
    expect(() => toMessages(structured, 1024)).toThrowError(
      expect.objectContaining({ code: "model.unsupported-output-schema" }),
    );
  });

  it("translates a projected call to Responses", () => {
    expect(toResponses(call)).toEqual({
      instructions: "Be brief.",
      input: [
        { type: "message", role: "user", content: "Weather?" },
        { type: "message", role: "assistant", content: "Checking." },
        {
          type: "function_call",
          call_id: "call-1",
          name: "weather",
          arguments: '{"city":"Delhi"}',
        },
        { type: "function_call_output", call_id: "call-1", output: '{"temp":30}' },
        { type: "message", role: "user", content: "Current runtime context." },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      temperature: 0.2,
      max_output_tokens: 256,
    });
  });

  it("translates a projected call to Anthropic Messages", () => {
    expect(toMessages(call, 1024)).toEqual({
      system: "Be brief.",
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "call-1", name: "weather", input: { city: "Delhi" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: '{"temp":30}' }],
        },
        { role: "user", content: "Current runtime context." },
      ],
      tools: [
        {
          name: "weather",
          description: "Look up weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      temperature: 0.2,
      max_tokens: 256,
    });
  });

  it("uses the Anthropic default when the call omits max output tokens", () => {
    expect(toMessages({ ...call, model: undefined }, 1024).max_tokens).toBe(1024);
    try {
      toMessages(call, -1);
      expect.fail("Expected invalid defaultMaxOutputTokens to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "model.adapter-invalid-options" });
    }
  });

  it("marks denied tool results as Anthropic tool errors", () => {
    const prompt = call.prompt.map((item) =>
      item.kind === "tool-result" ? { ...item, status: "denied" as const } : item,
    );
    expect(toMessages({ ...call, prompt }, 1024).messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: '{"temp":30}',
          is_error: true,
        },
      ],
    });
  });

  it("decodes each provider shape", () => {
    expect(
      fromChatCompletions({
        id: "chat-1",
        model: "chat-model",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Calling.",
              tool_calls: [
                { id: "call-2", function: { name: "weather", arguments: '{"city":"Pune"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      }),
    ).toEqual({
      output: [
        { type: "text", text: "Calling." },
        {
          type: "tool-call",
          id: "call-2",
          name: "weather",
          args: { city: "Pune" },
          raw: '{"city":"Pune"}',
        },
      ],
      finishReason: "tool-calls",
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      evidence: { requestId: "chat-1", resolvedModel: "chat-model" },
    });
    expect(
      fromResponses({
        id: "resp-1",
        model: "response-model",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "Plan." }] },
          {
            type: "function_call",
            call_id: "call-3",
            name: "weather",
            arguments: '{"city":"Goa"}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }),
    ).toMatchObject({
      output: [
        { type: "reasoning", text: "Plan." },
        { type: "tool-call", id: "call-3", name: "weather", args: { city: "Goa" } },
      ],
      finishReason: "tool-calls",
    });
    expect(
      fromMessages({
        id: "msg-1",
        model: "claude",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "Plan." },
          { type: "tool_use", id: "call-4", name: "weather", input: { city: "Kochi" } },
        ],
        usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 1 },
      }),
    ).toMatchObject({
      output: [
        { type: "reasoning", text: "Plan." },
        { type: "tool-call", id: "call-4", name: "weather", args: { city: "Kochi" } },
      ],
      finishReason: "tool-calls",
      usage: { inputTokens: 6, outputTokens: 2, cachedTokens: 1 },
    });
  });

  it("maps native length and content-filter finish reasons", () => {
    expect(
      fromChatCompletions({
        choices: [{ finish_reason: "content_filter", message: { content: null } }],
      }).finishReason,
    ).toBe("content-filter");
    expect(
      fromResponses({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }).finishReason,
    ).toBe("length");
    expect(fromMessages({ stop_reason: "max_tokens", content: [] }).finishReason).toBe("length");
  });

  it("rejects malformed provider tool arguments before tool execution", () => {
    try {
      fromChatCompletions({
        choices: [
          {
            message: {
              tool_calls: [{ id: "call", function: { name: "weather", arguments: "not json" } }],
            },
          },
        ],
      });
      expect.fail("Expected malformed tool arguments to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect(error).toMatchObject({ code: "model.adapter-invalid-response" });
    }
  });

  it("adapter helpers forward the original call and context", async () => {
    const sent: unknown[] = [];
    const adapter = chatCompletionsAdapter(async (request, sentCall, sentContext) => {
      sent.push(request, sentCall, sentContext);
      return { choices: [{ finish_reason: "stop", message: { content: "Done." } }] };
    });
    await expect(adapter(call, context)).resolves.toMatchObject({ output: [{ text: "Done." }] });
    expect(sent).toEqual([toChatCompletions(call), call, context]);

    const responseAdapter = responsesAdapter(async () => ({ status: "completed", output: [] }));
    await expect(responseAdapter(call, context)).resolves.toMatchObject({ finishReason: "stop" });

    const messageAdapter = anthropicAdapter({
      defaultMaxOutputTokens: 512,
      send: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] }),
    });
    await expect(messageAdapter(call, context)).resolves.toMatchObject({
      output: [{ text: "Done." }],
    });
  });
});
