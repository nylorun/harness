import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { piModel } from "../src/model/pi-model.js";
import type { RuntimeModelCall } from "../src/contracts.js";
import { scrub } from "../src/adapters/journal.js";
const roots: string[] = [];
const selection = {
  provider: "custom",
  model: "test-model",
  custom: { baseUrl: "https://provider.invalid/v1" },
};
const signal = () => new AbortController().signal;
const call: RuntimeModelCall = {
  sessionId: "test",
  tools: [],
  prompt: [
    {
      kind: "message",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function response(delta: unknown, finishReason = "stop") {
  return new Response(
    `data: ${JSON.stringify({
      id: "test",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      id: "test",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
it("loads configuration lazily and reports missing setup only on invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lazy-"));
  roots.push(root);
  const adapter = piModel({ root });
  await expect(adapter(call, { signal: signal() })).rejects.toThrow(
    "nylorun configure",
  );
});
it("preserves context, assistant tool calls, tool results and model controls through the provider", async () => {
  vi.stubEnv("NYLO_CUSTOM_API_KEY", "test-provider-secret");
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ role: "assistant", content: "42" });
    }),
  );
  const adapter = piModel({ selection });
  const result = await adapter(
    {
      ...call,
      model: { controls: { temperature: 0.2, maxOutputTokens: 80 } },
      tools: [
        {
          name: "calculate",
          description: "Calculate",
          inputSchema: { type: "object" },
        },
      ],
      prompt: [
        {
          kind: "instructions",
          role: "system",
          content: [{ type: "text", text: "Be brief." }],
        },
        {
          kind: "context",
          role: "user",
          content: [{ type: "text", text: "context facts" }],
        },
        {
          kind: "message",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: "call-1",
              name: "calculate",
              args: { value: 42 },
            },
          ],
        },
        {
          kind: "tool-result",
          toolCallId: "call-1",
          toolName: "calculate",
          status: "completed",
          content: [{ type: "text", text: "42" }],
        },
      ],
    },
    { signal: signal() },
  );
  expect(result.output).toEqual([{ type: "text", text: "42" }]);
  expect(JSON.stringify(body.messages)).toContain("context facts");
  expect(JSON.stringify(body.messages)).toContain('"tool_call_id":"call-1"');
  expect(JSON.stringify(body.messages)).toContain('"tool_calls"');
  expect(body.temperature).toBe(0.2);
  expect(body.max_tokens ?? body.max_completion_tokens).toBe(80);
});
it("returns provider tool calls using the portable model contract", async () => {
  vi.stubEnv("NYLO_CUSTOM_API_KEY", "test-provider-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "tool-1",
              type: "function",
              function: { name: "calculate", arguments: '{"value":42}' },
            },
          ],
        },
        "tool_calls",
      ),
    ),
  );
  expect(
    await piModel({ selection })(call, { signal: signal() }),
  ).toMatchObject({
    finishReason: "tool-calls",
    output: [
      {
        type: "tool-call",
        id: "tool-1",
        name: "calculate",
        args: { value: 42 },
      },
    ],
  });
});
it("honors cancellation before contacting a provider", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(
    piModel({ selection })(call, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("redacts credentials read from the vault in provider failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vault-"));
  roots.push(root);
  await mkdir(join(root, ".env"));
  await writeFile(
    join(root, ".env", "auth.json"),
    JSON.stringify({ custom: { type: "api_key", key: "vault-test-secret" } }),
  );
  vi.stubEnv("NYLO_CUSTOM_API_KEY", "vault-test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "denied vault-test-secret" } }),
          { status: 401 },
        ),
    ),
  );
  await expect(
    piModel({ root, selection })(call, { signal: signal() }),
  ).rejects.toThrow("[redacted]");
});
it("keeps usage counters while redacting credential fields and inline images", () => {
  expect(
    scrub(
      {
        inputTokens: 10,
        access_token: "secret",
        api_key: "secret",
        preview: "data:image/png;base64,abcd",
      },
      [],
    ),
  ).toEqual({
    inputTokens: 10,
    access_token: "[redacted]",
    api_key: "[redacted]",
    preview: "[inline image data redacted]",
  });
});
it.each(["tool", "text", "reasoning"])(
  "replays Gemini %s signatures on the tool-result request",
  async (signatureBlock) => {
    vi.stubEnv("GEMINI_API_KEY", "test-google-secret");
    const requests: { contents: { role: string; parts: unknown[] }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        const body =
          options?.body ??
          (url instanceof Request ? await url.text() : undefined);
        requests.push(JSON.parse(String(body)));
        const parts =
          requests.length === 1
            ? [
                ...(signatureBlock === "text"
                  ? [{ text: "", thoughtSignature: "dGV4dA==" }]
                  : []),
                ...(signatureBlock === "reasoning"
                  ? [
                      {
                        text: "",
                        thought: true,
                        thoughtSignature: "dGhpbmtpbmc=",
                      },
                    ]
                  : []),
                {
                  functionCall: { name: "add_numbers", args: { a: 19, b: 7 } },
                  thoughtSignature: "c2lnbmF0dXJl",
                },
              ]
            : [{ text: "26" }];
        return new Response(
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: "model", parts }, finishReason: "STOP" },
            ],
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const adapter = piModel({
      selection: { provider: "google", model: "gemini-flash-latest" },
    });
    const first = await adapter(call, { signal: signal() });
    const toolCall = first.output.find((part) => part.type === "tool-call");
    if (!toolCall || toolCall.type !== "tool-call")
      throw new Error("Missing function call");
    const nextCall: RuntimeModelCall = {
      ...call,
      prompt: [
        ...call.prompt,
        {
          kind: "message",
          role: "assistant",
          content: first.output.filter((part) => part.type !== "json"),
        },
        {
          kind: "tool-result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "completed",
          content: [{ type: "text", text: '{"sum":26}' }],
        },
      ],
    };
    // A fresh adapter and JSON round trip rule out hidden per-instance state.
    await piModel({
      selection: { provider: "google", model: "gemini-flash-latest" },
    })(JSON.parse(JSON.stringify(nextCall)), { signal: signal() });
    expect(
      requests[1]?.contents.find((message) => message.role === "model")?.parts,
    ).toContainEqual({
      functionCall: { name: "add_numbers", args: { a: 19, b: 7 } },
      thoughtSignature: "c2lnbmF0dXJl",
    });
    if (signatureBlock === "text")
      expect(
        requests[1]?.contents.find((message) => message.role === "model")
          ?.parts[0],
      ).toEqual({ text: "", thoughtSignature: "dGV4dA==" });
    if (signatureBlock === "reasoning")
      expect(
        requests[1]?.contents.find((message) => message.role === "model")
          ?.parts[0],
      ).toEqual({ text: "", thought: true, thoughtSignature: "dGhpbmtpbmc=" });
    await piModel({
      selection: { provider: "google", model: "gemini-2.5-flash" },
    })(nextCall, { signal: signal() });
    expect(JSON.stringify(requests[2])).not.toContain("thoughtSignature");
  },
);
