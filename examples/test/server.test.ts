import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { model } from "@nylorun/harness";
import { createAgentServer } from "../server/server.js";
import { exampleInstructions } from "../agents/types.js";
import { MAX_IMAGE_BYTES } from "../services/media.js";
import type { ImageEditor } from "../services/openai-image.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const encodedPng = Buffer.from(png).toString("base64");

const deterministic = model(async (call) => {
  const user = call.prompt.find(
    (item) => item.kind === "message" && item.role === "user",
  );
  const text = user?.content.find((part) => part.type === "text")?.text ?? "";
  if (call.prompt.some((item) => item.kind === "tool-result"))
    return {
      output: [{ type: "text", text: "Done." }],
      finishReason: "stop" as const,
    };
  if (/save/i.test(text))
    return {
      output: [
        {
          type: "tool-call",
          id: "note-1",
          name: "write_note",
          args: { text: "verified note" },
        },
      ],
      finishReason: "tool-calls" as const,
    };
  return {
    output: [
      {
        type: "tool-call",
        id: "calc-1",
        name: "calculate",
        args: { expression: "2 + 2" },
      },
    ],
    finishReason: "tool-calls" as const,
  };
});

const interiorModel = model(async (call) => {
  if (call.prompt.some((item) => item.kind === "tool-result"))
    return {
      output: [
        { type: "text", text: "Your room is now warm modern Scandinavian." },
      ],
    };
  return {
    output: [
      {
        type: "tool-call",
        id: "redesign-1",
        name: "reimagine_interior",
        args: { theme: "warm modern Scandinavian" },
      },
    ],
    finishReason: "tool-calls" as const,
  };
});

describe("multi-agent Hono host", () => {
  it("exposes harness identity and static middleware surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-manifest-test-"));
    const runtime = await createAgentServer({
      root,
      adapter: deterministic,
      provider: "test",
      model: "deterministic",
    });
    try {
      const response = await runtime.app.request(
        "http://local/agents/interactions/manifest.json",
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        protocolVersion: 1,
        id: "interactions",
        name: "Interactions",
        mediaInput: {
          acceptedTypes: ["image/jpeg", "image/png", "image/webp"],
          maxBytes: MAX_IMAGE_BYTES,
        },
        harness: {
          manifest: {
            id: "interactions",
            name: "Interactions",
            middleware: [
              { id: "agent", instructions: [exampleInstructions] },
              {
                id: "model",
                model: {
                  id: "test/deterministic",
                  controls: { temperature: 0.1 },
                },
              },
              {
                id: "notes",
                instructions: [
                  "Use write_note only when the user asks to save a note. A human approval is required before the write.",
                ],
                tools: [
                  {
                    name: "read_notes",
                    description: "Read the most recent locally stored notes.",
                  },
                  {
                    name: "write_note",
                    description:
                      "Write a local JSONL note after the user approves.",
                  },
                ],
              },
              {
                id: "ask-user",
                instructions: [
                  "Use ask_user when you need a short fact from the human before continuing.",
                ],
                tools: [
                  {
                    name: "ask_user",
                    description:
                      "Ask the human a question and wait for their reply.",
                  },
                ],
              },
              { id: "review-writes" },
            ],
          },
        },
      });
      expect(body).not.toHaveProperty("description");
      expect(body).not.toHaveProperty("capabilities");
      expect(body).not.toHaveProperty("model");
      expect(body).not.toHaveProperty("records");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
          expect.objectContaining({ id: "tool-use" }),
          expect.objectContaining({ id: "interactions" }),
          expect.objectContaining({ id: "mcp" }),
        ]),
      });
      const response = await runtime.app.request(
        "http://local/agents/tool-use/v1/ag-ui",
        {
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
        },
      );
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://nylo.run.localhost:4161",
      );
      const body = await response.text();
      const projectedEvents = body
        .trim()
        .split("\n\n")
        .map(
          (frame) =>
            JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>,
        );
      expect(body).toContain("TOOL_CALL_START");
      expect(body).toContain("TOOL_CALL_RESULT");
      expect(body).toContain("TEXT_MESSAGE_CONTENT");
      expect(body).toContain("Done.");
      expect(
        projectedEvents.find((event) => event.type === "TOOL_CALL_RESULT"),
      ).toMatchObject({
        messageId: expect.any(String),
        toolCallId: "calc-1",
      });
      const listed = await runtime.app.request(
        "http://local/agents/tool-use/v1/sessions",
      );
      await expect(listed.json()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({
            session: "calculator",
            title: "calculate two plus two",
            status: "idle",
          }),
        ]),
      });
      const eventsResponse = await runtime.app.request(
        "http://local/agents/tool-use/v1/sessions/calculator/events",
      );
      const events = (await eventsResponse.json()) as {
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      };
      const requests = events.events.filter(
        (event) => event.type === "model.requested",
      );
      expect(requests).toHaveLength(2);
      const digests = requests.map(
        (event) => event.payload.digests as Record<string, string>,
      );
      expect(digests).toEqual([
        {
          prompt: expect.stringMatching(/^[a-f0-9]{64}$/u),
          tools: expect.stringMatching(/^[a-f0-9]{64}$/u),
          model: expect.stringMatching(/^[a-f0-9]{64}$/u),
          output: expect.stringMatching(/^[a-f0-9]{64}$/u),
          configuration: expect.stringMatching(/^[a-f0-9]{64}$/u),
          context: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          prompt: expect.stringMatching(/^[a-f0-9]{64}$/u),
          tools: expect.stringMatching(/^[a-f0-9]{64}$/u),
          model: expect.stringMatching(/^[a-f0-9]{64}$/u),
          output: expect.stringMatching(/^[a-f0-9]{64}$/u),
          configuration: expect.stringMatching(/^[a-f0-9]{64}$/u),
          context: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ]);
      expect(digests[0]?.prompt).not.toBe(digests[1]?.prompt);
      expect(digests[0]?.tools).toBe(digests[1]?.tools);
      expect(digests[0]?.output).toBe(digests[1]?.output);
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
      await runtime.app.request("http://local/agents/interactions/v1/ag-ui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "notes",
          runId: "run",
          messages: [{ role: "user", content: "save a note" }],
        }),
      });
      const waiting = await runtime.app.request(
        "http://local/agents/interactions/v1/sessions/notes",
      );
      const state = (await waiting.json()) as {
        pending_interaction?: { id: string };
      };
      expect(state.pending_interaction?.id).toBeTruthy();
      const listed = await runtime.app.request(
        "http://local/agents/interactions/v1/sessions",
      );
      await expect(listed.json()).resolves.toMatchObject({
        sessions: expect.arrayContaining([
          expect.objectContaining({
            session: "notes",
            title: "save a note",
            status: "waiting",
          }),
        ]),
      });
      await runtime.app.request(
        "http://local/agents/interactions/v1/sessions/notes",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            interaction: {
              id: state.pending_interaction!.id,
              kind: "approval",
              approved: true,
            },
          }),
        },
      );
      await expect(
        readFile(join(root, ".data", "interactions", "notes.jsonl"), "utf8"),
      ).resolves.toContain("verified note");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an AG-UI image, preserves Harness media input, and persists an edited result", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-media-test-"));
    const calls: Array<{ mediaType: string; prompt: string }> = [];
    const imageEditor: ImageEditor = {
      async edit(request) {
        calls.push({ mediaType: request.mediaType, prompt: request.prompt });
        return {
          bytes: png,
          mediaType: "image/png",
        };
      },
    };
    const runtime = await createAgentServer({
      root,
      adapter: interiorModel,
      provider: "test",
      model: "vision-test",
      imageEditor,
    });
    try {
      const response = await runtime.app.request(
        "http://local/agents/interior-design/v1/ag-ui",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "room",
            runId: "redesign",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Make this warm modern Scandinavian." },
                  {
                    type: "image",
                    source: {
                      type: "data",
                      value: encodedPng,
                      mimeType: "image/png",
                    },
                  },
                ],
              },
            ],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        expect.objectContaining({
          mediaType: "image/png",
          prompt: expect.stringContaining("warm modern Scandinavian"),
        }),
      ]);
      const eventsResponse = await runtime.app.request(
        "http://local/agents/interior-design/v1/sessions/room/events",
      );
      const events = (await eventsResponse.json()) as {
        events: Array<{ type: string; payload: Record<string, any> }>;
      };
      const requested = events.events.find(
        (event) => event.type === "model.requested",
      );
      const prompt = requested?.payload.attributes.call.prompt as Array<{
        kind: string;
        content: Array<Record<string, any>>;
      }>;
      expect(prompt.find((item) => item.kind === "message")?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "media",
            mediaType: "image/png",
            reference: expect.objectContaining({
              agentId: "interior-design",
              assetId: expect.any(String),
            }),
          }),
        ]),
      );
      const journal = await readFile(
        join(
          root,
          ".data",
          "sessions",
          "interior-design",
          "room",
          "events.jsonl",
        ),
        "utf8",
      );
      expect(journal).not.toContain(encodedPng);
      expect(journal).not.toContain("data:image/");
      const completed = events.events.find(
        (event) =>
          event.type === "tool.completed" &&
          event.payload.toolName === "reimagine_interior",
      );
      const assetId = completed?.payload.attributes.output.image.id;
      const image = await runtime.app.request(
        `http://local/agents/interior-design/v1/media/room/${assetId}`,
      );
      expect(image.headers.get("content-type")).toBe("image/png");
      await expect(image.arrayBuffer()).resolves.toHaveProperty(
        "byteLength",
        png.byteLength,
      );
      const history = await runtime.app.request(
        "http://local/agents/interior-design/v1/ag-ui/sessions/room",
      );
      await expect(history.json()).resolves.toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "image" }),
            ]),
          }),
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "image" }),
            ]),
          }),
        ]),
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported and oversized AG-UI images", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-media-validation-test-"));
    const runtime = await createAgentServer({
      root,
      adapter: deterministic,
      provider: "test",
      model: "test",
    });
    try {
      const unsupported = await runtime.app.request(
        "http://local/agents/instructions/v1/ag-ui",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "data",
                      value: "aGVsbG8=",
                      mimeType: "image/gif",
                    },
                  },
                ],
              },
            ],
          }),
        },
      );
      expect(unsupported.status).toBe(400);
      const oversized = await runtime.app.request(
        "http://local/agents/instructions/v1/ag-ui",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "data",
                      value: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString(
                        "base64",
                      ),
                      mimeType: "image/png",
                    },
                  },
                ],
              },
            ],
          }),
        },
      );
      expect(oversized.status).toBe(400);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
