import { describe, expect, it } from "vitest";

import {
  createSession,
  ProviderError,
  rehydrate,
  SKILL_TOOL_NAME,
  type EventSink,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type SessionEvent,
  type ToolRegistration
} from "../src/session/index.js";

class MemorySink implements EventSink {
  readonly events: SessionEvent[] = [];

  append(event: SessionEvent): void {
    this.events.push(event);
  }
}

class ScriptedProvider implements ProviderAdapter {
  readonly requests: ProviderRequest[] = [];
  readonly #responses: readonly (readonly ProviderChunk[])[];

  constructor(responses: readonly (readonly ProviderChunk[])[]) {
    this.#responses = responses;
  }

  async *complete(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    for (const chunk of this.#responses[this.requests.length - 1] ?? []) yield chunk;
  }
}

const definition = { name: "echo", model: "nylorun/gemini-3", instructions: "Be exact." };

describe("session engine", () => {
  it("streams text, persists ordered events, and rehydrates the live state", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "text", text: "violet " },
        { type: "text", text: "bridge" },
        {
          type: "done",
          finishReason: "stop",
          usage: { tokensIn: 9, tokensOut: 2, costUsd: 0.001 },
          evidence: {
            resolvedModel: "google/gemini-version",
            gateway: "test-gateway",
            gatewayProfile: "test-profile",
            requestId: "req-1",
            provider: "google",
            attempts: 2,
            timeToFirstTokenMs: 12,
            totalLatencyMs: 40,
            fallback: false
          }
        }
      ]
    ]);
    const session = createSession({ sessionId: "s1", definition, provider, sink });

    const state = await session.start("ECHO: violet bridge");

    expect(sink.events.map((event) => event.type)).toEqual([
      "session.started",
      "harness.message",
      "harness.message",
      "model.call",
      "session.ended"
    ]);
    expect(sink.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state).toEqual(rehydrate(sink.events));
    expect(state).toMatchObject({ status: "completed", exitReason: "done", tokensIn: 9, tokensOut: 2 });
    expect(sink.events.find((event) => event.type === "model.call")?.payload).toMatchObject({
      model: "nylorun/gemini-3",
      resolved_model: "google/gemini-version",
      gateway: "test-gateway",
      gateway_profile: "test-profile",
      request_id: "req-1",
      provider: "google",
      attempts: 2,
      time_to_first_token_ms: 12,
      total_latency_ms: 40,
      fallback: false
    });
  });

  it("assembles fragmented tool calls, executes serially, and pairs the result", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "call-1", name: "Ba", arguments: "{\"command\":" },
        { type: "tool-call", index: 0, name: "sh", arguments: "\"printf hi\"}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 10, tokensOut: 5 } }
      ],
      [
        { type: "text", text: "hi" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 20, tokensOut: 1 } }
      ]
    ]);
    const calls: unknown[] = [];
    const bash: ToolRegistration = {
      name: "Bash",
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false
      },
      async *execute(input) {
        calls.push(input);
        yield { stream: "stdout", text: "hi", exitCode: 0 };
      }
    };
    const session = createSession({ sessionId: "s2", definition, provider, sink, tools: [bash] });

    const state = await session.start("Use Bash");

    expect(calls).toEqual([{ command: "printf hi" }]);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({ role: "tool", toolCallId: "call-1", content: "hi" });
    expect(sink.events.find((event) => event.type === "tool.call")?.payload).toMatchObject({
      tool: "Bash",
      exit: 0,
      model_result: "hi"
    });
    expect(sink.events.map((event) => event.type)).toContain("tool.call.started");
    const started = sink.events.find((event) => event.type === "tool.call.started");
    const completed = sink.events.find((event) => event.type === "tool.call");
    expect(started?.seq).toBeLessThan(completed?.seq ?? 0);
    expect(started?.payload.args_digest).toBe(completed?.payload.args_digest);
    expect(state.exitReason).toBe("done");
  });

  it("returns a synthetic result for malformed or unknown tools", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "bad", name: "Missing", arguments: "{" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 1, tokensOut: 1 } }
      ],
      [{ type: "done", finishReason: "stop", usage: { tokensIn: 1, tokensOut: 1 } }]
    ]);

    await createSession({ sessionId: "s3", definition, provider, sink }).start("go");

    expect(sink.events.find((event) => event.type === "tool.call")?.payload).toMatchObject({ exit: 1 });
    expect(sink.events.some((event) => event.type === "tool.call.started")).toBe(false);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "bad" });
  });

  it("enforces turn and token limits with a budget exit", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [{ type: "done", finishReason: "stop", usage: { tokensIn: 6, tokensOut: 5 } }]
    ]);

    const state = await createSession({
      sessionId: "s4",
      definition,
      provider,
      sink,
      limits: { maxTokens: 10 }
    }).start("go");

    expect(state.exitReason).toBe("budget");
    expect(sink.events.at(-1)?.payload).toMatchObject({ limit: "tokens" });
  });

  it("pairs requested tools before a turn limit ends the session", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "paired", name: "Bash", arguments: "{\"command\":\"true\"}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 1, tokensOut: 1 } }
      ]
    ]);
    const tool: ToolRegistration = {
      name: "Bash",
      description: "run",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async *execute() {
        yield { exitCode: 0 };
      }
    };

    await createSession({
      sessionId: "s-limit-pair",
      definition,
      provider,
      sink,
      tools: [tool],
      limits: { maxTurns: 1 }
    }).start("go");

    expect(sink.events.slice(-2).map((event) => event.type)).toEqual(["tool.call", "session.ended"]);
    expect(sink.events.at(-1)?.payload).toMatchObject({ exit_reason: "budget", limit: "turns" });
  });

  it("stops only after a paired tool result and resumes without re-emitting session.started", async () => {
    const firstSink = new MemorySink();
    const tool: ToolRegistration = {
      name: "Bash",
      description: "run",
      inputSchema: { type: "object" },
      async *execute() {
        yield { text: "durable", exitCode: 0 };
      }
    };
    const firstProvider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "durable-1", name: "Bash", arguments: "{}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 2, tokensOut: 1 } }
      ]
    ]);
    const first = createSession({
      sessionId: "resume-1",
      definition,
      provider: firstProvider,
      sink: firstSink,
      tools: [tool],
      episode: { ordinal: 1, fencingEpoch: 1 },
      onSafePoint: () => true
    });

    const boundaryState = await first.start("go");
    expect(boundaryState.status).toBe("running");
    expect(firstSink.events.at(-1)?.type).toBe("tool.call");
    expect(firstSink.events.map((event) => event.type)).toContain("session.episode.started");

    const secondSink = new MemorySink();
    const secondProvider = new ScriptedProvider([
      [
        { type: "text", text: "finished" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 3, tokensOut: 1 } }
      ]
    ]);
    const resumed = createSession({
      sessionId: "resume-1",
      definition,
      provider: secondProvider,
      sink: secondSink,
      tools: [tool],
      resumeFrom: boundaryState,
      resumeInterruption: { reason: "platform_restart", previousOrdinal: 1 },
      episode: { ordinal: 2, fencingEpoch: 2 }
    });

    const finalState = await resumed.resume();
    expect(secondSink.events.map((event) => event.type).slice(0, 3)).toEqual([
      "session.interrupted",
      "session.resumed",
      "session.episode.started"
    ]);
    expect(secondSink.events.some((event) => event.type === "session.started")).toBe(false);
    expect(secondProvider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "go" }),
        expect.objectContaining({ role: "tool", toolCallId: "durable-1", content: "durable" })
      ])
    );
    expect(finalState.status).toBe("completed");
    expect(rehydrate([...firstSink.events, ...secondSink.events])).toEqual(finalState);
  });

  it("emits the closed interrupted_outcome_unknown tool result", async () => {
    const sink = new MemorySink();
    const session = createSession({
      sessionId: "unknown-tool-outcome",
      definition,
      provider: new ScriptedProvider([]),
      sink
    });

    const event = await session.appendInterruptedToolResult({
      tool: "charge",
      toolCallId: "charge-1",
      argsDigest: "a".repeat(64)
    });

    expect(event.type).toBe("tool.call");
    expect(event.payload).toMatchObject({
      tool_call_id: "charge-1",
      error: "interrupted_outcome_unknown",
      outcome: "interrupted_outcome_unknown"
    });
  });

  it("aborts provider work when the injected clock reaches the timeout", async () => {
    const sink = new MemorySink();
    const provider: ProviderAdapter = {
      async *complete(_request, signal) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
        yield { type: "done", finishReason: "stop", usage: { tokensIn: 0, tokensOut: 0 } };
      }
    };
    const state = await createSession({
      sessionId: "s-timeout",
      definition,
      provider,
      sink,
      limits: { timeoutMs: 1 },
      clock: {
        now: () => new Date("2026-07-21T00:00:00.000Z"),
        setTimeout: (callback) => {
          queueMicrotask(callback);
          return 1;
        },
        clearTimeout: () => undefined
      }
    }).start("go");

    expect(state).toMatchObject({ status: "completed", exitReason: "timeout" });
  });

  it("truncates model-visible tool output but retains the full event stream", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "long", name: "Bash", arguments: "{\"command\":\"x\"}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 1, tokensOut: 1 } }
      ],
      [{ type: "done", finishReason: "stop", usage: { tokensIn: 1, tokensOut: 1 } }]
    ]);
    const tool: ToolRegistration = {
      name: "Bash",
      description: "run",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async *execute() {
        yield { stream: "stdout", text: "abcdefghijklmnopqrstuvwxyz", exitCode: 0 };
      }
    };

    await createSession({
      sessionId: "s5",
      definition,
      provider,
      sink,
      tools: [tool],
      limits: { maxToolResultBytes: 24 }
    }).start("go");

    const event = sink.events.find((candidate) => candidate.type === "tool.call");
    expect(event?.payload.stdout).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(event?.payload.truncated).toBe(true);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
  });
  it("preserves normalized provider failure codes in terminal events", async () => {
    const sink = new MemorySink();
    const provider: ProviderAdapter = {
      async *complete() {
        throw new ProviderError("The configured model is unavailable.", {
          code: "model_unavailable",
          status: 404
        });
      }
    };

    const state = await createSession({ sessionId: "provider-error", definition, provider, sink }).start("go");

    expect(state).toMatchObject({ status: "failed", exitReason: "error" });
    expect(sink.events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "model_unavailable"
    });
    expect(sink.events.at(-1)?.payload).toMatchObject({ code: "model_unavailable" });
  });
});

describe("skill activation", () => {
  const skills = [
    { name: "refunds", description: "Process a refund.", body: "Refund procedure." },
    { name: "escalation", description: "Escalate a case.", body: "Escalation procedure." }
  ];
  const skilled = { ...definition, skills };

  function activationProvider(): ScriptedProvider {
    return new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "skill-1", name: SKILL_TOOL_NAME, arguments: "{\"name\":\"refunds\"}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 10, tokensOut: 4 } }
      ],
      [
        { type: "text", text: "done" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 12, tokensOut: 1 } }
      ]
    ]);
  }

  it("advertises the platform tool and lists every skill by name and description", async () => {
    const sink = new MemorySink();
    const provider = activationProvider();

    await createSession({ sessionId: "skills-catalog", definition: skilled, provider, sink }).start("go");

    const system = provider.requests[0]?.messages[0];
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([SKILL_TOOL_NAME]);
    expect(system?.content).toContain("Be exact.");
    expect(system?.content).toContain("- escalation: Escalate a case.");
    expect(system?.content).toContain("- refunds: Process a refund.");
  });

  it("keeps skill bodies out of context until the model activates one", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "text", text: "no skill needed" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 5, tokensOut: 3 } }
      ]
    ]);

    await createSession({ sessionId: "skills-unused", definition: skilled, provider, sink }).start("go");

    expect(provider.requests[0]?.messages[0]?.content).not.toContain("Refund procedure.");
    expect(sink.events.some((event) => event.type === "skill.invocation")).toBe(false);
  });

  it("returns the body as the tool result and records a skill.invocation", async () => {
    const sink = new MemorySink();
    const provider = activationProvider();

    await createSession({ sessionId: "skills-activate", definition: skilled, provider, sink }).start("refund please");

    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "skill-1",
      content: "Refund procedure."
    });
    const types = sink.events.map((event) => event.type);
    expect(types.filter((type) => type.startsWith("tool.call") || type === "skill.invocation")).toEqual([
      "tool.call.started",
      "tool.call",
      "skill.invocation"
    ]);
    expect(sink.events.find((event) => event.type === "skill.invocation")?.payload).toEqual({
      skill: "refunds"
    });
  });

  it("reports an unknown skill without recording an activation", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "skill-x", name: SKILL_TOOL_NAME, arguments: "{\"name\":\"absent\"}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 3, tokensOut: 2 } }
      ],
      [
        { type: "text", text: "recovered" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 4, tokensOut: 1 } }
      ]
    ]);

    await createSession({ sessionId: "skills-unknown", definition: skilled, provider, sink }).start("go");

    expect(sink.events.find((event) => event.type === "tool.call")?.payload).toMatchObject({ exit: 1 });
    expect(sink.events.some((event) => event.type === "skill.invocation")).toBe(false);
  });

  it("registers no platform tool and changes no prompt when a folder carries no skills", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "text", text: "plain" },
        { type: "done", finishReason: "stop", usage: { tokensIn: 2, tokensOut: 1 } }
      ]
    ]);

    await createSession({ sessionId: "skills-absent", definition, provider, sink }).start("go");

    expect(provider.requests[0]?.tools).toEqual([]);
    expect(provider.requests[0]?.messages[0]?.content).toBe("Be exact.");
  });

  it("carries a host-supplied abort code into the error event and terminal state", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "call-1", name: "leaky", arguments: "{}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 2, tokensOut: 1 } }
      ]
    ]);
    const tool: ToolRegistration = {
      name: "leaky",
      description: "Aborts before executing, the way a host does for an unresolvable secret.",
      inputSchema: { type: "object" },
      // eslint-disable-next-line require-yield
      async *execute() {
        session.abort('secret "TOKEN" is not provisioned', "secret_resolution_failed");
        throw new Error('secret "TOKEN" is not provisioned');
      }
    };
    const session = createSession({ sessionId: "abort-code", definition, provider, sink, tools: [tool] });

    const state = await session.start("go");

    expect(state).toMatchObject({ status: "failed", exitReason: "error" });
    expect(sink.events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "secret_resolution_failed",
      message: 'secret "TOKEN" is not provisioned'
    });
  });

  it("defaults the abort code to \"aborted\"", async () => {
    const sink = new MemorySink();
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", index: 0, id: "call-1", name: "halting", arguments: "{}" },
        { type: "done", finishReason: "tool_calls", usage: { tokensIn: 2, tokensOut: 1 } }
      ]
    ]);
    const tool: ToolRegistration = {
      name: "halting",
      description: "Aborts with no code.",
      inputSchema: { type: "object" },
      // eslint-disable-next-line require-yield
      async *execute() {
        session.abort("host stopped the session");
        throw new Error("host stopped the session");
      }
    };
    const session = createSession({ sessionId: "abort-default", definition, provider, sink, tools: [tool] });

    await session.start("go");

    expect(sink.events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "aborted",
      message: "host stopped the session"
    });
  });
});
