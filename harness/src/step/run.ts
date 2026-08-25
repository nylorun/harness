import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelCandidate, ModelInvoker } from "../types/model.js";
import type { ObserveEvent } from "../types/shared.js";
import type { InputEvent, SessionSnapshot } from "../types/session.js";
import type { AdapterRegistry } from "../build/adapters.js";
import { normalizeCandidate } from "../types/model.js";
import { digest } from "../utils/digest.js";
import { runMiddleware } from "./compose.js";
import { StepContext } from "./context.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";

export interface LoopAgent {
  readonly middleware: readonly BoundMiddleware[];
  readonly model: ModelInvoker;
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
    transcript: Object.freeze([...input.state.transcript]),
  });
  const context = new StepContext(stepInput, input.agent.adapters, input.observe);
  await runMiddleware(
    input.agent.middleware,
    context,
    async () => {
      if (context.currentTripwire) return context.tripwire(context.currentTripwire);
      const names = context.offeredTools.map((tool) => tool.name);
      input.observe({
        type: "step.catalog",
        turnId: input.turnId,
        stepId: input.stepId,
        attributes: { names: Object.freeze([...names]), digest: digest(names) },
      });
      const request = resolveModelRequest({
        context,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
        sessionContext: input.session.context,
      });
      input.observe({
        type: "model.started",
        turnId: input.turnId,
        stepId: input.stepId,
        ...(request.model?.id === undefined
          ? {}
          : { attributes: { requestedModelId: request.model.id } }),
      });
      try {
        const minted = context.mintFromModel(
          normalizeCandidate(await input.agent.model.invoke(request, input.signal)),
        );
        if (input.signal.aborted) throw input.signal.reason;
        input.observe({
          type: "model.completed",
          turnId: input.turnId,
          stepId: input.stepId,
          ...(request.model?.id === undefined
            ? {}
            : { attributes: { requestedModelId: request.model.id } }),
        });
        return minted;
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        return context.tripwire({
          code: "model.failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    input.observe,
  );
  const output = sealStep(context);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({ stepId: input.stepId, ...(candidate ? { candidate } : {}), output });
}
