import { z } from "zod";
import {
  Agent,
  defineToolFamily,
  tool,
  type CapabilityDeclaration,
  type ExecutionState,
  type RunResult,
  type StepRequest,
} from "../../src/index.js";
// @ts-expect-error Session objects are no longer exported.
import type { Session } from "../../src/index.js";
// @ts-expect-error Private binding implementation is not public.
import { bindAgent } from "../../src/index.js";

type Scope = { tenantId: string };
const schema = z.object({ count: z.number() });
const capability: CapabilityDeclaration<Scope> = {
  id: "tools",
  tools: [
    tool({
      name: "count",
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ value }, { scope }) => {
        const tenant: string | undefined = scope?.tenantId;
        return { kind: "completed", output: { value, tenant: tenant ?? "" } };
      },
    }),
  ],
  middleware: async (request, next) => {
    const tenant: string | undefined = request.scope?.tenantId;
    // @ts-expect-error Resource creation and session-owned state were removed.
    request.state;
    request.context.set("tenant", [{ value: tenant ?? "" }]);
    return next();
  },
};
const scoped = Agent<Scope>({ id: "a", name: "A" }).use(capability).build();
const promise: Promise<RunResult<string>> = scoped.run({
  input: "hi",
  scope: { tenantId: "t" },
  onModelCall: async () => "hello",
});
// @ts-expect-error run returns a Promise, not a handle.
promise.completed;
// @ts-expect-error No public step loop.
scoped.step;
// @ts-expect-error Cancellation belongs to an AbortController.
scoped.cancel;
// @ts-expect-error Scope is typed.
scoped.run({ input: "hi", scope: { tenantId: 2 }, onModelCall: async () => "hello" });
// @ts-expect-error Every invocation specifies input.
scoped.run({ onModelCall: async () => "hello" });
// @ts-expect-error Per-run final schemas were removed.
scoped.run({ input: "hi", outputSchema: schema, onModelCall: async () => "hello" });
// @ts-expect-error No run-time tool resolver.
scoped.run({ input: "hi", resolveTool: () => null, onModelCall: async () => "hello" });

const typed = Agent({ id: "structured", name: "Structured", outputSchema: schema }).build();
const typedResult = await typed.run({
  input: "go",
  onModelCall: async () => ({ output: [{ type: "json", value: { count: 1 } }] }),
});
if (typedResult.status === "completed") {
  const count: number = typedResult.output.count;
  // @ts-expect-error Inferred output is not string.
  const wrong: string = typedResult.output;
}
const scopedTyped = Agent<Scope, typeof schema>({
  id: "scoped",
  name: "Scoped",
  outputSchema: schema,
})
  .use(capability)
  .build();
void scopedTyped;
const family = defineToolFamily({
  id: "table",
  version: "1",
  bindingSchema: z.object({ table: z.string() }),
  describe: (binding) => ({
    name: `query_${binding.table}`,
    inputSchema: z.object({ limit: z.number() }),
    outputSchema: z.object({ rows: z.number() }),
  }),
  execute: async (args, { binding }) => {
    const limit: number = args.limit;
    const table: string = binding.table;
    return { kind: "completed", output: { rows: limit } };
  },
});
family.bind({ table: "orders" });
// @ts-expect-error Binding data must match its schema.
family.bind({ table: 1 });
declare const state: ExecutionState;
await scoped.run({
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
