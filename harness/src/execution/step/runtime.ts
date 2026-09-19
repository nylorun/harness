import type { ToolRegistry } from "../../definition/registry.js";
import type { AgentDefinition } from "../../definition/agent-definition.js";
import type { ModelAdapter } from "../../types/model.js";
import type { InputEvent, TranscriptEntry } from "../../types/transcript.js";
import type { ToolResult } from "../../types/tool.js";
import type { BoundMiddleware } from "../../definition/bound.js";
import type { JsonValue } from "../../types/shared.js";

/** Compiled definition pieces plus the per-run model adapter for one step. */
export interface StepRuntime {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
  readonly registry: ToolRegistry;
  /** Full definition for before/after dynamics (optional for middleware-only agents). */
  readonly definition?: AgentDefinition;
  /** Mutable session memory bag shared with tools. */
  sessionState?: Record<string, JsonValue>;
  /** Called after Patch/Decision applied so the host can record. */
  recordAfterDynamics?: () => Promise<void>;
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
