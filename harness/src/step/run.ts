import type { StepInput } from "../types/middleware.js";
import type { ModelCandidate, ModelConfigurationSnapshot } from "../types/model.js";
import type {
  ObserveEvent,
  ObserveModelConfigurationSnapshot,
  ObserveToolSnapshot,
} from "../types/shared.js";
import type { InputEvent, ExecutionSnapshot } from "../types/transcript.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { LoopAgent } from "../build/agent.js";
import { normalizeCandidate } from "../model/normalize.js";
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

export interface StepRunResult {
  readonly stepId: string;
  readonly state: ExecutionSnapshot;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
  readonly requestedModelId?: string;
  readonly modelInvocationId?: string;
}

export async function runStep(input: {
  agent: LoopAgent;
  observe: ObserveEmit;
  state: ExecutionSnapshot;
  executionId: string;
  turnId: string;
  stepId: string;
  turnNumber: number;
  stepNumber: number;
  arrivals: readonly InputEvent[];
  toolResults: readonly import("../types/tool.js").ToolResult[];
  signal: AbortSignal;
  scope?: unknown;
  output?: import("../execution/output-contract.js").TurnOutputContract;
}): Promise<StepRunResult> {
  let state = input.state;
  let requestedModelId: string | undefined;
  let modelInvocationId: string | undefined;
  const stepInput = Object.freeze({
    executionId: input.executionId,
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    scope: input.scope,
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    transcript: Object.freeze([...input.state.transcript]),
  });
  const configuration = new ModelConfigurationDraft();
  const runtimeContext = new ContextDraft();
  const context = new StepContext(stepInput, input.observe, configuration, runtimeContext);
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
      input.signal.throwIfAborted();
      if (context.currentTripwire) return context.tripwire(context.currentTripwire);
      try {
        const selected = configuration.snapshot();
        for (const tool of selected.tools) input.agent.registry.reference(tool);
        context.sealConfiguration(selected);
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
        output: input.output,
      });
      requestedModelId = request.model?.id;
      const call = projectModelCall(request);
      const invocationId = createId("invocation");
      modelInvocationId = invocationId;
      input.observe(() => ({
        type: "model.requested",
        invocationId,
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
        let prepared = false;
        const outcome = await input.agent.invoke(call, {
          request,
          invocationId,
          signal: input.signal,
          reportPreparedCall(value) {
            if (prepared)
              throw new HarnessError(
                "model.adapter-invalid-options",
                "Model adapter may report only one prepared call per invocation",
              );
            if (typeof value.adapter !== "string" || value.adapter === "")
              throw new HarnessError(
                "model.adapter-invalid-options",
                "Prepared model call adapter must be a non-empty string",
              );
            prepared = true;
            const reported = Object.freeze({ adapter: value.adapter, call: copyJson(value.call) });
            input.observe(() => ({
              type: "model.prepared",
              invocationId,
              turnId: input.turnId,
              stepId: input.stepId,
              ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
              attributes: reported,
            }));
          },
        });
        if (input.signal.aborted) throw input.signal.reason;
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
  const output = sealStep(context, input.output);
  const candidate = output.kind === "tools" ? output.plan.candidate : context.currentCandidate;
  return Object.freeze({
    stepId: input.stepId,
    state,
    ...(candidate ? { candidate } : {}),
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    output,
    ...(modelInvocationId ? { modelInvocationId } : {}),
  });
}

function snapshotStepStart(
  input: StepInput,
): Extract<ObserveEvent, { type: "step.started" }>["attributes"] {
  return Object.freeze({
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
  });
}

function snapshotTools(tools: readonly BoundToolDefinition[]): readonly ObserveToolSnapshot[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        owner: tool.owner,
        inputSchema: Object.freeze({ jsonSchema: copyJson(tool.inputSchema.jsonSchema) }),
        ...(tool.outputSchema === undefined
          ? {}
          : {
              outputSchema: Object.freeze({ jsonSchema: copyJson(tool.outputSchema.jsonSchema) }),
            }),
      }),
    ),
  );
}
