import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { HttpAgent } from "@ag-ui/client";
import dayjs from "dayjs";
import { ChevronDown, CirclePlus, X } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatComposer, type ImageAttachment } from "@/components/chat-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadBrowserStudioConfig } from "./config";
import {
  eventLabel,
  eventSummary,
  type CanonicalEvent,
} from "./event-presentation";

export type MiddlewareManifest = Readonly<{
  id: string;
  instructions?: readonly string[];
  tools?: readonly Readonly<{ name: string; description?: string }>[];
  model?: Readonly<{
    id?: string;
    controls?: Readonly<{ temperature?: number; maxOutputTokens?: number }>;
  }>;
}>;
export type AgentManifest = Readonly<{
  protocolVersion: number;
  id: string;
  name: string;
  harness: {
    manifest: {
      id: string;
      name: string;
      middleware: readonly MiddlewareManifest[];
    };
  };
  endpoints: { agUi: string; sessions: string };
  mediaInput?: Readonly<{ acceptedTypes: readonly string[]; maxBytes: number }>;
}>;
type Discovery = Readonly<{
  protocolVersion: number;
  agents: readonly { id: string; manifestUrl: string }[];
}>;
export type SessionSummary = Readonly<{
  session: string;
  title?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
}>;
type PendingInteraction = Readonly<{
  id: string;
  kind: "approval" | "response";
  prompt: string;
}>;
type ChatContent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; url: string; mediaType: string }>
  | Readonly<{ type: "json"; value: unknown }>;
type ChatMessage = Readonly<{
  id: string;
  role: string;
  content: readonly ChatContent[];
}>;
export type Connection = Readonly<{
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly AgentManifest[];
  sessionsByAgent: Readonly<Record<string, readonly SessionSummary[]>>;
}>;

function endpoint(base: string, value: string): string {
  return new URL(value, base + "/").toString();
}
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}
function date(value?: number | string): string {
  return value === undefined ? "—" : dayjs(value).format("HH:mm:ss");
}
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unserializable value";
  }
}
type ModelRequestDigests = Readonly<{
  prompt: string;
  tools: string;
  model: string;
  output: string;
  configuration: string;
  context: string;
}>;
function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
function modelRequestDigests(
  event: CanonicalEvent,
): ModelRequestDigests | undefined {
  if (event.type !== "model.requested") return undefined;
  const value = record(record(event.payload).digests);
  const fields = [
    "prompt",
    "tools",
    "model",
    "output",
    "configuration",
    "context",
  ] as const;
  if (
    !fields.every(
      (field) =>
        typeof value[field] === "string" &&
        /^[a-f0-9]{64}$/u.test(value[field]),
    )
  )
    return undefined;
  return value as ModelRequestDigests;
}
function requestError(cause: unknown, fallback: string): string {
  if (cause instanceof TypeError && cause.message === "Failed to fetch") {
    return "Studio could not reach the agent server. Confirm it is running, then retry.";
  }
  return cause instanceof Error ? cause.message : fallback;
}
function agentPath(agentId: string): string {
  return "/agents/" + encodeURIComponent(agentId);
}
function sessionPath(agentId: string, sessionId: string): string {
  return agentPath(agentId) + "/sessions/" + encodeURIComponent(sessionId);
}

function chatText(value: unknown): readonly ChatContent[] {
  return typeof value === "string"
    ? [{ type: "text", text: value }]
    : [{ type: "json", value }];
}

function useConnection(): Connection {
  const [connection, setConnection] = useState<Connection>({
    status: "Connecting",
    agents: [],
    sessionsByAgent: {},
  });
  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const config = await loadBrowserStudioConfig();
        if (config.agentServerUrl === undefined)
          throw new Error("No Agent Server URL configured.");
        const response = await fetch(
          endpoint(config.agentServerUrl, "/v1/agents"),
          { cache: "no-store" },
        );
        if (!response.ok)
          throw new Error("Agent Server returned " + response.status + ".");
        const discovery = (await response.json()) as Discovery;
        if (discovery.protocolVersion !== 1 || !Array.isArray(discovery.agents))
          throw new Error("Unsupported Studio discovery document.");
        const agents = await Promise.all(
          discovery.agents.map(async (entry) => {
            const manifest = await fetch(
              endpoint(config.agentServerUrl!, entry.manifestUrl),
              { cache: "no-store" },
            );
            if (!manifest.ok)
              throw new Error(
                "Manifest for " +
                  entry.id +
                  " returned " +
                  manifest.status +
                  ".",
              );
            const raw = (await manifest.json()) as AgentManifest;
            return {
              ...raw,
              endpoints: {
                agUi: endpoint(config.agentServerUrl!, raw.endpoints.agUi),
                sessions: endpoint(
                  config.agentServerUrl!,
                  raw.endpoints.sessions,
                ),
              },
            };
          }),
        );
        if (!disposed)
          setConnection((previous) => ({
            status: "Running",
            url: config.agentServerUrl,
            agents,
            sessionsByAgent: previous.sessionsByAgent,
          }));
      } catch {
        if (!disposed)
          setConnection((previous) => ({ ...previous, status: "Offline" }));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (connection.status !== "Running" || connection.agents.length === 0)
      return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const results = await Promise.all(
        connection.agents.map(async (agent) => {
          try {
            const response = await fetch(agent.endpoints.sessions, {
              cache: "no-store",
            });
            if (!response.ok) return [agent.id, undefined] as const;
            const payload = (await response.json()) as {
              sessions: SessionSummary[];
            };
            return [
              agent.id,
              [...payload.sessions].sort(
                (left, right) => right.startedAt - left.startedAt,
              ),
            ] as const;
          } catch {
            return [agent.id, undefined] as const;
          }
        }),
      );
      if (cancelled) return;
      setConnection((previous) => {
        const sessionsByAgent = { ...previous.sessionsByAgent };
        for (const [agentId, sessions] of results)
          if (sessions !== undefined) sessionsByAgent[agentId] = sessions;
        return { ...previous, sessionsByAgent };
      });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connection.status, connection.agents]);
  return connection;
}

function Empty({
  title,
  detail,
  action,
}: Readonly<{ title: string; detail: string; action?: ReactNode }>) {
  return (
    <div className="relative grid h-full min-h-52 place-items-center p-8 text-center">
      <div className="absolute left-2 top-2">
        <SidebarTrigger />
      </div>
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{detail}</p>
        {action === undefined ? null : (
          <div className="mt-4 flex justify-center">{action}</div>
        )}
      </div>
    </div>
  );
}
function Tokens({ values }: Readonly<{ values: readonly string[] }>) {
  return (
    <p className="text-sm">
      {values.length === 0 ? (
        <span className="text-muted-foreground">None declared</span>
      ) : (
        values.join(", ")
      )}
    </p>
  );
}
function EmptyValue() {
  return <span className="text-muted-foreground">None declared</span>;
}
function constructorInstructions(
  middleware: readonly MiddlewareManifest[],
): readonly string[] {
  return middleware.find((entry) => entry.id === "agent")?.instructions ?? [];
}
function InstructionList({ values }: Readonly<{ values: readonly string[] }>) {
  if (values.length === 0)
    return (
      <p className="mt-2 text-sm">
        <EmptyValue />
      </p>
    );
  return (
    <div className="mt-2 space-y-2">
      {values.map((text, index) => (
        <p key={index} className="whitespace-pre-wrap text-sm">
          {text}
        </p>
      ))}
    </div>
  );
}
function ToolList({
  tools,
}: Readonly<{
  tools: readonly Readonly<{ name: string; description?: string }>[];
}>) {
  if (tools.length === 0) return <EmptyValue />;
  return (
    <ul className="space-y-1">
      {tools.map((tool) => (
        <li key={tool.name}>
          <span className="font-mono text-xs">{tool.name}</span>
          {tool.description === undefined ? null : (
            <span className="text-muted-foreground"> — {tool.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
function CompactModel({
  model,
}: Readonly<{ model?: MiddlewareManifest["model"] }>) {
  if (model === undefined) return <EmptyValue />;
  const details = [
    model.id,
    model.controls?.temperature === undefined
      ? undefined
      : `temperature ${model.controls.temperature}`,
    model.controls?.maxOutputTokens === undefined
      ? undefined
      : `max ${model.controls.maxOutputTokens}`,
  ].filter((item): item is string => item !== undefined);
  return details.length === 0 ? (
    <EmptyValue />
  ) : (
    <span>{details.join(" · ")}</span>
  );
}

function Chat({
  agent,
  sessionId,
}: Readonly<{ agent: AgentManifest; sessionId: string }>) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | undefined>();
  const [pending, setPending] = useState<PendingInteraction | undefined>();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const history = await fetch(
        agent.endpoints.agUi.replace(/\/$/u, "") +
          "/sessions/" +
          encodeURIComponent(sessionId),
        { cache: "no-store" },
      );
      if (history.ok && !cancelled)
        setMessages(
          ((await history.json()) as { messages: ChatMessage[] }).messages,
        );
      const summary = await fetch(
        agent.endpoints.sessions.replace(/\/$/u, "") +
          "/" +
          encodeURIComponent(sessionId),
        { cache: "no-store" },
      );
      if (summary.ok && !cancelled)
        setPending(
          (
            (await summary.json()) as {
              pending_interaction?: PendingInteraction;
            }
          ).pending_interaction,
        );
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agent.endpoints.agUi, agent.endpoints.sessions, sessionId]);
  useEffect(() => {
    if (!sending) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);
  const send = async (): Promise<void> => {
    if ((!input.trim() && attachment === undefined) || sending) return;
    const text = input.trim();
    const image = attachment;
    const content = [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...(image === undefined
        ? []
        : [
            {
              type: "image" as const,
              source: {
                type: "data" as const,
                value: image.base64,
                mimeType: image.mediaType,
              },
            },
          ]),
    ];
    setInput("");
    setAttachment(undefined);
    setSending(true);
    setError(undefined);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...(image === undefined
            ? []
            : [
                {
                  type: "image" as const,
                  url: image.previewUrl,
                  mediaType: image.mediaType,
                },
              ]),
        ],
      },
    ]);
    try {
      const runner = new HttpAgent({
        url: agent.endpoints.agUi,
        threadId: sessionId,
      });
      runner.addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content,
      } as never);
      await runner.runAgent(
        { runId: crypto.randomUUID() },
        {
          onNewMessage: ({ message }) => {
            const value = message as unknown as {
              id?: string;
              role?: string;
              content?: unknown;
            };
            setMessages((current) => [
              ...current,
              {
                id: value.id ?? crypto.randomUUID(),
                role: value.role ?? "assistant",
                content: chatText(value.content),
              },
            ]);
          },
        },
      );
    } catch (cause) {
      setError(requestError(cause, "Agent request failed."));
    } finally {
      setSending(false);
    }
  };
  const replyTo = async (
    body: Record<string, unknown>,
    failed: string,
  ): Promise<void> => {
    if (pending === undefined) return;
    setSending(true);
    try {
      const response = await fetch(
        agent.endpoints.sessions.replace(/\/$/u, "") +
          "/" +
          encodeURIComponent(sessionId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ interaction: { id: pending.id, ...body } }),
        },
      );
      if (!response.ok)
        throw new Error(failed + " returned " + response.status + ".");
      setPending(undefined);
      setReply("");
    } catch (cause) {
      setError(requestError(cause, failed + " failed."));
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-0.5" />
        <h1 className="min-w-0 truncate text-sm font-medium">{agent.name}</h1>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {shortId(sessionId)}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Start the conversation to run this session.
            </p>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                className={
                  "max-w-3xl rounded-lg px-4 py-3 text-sm " +
                  (message.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted")
                }
              >
                <p className="mb-1 text-xs opacity-70">{message.role}</p>
                {message.content.map((part, index) =>
                  part.type === "text" ? (
                    <p key={index} className="whitespace-pre-wrap">
                      {part.text}
                    </p>
                  ) : part.type === "image" ? (
                    <img
                      key={index}
                      src={new URL(part.url, agent.endpoints.agUi).toString()}
                      alt="Shared image"
                      className="max-h-96 rounded-md object-contain"
                    />
                  ) : (
                    <pre
                      key={index}
                      className="overflow-x-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-xs"
                    >
                      {pretty(part.value)}
                    </pre>
                  ),
                )}
              </article>
            ))
          )}
          {pending !== undefined && (
            <section className="rounded-lg border border-amber-400/50 bg-amber-50 p-4 text-sm">
              <p className="font-medium">
                {pending.kind === "response"
                  ? "Response required"
                  : "Approval required"}
              </p>
              <p className="mt-1">{pending.prompt}</p>
              {pending.kind === "response" ? (
                <div className="mt-3">
                  <ChatComposer
                    value={reply}
                    onChange={setReply}
                    onSubmit={() =>
                      void replyTo(
                        { kind: "respond", value: reply.trim() },
                        "Reply",
                      )
                    }
                    sending={sending}
                    placeholder="Your reply…"
                    submitLabel="Send reply"
                  />
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      void replyTo(
                        { kind: "approval", approved: true },
                        "Approval",
                      )
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void replyTo(
                        { kind: "approval", approved: false },
                        "Approval",
                      )
                    }
                  >
                    Deny
                  </Button>
                </div>
              )}
            </section>
          )}
          {error !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t bg-background p-3">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          acceptedTypes={agent.mediaInput?.acceptedTypes}
          maxBytes={agent.mediaInput?.maxBytes}
          disabled={pending !== undefined}
          sending={sending}
          placeholder="Message the agent…"
          autoFocus
        />
      </div>
    </section>
  );
}

function Manifest({ agent }: Readonly<{ agent: AgentManifest }>) {
  const declared = agent.harness.manifest.middleware ?? [];
  const instructions = constructorInstructions(declared);
  const middleware = declared.filter((entry) => entry.id !== "agent");
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <section>
          <h3 className="text-sm font-medium">ID</h3>
          <p className="mt-2 font-mono text-xs">{agent.id}</p>
        </section>
        <Separator className="my-4" />
        <section>
          <h3 className="text-sm font-medium">Name</h3>
          <p className="mt-2 text-sm">{agent.name}</p>
        </section>
        <Separator className="my-4" />
        <section>
          <h3 className="text-sm font-medium">Instructions</h3>
          <InstructionList values={instructions} />
        </section>
        <Separator className="my-4" />
        <section>
          <h3 className="text-sm font-medium">Middleware</h3>
          <div className="mt-3">
            <Tokens values={middleware.map((entry) => entry.id)} />
          </div>
        </section>
        {middleware.map((entry) => (
          <div key={entry.id}>
            <Separator className="my-4" />
            <section>
              <h3 className="font-mono text-sm font-medium">{entry.id}</h3>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Instructions</dt>
                <dd>
                  {entry.instructions === undefined ||
                  entry.instructions.length === 0 ? (
                    <EmptyValue />
                  ) : (
                    <div className="space-y-1">
                      {entry.instructions.map((text, index) => (
                        <p key={index} className="whitespace-pre-wrap">
                          {text}
                        </p>
                      ))}
                    </div>
                  )}
                </dd>
                <dt className="text-muted-foreground">Tools</dt>
                <dd>
                  <ToolList tools={entry.tools ?? []} />
                </dd>
                <dt className="text-muted-foreground">Context</dt>
                <dd>
                  <EmptyValue />
                </dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd>
                  <CompactModel model={entry.model} />
                </dd>
              </dl>
            </section>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
function EventTable({
  events,
  selected,
  onSelect,
}: Readonly<{
  events: readonly CanonicalEvent[];
  selected?: CanonicalEvent;
  onSelect: (event: CanonicalEvent) => void;
}>) {
  const [selectedTypes, setSelectedTypes] = useState<
    readonly string[] | undefined
  >();
  const eventTypes = useMemo(
    () => [...new Set(events.map((event) => event.type))].sort(),
    [events],
  );
  const activeTypes = selectedTypes ?? eventTypes;
  const visibleEvents =
    selectedTypes === undefined
      ? events
      : events.filter((event) => selectedTypes.includes(event.type));
  const filterLabel =
    selectedTypes === undefined || selectedTypes.length === eventTypes.length
      ? "All event types"
      : selectedTypes.length === 0
        ? "No event types"
        : selectedTypes.length === 1
          ? eventLabel({ type: selectedTypes[0] } as CanonicalEvent)
          : selectedTypes.length + " event types";
  const toggleType = (type: string, checked: boolean): void => {
    setSelectedTypes((current) => {
      const next = (current ?? eventTypes).filter((entry) => entry !== type);
      if (checked) next.push(type);
      return next.length === eventTypes.length &&
        eventTypes.every((entry) => next.includes(entry))
        ? undefined
        : next;
    });
  };
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h2 className="text-sm font-medium">Events</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto w-44 justify-between font-normal"
            >
              <span className="truncate">{filterLabel}</span>
              <ChevronDown className="size-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {eventTypes.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                No event types yet
              </p>
            ) : (
              eventTypes.map((type) => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={activeTypes.includes(type)}
                  onCheckedChange={(checked) =>
                    toggleType(type, checked === true)
                  }
                >
                  {eventLabel({ type } as CanonicalEvent)}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-14">Seq</TableHead>
              <TableHead className="w-20">Time</TableHead>
              <TableHead className="w-40">Type</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleEvents.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  {events.length === 0
                    ? "Events will appear when the agent runs."
                    : "No events match this filter."}
                </TableCell>
              </TableRow>
            ) : (
              visibleEvents.map((event) => (
                <TableRow
                  key={event.seq}
                  data-state={
                    selected?.seq === event.seq ? "selected" : undefined
                  }
                  className="cursor-pointer"
                  onClick={() => onSelect(event)}
                >
                  <TableCell className="font-mono text-xs">
                    {event.seq}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {date(event.ts)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{eventLabel(event)}</Badge>
                  </TableCell>
                  <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                    {eventSummary(event)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </section>
  );
}
function EventDetails({
  event,
  onClose,
}: Readonly<{ event: CanonicalEvent; onClose: () => void }>) {
  const digests = modelRequestDigests(event);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{eventLabel(event)}</h2>
          <p className="font-mono text-xs text-muted-foreground">
            Event {event.seq}
          </p>
        </div>
        <Button
          className="ml-auto"
          size="icon"
          variant="ghost"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close event details</span>
        </Button>
      </header>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="min-w-0 max-w-full space-y-4 overflow-hidden p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Sequence</dt>
            <dd>{event.seq}</dd>
            <dt className="text-muted-foreground">Timestamp</dt>
            <dd>{date(event.ts)}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{event.type}</dd>
          </dl>
          {digests === undefined ? null : (
            <section className="min-w-0 max-w-full">
              <h3 className="text-sm font-medium">Digests</h3>
              <dl className="mt-2 space-y-2 rounded-md bg-muted p-3 text-xs">
                <Digest label="Prompt" value={digests.prompt} />
                <Digest label="Tools" value={digests.tools} />
                <Digest label="Model" value={digests.model} />
                <Digest label="Output contract" value={digests.output} />
                <Digest label="Configuration" value={digests.configuration} />
                <Digest label="Context" value={digests.context} />
              </dl>
            </section>
          )}
          <section className="min-w-0 max-w-full">
            <h3 className="text-sm font-medium">Canonical event</h3>
            <pre className="mt-2 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-5">
              {pretty(event)}
            </pre>
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}
function Digest({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono break-all select-text">{value}</dd>
    </div>
  );
}

function SessionWorkspace({
  agent,
  sessionId,
}: Readonly<{ agent: AgentManifest; sessionId: string }>) {
  const [events, setEvents] = useState<readonly CanonicalEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"events" | "manifest">("events");
  const [selectedEvent, setSelectedEvent] = useState<
    CanonicalEvent | undefined
  >();
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const url =
        agent.endpoints.sessions.replace(/\/$/u, "") +
        "/" +
        encodeURIComponent(sessionId) +
        "/events?after=0&limit=1000";
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok && !cancelled) {
        const payload = (await response.json()) as { events: CanonicalEvent[] };
        setEvents(
          [...payload.events].sort((left, right) => right.seq - left.seq),
        );
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agent.endpoints.sessions, sessionId]);
  useEffect(() => {
    setSelectedEvent(undefined);
    setDetailsOpen(false);
    setActiveTab("events");
  }, [sessionId]);
  const openEvent = (event: CanonicalEvent): void => {
    setSelectedEvent(event);
    setDetailsOpen(true);
  };
  const changeTab = (value: string): void => {
    const nextTab = value as "events" | "manifest";
    setActiveTab(nextTab);
    if (nextTab === "manifest") setDetailsOpen(false);
  };
  const showDetails =
    activeTab === "events" && detailsOpen && selectedEvent !== undefined;
  return (
    <ResizablePanelGroup
      key={showDetails ? "details" : "workspace"}
      orientation="horizontal"
      className="h-full min-h-0 overflow-hidden"
    >
      <ResizablePanel defaultSize={showDetails ? 24 : 32} minSize={20}>
        <Chat agent={agent} sessionId={sessionId} />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={showDetails ? 40 : 68} minSize={28}>
        <TabsPrimitive.Root
          value={activeTab}
          onValueChange={changeTab}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-end border-b bg-background px-4">
            <TabsPrimitive.List className="flex h-full items-end gap-5">
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
                Agent Manifest
              </TabsPrimitive.Trigger>
            </TabsPrimitive.List>
          </div>
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
            <Manifest agent={agent} />
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
      </ResizablePanel>
      {showDetails ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={36} minSize={26}>
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
  );
}
function StudioWorkspace({ connection }: Readonly<{ connection: Connection }>) {
  const { agentId = "", sessionId } = useParams();
  const navigate = useNavigate();
  const agent = connection.agents.find((entry) => entry.id === agentId);
  if (agentId === "")
    return (
      <Empty
        title="Choose an agent"
        detail="Select an agent and one of its sessions from the navigation."
      />
    );
  if (agent === undefined)
    return (
      <Empty
        title="Agent not found"
        detail="This agent is not currently exposed by the connected agent server."
      />
    );
  if (sessionId === undefined)
    return (
      <Empty
        title="Choose a session"
        detail="Select a saved session from the navigation, or start a new conversation with this agent."
        action={
          <Button
            onClick={() => navigate(sessionPath(agent.id, crypto.randomUUID()))}
          >
            <CirclePlus className="size-4" />
            New session
          </Button>
        }
      />
    );
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <SessionWorkspace agent={agent} sessionId={sessionId} />
    </div>
  );
}
function Shell() {
  const connection = useConnection();
  const location = useLocation();
  const match = location.pathname.match(
    /^\/agents\/([^/]+)(?:\/sessions\/([^/]+))?/u,
  );
  const activeAgentId =
    match === null ? undefined : decodeURIComponent(match[1]);
  const activeSessionId = match?.[2];
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        connection={connection}
        activeAgentId={activeAgentId}
        activeSessionId={activeSessionId}
      />
      <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
        <Routes>
          <Route
            path="/"
            element={<StudioWorkspace connection={connection} />}
          />
          <Route
            path="/agents/:agentId"
            element={<StudioWorkspace connection={connection} />}
          />
          <Route
            path="/agents/:agentId/sessions/:sessionId"
            element={<StudioWorkspace connection={connection} />}
          />
        </Routes>
      </SidebarInset>
    </SidebarProvider>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
