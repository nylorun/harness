import { run, bindingFromAgent } from "../../src/engine/index.js";
import { z } from "zod";
import {
  Agent,
  createExecutionState,
  type BuiltAgent,
  type ModelRequest,
  type ToolDescriptor,
  tool,
  type CapabilityDeclaration,
  type ExecutionState,
  type RunResult,
  type StepRequest,
  type Session,
} from "../../src/index.js";
// @ts-expect-error Private binding implementation is not public.
import { bindAgent } from "../../src/index.js";

type Info = { tenantId: string };
const _sessionTypeCheck: Session | undefined = undefined;
void _sessionTypeCheck;
const schema = z.object({ count: z.number() });
const capability: CapabilityDeclaration<Info> = {
  id: "tools",
  tools: [
    tool({
      name: "count",
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ value }, { info }) => {
        const tenant: string | undefined = info?.tenantId;
        return { kind: "completed", output: { value, tenant: tenant ?? "" } };
      },
    }),
  ],
  middleware: async (request, next) => {
    const tenant: string | undefined = request.info?.tenantId;
    // @ts-expect-error Resource creation and session-owned state were removed.
    request.state;
    request.context.set("tenant", [{ value: tenant ?? "" }]);
    return next();
  },
};
const scoped = Agent<Info>({ id: "a", name: "A" }).use(capability).build();
const promise: Promise<RunResult<string>> = run<Info>({
  binding: bindingFromAgent(scoped),
  input: "hi",
  info: { tenantId: "t" },
  onModelCall: async () => "hello",
});
// @ts-expect-error run returns a Promise, not a handle.
promise.completed;
// @ts-expect-error No public step loop.
scoped.step;
// @ts-expect-error Cancellation belongs to an AbortController.
scoped.cancel;
run<Info>({
  binding: bindingFromAgent(scoped),
  input: "hi",
  // @ts-expect-error Info is typed.
  info: { tenantId: 2 },
  onModelCall: async () => "hello",
});
// @ts-expect-error Every invocation specifies input.
run<Info>({ binding: bindingFromAgent(scoped), onModelCall: async () => "hello" });
run<Info>({
  binding: bindingFromAgent(scoped),
  input: "hi",
  // @ts-expect-error Per-run final schemas were removed.
  outputSchema: schema,
  onModelCall: async () => "hello",
});
run<Info>({
  binding: bindingFromAgent(scoped),
  input: "hi",
  // @ts-expect-error No run-time tool resolver.
  resolveTool: () => null,
  onModelCall: async () => "hello",
});

const typed = Agent({ id: "structured", name: "Structured", outputSchema: schema }).build();
const typedResult = await run<unknown, { count: number }>({
  binding: bindingFromAgent(typed),
  input: "go",
  onModelCall: async () => ({ output: [{ type: "json", value: { count: 1 } }] }),
});
if (typedResult.status === "completed") {
  const count: number = typedResult.output.count;
  // @ts-expect-error Inferred output is not string.
  const wrong: string = typedResult.output;
}
const scopedTyped = Agent<Info, typeof schema>({
  id: "scoped",
  name: "Scoped",
  outputSchema: schema,
})
  .use(capability)
  .build();
void scopedTyped;
declare const state: ExecutionState;
await run<Info>({
  binding: bindingFromAgent(scoped),
  state,
  input: "again",
  onModelCall: async () => "done",
  record: async (snapshot) => {
    const revision: number = snapshot.revision;
  },
  onEvent: (event) => {
    const sequence: number = event.sequence;
  },
});
// @ts-expect-error Legacy state factories are removed.
const bad: CapabilityDeclaration = { id: "bad", state: { create: () => ({}) } };
declare const request: StepRequest;
// @ts-expect-error Harness does not expose a Session on middleware requests.
request.session;

const typedAgent: BuiltAgent<Info, { count: number }> = scopedTyped;
const initialized: ExecutionState = createExecutionState(typedAgent);
createExecutionState(scoped);
// @ts-expect-error BuiltAgent has no runtime constructor.
new BuiltAgent();
// @ts-expect-error BuiltAgent cannot be used with instanceof.
scoped instanceof BuiltAgent;
// @ts-expect-error The registry is internal.
scoped.registry;
// @ts-expect-error Compiled middleware is internal.
scoped.middleware;
// @ts-expect-error Bound output validation is internal.
typed.output;
// @ts-expect-error Compiled middleware is not a public contract.
import type { BoundMiddleware } from "../../src/index.js";
// @ts-expect-error Step input is internal.
import type { StepInput } from "../../src/index.js";
// @ts-expect-error Bound schemas are internal.
import type { BoundToolSchema } from "../../src/index.js";
// @ts-expect-error Executable bound definitions are internal.
import type { BoundToolDefinition } from "../../src/index.js";
// @ts-expect-error Sealed calls are internal.
import type { SealedToolCall } from "../../src/index.js";
declare const modelRequest: ModelRequest;
const descriptor: ToolDescriptor = modelRequest.tools[0]!;
const descriptionSchema = descriptor.inputSchema.jsonSchema;
const owner: string = descriptor.owner.middlewareId;
// @ts-expect-error Adapters cannot dispatch tools through descriptors.
descriptor.execute({}, {});
// @ts-expect-error Descriptors do not expose original definitions.
descriptor.source;
// @ts-expect-error Descriptors do not expose validators.
descriptor.inputSchema.validate({});
// @ts-expect-error The configuration view also contains only descriptors.
modelRequest.configuration.tools[0]!.execute({}, {});
