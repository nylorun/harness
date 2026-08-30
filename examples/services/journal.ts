import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type CanonicalEvent = Readonly<{
  session: string;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}>;

export type SessionSummary = Readonly<{
  session: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  events: number;
}>;

/** Explicit local-only JSONL persistence. Raw provider payloads never enter this service. */
export class JsonlJournal {
  constructor(
    private readonly root: string,
    private readonly secrets: readonly string[],
  ) {}

  async append(agent: string, event: CanonicalEvent): Promise<void> {
    const file = this.file(agent, event.session);
    await mkdir(join(this.root, agent, event.session), { recursive: true });
    await appendFile(file, `${JSON.stringify(scrub(event, this.secrets))}\n`);
  }

  async events(agent: string, session: string): Promise<readonly CanonicalEvent[]> {
    try {
      return Object.freeze(
        (await readFile(this.file(agent, session), "utf8"))
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as CanonicalEvent];
            } catch {
              return [];
            }
          }),
      );
    } catch {
      return Object.freeze([]);
    }
  }

  async list(agent: string): Promise<readonly SessionSummary[]> {
    try {
      const ids = await readdir(join(this.root, agent));
      const summaries = await Promise.all(
        ids.map(async (session) => {
          const events = await this.events(agent, session);
          const final = events.at(-1);
          return {
            session,
            status:
              final?.type === "final"
                ? "completed"
                : events.some((event) => event.type === "interaction.required")
                  ? "waiting"
                  : "running",
            startedAt: events[0] ? Date.parse(events[0].ts) : 0,
            ...(final?.type === "final" ? { endedAt: Date.parse(final.ts) } : {}),
            events: events.length,
          };
        }),
      );
      return Object.freeze(summaries.sort((a, b) => b.startedAt - a.startedAt));
    } catch {
      return Object.freeze([]);
    }
  }

  private file(agent: string, session: string): string {
    return join(this.root, safe(agent), safe(session), "events.jsonl");
  }
}

function safe(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new Error("Refusing a path-shaped ID.");
  }
  return value;
}

function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => (secret.length >= 8 ? text.split(secret).join("[redacted]") : text),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /authorization|api.?key|token|secret|cookie/iu.test(key)
          ? "[redacted]"
          : scrub(item, secrets),
      ]),
    );
  return value;
}
