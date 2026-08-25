/** The global symbol brands a harness value across independently installed packages. */
export const AGENT_HARNESS: unique symbol = Symbol.for("nylorun.agent.harness") as never;
export const HARNESS_PROTOCOL = "nylorun.harness/v2" as const;

export type SessionEventType =
  | "session.started" | "session.ended" | "session.episode.started" | "session.episode.ended"
  | "session.interrupted" | "session.resumed" | "session.run.started" | "session.run.ended" | "harness.message" | "model.call"
  | "tool.call.started" | "tool.call" | "skill.invocation" | "error";

export type SessionLimits = Readonly<{
  timeoutMs: number; maxTokens: number; maxTurns: number; maxToolResultBytes: number;
}>;

export type Clock = Readonly<{
  now(): Date;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

export type EventEmitter = Readonly<{
  emit(type: SessionEventType, payload: Readonly<Record<string, unknown>>): Promise<unknown>;
  readonly seq: number;
}>;

/** Everything a loop needs for a local turn; host durability remains deliberately absent. */
/** Dependencies which are stable for the lifetime of one configured host. */
export type PrepareInput = Readonly<{
  definition: Readonly<{ name: string; model: string; instructions: string; skills?: readonly unknown[] }>;
  modelGatewayAdapter: unknown;
  tools: readonly unknown[];
}>;

/** Dependencies which are unique to one invocation/session. */
export type StartInput = Readonly<{
  sessionId: string;
  input: string;
  /** Opaque state returned by the preceding turn of this same session. */
  resumeState?: unknown;
  toolContext(toolName: string): Readonly<{ sessionId: string; signal: AbortSignal }>;
  emit: EventEmitter;
  limits: SessionLimits;
  clock: Clock;
  signal: AbortSignal;
}>;

export type NormalizedError = Readonly<{ code: string; message: string; retryable?: boolean }>;

export type ExecutionUsage = Readonly<{
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}>;

export type ExecutionResult = Readonly<{
  status: "completed" | "failed" | "cancelled" | "limit_exceeded";
  output?: string;
  usage?: ExecutionUsage;
  error?: NormalizedError;
  /** Harness-native checkpoint data. It is intentionally opaque and not cross-harness portable. */
  sessionState?: unknown;
}>;

/** A contract whose values describe guarantees, not SDK implementation details. */
export type HarnessCapabilities = Readonly<{
  tools: "native" | "bridged" | "none";
  skills: "native" | "prompt-injected" | "none";
  mcp: "native" | "bridged" | "none";
  streaming: "tokens" | "messages" | "none";
  modelRouting: "nylorun" | "harness-owned";
  sessions: "native" | "runtime-managed" | "none";
  usage: "per-model-call" | "final-only" | "none";
  cancellation: "mid-turn" | "turn-boundary" | "none";
  limits: Readonly<{
    maxTurns: boolean;
    maxTokens: boolean;
    maxToolResultBytes: boolean;
  }>;
}>;

export type HostCompatibilityPolicy = Readonly<{
  requireModelRouting?: "nylorun" | "harness-owned";
  requireTokenStreaming?: boolean;
  requireDurableSessions?: boolean;
  requireSkills?: boolean;
  requireMcp?: boolean;
  requireMaxTokens?: boolean;
  requireMaxToolResultBytes?: boolean;
}>;

export type AgentRequirements = Readonly<{
  tools: boolean;
  skills: boolean;
  mcp: boolean;
  tokenStreaming: boolean;
  modelRouting?: "nylorun" | "harness-owned";
  durableSessions: boolean;
  maxTokens: boolean;
  maxToolResultBytes: boolean;
}>;

export type CompatibilityDiagnostic = Readonly<{
  code: string;
  severity: "error" | "warning";
  requirement: keyof AgentRequirements | "protocol";
  message: string;
  hint: string;
}>;

export type AgentExecution = Readonly<{
  done: Promise<ExecutionResult>;
  abort(reason?: string, code?: string): void;
}>;

export type UnsupportedCapability =
  | "tool-streaming" | "tool-call-budget" | "tool-error-message" | "skills" | "mcp" | "cancellation-midturn";

export type AdapterDescription = Readonly<{
  protocol: typeof HARNESS_PROTOCOL;
  harness: string;
  harnessVersion: string;
  capabilities: HarnessCapabilities;
  /** @deprecated Use capabilities and target compatibility validation. */
  portable: boolean;
  /** @deprecated Use capabilities and target compatibility validation. */
  unsupported: readonly UnsupportedCapability[];
  eventCoverage: readonly SessionEventType[];
  durability: "fold" | "snapshot" | "opaque" | "none";
  concurrency: "serial" | "interleaved";
  compaction: "none" | "truncating" | "replacing";
}>;

/** An SDK-specific execution plan, prepared once per host configuration. */
export type PreparedAgent = Readonly<{
  /**
   * Execute one serial turn. A host retains `sessionState` and supplies it to the next call so a
   * session can accept later messages without a second public execution vocabulary.
   */
  start(input: StartInput): AgentExecution;
}>;

export type AgentAdapter = Readonly<{
  describe(): AdapterDescription | Promise<AdapterDescription>;
  /**
   * Translate a Nylo definition into harness-native objects. This is deliberately
   * separate from `start`: definitions, model providers and tool schemas are static,
   * while sessions, cancellation and event sinks are not.
   */
  prepare(input: PrepareInput): PreparedAgent | Promise<PreparedAgent>;
}>;

export type AgentHarness = Readonly<{
  readonly [AGENT_HARNESS]: true;
  readonly protocol: typeof HARNESS_PROTOCOL;
  readonly adapter: AgentAdapter;
  readonly instructions?: string;
}>;

export function createAgentHarness(
  adapter: AgentAdapter,
  options: Readonly<{ instructions?: string }> = {}
): AgentHarness {
  assertAgentAdapter(adapter);
  return Object.freeze({
    [AGENT_HARNESS]: true as const,
    protocol: HARNESS_PROTOCOL,
    adapter,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions })
  });
}

function assertAgentAdapter(value: unknown): asserts value is AgentAdapter {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("NYLO_HARNESS_ADAPTER_INVALID: Harness adapter must be a non-null object.");
  }
  const adapter = value as Record<string, unknown>;
  if (typeof adapter.describe !== "function" || typeof adapter.prepare !== "function") {
    throw new TypeError("NYLO_HARNESS_ADAPTER_INVALID: Harness adapter must provide describe() and prepare().");
  }
}

export function parseAgentHarness(value: unknown): AgentHarness {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("NYLO_HARNESS_INVALID: Harness must be a non-null object.");
  }
  const harness = value as Record<PropertyKey, unknown>;
  if (harness[AGENT_HARNESS] !== true) {
    throw new TypeError("NYLO_HARNESS_INVALID: Harness is missing the Nylo harness brand.");
  }
  if (harness.protocol !== HARNESS_PROTOCOL) {
    throw new TypeError(`NYLO_HARNESS_PROTOCOL_UNSUPPORTED: Expected ${HARNESS_PROTOCOL}.`);
  }
  if (harness.instructions !== undefined && typeof harness.instructions !== "string") {
    throw new TypeError("NYLO_HARNESS_INVALID: Harness instructions must be a string when provided.");
  }
  assertAgentAdapter(harness.adapter);
  return harness as AgentHarness;
}

export function isAgentHarness(value: unknown): value is AgentHarness {
  try {
    parseAgentHarness(value);
    return true;
  } catch {
    return false;
  }
}

export function isHarnessCapabilities(value: unknown): value is HarnessCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const limits = candidate.limits;
  return (
    (candidate.tools === "native" || candidate.tools === "bridged" || candidate.tools === "none") &&
    (candidate.skills === "native" || candidate.skills === "prompt-injected" || candidate.skills === "none") &&
    (candidate.mcp === "native" || candidate.mcp === "bridged" || candidate.mcp === "none") &&
    (candidate.streaming === "tokens" || candidate.streaming === "messages" || candidate.streaming === "none") &&
    (candidate.modelRouting === "nylorun" || candidate.modelRouting === "harness-owned") &&
    (candidate.sessions === "native" || candidate.sessions === "runtime-managed" || candidate.sessions === "none") &&
    (candidate.usage === "per-model-call" || candidate.usage === "final-only" || candidate.usage === "none") &&
    (candidate.cancellation === "mid-turn" || candidate.cancellation === "turn-boundary" || candidate.cancellation === "none") &&
    typeof limits === "object" && limits !== null &&
    typeof (limits as Record<string, unknown>).maxTurns === "boolean" &&
    typeof (limits as Record<string, unknown>).maxTokens === "boolean" &&
    typeof (limits as Record<string, unknown>).maxToolResultBytes === "boolean"
  );
}

export function isProtocolV1Description(value: unknown): value is AdapterDescription {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === HARNESS_PROTOCOL && typeof candidate.harness === "string" &&
    typeof candidate.harnessVersion === "string" && isHarnessCapabilities(candidate.capabilities) &&
    typeof candidate.portable === "boolean" &&
    Array.isArray(candidate.unsupported) && candidate.unsupported.every((item) =>
      item === "tool-streaming" || item === "tool-call-budget" || item === "tool-error-message" ||
      item === "skills" || item === "mcp" || item === "cancellation-midturn"
    ) &&
    Array.isArray(candidate.eventCoverage) && candidate.eventCoverage.every((item) =>
      item === "session.started" || item === "session.ended" || item === "session.episode.started" ||
      item === "session.episode.ended" || item === "session.interrupted" || item === "session.resumed" ||
      item === "session.run.started" || item === "session.run.ended" ||
      item === "harness.message" || item === "model.call" || item === "tool.call.started" ||
      item === "tool.call" || item === "skill.invocation" || item === "error"
    ) &&
    (candidate.durability === "fold" || candidate.durability === "snapshot" || candidate.durability === "opaque" || candidate.durability === "none") &&
    (candidate.concurrency === "serial" || candidate.concurrency === "interleaved") &&
    (candidate.compaction === "none" || candidate.compaction === "truncating" || candidate.compaction === "replacing");
}

/**
 * Builds requirements from Nylo-owned inputs only, allowing the compiler and host to share the
 * exact same compatibility decision without importing a provider SDK.
 */
export function deriveAgentRequirements(input: Readonly<{
  toolCount?: number;
  skillCount?: number;
  mcpCount?: number;
  policy?: HostCompatibilityPolicy;
}>): AgentRequirements {
  const policy = input.policy ?? {};
  return Object.freeze({
    tools: (input.toolCount ?? 0) > 0,
    skills: (input.skillCount ?? 0) > 0 || policy.requireSkills === true,
    mcp: (input.mcpCount ?? 0) > 0 || policy.requireMcp === true,
    tokenStreaming: policy.requireTokenStreaming === true,
    ...(policy.requireModelRouting === undefined ? {} : { modelRouting: policy.requireModelRouting }),
    durableSessions: policy.requireDurableSessions === true,
    maxTokens: policy.requireMaxTokens === true,
    maxToolResultBytes: policy.requireMaxToolResultBytes === true
  });
}

function diagnostic(
  code: string,
  requirement: CompatibilityDiagnostic["requirement"],
  message: string,
  hint: string,
  severity: CompatibilityDiagnostic["severity"] = "error"
): CompatibilityDiagnostic {
  return Object.freeze({ code, requirement, message, hint, severity });
}

export function validateHarnessCompatibility(
  requirements: AgentRequirements,
  description: AdapterDescription
): readonly CompatibilityDiagnostic[] {
  if (!isProtocolV1Description(description)) {
    return Object.freeze([diagnostic(
      "NYLO_HARNESS_PROTOCOL_UNSUPPORTED",
      "protocol",
      "The selected harness does not implement nylorun.harness/v1.",
      "Upgrade the harness package to nylorun.harness/v1."
    )]);
  }
  const capabilities = description.capabilities;
  const diagnostics: CompatibilityDiagnostic[] = [];
  if (requirements.tools && capabilities.tools === "none") diagnostics.push(diagnostic("NYLO_HARNESS_TOOLS_UNSUPPORTED", "tools", "The agent declares tools but the selected harness cannot execute Nylo tools.", "Use a harness with native or bridged tool support."));
  if (requirements.skills && capabilities.skills === "none") diagnostics.push(diagnostic("NYLO_HARNESS_SKILLS_UNSUPPORTED", "skills", "The agent requires skills but the selected harness does not support them.", "Use a skills-capable harness or remove the skill requirement."));
  if (requirements.mcp && capabilities.mcp === "none") diagnostics.push(diagnostic("NYLO_HARNESS_MCP_UNSUPPORTED", "mcp", "The agent requires MCP but the selected harness does not support it.", "Use an MCP-capable harness or remove the MCP declaration."));
  if (requirements.tokenStreaming && capabilities.streaming !== "tokens") diagnostics.push(diagnostic("NYLO_HARNESS_TOKEN_STREAMING_UNSUPPORTED", "tokenStreaming", "The host requires token streaming but the selected harness cannot provide it.", "Select a token-streaming harness or relax the host streaming policy."));
  if (requirements.modelRouting !== undefined && capabilities.modelRouting !== requirements.modelRouting) diagnostics.push(diagnostic("NYLO_HARNESS_MODEL_ROUTING_UNSUPPORTED", "modelRouting", `The host requires ${requirements.modelRouting} model routing but the harness owns ${capabilities.modelRouting} routing.`, "Select a harness with the required routing mode or update host policy."));
  if (requirements.durableSessions && capabilities.sessions === "none") diagnostics.push(diagnostic("NYLO_HARNESS_DURABILITY_UNSUPPORTED", "durableSessions", "The host requires durable sessions but the selected harness exposes none.", "Select a harness with native or runtime-managed sessions."));
  if (requirements.maxTokens && !capabilities.limits.maxTokens) diagnostics.push(diagnostic("NYLO_HARNESS_MAX_TOKENS_UNSUPPORTED", "maxTokens", "The host requires max-token enforcement but the selected harness cannot enforce it.", "Select a harness that enforces max tokens or relax the policy."));
  if (requirements.maxToolResultBytes && !capabilities.limits.maxToolResultBytes) diagnostics.push(diagnostic("NYLO_HARNESS_TOOL_RESULT_LIMIT_UNSUPPORTED", "maxToolResultBytes", "The host requires tool-result size enforcement but the selected harness cannot enforce it.", "Select a harness that enforces tool-result limits or relax the policy."));
  if (!requirements.tokenStreaming && capabilities.streaming === "messages") diagnostics.push(diagnostic("NYLO_HARNESS_MESSAGE_STREAMING_ONLY", "tokenStreaming", "The selected harness provides message-level rather than token-level streaming.", "Require token streaming in host policy when incremental token delivery is mandatory.", "warning"));
  return Object.freeze(diagnostics);
}

/** Reusable post-run checks for claims that can only be proved from execution evidence. */
export function validateExecutionConformance(
  description: AdapterDescription,
  events: readonly Readonly<{ type: string }>[],
  outcome: ExecutionResult
): readonly CompatibilityDiagnostic[] {
  const diagnostics: CompatibilityDiagnostic[] = [];
  if (outcome.status === "completed" && description.capabilities.usage === "per-model-call" && !events.some((event) => event.type === "model.call")) {
    diagnostics.push(diagnostic("NYLO_HARNESS_USAGE_EVENT_MISSING", "protocol", "The harness declared per-model-call usage but completed without a model.call event.", "Emit a normalized model.call event before resolving a completed outcome."));
  }
  if (outcome.status === "cancelled" && description.capabilities.cancellation === "none") {
    diagnostics.push(diagnostic("NYLO_HARNESS_CANCELLATION_CLAIM_INVALID", "protocol", "The harness returned a cancelled outcome while declaring no cancellation support.", "Declare the cancellation guarantee the adapter actually provides."));
  }
  return Object.freeze(diagnostics);
}
