import { Link } from "react-router-dom";
import type { WorkflowLink } from "@/workflow";

export function WorkflowLinkBanner({
  link,
  workflowName,
}: Readonly<{
  link: WorkflowLink;
  workflowName?: string;
}>) {
  const agentId = link.workflowAgentId;
  const href = agentId
    ? `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(link.workflowSessionId)}`
    : undefined;
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
      <span className="text-muted-foreground">Workflow</span>
      {href ? (
        <Link className="font-medium text-primary underline-offset-2 hover:underline" to={href}>
          {workflowName ?? link.workflowSessionId.slice(0, 8)}
        </Link>
      ) : (
        <span className="font-mono">{link.workflowSessionId.slice(0, 8)}</span>
      )}
      <span className="text-muted-foreground">·</span>
      <span className="font-mono text-muted-foreground">{link.path}</span>
    </div>
  );
}
