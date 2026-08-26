import type { BoundMiddleware, StepInput } from "../types/middleware.js";
import type { ModelAdapter, ModelCandidate, ModelDirective, ModelRequest } from "../types/model.js";
import type { ObserveEvent, ObserveModelRequest, ObserveToolSnapshot } from "../types/shared.js";
import type { InputEvent, SessionSnapshot } from "../types/session.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { AdapterRegistry } from "../build/adapters.js";
import { normalizeCandidate } from "../types/model.js";
import { copyJson } from "../utils/immutable.js";
import { runMiddleware } from "./compose.js";
import { StepContext } from "./context.js";
import { resolveModelRequest } from "./resolve.js";
import { sealStep, type SealedStepOutput } from "./seal.js";
import { assertCanonicalPrefix, type PromptPrefixState } from "./prompt-prefix.js";

export interface LoopAgent {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
  readonly directive?: ModelDirective;
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
  prefixState: PromptPrefixState;
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
  const context = new StepContext(stepInput, input.observe, prefixTransaction);
  input.observe({
    type: "step.started",
    turnId: input.turnId,
    stepId: input.stepId,
    turnNumber: input.turnNumber,
    stepNumber: input.stepNumber,
    attributes: snapshotStepStart(stepInput),
  });
  await runMiddleware(
    input.agent.middleware,
    context,
    async () => {
      if (context.currentTripwire) return context.tripwire(context.currentTripwire);
      let ledger;
      try {
        const prefix = prefixTransaction.snapshot();
        ledger = input.prefixState.preview(prefixTransaction, prefix);
        context.commitPrefix(ledger.snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.tripwire({
          code: message.startsWith("Duplicate Tool '") ? "tool.duplicate-name" : "prefix.invalid",
          message,
        });
      }
      const request = resolveModelRequest({
        context,
        arrivals: input.arrivals,
        toolResults: input.toolResults,
        sessionContext: input.session.context,
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
          throw new Error("Resolved ModelRequest diverged from its prompt prefix snapshot");
        input.prefixState.commit(prefixTransaction, ledger);
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
          code: "prefix.drift",
          message: error instanceof Error ? error.message : String(error),
          scope: "session",
        });
      }
      input.observe({
        type: "model.started",
        turnId: input.turnId,
        stepId: input.stepId,
        ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
        attributes: snapshotModelRequest(request),
      });
      try {
        const minted = context.mintFromModel(
          normalizeCandidate(await input.agent.invoke(request, input.signal)),
        );
        if (input.signal.aborted) throw input.signal.reason;
        const candidate = context.currentCandidate;
        if (!candidate) throw new TypeError("Model candidate missing after mint");
        input.observe({
          type: "model.completed",
          turnId: input.turnId,
          stepId: input.stepId,
          ...(request.model?.id === undefined ? {} : { requestedModelId: request.model.id }),
          attributes: copyJson(candidate),
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
    transcript: copyJson(input.transcript),
  });
}

function snapshotModelRequest(request: ModelRequest): ObserveModelRequest {
  return Object.freeze({
    ...(request.model === undefined ? {} : { model: copyJson(request.model) }),
    prefix: request.prefix,
    instructions: Object.freeze([...request.instructions]),
    context: copyJson(request.context),
    arrivals: copyJson(request.arrivals),
    toolResults: copyJson(request.toolResults),
    transcript: copyJson(request.transcript),
    tools: snapshotTools(request.tools),
  });
}

function snapshotTools(tools: readonly BoundToolDefinition[]): readonly ObserveToolSnapshot[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        executeWith: tool.executeWith,
        route: copyJson(tool.route),
        ...(tool.metadata === undefined ? {} : { metadata: copyJson(tool.metadata) }),
        input: Object.freeze({ jsonSchema: copyJson(tool.input.jsonSchema) }),
      }),
    ),
  );
}
