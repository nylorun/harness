import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bot, ChevronRight, CirclePlus, Database, FolderOpen, LoaderCircle } from "lucide-react";
import type { AgentManifest, Connection, SessionSummary } from "@/App";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";

function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) + "…" + id.slice(-4) : id; }
function agentPath(agentId: string): string { return "/agents/" + encodeURIComponent(agentId); }
function sessionPath(agentId: string, sessionId: string): string { return agentPath(agentId) + "/sessions/" + encodeURIComponent(sessionId); }

function SessionItem({ session, active, agentId }: Readonly<{ session: SessionSummary; active: boolean; agentId: string }>) {
  const statusClass = session.status === "running" ? "bg-emerald-500" : session.status === "New" ? "bg-amber-500" : "bg-muted-foreground";
  return <SidebarMenuSubItem><SidebarMenuSubButton asChild isActive={active} size="sm"><Link to={sessionPath(agentId, session.session)}><span className={"size-1.5 shrink-0 rounded-full " + statusClass} /><span>{shortId(session.session)}</span><span className="ml-auto text-[10px] text-muted-foreground">{session.events}</span></Link></SidebarMenuSubButton></SidebarMenuSubItem>;
}
function AgentNavigation({ agent, sessions, activeAgentId, activeSessionId }: Readonly<{ agent: AgentManifest; sessions: readonly SessionSummary[]; activeAgentId?: string; activeSessionId?: string }>) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  useEffect(() => { if (agent.id === activeAgentId) setOpen(true); }, [agent.id, activeAgentId]);
  const displayedSessions = activeAgentId === agent.id && activeSessionId !== undefined && !sessions.some((session) => session.session === activeSessionId)
    ? [{ session: activeSessionId, status: "New", startedAt: Date.now(), events: 0 }, ...sessions]
    : sessions;
  const startSession = (): void => { void navigate(sessionPath(agent.id, crypto.randomUUID())); };
  return <Collapsible open={open} onOpenChange={setOpen} asChild><SidebarMenuItem><SidebarMenuButton asChild isActive={agent.id === activeAgentId} tooltip={agent.name}><Link to={agentPath(agent.id)}><Bot /><span>{agent.name}</span></Link></SidebarMenuButton><CollapsibleTrigger asChild><SidebarMenuAction className="data-[state=open]:rotate-90"><ChevronRight /><span className="sr-only">Toggle {agent.name} sessions</span></SidebarMenuAction></CollapsibleTrigger><SidebarMenuAction className="right-7" showOnHover onClick={startSession}><CirclePlus /><span className="sr-only">New {agent.name} session</span></SidebarMenuAction><CollapsibleContent><SidebarMenuSub>{displayedSessions.length === 0 ? <SidebarMenuSubItem><span className="block px-2 py-1 text-xs text-muted-foreground">No sessions yet</span></SidebarMenuSubItem> : displayedSessions.map((session) => <SessionItem key={session.session} session={session} active={session.session === activeSessionId} agentId={agent.id} />)}</SidebarMenuSub></CollapsibleContent></SidebarMenuItem></Collapsible>;
}
export function AppSidebar({ connection, activeAgentId, activeSessionId }: Readonly<{ connection: Connection; activeAgentId?: string; activeSessionId?: string }>) {
  const availability = connection.status === "Running" ? connection.agents.length + " agent" + (connection.agents.length === 1 ? "" : "s") : "Agent server unavailable";
  return <Sidebar collapsible="icon"><SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" asChild><Link to="/"><div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><FolderOpen className="size-4" /></div><div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">Nylorun Studio</span><span className="truncate text-xs">Agent workspace</span></div></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupLabel>Agents</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{connection.agents.map((agent) => <AgentNavigation key={agent.id} agent={agent} sessions={connection.sessionsByAgent[agent.id] ?? []} activeAgentId={activeAgentId} activeSessionId={activeSessionId} />)}{connection.status === "Running" && connection.agents.length === 0 ? <SidebarMenuItem><span className="block px-2 py-1 text-sm text-muted-foreground">No agents exposed</span></SidebarMenuItem> : null}{connection.status === "Connecting" ? <SidebarMenuItem><span className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Discovering agents</span></SidebarMenuItem> : null}</SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter><div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"><Database className="size-3.5" />{availability}</div></SidebarFooter></Sidebar>;
}
