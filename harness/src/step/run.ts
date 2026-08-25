import type { StepMiddleware } from "../types/middleware.js";
import type { ModelCandidate } from "../types/model.js";
import type { ObserveEvent } from "../types/shared.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { InputEvent, SessionSnapshot } from "../types/session.js";
import type { AdapterRegistry } from "../build/adapters.js";
import type { ModelRegistry } from "../build/models.js";
import { normalizeCandidate } from "../types/model.js";
import { runMiddleware } from "./compose.js";
import { StepContext } from "./context.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";

export interface LoopAgent {
  readonly catalog: readonly BoundToolDefinition[];
  readonly catalogByName: ReadonlyMap<string, BoundToolDefinition>;
  readonly instructions: readonly string[];
  readonly middleware: readonly StepMiddleware[];
  readonly models: ModelRegistry;
  readonly adapters: AdapterRegistry;
}

export interface StepRunResult {
  readonly stepId: string;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
}

export async function runStep(input: {
  agent: LoopAgent;
  observe: (event: ObserveEvent) => void;
  state: SessionSnapshot;
  sessionId: string;
  turnId: string;
  stepId: string;
  turnNumber: number;
  stepNumber: number;
  arrivals: readonly InputEvent[];
  toolResults: readonly import("../types/tool.js").ToolResult[];
  defaultModel: string;
  signal: AbortSignal;
  session: Readonly<{
    readonly userId?: string;
    readonly context?: import("../types/shared.js").JsonObject;
  }>;
}): Promise<StepRunResult> {
  const stepInput = Object.freeze({
    sessionId: input.sessionId,
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    session: input.session,
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
  });
  const context = new StepContext(stepInput, new Set(input.agent.models.entries.keys()));
  await runMiddleware(
    input.agent.middleware,
    context,
    async () => {
      if (context.currentTripwire) return;
      const request = resolveModelRequest({
        context,
        defaultModel: input.defaultModel,
        boundInstructions: input.agent.instructions,
        transcript: input.state.transcript,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
        tools: input.agent.catalog,
        sessionContext: input.session.context,
      });
      const model = input.agent.models.require(request.modelId);
      input.observe({
        type: "model.started",
        turnId: input.turnId,
        stepId: input.stepId,
        attributes: { modelId: request.modelId },
      });
      try {
        context.setCandidate(normalizeCandidate(await model.invoke(request, input.signal)));
        if (input.signal.aborted) throw input.signal.reason;
        input.observe({
          type: "model.completed",
          turnId: input.turnId,
          stepId: input.stepId,
          attributes: { modelId: request.modelId },
        });
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        context.tripwire({
          code: "model.failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    input.observe,
  );
  const output = sealStep(context, input.agent.catalogByName);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({ stepId: input.stepId, ...(candidate ? { candidate } : {}), output });
}
