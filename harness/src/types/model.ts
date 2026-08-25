import type { ContextItem, JsonObject } from "./shared.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { BoundToolDefinition, ToolResult } from "./tool.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";
import { digest } from "../utils/digest.js";

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export type ModelOutputBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: JsonObject;
      readonly raw?: string;
    };

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
}

export type ModelFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

export interface ModelEvidence {
  readonly requestId?: string;
  readonly resolvedModel?: string;
  readonly warnings?: readonly string[];
  readonly extras?: JsonObject;
}

export interface ModelCandidate {
  readonly output: readonly ModelOutputBlock[];
  readonly finishReason?: ModelFinishReason;
  readonly usage?: ModelUsage;
  readonly evidence?: ModelEvidence;
}

export interface ModelControls {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelDirective {
  readonly id?: string;
  readonly controls?: ModelControls;
  readonly config?: JsonObject;
}

export interface ModelRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly model?: ModelDirective;
  readonly instructions: readonly string[];
  readonly context: readonly ContextItem[];
  readonly transcript: readonly TranscriptEntry[];
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  /** Tools are normalized and immutable by the time a Model sees them. */
  readonly tools: readonly BoundToolDefinition[];
}

export interface ModelInvoker {
  readonly id?: string;
  readonly version?: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelCandidate | string>;
}

const FINISH_REASONS = new Set<ModelFinishReason>([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "other",
]);
const USAGE_TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedTokens",
  "reasoningTokens",
] as const;

export function normalizeDirective(value: unknown): ModelDirective | Error {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new Error("Model directive must be an object");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "id" && key !== "controls" && key !== "config")
      return new Error(`Model directive has unknown key '${key}'`);
  }
  const raw = value as { id?: unknown; controls?: unknown; config?: unknown };
  if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.length === 0))
    return new Error("Model directive id must be a non-empty string");
  let controls: ModelControls | undefined;
  if (raw.controls !== undefined) {
    const normalized = normalizeControls(raw.controls);
    if (normalized instanceof Error) return normalized;
    controls = normalized;
  }
  let config: JsonObject | undefined;
  if (raw.config !== undefined) {
    try {
      config = copyJsonObject(raw.config, "model directive config");
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  return Object.freeze({
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(controls === undefined ? {} : { controls }),
    ...(config === undefined ? {} : { config }),
  });
}

export function sameDirective(left: ModelDirective, right: ModelDirective): boolean {
  return digest(left) === digest(right);
}

export function textFromOutput(output: readonly ModelOutputBlock[]): string {
  return output.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function toolCallsFromOutput(output: readonly ModelOutputBlock[]): readonly ModelToolCall[] {
  return Object.freeze(
    output.flatMap((block) =>
      block.type === "tool-call"
        ? [Object.freeze({ id: block.id, name: block.name, args: block.args })]
        : [],
    ),
  );
}

export function normalizeCandidate(value: ModelCandidate | string): ModelCandidate {
  if (typeof value === "string")
    return Object.freeze({ output: freezeBlocks([{ type: "text", text: value }]) });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Model candidate must be an object or string");
  if (!Array.isArray(value.output)) throw new TypeError("Model candidate output must be an array");
  const output = freezeBlocks(value.output.map((block, index) => normalizeBlock(block, index)));
  return Object.freeze({
    output,
    ...(value.finishReason === undefined
      ? {}
      : { finishReason: normalizeFinishReason(value.finishReason) }),
    ...(value.usage === undefined ? {} : { usage: normalizeUsage(value.usage) }),
    ...(value.evidence === undefined ? {} : { evidence: normalizeEvidence(value.evidence) }),
  });
}

function normalizeControls(value: unknown): ModelControls | Error {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return new Error("Model directive controls must be an object");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "temperature" && key !== "maxOutputTokens")
      return new Error(`Model directive controls has unknown key '${key}'`);
  }
  const raw = value as { temperature?: unknown; maxOutputTokens?: unknown };
  if (raw.temperature !== undefined && !isFiniteNumber(raw.temperature))
    return new Error("Model directive temperature must be a finite number");
  if (raw.maxOutputTokens !== undefined && !isNonNegativeInteger(raw.maxOutputTokens))
    return new Error("Model directive maxOutputTokens must be a non-negative integer");
  return Object.freeze({
    ...(raw.temperature === undefined ? {} : { temperature: raw.temperature }),
    ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
  });
}

function normalizeBlock(value: unknown, index: number): ModelOutputBlock {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Model output[${index}] must be an object`);
  const block = value as { type?: unknown };
  if (block.type === "text" || block.type === "reasoning") {
    rejectUnknownKeys(value, ["type", "text"], `Model output[${index}]`);
    const text = (value as { text?: unknown }).text;
    if (typeof text !== "string")
      throw new TypeError(`Model output[${index}].text must be a string`);
    return Object.freeze({ type: block.type, text });
  }
  if (block.type === "tool-call") {
    rejectUnknownKeys(value, ["type", "id", "name", "args", "raw"], `Model output[${index}]`);
    const raw = value as { id?: unknown; name?: unknown; args?: unknown; raw?: unknown };
    if (raw.id !== undefined && typeof raw.id !== "string")
      throw new TypeError(`Model output[${index}].id must be a string`);
    if (raw.name !== undefined && typeof raw.name !== "string")
      throw new TypeError(`Model output[${index}].name must be a string`);
    let args: JsonObject;
    try {
      args = copyJsonObject(raw.args, `Model output[${index}].args`);
    } catch (error) {
      throw error instanceof TypeError
        ? error
        : new TypeError(`Model output[${index}].args must be a JSON object`);
    }
    if (raw.raw !== undefined && typeof raw.raw !== "string")
      throw new TypeError(`Model output[${index}].raw must be a string`);
    return Object.freeze({
      type: "tool-call",
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : "",
      args,
      ...(raw.raw === undefined ? {} : { raw: raw.raw }),
    });
  }
  throw new TypeError(`Model output[${index}] has unknown type`);
}

function normalizeFinishReason(value: unknown): ModelFinishReason {
  if (value === "error" || value === "aborted")
    throw new TypeError("Model candidate finishReason cannot be error or aborted");
  if (typeof value !== "string" || !FINISH_REASONS.has(value as ModelFinishReason))
    throw new TypeError("Model candidate finishReason is invalid");
  return value as ModelFinishReason;
}

function normalizeUsage(value: unknown): ModelUsage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Model candidate usage must be an object");
  rejectUnknownKeys(value, [...USAGE_TOKEN_KEYS, "costUsd"], "Model candidate usage");
  const raw = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const key of USAGE_TOKEN_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isNonNegativeInteger(raw[key]))
      throw new TypeError(`Model candidate usage.${key} must be a non-negative integer`);
    usage[key] = raw[key];
  }
  if (raw.costUsd !== undefined) {
    if (!isFiniteNumber(raw.costUsd))
      throw new TypeError("Model candidate usage.costUsd must be a finite number");
    usage.costUsd = raw.costUsd;
  }
  return Object.freeze(usage);
}

function normalizeEvidence(value: unknown): ModelEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Model candidate evidence must be an object");
  rejectUnknownKeys(
    value,
    ["requestId", "resolvedModel", "warnings", "extras"],
    "Model candidate evidence",
  );
  const raw = value as {
    requestId?: unknown;
    resolvedModel?: unknown;
    warnings?: unknown;
    extras?: unknown;
  };
  if (raw.requestId !== undefined && typeof raw.requestId !== "string")
    throw new TypeError("Model candidate evidence.requestId must be a string");
  if (raw.resolvedModel !== undefined && typeof raw.resolvedModel !== "string")
    throw new TypeError("Model candidate evidence.resolvedModel must be a string");
  let warnings: readonly string[] | undefined;
  if (raw.warnings !== undefined) {
    if (!Array.isArray(raw.warnings) || raw.warnings.some((item) => typeof item !== "string"))
      throw new TypeError("Model candidate evidence.warnings must be an array of strings");
    warnings = Object.freeze([...raw.warnings]);
  }
  const extras =
    raw.extras === undefined
      ? undefined
      : copyJsonObject(raw.extras, "Model candidate evidence.extras");
  return Object.freeze({
    ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
    ...(typeof raw.resolvedModel === "string" ? { resolvedModel: raw.resolvedModel } : {}),
    ...(warnings === undefined ? {} : { warnings }),
    ...(extras === undefined ? {} : { extras }),
  });
}

function freezeBlocks(blocks: readonly ModelOutputBlock[]): readonly ModelOutputBlock[] {
  return Object.freeze(blocks.map((block) => Object.freeze(block)));
}

function rejectUnknownKeys(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${path} has unknown key '${key}'`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
