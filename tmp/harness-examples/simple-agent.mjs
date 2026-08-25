import {
  AgentBuildError,
  Harness,
  defineAdapter,
  defineCapability,
  defineModel,
  defineTool,
} from "@nylorun/harness";
import { z } from "zod";

const localAdapter = defineAdapter({
  id: "local",
  validateRoute(route) {
    console.log("[adapter] validated route", route);
  },
  async execute(call) {
    console.log("[adapter] executing sealed call", call.toolName, call.args);
    return { kind: "completed", output: { echoed: call.args.text } };
  },
});

const echoTool = defineTool({
  name: "echo",
  description: "Echo text back to the agent",
  input: z.object({ text: z.string() }),
  executeWith: "local",
  route: { operation: "echo" },
});

const model = defineModel({
  id: "logged-model",
  async invoke(request) {
    console.log("[model] step", request.stepId, "tool results", request.toolResults.length);
    if (request.toolResults.length === 0) {
      const input = request.arrivals.find((event) => event.kind === "user-message");
      return {
        toolCalls: [{ id: "echo-call", name: "echo", args: { text: input?.text ?? "hello" } }],
      };
    }
    return `Agent received: ${request.toolResults[0].output.echoed}`;
  },
});

const harness = new Harness({
  model,
  adapters: { local: localAdapter },
}).add(defineCapability({
  id: "echo-capability",
  setup: () => ({ tools: [echoTool], instructions: ["Use echo when the user asks you to repeat text."] }),
}));

const built = await harness.build();
if (!built.ok) throw new AgentBuildError(built.diagnostics);

const session = built.agent.run({ id: "simple-session" });
session.observe((event) => {
  if (event.type === "model.started" || event.type === "adapter.completed") {
    console.log("[observe]", event.type);
  }
});
const handle = session.input("hello from the Harness");
for await (const event of session.stream()) {
  console.log("[output]", event);
  if (event.type === "final" || event.type === "session.stopped") break;
}
await handle.completed;
await session.stop();

