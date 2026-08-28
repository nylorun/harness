import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionJournal, redactRecord, NYLO_DIRECTORY } from "../../src/local/runtime/runtime/record-store.js";
import { createAuthoringArchive, EXCLUDED } from "../../src/local/runtime/publish/archive.js";

const STEP = {
  sessionId: "s1",
  turnNumber: 1,
  stepNumber: 1,
  transcript: [],
  toolCalls: []
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nylo-records-"));
}

describe("redaction", () => {
  it("removes a known secret value wherever it appears", () => {
    const scrubbed = redactRecord({ text: "token is sk-abcdefghijkl here" }, ["sk-abcdefghijkl"]);
    expect(JSON.stringify(scrubbed)).not.toContain("sk-abcdefghijkl");
    expect(JSON.stringify(scrubbed)).toContain("[redacted]");
  });

  it("removes credential-bearing header values by name, whatever they contain", () => {
    const scrubbed = redactRecord({ headers: { Authorization: "Bearer nothing-known", "x-api-key": "abc" } }, []);
    expect(JSON.stringify(scrubbed)).not.toContain("Bearer nothing-known");
    expect(JSON.stringify(scrubbed)).not.toContain("abc");
  });

  it("leaves a short value alone rather than shredding prose that happens to match", () => {
    expect(redactRecord({ text: "the key is up" }, ["key"])).toEqual({ text: "the key is up" });
  });
});

describe("the session journal", () => {
  it("writes one record line per append under the session directory", async () => {
    const root = await scratch();
    try {
      const journal = createSessionJournal({ projectRoot: root });
      await journal.appendRecord("s1", STEP);
      await journal.appendRecord("s1", { ...STEP, stepNumber: 2 });

      const raw = await readFile(join(root, NYLO_DIRECTORY, "s1", "record.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: "s1", turnNumber: 1, stepNumber: 1 });

      const summary = await journal.summary("s1");
      expect(summary).toMatchObject({ session: "s1", status: "incomplete", events: 0 });
      expect(await journal.readRecords("s1")).toHaveLength(2);
      expect(await journal.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes observe events to a sibling jsonl and never writes a declared secret", async () => {
    const root = await scratch();
    try {
      const journal = createSessionJournal({ projectRoot: root, redact: ["super-secret-value"] });
      await journal.appendObserve("s2", { type: "input.received", inputId: "i1", kind: "user-message" });
      await journal.appendObserve("s2", { type: "tripwire", turnId: "t1", code: "used super-secret-value", scope: "step", attributes: { message: "used super-secret-value to authenticate" } });

      const raw = await readFile(join(root, NYLO_DIRECTORY, "s2", "observe.jsonl"), "utf8");
      expect(raw).not.toContain("super-secret-value");
      expect(raw).toContain("[redacted]");
      expect(await journal.readObserve("s2")).toHaveLength(2);
      expect(await journal.summary("s2")).toMatchObject({ session: "s2", status: "failed", events: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a record it cannot write and lets the run continue", async () => {
    const errors: Error[] = [];
    const root = await scratch();
    try {
      await writeFile(join(root, ".nylo"), "not a directory");
      const journal = createSessionJournal({ projectRoot: root, onError: (error) => errors.push(error) });
      await expect(journal.appendRecord("s3", { ...STEP, sessionId: "s3" })).resolves.toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls a session without a stop event incomplete rather than inventing an ending", async () => {
    const root = await scratch();
    try {
      await mkdir(join(root, NYLO_DIRECTORY, "s4"), { recursive: true });
      await writeFile(join(root, NYLO_DIRECTORY, "s4", "observe.jsonl"), `${JSON.stringify({ type: "input.received", inputId: "i1", kind: "user-message", ts: "2026-01-01T00:00:00.000Z" })}\n`);
      expect(await journalSummary(root, "s4")).toMatchObject({ status: "incomplete", events: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a session id that is path-shaped", async () => {
    const root = await scratch();
    try {
      const journal = createSessionJournal({ projectRoot: root });
      await expect(journal.appendRecord("../escape", STEP)).rejects.toThrow(/plain name/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a session directory and says so when there was none", async () => {
    const root = await scratch();
    try {
      const journal = createSessionJournal({ projectRoot: root });
      await journal.appendRecord("s5", { ...STEP, sessionId: "s5" });
      expect(await journal.remove("s5")).toBe(true);
      expect(await journal.remove("s5")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function journalSummary(root: string, id: string): Promise<unknown> {
  return createSessionJournal({ projectRoot: root }).summary(id);
}

describe("the authoring archive", () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "nylo-archive-"));
    await mkdir(join(root, "agent"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, ".nylo"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"x"}');
    await writeFile(join(root, "agent", "agent.ts"), "export default 1;");
    await writeFile(join(root, ".env"), "OPENROUTER_API_KEY=super-secret-value");
    await writeFile(join(root, "dist", "agent.mjs"), "built");
    await writeFile(join(root, "node_modules", "junk.js"), "junk");
    await writeFile(join(root, ".nylo", "runs.jsonl"), "record");
    return root;
  }

  it("excludes what must never travel, by construction", async () => {
    const root = await fixture();
    try {
      const archive = await createAuthoringArchive(root);
      const paths = archive.entries.map((entry) => entry.path);
      expect(paths).toEqual(["agent/agent.ts", "package.json"]);
      expect(archive.excluded).toContain(".env");
      expect(Buffer.from(archive.data).toString("binary")).not.toContain("super-secret-value");
      for (const name of [".env", "dist", "node_modules", ".nylo"]) expect(EXCLUDED).toContain(name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("digests identically for the same project built twice", async () => {
    const one = await fixture();
    const two = await fixture();
    try {
      const a = await createAuthoringArchive(one);
      const b = await createAuthoringArchive(two);
      expect(a.digest).toBe(b.digest);
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });
});
