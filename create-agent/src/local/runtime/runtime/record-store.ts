import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelCandidate, ModelToolCall, ObserveEvent, TranscriptEntry } from "@nylorun/harness";

/** Project-local session journals live here, one directory per session. */
export const NYLO_DIRECTORY = ".nylo";

export type DurableRecord = Readonly<{
  ts: string;
  sessionId: string;
  turnNumber: number;
  stepNumber: number;
  transcript: readonly TranscriptEntry[];
  candidate?: ModelCandidate;
  toolCalls: readonly ModelToolCall[];
}>;

export type ObserveLine = ObserveEvent & { readonly ts: string };

export type RecordSummary = Readonly<{
  session: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  events: number;
}>;

/**
 * Where a session's durable step records and observe events are written.
 *
 * Each session owns a directory so a killed process still leaves what it had. Recording is an
 * obligation of the local runtime and never a precondition of the session: a directory that cannot
 * be written produces a warning, and the run continues.
 */
export type SessionJournal = Readonly<{
  appendRecord(session: string, record: DurableStep): Promise<void>;
  appendObserve(session: string, event: ObserveEvent): Promise<void>;
  readRecords(session: string): Promise<readonly DurableRecord[] | undefined>;
  readObserve(session: string): Promise<readonly ObserveLine[] | undefined>;
  summary(session: string): Promise<RecordSummary | undefined>;
  list(): Promise<readonly RecordSummary[]>;
  remove(session: string): Promise<boolean>;
  flush(): Promise<void>;
}>;

export type DurableStep = Omit<DurableRecord, "ts"> & { readonly ts?: string };

export type SessionJournalOptions = Readonly<{
  projectRoot: string;
  /**
   * Values that must never reach a line. Redaction happens before the write rather than at read
   * time, so a record is safe to attach to a bug report without a scrubbing step to remember.
   */
  redact?: readonly string[];
  onError?: (error: Error) => void;
}>;

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie"]);

/**
 * Replaces every occurrence of a known secret value, and the value of any credential-bearing header,
 * with a marker. Header names are matched case-insensitively because a wire header is not a
 * JavaScript identifier and nothing normalises them on the way in.
 */
export function redactRecord(value: unknown, secrets: readonly string[]): unknown {
  const scrub = (text: string): string => {
    let output = text;
    for (const secret of secrets) {
      if (secret.length < 8) continue; // Too short to be a credential, and likely to match prose.
      output = output.split(secret).join("[redacted]");
    }
    return output;
  };

  const walk = (node: unknown, headerish: boolean): unknown => {
    if (typeof node === "string") return headerish ? "[redacted]" : scrub(node);
    if (Array.isArray(node)) return node.map((item) => walk(item, headerish));
    if (node !== null && typeof node === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        output[key] = walk(item, headerish || CREDENTIAL_HEADERS.has(key.toLowerCase()));
      }
      return output;
    }
    return node;
  };

  return walk(value, false);
}

function sessionDirectory(projectRoot: string, session: string): string {
  return join(projectRoot, NYLO_DIRECTORY, session);
}

function recordPath(projectRoot: string, session: string): string {
  return join(sessionDirectory(projectRoot, session), "record.jsonl");
}

function observePath(projectRoot: string, session: string): string {
  return join(sessionDirectory(projectRoot, session), "observe.jsonl");
}

/** Session ids are generated, but a path is still built from one — so refuse anything path-shaped. */
function assertPlainId(session: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(session) || session === "." || session === "..") {
    throw new Error(`Refusing a session id that is not a plain name: ${session}`);
  }
}

async function readLines(file: string): Promise<string[] | undefined> {
  try {
    const contents = await readFile(file, "utf8");
    return contents.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return undefined;
  }
}

function parseLines<T>(lines: readonly string[]): T[] {
  const parsed: T[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as T);
    } catch {
      // A truncated final line is what a killed process leaves. Everything before it is real.
    }
  }
  return parsed;
}

function inferStatus(observe: readonly ObserveLine[]): { status: string; endedAt?: number } {
  const latest = observe.at(-1);
  if (latest === undefined) return { status: "incomplete" };
  if (latest.type === "session.stopped") {
    const endedAt = Date.parse(latest.ts);
    return { status: "completed", ...(Number.isFinite(endedAt) ? { endedAt } : {}) };
  }
  if (latest.type === "interaction.required") return { status: "waiting" };
  if (latest.type === "tripwire") return { status: "failed" };
  return { status: "incomplete" };
}

export function createSessionJournal(options: SessionJournalOptions): SessionJournal {
  const secrets = options.redact ?? [];
  const report = options.onError ?? ((): void => {});
  const writes = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  const enqueue = (file: string, work: () => Promise<void>): Promise<void> => {
    const previous = writes.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    writes.set(file, next);
    pending.add(next);
    void next.finally(() => pending.delete(next));
    return next;
  };

  const settled = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const appendLine = async (file: string, value: unknown): Promise<void> => {
    await enqueue(file, async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(redactRecord(value, secrets))}\n`);
      } catch (error) {
        report(error as Error);
      }
    });
  };

  return Object.freeze({
    async appendRecord(session, record) {
      assertPlainId(session);
      await appendLine(recordPath(options.projectRoot, session), {
        ts: record.ts ?? new Date().toISOString(),
        sessionId: record.sessionId,
        turnNumber: record.turnNumber,
        stepNumber: record.stepNumber,
        transcript: record.transcript,
        ...(record.candidate === undefined ? {} : { candidate: record.candidate }),
        toolCalls: record.toolCalls
      });
    },

    async appendObserve(session, event) {
      assertPlainId(session);
      await appendLine(observePath(options.projectRoot, session), { ts: new Date().toISOString(), ...event });
    },

    async readRecords(session) {
      assertPlainId(session);
      await settled();
      const lines = await readLines(recordPath(options.projectRoot, session));
      return lines === undefined ? undefined : Object.freeze(parseLines<DurableRecord>(lines));
    },

    async readObserve(session) {
      assertPlainId(session);
      await settled();
      const lines = await readLines(observePath(options.projectRoot, session));
      return lines === undefined ? undefined : Object.freeze(parseLines<ObserveLine>(lines));
    },

    async summary(session) {
      assertPlainId(session);
      const records = await this.readRecords(session);
      const observe = await this.readObserve(session);
      if (records === undefined && observe === undefined) return undefined;
      const recordLines = records ?? [];
      const observeLines = observe ?? [];
      const firstTs = observeLines[0]?.ts ?? recordLines[0]?.ts;
      const inferred = inferStatus(observeLines);
      return Object.freeze({
        session,
        status: inferred.status,
        startedAt: firstTs === undefined ? 0 : Date.parse(firstTs) || 0,
        ...(inferred.endedAt === undefined ? {} : { endedAt: inferred.endedAt }),
        events: observeLines.length
      });
    },

    async list() {
      await settled();
      let names: string[];
      try {
        names = await readdir(join(options.projectRoot, NYLO_DIRECTORY));
      } catch {
        return Object.freeze([]);
      }
      const summaries: RecordSummary[] = [];
      for (const name of names.sort()) {
        if (name === "." || name === "..") continue;
        try {
          const found = await this.summary(name);
          if (found !== undefined) summaries.push(found);
        } catch {
          // A leftover file or a path-shaped name is not a session.
        }
      }
      return Object.freeze(summaries.sort((a, b) => b.startedAt - a.startedAt));
    },

    async remove(session) {
      assertPlainId(session);
      await settled();
      try {
        await rm(sessionDirectory(options.projectRoot, session), { recursive: true });
        return true;
      } catch {
        return false;
      }
    },

    flush: settled
  });
}
