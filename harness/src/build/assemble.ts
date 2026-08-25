import type { BuildResult, Capability } from "../types/capability.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { BuildDiagnostic } from "../types/shared.js";
import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import { Agent } from "../agent.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";
import { normalizeSchema } from "./schema.js";
import { createModelRegistry, type ModelRegistry } from "./models.js";
import { createAdapterRegistry, type AdapterInput, type AdapterRegistry } from "./adapters.js";
import { createManifest } from "./manifest.js";
import type { ModelInvoker, ModelRegistryInput } from "../types/model.js";

export interface HarnessOptions {
  readonly adapters?: AdapterInput;
  readonly model?: ModelInvoker;
  readonly models?: ModelRegistryInput;
  readonly defaultModel?: string;
}

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export async function assembleAgent(
  capabilities: readonly Capability[],
  options: HarnessOptions,
): Promise<BuildResult<Agent>> {
  const diagnostics: BuildDiagnostic[] = [];
  let adapters: AdapterRegistry;
  let models: ModelRegistry;
  try {
    adapters = createAdapterRegistry(options.adapters);
  } catch (cause) {
    return {
      ok: false,
      diagnostics: Object.freeze([
        diagnostic(
          "harness.invalid-adapters",
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        ),
      ]),
    };
  }
  try {
    models = createModelRegistry(options);
  } catch (cause) {
    return {
      ok: false,
      diagnostics: Object.freeze([
        diagnostic(
          "harness.invalid-models",
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        ),
      ]),
    };
  }

  const capabilityIds = new Set<string>();
  for (const capability of capabilities) {
    if (!capability.id)
      diagnostics.push(diagnostic("capability.invalid-id", "Capability id must not be empty"));
    else if (capabilityIds.has(capability.id))
      diagnostics.push(
        diagnostic("capability.duplicate-id", `Duplicate capability id '${capability.id}'`, {
          capabilityId: capability.id,
        }),
      );
    capabilityIds.add(capability.id);
  }

  const settled = await Promise.allSettled(
    capabilities.map(async (capability) => {
      const adapterAccess = Object.freeze({ require: adapters.require });
      return (await capability.setup?.({ adapters: adapterAccess })) ?? {};
    }),
  );

  const tools: BoundToolDefinition[] = [];
  const middleware: StepMiddleware[] = [];
  const instructions: string[] = [];
  const toolNames = new Set<string>();
  const middlewareIds = new Set<string>();

  const addMiddleware = (item: StepMiddleware, capabilityId: string): void => {
    if (!item.id)
      diagnostics.push(
        diagnostic(
          "middleware.invalid-id",
          `Capability '${capabilityId}' contributed middleware without an id`,
          { capabilityId },
        ),
      );
    else if (middlewareIds.has(item.id))
      diagnostics.push(
        diagnostic("middleware.duplicate-id", `Duplicate middleware id '${item.id}'`, {
          capabilityId,
        }),
      );
    else {
      middlewareIds.add(item.id);
      middleware.push(Object.freeze({ ...item }));
    }
  };

  const addTool = (item: ToolDefinition, capabilityId: string): void => {
    if (!item.name) {
      diagnostics.push(
        diagnostic(
          "tool.invalid-name",
          `Capability '${capabilityId}' contributed a Tool without a name`,
          { capabilityId },
        ),
      );
      return;
    }
    if (toolNames.has(item.name)) {
      diagnostics.push(
        diagnostic("tool.duplicate-name", `Duplicate Tool '${item.name}'`, {
          capabilityId,
          toolName: item.name,
        }),
      );
      return;
    }
    toolNames.add(item.name);
    try {
      const adapter = adapters.require(item.executeWith);
      const route = copyJson(item.route);
      adapter.validateRoute(route);
      const input = normalizeSchema(item.input);
      const metadata =
        item.metadata === undefined
          ? undefined
          : copyJsonObject(item.metadata, `tool '${item.name}' metadata`);
      tools.push(
        Object.freeze({
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          input,
          executeWith: item.executeWith,
          route,
          ...(metadata ? { metadata } : {}),
        }),
      );
    } catch (cause) {
      diagnostics.push(
        diagnostic(
          "tool.invalid",
          `Tool '${item.name}' is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
          { capabilityId, toolName: item.name, cause },
        ),
      );
    }
  };

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index]!;
    const result = settled[index]!;
    for (const item of capability.middleware ?? []) addMiddleware(item, capability.id);
    if (result.status === "rejected") {
      diagnostics.push(
        diagnostic(
          "capability.setup-failed",
          `Capability '${capability.id}' failed to setup: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          { capabilityId: capability.id, cause: result.reason },
        ),
      );
      continue;
    }
    const contribution = result.value;
    if (!contribution || typeof contribution !== "object") {
      diagnostics.push(
        diagnostic(
          "capability.invalid-contribution",
          `Capability '${capability.id}' returned an invalid contribution`,
          { capabilityId: capability.id },
        ),
      );
      continue;
    }
    for (const item of contribution.tools ?? []) addTool(item, capability.id);
    for (const item of contribution.middleware ?? []) addMiddleware(item, capability.id);
    for (const item of contribution.instructions ?? []) {
      if (typeof item !== "string")
        diagnostics.push(
          diagnostic(
            "capability.invalid-instruction",
            `Capability '${capability.id}' contributed a non-string instruction`,
            { capabilityId: capability.id },
          ),
        );
      else instructions.push(item);
    }
  }

  if (diagnostics.length)
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  const frozenTools = Object.freeze(tools);
  const frozenMiddleware = Object.freeze(middleware);
  const frozenInstructions = Object.freeze(instructions);
  const manifest = createManifest({
    capabilities,
    tools: frozenTools,
    instructions: frozenInstructions,
    middleware: frozenMiddleware,
    models,
    adapters,
  });
  const agent = new Agent(
    frozenTools,
    frozenInstructions,
    frozenMiddleware,
    models,
    adapters,
    manifest,
  );
  return Object.freeze({ ok: true, agent, manifest });
}
