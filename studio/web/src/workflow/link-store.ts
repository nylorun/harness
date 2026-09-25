import type { WorkflowLink } from "./types.ts";

/** Session-scoped Studio cache of Runtime links (agentSessionId → workflow). */
const links = new Map<string, WorkflowLink>();

export function rememberWorkflowLinks(
  next: ReadonlyMap<string, WorkflowLink>,
): void {
  for (const [agentSessionId, link] of next) links.set(agentSessionId, link);
}

export function lookupWorkflowLink(
  agentSessionId: string,
): WorkflowLink | undefined {
  return links.get(agentSessionId);
}

export function clearWorkflowLinks(): void {
  links.clear();
}
