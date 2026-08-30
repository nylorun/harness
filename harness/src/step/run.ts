import type { StepInput } from "../types/middleware.js";
import type { ModelCandidate, ModelConfigurationSnapshot } from "../types/model.js";
import type {
  ObserveEvent,
  ObserveModelConfigurationSnapshot,
  ObserveToolSnapshot,
} from "../types/shared.js";
import type { ActiveModelExecutionRecord, InputEvent, SessionSnapshot } from "../types/session.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { LoopAgent } from "../build/agent.js";
import { normalizeCandidate } from "../model-normalize.js";
import { HarnessError, isHarnessError } from "../errors.js";
import { copyJson } from "../utils/immutable.js";
import type { ObserveEmit } from "../utils/observe.js";
import { runMiddleware } from "./compose.js";
import { ContextDraft } from "./context-draft.js";
import { StepContext } from "./step-context.js";
import { projectModelCall } from "./project.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";
import { ModelConfigurationDraft } from "./model-configuration.js";
import { createId } from "../utils/ids.js";
import type { CapabilityStateRegistry } from "../session/capability-state.js";

export interface StepRunResult {
  readonly stepId: string;
  readonly state: SessionSnapshot;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
  readonly requestedModelId?: string;
}

export async function runStep(input: {
  agent: LoopAgent;
  observe: ObserveEmit;
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
  states: CapabilityStateRegistry;
  recordModelRequested(
    state: SessionSnapshot,
    active: ActiveModelExecutionRecord,
  ): Promise<SessionSnapshot>;
}): Promise<StepRunResult> {
  let state = input.state;
  let requestedModelId: string | undefined;
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
  const configuration = new ModelConfigurationDraft();
  const runtimeContext = new ContextDraft(input.session.context);
  const context = new StepContext(
    stepInput,
    input.observe,
    configuration,
    runtimeContext,
    input.states,
  );
  input.observe(() => ({
    type: "step.started",
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    attributes: snapshotStepStart(stepInput),
  }));
  await runMiddleware(
    input.agent.middleware,
    context,
    async () => {
      if (context.currentTripwire) return context.tripwire(context.currentTripwire);
      try {
        context.sealConfiguration(configuration.snapshot());
        context.sealContext(runtimeContext.snapshot());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "configuration.invalid",
          message,
        });
      }
      const request = resolveModelRequest({
        context,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
      });
      requestedModelId = request.model?.id;
      const call = projectModelCall(request);
      const invocationId = createId("invocation");
      const active: ActiveModelExecutionRecord = Object.freeze({
        kind: "model",
        turnId: input.turnId,
        stepId: input.stepId,
        invocationId,
        call,
      });
      state = await input.recordModelRequested(state, active);
      input.observe(() => ({
        type: "model.requested",
        turnId: input.turnId,
        stepId: input.stepId,
        ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
        attributes: Object.freeze({
          call,
          configuration: snapshotConfiguration(request.configuration),
          context: copyJson(request.context),
        }),
      }));
      try {
        const outcome = await input.agent.invoke(call, {
          request,
          invocationId,
          signal: input.signal,
        });
        if (input.signal.aborted) throw input.signal.reason;
        if (isDeferred(outcome))
          return context.deferModel(
            Object.freeze({
              ...active,
              ...(outcome.token === undefined ? {} : { token: copyJson(outcome.token) }),
            }),
          );
        const minted = context.mintFromModel(normalizeCandidate(outcome));
        const candidate = context.currentCandidate;
        if (!candidate)
          throw new HarnessError("model.candidate-missing", "Model candidate missing after mint");
        return minted;
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "model.failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    input.observe,
  );
  const output = sealStep(context);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({
    stepId: input.stepId,
    state,
    ...(candidate ? { candidate } : {}),
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    output,
  });
}

function isDeferred(
  value: string | ModelCandidate | import("../types/shared.js").DeferredOutcome,
): value is import("../types/shared.js").DeferredOutcome {
  return (
    typeof value === "object" && value !== null && "kind" in value && value.kind === "deferred"
  );
}

function snapshotStepStart(
  input: StepInput,
): Extract<ObserveEvent, { type: "step.started" }>["attributes"] {
  const session = Object.freeze({
    ...(input.session.userId === undefined ? {} : { userId: input.session.userId }),
    ...(input.session.context === undefined ? {} : { context: copyJson(input.session.context) }),
  });
  return Object.freeze({
    ...(Object.keys(session).length === 0 ? {} : { session }),
    arrivals: copyJson(input.arrivals),
    toolResults: copyJson(input.toolResults),
    transcript: input.transcript,
  });
}

function snapshotConfiguration(
  configuration: ModelConfigurationSnapshot,
): ObserveModelConfigurationSnapshot {
  return Object.freeze({
    version: configuration.version,
    ...(configuration.model === undefined ? {} : { model: copyJson(configuration.model) }),
    instructions: copyJson(configuration.instructions),
    tools: snapshotTools(configuration.tools),
    toolContracts: copyJson(configuration.toolContracts),
    contributors: copyJson(configuration.contributors),
    digests: copyJson(configuration.digests),
  });
}

function snapshotTools(tools: readonly BoundToolDefinition[]): readonly ObserveToolSnapshot[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        owner: tool.owner,
        parameters: Object.freeze({ jsonSchema: copyJson(tool.parameters.jsonSchema) }),
      }),
    ),
  );
}
