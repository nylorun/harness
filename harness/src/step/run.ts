import type { StepInput } from "../types/middleware.js";
import type { ModelCandidate, ModelRequest, PromptPrefixSnapshot } from "../types/model.js";
import type {
  ObserveEvent,
  ObserveModelRequest,
  ObservePromptPrefixSnapshot,
  ObserveToolSnapshot,
} from "../types/shared.js";
import type { InputEvent, SessionSnapshot } from "../types/session.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { LoopAgent } from "../build/agent.js";
import { normalizeCandidate } from "../model-normalize.js";
import { HarnessError, isHarnessError } from "../errors.js";
import { copyJson } from "../utils/immutable.js";
import type { ObserveEmit } from "../utils/observe.js";
import { runMiddleware } from "./compose.js";
import { ContextState } from "./context-state.js";
import { StepContext } from "./step-context.js";
import { projectModelCall } from "./project.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";
import { assertCanonicalPrefix, type PromptPrefixState } from "./prompt-prefix.js";

export interface StepRunResult {
  readonly stepId: string;
  readonly candidate?: ModelCandidate;
  readonly output: SealedStepOutput;
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
  prefixState: PromptPrefixState;
  contextState: ContextState;
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
  const prefixTransaction = input.prefixState.begin(input.agent.adapters);
  const contextTransaction = input.contextState.begin();
  const context = new StepContext(stepInput, input.observe, prefixTransaction, contextTransaction);
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
      let ledger;
      try {
        const prefix = prefixTransaction.snapshot();
        ledger = input.prefixState.preview(prefixTransaction, prefix);
        const contextSnapshot = contextTransaction.snapshot();
        context.commitPrefix(ledger.snapshot);
        context.commitContext(contextSnapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "prefix.invalid",
          message,
        });
      }
      const request = resolveModelRequest({
        context,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
      });
      try {
        assertCanonicalPrefix(request.prefix);
        if (
          request.model !== request.prefix.model ||
          request.instructions.join("\u0000") !==
            request.prefix.instructions.map((item) => item.text).join("\u0000") ||
          request.tools.length !== request.prefix.tools.length ||
          request.tools.some((tool, index) => tool !== request.prefix.tools[index])
        )
          throw new HarnessError(
            "request.prefix-drift",
            "Resolved ModelRequest diverged from its prompt prefix snapshot",
          );
        input.prefixState.commit(prefixTransaction, ledger);
        input.contextState.commit(contextTransaction, request.context);
        input.observe({
          type: "model.prefix",
          turnId: input.turnId,
          stepId: input.stepId,
          attributes: ledger,
        });
      } catch (error) {
        input.observe({
          type: "model.prefix",
          turnId: input.turnId,
          stepId: input.stepId,
          attributes: {
            status: "drift",
            snapshot: request.prefix,
          },
        });
        return context.tripwire({
          code: isHarnessError(error) ? error.code : "request.prefix-drift",
          message: error instanceof Error ? error.message : String(error),
          scope: "session",
        });
      }
      input.observe(() => ({
        type: "model.started",
        turnId: input.turnId,
        stepId: input.stepId,
        ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
        attributes: snapshotModelRequest(request),
      }));
      try {
        const minted = context.mintFromModel(
          normalizeCandidate(
            await input.agent.invoke(projectModelCall(request), {
              request,
              signal: input.signal,
            }),
          ),
        );
        if (input.signal.aborted) throw input.signal.reason;
        const candidate = context.currentCandidate;
        if (!candidate)
          throw new HarnessError("model.candidate-missing", "Model candidate missing after mint");
        input.observe(() => ({
          type: "model.completed",
          turnId: input.turnId,
          stepId: input.stepId,
          ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
          attributes: candidate,
        }));
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
  return Object.freeze({ stepId: input.stepId, ...(candidate ? { candidate } : {}), output });
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

function snapshotModelRequest(request: ModelRequest): ObserveModelRequest {
  return Object.freeze({
    ...(request.model === undefined ? {} : { model: copyJson(request.model) }),
    prefix: snapshotPrefix(request.prefix),
    instructions: Object.freeze([...request.instructions]),
    context: copyJson(request.context),
    arrivals: copyJson(request.arrivals),
    toolResults: copyJson(request.toolResults),
    transcript: request.transcript,
    tools: snapshotTools(request.tools),
  });
}

function snapshotPrefix(prefix: PromptPrefixSnapshot): ObservePromptPrefixSnapshot {
  return Object.freeze({
    version: prefix.version,
    ...(prefix.model === undefined ? {} : { model: copyJson(prefix.model) }),
    instructions: copyJson(prefix.instructions),
    tools: snapshotTools(prefix.tools),
    toolContracts: copyJson(prefix.toolContracts),
    contributors: copyJson(prefix.contributors),
    digests: copyJson(prefix.digests),
  });
}

function snapshotTools(tools: readonly BoundToolDefinition[]): readonly ObserveToolSnapshot[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        executeWith: tool.executeWith,
        parameters: Object.freeze({ jsonSchema: copyJson(tool.parameters.jsonSchema) }),
      }),
    ),
  );
}
