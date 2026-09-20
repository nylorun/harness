import {
  implementationsFor,
  isToolError,
  normalizeToolDefinition,
  normalizedSchemasFor,
  type BuiltAgent,
  type JsonValue,
  type ToolExecutionContext,
} from "@nylorun/harness/define";
import type { Action, ActionOutcome } from "@nylorun/harness/contracts";
class Suspend {
  constructor(readonly outcome: unknown) {}
}
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
/** Executes code only after a host-issued claim. No engine dependency. */
export async function executeAction(
  action: Action,
  agent: BuiltAgent,
  signal: AbortSignal
): Promise<ActionOutcome> {
  const impl = implementationsFor(agent)[action.capabilityId];
  if (!impl) throw new Error(`No capability ${action.capabilityId}`);
  if (action.kind === "beforeModelCall") {
    if (!impl.beforeModelCall)
      throw new Error("Missing beforeModelCall implementation");
    try {
      return { value: (await impl.beforeModelCall(action.input as any)) ?? {} };
    } catch (error) {
      return { value: { block: message(error) } };
    }
  }
  if (action.kind === "afterModelCall") {
    if (!impl.afterModelCall)
      throw new Error("Missing afterModelCall implementation");
    try {
      return {
        value:
          (await impl.afterModelCall(
            action.input as any,
            action.context as any
          )) ?? {},
      };
    } catch (error) {
      return { value: { block: message(error) } };
    }
  }
  const raw = impl.tools?.[action.toolName ?? ""];
  if (!raw) throw new Error("Missing tool implementation");
  const tool = normalizeToolDefinition(raw);
  const schemas = normalizedSchemasFor(tool);
  const input = schemas.inputSchema.validate(action.input);
  if (!input.ok)
    return {
      value: {
        kind: "failed",
        code: "tool.invalid-input",
        message: JSON.stringify(input.issues),
      },
    };
  const ctx = action.context;
  const state: Record<string, JsonValue> = { ...object(ctx.state) };
  const statePatch: Record<string, JsonValue> = {};
  const resume = object(ctx.resume);
  const token = object(resume.token);
  const memo = object(token._nylorun);
  const steps: Record<string, JsonValue> = { ...object(memo.steps) };
  const answers: Record<string, JsonValue> = { ...object(memo.answers) };
  let waitIndex = 0;
  let gateApproved =
    Boolean(memo.gateApproved) ||
    Boolean(memo.approvalGate && resume.kind === "approval" && resume.approved);
  const durableToken = (extra: Record<string, unknown> = {}) => ({
    _nylorun: { steps, answers, waitIndex, gateApproved, ...extra },
  });
  const wait = async (
    kind: "approval" | "response",
    prompt: string,
    metadata?: any
  ): Promise<any> => {
    const index = String(waitIndex++);
    if (index in answers) return answers[index];
    if (
      !memo.approvalGate &&
      resume.kind === kind &&
      Number(memo.waitIndex ?? 0) === Number(index)
    ) {
      const answer =
        kind === "approval" ? Boolean(resume.approved) : resume.value;
      answers[index] = answer;
      return answer;
    }
    throw new Suspend({
      kind: "interaction-required",
      interaction: { kind, prompt, ...(metadata ? { metadata } : {}) },
      token: {
        _nylorun: { steps, answers, waitIndex: Number(index), gateApproved },
      },
    });
  };
  const context: ToolExecutionContext = {
    executionId: String(ctx.executionId ?? action.sessionId),
    turnId: String(ctx.turnId ?? action.turnId),
    stepId: String(ctx.stepId ?? ""),
    callId: String(ctx.callId ?? action.actionId),
    invocationId: String(ctx.invocationId ?? action.actionId),
    idempotencyKey: String(ctx.idempotencyKey ?? action.actionId),
    signal,
    info: ctx.info,
    session: { id: action.sessionId },
    ...(ctx.resume ? { resume: ctx.resume as any } : {}),
    state: {
      get: (key) => state[key],
      set: (key, value) => {
        state[key] = value;
        statePatch[key] = value;
      },
      entries: () => ({ ...state }),
    },
    progress() {
      /* Canonical events are host-owned; progress transport is deferred. */
    },
    ask: (prompt, options) => wait("response", prompt, options),
    approve: (prompt) => wait("approval", prompt),
    sleep: async (duration) => {
      throw new Suspend({
        kind: "deferred",
        token: durableToken({ wait: { kind: "sleep", duration } }),
      });
    },
    waitFor: async (event, options) => {
      throw new Suspend({
        kind: "deferred",
        token: durableToken({ wait: { kind: "waitFor", event, ...options } }),
      });
    },
    step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      if (Object.prototype.hasOwnProperty.call(steps, name))
        return steps[name] as T;
      signal.throwIfAborted();
      const value = await fn();
      // Memoized values are durable only with a persisted action outcome. Interrupted actions stay uncertain.
      steps[name] = JSON.parse(JSON.stringify(value ?? null));
      return value;
    },
  };
  try {
    signal.throwIfAborted();
    if (tool.approval && !gateApproved) {
      const approval = await tool.approval(input.value);
      if (approval)
        throw new Suspend({
          kind: "interaction-required",
          interaction: {
            kind: "approval",
            prompt:
              typeof approval === "string" ? approval : `Approve ${tool.name}?`,
          },
          token: durableToken({ approvalGate: true }),
        });
      gateApproved = true;
    }
    if (resume.kind === "approval" && resume.approved === false)
      return { value: { kind: "denied", reason: "Approval denied" } };
    const value = await tool.execute!(input.value, context);
    const tagged = object(value);
    let outcome: any;
    if (
      [
        "completed",
        "failed",
        "denied",
        "interaction-required",
        "deferred",
      ].includes(tagged.kind)
    )
      outcome = value;
    else outcome = { kind: "completed", output: value ?? null };
    if (outcome.kind === "completed" && schemas.outputSchema) {
      const parsed = schemas.outputSchema.validate(outcome.output);
      outcome = parsed.ok
        ? { ...outcome, output: parsed.value }
        : {
            kind: "failed",
            code: "tool.invalid-output",
            message: JSON.stringify(parsed.issues),
          };
    }
    return { value: outcome, statePatch };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      value:
        error instanceof Suspend
          ? error.outcome
          : {
              kind: "failed",
              code: isToolError(error) ? error.code : "tool.execution-failed",
              message: message(error),
            },
      statePatch,
    };
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
