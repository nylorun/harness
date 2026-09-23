import { HarnessError, hasHook, runHookPoint } from "@nylorun/core/define";
import type { AgentDefinition, Implementations } from "../../definition/agent-definition.js";
import type { Decision, HookAt, HookScope, Patch, TurnDecision } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import type { InputEvent } from "@nylorun/core/define";
import type { ModelConfigurationDraft } from "./model-configuration.js";

export interface HookPoint {
  readonly at: HookAt;
  readonly scope: HookScope;
}

/** Runs one hook point for the listed capabilities; results are keyed by capability id. */
export type HookRunner = (request: {
  readonly point: HookPoint;
  readonly capabilityIds: readonly string[];
  readonly args: unknown;
  /** Stable name of this call within the turn, used to journal it durably. */
  readonly identity: string;
}) => Promise<Readonly<Record<string, unknown>>>;

/** The part of a before-hook Patch that shapes model calls. JSON, so a turn can persist it. */
export interface CallPatch {
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly tools?: Readonly<Record<string, boolean>>;
  readonly instructions?: readonly string[];
}

export interface CombinedPatch {
  readonly block?: string;
  readonly state?: Readonly<Record<string, JsonValue>>;
  readonly patch: CallPatch;
}

export function localHookRunner(implementations: Implementations): HookRunner {
  return ({ point, capabilityIds, args }) =>
    runHookPoint(implementations, { ...point, capabilityIds }, args);
}

/** Capability ids registered at a hook point, in manifest (`.use()`) order. */
export function hookRegistrants(agent: AgentDefinition, point: HookPoint): readonly string[] {
  return agent.manifest.capabilities
    .filter((capability) => hasHook(capability.hooks, point.at, point.scope))
    .map((capability) => capability.id);
}

export function hasAnyHooks(agent: AgentDefinition): boolean {
  return agent.manifest.capabilities.some((capability) => capability.hooks?.length);
}

/** Run a hook point, returning results in manifest order. Skips the call when nobody registered. */
export async function callHooks(
  agent: AgentDefinition,
  point: HookPoint,
  args: unknown,
  identity: string,
): Promise<readonly { readonly id: string; readonly result: unknown }[]> {
  const capabilityIds = hookRegistrants(agent, point);
  if (!capabilityIds.length) return [];
  const results = await agent.runHooks({ point, capabilityIds, args, identity });
  return capabilityIds.map((id) => ({ id, result: results[id] ?? {} }));
}

/** Validate and merge before-hook Patches in manifest order. */
export function combinePatches(
  agent: AgentDefinition,
  results: readonly { readonly id: string; readonly result: unknown }[],
): CombinedPatch {
  let block: string | undefined;
  const state: Record<string, JsonValue> = {};
  const capabilities: Record<string, boolean> = {};
  const tools: Record<string, boolean> = {};
  const instructions: string[] = [];
  for (const { id, result } of results) {
    const agentLevel = id === "agent";
    const patch = normalizeCapabilityPatch(id, asObject(result, id) as Patch, agentLevel);
    if (patch.block !== undefined) block = checkedString(patch.block, id, "block");
    if (patch.state !== undefined)
      Object.assign(state, asObject(patch.state, id) as Record<string, JsonValue>);
    if (patch.instructions !== undefined) {
      if (
        !Array.isArray(patch.instructions) ||
        patch.instructions.some((item) => typeof item !== "string")
      )
        throw invalid(`Capability '${id}' hook instructions must be strings`);
      instructions.push(...patch.instructions);
    }
    for (const [name, on] of Object.entries(asObject(patch.capabilities ?? {}, id))) {
      if (!agentLevel && name !== id)
        throw invalid(`Capability '${id}' hook may only toggle itself, not '${name}'`);
      if (!agent.manifest.capabilities.some((item) => item.id === name))
        throw invalid(`Hook referenced unknown capability '${name}'`);
      capabilities[name] = checkedBoolean(on, id);
    }
    for (const [name, on] of Object.entries(asObject(patch.tools ?? {}, id))) {
      const owner = toolOwner(agent, name);
      if (owner === undefined) throw invalid(`Hook referenced unknown tool '${name}'`);
      if (!agentLevel && owner !== id)
        throw invalid(`Capability '${id}' hook may only toggle its own tools`);
      tools[name] = checkedBoolean(on, id);
    }
  }
  return {
    ...(block === undefined ? {} : { block }),
    ...(Object.keys(state).length ? { state } : {}),
    patch: compact({ capabilities, tools, instructions }),
  };
}

/** Layer a step patch over the turn patch: step toggles win, instructions concatenate. */
export function layerPatches(turn: CallPatch | undefined, step: CallPatch | undefined): CallPatch {
  return compact({
    capabilities: { ...turn?.capabilities, ...step?.capabilities },
    tools: { ...turn?.tools, ...step?.tools },
    instructions: [...(turn?.instructions ?? []), ...(step?.instructions ?? [])],
  });
}

/** Apply a patch to this model call's configuration. Toggles hide tools; hooks keep running. */
export function applyPatch(
  configuration: ModelConfigurationDraft,
  patch: CallPatch,
  order: number,
): void {
  const offCapabilities = Object.entries(patch.capabilities ?? {})
    .filter(([, on]) => !on)
    .map(([id]) => id);
  const offTools = Object.entries(patch.tools ?? {})
    .filter(([, on]) => !on)
    .map(([name]) => name);
  if (offCapabilities.length || offTools.length)
    configuration.exclude({ capabilities: offCapabilities, tools: offTools });
  if (patch.instructions?.length)
    configuration.setInstructions(
      "dynamics",
      order,
      "dynamics",
      Object.freeze([...patch.instructions]),
    );
}

/** Merge after("step") Decisions; strictest wins. */
export function mergeDecisions(decisions: readonly Decision[]): Decision {
  let block: string | undefined;
  let retry: string | undefined;
  const deny = new Map<string, string>();
  const approve = new Map<string, string>();
  let text: string | undefined;
  for (const decision of decisions) {
    if (decision.block) block = decision.block;
    if (decision.retry) retry = decision.retry;
    for (const item of decision.deny ?? []) deny.set(item.id, item.reason);
    for (const item of decision.approve ?? []) approve.set(item.id, item.prompt);
    if (decision.text !== undefined) text = decision.text;
  }
  if (block) return { block };
  if (retry) return { retry, ...(text === undefined ? {} : { text }) };
  return {
    ...(text === undefined ? {} : { text }),
    ...(deny.size ? { deny: [...deny.entries()].map(([id, reason]) => ({ id, reason })) } : {}),
    ...(approve.size
      ? { approve: [...approve.entries()].map(([id, prompt]) => ({ id, prompt })) }
      : {}),
  };
}

/** Merge after("turn") decisions: block, then retry, then a replacement answer. */
export function mergeTurnDecisions(decisions: readonly TurnDecision[]): TurnDecision {
  let block: string | undefined;
  let retry: string | undefined;
  let text: string | undefined;
  let output: JsonValue | undefined;
  for (const decision of decisions) {
    if (decision.block) block = decision.block;
    if (decision.retry) retry = decision.retry;
    if (decision.text !== undefined) text = decision.text;
    if (decision.output !== undefined) output = decision.output;
  }
  if (block) return { block };
  if (retry) return { retry };
  return {
    ...(text === undefined ? {} : { text }),
    ...(output === undefined ? {} : { output }),
  };
}

export function asDecisions<T>(
  results: readonly { readonly id: string; readonly result: unknown }[],
): T[] {
  return results.map(({ id, result }) => asObject(result, id) as T);
}

/** The text of the user message that started a turn, when there is one. */
export function projectInput(arrivals: readonly InputEvent[]): string | undefined {
  const message = arrivals.find((item) => item.kind === "user-message");
  if (!message) return undefined;
  if ("text" in message && typeof message.text === "string") return message.text;
  return undefined;
}

function toolOwner(agent: AgentDefinition, name: string): string | undefined {
  return agent.manifest.capabilities.find(
    (capability) =>
      capability.tools?.some((tool) => tool.name === name) ||
      agent.implementations[capability.id]?.tools?.[name] !== undefined,
  )?.id;
}

function normalizeCapabilityPatch(id: string, patch: Patch, agentLevel: boolean): Patch {
  if (patch.active === undefined) return patch;
  if (agentLevel) throw invalid("Agent-level before hooks must use capabilities{}, not active");
  return {
    ...patch,
    capabilities: { ...(patch.capabilities ?? {}), [id]: checkedBoolean(patch.active, id) },
  };
}

function compact(patch: {
  capabilities: Record<string, boolean>;
  tools: Record<string, boolean>;
  instructions: string[];
}): CallPatch {
  return {
    ...(Object.keys(patch.capabilities).length ? { capabilities: patch.capabilities } : {}),
    ...(Object.keys(patch.tools).length ? { tools: patch.tools } : {}),
    ...(patch.instructions.length ? { instructions: patch.instructions } : {}),
  };
}

function asObject(value: unknown, id: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid(`Capability '${id}' hook must return an object`);
  return value as Record<string, unknown>;
}

function checkedBoolean(value: unknown, id: string): boolean {
  if (typeof value !== "boolean") throw invalid(`Capability '${id}' hook toggles must be booleans`);
  return value;
}

function checkedString(value: unknown, id: string, field: string): string {
  if (typeof value !== "string") throw invalid(`Capability '${id}' hook ${field} must be a string`);
  return value;
}

function invalid(message: string): HarnessError {
  return new HarnessError("configuration.invalid", message);
}
