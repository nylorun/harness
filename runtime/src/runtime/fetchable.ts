import { randomUUID } from "node:crypto";
import { EventEncoder } from "@ag-ui/encoder";
import type { WireSessionEvent } from "./contracts.js";
import type { BuiltAgent } from "./bind.js";
import { AgUiEventMapper, agUiHistory, latestUserMessage, parseAgUiRun } from "./ag-ui.js";

export type CorsOptions = Readonly<{ allowedOrigins: readonly string[] }>;
export type FetchableOptions = Readonly<{ basePath?: string; cors?: CorsOptions }>;
export interface FetchHandler { (request: Request): Promise<Response>; readonly fetch: (request: Request) => Promise<Response>; }

type Refusal = Readonly<{ status: number; code: string; message: string; hint: string }>;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const json = (status: number, body: unknown): Response => new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });
const refuse = (value: Refusal): Response => json(value.status, { error: { code: value.code, message: value.message }, hint: value.hint });

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return undefined;
  try { const parsed: unknown = await request.json(); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
function cursor(value: string | null): number | undefined { if (value === null || value === "") return 0; const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined; }
function stream(id: string, after: number, source: AsyncIterable<WireSessionEvent>): Response {
  const body = new ReadableStream<Uint8Array>({ async start(controller) { const encoder = new TextEncoder(); try { for await (const event of source) if (event.seq > after) controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); controller.close(); } catch (cause) { controller.error(cause); } } });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-nylo-session-id": id } });
}
async function* eventsAfter(source: AsyncIterable<WireSessionEvent>, sequence: number): AsyncIterable<WireSessionEvent> {
  for await (const event of source) if (event.seq > sequence) yield event;
}
function agUiStream(events: AsyncIterable<WireSessionEvent>, threadId: string, runId: string): Response {
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    const encoder = new TextEncoder(); const wire = new EventEncoder(); const mapper = new AgUiEventMapper(threadId, runId);
    try {
      controller.enqueue(encoder.encode(wire.encodeSSE(mapper.started() as never)));
      for await (const event of events) for (const projected of mapper.event(event)) controller.enqueue(encoder.encode(wire.encodeSSE(projected as never)));
      for (const projected of mapper.finished()) controller.enqueue(encoder.encode(wire.encodeSSE(projected as never)));
      controller.close();
    } catch (cause) { controller.error(cause); }
  } });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_HEADERS = new Set(["content-type", "idempotency-key", "last-event-id"]);

function configuredOrigins(cors: CorsOptions | undefined): ReadonlySet<string> {
  if (cors === undefined) return new Set();
  const origins = new Set<string>();
  for (const value of cors.allowedOrigins) {
    if (value === "*") throw new Error("Fetchable CORS requires explicit origins; wildcard origins are not supported.");
    let origin: URL;
    try { origin = new URL(value); } catch { throw new Error(`Fetchable CORS origin is not a URL: ${value}`); }
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value) throw new Error(`Fetchable CORS origin must be an exact http(s) origin: ${value}`);
    origins.add(value);
  }
  return origins;
}
function corsOrigin(request: Request, origins: ReadonlySet<string>): string | undefined {
  const origin = request.headers.get("origin");
  return origin !== null && origins.has(origin) ? origin : undefined;
}
function decorateCors(response: Response, request: Request, origins: ReadonlySet<string>): Response {
  const origin = corsOrigin(request, origins);
  if (origin === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  headers.set("access-control-expose-headers", "x-nylo-session-id");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function preflight(request: Request, origins: ReadonlySet<string>): Response | undefined {
  if (request.method.toUpperCase() !== "OPTIONS" || request.headers.get("access-control-request-method") === null) return undefined;
  const origin = corsOrigin(request, origins);
  if (origin === undefined) return new Response(null, { status: 403 });
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (requestedMethod !== "GET" && requestedMethod !== "POST") return new Response(null, { status: 405 });
  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
  if (requestedHeaders.some((header) => !CORS_HEADERS.has(header))) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-allow-headers": [...CORS_HEADERS].join(", "),
      "access-control-max-age": "600",
      "vary": "origin, access-control-request-headers"
    }
  });
}

export function Fetchable(agent: BuiltAgent, options: FetchableOptions = {}): FetchHandler {
  const base = (options.basePath ?? "").replace(/\/$/u, "");
  const route = (path: string): string => `${base}${path}` || "/";
  const origins = configuredOrigins(options.cors);
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (base !== "" && !url.pathname.startsWith(base)) return refuse(unknownRoute(url.pathname));
    const path = base === "" ? url.pathname : url.pathname.slice(base.length);
    const segments = path.split("/").filter(Boolean);
    const method = request.method.toUpperCase();
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "agent") {
      if (method !== "GET") return refuse(methodRefusal(method, path, "GET"));
      const inspection = await agent.inspect();
      return json(200, {
        protocolVersion: 1,
        agentServerVersion: inspection.manifest.sdkVersion,
        capabilities: ["agent-dashboard", "session-records", "ag-ui"],
        manifest: inspection.manifest,
        agUiUrl: route("/v1/ag-ui"),
        ...(agent.records === undefined ? {} : { sessionRecords: { path: ".nylo/runs" } })
      });
    }
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "ag-ui") {
      if (method !== "POST") return refuse(methodRefusal(method, path, "POST"));
      const raw = await body(request); const input = raw === undefined ? undefined : parseAgUiRun(raw);
      const message = input === undefined ? undefined : latestUserMessage(input);
      if (input === undefined || message === undefined) return refuse({ status: 400, code: "NYLO_AGUI_INPUT_INVALID", message: "AG-UI requires threadId, runId, and a final non-empty user text message; client tools and context are not supported.", hint: "Send standard RunAgentInput with text messages only." });
      const existing = await agent.session.get(input.threadId);
      if (existing?.status === "running") return refuse({ status: 409, code: "NYLO_AGUI_SESSION_BUSY", message: `Session ${input.threadId} already has an active run.`, hint: "Wait for the current response before sending another message." });
      const previousSequence = (await agent.session.events(input.threadId))?.at(-1)?.seq ?? 0;
      const run = agent.session.start(message, { sessionId: input.threadId });
      return agUiStream(eventsAfter(run.events, previousSequence), input.threadId, input.runId);
    }
    if (segments.length === 4 && segments[0] === "v1" && segments[1] === "ag-ui" && segments[2] === "sessions") {
      if (method !== "GET") return refuse(methodRefusal(method, path, "GET"));
      const events = await agent.session.events(segments[3]!);
      if (events === undefined) return refuse(unknownSession(segments[3]!));
      return json(200, { session_id: segments[3], messages: agUiHistory(events), state: {} });
    }
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "sessions") {
      if (method === "GET") {
        const sessions = agent.records === undefined ? await agent.session.list() : await agent.records.list();
        return json(200, { sessions });
      }
      if (method !== "POST") return refuse(methodRefusal(method, path, "POST"));
      const payload = await body(request);
      if (payload === undefined || Object.keys(payload).some((key) => key !== "agent_id" && key !== "message") || typeof payload.agent_id !== "string" || payload.agent_id.trim() === "" || (payload.message !== undefined && (typeof payload.message !== "string" || payload.message.trim() === ""))) return refuse({ status: 400, code: "NYLO_HTTP_SESSION_CREATE_INVALID", message: "Create requires { agent_id, message? } with non-empty strings.", hint: "Use this local agent's configured name for agent_id." });
      if (payload.agent_id !== agent.config.name) return refuse({ status: 404, code: "NYLO_HTTP_AGENT_UNKNOWN", message: `No agent named ${payload.agent_id} is served here.`, hint: "Use the configured name of the mounted agent." });
      const key = request.headers.get("idempotency-key");
      if (key !== null && key.length > 200) return refuse({ status: 400, code: "NYLO_HTTP_IDEMPOTENCY_KEY_INVALID", message: "Idempotency-Key must be 200 characters or fewer.", hint: "Use a shorter retry key." });
      const id = randomUUID(); const claimed = key === null ? id : await agent.session.claim(key, id);
      if (claimed !== id) return json(200, { session_id: claimed, state: "requested", stream_url: route(`/v1/sessions/${claimed}/stream`) });
      agent.session.start(typeof payload.message === "string" ? payload.message : undefined, { sessionId: id });
      return json(202, { session_id: id, state: "requested", stream_url: route(`/v1/sessions/${id}/stream`) });
    }
    if (segments.length >= 3 && segments[0] === "v1" && segments[1] === "sessions") {
      const id = segments[2]!; const tail = segments[3]; const record = await agent.session.get(id);
      if (record === undefined) return refuse(unknownSession(id));
      if (tail === undefined && method === "GET") { const events = await agent.session.events(id); const pending = pendingInteraction(events ?? []); return json(200, { id: record.id, state: record.status, started_at: new Date(record.startedAt).toISOString(), ...(record.endedAt === undefined ? {} : { ended_at: new Date(record.endedAt).toISOString() }), latest_event_cursor: events?.at(-1)?.seq ?? 0, ...(pending === undefined ? {} : { pending_interaction: pending }) }); }
      if (tail === undefined && method === "POST") {
        const payload = await body(request);
        if (payload === undefined || Object.keys(payload).length !== 1) return refuse({ status: 400, code: "NYLO_HTTP_INPUT_INVALID", message: "Submit either { message } or { interaction }.", hint: "Send exactly one input field." });
        let accepted = false;
        if (typeof payload.message === "string" && payload.message.trim() !== "") accepted = await agent.session.send(id, payload.message);
        else if (typeof payload.interaction === "object" && payload.interaction !== null && !Array.isArray(payload.interaction)) {
          const interaction = payload.interaction as Record<string, unknown>;
          if (typeof interaction.id === "string" && interaction.kind === "approval" && typeof interaction.approved === "boolean") accepted = await agent.session.interact(id, { kind: "approve", interactionId: interaction.id, approved: interaction.approved });
          else if (typeof interaction.id === "string" && interaction.kind === "response" && "value" in interaction) accepted = await agent.session.interact(id, { kind: "respond", interactionId: interaction.id, value: interaction.value as never });
        }
        if (!accepted) return refuse({ status: 409, code: "NYLO_HTTP_SESSION_NOT_ACCEPTING", message: `Session ${id} cannot accept this input.`, hint: "Wait for the current run, or submit the pending interaction." });
        return json(202, { session_id: id, state: "requested" });
      }
      if (tail === "events" && method === "GET") {
        const after = cursor(url.searchParams.get("after")); const requestedLimit = url.searchParams.get("limit"); const limit = requestedLimit === null ? DEFAULT_EVENT_LIMIT : Number(requestedLimit);
        if (after === undefined || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) return refuse({ status: 400, code: "NYLO_HTTP_EVENT_PAGE_INVALID", message: `after must be a non-negative cursor and limit an integer from 1 to ${MAX_EVENT_LIMIT}.`, hint: "Use ?after=0&limit=100." });
        const page = (await agent.session.events(id, after) ?? []).filter((event) => event.seq > after).slice(0, limit);
        return json(200, { session_id: id, events: page, next_cursor: page.at(-1)?.seq ?? after });
      }
      if (tail === "stream" && method === "GET") { const after = cursor(request.headers.get("last-event-id")); if (after === undefined) return refuse({ status: 400, code: "NYLO_HTTP_LAST_EVENT_ID_INVALID", message: "Last-Event-ID must be a non-negative integer.", hint: "Use the id from the last SSE event." }); const following = agent.session.follow(id, after); return following === undefined ? refuse(unknownSession(id)) : stream(id, after, following); }
      if (tail === "cancel" && method === "POST") { if (record.status === "completed" || record.status === "failed") return json(200, { session_id: id, state: record.status }); await agent.session.cancel(id, "cancelled"); return json(202, { session_id: id, state: "cancelling" }); }
      return refuse(methodRefusal(method, path, tail === "events" || tail === "stream" ? "GET" : "POST"));
    }
    return refuse(unknownRoute(path));
  }
  const handler = async (request: Request): Promise<Response> => {
    const corsResponse = preflight(request, origins);
    if (corsResponse !== undefined) return corsResponse;
    return decorateCors(await handle(request), request, origins);
  };
  Object.defineProperty(handler, "fetch", { value: handler, enumerable: true });
  return Object.freeze(handler) as FetchHandler;
}
function unknownRoute(path: string): Refusal { return { status: 404, code: "NYLO_HTTP_ROUTE_UNKNOWN", message: `No agent route matches ${path || "/"}.`, hint: "Expected /v1/agent, /v1/sessions, or /v1/ag-ui." }; }
function unknownSession(id: string): Refusal { return { status: 404, code: "NYLO_HTTP_SESSION_UNKNOWN", message: `This process has no session ${id}.`, hint: "Check the id or create a new local session." }; }
function methodRefusal(method: string, path: string, expected: string): Refusal { return { status: 405, code: "NYLO_HTTP_METHOD_UNSUPPORTED", message: `${method} is not supported on ${path}.`, hint: `Use ${expected}.` }; }
function pendingInteraction(events: readonly WireSessionEvent[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "interaction.required") return event.payload.interaction;
    if (event.type === "session.run.ended" && event.payload.state !== "waiting") return undefined;
  }
  return undefined;
}
