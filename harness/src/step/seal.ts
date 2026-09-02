import type { ModelCandidate } from "../types/model.js";
import { textFromOutput } from "../model/normalize.js";
import type { Tripwire } from "../types/shared.js";
import type {
  BoundToolDefinition,
  RequiredInteraction,
  SealedToolCall,
  ToolOwner,
  ToolOutcome,
  ToolResult,
} from "../types/tool.js";
import { createId } from "../utils/ids.js";
import { HarnessError, isHarnessError } from "../errors.js";
import { assertJson, copyJson } from "../utils/immutable.js";
import type { CanonicalCall } from "./canonicalize.js";
import type { StepContext } from "./step-context.js";

export interface ExecutablePlanEntry {
  readonly call: SealedToolCall;
  readonly invocationId: string;
  readonly owner: ToolOwner;
  readonly execute: BoundToolDefinition["execute"];
  readonly interaction?: RequiredInteraction;
}

export interface InternalToolPlan {
  readonly candidate: ModelCandidate;
  readonly order: readonly { readonly callId: string; readonly toolName: string }[];
  readonly executable: readonly ExecutablePlanEntry[];
  readonly immediateResults: readonly ToolResult[];
}

export type SealedStepOutput =
  | { readonly kind: "tripwire"; readonly tripwire: Tripwire }
  | { readonly kind: "final"; readonly output: string }
  | {
      readonly kind: "deferred-model";
      readonly active: import("../types/session.js").ActiveModelExecutionRecord;
    }
  | { readonly kind: "tools"; readonly plan: InternalToolPlan };

interface SealedCall {
  readonly order: { readonly callId: string; readonly toolName: string };
  readonly canonical: { readonly id: string; readonly name: string; readonly args: unknown };
  readonly executable?: ExecutablePlanEntry;
  readonly immediate?: ToolResult;
}

const failed = (callId: string, toolName: string, code: string, message: string): ToolResult =>
  Object.freeze({ kind: "failed", callId, toolName, code, message });

/** Converts the reviewed canonical candidate into either a final response or an executable tool plan. */
export function sealStep(context: StepContext): SealedStepOutput {
  if (context.currentTripwire)
    return Object.freeze({ kind: "tripwire", tripwire: context.currentTripwire });
  if (context.currentModelDeferred)
    return Object.freeze({ kind: "deferred-model", active: context.currentModelDeferred });
  const calls = context.canonicalCalls();
  if (!calls.length)
    return Object.freeze({
      kind: "final",
      output: textFromOutput(context.currentCandidate?.output ?? []),
    });

  const catalog = context.catalogByName;
  const sealed = calls.map((call) => sealCall(context, catalog, call));
  const canonicalCandidate =
    context.currentCandidate ?? Object.freeze({ output: Object.freeze([]) });
  return Object.freeze({
    kind: "tools",
    plan: Object.freeze({
      candidate: canonicalCandidate,
      order: Object.freeze(sealed.map((item) => item.order)),
      executable: Object.freeze(
        sealed.flatMap((item) => (item.executable ? [item.executable] : [])),
      ),
      immediateResults: Object.freeze(
        sealed.flatMap((item) => (item.immediate ? [item.immediate] : [])),
      ),
    }),
  });
}

function sealCall(
  context: StepContext,
  catalog: ReadonlyMap<string, BoundToolDefinition>,
  candidate: CanonicalCall,
): SealedCall {
  const order = Object.freeze({ callId: candidate.id, toolName: candidate.name });
  const canonical = Object.freeze({
    id: candidate.id,
    name: candidate.name,
    args: candidate.args,
  });
  if (candidate.missingId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.invalid-call-id",
        "Tool call id must not be empty",
      ),
    };
  if (candidate.duplicateId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.duplicate-call-id",
        `Duplicate Tool call id '${candidate.duplicateId}'`,
      ),
    };

  const tool = catalog.get(candidate.name);
  if (!tool)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.unknown",
        `Unknown Tool '${candidate.name}'`,
      ),
    };
  const args = validatedArguments(tool, candidate);
  if (isHarnessError(args))
    return {
      order,
      canonical,
      immediate: failed(candidate.id, candidate.name, args.code, args.message),
    };
  const denial = context.denialFor(candidate.id);
  if (denial)
    return {
      order,
      canonical,
      immediate: Object.freeze({
        kind: "denied",
        callId: candidate.id,
        toolName: candidate.name,
        reason: denial,
      }),
    };

  const requested = context.interactionFor(candidate.id);
  const interaction = requested
    ? Object.freeze({ ...requested, id: requested.id ?? createId("interaction") })
    : undefined;
  return {
    order,
    canonical,
    executable: Object.freeze({
      call: Object.freeze({
        callId: candidate.id,
        toolName: candidate.name,
        args,
      }),
      invocationId: createId("invocation"),
      owner: tool.owner,
      execute: tool.execute,
      ...(interaction ? { interaction } : {}),
    }),
  };
}

function validatedArguments(
  tool: BoundToolDefinition,
  candidate: CanonicalCall,
): import("../types/shared.js").JsonValue | HarnessError {
  const validation = tool.parameters.validate(candidate.args);
  if (!validation.ok)
    return new HarnessError("tool.invalid-arguments", validation.issues.join("; "));
  try {
    assertJson(validation.value, `arguments for '${candidate.name}'`);
    return copyJson(validation.value);
  } catch (error) {
    return isHarnessError(error)
      ? error
      : new HarnessError("tool.invalid-arguments", String(error), { cause: error });
  }
}
