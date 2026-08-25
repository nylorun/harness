import { Harness, defineCapability, defineMiddleware } from "@nylorun/harness";
import { Run } from "@nylorun/runtime";

const approval = defineMiddleware({
  id: "publish-approval",
  async aroundModel(context, next) {
    await next();
    for (const call of context.candidate()?.toolCalls ?? []) {
      if (call.name === "publish-message") context.requireInteraction(call.id, { kind: "approval", prompt: "Approve publishing this validation message?" });
    }
  },
});

export default Run(
  (options) => new Harness(options).add(defineCapability({ id: "approval-policy", middleware: [approval] })),
  {
    name: "ollama-approval",
    model: "local/gemma4:e2b-mlx"
  }
);
