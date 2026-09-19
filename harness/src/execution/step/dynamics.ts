import { HarnessError } from "../../errors.js";
import type { AgentDefinition } from "../../definition/agent-definition.js";
import type { Decision, Patch } from "../../types/dynamics.js";
import type { JsonValue } from "../../types/shared.js";
import type { PromptItem } from "../../types/model.js";
import type { InputEvent } from "../../types/transcript.js";
import type { ModelConfigurationDraft } from "./model-configuration.js";

export interface DynamicsContext {
  readonly agent: AgentDefinition;
  readonly info?: unknown;
  readonly step: number;
  readonly arrivals: readonly InputEvent[];
  readonly messages: readonly PromptItem[];
  sessionState: Record<string, JsonValue>;
}

/** Run all beforeModelCall handlers in capability `.use()` order. */
export async function applyBeforeModelCall(
  ctx: DynamicsContext,
  configuration: ModelConfigurationDraft,
): Promise<{ readonly blocked?: string }> {
  const patches: { readonly id: string; readonly patch: Patch; readonly agentLevel: boolean }[] =
    [];
  for (const capability of ctx.agent.manifest.capabilities) {
    const impl = ctx.agent.implementations[capability.id];
    if (!impl?.beforeModelCall) continue;
    const raw = await impl.beforeModelCall({
      input: projectInput(ctx.arrivals),
      info: ctx.info,
      state: { ...ctx.sessionState },
      messages: ctx.messages,
      step: ctx.step,
    });
    const patch = normalizeCapabilityPatch(capability.id, raw ?? {}, capability.id === "agent");
    patches.push({ id: capability.id, patch, agentLevel: capability.id === "agent" });
  }

  if (!patches.length) return {};

  let blocked: string | undefined;
  const capabilitySwitches = new Map<string, boolean>();
  const toolSwitches = new Map<string, boolean>();
  const extraInstructions: string[] = [];

  for (const { id, patch, agentLevel } of patches) {
    if (patch.block) blocked = patch.block;
    if (patch.state) {
      for (const [key, value] of Object.entries(patch.state)) ctx.sessionState[key] = value;
    }
    if (patch.instructions) extraInstructions.push(...patch.instructions);
    if (patch.capabilities) {
      for (const [name, on] of Object.entries(patch.capabilities)) {
        if (!agentLevel && name !== id)
          throw new HarnessError(
            "configuration.invalid",
            `Capability '${id}' beforeModelCall may only toggle itself, not '${name}'`,
          );
        if (!ctx.agent.manifest.capabilities.some((item) => item.id === name))
          throw new HarnessError(
            "configuration.invalid",
            `beforeModelCall referenced unknown capability '${name}'`,
          );
        capabilitySwitches.set(name, on);
      }
    }
    if (patch.tools) {
      for (const [name, on] of Object.entries(patch.tools)) {
        const known = ctx.agent.manifest.capabilities.some((cap) =>
          cap.tools?.some((tool) => tool.name === name),
        );
        if (!known)
          throw new HarnessError(
            "configuration.invalid",
            `beforeModelCall referenced unknown tool '${name}'`,
          );
        if (!agentLevel) {
          const owned = ctx.agent.manifest.capabilities
            .find((cap) => cap.id === id)
            ?.tools?.some((tool) => tool.name === name);
          if (!owned)
            throw new HarnessError(
              "configuration.invalid",
              `Capability '${id}' beforeModelCall may only toggle its own tools`,
            );
        }
        toolSwitches.set(name, on);
      }
    }
  }

  if (blocked) return { blocked };

  let order = 10_000;
  for (const [capabilityId, on] of capabilitySwitches) {
    if (on) continue;
    configuration.setTools("dynamics", order++, capabilityId, []);
  }
  for (const [toolName, on] of toolSwitches) {
    if (on) continue;
    for (const capability of ctx.agent.manifest.capabilities) {
      const tools = ctx.agent.implementations[capability.id]?.tools;
      if (!tools?.[toolName]) continue;
      const remaining = Object.values(tools).filter((tool) => tool.name !== toolName);
      configuration.setTools("dynamics", order++, capability.id, remaining);
    }
  }
  if (extraInstructions.length)
    configuration.setInstructions(
      "dynamics",
      order++,
      "dynamics",
      Object.freeze([...extraInstructions]),
    );

  return {};
}

/** Run all afterModelCall handlers; merge with strictest-wins rules. */
export async function applyAfterModelCall(
  ctx: DynamicsContext,
  args: {
    readonly text?: string;
    readonly toolCalls: readonly {
      readonly id: string;
      readonly name: string;
      readonly args: JsonValue;
    }[];
  },
): Promise<Decision> {
  const decisions: Decision[] = [];
  for (const capability of ctx.agent.manifest.capabilities) {
    const impl = ctx.agent.implementations[capability.id];
    if (!impl?.afterModelCall) continue;
    const decision = await impl.afterModelCall(args, {
      info: ctx.info,
      state: { ...ctx.sessionState },
    });
    decisions.push(decision ?? {});
  }
  return mergeDecisions(decisions);
}

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

export function hasDynamics(agent: AgentDefinition): boolean {
  return agent.manifest.capabilities.some(
    (capability) => capability.beforeModelCall || capability.afterModelCall,
  );
}

function normalizeCapabilityPatch(id: string, patch: Patch, agentLevel: boolean): Patch {
  if (patch.active === undefined) return patch;
  if (agentLevel)
    throw new HarnessError(
      "configuration.invalid",
      "Agent-level beforeModelCall must use capabilities{}, not active",
    );
  return {
    ...patch,
    capabilities: { ...(patch.capabilities ?? {}), [id]: patch.active },
  };
}

function projectInput(arrivals: readonly InputEvent[]): string | undefined {
  const message = arrivals.find((item) => item.kind === "user-message");
  if (!message) return undefined;
  if ("text" in message && typeof message.text === "string") return message.text;
  return undefined;
}
