import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  sessionSummary,
  type ManagedSessionStore,
  type StoredSession,
} from "../sessions/store.js";

/** Single-owner local disk store. No lease stealing, replay, or shared-filesystem guarantee. */
export function localSessions(options: { root: string }): ManagedSessionStore {
  let closed = false;
  let directory: string;
  const token = randomUUID();
  const acquired = (async () => {
    await mkdir(resolve(options.root), { recursive: true, mode: 0o700 });
    directory = await realpath(resolve(options.root));
    const path = join(directory, ".owner.lock");
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (cause) {
      throw new Error(
        `Session store ${directory} already has an owner. Stop the owner before opening it again. After a crash, confirm it has stopped and manually remove .owner.lock.`,
        { cause },
      );
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  })();
  void acquired.catch(() => {});
  let operations = Promise.resolve();
  const check = async () => {
    await acquired;
    if (closed) throw new Error("Session store is closed");
    const owner = JSON.parse(
      await readFile(join(directory, ".owner.lock"), "utf8"),
    );
    if (owner.token !== token)
      throw new Error(
        "Session store ownership was lost; refusing further writes",
      );
  };
  const pathFor = (agentId: string, sessionId: string) =>
    join(directory, safe(agentId), `${safe(sessionId)}.json`);
  const get = async (
    agentId: string,
    sessionId: string,
  ): Promise<StoredSession | undefined> => {
    await check();
    try {
      const value = JSON.parse(
        await readFile(pathFor(agentId, sessionId), "utf8"),
      ) as StoredSession;
      if (
        value.version !== 1 ||
        value.id !== sessionId ||
        value.agentId !== agentId ||
        !Array.isArray(value.events)
      )
        throw new Error("Invalid stored session document");
      return value;
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        const contents = await readFile(
          join(directory, safe(agentId), safe(sessionId), "events.jsonl"),
          "utf8",
        );
        const events = contents
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return {
          version: 1,
          id: sessionId,
          agentId,
          status: "archived",
          startedAt: events[0] ? Date.parse(events[0].ts) : 0,
          updatedAt: 0,
          events,
        };
      } catch (legacyError) {
        if (isMissing(legacyError)) return undefined;
        throw legacyError;
      }
    }
  };
  return {
    get,
    put(agentId, sessionId, session) {
      const contents = JSON.stringify(session);
      const operation = operations.then(async () => {
        await check();
        if (session.id !== sessionId || session.agentId !== agentId)
          throw new Error("Session identity mismatch");
        const target = pathFor(agentId, sessionId);
        await mkdir(join(directory, safe(agentId)), {
          recursive: true,
          mode: 0o700,
        });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(contents);
            await file.sync();
          } finally {
            await file.close();
          }
          await check();
          await rename(temporary, target);
          const parent = await open(join(directory, safe(agentId)), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await rm(temporary, { force: true });
        }
      });
      operations = operation.catch(() => {});
      return operation;
    },
    async list(agentId) {
      await check();
      let names;
      try {
        names = await readdir(join(directory, safe(agentId)), {
          withFileTypes: true,
        });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const sessions = await Promise.all(
        names
          .filter((item) => item.isDirectory() || item.name.endsWith(".json"))
          .map((item) =>
            get(
              agentId,
              item.isDirectory() ? item.name : item.name.slice(0, -5),
            ),
          ),
      );
      return sessions
        .flatMap((session) => (session ? [sessionSummary(session)] : []))
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    async close() {
      await operations;
      if (closed) return;
      await check();
      closed = true;
      await rm(join(directory, ".owner.lock"));
    },
  };
}
function safe(value: string): string {
  if (value === "." || value === ".." || !/^[a-zA-Z0-9._-]+$/.test(value))
    throw new Error("Invalid session path identifier");
  return value;
}
function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
