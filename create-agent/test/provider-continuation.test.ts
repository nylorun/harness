import { afterEach, expect, it, vi } from "vitest";
import { Agent, tool } from "@nylorun/harness";
import { piModel } from "@nylorun/runtime";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("completes a signed Gemini tool conversation across the published engine/runtime interfaces", async () => {
  vi.stubEnv("GEMINI_API_KEY", "fixture-key");
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      const body = JSON.parse(
        String(
          options?.body ??
            (url instanceof Request ? await url.text() : undefined),
        ),
      );
      requests++;
      if (requests > 1) {
        const modelParts = body.contents.find(
          (message: { role: string }) => message.role === "model",
        )?.parts;
        if (
          !modelParts?.some(
            (part: { thoughtSignature?: string }) =>
              part.thoughtSignature === "c2lnbmF0dXJl",
          )
        ) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Function call is missing a thought_signature",
                code: 400,
              },
            }),
            { status: 400 },
          );
        }
        expect(JSON.stringify(body.contents)).toContain("sum");
        expect(JSON.stringify(body.contents)).toContain("26");
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: requests === 1 ? [{ functionCall: { name: "add_numbers", args: { a: 19, b: 7 } }, thoughtSignature: "c2lnbmF0dXJl" }] : [{ text: "26" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const agent = Agent({ id: "assistant", name: "Assistant" })
    .use({
      id: "arithmetic",
      tools: [
        tool({
          name: "add_numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({
            kind: "completed",
            output: { sum: a + b },
          }),
        }),
      ],
    })
    .with(
      piModel({
        selection: { provider: "google", model: "gemini-flash-latest" },
      }),
    )
    .build();
  const session = agent.run();
  try {
    const result = await session.input("Add 19 and 7").completed;
    expect(result.events.at(-1)).toMatchObject({ type: "final", output: "26" });
    expect(requests).toBe(2);
  } finally {
    await session.stop();
  }
});
