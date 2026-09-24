import { HarnessError } from "@nylorun/core/define";
import type { JsonValue, Verdict, WorkflowManifest } from "@nylorun/core/define";
import type { DurableHost, HostEffect } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { flowEffectId, iterationsOf, joinPath } from "./paths.js";

export type FlowRunResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string; readonly path?: string };
    }
  | { readonly status: "cancelled" }
  | { readonly status: "paused"; readonly pending: unknown };

export type FlowDurableResult =
  | {
      readonly status: "waiting" | "uncertain";
      readonly checkpoint: FlowCheckpoint;
      readonly effectIds: readonly string[];
    }
  | {
      readonly status: "completed" | "paused" | "cancelled" | "failed";
      readonly checkpoint: FlowCheckpoint;
      readonly result: FlowRunResult;
    };

type LoopHistoryEntry = {
  readonly iteration: number;
  readonly output: JsonValue;
  readonly verdict: Verdict;
};

type Decision =
  { readonly input: JsonValue; readonly agent?: unknown } | { readonly output: JsonValue };

/**
 * Interpret a root Loop node. Returns effects only; the host journals outcomes.
 */
export async function runLoop(options: {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, host } = options;
  const root = manifest.root;
  if (!("loop" in root))
    throw new HarnessError("execution.invalid-state", "runLoop expects a loop root");
  const loop = root.loop;
  const loopPath = loop.id;
  const runNode = loop.run;
  if (!("agent" in runNode))
    throw new HarnessError("execution.invalid-state", "Tracer Loop.run must be an agent node");
  const agentId = runNode.agent;
  const agentPath = joinPath(loopPath, agentId);

  const pending = new Map<string, "pending" | "uncertain">();
  const inFlight = new Set<Promise<unknown>>();

  const effect = async (
    kind: "agent" | "fn" | "verify",
    input: unknown,
    identity: { path: string; key: string; iterations: string },
    context: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const effectId = flowEffectId({
      turnId: checkpoint.turnId,
      segment: checkpoint.segment,
      path: identity.path,
      kind,
      iterations: identity.iterations,
    });
    const request: HostEffect = JSON.parse(
      JSON.stringify({
        effectId,
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        agentId: manifest.id,
        manifestHash: checkpoint.manifestHash,
        kind,
        path: identity.path,
        key: identity.key,
        iterations: identity.iterations,
        input,
        context,
      }),
    );
    const operation = host.resolveEffect(request);
    inFlight.add(operation);
    let result: Awaited<ReturnType<DurableHost["resolveEffect"]>>;
    try {
      result = await operation;
    } finally {
      inFlight.delete(operation);
    }
    if (result.status !== "completed") {
      pending.set(effectId, result.status);
      throw new HostSuspension(effectId, result.status);
    }
    return result.outcome.value;
  };

  try {
    let iteration = 1;
    let currentInput: JsonValue = checkpoint.input;
    const history: LoopHistoryEntry[] = [];
    // Loop run input stays fixed for verify/decide; iteration input feeds the agent.
    const loopInput = checkpoint.input;

    for (;;) {
      if (options.signal?.aborted)
        return { status: "cancelled", checkpoint, result: { status: "cancelled" } };

      const iterations = iterationsOf([iteration]);

      const agentOutput = (await effect(
        "agent",
        {
          agentId,
          input: currentInput,
          path: agentPath,
        },
        { path: agentPath, key: agentPath, iterations },
        { loopPath, n: iteration },
      )) as JsonValue;

      const verdict = (await effect(
        "verify",
        { input: loopInput, output: agentOutput, iteration },
        { path: loopPath, key: loopPath, iterations },
        { loopPath, n: iteration },
      )) as Verdict;

      const decision = (await effect(
        "fn",
        {
          output: agentOutput,
          verdict,
          iteration,
          input: loopInput,
          history,
        },
        { path: loopPath, key: `${loopPath}/decide`, iterations },
        { loopPath, n: iteration, role: "decide" },
      )) as Decision;

      if ("output" in decision && !("input" in decision)) {
        return {
          status: "completed",
          checkpoint,
          result: { status: "completed", output: decision.output },
        };
      }

      if (!("input" in decision))
        throw new HarnessError(
          "execution.invalid-state",
          "Decide returned neither input nor output",
        );

      history.push({ iteration, output: agentOutput, verdict });
      currentInput = decision.input as JsonValue;
      iteration += 1;
    }
  } catch (error) {
    await Promise.allSettled([...inFlight]);
    if (!(error instanceof HostSuspension)) {
      if (error instanceof Error && error.message) {
        return {
          status: "failed",
          checkpoint,
          result: {
            status: "failed",
            error: { code: "loop.stopped", message: error.message, path: loopPath },
          },
        };
      }
      throw error;
    }
    return {
      status: [...pending.values()].includes("uncertain") ? "uncertain" : "waiting",
      checkpoint,
      effectIds: [...pending.keys()],
    };
  }
}
