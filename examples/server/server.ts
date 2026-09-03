import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import type {
  JsonValue,
  MessageInput,
  ModelAdapter,
  ObserveEvent,
  Session,
  ToolResult,
  UserContentPart,
} from "@nylorun/harness";
import { agUiEvents, sse } from "./ag-ui.js";
import { observedPayload } from "./digests.js";
import { createRegistry } from "./registry.js";
import { JsonlJournal, type CanonicalEvent } from "../services/journal.js";
import type { ExampleAgent } from "../agents/types.js";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MediaStore,
  type MediaAsset,
} from "../services/media.js";
import type { ImageEditor } from "../services/openai-image.js";

type Live = {
  session: Session;
  events: CanonicalEvent[];
  messages: ChatMessage[];
  status: "running" | "waiting" | "completed" | "failed";
  sequence: number;
};

type ChatContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly url: string; readonly mediaType: string }
  | { readonly type: "json"; readonly value: JsonValue };
type ChatMessage = {
  readonly id: string;
  readonly role: string;
  readonly content: readonly ChatContent[];
};
type IncomingMessage = Readonly<{ input: MessageInput; chat: ChatMessage }>;

export async function createAgentServer(
  options: Readonly<{
    root?: string;
    origins?: readonly string[];
    adapter?: ModelAdapter;
    provider?: string;
    model?: string;
    imageEditor?: ImageEditor;
  }> = {},
) {
  const root = options.root ?? process.cwd();
  const override =
    options.adapter === undefined
      ? undefined
      : {
          adapter: options.adapter,
          provider: options.provider ?? "test",
          model: options.model ?? "test-model",
        };
  const media = new MediaStore(resolve(root, ".data", "media"));
  const agents = await createRegistry(root, override, {
    media,
    ...(options.imageEditor ? { imageEditor: options.imageEditor } : {}),
  });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const journal = new JsonlJournal(
    resolve(root, ".data", "sessions"),
    secrets(),
  );
  const live = new Map<string, Live>();
  const app = new Hono();

  app.use("*", async (context, next) => {
    const origin = context.req.header("origin");
    if (origin && permitted(origin, options.origins ?? [])) {
      context.header("access-control-allow-origin", origin);
      context.header("access-control-allow-headers", "content-type");
      context.header("access-control-allow-methods", "GET, POST, OPTIONS");
      context.header("vary", "origin");
    }
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  });

  app.get("/v1/agents", (context) =>
    context.json({
      protocolVersion: 1,
      agents: agents.map((agent) => ({
        id: agent.id,
        manifestUrl: `/agents/${agent.id}/manifest.json`,
      })),
    }),
  );

  app.get("/agents/:agentId/manifest.json", (context) => {
    const agent = byId.get(context.req.param("agentId"));
    return agent === undefined
      ? context.json({ error: "unknown agent" }, 404)
      : context.json(manifest(agent));
  });

  app.get("/agents/:agentId/v1/media/:session/:assetId", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const asset = await media.read(
      agent.id,
      context.req.param("session"),
      context.req.param("assetId"),
    );
    if (!asset) return context.json({ error: "unknown media asset" }, 404);
    context.header("cache-control", "no-store");
    return context.body(asset.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": asset.asset.mediaType,
    });
  });

  app.get("/agents/:agentId/v1/sessions", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (agent === undefined)
      return context.json({ error: "unknown agent" }, 404);
    const listed = await journal.list(agent.id);
    return context.json({
      sessions: listed.map((summary) => {
        const found = live.get(keyOf(agent.id, summary.session));
        if (found?.status === "running")
          return { ...summary, status: "running" as const };
        if (found?.status === "waiting")
          return { ...summary, status: "waiting" as const };
        return summary;
      }),
    });
  });

  app.get("/agents/:agentId/v1/sessions/:session", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const key = keyOf(agent.id, context.req.param("session"));
    const found = live.get(key);
    const events =
      found?.events ??
      (await journal.events(agent.id, context.req.param("session")));
    if (!found && events.length === 0)
      return context.json({ error: "unknown session" }, 404);
    return context.json({
      id: context.req.param("session"),
      state: found?.status ?? status(events),
      pending_interaction: pending(events),
    });
  });

  app.post("/agents/:agentId/v1/sessions/:session", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const found = live.get(keyOf(agent.id, context.req.param("session")));
    if (!found)
      return context.json({ error: "session is no longer live" }, 409);
    const payload = await context.req
      .json<Record<string, unknown>>()
      .catch(() => undefined);
    const interaction = payload?.interaction as
      Record<string, unknown> | undefined;
    if (!interaction || typeof interaction.id !== "string")
      return context.json({ error: "expected interaction" }, 400);
    if (interaction.kind === "approval") {
      if (typeof interaction.approved !== "boolean")
        return context.json({ error: "expected approval interaction" }, 400);
      found.status = "running";
      await found.session.input({
        kind: "approve",
        interactionId: interaction.id,
        approved: interaction.approved,
      }).completed;
      return context.json(
        { session_id: context.req.param("session"), state: found.status },
        202,
      );
    }
    if (interaction.kind === "respond") {
      if (!("value" in interaction))
        return context.json({ error: "expected respond interaction" }, 400);
      found.status = "running";
      await found.session.input({
        kind: "respond",
        interactionId: interaction.id,
        value: interaction.value as never,
      }).completed;
      return context.json(
        { session_id: context.req.param("session"), state: found.status },
        202,
      );
    }
    return context.json(
      { error: "expected approval or respond interaction" },
      400,
    );
  });

  app.get("/agents/:agentId/v1/sessions/:session/events", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const after = Number(context.req.query("after") ?? "0");
    const session = context.req.param("session");
    const events =
      live.get(keyOf(agent.id, session))?.events ??
      (await journal.events(agent.id, session));
    return context.json({
      events: events.filter((event) => event.seq > after),
      next_cursor: events.at(-1)?.seq ?? after,
    });
  });

  app.get("/agents/:agentId/v1/ag-ui/sessions/:session", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const found = live.get(keyOf(agent.id, context.req.param("session")));
    return context.json({
      messages:
        found?.messages ??
        messages(
          agent.id,
          await journal.events(agent.id, context.req.param("session")),
        ),
    });
  });

  app.post("/agents/:agentId/v1/ag-ui", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const payload = await context.req
      .json<Record<string, unknown>>()
      .catch(() => undefined);
    const threadId =
      typeof payload?.threadId === "string" && payload.threadId
        ? payload.threadId
        : randomUUID();
    const runId =
      typeof payload?.runId === "string" && payload.runId
        ? payload.runId
        : randomUUID();
    let message: IncomingMessage;
    try {
      message = await latestMessage(
        payload?.messages,
        media,
        agent.id,
        threadId,
      );
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid AG-UI user message",
        },
        400,
      );
    }
    const found = await begin(agent, threadId, message);
    const start = found.events.length;
    await found.session.input(message.input).completed;
    await waitForProjectedEvents(found);
    return sse(
      agUiEvents(found.events.slice(start), threadId, runId),
      context.res.headers,
    );
  });

  function requireAgent(id: string): ExampleAgent | undefined {
    return byId.get(id);
  }

  async function begin(
    agent: ExampleAgent,
    sessionId: string,
    message: IncomingMessage,
  ): Promise<Live> {
    const key = keyOf(agent.id, sessionId);
    const existing = live.get(key);
    if (existing) {
      existing.messages.push(message.chat);
      return existing;
    }
    const session = agent.agent.run({ id: sessionId });
    const entry: Live = {
      session,
      events: [],
      messages: [message.chat],
      status: "running",
      sequence: 0,
    };
    live.set(key, entry);

    const add = async (type: string, payload: Record<string, unknown>) => {
      const event: CanonicalEvent = {
        session: sessionId,
        seq: ++entry.sequence,
        ts: new Date().toISOString(),
        type,
        payload,
      };
      entry.events.push(event);
      await journal.append(agent.id, event);
    };

    session.observe((event: ObserveEvent) => {
      const image = generatedImageMessage(event, agent.id, sessionId);
      if (image) entry.messages.push(image);
      void add(event.type, observedPayload(event));
    });

    void (async () => {
      for await (const event of session.stream()) {
        if (event.type === "final") {
          entry.status = "completed";
          entry.messages.push({
            id: randomUUID(),
            role: "assistant",
            content: finalContent(event.output),
          });
          await add("final", { output: event.output });
        } else if (event.type === "interaction.required") {
          entry.status = "waiting";
          await add("interaction.required", { interaction: event.interaction });
        } else if (event.type === "input") {
          const message = chatFromInput(event.event, agent.id, sessionId);
          await add("session.run.started", {
            input_kind: event.event.kind,
            input:
              message === undefined
                ? "text" in event.event
                  ? event.event.text
                  : undefined
                : firstText(message),
            ...(message === undefined ? {} : { message }),
            approved:
              "approved" in event.event ? event.event.approved : undefined,
            value: "value" in event.event ? event.event.value : undefined,
          });
        }
      }
    })();

    return entry;
  }

  return Object.freeze({
    app,
    hasSession: (agentId: string, sessionId: string) =>
      live.has(keyOf(agentId, sessionId)),
    close: async () => {
      await Promise.all(agents.map((agent) => agent.close?.()));
    },
  });
}

function manifest(agent: ExampleAgent) {
  return {
    protocolVersion: 1,
    id: agent.agent.manifest.id,
    name: agent.agent.manifest.name,
    harness: { manifest: agent.agent.manifest },
    endpoints: {
      agUi: `/agents/${agent.id}/v1/ag-ui`,
      sessions: `/agents/${agent.id}/v1/sessions`,
    },
    mediaInput: { acceptedTypes: IMAGE_MEDIA_TYPES, maxBytes: MAX_IMAGE_BYTES },
  };
}

function keyOf(agent: string, session: string): string {
  return `${agent}:${session}`;
}

async function latestMessage(
  value: unknown,
  media: MediaStore,
  agentId: string,
  sessionId: string,
): Promise<IncomingMessage> {
  if (!Array.isArray(value)) throw new Error("AG-UI requires a user message.");
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i] as Record<string, unknown>;
    if (item?.role !== "user") continue;
    const content = await incomingContent(
      item.content,
      media,
      agentId,
      sessionId,
    );
    if (content) return content;
  }
  throw new Error("AG-UI requires a non-empty user message.");
}

function pending(events: readonly CanonicalEvent[]): unknown {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "interaction.required")
      return events[i]!.payload.interaction;
    if (events[i]!.type === "final") return undefined;
  }
  return undefined;
}

function status(events: readonly CanonicalEvent[]): string {
  return events.some((event) => event.type === "final")
    ? "completed"
    : pending(events)
      ? "waiting"
      : "incomplete";
}

function messages(
  agentId: string,
  events: readonly CanonicalEvent[],
): ChatMessage[] {
  return events.flatMap((event) =>
    event.type === "final" && "output" in event.payload
      ? [
          {
            id: String(event.seq),
            role: "assistant",
            content: finalContent(event.payload.output as JsonValue),
          },
        ]
      : event.type === "session.run.started" &&
          isChatMessage(event.payload.message)
        ? [
            {
              ...event.payload.message,
              id: String(event.seq),
            },
          ]
        : generatedImageFromEvent(event, agentId)
          ? [generatedImageFromEvent(event, agentId)!]
          : [],
  );
}

async function incomingContent(
  value: unknown,
  media: MediaStore,
  agentId: string,
  sessionId: string,
): Promise<IncomingMessage | undefined> {
  const parts: UserContentPart[] = [];
  const chat: ChatContent[] = [];
  if (typeof value === "string") {
    if (value.trim() === "") return undefined;
    parts.push({ type: "text", text: value });
    chat.push({ type: "text", text: value });
  } else if (Array.isArray(value)) {
    let images = 0;
    for (const raw of value) {
      const part = raw as Record<string, unknown>;
      if (part?.type === "text" && typeof part.text === "string") {
        if (part.text !== "") {
          parts.push({ type: "text", text: part.text });
          chat.push({ type: "text", text: part.text });
        }
        continue;
      }
      if (part?.type !== "image")
        throw new Error("Only text and image inputs are supported.");
      if (++images > 1) throw new Error("Attach only one image per message.");
      const source = part.source as Record<string, unknown> | undefined;
      if (
        !source ||
        source.type !== "data" ||
        typeof source.value !== "string" ||
        typeof source.mimeType !== "string"
      )
        throw new Error(
          "Image input must contain base64 data and a media type.",
        );
      const asset = await media.saveInput(
        agentId,
        sessionId,
        source.mimeType,
        source.value,
      );
      parts.push({
        type: "media",
        mediaType: asset.mediaType,
        reference: { agentId, assetId: asset.id },
      });
      chat.push({
        type: "image",
        url: mediaUrl(agentId, sessionId, asset.id),
        mediaType: asset.mediaType,
      });
    }
  } else return undefined;
  if (parts.length === 0) return undefined;
  return Object.freeze({
    input: { content: Object.freeze(parts) },
    chat: { id: randomUUID(), role: "user", content: Object.freeze(chat) },
  });
}

function chatFromInput(
  event: {
    readonly kind: string;
    readonly text?: string;
    readonly content?: readonly UserContentPart[];
  },
  agentId: string,
  sessionId: string,
): ChatMessage | undefined {
  if (event.kind !== "user-message") return undefined;
  if (typeof event.text === "string")
    return {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: event.text }],
    };
  if (!event.content) return undefined;
  const content = event.content.flatMap((part): ChatContent[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    const reference = part.reference as { assetId?: unknown };
    return typeof reference.assetId === "string"
      ? [
          {
            type: "image",
            url: mediaUrl(agentId, sessionId, reference.assetId),
            mediaType: part.mediaType,
          },
        ]
      : [];
  });
  return content.length === 0
    ? undefined
    : { id: randomUUID(), role: "user", content };
}

function finalContent(output: JsonValue): readonly ChatContent[] {
  return typeof output === "string"
    ? [{ type: "text", text: output }]
    : [{ type: "json", value: output }];
}

function generatedImageMessage(
  event: ObserveEvent,
  agentId: string,
  sessionId: string,
): ChatMessage | undefined {
  if (event.type !== "tool.completed") return undefined;
  const image = imageFromToolResult(event.attributes);
  return image
    ? {
        id: randomUUID(),
        role: "assistant",
        content: [
          {
            type: "image",
            url: mediaUrl(agentId, sessionId, image.id),
            mediaType: image.mediaType,
          },
        ],
      }
    : undefined;
}

function generatedImageFromEvent(
  event: CanonicalEvent,
  agentId: string,
): ChatMessage | undefined {
  if (event.type !== "tool.completed") return undefined;
  const image = imageFromToolResult(
    event.payload.attributes as ToolResult | undefined,
  );
  return image
    ? {
        id: String(event.seq),
        role: "assistant",
        content: [
          {
            type: "image",
            url: mediaUrl(agentId, event.session, image.id),
            mediaType: image.mediaType,
          },
        ],
      }
    : undefined;
}

function imageFromToolResult(
  value: ToolResult | undefined,
): MediaAsset | undefined {
  if (
    !value ||
    value.kind !== "completed" ||
    !value.output ||
    typeof value.output !== "object"
  )
    return undefined;
  const image = (value.output as { image?: unknown }).image as
    Partial<MediaAsset> | undefined;
  return image &&
    typeof image.id === "string" &&
    typeof image.mediaType === "string" &&
    image.kind === "generated"
    ? (image as MediaAsset)
    : undefined;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === "string" &&
    typeof message.role === "string" &&
    Array.isArray(message.content)
  );
}

function firstText(message: ChatMessage): string | undefined {
  return message.content.find(
    (part): part is Extract<ChatContent, { type: "text" }> =>
      part.type === "text",
  )?.text;
}

function mediaUrl(agentId: string, sessionId: string, assetId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/v1/media/${encodeURIComponent(sessionId)}/${encodeURIComponent(assetId)}`;
}

function secrets(): readonly string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        value && /key|token|secret|password|credential/iu.test(name),
    )
    .map(([, value]) => value!);
}

function permitted(origin: string, configured: readonly string[]): boolean {
  try {
    const url = new URL(origin);
    return (
      configured.includes(origin) ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

async function waitForProjectedEvents(live: Live): Promise<void> {
  for (
    let attempt = 0;
    attempt < 40 && live.status === "running";
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
