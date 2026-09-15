import { Agent, type ModelAdapter } from "@nylorun/harness";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { httpModel } from "../src/model/http-model.js";

const agent = Agent({ id: "a", name: "A" }).build();
const env = {
  MODEL_PROVIDER: "custom",
  MODEL: "test",
  MODEL_PROVIDER_BASE_URL: "https://model.example/v1",
  MODEL_PROVIDER_API_KEY: "explicit",
  OPENAI_API_KEY: "native",
};
const answer = () =>
  Response.json({
    model: "test",
    choices: [{ message: { content: "hello" } }],
  });
it("uses isolated request environment and explicit credentials without files or global mutation", async () => {
  const original = process.env.MODEL_PROVIDER_API_KEY;
  const seen: string[] = [];
  const mock: typeof fetch = async (_, init) => {
    seen.push(new Headers(init?.headers).get("authorization")!);
    return answer();
  };
  await Promise.all(
    ["first", "second"].map((key) =>
      agent.run({
        input: "go",
        onModelCall: httpModel({
          environment: { ...env, MODEL_PROVIDER_API_KEY: key },
          fetch: mock,
        }),
      }),
    ),
  );
  expect(seen.sort()).toEqual(["Bearer first", "Bearer second"]);
  expect(process.env.MODEL_PROVIDER_API_KEY).toBe(original);
});
it("accepts native credentials and explicit option precedence", async () => {
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://override.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer option",
    );
    expect(JSON.parse(String(init?.body)).model).toBe("override");
    return answer();
  });
  const result = await agent.run({
    input: "go",
    onModelCall: httpModel({
      environment: env,
      model: "override",
      apiKey: "option",
      baseUrl: "https://override.example/v1",
      fetch: mock,
    }),
  });
  expect(result.status).toBe("completed");
  await agent.run({
    input: "go",
    onModelCall: httpModel({
      environment: { ...env, MODEL_PROVIDER_API_KEY: undefined },
      fetch: async (_, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer native",
        );
        return answer();
      },
    }),
  });
});
it.each([
  { MODEL_PROVIDER: "openai" },
  { MODEL: "x" },
  { MODEL_PROVIDER: "custom", MODEL: "x", MODEL_PROVIDER_API_KEY: "key" },
])(
  "fails incomplete configuration before HTTP dispatch",
  async (environment) => {
    const mock = vi.fn<typeof fetch>();
    const result = await agent.run({
      input: "go",
      onModelCall: httpModel({ environment, fetch: mock }),
    });
    expect(result.status).toBe("failed");
    expect(mock).not.toHaveBeenCalled();
  },
);
it("assembles streamed results while isolating preview errors", async () => {
  const preview = vi.fn(() => {
    throw new Error("observer failed");
  });
  const request: typeof fetch = async (_, init) => {
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
    return new Response(
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    );
  };
  const result = await agent.run({
    input: "go",
    onModelCall: httpModel({
      environment: env,
      onPreview: preview,
      fetch: request,
    }),
  });
  expect(result).toMatchObject({ status: "completed", output: "hello" });
  expect(preview).toHaveBeenCalledTimes(2);
});
it("rejects truncated streams instead of accepting partial output", async () => {
  const result = await agent.run({
    input: "go",
    onModelCall: httpModel({
      environment: env,
      onPreview: () => {},
      fetch: async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    }),
  });
  expect(result.status).toBe("failed");
});
it.each(["openai", "anthropic"] as const)(
  "validates final JSON output through %s",
  async (provider) => {
    const structured = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ value: z.number() }),
    }).build();
    const model: ModelAdapter = httpModel({
      environment: { ...env, MODEL_PROVIDER: provider },
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        expect(
          provider === "openai"
            ? body.response_format.json_schema.schema
            : body.output_config.format.schema,
        ).toMatchObject({ type: "object" });
        return provider === "openai"
          ? Response.json({
              choices: [{ message: { content: '{"value":3}' } }],
            })
          : Response.json({ content: [{ type: "text", text: '{"value":3}' }] });
      },
    });
    expect(
      await structured.run({ input: "go", onModelCall: model }),
    ).toMatchObject({ status: "completed", output: { value: 3 } });
  },
);
