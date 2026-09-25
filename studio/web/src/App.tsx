import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Tabs as TabsPrimitive } from "radix-ui";
import { createClient } from "@nylorun/agents/client";
import { AppSidebar } from "@/components/app-sidebar";
import { ModelSettings } from "@/components/model-settings";
import { VaultModule } from "@/components/vault";
import { AgentManifestPanel } from "@/components/agent-manifest-panel";
import { EventDetails } from "@/components/event-details";
import { EventTable } from "@/components/event-table";
import { IterationTimeline } from "@/components/iteration-timeline";
import { SessionModelPicker } from "@/components/session-model-picker";
import { WorkflowLinkBanner } from "@/components/workflow-link-banner";
import { WorkflowTree } from "@/components/workflow-tree";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  actionLabel,
  agentOf,
  eventLabel,
  mergeStudioEvents,
  type StudioEvent,
} from "@/event-presentation";
import {
  loadBrowserStudioConfig,
  shortTenantId,
  type StudioTenantInfo,
} from "@/config";
import type {
  AgentManifest,
  Connection,
  StudioDefinition,
} from "@/studio-types";
import {
  isWorkflowManifest,
  iterationTimelineFromEvents,
  linksFromEvents,
  liveStatusFromEvents,
  lookupWorkflowLink,
  rememberWorkflowLinks,
  treeFromManifest,
  type IterationRecord,
  type WorkflowManifest,
  type WorkflowTreeNode,
} from "@/workflow";

export type { AgentManifest, Connection, SessionSummary } from "@/studio-types";

function asStudioDefinition(raw: {
  manifest: Record<string, unknown> & { id: string; name?: string };
}): StudioDefinition {
  const manifest = raw.manifest;
  if (manifest.kind === "workflow") {
    return {
      id: String(manifest.id),
      name: String(manifest.name ?? manifest.id),
      kind: "workflow",
      manifest: manifest as WorkflowManifest,
    };
  }
  const capabilities = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as {
        id: string;
        tools?: { name: string; description?: string }[];
        hooks?: { at: "before" | "after"; scope: "turn" | "step" }[];
      }[])
    : [];
  return {
    id: String(manifest.id),
    name: String(manifest.name ?? manifest.id),
    manifest: { capabilities },
  };
}

const base = () => location.origin + "/_studio/runtime";
// SDK requests travel through a trusted local proxy; this public marker is not a Runtime credential.
function studioClient(tenantId: string) {
  return createClient({
    url: base(),
    key: "studio-proxy",
    tenant: tenantId,
    fetch: (url, init) => fetch(url, init),
  });
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
  const [tenant, setTenant] = useState<StudioTenantInfo | undefined>();
  const [connection, setConnection] = useState<Connection>({
    status: "Connecting",
    agents: [],
    sessionsByAgent: {},
  });
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await loadBrowserStudioConfig();
        if (cancelled) return;
        if (!config.tenant)
          throw new Error("Studio config is missing tenant { id, name }.");
        setTenant(config.tenant);
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!tenant) return;
    try {
      const client = studioClient(tenant.id);
      const [definitions, sessions] = await Promise.all([
        client.listAgents(),
        client.listSessions(),
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
        agents: definitions.agents.map((a) =>
          asStudioDefinition({
            manifest: a.manifest as unknown as Record<string, unknown> & {
              id: string;
              name?: string;
            },
          }),
        ),
        sessionsByAgent: grouped,
      });
      setError("");
    } catch (e) {
      setError(String(e));
      setConnection((c) => ({ ...c, status: "Offline" }));
    }
  }, [tenant]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const agent = connection.agents.find((a) => a.id === agentId);
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        connection={connection}
        tenant={tenant}
        activeAgentId={agentId}
        activeSessionId={sessionId}
        settingsActive={location.pathname === "/settings"}
        vaultActive={location.pathname === "/vault"}
      />
      <SidebarInset className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <strong>
            {location.pathname === "/settings"
              ? "Model Settings"
              : location.pathname === "/vault"
                ? "Vault"
                : (agent?.name ?? "Nylorun Studio")}
          </strong>
          {tenant ? (
            <Badge variant="outline" title={tenant.id}>
              {tenant.name} · {shortTenantId(tenant.id)}
            </Badge>
          ) : (
            <Badge variant="outline">Local beta</Badge>
          )}
          <Button
            className="ml-auto"
            variant="outline"
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </header>
        {error && (
          <p role="alert" className="shrink-0 p-4 text-red-600">
            {error}
          </p>
        )}
        {location.pathname === "/settings" ? (
          <ModelSettings />
        ) : location.pathname === "/vault" ? (
          tenant ? (
            <VaultModule tenantId={tenant.id} />
          ) : (
            <p role="alert" className="p-4 text-red-600">
              Studio is missing a Tenant id.
            </p>
          )
        ) : agent && sessionId ? (
          <SessionWorkspace
            key={sessionId}
            agent={agent}
            sessionId={sessionId}
            tenantId={tenant?.id}
            refresh={refresh}
          />
        ) : (
          <section className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-8">
            <h1 className="text-2xl font-semibold">
              {agent?.name ?? "Your local agents"}
            </h1>
            <p className="my-4 text-muted-foreground">
              Start a session to chat and inspect session events.
            </p>
            {(agent ? [agent] : connection.agents).map((a) => (
              <section key={a.id} className="mb-4 rounded-lg border p-4">
                <h2 className="font-medium">{a.name}</h2>
                <p className="my-2 text-sm text-muted-foreground">
                  {a.kind === "workflow" || a.manifest.kind === "workflow"
                    ? "Workflow"
                    : a.manifest.capabilities
                        ?.flatMap((c) => c.tools ?? [])
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

function SessionWorkspace({
  agent,
  sessionId,
  tenantId,
  refresh,
}: {
  agent: AgentManifest;
  sessionId: string;
  tenantId?: string;
  refresh: () => Promise<void>;
}) {
  const workflowManifest = isWorkflowManifest(agent.manifest)
    ? agent.manifest
    : undefined;
  const isWorkflow = workflowManifest !== undefined;
  const [events, setEvents] = useState<readonly StudioEvent[]>([]);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "events" | "manifest" | "tree" | "iterations"
  >(isWorkflow ? "tree" : "events");
  const [selectedEvent, setSelectedEvent] = useState<StudioEvent | undefined>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<WorkflowTreeNode | undefined>();
  const [selectedIteration, setSelectedIteration] = useState<
    IterationRecord | undefined
  >();
  const workflowLink = lookupWorkflowLink(sessionId);

  useEffect(() => {
    if (!tenantId) {
      setError("Studio is missing a Tenant id.");
      return;
    }
    const abort = new AbortController();
    const sdk = studioClient(tenantId);
    const current = sdk.session(sessionId);
    void (async () => {
      await sdk.createSession({
        id: sessionId,
        agentId: agent.id,
        ownerUserId: "local-developer",
      });
      const history = await current.history({ signal: abort.signal });
      if (abort.signal.aborted) return;
      const loaded = mergeStudioEvents(
        [],
        history.items.map((event) => ({ ...event, committed: true })),
      );
      setEvents(loaded);
      if (isWorkflow) {
        rememberWorkflowLinks(
          linksFromEvents(loaded, sessionId, { workflowAgentId: agent.id }),
        );
      }
      const inspect = await current.inspect(abort.signal);
      setStatus(inspect.status);
      await refresh();
      for await (const event of current.observe({
        cursor: history.cursor ?? undefined,
        signal: abort.signal,
      })) {
        setEvents((previous) => {
          const next = mergeStudioEvents(previous, [
            { ...event, committed: false },
          ]);
          if (isWorkflow) {
            rememberWorkflowLinks(
              linksFromEvents(next, sessionId, { workflowAgentId: agent.id }),
            );
          }
          return next;
        });
        if (event.type.startsWith("turn.")) {
          setStatus(event.type.slice(5));
          void refresh();
        } else if (event.type === "command.message") setStatus("running");
      }
    })().catch((e) => {
      if (!abort.signal.aborted) setError(String(e));
    });
    return () => abort.abort();
  }, [sessionId, agent.id, refresh, tenantId, isWorkflow]);

  useEffect(() => {
    setSelectedEvent(undefined);
    setDetailsOpen(false);
    setSelectedNode(undefined);
    setSelectedIteration(undefined);
    setActiveTab(isWorkflow ? "tree" : "events");
  }, [sessionId, isWorkflow]);

  const busy =
    sending || ["loading", "running", "runnable", "waiting"].includes(status);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !content.trim() || busy) return;
    setSending(true);
    setStatus("running");
    setError("");
    const session = studioClient(tenantId).session(sessionId);
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

  if (!tenantId) {
    return (
      <p role="alert" className="p-4 text-red-600">
        Studio is missing a Tenant id.
      </p>
    );
  }

  const openEvent = (event: StudioEvent): void => {
    setSelectedEvent(event);
    setDetailsOpen(true);
  };
  const changeTab = (value: string): void => {
    const nextTab = value as "events" | "manifest" | "tree" | "iterations";
    setActiveTab(nextTab);
    if (nextTab !== "events") setDetailsOpen(false);
  };
  const showDetails =
    activeTab === "events" && detailsOpen && selectedEvent !== undefined;

  const chronological = [...events].reverse();
  const liveByPath = liveStatusFromEvents(chronological);
  const tree =
    workflowManifest !== undefined
      ? treeFromManifest(workflowManifest)
      : undefined;
  const iterations =
    workflowManifest !== undefined
      ? iterationTimelineFromEvents(chronological)
      : [];

  // Newest-first in the Events table; chat stays chronological.
  const chatEvents = chronological;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {workflowLink && !workflowManifest ? (
        <WorkflowLinkBanner link={workflowLink} />
      ) : null}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 overflow-hidden"
      >
      <ResizablePanel defaultSize={showDetails ? 34 : 42} minSize={28}>
        <section className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <Badge variant="outline">{status}</Badge>
            {workflowManifest ? (
              <Badge variant="secondary">workflow</Badge>
            ) : null}
            <span className="truncate font-mono text-xs text-muted-foreground">
              {sessionId}
            </span>
            {busy && status !== "loading" && (
              <Button
                className="ml-auto"
                variant="outline"
                size="sm"
                onClick={() =>
                  void studioClient(tenantId)
                    .session(sessionId)
                    .cancel({ idempotencyKey: crypto.randomUUID() })
                    .catch((e) => setError(String(e)))
                }
              >
                Cancel
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {chatEvents.map((event) => {
              const payload = event.payload as Record<string, unknown>;
              if (event.type === "command.message")
                return (
                  <article
                    key={event.eventId}
                    className="ml-8 rounded-xl bg-muted p-4"
                  >
                    <p className="mb-1 text-xs text-muted-foreground">You</p>
                    {String(payload.content ?? "")}
                  </article>
                );
              if (event.type === "turn.completed")
                return (
                  <article
                    key={event.eventId}
                    className="mr-8 rounded-xl border p-4"
                  >
                    <p className="mb-1 text-xs text-muted-foreground">
                      Assistant
                    </p>
                    <pre className="whitespace-pre-wrap font-sans">
                      {pretty(payload.output)}
                    </pre>
                  </article>
                );
              if (
                ["delegation.started", "delegation.completed"].includes(
                  event.type,
                )
              )
                return (
                  <details
                    key={event.eventId}
                    className="rounded-lg border border-dashed p-3"
                    open={event.type === "delegation.completed"}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      {eventLabel(event)} · {agentOf(payload)?.id}
                    </summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                      {pretty(
                        event.type === "delegation.started"
                          ? payload.task
                          : payload.outcome,
                      )}
                    </pre>
                  </details>
                );
              if (["action.pending", "action.completed"].includes(event.type))
                return (
                  <details
                    key={event.eventId}
                    className={
                      agentOf(payload)
                        ? "ml-6 rounded-lg border p-3"
                        : "rounded-lg border p-3"
                    }
                    open={event.type === "action.completed"}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      {actionLabel(payload)} · {event.type.slice(7)}
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
                  <p
                    key={event.eventId}
                    className="text-sm text-muted-foreground"
                  >
                    {event.type}: {pretty(payload)}
                  </p>
                );
              return null;
            })}
            {["paused", "uncertain"].includes(status) && (
              <p className="rounded border p-3 text-sm">
                This session needs attention. This release supports text and
                ordinary tools; advanced waits and reconciliation are not
                available in Studio.
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
            className="flex shrink-0 flex-col gap-2 border-t p-3"
          >
            <SessionModelPicker
              disabled={busy || ["paused", "uncertain"].includes(status)}
            />
            <div className="flex gap-3">
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
                  busy ||
                  !content.trim() ||
                  ["paused", "uncertain"].includes(status)
                }
                type="submit"
              >
                Send
              </Button>
            </div>
          </form>
        </section>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={showDetails ? 36 : 58} minSize={28}>
        <TabsPrimitive.Root
          value={activeTab}
          onValueChange={changeTab}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-end border-b bg-background px-4">
            <TabsPrimitive.List className="flex h-full items-end gap-5">
              {workflowManifest ? (
                <>
                  <TabsPrimitive.Trigger
                    value="tree"
                    className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  >
                    Tree
                  </TabsPrimitive.Trigger>
                  <TabsPrimitive.Trigger
                    value="iterations"
                    className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  >
                    Iterations
                  </TabsPrimitive.Trigger>
                </>
              ) : null}
              <TabsPrimitive.Trigger
                value="events"
                className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
              >
                Events
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="manifest"
                className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
              >
                {workflowManifest ? "Manifest" : "Agent Manifest"}
              </TabsPrimitive.Trigger>
            </TabsPrimitive.List>
          </div>
          {tree ? (
            <TabsPrimitive.Content
              value="tree"
              className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
            >
              <WorkflowTree
                root={tree}
                liveByPath={liveByPath}
                selectedPath={selectedNode?.path}
                onSelect={setSelectedNode}
              />
              {selectedNode ? (
                <p className="shrink-0 border-t px-4 py-2 font-mono text-xs text-muted-foreground">
                  {selectedNode.path}
                  {selectedNode.kind === "item" || selectedNode.kind === "map"
                    ? " · item drill-down"
                    : ""}
                  {liveByPath.get(selectedNode.path)?.agentSessionId
                    ? ` · agent session ${liveByPath.get(selectedNode.path)?.agentSessionId}`
                    : ""}
                </p>
              ) : null}
            </TabsPrimitive.Content>
          ) : null}
          {workflowManifest ? (
            <TabsPrimitive.Content
              value="iterations"
              className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
            >
              <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
                <h2 className="text-sm font-medium">Iteration timeline</h2>
              </div>
              <IterationTimeline
                rows={iterations}
                selected={selectedIteration}
                onSelect={setSelectedIteration}
              />
            </TabsPrimitive.Content>
          ) : null}
          <TabsPrimitive.Content
            value="events"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <EventTable
              events={events}
              selected={selectedEvent}
              onSelect={openEvent}
            />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="manifest"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <AgentManifestPanel agent={agent} />
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
      </ResizablePanel>
      {showDetails ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={30} minSize={22}>
            <EventDetails
              event={selectedEvent}
              onClose={() => {
                setDetailsOpen(false);
                setSelectedEvent(undefined);
              }}
            />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
    </div>
  );
}
