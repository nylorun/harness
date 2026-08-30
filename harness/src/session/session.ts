import type {
  InputEvent,
  InputHandle,
  InputOptions,
  InteractionReply,
  MessageInput,
  Session,
  SessionEvent,
  SessionRunOptions,
  SessionSnapshot,
  SessionInput,
} from "../types/session.js";
import type { Observer } from "../types/shared.js";
import { SessionScheduler } from "./scheduler.js";
import type { LoopAgent } from "../build/agent.js";
import { copyJsonObject } from "../utils/immutable.js";
import { normalizeSessionSeed } from "./seed.js";

export class LiveSession implements Session {
  private readonly scheduler: SessionScheduler;

  constructor(
    readonly id: string,
    agent: LoopAgent,
    options: SessionRunOptions,
  ) {
    const seed = "seed" in options && options.seed ? normalizeSessionSeed(options.seed) : undefined;
    const userId = seed?.userId ?? ("userId" in options ? options.userId : undefined);
    const suppliedContext = seed?.context ?? ("context" in options ? options.context : undefined);
    const session = Object.freeze({
      ...(userId === undefined ? {} : { userId }),
      ...(suppliedContext === undefined
        ? {}
        : { context: copyJsonObject(suppliedContext, "session context") }),
    });
    this.scheduler = new SessionScheduler(id, agent, session, {
      ...(seed === undefined ? {} : { seed }),
      ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    });
  }

  get state(): SessionSnapshot {
    return this.scheduler.snapshot;
  }
  input(event: SessionInput, options?: InputOptions): InputHandle {
    return this.scheduler.submit(normalizeInput(event), options);
  }
  interrupt(event: MessageInput, options?: InputOptions): InputHandle {
    return this.scheduler.submit(normalizeMessage("interrupt", event), options);
  }
  continue(options?: InputOptions): InputHandle {
    return this.scheduler.continue(options);
  }
  stream(): AsyncIterable<SessionEvent> {
    return this.scheduler.events;
  }
  observe(listener: Observer): () => void {
    return this.scheduler.observe(listener);
  }
  stop(reason?: string): Promise<void> {
    return this.scheduler.stop(reason);
  }
}

function isInteractionReply(value: SessionInput): value is InteractionReply {
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

function normalizeInput(input: SessionInput): InputEvent {
  if (typeof input === "string") return { kind: "user-message", text: input };
  if (isInteractionReply(input)) return input;
  return normalizeMessage("user-message", input);
}
