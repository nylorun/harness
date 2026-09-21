import { join } from "node:path";
import { isToolError, type JsonValue, type ToolDefinition, type ToolExecutionContext, type ToolOutcome, type ToolRunResult } from "@nylorun/core/define";
import {
  Runtime,
  serveAgents,
} from "../../runtime/dist/server/host.js";
import type { RuntimeModelAdapter } from "../../runtime/dist/contracts.js";
import { localSessions, localMedia } from "@nylorun/runtime/node";
import { createRegistry } from "../agents/legacy-registry.js";
import type { ImageEditor } from "../agents/interior-design/image-editor.js";

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

export async function createAgentServer(
  options: {
    root?: string;
    adapter?: RuntimeModelAdapter;
    provider?: string;
    model?: string;
    imageEditor?: ImageEditor;
  } = {}
) {
  const root = options.root ?? process.cwd();
  const media = localMedia({ root: join(root, ".data", "media") });
  const agents = await createRegistry(
    root,
    options.adapter
      ? {
          provider: options.provider ?? "test",
          model: options.model ?? "test-model",
        }
      : undefined,
    { media, imageEditor: options.imageEditor }
  );
  const runtime = new Runtime({
    media,
    observer: () => {},
    ...(options.adapter === undefined ? {} : { onModelCall: options.adapter }),
    sessions: localSessions({ root: join(root, ".data", "sessions") }),
  });
  return Object.freeze({
    app: serveAgents({ agents, runtime }),
    close: async () => { await runtime.close(); await Promise.all(agents.map(agent => agent.close?.())); },
  });
}
