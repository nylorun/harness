import { z } from "zod";
import { Agent, defineCapability, defineTool, type AgentCreateOptions } from "../../src/index.js";
// @ts-expect-error bindAgent is not a public export
import { bindAgent } from "../../src/index.js";

defineTool({
  name: "echo",
  input: z.object({ text: z.string().trim() }),
  executeWith: "local",
  route: {},
});

defineTool({
  name: "invalid-root",
  // @ts-expect-error Harness accepts Zod object roots only.
  input: z.string(),
  executeWith: "local",
  route: {},
});

defineCapability({
  id: "echo",
  setup: () => ({ tools: [] }),
});

defineCapability({
  id: "async-setup",
  // @ts-expect-error Capability setup must be synchronous.
  setup: async () => ({}),
});

const options: AgentCreateOptions = {};
Agent.create(options)
  .with(defineCapability({ id: "echo", setup: () => ({}) }))
  .build()
  .run();

// @ts-expect-error run belongs on the sealed Agent, not the builder
Agent.create({}).run();

// @ts-expect-error Agent is constructed through create/build, not new
new Agent();

declare const agent: Agent;

// @ts-expect-error Session limits are application middleware policy.
agent.run({ limits: { maxTurns: 1 } });

// @ts-expect-error run is a Session factory; submit work through session.input
agent.run("hello");
