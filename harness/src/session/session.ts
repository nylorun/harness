import type {
  AgentRunInput,
  InputEvent,
  InputHandle,
  InputOptions,
  InteractionReply,
  MessageInput,
  Session,
  SessionEvent,
  SessionOptions,
  SessionSnapshot,
} from "../types/session.js";
import type { Observer } from "../types/shared.js";
import { SessionScheduler } from "./scheduler.js";
import type { LoopAgent } from "../step/run.js";
import { copyJsonObject } from "../utils/immutable.js";

export class LiveSession implements Session {
  private readonly scheduler: SessionScheduler;

  constructor(
    readonly id: string,
    agent: LoopAgent,
    options: SessionOptions,
  ) {
    const session = Object.freeze({
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.context ? { context: copyJsonObject(options.context, "session context") } : {}),
    });
    this.scheduler = new SessionScheduler(id, agent, session, options.prefixPolicy);
  }

  get state(): SessionSnapshot {
    return this.scheduler.snapshot;
  }
  input(event: AgentRunInput, options?: InputOptions): InputHandle {
    return this.scheduler.submit(normalizeInput(event), options);
  }
  interrupt(event: MessageInput, options?: InputOptions): InputHandle {
    return this.scheduler.submit(normalizeMessage("interrupt", event), options);
  }
  stream(): AsyncIterable<SessionEvent> {
    return this.scheduler.events;
  }
  observe(listener: Observer): void {
    this.scheduler.setObserver(listener);
  }
  stop(reason?: string): Promise<void> {
    return this.scheduler.stop(reason);
  }
}

function isInteractionReply(value: AgentRunInput): value is InteractionReply {
  return (
    typeof value === "object" &&
    "kind" in value &&
    (value.kind === "approve" || value.kind === "respond")
  );
}

function normalizeMessage(kind: "user-message" | "interrupt", value: MessageInput): InputEvent {
  if (typeof value === "string") return { kind, text: value };
  return {
    kind,
    text: value.text,
    ...(value.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(value.metadata, "input metadata") }),
  };
}

function normalizeInput(input: AgentRunInput): InputEvent {
  if (typeof input === "string") return { kind: "user-message", text: input };
  if (isInteractionReply(input)) return input;
  return normalizeMessage("user-message", input);
}
