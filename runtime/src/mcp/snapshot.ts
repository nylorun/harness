import type { JsonObject } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";

export interface McpToolRecord {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  readonly serverToolName: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
}

export interface McpSnapshot {
  readonly snapshotSchemaVersion: 1;
  readonly manifestHash: string;
  readonly mcpTools: readonly McpToolRecord[];
}

export interface McpDiagnostic {
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly serverName: string;
  readonly outcome: "connected" | "refused" | "failed";
  readonly message: string;
  readonly credentialIds?: readonly string[];
}

export function modelToolName(serverName: string, serverToolName: string): string {
  return `${serverName}__${serverToolName}`;
}

export function declaredToolNames(manifest: AgentManifest): Set<string> {
  const names = new Set<string>();
  for (const capability of manifest.capabilities)
    for (const tool of capability.tools ?? []) names.add(tool.name);
  return names;
}
