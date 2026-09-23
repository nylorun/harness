import type { BoundMiddleware } from "./bound.js";
import type {
  CapabilityDeclaration,
  CapabilityItems,
  MiddlewareContributions,
  StepMiddleware,
} from "../types/middleware.js";
import type { AfterModelCallFn, BeforeModelCallFn } from "../types/dynamics.js";
import type { ModelDirective } from "../types/model.js";

export interface CompiledCapability {
  readonly bound: BoundMiddleware;
  readonly beforeModelCall?: BeforeModelCallFn<any>;
  readonly afterModelCall?: AfterModelCallFn<any>;
  readonly middleware?: StepMiddleware<any>;
}

export function compileDeclaration<State>(
  declaration: CapabilityDeclaration<State>
): CompiledCapability {
  const tools = copyItems(declaration.tools, declaration.id);
  const instructions = copyItems(declaration.instructions, declaration.id);
  const model = declaration.model;
  const contributions = snapshotContributions(
    instructions?.items,
    tools?.items,
    model
  );
  const handle: StepMiddleware = async (request, next) => {
    if (tools) request.configuration.tools.set(tools.slot, tools.items);
    if (instructions)
      request.configuration.instructions.set(
        instructions.slot,
        instructions.items
      );
    if (model) request.configuration.model.select(model);
    return declaration.middleware
      ? declaration.middleware(request as never, next)
      : next();
  };
  return {
    bound: {
      id: declaration.id,
      ...(declaration.name === undefined ? {} : { name: declaration.name }),
      ...(declaration.description === undefined
        ? {}
        : { description: declaration.description }),
      handle,
      hasMiddleware: declaration.middleware !== undefined,
      tools: tools?.items,
      ...(contributions === undefined ? {} : { contributions }),
      ...(declaration.beforeModelCall ? { beforeModelCall: true } : {}),
      ...(declaration.afterModelCall ? { afterModelCall: true } : {}),
      ...(declaration.type === undefined ? {} : { manifestType: declaration.type }),
      ...(declaration.metadata === undefined
        ? {}
        : { metadata: declaration.metadata }),
      ...(declaration.skills === undefined ||
      Object.keys(declaration.skills).length === 0
        ? {}
        : { skills: declaration.skills }),
      ...(declaration.skillRecords === undefined ||
      Object.keys(declaration.skillRecords).length === 0
        ? {}
        : { skillRecords: declaration.skillRecords }),
      ...(declaration.mcpServers === undefined ||
      Object.keys(declaration.mcpServers).length === 0
        ? {}
        : { mcpServers: declaration.mcpServers }),
      ...(declaration.sandbox === undefined
        ? {}
        : { sandbox: declaration.sandbox }),
      ...(declaration.pluginRoot === undefined
        ? {}
        : { pluginRoot: declaration.pluginRoot }),
    },
    ...(declaration.beforeModelCall
      ? { beforeModelCall: declaration.beforeModelCall }
      : {}),
    ...(declaration.afterModelCall
      ? { afterModelCall: declaration.afterModelCall }
      : {}),
    ...(declaration.middleware ? { middleware: declaration.middleware } : {}),
  };
}

function snapshotContributions(
  instructions: readonly string[] | undefined,
  tools:
    | readonly { readonly name: string; readonly description?: string }[]
    | undefined,
  model: ModelDirective | undefined
): MiddlewareContributions | undefined {
  const snapInstructions =
    instructions === undefined ? undefined : Object.freeze([...instructions]);
  const snapTools =
    tools === undefined
      ? undefined
      : Object.freeze(
          tools.map((tool) =>
            Object.freeze({
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
            })
          )
        );
  // Model is Runtime-owned for the published manifest; still allow local middleware select().
  void model;
  if (snapInstructions === undefined && snapTools === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(snapInstructions === undefined
      ? {}
      : { instructions: snapInstructions }),
    ...(snapTools === undefined ? {} : { tools: snapTools }),
  });
}

function copyItems<Item>(
  value: CapabilityItems<Item> | undefined,
  defaultSlot: string
):
  | Readonly<{ readonly slot: string; readonly items: readonly Item[] }>
  | undefined {
  if (value === undefined) return undefined;
  if (!("items" in value))
    return Object.freeze({
      slot: defaultSlot,
      items: Object.freeze([...value]),
    });
  return Object.freeze({
    slot: value.slot,
    items: Object.freeze([...value.items]),
  });
}
