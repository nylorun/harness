import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WireSessionEvent } from "../../src/local/runtime/index.js";
import { createFileRecorder, redactRecord, RECORDS_DIRECTORY } from "../../src/local/runtime/runtime/record-store.js";
import { createAuthoringArchive, EXCLUDED } from "../../src/local/runtime/publish/archive.js";

const CONTEXT = { agent: "sample", model: "openai/gpt-4o-mini", bundleDigest: "bbb", manifestDigest: "mmm" };

function event(seq: number, type: string, payload: unknown = {}): WireSessionEvent {
  return { session: "s1", seq, ts: new Date(1000 + seq).toISOString(), type, payload } as WireSessionEvent;
}

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

describe("the file recorder", () => {
  it("writes one event per line and closes with a terminal summary", async () => {
    const root = await scratch();
    try {
      const recorder = createFileRecorder({ projectRoot: root });
      const writer = await recorder.open("s1", CONTEXT);
      writer.append(event(0, "session.started"));
      writer.append(event(1, "session.ended"));
      await writer.close({ status: "completed" } as never);

      const raw = await readFile(join(root, RECORDS_DIRECTORY, "s1.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(3);

      const summary = await recorder.summary("s1");
      expect(summary).toMatchObject({ session: "s1", status: "completed", events: 2, bundleDigest: "bbb" });
      expect(await recorder.read("s1")).toHaveLength(2);
      expect(await recorder.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never writes a declared secret value", async () => {
    const root = await scratch();
    try {
      const recorder = createFileRecorder({ projectRoot: root, redact: ["super-secret-value"] });
      const writer = await recorder.open("s2", CONTEXT);
      writer.append(event(0, "tool.call", { output: "used super-secret-value to authenticate" }));
      await writer.close({ status: "completed" } as never);
      const raw = await readFile(join(root, RECORDS_DIRECTORY, "s2.jsonl"), "utf8");
      expect(raw).not.toContain("super-secret-value");
      expect(raw).toContain("[redacted]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a record it cannot write and lets the run continue", async () => {
    const errors: Error[] = [];
    // A path whose parent is a file cannot become a directory, which is the cheapest real failure.
    const root = await scratch();
    try {
      await writeFile(join(root, ".nylo"), "not a directory");
      const recorder = createFileRecorder({ projectRoot: root, onError: (error) => errors.push(error) });
      const writer = await recorder.open("s3", CONTEXT);
      expect(() => writer.append(event(0, "session.started"))).not.toThrow();
      await expect(writer.close({ status: "completed" } as never)).resolves.toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls an unfinished record incomplete rather than inventing an ending", async () => {
    const root = await scratch();
    try {
      await mkdir(join(root, RECORDS_DIRECTORY), { recursive: true });
      await writeFile(join(root, RECORDS_DIRECTORY, "s4.jsonl"), `${JSON.stringify(event(0, "session.started"))}\n`);
      expect(await recorderSummary(root, "s4")).toMatchObject({ status: "incomplete", events: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a session id that is path-shaped", async () => {
    const root = await scratch();
    try {
      const recorder = createFileRecorder({ projectRoot: root });
      await expect(recorder.open("../escape", CONTEXT)).rejects.toThrow(/plain name/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a record and says so when there was none", async () => {
    const root = await scratch();
    try {
      const recorder = createFileRecorder({ projectRoot: root });
      const writer = await recorder.open("s5", CONTEXT);
      await writer.close(undefined);
      expect(await recorder.remove("s5")).toBe(true);
      expect(await recorder.remove("s5")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function recorderSummary(root: string, id: string): Promise<unknown> {
  return createFileRecorder({ projectRoot: root }).summary(id);
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
      // A second directory, created later, with different inode times and a different path.
      const b = await createAuthoringArchive(two);
      expect(a.digest).toBe(b.digest);
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });
});
