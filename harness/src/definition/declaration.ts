import type { BoundMiddleware } from "./bound.js";
import type {
  CapabilityDeclaration,
  CapabilityItems,
  MiddlewareContributions,
  StepMiddleware,
} from "../types/middleware.js";
import type { ModelDirective } from "../types/model.js";

export function compileDeclaration<State>(
  declaration: CapabilityDeclaration<State>,
): BoundMiddleware {
  const tools = copyItems(declaration.tools, declaration.id);
  const instructions = copyItems(declaration.instructions, declaration.id);
  const model = declaration.model;
  const contributions = snapshotContributions(instructions?.items, tools?.items, model);
  const handle: StepMiddleware = async (request, next) => {
    if (tools) request.configuration.tools.set(tools.slot, tools.items);
    if (instructions) request.configuration.instructions.set(instructions.slot, instructions.items);
    if (model) request.configuration.model.select(model);
    return declaration.middleware ? declaration.middleware(request as never, next) : next();
  };
  return {
    id: declaration.id,
    handle,
    hasMiddleware: declaration.middleware !== undefined,
    tools: tools?.items,
    ...(contributions === undefined ? {} : { contributions }),
  };
}

function snapshotContributions(
  instructions: readonly string[] | undefined,
  tools: readonly { readonly name: string; readonly description?: string }[] | undefined,
  model: ModelDirective | undefined,
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
              ...(tool.description === undefined ? {} : { description: tool.description }),
            }),
          ),
        );
  const snapModel = model === undefined ? undefined : snapshotModel(model);
  if (snapInstructions === undefined && snapTools === undefined && snapModel === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(snapInstructions === undefined ? {} : { instructions: snapInstructions }),
    ...(snapTools === undefined ? {} : { tools: snapTools }),
    ...(snapModel === undefined ? {} : { model: snapModel }),
  });
}

function snapshotModel(model: ModelDirective): Pick<ModelDirective, "id" | "controls"> {
  return Object.freeze({
    ...(model.id === undefined ? {} : { id: model.id }),
    ...(model.controls === undefined ? {} : { controls: Object.freeze({ ...model.controls }) }),
  });
}

function copyItems<Item>(
  value: CapabilityItems<Item> | undefined,
  defaultSlot: string,
): Readonly<{ readonly slot: string; readonly items: readonly Item[] }> | undefined {
  if (value === undefined) return undefined;
  if (!("items" in value))
    return Object.freeze({ slot: defaultSlot, items: Object.freeze([...value]) });
  return Object.freeze({ slot: value.slot, items: Object.freeze([...value.items]) });
}
