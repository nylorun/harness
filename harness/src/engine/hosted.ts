import { HarnessError } from "../errors.js";
import type { AgentManifest } from "../types/manifest.js";
import type { ExecutionInput, ExecutionState, RunResult } from "../types/execution.js";
import type { JsonObject } from "../types/shared.js";
import type { Implementations } from "../definition/implementations.js";
import type { ActionOutcome } from "../contracts/index.js";
import { AgentManifestSchema } from "../contracts/index.js";
import { agentFrom } from "../definition/from.js";
import { definitionFor } from "../definition/agent-definition.js";
import { schemaFromJSON } from "../definition/schema-json.js";
import { hashManifest } from "../utils/hash.js";
import { withDeterministicIds } from "../utils/ids.js";
import { execute } from "../execution/run.js";
import { initializeExecutionState } from "../execution/initial-state.js";
import { HostSuspension } from "../execution/host-suspension.js";
import { CHECKPOINT_VERSION, ENGINE_VERSION } from "../compatibility/index.js";

/** Private persistence contract for hosts; this is not a session wire type. */
export interface HostedCheckpoint {
  readonly version: 1;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly manifestHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Increment for each human/event continuation, not for an action result. */
  readonly segment: number;
  readonly input: ExecutionInput;
  readonly state?: ExecutionState;
  readonly info?: JsonObject;
}
export interface HostEffect {
  readonly effectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly manifestHash: string;
  readonly kind: "model" | "tool" | "beforeModelCall" | "afterModelCall";
  readonly capabilityId?: string;
  readonly toolName?: string;
  readonly input: unknown;
  readonly context: Record<string, unknown>;
}
export type EffectResolution =
  | { readonly status: "completed"; readonly outcome: ActionOutcome }
  | { readonly status: "pending" | "uncertain" };
export interface EngineHost {
  /** Atomically load-or-create by effectId; validate identical request on replay.
   * Return recorded outcomes. Record intent BEFORE invoking a provider or exposing
   * customer work. Uncertain effects must never be automatically executed again.
   */
  resolveEffect(effect: HostEffect): Promise<EffectResolution>;
}
export type HostedResult =
  | {
      readonly status: "waiting" | "uncertain";
      readonly checkpoint: HostedCheckpoint;
      readonly effectIds: readonly string[];
    }
  | {
      readonly status: "completed" | "paused" | "cancelled" | "failed";
      readonly checkpoint: HostedCheckpoint;
      readonly result: RunResult<unknown>;
    };
export function createHostedCheckpoint(input: {
  manifest: AgentManifest;
  sessionId: string;
  turnId: string;
  input: ExecutionInput;
  state?: ExecutionState;
  info?: JsonObject;
  segment?: number;
}): HostedCheckpoint {
  AgentManifestSchema.parse(input.manifest);
  return {
    version: CHECKPOINT_VERSION,
    engineVersion: ENGINE_VERSION,
    manifestHash: hashManifest(input.manifest),
    sessionId: input.sessionId,
    turnId: input.turnId,
    segment: input.segment ?? 0,
    input: input.input,
    ...(input.state ? { state: input.state } : {}),
    ...(input.info ? { info: input.info } : {}),
  };
}
/** Deterministic reconstruction uses individually journaled effects, never a replayable whole loop.
 * A suspended checkpoint is the immutable segment start plus the host's durable effect journal.
 * Returning waiting releases all execution stacks; no process-local continuation survives.
 */
export async function runHosted(options: {
  manifest: AgentManifest;
  checkpoint: HostedCheckpoint;
  host: EngineHost;
  signal?: AbortSignal;
}): Promise<HostedResult> {
  const { manifest, checkpoint, host } = options;
  AgentManifestSchema.parse(manifest);
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.engineVersion !== ENGINE_VERSION ||
    checkpoint.manifestHash !== hashManifest(manifest)
  )
    throw new HarnessError("execution.incompatible", "Incompatible hosted checkpoint");
  if (
    checkpoint.state &&
    (checkpoint.state.manifestHash !== checkpoint.manifestHash ||
      checkpoint.state.agentId !== manifest.id ||
      checkpoint.state.executionId !== checkpoint.sessionId)
  )
    throw new HarnessError("execution.incompatible", "Checkpoint definition/session mismatch");
  let serial = 0;
  const pending = new Map<string, "pending" | "uncertain">();
  const inFlight = new Set<Promise<unknown>>();
  const effect = async (
    kind: HostEffect["kind"],
    input: unknown,
    context: Record<string, unknown>,
    capabilityId?: string,
    toolName?: string,
    identity?: string,
  ): Promise<ActionOutcome> => {
    const effectId = `${checkpoint.turnId}:${checkpoint.segment}:${kind}:${identity ?? ++serial}`;
    const request: HostEffect = JSON.parse(
      JSON.stringify({
        effectId,
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        agentId: manifest.id,
        manifestHash: checkpoint.manifestHash,
        kind,
        input,
        context,
        ...(capabilityId ? { capabilityId } : {}),
        ...(toolName ? { toolName } : {}),
      }),
    );
    const operation = host.resolveEffect(request);
    inFlight.add(operation);
    let result: EffectResolution;
    try {
      result = await operation;
    } finally {
      inFlight.delete(operation);
    }
    if (result.status !== "completed") {
      pending.set(effectId, result.status);
      throw new HostSuspension(effectId, result.status);
    }
    return result.outcome;
  };
  let patchTail: Promise<void> = Promise.resolve();
  const implementations: Record<string, Implementations[string]> = {};
  for (const capability of manifest.capabilities) {
    const tools: Record<string, any> = {};
    for (const tool of capability.tools ?? [])
      tools[tool.name] = {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: schemaFromJSON(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: schemaFromJSON(tool.outputSchema) } : {}),
        async execute(args: unknown, ctx: any) {
          const previous = patchTail;
          let release!: () => void;
          patchTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          try {
            const outcome = await effect(
              "tool",
              args,
              {
                executionId: ctx.executionId,
                turnId: ctx.turnId,
                stepId: ctx.stepId,
                callId: ctx.callId,
                invocationId: ctx.invocationId,
                idempotencyKey: ctx.idempotencyKey,
                info: ctx.info,
                state: ctx.state.entries(),
                resume: ctx.resume,
              },
              capability.id,
              tool.name,
              ctx.invocationId,
            );
            // Apply concurrently resolved patches in manifest call order, independent of host I/O timing.
            await previous;
            for (const [key, value] of Object.entries(outcome.statePatch ?? {}))
              ctx.state.set(key, value);
            const value = outcome.value as any;
            return value?.kind === "interaction-required"
              ? {
                  ...value,
                  interaction: {
                    ...value.interaction,
                    id: `${checkpoint.turnId}:${checkpoint.segment}:interaction:${ctx.invocationId}`,
                  },
                }
              : value;
          } finally {
            await previous;
            release();
          }
        },
      };
    implementations[capability.id] = {
      tools,
      ...(capability.beforeModelCall
        ? {
            beforeModelCall: async (args: any) =>
              (await effect("beforeModelCall", args, { info: checkpoint.info }, capability.id))
                .value as any,
          }
        : {}),
      ...(capability.afterModelCall
        ? {
            afterModelCall: async (args: any, ctx: any) =>
              (await effect("afterModelCall", args, ctx, capability.id)).value as any,
          }
        : {}),
    };
  }
  const definition = definitionFor(agentFrom(manifest, implementations));
  // Manifest reconstruction must retain definition identity, including schemas and instructions.
  if (definition.hash !== checkpoint.manifestHash)
    throw new HarnessError("execution.incompatible", "Reconstructed definition hash mismatch");
  try {
    const result = await withDeterministicIds(`${checkpoint.turnId}_${checkpoint.segment}`, () =>
      execute(definition, {
        state:
          checkpoint.state ??
          initializeExecutionState(definition, { executionId: checkpoint.sessionId }),
        input: checkpoint.input,
        info: checkpoint.info,
        signal: options.signal,
        onModelCall: async (call, ctx) =>
          (
            await effect(
              "model",
              call,
              { request: ctx.request, invocationId: ctx.invocationId },
              undefined,
              undefined,
              ctx.invocationId,
            )
          ).value as any,
      }),
    );
    return { status: result.status, checkpoint: { ...checkpoint, state: result.state }, result };
  } catch (error) {
    // Parallel tool dispatch can suspend more than one action. Drain persistence before returning.
    await Promise.allSettled([...inFlight]);
    if (!(error instanceof HostSuspension)) throw error;
    return {
      status: [...pending.values()].includes("uncertain") ? "uncertain" : "waiting",
      checkpoint,
      effectIds: [...pending.keys()],
    };
  }
}
