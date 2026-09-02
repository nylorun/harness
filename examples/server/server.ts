import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { ModelAdapter, ObserveEvent, Session } from "@nylorun/harness";
import { agUiEvents, sse } from "./ag-ui.js";
import { createRegistry } from "./registry.js";
import { JsonlJournal, type CanonicalEvent } from "../services/journal.js";
import type { ExampleAgent } from "../agents/types.js";

type Live = {
  session: Session;
  events: CanonicalEvent[];
  messages: Array<{ id: string; role: string; content: string }>;
  status: "running" | "waiting" | "completed" | "failed";
  sequence: number;
};

export async function createAgentServer(
  options: Readonly<{
    root?: string;
    origins?: readonly string[];
    adapter?: ModelAdapter;
    provider?: string;
    model?: string;
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
  const agents = await createRegistry(root, override);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const journal = new JsonlJournal(resolve(root, ".data", "sessions"), secrets());
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

  app.get("/agents/:agentId/v1/sessions", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (agent === undefined) return context.json({ error: "unknown agent" }, 404);
    const listed = await journal.list(agent.id);
    return context.json({
      sessions: listed.map((summary) => {
        const found = live.get(keyOf(agent.id, summary.session));
        if (found?.status === "running") return { ...summary, status: "running" as const };
        if (found?.status === "waiting") return { ...summary, status: "waiting" as const };
        return summary;
      }),
    });
  });

  app.get("/agents/:agentId/v1/sessions/:session", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const key = keyOf(agent.id, context.req.param("session"));
    const found = live.get(key);
    const events = found?.events ?? (await journal.events(agent.id, context.req.param("session")));
    if (!found && events.length === 0) return context.json({ error: "unknown session" }, 404);
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
    if (!found) return context.json({ error: "session is no longer live" }, 409);
    const payload = await context.req.json<Record<string, unknown>>().catch(() => undefined);
    const interaction = payload?.interaction as Record<string, unknown> | undefined;
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
      return context.json({ session_id: context.req.param("session"), state: found.status }, 202);
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
      return context.json({ session_id: context.req.param("session"), state: found.status }, 202);
    }
    return context.json({ error: "expected approval or respond interaction" }, 400);
  });

  app.get("/agents/:agentId/v1/sessions/:session/events", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const after = Number(context.req.query("after") ?? "0");
    const session = context.req.param("session");
    const events =
      live.get(keyOf(agent.id, session))?.events ?? (await journal.events(agent.id, session));
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
        found?.messages ?? messages(await journal.events(agent.id, context.req.param("session"))),
    });
  });

  app.post("/agents/:agentId/v1/ag-ui", async (context) => {
    const agent = requireAgent(context.req.param("agentId"));
    if (!agent) return context.json({ error: "unknown agent" }, 404);
    const payload = await context.req.json<Record<string, unknown>>().catch(() => undefined);
    const threadId =
      typeof payload?.threadId === "string" && payload.threadId ? payload.threadId : randomUUID();
    const runId =
      typeof payload?.runId === "string" && payload.runId ? payload.runId : randomUUID();
    const text = latestMessage(payload?.messages);
    if (!text) return context.json({ error: "AG-UI requires a user message" }, 400);
    const found = await begin(agent, threadId, text);
    const start = found.events.length;
    await found.session.input(text).completed;
    await waitForProjectedEvents(found);
    return sse(agUiEvents(found.events.slice(start), threadId, runId), context.res.headers);
  });

  function requireAgent(id: string): ExampleAgent | undefined {
    return byId.get(id);
  }

  async function begin(agent: ExampleAgent, sessionId: string, text: string): Promise<Live> {
    const key = keyOf(agent.id, sessionId);
    const existing = live.get(key);
    if (existing) {
      existing.messages.push({ id: randomUUID(), role: "user", content: text });
      return existing;
    }
    const session = agent.agent.run({ id: sessionId });
    const entry: Live = {
      session,
      events: [],
      messages: [{ id: randomUUID(), role: "user", content: text }],
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
      void add(event.type, { ...event } as unknown as Record<string, unknown>);
    });

    void (async () => {
      for await (const event of session.stream()) {
        if (event.type === "final") {
          entry.status = "completed";
          entry.messages.push({ id: randomUUID(), role: "assistant", content: event.output });
          await add("final", { output: event.output });
        } else if (event.type === "interaction.required") {
          entry.status = "waiting";
          await add("interaction.required", { interaction: event.interaction });
        } else if (event.type === "input") {
          await add("session.run.started", {
            input_kind: event.event.kind,
            input: "text" in event.event ? event.event.text : undefined,
            approved: "approved" in event.event ? event.event.approved : undefined,
            value: "value" in event.event ? event.event.value : undefined,
          });
        }
      }
    })();

    return entry;
  }

  return Object.freeze({
    app,
    hasSession: (agentId: string, sessionId: string) => live.has(keyOf(agentId, sessionId)),
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
  };
}

function keyOf(agent: string, session: string): string {
  return `${agent}:${session}`;
}

function latestMessage(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i] as Record<string, unknown>;
    if (item?.role === "user" && typeof item.content === "string" && item.content.trim()) {
      return item.content;
    }
  }
  return undefined;
}

function pending(events: readonly CanonicalEvent[]): unknown {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "interaction.required") return events[i]!.payload.interaction;
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
  events: readonly CanonicalEvent[],
): Array<{ id: string; role: string; content: string }> {
  return events.flatMap((event) =>
    event.type === "final" && typeof event.payload.output === "string"
      ? [{ id: String(event.seq), role: "assistant", content: event.payload.output }]
      : event.type === "session.run.started" && typeof event.payload.input === "string"
        ? [{ id: String(event.seq), role: "user", content: event.payload.input }]
        : [],
  );
}

function secrets(): readonly string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => value && /key|token|secret|password|credential/iu.test(name))
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
  for (let attempt = 0; attempt < 40 && live.status === "running"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
