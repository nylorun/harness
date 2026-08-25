import type { ModelCandidate } from "../types/model.js";
import type { Tripwire } from "../types/shared.js";
import type {
  BoundToolDefinition,
  RequiredInteraction,
  SealedToolCall,
  ToolResult,
} from "../types/tool.js";
import { createId } from "../utils/ids.js";
import { assertJson, copyJson } from "../utils/immutable.js";
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

interface CanonicalCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly missingId: boolean;
  readonly duplicateId?: string;
}

interface SealedCall {
  readonly order: { readonly callId: string; readonly toolName: string };
  readonly canonical: { readonly id: string; readonly name: string; readonly args: unknown };
  readonly executable?: ExecutablePlanEntry;
  readonly immediate?: ToolResult;
}

const failed = (callId: string, toolName: string, code: string, message: string): ToolResult =>
  Object.freeze({ kind: "failed", callId, toolName, code, message });

/** Converts middleware-adjusted model output into either a final response or an executable tool plan. */
export function sealStep(
  context: StepContext,
  catalog: ReadonlyMap<string, BoundToolDefinition>,
): SealedStepOutput {
  if (context.currentTripwire)
    return Object.freeze({ kind: "tripwire", tripwire: context.currentTripwire });
  const candidate: Readonly<ModelCandidate> =
    context.currentCandidate ?? Object.freeze({ content: "" });
  if (!candidate.toolCalls?.length)
    return Object.freeze({ kind: "final", output: candidate.content ?? "" });

  const sealed = canonicalizeCalls(candidate.toolCalls).map((call) =>
    sealCall(context, catalog, call),
  );
  const canonicalCandidate = Object.freeze({
    ...(candidate.content === undefined ? {} : { content: candidate.content }),
    toolCalls: Object.freeze(sealed.map((item) => item.canonical)),
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
  });
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

function canonicalizeCalls(
  calls: readonly { readonly id?: string; readonly name?: string; readonly args: unknown }[],
): readonly CanonicalCall[] {
  const idCounts = new Map<string, number>();
  for (const call of calls) {
    if (typeof call.id === "string" && call.id)
      idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
  }
  return calls.map((call) => {
    const hasId = typeof call.id === "string" && call.id.length > 0;
    const duplicateId = hasId && (idCounts.get(call.id) ?? 0) > 1 ? call.id : undefined;
    return Object.freeze({
      callId: hasId && !duplicateId ? call.id : createId("call"),
      toolName: typeof call.name === "string" ? call.name : "unknown",
      args: call.args,
      missingId: !hasId,
      ...(duplicateId ? { duplicateId } : {}),
    });
  });
}

function sealCall(
  context: StepContext,
  catalog: ReadonlyMap<string, BoundToolDefinition>,
  candidate: CanonicalCall,
): SealedCall {
  const order = Object.freeze({ callId: candidate.callId, toolName: candidate.toolName });
  const canonical = Object.freeze({
    id: candidate.callId,
    name: candidate.toolName,
    args: candidate.args,
  });
  if (candidate.missingId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.callId,
        candidate.toolName,
        "tool.invalid-call-id",
        "Tool call id must not be empty",
      ),
    };
  if (candidate.duplicateId)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.callId,
        candidate.toolName,
        "tool.duplicate-call-id",
        `Duplicate Tool call id '${candidate.duplicateId}'`,
      ),
    };

  const tool = catalog.get(candidate.toolName);
  if (!tool)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.callId,
        candidate.toolName,
        "tool.unknown",
        `Unknown Tool '${candidate.toolName}'`,
      ),
    };
  if (context.isToolHidden(candidate.toolName))
    return {
      order,
      canonical,
      immediate: failed(
        candidate.callId,
        candidate.toolName,
        "tool.hidden",
        `Tool '${candidate.toolName}' is not visible in this Step`,
      ),
    };

  const args = validatedArguments(tool, candidate);
  if (args instanceof Error)
    return {
      order,
      canonical,
      immediate: failed(
        candidate.callId,
        candidate.toolName,
        "tool.invalid-arguments",
        args.message,
      ),
    };
  const denial = context.denialFor(candidate.callId);
  if (denial)
    return {
      order,
      canonical,
      immediate: Object.freeze({
        kind: "denied",
        callId: candidate.callId,
        toolName: candidate.toolName,
        reason: denial,
      }),
    };

  const requested = context.interactionFor(candidate.callId);
  const interaction = requested
    ? Object.freeze({ ...requested, id: requested.id ?? createId("interaction") })
    : undefined;
  const preflight = context.preflightFor(candidate.callId);
  return {
    order,
    canonical,
    executable: Object.freeze({
      call: Object.freeze({
        callId: candidate.callId,
        toolName: candidate.toolName,
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
    assertJson(validation.value, `arguments for '${candidate.toolName}'`);
    return copyJson(validation.value);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
