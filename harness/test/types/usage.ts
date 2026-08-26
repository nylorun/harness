import { z } from "zod";
import {
  Agent,
  adapter,
  tool,
  type BuiltAgent,
  type ModelCandidate,
  type ModelDirective,
  type SessionOptions,
  type StepRequest,
} from "../../src/index.js";
// @ts-expect-error bindAgent is not a public export
import { bindAgent } from "../../src/index.js";

tool({
  name: "echo",
  input: z.object({ text: z.string().trim() }),
  executeWith: "local",
  route: {},
});

tool({
  name: "invalid-root",
  // @ts-expect-error Harness accepts Zod object roots only.
  input: z.string(),
  executeWith: "local",
  route: {},
});

const local = adapter({
  id: "local",
  validateRoute() {},
  async execute(call) {
    return { kind: "completed" as const, output: call.args };
  },
});

Agent(async () => "done")
  .with(local)
  .use("echo", async (_request, next) => next())
  .build()
  .run();

Agent(async () => "done", { id: "opus" });

// @ts-expect-error model is required
Agent();

// @ts-expect-error Agent takes a model adapter function, not an invoker object
Agent({ invoke: async () => "done" });

// @ts-expect-error Agent takes a model adapter function, not a create-options bag
Agent({ model: { invoke: async () => "done" } });

// @ts-expect-error run belongs on BuiltAgent, not the builder
Agent(async () => "done").run();

// @ts-expect-error Agent is a factory, not a constructable class
new Agent(async () => "done");

declare const agent: BuiltAgent;

// @ts-expect-error Session limits are application middleware policy.
agent.run({ limits: { maxTurns: 1 } });

// @ts-expect-error run is a Session factory; submit work through session.input
agent.run("hello");

// @ts-expect-error SessionOptions.model was removed
const sessionOptions: SessionOptions = { model: "opus" };

declare const request: StepRequest;
// @ts-expect-error selectModel was replaced by request.model.select
request.selectModel("opus");

const candidate: ModelCandidate = {
  output: [{ type: "text", text: "ok" }],
  finishReason: "stop",
};
// @ts-expect-error content was replaced by output blocks
const oldContent: ModelCandidate = { content: "hi" };
// @ts-expect-error toolCalls was replaced by output blocks
const oldCalls: ModelCandidate = { toolCalls: [] };
// @ts-expect-error metadata was removed
const oldMetadata: ModelCandidate = { output: [], metadata: {} };
// @ts-expect-error error is not a successful finishReason
const failed: ModelCandidate = { output: [], finishReason: "error" };

const directive: ModelDirective = {
  id: "opus",
  controls: { temperature: 0.2, maxOutputTokens: 128 },
};
// @ts-expect-error extra directive keys are not allowed
const extra: ModelDirective = { id: "opus", extra: true };
