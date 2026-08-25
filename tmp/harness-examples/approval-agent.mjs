import {
  AgentBuildError,
  Harness,
  defineAdapter,
  defineCapability,
  defineMiddleware,
  defineModel,
  defineTool,
} from "@nylorun/harness";
import { z } from "zod";

let modelCalls = 0;
const adapterLog = [];

const localAdapter = defineAdapter({
  id: "local",
  validateRoute() {},
  async execute(call, context) {
    adapterLog.push({ callId: call.callId, resume: context.resume });
    console.log("[adapter] approved execution", call.args, context.resume);
    return { kind: "completed", output: { sent: call.args.message } };
  },
});

const sendTool = defineTool({
  name: "send_message",
  description: "Send a message after approval",
  input: z.object({ message: z.string() }),
  executeWith: "local",
  route: { operation: "send" },
});

const approval = defineMiddleware({
  id: "message-approval",
  async aroundModel(context, next) {
    await next();
    for (const call of context.candidate()?.toolCalls ?? []) {
      if (call.name === "send_message") {
        console.log("[middleware] requiring approval for", call.id);
        context.requireInteraction(call.id, { kind: "approval", prompt: "Approve sending this message?" });
      }
    }
  },
});

const model = defineModel({
  id: "approval-model",
  async invoke(request) {
    modelCalls += 1;
    console.log("[model] call", modelCalls);
    return request.toolResults.length === 0
      ? { toolCalls: [{ id: "send-call", name: "send_message", args: { message: "hello" } }] }
      : `Sent: ${request.toolResults[0].output.sent}`;
  },
});

const bound = await new Harness({ model, adapters: { local: localAdapter } })
  .add(defineCapability({
    id: "approved-message",
    middleware: [approval],
    setup: () => ({ tools: [sendTool] }),
  }))
  .build();
if (!bound.ok) throw new AgentBuildError(bound.diagnostics);

const session = bound.agent.run({ id: "approval-session" });
const handle = session.input("send hello");
const waiting = await handle.completed;
const request = waiting.events.find((event) => event.type === "interaction.required");
if (!request || request.type !== "interaction.required") throw new Error("Expected an approval request");
if (modelCalls !== 1 || adapterLog.length !== 0) throw new Error("The plan executed before approval");

console.log("[output] interaction required", request.interaction.id);
const resumed = await session.input({ kind: "approve", interactionId: request.interaction.id, approved: true }).completed;
console.log("[output]", resumed.events.at(-1));

if (modelCalls !== 2 || adapterLog.length !== 1) throw new Error("Approval did not resume exactly one retained call");
if (adapterLog[0].resume?.interactionId !== request.interaction.id) throw new Error("Adapter did not receive correlated resume data");

await session.stop();

