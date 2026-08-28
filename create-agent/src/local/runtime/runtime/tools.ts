import { adapter, tool as harnessTool } from "@nylorun/harness";
import type { JsonValue, ToolAdapter, ToolDefinition as HarnessToolDefinition } from "@nylorun/harness";
import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { describeTools } from "../manifest.js";
import { isToolDefinition } from "../tool.js";
import type { ToolDefinition, ToolDescriptor } from "../types.js";

export type ToolModule = Readonly<{ file: string; exports: Record<string, unknown> }>;

export function bridgeTools(modules: readonly ToolModule[]): { tools: HarnessToolDefinition[]; adapter: ToolAdapter; descriptors: ToolDescriptor[] } {
  const descriptors = describeTools(modules);
  const definitions = new Map<string, ToolDefinition>();
  const tools = descriptors.map((descriptor) => {
    const module = modules.find((entry) => entry.file.replace(/\.tsx?$/u, "") === descriptor.name);
    const definition = module?.exports.default;
    if (!isToolDefinition(definition)) throw missingTool(descriptor.name);
    if (descriptor.sandbox) throw unsupported(descriptor.name, "sandbox: true");
    if (descriptor.maxCallsPerSession !== undefined) throw unsupported(descriptor.name, "maxCallsPerSession");
    definitions.set(descriptor.name, definition as ToolDefinition);
    return harnessTool({
      name: descriptor.name,
      description: descriptor.description,
      parameters: (definition as ToolDefinition).input,
      executeWith: "runtime-local",
    });
  });
  const localAdapter = adapter({
    id: "runtime-local",
    async execute(call, context) {
      const definition = definitions.get(call.toolName);
      if (definition === undefined) return { kind: "failed" as const, code: "tool_missing", message: `Tool ${call.toolName} is unavailable.` };
      try {
        // Harness has already parsed this call with the exact authored Zod schema.
        const output = definition.run(call.args as import("zod").output<import("zod").ZodObject>, {
          signal: context.signal,
        });
        const values: unknown[] = [];
        if (isAsyncIterable(output)) for await (const value of output) values.push(value);
        else values.push(await output);
        return { kind: "completed" as const, output: jsonOutput(values) };
      } catch (cause) {
        return { kind: "failed" as const, code: "tool_failed", message: definition.onErrorMessage ?? (cause instanceof Error ? cause.message : String(cause)) };
      }
    }
  });
  return { tools, adapter: localAdapter, descriptors };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> { return typeof value === "object" && value !== null && Symbol.asyncIterator in value; }
function jsonOutput(values: readonly unknown[]): JsonValue {
  const value = values.length === 1 ? values[0] : values;
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return String(value); }
}
function missingTool(name: string): NyloBuildError { return new NyloBuildError(diagnostic("NYLO_RUN_TOOL_MISSING", "run", "error", `agent/tools/${name}.ts`, `The built bundle has no usable default export for tool ${name}.`, "Rebuild the project.")); }
function unsupported(name: string, feature: string): NyloBuildError { return new NyloBuildError(diagnostic("NYLO_RUN_TOOL_OPTION_UNSUPPORTED", "run", "error", `agent/tools/${name}.ts`, `Tool ${name} uses ${feature}, which this local Harness bridge cannot enforce without cross-session state.`, "Remove the option for local execution.")); }
