import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgent, createFileRecorder, Fetchable } from "../../src/local/runtime/index.js";
import type { BuiltAgent, ModelGatewayAdapter, ModelGatewayChunk, RuntimeOptions } from "../../src/local/runtime/index.js";

let imported = 0;
const done = (): ModelGatewayChunk => ({ type: "done", finishReason: "stop", usage: { tokensIn: 1, tokensOut: 1 } });
const scripted = (): ModelGatewayAdapter => ({ async *complete() { yield { type: "text", text: "Hello." } as const; yield done(); } });
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://local${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-fetchable-"));
  await mkdir(join(root, "agent"), { recursive: true }); await mkdir(join(root, "node_modules", "@nylorun"), { recursive: true });
  const packageRoot = new URL("../../", import.meta.url).pathname;
  await symlink(packageRoot, join(root, "node_modules", "@nylorun", "create-agent"), "dir");
  await symlink(join(packageRoot, "..", "harness"), join(root, "node_modules", "@nylorun", "harness"), "dir");
  await symlink(join(packageRoot, "node_modules", "zod"), join(root, "node_modules", "zod"), "dir").catch(() => undefined);
  await writeFile(join(root, "package.json"), '{"type":"module"}\n'); await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "vite.config.ts"), 'import { nyloAgent } from "@nylorun/create-agent/local"; export default {plugins:[nyloAgent()]};\n');
  await writeFile(join(root, "agent", "agent.ts"), 'import { Agent } from "@nylorun/harness"; import { Run } from "@nylorun/create-agent/local"; export default Run((model,directive)=>Agent(model,directive),{name:"sample",model:"anthropic/example"});\n');
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n"); expect((await buildAgent(root)).ok).toBe(true); return root;
}
async function built(root: string, host: RuntimeOptions): Promise<BuiltAgent> { const module = await import(`${pathToFileURL(join(root, "dist", "agent.mjs")).href}?t=${imported++}`) as { agent: BuiltAgent }; return module.agent.withHost(host); }

describe("Fetchable session-first HTTP surface", () => {
  it("creates one named session and returns its follow URL", async () => {
    const root = await project(); try {
      const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted() }));
      const response = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" }));
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ state: "requested", stream_url: expect.stringMatching(/^\/v1\/sessions\/.+\/stream$/) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("validates agent identity and creates idempotently", async () => {
    const root = await project(); try {
      const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted() }));
      expect((await handler(post("/v1/sessions", { agent_id: "other", message: "hi" }))).status).toBe(404);
      const first = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" }, { "idempotency-key": "k1" }));
      const retry = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" }, { "idempotency-key": "k1" }));
      expect(retry.status).toBe(200); expect((await retry.json() as { session_id: string }).session_id).toBe((await first.json() as { session_id: string }).session_id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("serves summary, bounded exclusive pages, and Last-Event-ID SSE", async () => {
    const root = await project(); try {
      const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted() }));
      const created = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" })); const id = (await created.json() as { session_id: string }).session_id;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const summary = await handler(new Request(`http://local/v1/sessions/${id}`)); expect(summary.status).toBe(200);
      const page = await handler(new Request(`http://local/v1/sessions/${id}/events?after=0&limit=1`)); const data = await page.json() as { events: unknown[]; next_cursor: number };
      expect(page.status).toBe(200); expect(data.events.length).toBeLessThanOrEqual(1);
      const stream = await handler(new Request(`http://local/v1/sessions/${id}/stream`, { headers: { "Last-Event-ID": String(data.next_cursor) } })); expect(stream.headers.get("content-type")).toContain("text/event-stream");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("allows explicit Studio origins for REST, SSE, and preflight without browser credentials", async () => {
    const root = await project(); try {
      const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted() }), { cors: { allowedOrigins: ["http://nylo.run.localhost:4113"] } });
      const preflight = await handler(new Request("http://local/v1/sessions", { method: "OPTIONS", headers: { origin: "http://nylo.run.localhost:4113", "access-control-request-method": "POST", "access-control-request-headers": "content-type, idempotency-key" } }));
      expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe("http://nylo.run.localhost:4113"); expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
      const created = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" }, { origin: "http://nylo.run.localhost:4113" }));
      const id = (await created.json() as { session_id: string }).session_id; expect(created.headers.get("access-control-allow-origin")).toBe("http://nylo.run.localhost:4113");
      const stream = await handler(new Request(`http://local/v1/sessions/${id}/stream`, { headers: { origin: "http://nylo.run.localhost:4113" } }));
      expect(stream.headers.get("access-control-allow-origin")).toBe("http://nylo.run.localhost:4113"); expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const denied = await handler(post("/v1/sessions", { agent_id: "sample", message: "hi" }, { origin: "https://other.example" }));
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects wildcard CORS configuration", async () => {
    const root = await project(); try { const agent = await built(root, { modelGatewayAdapter: scripted() }); expect(() => Fetchable(agent, { cors: { allowedOrigins: ["*"] } })).toThrow("wildcard"); } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("serves Studio metadata, durable session history, and live AG-UI SSE", async () => {
    const root = await project(); try {
      const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted(), recorder: createFileRecorder({ projectRoot: root }) }));
      const agent = await handler(new Request("http://local/v1/agent"));
      expect(agent.status).toBe(200); expect(await agent.json()).toMatchObject({ protocolVersion: 1, agUiUrl: "/v1/ag-ui", sessionRecords: { path: ".nylo/runs" }, harness: { model: { id: "anthropic/example" }, middleware: [{ id: "nylorun-folder" }], adapters: [{ id: "runtime-local" }] } });
      const session = "studio-session";
      const first = await handler(post("/v1/ag-ui", { threadId: session, runId: "run-1", messages: [{ id: "m1", role: "user", content: "hello" }] }));
      expect(first.status).toBe(200); expect(await first.text()).toContain("RUN_STARTED");
      const second = await handler(post("/v1/ag-ui", { threadId: session, runId: "run-2", messages: [{ id: "m2", role: "user", content: "again" }] }));
      const secondWire = await second.text();
      expect(secondWire).toContain("RUN_FINISHED"); expect((secondWire.match(/TEXT_MESSAGE_START/g) ?? []).length).toBe(1);
      const history = await handler(new Request(`http://local/v1/ag-ui/sessions/${session}`));
      expect(await history.json()).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: "hello" }), expect.objectContaining({ role: "user", content: "again" })]) });
      const list = await handler(new Request("http://local/v1/sessions"));
      expect(await list.json()).toMatchObject({ sessions: [expect.objectContaining({ session, events: expect.any(Number) })] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects the legacy dialect", async () => {
    const root = await project(); try { const handler = Fetchable(await built(root, { modelGatewayAdapter: scripted() })); expect((await handler(post("/a/sample/sessions", { input: "hi" }))).status).toBe(404); } finally { await rm(root, { recursive: true, force: true }); }
  });
});
