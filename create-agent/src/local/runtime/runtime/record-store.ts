import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { RuntimeSessionState, WireSessionEvent } from "./contracts.js";

/** Where records live, relative to the project root. */
export const RECORDS_DIRECTORY = join(".nylo", "runs");

export type RecordSummary = Readonly<{
  session: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  agent?: string;
  model?: string;
  bundleDigest?: string;
  manifestDigest?: string;
  events: number;
}>;

/**
 * A record's final line. It carries what a reader needs to know about the run without replaying it:
 * how it ended, and which bytes produced it.
 */
export type RecordTerminal = Readonly<{
  type: "session.record";
  session: string;
  status: string;
  startedAt: number;
  endedAt: number;
  agent: string;
  model: string;
  bundleDigest: string;
  manifestDigest: string;
  events: number;
}>;

export type RecordWriter = Readonly<{
  append(event: WireSessionEvent): void;
  close(state: RuntimeSessionState | undefined): Promise<void>;
}>;

/**
 * Where a finished session can be read back from.
 *
 * A record is written as it happens rather than assembled at the end, so a run that is killed still
 * leaves what it had. Recording is an obligation of the host and never a precondition of the
 * session: a directory that cannot be written produces a warning, and the run continues.
 */
export type SessionRecorder = Readonly<{
  open(session: string, context: RecorderContext): Promise<RecordWriter>;
  read(session: string): Promise<readonly WireSessionEvent[] | undefined>;
  summary(session: string): Promise<RecordSummary | undefined>;
  list(): Promise<readonly RecordSummary[]>;
  remove(session: string): Promise<boolean>;
}>;

export type RecorderContext = Readonly<{
  agent: string;
  model: string;
  bundleDigest: string;
  manifestDigest: string;
}>;

export type FileRecorderOptions = Readonly<{
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

function recordPath(projectRoot: string, session: string): string {
  return join(projectRoot, RECORDS_DIRECTORY, `${session}.jsonl`);
}

/** Session ids are generated, but a path is still built from one — so refuse anything path-shaped. */
function assertPlainId(session: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(session) || session === "." || session === "..") {
    throw new Error(`Refusing a session id that is not a plain name: ${session}`);
  }
}

export function createFileRecorder(options: FileRecorderOptions): SessionRecorder {
  const directory = join(options.projectRoot, RECORDS_DIRECTORY);
  const secrets = options.redact ?? [];
  const report = options.onError ?? ((): void => {});

  async function readLines(session: string): Promise<string[] | undefined> {
    assertPlainId(session);
    try {
      const contents = await readFile(recordPath(options.projectRoot, session), "utf8");
      return contents.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    async open(session, context) {
      assertPlainId(session);
      const startedAt = Date.now();
      let count = 0;
      let stream: WriteStream | undefined;
      try {
        await mkdir(directory, { recursive: true });
        // A session can contain several serial runs. Each writer owns one run, but all of them
        // append to the same session journal so history survives a server restart.
        stream = createWriteStream(recordPath(options.projectRoot, session), { flags: "a" });
        // A write failure after the stream opens must not become an unhandled rejection that takes
        // the process with it — the run is what matters, and the record is best effort.
        stream.on("error", (error) => report(error));
      } catch (error) {
        report(error as Error);
      }

      return Object.freeze({
        append(event) {
          count += 1;
          if (stream === undefined) return;
          try {
            stream.write(`${JSON.stringify(redactRecord(event, secrets))}\n`);
          } catch (error) {
            report(error as Error);
          }
        },
        async close(state) {
          if (stream === undefined) return;
          const terminal: RecordTerminal = {
            type: "session.record",
            session,
            status: state?.status ?? "unknown",
            startedAt,
            endedAt: Date.now(),
            agent: context.agent,
            model: context.model,
            bundleDigest: context.bundleDigest,
            manifestDigest: context.manifestDigest,
            events: count
          };
          const handle = stream;
          stream = undefined;
          await new Promise<void>((done) => {
            handle.write(`${JSON.stringify(terminal)}\n`, () => handle.end(() => done()));
          });
        }
      });
    },

    async read(session) {
      const lines = await readLines(session);
      if (lines === undefined) return undefined;
      const events: WireSessionEvent[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type === "session.record") continue;
          events.push(parsed as WireSessionEvent);
        } catch {
          // A truncated final line is what a killed process leaves. Everything before it is real.
        }
      }
      return Object.freeze(events);
    },

    async summary(session) {
      const lines = await readLines(session);
      if (lines === undefined) return undefined;
      const events = await this.read(session) ?? [];
      const terminals: RecordTerminal[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as RecordTerminal & { type?: string };
          if (parsed.type === "session.record") terminals.push(parsed);
        } catch { /* A truncated trailing write is handled below. */ }
      }
      const latest = terminals.at(-1);
      const startedAt = events.length === 0 ? latest?.startedAt ?? 0 : Date.parse(events[0]!.ts) || 0;
      if (latest !== undefined) {
        return Object.freeze({
          session: latest.session,
          status: latest.status,
          startedAt,
          endedAt: latest.endedAt,
          agent: latest.agent,
          model: latest.model,
          bundleDigest: latest.bundleDigest,
          manifestDigest: latest.manifestDigest,
          events: events.length
        });
      }
      // No terminal line means the process did not finish. Say so rather than inventing an ending.
      const first = lines.find((line) => {
        try { return (JSON.parse(line) as { type?: string }).type !== "session.record"; } catch { return false; }
      });
      let incompleteStartedAt = 0;
      try {
        const timestamp = (JSON.parse(first ?? "{}") as { ts?: string }).ts;
        incompleteStartedAt = timestamp === undefined ? 0 : Date.parse(timestamp) || 0;
      } catch {
        incompleteStartedAt = 0;
      }
      return Object.freeze({ session, status: "incomplete", startedAt: incompleteStartedAt, events: events.length });
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return Object.freeze([]);
      }
      const sessions = names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -6));
      const summaries: RecordSummary[] = [];
      for (const session of sessions.sort()) {
        const found = await this.summary(session);
        if (found !== undefined) summaries.push(found);
      }
      return Object.freeze(summaries.sort((a, b) => b.startedAt - a.startedAt));
    },

    async remove(session) {
      assertPlainId(session);
      try {
        await rm(recordPath(options.projectRoot, session));
        return true;
      } catch {
        return false;
      }
    }
  });
}
