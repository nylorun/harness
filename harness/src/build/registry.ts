import { bindTool } from "./bind-tool.js";
import { familyInstances, type ToolFamily } from "./tool-family.js";
import { HarnessError } from "../errors.js";
import { copyJson } from "../utils/immutable.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ToolReference } from "../types/execution.js";
import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";

/** Definition-only lookup; no per-run selections or progress live here. */
export class ToolRegistry {
  private readonly tools = new Map<string, BoundToolDefinition>();
  private readonly families = new Map<string, ToolFamily<any, any, any, any>>();
  private readonly owners = new WeakMap<object, string>();

  constructor(middleware: readonly BoundMiddleware[]) {
    for (const capability of middleware) {
      for (const tool of capability.tools ?? []) {
        const key = JSON.stringify([capability.id, tool.name]);
        if (this.tools.has(key) || this.owners.has(tool))
          throw new HarnessError(
            "tool.invalid",
            `Duplicate registered tool '${tool.name}' in '${capability.id}'`,
          );
        this.tools.set(key, bindTool(tool, { middlewareId: capability.id, slot: capability.id }));
        this.owners.set(tool, capability.id);
      }
      for (const family of capability.toolFamilies ?? []) {
        const key = JSON.stringify([capability.id, family.id]);
        if (this.families.has(key) || this.owners.has(family))
          throw new HarnessError("tool.invalid", `Duplicate family '${family.id}'`);
        this.families.set(key, family);
        this.owners.set(family, capability.id);
      }
    }
  }

  reference(tool: BoundToolDefinition): ToolReference {
    const instance = familyInstances.get(tool.source);
    const capabilityId = this.owners.get(instance?.family ?? tool.source);
    if (!capabilityId)
      throw new HarnessError(
        "tool.unregistered",
        `Tool '${tool.name}' is not registered. Declare it in capability.tools or expose a registered toolFamily.bind(...) instance.`,
      );
    const reference = copyJson({
      capabilityId,
      ...(instance
        ? {
            familyId: instance.family.id,
            version: instance.family.version,
            binding: instance.binding,
          }
        : { toolName: tool.source.name }),
      descriptor: descriptor(tool),
    });
    if (!instance) this.restore(reference);
    return reference;
  }

  restore(reference: ToolReference): BoundToolDefinition {
    let definition: ToolDefinition<any, any, any> | undefined;
    if (reference.familyId !== undefined) {
      const family = this.families.get(
        JSON.stringify([reference.capabilityId, reference.familyId]),
      );
      if (!family || family.version !== reference.version || reference.binding === undefined)
        throw new HarnessError(
          "execution.incompatible",
          `Missing or incompatible tool family '${reference.familyId}'`,
        );
      definition = family.bind(reference.binding);
    } else {
      const registered = this.tools.get(
        JSON.stringify([reference.capabilityId, reference.toolName]),
      );
      if (!registered || canonical(descriptor(registered)) !== canonical(reference.descriptor))
        throw new HarnessError(
          "execution.incompatible",
          `Missing or changed registered tool '${reference.toolName}'`,
        );
      return registered;
    }
    if (!definition)
      throw new HarnessError(
        "execution.incompatible",
        `Missing registered tool '${reference.toolName}'`,
      );
    const tool = bindTool(definition, {
      middlewareId: reference.capabilityId,
      slot: reference.capabilityId,
    });
    if (canonical(descriptor(tool)) !== canonical(reference.descriptor))
      throw new HarnessError(
        "execution.incompatible",
        `Saved contract for '${reference.descriptor.name}' differs from its rebuilt definition. Restore compatible code or reconcile the execution.`,
      );
    return tool;
  }
}

function descriptor(tool: BoundToolDefinition): ToolReference["descriptor"] {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema.jsonSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema.jsonSchema }),
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
