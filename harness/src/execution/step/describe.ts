import type { ModelConfigurationSnapshot } from "../../types/model.js";
import type { ToolDescriptor } from "../../types/tool.js";
import { copyJson } from "../../utils/immutable.js";
import type { BoundToolDefinition } from "../../definition/bound.js";

/** Executable configuration stays inside the invocation. */
export interface InternalModelConfigurationSnapshot extends Omit<
  ModelConfigurationSnapshot,
  "tools"
> {
  readonly tools: readonly BoundToolDefinition[];
}

export function describeTool(tool: BoundToolDefinition): ToolDescriptor {
  return copyJson({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    owner: tool.owner,
    inputSchema: { jsonSchema: tool.inputSchema.jsonSchema },
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: { jsonSchema: tool.outputSchema.jsonSchema } }),
  });
}

export function describeConfiguration(
  configuration: InternalModelConfigurationSnapshot,
): ModelConfigurationSnapshot {
  return copyJson({
    version: configuration.version,
    ...(configuration.model === undefined ? {} : { model: configuration.model }),
    instructions: configuration.instructions,
    tools: configuration.tools.map(describeTool),
    toolContracts: configuration.toolContracts,
    contributors: configuration.contributors,
  });
}
