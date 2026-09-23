import type { JsonValue } from "./shared.js";
import type { PromptItem } from "./model.js";
import type { MessageInput } from "./transcript.js";

/** Closed-world patch applied before a model call. No `model` — Runtime owns resolution. */
export type Patch = {
  /** Switch capabilities declared in the manifest. */
  readonly capabilities?: Readonly<Record<string, boolean>>;
  /** Switch tools by name. */
  readonly tools?: Readonly<Record<string, boolean>>;
  /** Extra instructions for the model calls this patch covers. */
  readonly instructions?: readonly string[];
  /** Write session state keys (merged into durable session state). */
  readonly state?: Readonly<Record<string, JsonValue>>;
  /** Refuse the model call; message returned to the host. */
  readonly block?: string;
  /**
   * Capability-level shorthand: toggle only this capability.
   * Normalized to `capabilities: { [id]: active }` at bind time.
   */
  readonly active?: boolean;
};

/** Decision applied after a model response, before tools/text take effect. */
export type Decision = {
  readonly text?: string;
  readonly deny?: readonly { readonly id: string; readonly reason: string }[];
  readonly approve?: readonly {
    readonly id: string;
    readonly prompt: string;
  }[];
  readonly retry?: string;
  readonly block?: string;
};

/** Decision applied to a turn's final answer before it is returned. */
export type TurnDecision = {
  /** Replace the final text. Plain-text agents only. */
  readonly text?: string;
  /** Replace the final structured output. Agents with an output schema only. */
  readonly output?: JsonValue;
  /** Ask the model to answer again; the feedback is added as a message. */
  readonly retry?: string;
  readonly block?: string;
};

/** When a hook runs: once per turn, or on every model call (step). */
export type HookScope = "turn" | "step";
export type HookAt = "before" | "after";

/** A registered hook point as published in the manifest. */
export type HookManifest = {
  readonly at: HookAt;
  readonly scope: HookScope;
};

export type HookState = Readonly<Record<string, JsonValue>>;

export type HookToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: JsonValue;
};

export type BeforeTurnArgs<Info = unknown> = {
  /** The user input that started this turn. */
  readonly input?: MessageInput | string;
  readonly info?: Info;
  readonly state: HookState;
  readonly messages: readonly PromptItem[];
};

export type BeforeStepArgs<Info = unknown> = BeforeTurnArgs<Info> & {
  /** Zero-based model call index within the turn. */
  readonly step: number;
};

export type AfterStepArgs<Info = unknown> = {
  readonly text?: string;
  readonly toolCalls: readonly HookToolCall[];
  readonly info?: Info;
  readonly state: HookState;
  readonly step: number;
  /** Retries already requested by `after("step")` hooks in this turn. */
  readonly attempt: number;
};

export type AfterTurnArgs<Info = unknown> = {
  /** Final text, for plain-text agents. */
  readonly text?: string;
  /** Final output: the text, or the structured value when an output schema is set. */
  readonly output: JsonValue;
  readonly info?: Info;
  readonly state: HookState;
  /** Retries already requested by `after("turn")` hooks in this turn. */
  readonly attempt: number;
};

type Awaitable<T> = T | Promise<T>;

export type BeforeHook<S extends HookScope, Info = unknown> = (
  args: S extends "turn" ? BeforeTurnArgs<Info> : BeforeStepArgs<Info>
) => Awaitable<Patch>;

export type AfterHook<S extends HookScope, Info = unknown> = S extends "step"
  ? (args: AfterStepArgs<Info>) => Awaitable<Decision>
  : (args: AfterTurnArgs<Info>) => Awaitable<TurnDecision>;

export type BeforeHooks<Info = unknown> = {
  readonly turn?: BeforeHook<"turn", Info>;
  readonly step?: BeforeHook<"step", Info>;
};

export type AfterHooks<Info = unknown> = {
  readonly step?: AfterHook<"step", Info>;
  readonly turn?: AfterHook<"turn", Info>;
};
