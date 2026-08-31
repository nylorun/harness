import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { HttpAgent } from "@ag-ui/client";
import { Activity, CirclePlus, LoaderCircle, SendHorizontal, ServerOff, X } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppSidebar } from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadBrowserStudioConfig } from "./config";
import { eventLabel, eventSummary, type CanonicalEvent } from "./event-presentation";

export type AgentManifest = Readonly<{ protocolVersion: number; id: string; name: string; description: string; capabilities: readonly string[]; requirements?: Record<string, boolean>; model: { provider: string; id: string }; harness: { name: string; version: string; manifest: { middleware?: readonly { id: string }[] } }; endpoints: { agUi: string; sessions: string }; records?: { path: string } }>;
type Discovery = Readonly<{ protocolVersion: number; agents: readonly { id: string; manifestUrl: string }[] }>;
export type SessionSummary = Readonly<{ session: string; status: string; startedAt: number; endedAt?: number; events: number }>;
type PendingInteraction = Readonly<{ id: string; kind: "approval" | "response"; prompt: string }>;
type ChatMessage = Readonly<{ id: string; role: string; content: string }>;
export type Connection = Readonly<{ status: "Connecting" | "Running" | "Offline"; url?: string; agents: readonly AgentManifest[]; sessionsByAgent: Readonly<Record<string, readonly SessionSummary[]>> }>;

function endpoint(base: string, value: string): string { return new URL(value, base + "/").toString(); }
function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }
function date(value?: number | string): string { return value === undefined ? "—" : new Date(value).toLocaleString(); }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return "Unserializable value"; } }
function requestError(cause: unknown, fallback: string): string {
  if (cause instanceof TypeError && cause.message === "Failed to fetch") {
    return "Studio could not reach the agent server. Confirm it is running, then retry.";
  }
  return cause instanceof Error ? cause.message : fallback;
}
function agentPath(agentId: string): string { return "/agents/" + encodeURIComponent(agentId); }
function sessionPath(agentId: string, sessionId: string): string { return agentPath(agentId) + "/sessions/" + encodeURIComponent(sessionId); }

function useConnection(): Connection {
  const [connection, setConnection] = useState<Connection>({ status: "Connecting", agents: [], sessionsByAgent: {} });
  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const config = await loadBrowserStudioConfig();
        if (config.agentServerUrl === undefined) throw new Error("No Agent Server URL configured.");
        const response = await fetch(endpoint(config.agentServerUrl, "/v1/agents"), { cache: "no-store" });
        if (!response.ok) throw new Error("Agent Server returned " + response.status + ".");
        const discovery = await response.json() as Discovery;
        if (discovery.protocolVersion !== 1 || !Array.isArray(discovery.agents)) throw new Error("Unsupported Studio discovery document.");
        const agents = await Promise.all(discovery.agents.map(async (entry) => {
          const manifest = await fetch(endpoint(config.agentServerUrl!, entry.manifestUrl), { cache: "no-store" });
          if (!manifest.ok) throw new Error("Manifest for " + entry.id + " returned " + manifest.status + ".");
          const raw = await manifest.json() as AgentManifest;
          return { ...raw, endpoints: { agUi: endpoint(config.agentServerUrl!, raw.endpoints.agUi), sessions: endpoint(config.agentServerUrl!, raw.endpoints.sessions) } };
        }));
        if (!disposed) setConnection((previous) => ({ status: "Running", url: config.agentServerUrl, agents, sessionsByAgent: previous.sessionsByAgent }));
      } catch {
        if (!disposed) setConnection((previous) => ({ ...previous, status: "Offline" }));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (connection.status !== "Running" || connection.agents.length === 0) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const results = await Promise.all(connection.agents.map(async (agent) => {
        try {
          const response = await fetch(agent.endpoints.sessions, { cache: "no-store" });
          if (!response.ok) return [agent.id, undefined] as const;
          const payload = await response.json() as { sessions: SessionSummary[] };
          return [agent.id, [...payload.sessions].sort((left, right) => right.startedAt - left.startedAt)] as const;
        } catch { return [agent.id, undefined] as const; }
      }));
      if (cancelled) return;
      setConnection((previous) => {
        const sessionsByAgent = { ...previous.sessionsByAgent };
        for (const [agentId, sessions] of results) if (sessions !== undefined) sessionsByAgent[agentId] = sessions;
        return { ...previous, sessionsByAgent };
      });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connection.status, connection.agents]);
  return connection;
}

function Empty({ title, detail, action }: Readonly<{ title: string; detail: string; action?: ReactNode }>) {
  return <div className="grid h-full min-h-52 place-items-center p-8 text-center"><div><h2 className="font-medium">{title}</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">{detail}</p>{action === undefined ? null : <div className="mt-4 flex justify-center">{action}</div>}</div></div>;
}
function Tokens({ values }: Readonly<{ values: readonly string[] }>) { return values.length === 0 ? <p className="text-sm text-muted-foreground">None declared</p> : <div className="flex flex-wrap gap-2">{values.map((value) => <Badge key={value} variant="secondary">{value}</Badge>)}</div>; }
function ConnectionIndicator({ connection }: Readonly<{ connection: Connection }>) {
  const running = connection.status === "Running";
  const className = running ? "bg-emerald-500" : connection.status === "Connecting" ? "bg-amber-500" : "bg-muted-foreground";
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><span className={"size-2 rounded-full " + className} />{connection.status === "Connecting" ? <LoaderCircle className="size-3 animate-spin" /> : running ? <Activity className="size-3" /> : <ServerOff className="size-3" />}<span>{connection.status}</span></div>;
}
function AppHeader({ connection }: Readonly<{ connection: Connection }>) {
  const location = useLocation();
  const navigate = useNavigate();
  const match = location.pathname.match(/^\/agents\/([^/]+)/u);
  const agent = connection.agents.find((entry) => entry.id === decodeURIComponent(match?.[1] ?? ""));
  const startSession = (): void => { if (agent !== undefined) navigate(sessionPath(agent.id, crypto.randomUUID())); };
  return <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger /><div className="min-w-0"><p className="truncate text-sm font-medium">{agent === undefined ? "Nylorun Studio" : agent.name}</p><p className="truncate text-xs text-muted-foreground">{agent === undefined ? "Select an agent and session" : agent.id}</p></div><div className="ml-auto flex items-center gap-3"><Button variant="outline" size="sm" disabled={connection.status !== "Running" || agent === undefined} onClick={startSession}><CirclePlus className="size-4" />New session</Button><ConnectionIndicator connection={connection} /></div></header>;
}

function Chat({ agent, sessionId }: Readonly<{ agent: AgentManifest; sessionId: string }>) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingInteraction | undefined>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const history = await fetch(agent.endpoints.agUi.replace(/\/$/u, "") + "/sessions/" + encodeURIComponent(sessionId), { cache: "no-store" });
      if (history.ok && !cancelled) setMessages((await history.json() as { messages: ChatMessage[] }).messages);
      const summary = await fetch(agent.endpoints.sessions.replace(/\/$/u, "") + "/" + encodeURIComponent(sessionId), { cache: "no-store" });
      if (summary.ok && !cancelled) setPending((await summary.json() as { pending_interaction?: PendingInteraction }).pending_interaction);
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [agent.endpoints.agUi, agent.endpoints.sessions, sessionId]);
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput(""); setSending(true); setError(undefined);
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: text }]);
    try {
      const runner = new HttpAgent({ url: agent.endpoints.agUi, threadId: sessionId });
      runner.addMessage({ id: crypto.randomUUID(), role: "user", content: text } as never);
      await runner.runAgent({ runId: crypto.randomUUID() }, { onNewMessage: ({ message }) => {
        const value = message as unknown as { id?: string; role?: string; content?: unknown };
        setMessages((current) => [...current, { id: value.id ?? crypto.randomUUID(), role: value.role ?? "assistant", content: typeof value.content === "string" ? value.content : pretty(value.content) }]);
      } });
    } catch (cause) { setError(requestError(cause, "Agent request failed.")); } finally { setSending(false); }
  };
  const interact = async (approved: boolean): Promise<void> => {
    if (pending === undefined) return;
    setSending(true);
    try {
      const response = await fetch(agent.endpoints.sessions.replace(/\/$/u, "") + "/" + encodeURIComponent(sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ interaction: { id: pending.id, kind: "approval", approved } }) });
      if (!response.ok) throw new Error("Approval returned " + response.status + ".");
      setPending(undefined);
    } catch (cause) { setError(requestError(cause, "Approval failed.")); } finally { setSending(false); }
  };
  return <section className="flex min-h-0 flex-1 flex-col"><div className="flex h-12 shrink-0 items-center border-b px-4"><h1 className="text-sm font-medium">Chat</h1><span className="ml-auto font-mono text-xs text-muted-foreground">{shortId(sessionId)}</span></div><ScrollArea className="min-h-0 flex-1"><div className="space-y-4 p-4">{messages.length === 0 ? <p className="text-sm text-muted-foreground">Start the conversation to run this session.</p> : messages.map((message) => <article key={message.id} className={"max-w-3xl rounded-lg px-4 py-3 text-sm " + (message.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted")}><p className="mb-1 text-xs opacity-70">{message.role}</p><p className="whitespace-pre-wrap">{message.content}</p></article>)}{pending !== undefined && <section className="rounded-lg border border-amber-400/50 bg-amber-50 p-4 text-sm"><p className="font-medium">Approval required</p><p className="mt-1">{pending.prompt}</p><div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void interact(true)}>Approve</Button><Button size="sm" variant="outline" onClick={() => void interact(false)}>Deny</Button></div></section>}{error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}</div></ScrollArea><form onSubmit={send} className="flex shrink-0 gap-2 border-t p-3"><Input value={input} onChange={(event) => setInput(event.target.value)} disabled={sending || pending !== undefined} placeholder="Message the agent…" /><Button type="submit" size="icon" disabled={sending || pending !== undefined || !input.trim()}><SendHorizontal className="size-4" /><span className="sr-only">Send message</span></Button></form></section>;
}

function Manifest({ agent }: Readonly<{ agent: AgentManifest }>) {
  const middleware = agent.harness.manifest.middleware ?? [];
  const requirements = Object.entries(agent.requirements ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  return <ScrollArea className="min-h-0 flex-1"><div className="space-y-4 p-4"><section><h2 className="text-sm font-medium">{agent.name}</h2><p className="mt-1 text-sm text-muted-foreground">{agent.description}</p><p className="mt-2 font-mono text-xs text-muted-foreground">{agent.id}</p></section><section className="rounded-lg border p-4"><h3 className="text-sm font-medium">Model</h3><dl className="mt-3 grid gap-3 text-sm"><div><dt className="text-muted-foreground">Provider</dt><dd>{agent.model.provider}</dd></div><div><dt className="text-muted-foreground">Model</dt><dd>{agent.model.id}</dd></div></dl></section><section className="rounded-lg border p-4"><h3 className="text-sm font-medium">Capabilities</h3><div className="mt-3"><Tokens values={agent.capabilities} /></div></section><section className="rounded-lg border p-4"><h3 className="text-sm font-medium">Harness</h3><dl className="mt-3 grid gap-3 text-sm"><div><dt className="text-muted-foreground">Package</dt><dd>{agent.harness.name} {agent.harness.version}</dd></div><div><dt className="text-muted-foreground">Middleware</dt><dd className="mt-1"><Tokens values={middleware.map((entry) => entry.id)} /></dd></div></dl></section><section className="rounded-lg border p-4"><h3 className="text-sm font-medium">Requirements</h3><div className="mt-3"><Tokens values={requirements} /></div><p className="mt-4 text-xs text-muted-foreground">Records: {agent.records?.path ?? "not reported"}</p></section></div></ScrollArea>;
}
function EventTable({ events, selected, onSelect }: Readonly<{ events: readonly CanonicalEvent[]; selected?: CanonicalEvent; onSelect: (event: CanonicalEvent) => void }>) {
  const [filter, setFilter] = useState("all");
  const eventTypes = useMemo(() => [...new Set(events.map((event) => event.type))].sort(), [events]);
  const visibleEvents = filter === "all" ? events : events.filter((event) => event.type === filter);
  return <section className="flex min-h-0 flex-1 flex-col"><div className="flex h-12 shrink-0 items-center gap-3 border-b px-4"><h2 className="text-sm font-medium">Events</h2><Select value={filter} onValueChange={setFilter}><SelectTrigger size="sm" className="ml-auto w-44"><SelectValue placeholder="All event types" /></SelectTrigger><SelectContent><SelectItem value="all">All event types</SelectItem>{eventTypes.map((type) => <SelectItem key={type} value={type}>{eventLabel({ type } as CanonicalEvent)}</SelectItem>)}</SelectContent></Select></div><ScrollArea className="min-h-0 flex-1"><Table><TableHeader className="sticky top-0 z-10 bg-background"><TableRow><TableHead className="w-14">Seq</TableHead><TableHead className="w-40">Time</TableHead><TableHead className="w-40">Type</TableHead><TableHead>Summary</TableHead></TableRow></TableHeader><TableBody>{visibleEvents.length === 0 ? <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">{events.length === 0 ? "Events will appear when the agent runs." : "No events match this type."}</TableCell></TableRow> : visibleEvents.map((event) => <TableRow key={event.seq} data-state={selected?.seq === event.seq ? "selected" : undefined} className="cursor-pointer" onClick={() => onSelect(event)}><TableCell className="font-mono text-xs">{event.seq}</TableCell><TableCell className="text-xs text-muted-foreground">{date(event.ts)}</TableCell><TableCell><Badge variant="secondary">{eventLabel(event)}</Badge></TableCell><TableCell className="max-w-0 truncate text-xs text-muted-foreground">{eventSummary(event)}</TableCell></TableRow>)}</TableBody></Table></ScrollArea></section>;
}
function EventDetails({ event, onClose }: Readonly<{ event: CanonicalEvent; onClose: () => void }>) {
  return <section className="flex min-h-0 flex-1 flex-col"><header className="flex h-12 shrink-0 items-center gap-3 border-b px-4"><div className="min-w-0"><h2 className="truncate text-sm font-medium">{eventLabel(event)}</h2><p className="font-mono text-xs text-muted-foreground">Event {event.seq}</p></div><Button className="ml-auto" size="icon" variant="ghost" onClick={onClose}><X className="size-4" /><span className="sr-only">Close event details</span></Button></header><ScrollArea className="min-h-0 flex-1"><div className="space-y-4 p-4"><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">Sequence</dt><dd>{event.seq}</dd><dt className="text-muted-foreground">Timestamp</dt><dd>{date(event.ts)}</dd><dt className="text-muted-foreground">Type</dt><dd>{event.type}</dd></dl><section><h3 className="text-sm font-medium">Canonical event</h3><pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs leading-5">{pretty(event)}</pre></section></div></ScrollArea></section>;
}

function SessionWorkspace({ agent, sessionId }: Readonly<{ agent: AgentManifest; sessionId: string }>) {
  const [events, setEvents] = useState<readonly CanonicalEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"events" | "manifest">("events");
  const [selectedEvent, setSelectedEvent] = useState<CanonicalEvent | undefined>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const url = agent.endpoints.sessions.replace(/\/$/u, "") + "/" + encodeURIComponent(sessionId) + "/events?after=0&limit=1000";
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok && !cancelled) {
        const payload = await response.json() as { events: CanonicalEvent[] };
        setEvents([...payload.events].sort((left, right) => right.seq - left.seq));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [agent.endpoints.sessions, sessionId]);
  useEffect(() => { setSelectedEvent(undefined); setDetailsOpen(false); setActiveTab("events"); }, [sessionId]);
  const openEvent = (event: CanonicalEvent): void => { setSelectedEvent(event); setDetailsOpen(true); };
  const changeTab = (value: string): void => { const nextTab = value as "events" | "manifest"; setActiveTab(nextTab); if (nextTab === "manifest") setDetailsOpen(false); };
  const showDetails = activeTab === "events" && detailsOpen && selectedEvent !== undefined;
  return <ResizablePanelGroup key={showDetails ? "details" : "workspace"} orientation="horizontal" className="min-h-0 flex-1"><ResizablePanel defaultSize={showDetails ? 38 : 50} minSize={28}><Chat agent={agent} sessionId={sessionId} /></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize={showDetails ? 37 : 50} minSize={28}><TabsPrimitive.Root value={activeTab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col"><div className="flex h-12 shrink-0 items-end border-b px-4"><TabsPrimitive.List className="flex h-full items-end gap-5"><TabsPrimitive.Trigger value="events" className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground">Events</TabsPrimitive.Trigger><TabsPrimitive.Trigger value="manifest" className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground">Agent Manifest</TabsPrimitive.Trigger></TabsPrimitive.List></div><TabsPrimitive.Content value="events" className="min-h-0 flex-1 outline-none"><EventTable events={events} selected={selectedEvent} onSelect={openEvent} /></TabsPrimitive.Content><TabsPrimitive.Content value="manifest" className="min-h-0 flex-1 outline-none"><Manifest agent={agent} /></TabsPrimitive.Content></TabsPrimitive.Root></ResizablePanel>{showDetails ? <><ResizableHandle withHandle /><ResizablePanel defaultSize={25} minSize={20}><EventDetails event={selectedEvent} onClose={() => { setDetailsOpen(false); setSelectedEvent(undefined); }} /></ResizablePanel></> : null}</ResizablePanelGroup>;
}
function StudioWorkspace({ connection }: Readonly<{ connection: Connection }>) {
  const { agentId = "", sessionId } = useParams();
  const navigate = useNavigate();
  const agent = connection.agents.find((entry) => entry.id === agentId);
  if (agentId === "") return <Empty title="Choose an agent" detail="Select an agent and one of its sessions from the navigation." />;
  if (agent === undefined) return <Empty title="Agent not found" detail="This agent is not currently exposed by the connected agent server." />;
  if (sessionId === undefined) return <Empty title="Choose a session" detail="Select a saved session from the navigation, or start a new conversation with this agent." action={<Button onClick={() => navigate(sessionPath(agent.id, crypto.randomUUID()))}><CirclePlus className="size-4" />New session</Button>} />;
  return <SessionWorkspace agent={agent} sessionId={sessionId} />;
}
function Shell() {
  const connection = useConnection();
  const location = useLocation();
  const match = location.pathname.match(/^\/agents\/([^/]+)(?:\/sessions\/([^/]+))?/u);
  const activeAgentId = match === null ? undefined : decodeURIComponent(match[1]);
  const activeSessionId = match?.[2];
  return <SidebarProvider><AppSidebar connection={connection} activeAgentId={activeAgentId} activeSessionId={activeSessionId} /><SidebarInset className="h-svh min-w-0"><AppHeader connection={connection} /><div className="flex min-h-0 flex-1"><Routes><Route path="/" element={<StudioWorkspace connection={connection} />} /><Route path="/agents/:agentId" element={<StudioWorkspace connection={connection} />} /><Route path="/agents/:agentId/sessions/:sessionId" element={<StudioWorkspace connection={connection} />} /></Routes></div></SidebarInset></SidebarProvider>;
}
export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
