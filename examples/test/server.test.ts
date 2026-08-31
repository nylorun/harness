import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { model } from "@nylorun/harness";
import { createAgentServer } from "../server/server.js";

const deterministic = model(async (call) => {
  const user = call.prompt.find((item) => item.kind === "message" && item.role === "user");
  const text = user?.content.find((part) => part.type === "text")?.text ?? "";
  if (call.prompt.some((item) => item.kind === "tool-result"))
    return { output: [{ type: "text", text: "Done." }], finishReason: "stop" as const };
  if (/save/i.test(text))
    return {
      output: [
        { type: "tool-call", id: "note-1", name: "write_note", args: { text: "verified note" } },
      ],
      finishReason: "tool-calls" as const,
    };
  return {
    output: [{ type: "tool-call", id: "calc-1", name: "calculate", args: { expression: "2 + 2" } }],
    finishReason: "tool-calls" as const,
  };
});

describe("multi-agent Hono host", () => {
  it("discovers manifests and projects a tool call, result, and final answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-agent-test-"));
    const runtime = await createAgentServer({
      root,
      adapter: deterministic,
      provider: "test",
      model: "deterministic",
    });
    try {
      const discovery = await runtime.app.request("http://local/v1/agents");
      await expect(discovery.json()).resolves.toMatchObject({
        protocolVersion: 1,
        agents: expect.arrayContaining([
          expect.objectContaining({ id: "inprocess-tools" }),
          expect.objectContaining({ id: "mcp" }),
        ]),
      });
      const response = await runtime.app.request("http://local/agents/inprocess-tools/v1/ag-ui", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://nylo.run.localhost:4161",
        },
        body: JSON.stringify({
          threadId: "calculator",
          runId: "run",
          messages: [{ role: "user", content: "calculate two plus two" }],
        }),
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://nylo.run.localhost:4161",
      );
      const body = await response.text();
      const projectedEvents = body
        .trim()
        .split("\n\n")
        .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
      expect(body).toContain("TOOL_CALL_START");
      expect(body).toContain("TOOL_CALL_RESULT");
      expect(body).toContain("TEXT_MESSAGE_CONTENT");
      expect(body).toContain("Done.");
      expect(projectedEvents.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({
        messageId: expect.any(String),
        toolCallId: "calc-1",
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires approval before persisting an in-process note", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-agent-test-"));
    const runtime = await createAgentServer({
      root,
      adapter: deterministic,
      provider: "test",
      model: "deterministic",
    });
    try {
      await runtime.app.request("http://local/agents/inprocess-tools/v1/ag-ui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "notes",
          runId: "run",
          messages: [{ role: "user", content: "save a note" }],
        }),
      });
      const waiting = await runtime.app.request(
        "http://local/agents/inprocess-tools/v1/sessions/notes",
      );
      const state = (await waiting.json()) as { pending_interaction?: { id: string } };
      expect(state.pending_interaction?.id).toBeTruthy();
      await runtime.app.request("http://local/agents/inprocess-tools/v1/sessions/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interaction: { id: state.pending_interaction!.id, kind: "approval", approved: true },
        }),
      });
      await expect(
        readFile(join(root, ".data", "inprocess-tools", "notes.jsonl"), "utf8"),
      ).resolves.toContain("verified note");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
