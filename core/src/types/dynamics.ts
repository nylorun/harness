import type { JsonValue } from "./shared.js";
import type { PromptItem } from "./model.js";
import type { MessageInput } from "./transcript.js";

/** Closed-world patch applied before a model call. No `model` — Runtime owns resolution. */
export type Patch = {
  /** Switch capabilities declared in the manifest. */
  readonly capabilities?: Readonly<Record<string, boolean>>;
  /** Switch tools by name. */
  readonly tools?: Readonly<Record<string, boolean>>;
  /** Extra instructions for this model call only. */
  readonly instructions?: readonly string[];
  /** Write session state keys (merged into durable session state). */
  readonly state?: Readonly<Record<string, JsonValue>>;
  /** Refuse this model call; message returned to the host. */
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

export type BeforeModelCallFn<Info = unknown> = (args: {
  readonly input?: MessageInput | string;
  readonly info?: Info;
  readonly state: Readonly<Record<string, JsonValue>>;
  readonly messages: readonly PromptItem[];
  readonly step: number;
}) => Patch | Promise<Patch>;

export type AfterModelCallFn<Info = unknown> = (
  args: {
    readonly text?: string;
    readonly toolCalls: readonly {
      readonly id: string;
      readonly name: string;
      readonly args: JsonValue;
    }[];
  },
  ctx: {
    readonly info?: Info;
    readonly state: Readonly<Record<string, JsonValue>>;
  }
) => Decision | Promise<Decision>;
