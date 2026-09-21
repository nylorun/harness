import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type {
  JsonValue,
  MessageInput,
  RuntimeAgent,
  UserContentPart,
} from "../contracts.js";
import type { BuiltAgent, ModelAdapter } from "@nylorun/core/define"
import type { ExecutionInput } from "@nylorun/harness";
import { agUiEvents } from "./ag-ui.js";
import { EventDelivery } from "./delivery.js";
import { scrub } from "../redact.js";
import { memorySessions, type CanonicalEvent } from "../sessions/store.js";
import { SessionHost } from "../sessions/host.js";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  decodeImageBase64,
  type RuntimeMedia,
  type MediaAsset,
} from "../media.js";
import type { RuntimeConfig } from "../config.js";
import {
  defaultModel,
  processEnvironment,
  registerRuntimeLifecycle,
} from "../model/defaults.js";
import type { ModelEnvironment } from "../model/http-model.js";
import {
  createSessionHandle,
  type OpenSessionOptions,
  type SessionHandle,
} from "../session/handle.js";
import { installDefaultRuntimeFactory } from "../session/default.js";
import {
  AgentsApiClient,
  createLazyCloudSessionHandle,
  resolveCloudConfig,
} from "../cloud/index.js";
const randomUUID = () => crypto.randomUUID();

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
  basePath?: string;
  getActor?: (
    context: Context
  ) => RuntimeActor | undefined | Promise<RuntimeActor | undefined>;
  getInfo?: (context: Context) => unknown | Promise<unknown>;
  getEnvironment?: (
    context: Context
  ) => ModelEnvironment | Promise<ModelEnvironment>;
  getRequestMetadata?: (
    context: Context
  ) =>
    | Record<string, JsonValue>
    | undefined
    | Promise<Record<string, JsonValue> | undefined>;
}>;
/** 1.0 compatibility: requires an explicit Runtime and returns a Hono app. */
export type ServeAgentsCompatOptions = AgentRouterOptions & {
  readonly agents: readonly RuntimeAgent[];
  readonly runtime: Runtime;
};
/** DX v5.6 local: optional Runtime; returns `{ fetch }`. */
export type ServeAgentsFetchOptions = AgentRouterOptions & {
  readonly agents?: readonly RuntimeAgent[];
  readonly runtime?: Runtime;
  /** Alias for `getInfo` — keep the name `info` (never `user`). */
  readonly info?: AgentRouterOptions["getInfo"];
  readonly on?: {
    readonly session?: {
      readonly created?: (session: { readonly id: string; readonly agentId: string }) => void;
      readonly idle?: (session: { readonly id: string; readonly agentId: string }) => void;
      readonly failed?: (session: { readonly id: string; readonly agentId: string }) => void;
    };
  };
};
export type ServeAgentsOptions = ServeAgentsCompatOptions;
export type ServeAgentsFetch = {
  readonly fetch: (request: Request) => Response | Promise<Response>;
};
const kServe = Symbol("serve");

export class Runtime {
  readonly host: SessionHost;
  private served = false;
  private closing?: Promise<void>;
  constructor(readonly config: RuntimeConfig = {}) {
    this.host = new SessionHost(config.sessions ?? memorySessions());
    registerRuntimeLifecycle(this.close);
  }
  close = (): Promise<void> => (this.closing ??= this.host.close());

  resolveModel(onPreview?: (preview: import("../model/defaults.js").ModelPreview) => void): ModelAdapter {
    return (
      this.config.onModelCall ??
      (this.config.createModel ?? defaultModel)({
        environment: this.config.environment ?? processEnvironment(),
        onPreview,
        media: this.config.media,
      })
    );
  }

  openSession(
    agent: BuiltAgent<any, any>,
    options?: OpenSessionOptions,
  ): SessionHandle {
    const cloud =
      this.config.cloud ??
      resolveCloudConfig(
        typeof process === "undefined" ? {} : process.env,
      );
    if (cloud) {
      const client = new AgentsApiClient(cloud);
      return createLazyCloudSessionHandle(client, agent, options);
    }
    return createSessionHandle(this, agent, options);
  }

  async listSessions(agentId: string) {
    return this.host.list(agentId);
  }

  async getSession(agentId: string, sessionId: string) {
    return this.host.read(agentId, sessionId);
  }

  async deleteSession(agentId: string, sessionId: string) {
    return this.host.delete(agentId, sessionId);
  }

  [kServe](options: Omit<ServeAgentsCompatOptions, "runtime"> & {
    readonly agents: readonly RuntimeAgent[];
  }): Hono<any> {
    if (this.served) throw new Error("A Runtime may only be served once.");
    this.served = true;
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
    const { media } = this.config;
    const app = new Hono<{
      Variables: { info: unknown; modelEnvironment: ModelEnvironment };
    }>();
    if (processEnvironment().NYLORUN_DEV === "1")
      app.use(
        "*",
        cors({
          origin: (origin) => {
            try {
              const url = new URL(origin);
              return ["http:", "https:"].includes(url.protocol) &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
                url.origin === origin
                ? origin
                : undefined;
            } catch {
              return undefined;
            }
          },
        })
      );
    app.onError((error, context) =>
      context.json(
        {
          error: String(
            scrub(error.message, secretValues(environment(context)))
          ),
        },
        error instanceof HTTPException ? error.status : 500
      )
    );
    // Application authorization/info resolution precedes all store and media access.
    app.use("*", async (context, next) => {
      const actor = await options.getActor?.(context);
      const info = options.getInfo
        ? await options.getInfo(context)
        : actor
        ? { ...actor.context, userId: actor.id }
        : undefined;
      context.set("info", info);
      if (options.getEnvironment)
        context.set("modelEnvironment", await options.getEnvironment(context));
      await next();
      if (
        context.res.headers.get("content-type")?.includes("application/json")
      ) {
        const value = await context.res.json();
        context.res = new Response(
          JSON.stringify(scrub(value, secretValues(environment(context)))),
          { status: context.res.status, headers: context.res.headers }
        );
      }
    });
    const environment = (context: Context): ModelEnvironment =>
      context.get("modelEnvironment") ??
      this.config.environment ??
      bindingsEnvironment(context) ??
      processEnvironment();
    const path = (context: Context, route: string, suffix: string) =>
      `${normalizeBasePath(
        options.basePath ?? inferMountPath(context, route)
      )}${suffix}`;
    const agentFor = (context: Context) => {
      const agent = byId.get(context.req.param("agentId")!);
      if (!agent) throw new HTTPException(404, { message: "unknown agent" });
      const session = context.req.param("session");
      if (session !== undefined && !isSessionId(session))
        throw new HTTPException(400, { message: "Invalid session identifier" });
      return agent;
    };
    const submitOptions = (
      context: Context,
      sessionId: string,
      onPreview?: (preview: import("../model/defaults.js").ModelPreview) => void
    ) => {
      // Leave undefined on Node so defaultModel can use the installed piModel
      // factory. Hono's Node adapter puts stream bindings on context.env; those
      // must not be treated as Workers-style provider bindings.
      const explicitEnvironment =
        context.get("modelEnvironment") ??
        this.config.environment ??
        bindingsEnvironment(context);
      return {
        info: { ...((context.get("info") as object) ?? {}), sessionId },
        onEvent: (event: CanonicalEvent) => {
          try {
            void Promise.resolve(
              this.config.observer?.({ type: event.type, ...event.payload })
            ).catch(() => {});
          } catch {
            /* Observation cannot acknowledge persistence. */
          }
        },
        onModelCall:
          this.config.onModelCall ??
          (this.config.createModel ?? defaultModel)({
            environment: explicitEnvironment,
            onPreview,
            media,
          }),
        secrets: secretValues(environment(context)),
        signal: context.req.raw.signal,
      };
    };
    app.get("/v1/agents", (context) =>
      context.json({
        protocolVersion: 2,
        agents: agents.map((agent) => ({
          id: agent.id,
          manifestUrl: path(
            context,
            "/v1/agents",
            `/${agent.id}/manifest.json`
          ),
        })),
      })
    );
    app.get("/:agentId/manifest.json", (context) =>
      context.json(
        manifest(agentFor(context), media !== undefined, (suffix) =>
          path(context, "/:agentId/manifest.json", suffix)
        )
      )
    );
    app.get("/:agentId/v1/media/:session/:assetId", async (context) => {
      const agent = agentFor(context);
      const asset = await media?.read(
        agent.id,
        context.req.param("session"),
        context.req.param("assetId")
      );
      if (!asset) return context.json({ error: "unknown media asset" }, 404);
      return context.body(asset.bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": asset.asset.mediaType,
        "cache-control": "no-store",
      });
    });
    app.get("/:agentId/v1/sessions", async (context) =>
      context.json({ sessions: await this.host.list(agentFor(context).id) })
    );
    app.get("/:agentId/v1/sessions/:session", async (context) => {
      const document = await this.host.read(
        agentFor(context).id,
        context.req.param("session")
      );
      if (!document) return context.json({ error: "unknown session" }, 404);
      return context.json({
        id: document.id,
        state: document.status,
        pending_interaction: document.state?.plan?.calls.find(
          (call) => call.status === "interaction"
        )?.interaction,
        pending_waits: document.state?.plan?.calls
          .filter(
            (call) =>
              (call.status === "interaction" || call.status === "deferred") &&
              call.wait
          )
          .map((call) => call.wait),
      });
    });
    app.delete("/:agentId/v1/sessions/:session", async (context) => {
      const agent = agentFor(context);
      const sessionId = context.req.param("session");
      const deleted = await this.host.delete(agent.id, sessionId);
      if (!deleted) return context.json({ error: "unknown session" }, 404);
      return context.json({ session_id: sessionId, deleted: true });
    });
    app.post("/:agentId/v1/sessions/:session", async (context) => {
      const agent = agentFor(context),
        sessionId = context.req.param("session");
      const payload = await context.req.json<Record<string, any>>();
      const interaction = payload.interaction;
      let input: ExecutionInput;
      if (payload.action === "cancel") {
        await this.host.cancel(agent, sessionId);
        return context.json({ session_id: sessionId, state: "cancelled" });
      }
      if (payload.action === "interrupt") {
        const result = await this.host.interrupt(
          agent,
          sessionId,
          payload.input,
          submitOptions(context, sessionId)
        );
        return context.json(
          {
            session_id: sessionId,
            state: result.status === "paused" ? "waiting" : result.status,
          },
          202
        );
      }
      if (payload.settlement) input = { kind: "settle", ...payload.settlement };
      else if (
        payload.action === "wait-resolve" ||
        payload.waitResolve ||
        (interaction?.kind === "wait-resolve" &&
          typeof interaction.waitId === "string")
      ) {
        const wait =
          payload.waitResolve ??
          (interaction?.kind === "wait-resolve" ? interaction : payload);
        if (typeof wait.waitId !== "string")
          return context.json({ error: "wait-resolve requires waitId" }, 400);
        input = {
          kind: "wait-resolve",
          waitId: wait.waitId,
          ...("value" in wait ? { value: wait.value } : {}),
        };
      } else if (
        interaction?.kind === "approval" &&
        typeof interaction.id === "string" &&
        typeof interaction.approved === "boolean"
      )
        input = {
          kind: "approve",
          interactionId: interaction.id,
          approved: interaction.approved,
        };
      else if (
        interaction?.kind === "respond" &&
        typeof interaction.id === "string" &&
        "value" in interaction
      )
        input = {
          kind: "respond",
          interactionId: interaction.id,
          value: interaction.value,
        };
      else
        return context.json(
          {
            error:
              "expected a correlated interaction, settlement, or wait-resolve",
          },
          400
        );
      const document = await this.host.read(agent.id, sessionId);
      if (!document || document.status !== "waiting")
        return context.json({ error: "interaction is no longer pending" }, 409);
      const result = await this.host.submit(
        agent,
        sessionId,
        input,
        submitOptions(context, sessionId)
      );
      return context.json(
        {
          session_id: sessionId,
          state: result.status === "paused" ? "waiting" : result.status,
        },
        202
      );
    });
    app.get("/:agentId/v1/sessions/:session/events", async (context) => {
      const document = await this.host.read(
        agentFor(context).id,
        context.req.param("session")
      );
      const after = Number(context.req.query("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0)
        return context.json({ error: "Invalid event cursor" }, 400);
      const events = document?.events ?? [];
      return context.json({
        events: events.filter((event) => event.seq > after),
        next_cursor: events.at(-1)?.seq ?? after,
      });
    });
    app.get("/:agentId/v1/ag-ui/sessions/:session", async (context) => {
      const agent = agentFor(context);
      return context.json({
        messages: messages(
          agent.id,
          (await this.host.read(agent.id, context.req.param("session")))
            ?.events ?? []
        ),
      });
    });
    app.post("/:agentId/v1/ag-ui", async (context) => {
      const agent = agentFor(context);
      const payload = await context.req.json<Record<string, unknown>>();
      const threadId =
        typeof payload.threadId === "string" && payload.threadId
          ? payload.threadId
          : randomUUID();
      if (!isSessionId(threadId))
        return context.json({ error: "Invalid threadId" }, 400);
      const runId =
        typeof payload.runId === "string" && payload.runId
          ? payload.runId
          : randomUUID();
      const message = await latestMessage(
        payload.messages,
        media,
        agent.id,
        threadId,
        await options.getRequestMetadata?.(context)
      );
      const controller = new AbortController();
      const abort = () => controller.abort(context.req.raw.signal.reason);
      context.req.raw.signal.addEventListener("abort", abort, { once: true });
      if (context.req.raw.signal.aborted) abort();
      const delivery = new EventDelivery(
        () => controller.abort(new Error("Delivery connection ended")),
        this.config.delivery,
        context.res.headers
      );
      delivery.push({ type: "RUN_STARTED", threadId, runId });
      const modelOptions = submitOptions(
        context,
        threadId,
        this.config.tokens
          ? (preview) =>
              delivery.push(
                {
                  type: "CUSTOM",
                  name: "nylorun.preview",
                  value: { ...preview, runId },
                },
                preview.invocationId
              )
          : undefined
      );
      const task = this.host.submit(agent, threadId, message.input, {
        ...modelOptions,
        runId,
        signal: controller.signal,
        started: {
          input_kind: "user-message",
          message: message.chat,
          ...(firstText(message.chat) === undefined
            ? {}
            : { input: firstText(message.chat) }),
        },
        onEvent: (event) => {
          delivery.push({
            type: "CUSTOM",
            name: "nylorun.execution",
            value: event,
          });
          for (const projected of agUiEvents([event], threadId, runId))
            if (
              !["RUN_STARTED", "RUN_FINISHED"].includes(String(projected.type))
            )
              delivery.push(projected);
          modelOptions.onEvent(event);
        },
      });
      void task
        .then(
          (result) => {
            delivery.push({
              type: "CUSTOM",
              name: "nylorun.preview.settled",
              value: { runId, status: result.status },
            });
            if (result.status !== "failed")
              delivery.push({ type: "RUN_FINISHED", threadId, runId });
          },
          (error) => {
            delivery.push({
              type: "RUN_ERROR",
              message: String(
                scrub(
                  error instanceof Error ? error.message : String(error),
                  modelOptions.secrets
                )
              ),
            });
          }
        )
        .finally(() => {
          context.req.raw.signal.removeEventListener("abort", abort);
          delivery.end();
        });
      return delivery.response;
    });
    return app;
  }
}

export function serveAgents(options: ServeAgentsCompatOptions): Hono<any>;
export function serveAgents(options: ServeAgentsFetchOptions): ServeAgentsFetch;
export function serveAgents(
  options: ServeAgentsCompatOptions | ServeAgentsFetchOptions,
): Hono<any> | ServeAgentsFetch {
  if ("runtime" in options && options.runtime) {
    const { runtime, ...rest } = options;
    return runtime[kServe]({
      ...rest,
      agents: options.agents ?? [],
    });
  }
  const runtime = new Runtime({});
  const getInfo = options.getInfo ?? ("info" in options ? options.info : undefined);
  const app = runtime[kServe]({
    ...options,
    agents: options.agents ?? [],
    ...(getInfo ? { getInfo } : {}),
  });
  return {
    fetch: (request: Request) => app.fetch(request),
  };
}

installDefaultRuntimeFactory(() => new Runtime({}));

/** Workers-style provider bindings on context.env; ignore Hono Node stream slots. */
function bindingsEnvironment(context: Context): ModelEnvironment | undefined {
  const env = context.env as ModelEnvironment | null | undefined;
  if (!env || typeof env !== "object") return undefined;
  const keys = Object.keys(env);
  if (!keys.length) return undefined;
  if (keys.every((key) => key === "incoming" || key === "outgoing"))
    return undefined;
  return env;
}

function secretValues(environment: ModelEnvironment): readonly string[] {
  return Object.entries(environment).flatMap(([key, value]) =>
    /key|token|secret|password|credential/i.test(key) &&
    typeof value === "string" &&
    value
      ? [value]
      : []
  );
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
      agUi: publicPath(`/${agent.id}/v1/ag-ui`),
      sessions: publicPath(`/${agent.id}/v1/sessions`),
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
  if (!Array.isArray(value))
    throw new HTTPException(400, { message: "AG-UI requires a user message." });
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
  throw new HTTPException(400, {
    message: "AG-UI requires a non-empty user message.",
  });
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
        throw new HTTPException(400, {
          message: "Only text and image inputs are supported.",
        });
      if (++images > 1)
        throw new HTTPException(400, {
          message: "Attach only one image per message.",
        });
      const source = part.source as Record<string, unknown> | undefined;
      if (
        !source ||
        source.type !== "data" ||
        typeof source.value !== "string" ||
        typeof source.mimeType !== "string"
      )
        throw new HTTPException(400, {
          message: "Image input must contain base64 data and a media type.",
        });
      if (!media)
        throw new HTTPException(400, {
          message: "This runtime does not support image input.",
        });
      try {
        decodeImageBase64(source.mimeType, source.value);
      } catch (cause) {
        throw new HTTPException(400, {
          message:
            cause instanceof Error ? cause.message : "Invalid image input",
          cause,
        });
      }
      const asset = await media.saveInput(
        agentId,
        sessionId,
        source.mimeType,
        source.value
      );
      parts.push({
        type: "media",
        mediaType: asset.mediaType,
        reference: { agentId, sessionId, assetId: asset.id },
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

/** Public mount prefix for this request, derived without hono/route Symbols. */
function inferMountPath(context: Context, routePath: string): string {
  const pathname = new URL(context.req.url).pathname;
  const suffix = routePath.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = context.req.param(key);
    if (value === undefined)
      throw new Error(
        `Unable to infer Runtime mount path from ${pathname}. Pass basePath matching the Hono mount.`
      );
    return value;
  });
  if (suffix !== "/" && pathname.endsWith(suffix)) {
    const base = pathname.slice(0, -suffix.length);
    return base === "" ? "/" : base;
  }
  if (pathname === suffix || `${pathname}/` === suffix) return "/";
  throw new Error(
    `Unable to infer Runtime mount path from ${pathname}. Pass basePath matching the Hono mount.`
  );
}
