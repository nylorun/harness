import type { ToolRegistry } from "../../definition/registry.js";
import type { AgentDefinition } from "../../definition/agent-definition.js";
import type { ModelAdapter } from "@nylorun/core/define";
import type { InputEvent, TranscriptEntry } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import type { BoundMiddleware } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import type { CallPatch } from "./hooks.js";

/** Compiled definition pieces plus the per-run model adapter for one step. */
export interface StepRuntime {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
  readonly registry: ToolRegistry;
  /** Full definition for before/after hooks (optional for middleware-only agents). */
  readonly definition?: AgentDefinition;
  /** Mutable session memory bag shared with tools. */
  sessionState?: Record<string, JsonValue>;
  /** Called after hook results are applied so the host can record. */
  recordAfterDynamics?: () => Promise<void>;
}

/** Turn-scoped hook state carried into each step. */
export interface StepTurnHooks {
  /** True for the first model call of a new turn: run before("turn"). */
  readonly start: boolean;
  /** Input that started the turn; hooks see it on every step, including retries. */
  readonly input?: string;
  /** Validated before("turn") patch applied to every step. */
  readonly patch?: CallPatch;
  /** Retries already requested by after("step") hooks this turn. */
  readonly afterStepAttempts: number;
}

export interface StepInput {
  readonly executionId: string;
  readonly turnId: string;
  readonly stepId: string;
  /** One-based position of this turn within the execution. */
  readonly turnNumber: number;
  /** One-based position of this Model Step within the Turn. */
  readonly stepNumber: number;
  readonly info?: unknown;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
}

/** Internal view consumed by a single model step. */
export interface ExecutionSnapshot {
  readonly id: string;
  readonly status: "running";
  readonly turnCount: number;
  readonly revision: number;
  readonly transcript: readonly TranscriptEntry[];
}
