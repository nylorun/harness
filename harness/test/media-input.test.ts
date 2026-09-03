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

  it("accepts and copies media content in a durable seed", async () => {
    const reference = { url: "https://cdn.example.test/seed.png" };
    const session = testAgent()
      .with(model(async () => "continued"))
      .build()
      .run({
        seed: {
          transcript: [
            {
              kind: "input",
              turnId: "old",
              event: { kind: "user-message", content: [{ ...image, reference }] },
            },
          ],
        },
      });
    reference.url = "https://changed.example.test/seed.png";

    expect(session.state.transcript).toMatchObject([
      {
        event: {
          content: [{ reference: { url: "https://cdn.example.test/seed.png" } }],
        },
      },
    ]);
    await expect(session.continue().completed).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects malformed media content before it enters the queue", () => {
    const session = testAgent()
      .with(model(async () => "done"))
      .build()
      .run();
    expect(() =>
      session.input({ content: [{ type: "media", mediaType: "", reference: {} }] as never }),
    ).toThrowError(expect.objectContaining({ code: "input.invalid-content" }));
  });

  it("maps direct URL images in bundled adapters and rejects unsupported content before send", async () => {
    const mediaCall: ModelCall = {
      sessionId: "session",
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
