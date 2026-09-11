import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  JsonValue,
  MessageInput,
  RuntimeSession,
  RuntimeAgent,
  RuntimeInput,
  UserContentPart,
} from "../contracts.js";
import { agUiEvents, sse } from "./ag-ui.js";
import { observedPayload } from "./digests.js";
import { localJsonl, scrub, type CanonicalEvent } from "../adapters/journal.js";
import { jsonlObserver } from "../adapters/observe.js";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  type RuntimeMedia,
  type MediaAsset,
} from "../adapters/media.js";
import type { RuntimeConfig } from "../config.js";
import { projectSecrets } from "../model/settings.js";
import { piModel } from "../model/pi-model.js";

type Live = {
  session: RuntimeSession;
  writes: Promise<void>;
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

export type RuntimeActor = Readonly<{
  id: string;
  context?: Record<string, JsonValue>;
}>;
export type AgentRouterOptions = Readonly<{
  /** Public URL prefix of this router, matching the Hono mount path. */
  basePath?: string;
  getActor?: (
    context: Context
  ) => RuntimeActor | undefined | Promise<RuntimeActor | undefined>;
  getRequestMetadata?: (
    context: Context
  ) =>
    | Record<string, JsonValue>
    | undefined
    | Promise<Record<string, JsonValue> | undefined>;
}>;

export type ServeAgentsOptions = AgentRouterOptions & {
  readonly agents: readonly RuntimeAgent[];
  readonly runtime: Runtime;
};

const kServe = Symbol("serve");

export class Runtime {
  readonly #config: RuntimeConfig;
  #served = false;
  #closing?: Promise<void>;
  #shutdown?: () => Promise<void>;

  constructor(options: RuntimeConfig = {}) {
    this.#config = options;
  }

  close = (): Promise<void> =>
    (this.#closing ??= this.#shutdown?.() ?? Promise.resolve());

  [kServe](options: Omit<ServeAgentsOptions, "runtime">): Hono {
    if (this.#served) throw new Error("A Runtime may only be served once.");
    this.#served = true;
    const agents = [...options.agents];
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    if (byId.size !== agents.length)
      throw new Error("Agent IDs must be unique.");
    for (const agent of agents) {
      if (!/^[a-zA-Z0-9_-]+$/.test(agent.id))
        throw new Error(`Invalid agent ID: ${agent.id}`);
      if (agent.id !== agent.manifest.id || agent.name !== agent.manifest.name)
        throw new Error("Agent identity must match its manifest.");
    }
    const media = this.#config.media;
    const onModelCall = this.#config.onModelCall ?? piModel({ media });
    const journal = this.#config.durability ?? localJsonl();
    const configuredObserver = this.#config.observer;
    const redact = (value: unknown) => scrub(value, projectSecrets());
    const live = new Map<string, Live>();
    let publicPath = (path: string) => path;
    const routerOptions = options;
    const app = new Hono();
    app.onError((error, context) =>
      context.json(
        { error: String(redact(error.message)) },
        error instanceof HTTPException ? error.status : 500
      )
    );

    app.use("*", async (context, next) => {
      await next();
      if (
        context.res.headers.get("content-type")?.includes("application/json")
      ) {
        const value: unknown = await context.res.json();
        context.res = new Response(JSON.stringify(redact(value)), {
          status: context.res.status,
          headers: context.res.headers,
        });
      }
    });
    publicPath = (path: string) =>
      `${normalizeBasePath(routerOptions.basePath)}${path}`;

    app.get("/v1/agents", (context) =>
      context.json({
        protocolVersion: 2,
        agents: agents.map((agent) => ({
          id: agent.id,
          manifestUrl: publicPath(`/agents/${agent.id}/manifest.json`),
        })),
      })
    );

    app.get("/agents/:agentId/manifest.json", (context) => {
      const agent = byId.get(context.req.param("agentId"));
      return agent === undefined
        ? context.json({ error: "unknown agent" }, 404)
        : context.json(manifest(agent, media !== undefined, publicPath));
    });

    app.get("/agents/:agentId/v1/media/:session/:assetId", async (context) => {
      const agent = requireAgent(context.req.param("agentId"));
      if (!agent) return context.json({ error: "unknown agent" }, 404);
      const asset = await media?.read(
        agent.id,
        context.req.param("session"),
        context.req.param("assetId")
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
        | Record<string, unknown>
        | undefined;
      if (!interaction || typeof interaction.id !== "string")
        return context.json({ error: "expected interaction" }, 400);
      const waiting = pending(found.events) as
        | { id?: string; kind?: string }
        | undefined;
      if (
        found.status !== "waiting" ||
        !waiting ||
        waiting.id !== interaction.id
      )
        return context.json({ error: "interaction is no longer pending" }, 409);
      if (interaction.kind === "approval") {
        if (typeof interaction.approved !== "boolean")
          return context.json({ error: "expected approval interaction" }, 400);
        found.status = "running";
        await submit(found, {
          kind: "approve",
          interactionId: interaction.id,
          approved: interaction.approved,
        });
        return context.json(
          { session_id: context.req.param("session"), state: found.status },
          202
        );
      }
      if (interaction.kind === "respond") {
        if (!("value" in interaction))
          return context.json({ error: "expected respond interaction" }, 400);
        found.status = "running";
        await submit(found, {
          kind: "respond",
          interactionId: interaction.id,
          value: interaction.value as JsonValue,
        });
        return context.json(
          { session_id: context.req.param("session"), state: found.status },
          202
        );
      }
      return context.json(
        { error: "expected approval or respond interaction" },
        400
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
            await journal.events(agent.id, context.req.param("session"))
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
      if (!isSessionId(threadId))
        return context.json(
          {
            error:
              "threadId may only contain letters, digits, '.', '_' and '-'",
          },
          400
        );
      const runId =
        typeof payload?.runId === "string" && payload.runId
          ? payload.runId
          : randomUUID();
      let message: IncomingMessage;
      let actor: RuntimeActor | undefined;
      try {
        actor = await routerOptions.getActor?.(context);
        const metadata = await routerOptions.getRequestMetadata?.(context);
        message = await latestMessage(
          payload?.messages,
          media,
          agent.id,
          threadId,
          metadata
        );
      } catch (error) {
        return context.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Invalid AG-UI user message",
          },
          400
        );
      }
      const found = await begin(agent, threadId, message, actor);
      const start = found.events.length;
      await submit(found, message.input);
      return sse(
        agUiEvents(found.events.slice(start), threadId, runId),
        context.res.headers
      );
    });

    function requireAgent(id: string): RuntimeAgent | undefined {
      return byId.get(id);
    }

    async function begin(
      agent: RuntimeAgent,
      sessionId: string,
      message: IncomingMessage,
      actor?: RuntimeActor
    ): Promise<Live> {
      const key = keyOf(agent.id, sessionId);
      const existing = live.get(key);
      if (existing) {
        existing.messages.push(message.chat);
        return existing;
      }
      const archived = await journal.events(agent.id, sessionId);
      const concurrent = live.get(key);
      if (concurrent) {
        concurrent.messages.push(message.chat);
        return concurrent;
      }
      if (archived.length)
        throw new HTTPException(409, {
          message: "This session is archived. Start a new conversation.",
        });
      let entry!: Live;
      const observer =
        configuredObserver ?? jsonlObserver({ agentId: agent.id, sessionId });
      const session = agent.run({
        id: sessionId,
        onModelCall,
        observer: (event) => {
          const image = generatedImageMessage(event, agent.id, sessionId);
          if (image) entry.messages.push(image);
          add(entry, agent.id, event.type, observedPayload(event));
          void Promise.resolve(observer(event)).catch(() => {});
        },
        ...(actor === undefined ? {} : { userId: actor.id }),
        ...(actor?.context === undefined ? {} : { context: actor.context }),
      });
      entry = {
        session,
        events: [],
        messages: [message.chat],
        status: "running",
        sequence: 0,
        writes: Promise.resolve(),
      };
      live.set(key, entry);

      return entry;
    }

    function add(
      entry: Live,
      agentId: string,
      type: string,
      payload: Record<string, unknown>
    ) {
      const event: CanonicalEvent = {
        session: entry.session.id,
        seq: ++entry.sequence,
        ts: new Date().toISOString(),
        type,
        payload: redact(payload) as Record<string, unknown>,
      };
      entry.events.push(event);
      entry.writes = entry.writes.then(() => journal.append(agentId, event));
      // The submit/close paths observe durability errors; avoid an unhandled rejection meanwhile.
      void entry.writes.catch(() => {});
    }
    async function submit(entry: Live, input: RuntimeInput) {
      const agentId = [...live]
        .find(([, value]) => value === entry)![0]
        .split(":")[0]!;
      entry.status = "running";
      const inputEvent =
        typeof input === "string"
          ? { kind: "user-message" as const, text: input }
          : "kind" in input
          ? input
          : { kind: "user-message" as const, ...input };
      const message = chatFromInput(inputEvent, agentId, entry.session.id);
      add(entry, agentId, "session.run.started", {
        input_kind: inputEvent.kind,
        input: message ? firstText(message) : undefined,
        ...(message ? { message } : {}),
        ...("approved" in inputEvent ? { approved: inputEvent.approved } : {}),
        ...("value" in inputEvent ? { value: inputEvent.value } : {}),
      });
      const start = entry.events.length;
      try {
        const result = await entry.session.input(input).completed;
        for (const event of result.events) {
          if (event.type === "final" && event.output !== undefined) {
            entry.messages.push({
              id: randomUUID(),
              role: "assistant",
              content: finalContent(event.output),
            });
            add(entry, agentId, "final", { output: event.output });
          } else if (event.type === "interaction.required") {
            add(entry, agentId, event.type, { interaction: event.interaction });
          }
        }
        const observedFailure = entry.events
          .slice(start)
          .some((event) => event.type === "error" || event.type === "tripwire");
        const completionFailure = result.events.find(
          (event) => event.type === "error" || event.type === "tripwire"
        );
        const failed =
          observedFailure ||
          completionFailure !== undefined ||
          (result.status !== "completed" && result.status !== "waiting");
        if (!observedFailure && completionFailure) {
          add(
            entry,
            agentId,
            completionFailure.type,
            observedPayload(completionFailure)
          );
        } else if (!observedFailure && failed) {
          add(entry, agentId, "error", {
            message: `Agent run ${result.status}.`,
          });
        }
        entry.status = failed
          ? "failed"
          : result.status === "waiting"
          ? "waiting"
          : "completed";
        await entry.writes;
      } catch (error) {
        entry.status = "failed";
        add(entry, agentId, "error", {
          message: error instanceof Error ? error.message : String(error),
        });
        await entry.writes;
        throw error;
      }
    }

    this.#shutdown = async () => {
      const sessions = await Promise.allSettled(
        [...live.values()].map(async (entry) => {
          try {
            await entry.session.stop();
            await entry.writes;
          } finally {
          }
        })
      );
      const resources = await Promise.allSettled(
        agents.map((agent) => agent.close?.())
      );
      const failure = [...sessions, ...resources].find(
        (result) => result.status === "rejected"
      );
      if (failure?.status === "rejected") throw failure.reason;
    };
    return app;
  }
}

/** Create the Hono protocol mount for a runtime. Applications may close it during graceful shutdown. */
// `any` avoids leaking a second physical Hono installation through a peer boundary.
// The returned value is the caller's Hono router at runtime.
export function serveAgents(options: ServeAgentsOptions): any {
  if (!(options.runtime instanceof Runtime))
    throw new Error("serveAgents requires a Runtime.");
  const { runtime, ...rest } = options;
  return runtime[kServe](rest);
}

function manifest(
  agent: RuntimeAgent,
  media: boolean,
  publicPath: (path: string) => string
) {
  return {
    protocolVersion: 2,
    id: agent.manifest.id,
    name: agent.manifest.name,
    manifest: agent.manifest,
    endpoints: {
      agUi: publicPath(`/agents/${agent.id}/v1/ag-ui`),
      sessions: publicPath(`/agents/${agent.id}/v1/sessions`),
    },
    ...(media
      ? {
          mediaInput: {
            acceptedTypes: IMAGE_MEDIA_TYPES,
            maxBytes: MAX_IMAGE_BYTES,
          },
        }
      : {}),
  };
}

function keyOf(agent: string, session: string): string {
  return `${agent}:${session}`;
}

async function latestMessage(
  value: unknown,
  media: RuntimeMedia | undefined,
  agentId: string,
  sessionId: string,
  metadata: Record<string, JsonValue> | undefined
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
      metadata
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
  return pending(events)
    ? "waiting"
    : events.some((event) => event.type === "final")
    ? "completed"
    : "incomplete";
}

function messages(
  agentId: string,
  events: readonly CanonicalEvent[]
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
      : []
  );
}

async function incomingContent(
  value: unknown,
  media: RuntimeMedia | undefined,
  agentId: string,
  sessionId: string,
  metadata: Record<string, JsonValue> | undefined
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
          "Image input must contain base64 data and a media type."
        );
      if (!media) throw new Error("This runtime does not support image input.");
      const asset = await media.saveInput(
        agentId,
        sessionId,
        source.mimeType,
        source.value
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
    input: {
      content: Object.freeze(parts),
      ...(metadata === undefined ? {} : { metadata }),
    },
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
  sessionId: string
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
  event: { readonly type: string; readonly attributes?: unknown },
  agentId: string,
  sessionId: string
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
  agentId: string
): ChatMessage | undefined {
  if (event.type !== "tool.completed") return undefined;
  const image = imageFromToolResult(event.payload.attributes);
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

function imageFromToolResult(value: unknown): MediaAsset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { kind?: unknown; output?: unknown };
  if (
    result.kind !== "completed" ||
    !result.output ||
    typeof result.output !== "object"
  )
    return undefined;
  const image = (result.output as { image?: unknown }).image as
    | Partial<MediaAsset>
    | undefined;
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
      part.type === "text"
  )?.text;
}

/** Session IDs name journal and media files; keep them path-safe up front. */
function isSessionId(value: string): boolean {
  return value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/u.test(value);
}

function mediaUrl(agentId: string, sessionId: string, assetId: string): string {
  return `media/${encodeURIComponent(sessionId)}/${encodeURIComponent(
    assetId
  )}`;
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === "/") return "";
  if (!value.startsWith("/") || value.endsWith("/"))
    throw new Error("basePath must start with / and must not end with /.");
  return value;
}
