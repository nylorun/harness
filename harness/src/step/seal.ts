import type { ModelCandidate } from "../types/model.js";
import { textFromOutput } from "../types/model.js";
import type { Tripwire } from "../types/shared.js";
import type {
  BoundToolDefinition,
  RequiredInteraction,
  SealedToolCall,
  ToolResult,
} from "../types/tool.js";
import { createId } from "../utils/ids.js";
import { assertJson, copyJson } from "../utils/immutable.js";
import type { CanonicalCall } from "./canonicalize.js";
import type { StepContext } from "./context.js";

export interface ExecutablePlanEntry {
  readonly call: SealedToolCall;
  readonly invocationId: string;
  readonly interaction?: RequiredInteraction;
  readonly preflight?: "sandbox" | "validation";
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
  if (context.isToolHidden(candidate.name))
    return {
      order,
      canonical,
      immediate: failed(
        candidate.id,
        candidate.name,
        "tool.hidden",
        `Tool '${candidate.name}' is not visible in this Step`,
      ),
    };

  const args = validatedArguments(tool, candidate);
  if (args instanceof Error)
    return {
      order,
      canonical,
      immediate: failed(candidate.id, candidate.name, "tool.invalid-arguments", args.message),
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
  const preflight = context.preflightFor(candidate.id);
  return {
    order,
    canonical,
    executable: Object.freeze({
      call: Object.freeze({
        callId: candidate.id,
        toolName: candidate.name,
        args,
        executeWith: tool.executeWith,
        route: tool.route,
      }),
      invocationId: createId("invocation"),
      ...(interaction ? { interaction } : {}),
      ...(preflight ? { preflight } : {}),
    }),
  };
}

function validatedArguments(
  tool: BoundToolDefinition,
  candidate: CanonicalCall,
): import("../types/shared.js").JsonValue | Error {
  const validation = tool.input.validate(candidate.args);
  if (!validation.ok) return new Error(validation.issues.join("; "));
  try {
    assertJson(validation.value, `arguments for '${candidate.name}'`);
    return copyJson(validation.value);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
