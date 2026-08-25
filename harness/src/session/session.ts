import type {
  AgentRunInput,
  InputEvent,
  InputHandle,
  InputOptions,
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
    this.scheduler = new SessionScheduler(id, agent, session);
    this.scheduler.observeKernel({ type: "session.created" });
  }

  get state(): SessionSnapshot {
    return this.scheduler.snapshot;
  }
  input(event: AgentRunInput, options?: InputOptions): InputHandle {
    return this.scheduler.submit(normalizeInput(event), options);
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

function normalizeInput(input: AgentRunInput): InputEvent {
  return typeof input === "string" ? { kind: "user-message", text: input } : input;
}
