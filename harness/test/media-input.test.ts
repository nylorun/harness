import { describe, expect, it, vi } from "vitest";
import { preparedModel, type ModelCall, type ObserveEvent } from "../src/index.js";
import { chatCompletionsAdapter, toMessages, toResponses } from "../src/model/adapters.js";
import { model, testAgent } from "./fixtures.js";

const image = {
  type: "media" as const,
  mediaType: "image/png",
  reference: { url: "https://cdn.example.test/chart.png" },
};

describe("media input", () => {
  it("preserves ordered media content through input, middleware, transcript, and ModelCall", async () => {
    const arrivals: unknown[] = [];
    const calls: ModelCall[] = [];
    const reference = { url: "https://cdn.example.test/chart.png" };
    const session = testAgent()
      .use("inspect", async (request, next) => {
        arrivals.push(request.arrivals);
        return next();
      })
      .with(
        model(async (call) => {
          calls.push(call);
          return "done";
        }),
      )
      .build()
      .run();

    await session.input({
      content: [
        { type: "text", text: "Describe this chart." },
        { type: "media", mediaType: "image/png", reference },
        { type: "text", text: "Use one sentence." },
      ],
    }).completed;
    reference.url = "https://changed.example.test/chart.png";

    const expected = [
      { type: "text", text: "Describe this chart." },
      { type: "media", mediaType: "image/png", reference: { url: image.reference.url } },
      { type: "text", text: "Use one sentence." },
    ];
    expect(arrivals).toEqual([
      [
        {
          kind: "user-message",
          content: expected,
        },
      ],
    ]);
    expect(session.state.transcript[0]).toMatchObject({ event: { content: expected } });
    expect(calls[0]?.prompt).toContainEqual({ kind: "message", role: "user", content: expected });
    expect(Object.isFrozen(calls[0]?.prompt[0]?.content)).toBe(true);
  });

  it("copies media references into serializable execution state", async () => {
    const { Agent } = await import("../src/index.js");
    const reference = { url: "https://cdn.example.test/seed.png" };
    const agent = Agent({ id: "a", name: "A" }).build();
    const result = await agent.run({
      input: { content: [{ ...image, reference }] },
      onModelCall: async () => "done",
    });
    reference.url = "changed";
    expect(JSON.stringify(result.state)).toContain("https://cdn.example.test/seed.png");
    const resumed = await agent.run({
      state: JSON.parse(JSON.stringify(result.state)),
      input: "next",
      onModelCall: async (call) => {
        expect(JSON.stringify(call)).toContain("https://cdn.example.test/seed.png");
        return "ok";
      },
    });
    expect(resumed.status).toBe("completed");
  });
  it("rejects malformed media before model invocation", async () => {
    const { Agent } = await import("../src/index.js");
    const invoke = vi.fn(async () => "done");
    await expect(
      Agent({ id: "a", name: "A" })
        .build()
        .run({
          input: { content: [{ type: "media", mediaType: "", reference: {} }] },
          onModelCall: invoke,
        }),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps direct URL images in bundled adapters and rejects unsupported content before send", async () => {
    const mediaCall: ModelCall = {
      executionId: "session",
      prompt: [
        {
          kind: "message",
          role: "user",
          content: [{ type: "text", text: "Inspect." }, image],
        },
      ],
      tools: [],
    };
    expect(toResponses(mediaCall).input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect." },
          { type: "input_image", image_url: "https://cdn.example.test/chart.png" },
        ],
      },
    ]);
    expect(toMessages(mediaCall, 64).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect." },
          {
            type: "image",
            source: { type: "url", url: "https://cdn.example.test/chart.png" },
          },
        ],
      },
    ]);

    const send = vi.fn(async () => ({ choices: [{ message: { content: "done" } }] }));
    const session = testAgent().with(chatCompletionsAdapter(send)).build().run();
    await session.input({ content: [{ type: "text", text: "Inspect." }, image] }).completed;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              { type: "text", text: "Inspect." },
              { type: "image_url", image_url: { url: "https://cdn.example.test/chart.png" } },
            ],
          }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );

    const unsupportedSend = vi.fn(async () => ({ choices: [{ message: { content: "no" } }] }));
    const unsupported = testAgent().with(chatCompletionsAdapter(unsupportedSend)).build().run();
    const result = await unsupported.input({
      content: [{ type: "media", mediaType: "application/pdf", reference: { url: "x" } }],
    }).completed;
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tripwire",
        tripwire: expect.objectContaining({ code: "model.unsupported-content" }),
      }),
    );
    expect(unsupportedSend).not.toHaveBeenCalled();
  });

  it("observes one derived call from preparedModel after the canonical call", async () => {
    const events: ObserveEvent[] = [];
    const adapter = preparedModel({
      adapter: "test-provider",
      async prepare(call) {
        return {
          request: { messageCount: call.prompt.length },
          observed: { messageCount: call.prompt.length },
        };
      },
      async send(request) {
        return { text: `prepared ${request.messageCount}` };
      },
      decode(response) {
        return (response as { text: string }).text;
      },
    });
    const session = testAgent().with(adapter).build().run();
    session.observe((event) => events.push(event));

    await session.input("go").completed;
    const requested = events.find((event) => event.type === "model.requested");
    const prepared = events.find((event) => event.type === "model.prepared");
    if (!requested || !prepared || prepared.type !== "model.prepared")
      throw new Error("missing model preparation events");
    expect(events.indexOf(requested)).toBeLessThan(events.indexOf(prepared));
    expect(prepared.attributes).toEqual({ adapter: "test-provider", call: { messageCount: 1 } });
    expect(Object.isFrozen(prepared.attributes.call)).toBe(true);
  });
});
