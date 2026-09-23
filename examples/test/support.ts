import { isToolError, type JsonValue, type ToolDefinition, type ToolExecutionContext, type ToolOutcome, type ToolRunResult } from "@nylorun/core/define";

/** Minimal ToolExecutionContext for unit tests under DX v5.6. */
export function toolContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  const bag: Record<string, JsonValue> = {};
  return {
    executionId: "session",
    turnId: "turn",
    stepId: "step",
    callId: "call",
    invocationId: "invocation",
    signal: new AbortController().signal,
    idempotencyKey: "idempotency",
    state: {
      get(key) {
        return bag[key];
      },
      set(key, value) {
        bag[key] = value;
      },
      entries() {
        return { ...bag };
      },
    },
    session: { id: "session" },
    progress() {},
    ask: async () => null,
    approve: async () => true,
    sleep: async () => {},
    waitFor: async () => null,
    step: async (_name, fn) => fn(),
    ...overrides,
  };
}

function normalizeToolOutcome(raw: ToolRunResult): ToolOutcome {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: string }).kind;
    if (
      kind === "completed" ||
      kind === "denied" ||
      kind === "failed" ||
      kind === "interaction-required" ||
      kind === "deferred"
    ) {
      return raw as ToolOutcome;
    }
  }
  return { kind: "completed", output: raw as JsonValue };
}

/** Call execute|run and normalize plain returns / ToolError like the harness. */
export async function invokeTool(
  tool: ToolDefinition,
  args: unknown,
  context: ToolExecutionContext = toolContext(),
): Promise<ToolOutcome> {
  const run = tool.execute ?? tool.run;
  if (typeof run !== "function") {
    throw new Error(`Tool '${tool.name}' has no execute() or run().`);
  }
  try {
    return normalizeToolOutcome(await run(args as never, context));
  } catch (error) {
    if (isToolError(error)) {
      return { kind: "failed", code: error.code, message: error.message };
    }
    throw error;
  }
}
