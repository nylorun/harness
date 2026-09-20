import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { createClient, type LiveEvent } from "@nylorun/agents";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
export type AgentManifest = {
  id: string;
  name: string;
  manifest: {
    capabilities: readonly {
      id: string;
      tools?: readonly { name: string; description?: string }[];
    }[];
  };
};
export type SessionSummary = {
  session: string;
  status: string;
  title?: string;
  startedAt: number;
};
export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly AgentManifest[];
  sessionsByAgent: Record<string, SessionSummary[]>;
};
const base = () => location.origin + "/_studio/runtime";
// SDK requests travel through a trusted local proxy; this public marker is not a Runtime credential.
const client = () =>
  createClient({
    url: base(),
    key: "studio-proxy",
    fetch: (url, init) => fetch(url, init),
  });
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base() + path, { signal });
  if (!response.ok)
    throw new Error(`Runtime request failed (${response.status})`);
  return response.json();
}
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<Workspace />} />
      </Routes>
    </BrowserRouter>
  );
}
function Workspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const match = location.pathname.match(
    /^\/agents\/([^/]+)(?:\/sessions\/([^/]+))?/,
  );
  const agentId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  const sessionId = match?.[2] ? decodeURIComponent(match[2]) : undefined;
  const [connection, setConnection] = useState<Connection>({
    status: "Connecting",
    agents: [],
    sessionsByAgent: {},
  });
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [definitions, sessions] = await Promise.all([
        get<{
          agents: {
            manifest: AgentManifest["manifest"] & { id: string; name: string };
          }[];
        }>("/v1/agents"),
        get<{ sessions: { id: string; agentId: string; status: string }[] }>(
          "/v1/sessions",
        ),
      ]);
      const grouped: Connection["sessionsByAgent"] = {};
      for (const s of sessions.sessions)
        (grouped[s.agentId] ??= []).push({
          session: s.id,
          status: s.status,
          title: s.id.slice(0, 8),
          startedAt: 0,
        });
      setConnection({
        status: "Running",
        url: "Local Runtime",
        agents: definitions.agents.map((a) => ({
          id: a.manifest.id,
          name: a.manifest.name,
          manifest: a.manifest,
        })),
        sessionsByAgent: grouped,
      });
      setError("");
    } catch (e) {
      setError(String(e));
      setConnection((c) => ({ ...c, status: "Offline" }));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const agent = connection.agents.find((a) => a.id === agentId);
  return (
    <SidebarProvider>
      <AppSidebar
        connection={connection}
        activeAgentId={agentId}
        activeSessionId={sessionId}
      />
      <SidebarInset>
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <strong>{agent?.name ?? "Nylorun Studio"}</strong>
          <Badge variant="outline">Local beta</Badge>
          <Button
            className="ml-auto"
            variant="outline"
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </header>
        {error && (
          <p role="alert" className="p-4 text-red-600">
            {error}
          </p>
        )}
        {agent && sessionId ? (
          <Conversation
            key={sessionId}
            agent={agent}
            sessionId={sessionId}
            refresh={refresh}
          />
        ) : (
          <section className="mx-auto w-full max-w-3xl p-8">
            <h1 className="text-2xl font-semibold">
              {agent?.name ?? "Your local agents"}
            </h1>
            <p className="my-4 text-muted-foreground">
              Start a session to chat and inspect tool calls.
            </p>
            {(agent ? [agent] : connection.agents).map((a) => (
              <section key={a.id} className="mb-4 rounded-lg border p-4">
                <h2 className="font-medium">{a.name}</h2>
                <p className="my-2 text-sm text-muted-foreground">
                  {a.manifest.capabilities
                    .flatMap((c) => c.tools ?? [])
                    .map((t) => t.name)
                    .join(", ") || "Text agent"}
                </p>
                <Button
                  onClick={() =>
                    void navigate(
                      `/agents/${encodeURIComponent(a.id)}/sessions/${crypto.randomUUID()}`,
                    )
                  }
                >
                  New session
                </Button>
              </section>
            ))}
          </section>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
function Conversation({
  agent,
  sessionId,
  refresh,
}: {
  agent: AgentManifest;
  sessionId: string;
  refresh: () => Promise<void>;
}) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const session = client().session(sessionId);
  useEffect(() => {
    const abort = new AbortController();
    const sdk = client();
    const current = sdk.session(sessionId);
    void (async () => {
      await sdk.createSession({
        id: sessionId,
        agentId: agent.id,
        ownerUserId: "local-developer",
      });
      const history = await current.history({ signal: abort.signal });
      if (abort.signal.aborted) return;
      setEvents(history.items);
      const inspect = await current.inspect(abort.signal);
      setStatus(inspect.status);
      await refresh();
      for await (const event of current.observe({
        cursor: history.cursor ?? undefined,
        signal: abort.signal,
      })) {
        setEvents((previous) =>
          previous.some((e) => e.eventId === event.eventId)
            ? previous
            : [...previous, event],
        );
        if (event.type.startsWith("turn.")) {
          setStatus(event.type.slice(5));
          void refresh();
        } else if (event.type === "command.message") setStatus("running");
      }
    })().catch((e) => {
      if (!abort.signal.aborted) setError(String(e));
    });
    return () => abort.abort();
  }, [sessionId, agent.id, refresh]);
  const busy =
    sending || ["loading", "running", "runnable", "waiting"].includes(status);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim() || busy) return;
    setSending(true);
    setStatus("running");
    setError("");
    try {
      await session.input(content, { idempotencyKey: crypto.randomUUID() });
      setContent("");
    } catch (e) {
      setError(String(e));
      try {
        setStatus((await session.inspect()).status);
      } catch {
        setStatus("idle");
      }
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <Badge variant="outline">{status}</Badge>
        <span className="text-xs text-muted-foreground">{sessionId}</span>
        {busy && status !== "loading" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void session
                .cancel({ idempotencyKey: crypto.randomUUID() })
                .catch((e) => setError(String(e)))
            }
          >
            Cancel
          </Button>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 overflow-auto p-6">
        {events.map((event) => {
          const payload = event.payload as any;
          if (event.type === "command.message")
            return (
              <article
                key={event.eventId}
                className="ml-12 rounded-xl bg-muted p-4"
              >
                <p className="mb-1 text-xs text-muted-foreground">You</p>
                {payload.content}
              </article>
            );
          if (event.type === "turn.completed")
            return (
              <article
                key={event.eventId}
                className="mr-12 rounded-xl border p-4"
              >
                <p className="mb-1 text-xs text-muted-foreground">Assistant</p>
                <pre className="whitespace-pre-wrap font-sans">
                  {pretty(payload.output)}
                </pre>
              </article>
            );
          if (["action.pending", "action.completed"].includes(event.type))
            return (
              <details
                key={event.eventId}
                className="rounded-lg border p-3"
                open={event.type === "action.completed"}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  Tool · {payload.toolName ?? payload.actionId} ·{" "}
                  {event.type.slice(7)}
                </summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                  {pretty(
                    event.type === "action.pending"
                      ? payload.input
                      : payload.result,
                  )}
                </pre>
              </details>
            );
          if (
            ["turn.failed", "turn.cancelled", "turn.uncertain"].includes(
              event.type,
            )
          )
            return (
              <p key={event.eventId} className="text-sm text-muted-foreground">
                {event.type}: {pretty(payload)}
              </p>
            );
          return null;
        })}
        {["paused", "uncertain"].includes(status) && (
          <p className="rounded border p-3 text-sm">
            This session needs attention. This release supports text and
            ordinary tools; advanced waits and reconciliation are not available
            in Studio.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
      </div>
      <form
        onSubmit={submit}
        className="mx-auto flex w-full max-w-3xl gap-3 border-t p-4"
      >
        <textarea
          aria-label="Message"
          className="min-h-20 flex-1 resize-none rounded-md border bg-background p-3"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Look up order demo-123"
          disabled={busy || ["paused", "uncertain"].includes(status)}
        />
        <Button
          disabled={
            busy || !content.trim() || ["paused", "uncertain"].includes(status)
          }
          type="submit"
        >
          Send
        </Button>
      </form>
    </section>
  );
}
