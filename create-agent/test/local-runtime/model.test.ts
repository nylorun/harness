import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OpenAICompatibleModelGatewayAdapter, resolveModel } from "../../src/local/runtime/index.js";
import type { ModelGatewayChunk } from "../../src/local/runtime/index.js";
import { PiModelGatewayAdapter } from "../../src/local/runtime/runtime/pi-model-gateway.js";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nylo-model-gateway-"));
}

describe("model gateway resolution", () => {
  it("uses an explicit gateway profile before any direct credential and preserves its model identity", async () => {
    const projectRoot = await root();
    try {
      const resolved = await resolveModel("openai/gpt-4o", {
        projectRoot,
        env: {
          NYLO_MODEL_GATEWAY_URL: "https://gateway.example/v1",
          NYLO_MODEL_GATEWAY_API_KEY: "gateway-key",
          NYLO_MODEL_GATEWAY_AUTH_HEADER: "x-api-key",
          NYLO_MODEL_GATEWAY_AUTH_PREFIX: "Token ",
          NYLO_MODEL_GATEWAY_HEADERS: '{"x-tenant":"acme"}',
          NYLO_MODEL_GATEWAY_REQUEST_ID_HEADER: "x-gateway-request-id",
          OPENROUTER_API_KEY: "router-key",
          OPENAI_API_KEY: "direct-key"
        }
      });
      expect(resolved).toMatchObject({
        route: "model-gateway",
        baseUrl: "https://gateway.example/v1",
        upstreamModel: "openai/gpt-4o",
        accessMode: "external-gateway",
        protocol: "openai-chat-completions",
        capabilities: { portableHistory: true, providerState: false, hostedTools: false },
        credentialHeader: "x-api-key",
        credentialPrefix: "Token ",
        headers: { "x-tenant": "acme" },
        requestIdHeader: "x-gateway-request-id"
      });
      expect(resolved.credential?.value).toBe("gateway-key");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("selects an explicit named-endpoint protocol and classifies loopback endpoints without changing model identity", async () => {
    const projectRoot = await root();
    try {
      const resolved = await resolveModel("custom/model", {
        projectRoot,
        env: {
          NYLO_MODEL_GATEWAY_URL: "http://localhost:8080",
          NYLO_MODEL_GATEWAY_PROTOCOL: "anthropic-messages"
        }
      });
      expect(resolved).toMatchObject({
        route: "model-gateway",
        upstreamModel: "custom/model",
        protocol: "anthropic-messages",
        accessMode: "private-or-local-endpoint"
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("sends a local model identity's loaded-model suffix to an explicit local gateway", async () => {
    const projectRoot = await root();
    try {
      const resolved = await resolveModel("local/gemma4:e2b-mlx", {
        projectRoot,
        env: { NYLO_MODEL_GATEWAY_URL: "http://localhost:11434/v1" }
      });
      expect(resolved).toMatchObject({
        model: "local/gemma4:e2b-mlx",
        upstreamModel: "gemma4:e2b-mlx",
        baseUrl: "http://localhost:11434/v1",
        route: "model-gateway",
        accessMode: "private-or-local-endpoint"
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("refuses invalid named-endpoint protocol and access-mode values before a call", async () => {
    const projectRoot = await root();
    try {
      await expect(resolveModel("custom/model", {
        projectRoot,
        env: { NYLO_MODEL_GATEWAY_URL: "https://gateway.example", NYLO_MODEL_GATEWAY_PROTOCOL: "not-a-protocol" }
      })).rejects.toMatchObject({ diagnostic: { code: "NYLO_RUN_MODEL_GATEWAY_PROTOCOL_INVALID" } });
      await expect(resolveModel("custom/model", {
        projectRoot,
        env: { NYLO_MODEL_GATEWAY_URL: "https://gateway.example", NYLO_MODEL_GATEWAY_ACCESS_MODE: "cloud-account" }
      })).rejects.toMatchObject({ diagnostic: { code: "NYLO_RUN_MODEL_GATEWAY_ACCESS_MODE_INVALID" } });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("accepts the deprecated URL alias for one release and reports it in the resolution", async () => {
    const projectRoot = await root();
    try {
      const resolved = await resolveModel("openai/gpt-4o", {
        projectRoot,
        env: { NYLO_PROVIDER_BASE_URL: "http://legacy.local/v1" }
      });
      expect(resolved).toMatchObject({
        route: "model-gateway",
        baseUrl: "http://legacy.local/v1",
        deprecatedConfiguration: "NYLO_PROVIDER_BASE_URL"
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("prefers OpenRouter within the direct-credential tier, then selects the direct origin's upstream id", async () => {
    const projectRoot = await root();
    try {
      const viaRouter = await resolveModel("openai/gpt-4o", {
        projectRoot,
        env: { OPENROUTER_API_KEY: "router-key", OPENAI_API_KEY: "direct-key" }
      });
      expect(viaRouter).toMatchObject({ route: "openrouter", upstreamModel: "openai/gpt-4o" });

      const direct = await resolveModel("openai/gpt-4o", {
        projectRoot,
        env: { OPENAI_API_KEY: "direct-key" }
      });
      expect(direct).toMatchObject({ route: "direct", upstreamModel: "gpt-4o" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("routes a direct Anthropic identity through Messages with its native authentication header", async () => {
    const projectRoot = await root();
    try {
      const resolved = await resolveModel("anthropic/claude-sonnet", {
        projectRoot,
        env: { ANTHROPIC_API_KEY: "anthropic-key" }
      });
      expect(resolved).toMatchObject({
        route: "direct",
        upstreamModel: "claude-sonnet",
        baseUrl: "https://api.anthropic.com",
        protocol: "anthropic-messages",
        accessMode: "direct-inference-provider",
        credentialHeader: "x-api-key",
        credentialPrefix: ""
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("discovers LM Studio before Ollama and permits a credential-free local server", async () => {
    const projectRoot = await root();
    const requests: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      requests.push(String(input));
      return new Response("{}", { status: 200 });
    };
    try {
      const resolved = await resolveModel("local/example", { projectRoot, env: {}, fetch });
      expect(resolved).toMatchObject({
        route: "local-lm-studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        upstreamModel: "example",
        credentialRequired: false
      });
      expect(requests).toEqual(["http://127.0.0.1:1234/v1/models"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses Pi's Anthropic Messages path while retaining Nylorun auth and normalized streaming", async () => {
    const requests: Request[] = [];
    const adapter = new PiModelGatewayAdapter({
      baseUrl: "https://anthropic.test",
      model: "anthropic/claude",
      upstreamModel: "claude",
      protocol: "anthropic-messages",
      credential: async () => "secret",
      credentialRequired: true,
      credentialHeader: "x-api-key",
      credentialPrefix: "",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ].join(""), { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_1" } });
      }
    });
    const chunks: unknown[] = [];
    for await (const chunk of adapter.complete({
      model: "anthropic/claude",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }],
      tools: [],
      maxOutputTokens: 16
    }, new AbortController().signal)) chunks.push(chunk);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://anthropic.test/v1/messages");
    expect(requests[0].headers.get("x-api-key")).toBe("secret");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(chunks).toEqual(expect.arrayContaining([
      { type: "text", text: "ok" },
      expect.objectContaining({
        type: "done",
        finishReason: "stop",
        usage: { tokensIn: 2, tokensOut: 1 },
        evidence: expect.objectContaining({ protocol: "anthropic-messages", attempts: 1, requestId: "req_1" })
      })
    ]));
  });

  it("uses Pi's OpenAI Responses path with full-history input and normalized terminal usage", async () => {
    const requests: Request[] = [];
    const adapter = new PiModelGatewayAdapter({
      baseUrl: "https://responses.test/v1",
      model: "openai/gpt",
      upstreamModel: "gpt",
      protocol: "openai-responses",
      credential: async () => "secret",
      credentialRequired: true,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response([
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":0,"status":"in_progress","model":"gpt","output":[]}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ok"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
        ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
    });
    const chunks: unknown[] = [];
    for await (const chunk of adapter.complete({
      model: "openai/gpt",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }],
      tools: [],
      maxOutputTokens: 16
    }, new AbortController().signal)) chunks.push(chunk);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://responses.test/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret");
    expect(await requests[0].json()).toMatchObject({
      model: "gpt",
      stream: true,
      store: false,
      input: expect.any(Array)
    });
    expect(chunks).toEqual(expect.arrayContaining([
      { type: "text", text: "ok" },
      expect.objectContaining({ type: "done", finishReason: "stop", usage: { tokensIn: 2, tokensOut: 1 } })
    ]));
  });

  it("normalizes Pi Chat Completions tool-call deltas without taking over the tool loop", async () => {
    const adapter = new PiModelGatewayAdapter({
      baseUrl: "https://chat.test/v1",
      model: "openai/gpt",
      upstreamModel: "gpt",
      protocol: "openai-chat-completions",
      fetch: async () => new Response([
        'data: {"id":"chat_1","model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n'
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
    });
    const chunks: ModelGatewayChunk[] = [];
    for await (const chunk of adapter.complete({
      model: "openai/gpt",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", description: "Looks up weather.", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
      maxOutputTokens: 16
    }, new AbortController().signal)) chunks.push(chunk);

    const calls = chunks.filter((chunk): chunk is Extract<ModelGatewayChunk, { type: "tool-call" }> => chunk.type === "tool-call");
    expect(calls.map((call) => call.arguments ?? "").join("")).toBe('{"city":"Paris"}');
    expect(calls.map((call) => call.name).filter(Boolean)).toEqual(["weather"]);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "tool_calls", usage: { tokensIn: 2, tokensOut: 1 } });
  });

  it("re-resolves the credential for each outbound call and applies configured headers", async () => {
    const credentials = ["first", "second"];
    const authorizations: Array<string | null> = [];
    const tenants: Array<string | null> = [];
    const models: string[] = [];
    const adapter = new OpenAICompatibleModelGatewayAdapter({
      baseUrl: "http://gateway.test/v1",
      model: "gateway/model",
      credential: async () => credentials.shift(),
      credentialRequired: true,
      credentialHeader: "x-auth",
      credentialPrefix: "Token ",
      headers: { "x-tenant": "acme" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        authorizations.push(request.headers.get("x-auth"));
        tenants.push(request.headers.get("x-tenant"));
        models.push((await request.json() as { model: string }).model);
        return new Response(
          'data: {"model":"gateway/model","choices":[{"finish_reason":"stop","delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
          { status: 200 }
        );
      }
    });
    const request = { model: "gateway/model", messages: [], tools: [], maxOutputTokens: 16 };

    for await (const _ of adapter.complete(request, new AbortController().signal)) { /* drain */ }
    for await (const _ of adapter.complete(request, new AbortController().signal)) { /* drain */ }

    expect(authorizations).toEqual(["Token first", "Token second"]);
    expect(tenants).toEqual(["acme", "acme"]);
    expect(models).toEqual(["gateway/model", "gateway/model"]);
  });
});
