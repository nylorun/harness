import { join } from "node:path";
import type { AgentManifest, McpServerManifest } from "@nylorun/core/define";
import type { AuthorizeResult } from "../vault/service.js";
import {
  callMcpTool,
  diagnosticFromError,
  listMcpTools,
  openMcpServer,
  type LiveConnection,
} from "./connect.js";
import {
  declaredToolNames,
  type McpDiagnostic,
  type McpSnapshot,
  type McpToolRecord,
} from "./snapshot.js";

interface LiveServer {
  readonly capabilityId: string;
  readonly serverName: string;
  readonly connection: LiveConnection;
}

export class McpPool {
  private readonly live = new Map<string, LiveServer>();

  constructor(
    private readonly options: {
      readonly dataDir: string;
      readonly authorize: (
        sessionId: string,
        request: { url: string; serverName: string },
      ) => Promise<AuthorizeResult>;
    },
  ) {}

  async discover(input: {
    sessionId: string;
    manifest: AgentManifest;
    manifestHash: string;
    pluginRoots: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<{ snapshot: McpSnapshot; diagnostics: McpDiagnostic[] }> {
    const taken = declaredToolNames(input.manifest);
    const tools: McpToolRecord[] = [];
    const diagnostics: McpDiagnostic[] = [];
    for (const declared of serversOf(input.manifest)) {
      input.signal?.throwIfAborted();
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) {
        diagnostics.push(opened.diagnostic);
        continue;
      }
      try {
        const listed = await listMcpTools(opened.connection.client, {
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
          taken,
        });
        tools.push(...listed.tools);
        diagnostics.push({
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
          outcome: "connected",
          message:
            listed.omitted.length === 0
              ? "Connected"
              : `Connected. Omitted ${listed.omitted.join(", ")}`,
        });
        this.remember(input.sessionId, declared, opened.connection);
      } catch (error) {
        await opened.connection.close().catch(() => {});
        diagnostics.push(
          diagnosticFromError(declared.capabilityId, declared.server.name, error),
        );
      }
    }
    return {
      snapshot: {
        snapshotSchemaVersion: 1,
        manifestHash: input.manifestHash,
        mcpTools: tools,
      },
      diagnostics,
    };
  }

  async reconnect(input: {
    sessionId: string;
    manifest: AgentManifest;
    pluginRoots: Readonly<Record<string, string>>;
    tools: readonly McpToolRecord[];
    signal?: AbortSignal;
  }): Promise<McpDiagnostic[]> {
    const diagnostics: McpDiagnostic[] = [];
    const seen = new Set<string>();
    for (const tool of input.tools) {
      const key = `${tool.capabilityId}\0${tool.serverName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.live.has(this.liveKey(input.sessionId, tool.capabilityId, tool.serverName)))
        continue;
      input.signal?.throwIfAborted();
      const declared = serversOf(input.manifest).find(
        (item) =>
          item.capabilityId === tool.capabilityId && item.server.name === tool.serverName,
      );
      if (!declared) {
        diagnostics.push({
          capabilityId: tool.capabilityId,
          serverName: tool.serverName,
          outcome: "failed",
          message: "Declared MCP server is missing from the pinned manifest",
        });
        continue;
      }
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) {
        diagnostics.push(opened.diagnostic);
        continue;
      }
      this.remember(input.sessionId, declared, opened.connection);
    }
    return diagnostics;
  }

  async call(input: {
    sessionId: string;
    capabilityId: string;
    serverName: string;
    serverToolName: string;
    args: unknown;
    manifest: AgentManifest;
    pluginRoots: Readonly<Record<string, string>>;
  }): Promise<Awaited<ReturnType<typeof callMcpTool>>> {
    const key = this.liveKey(input.sessionId, input.capabilityId, input.serverName);
    let live = this.live.get(key);
    if (!live) {
      const declared = serversOf(input.manifest).find(
        (item) =>
          item.capabilityId === input.capabilityId && item.server.name === input.serverName,
      );
      if (!declared) throw new Error(`MCP server '${input.serverName}' is not declared`);
      const opened = await this.connectDeclared(input, declared);
      if (!opened.ok) throw new Error(opened.diagnostic.message);
      this.remember(input.sessionId, declared, opened.connection);
      live = this.live.get(key);
    }
    if (!live) throw new Error(`MCP server '${input.serverName}' is not connected`);
    return callMcpTool(live.connection.client, input.serverToolName, input.args);
  }

  async close(): Promise<void> {
    const connections = [...this.live.values()];
    this.live.clear();
    await Promise.all(connections.map((item) => item.connection.close().catch(() => {})));
  }

  private remember(
    sessionId: string,
    declared: DeclaredServer,
    connection: LiveConnection,
  ): void {
    this.live.set(this.liveKey(sessionId, declared.capabilityId, declared.server.name), {
      capabilityId: declared.capabilityId,
      serverName: declared.server.name,
      connection,
    });
  }

  private liveKey(sessionId: string, capabilityId: string, serverName: string): string {
    return JSON.stringify([sessionId, capabilityId, serverName]);
  }

  private async connectDeclared(
    input: {
      sessionId: string;
      pluginRoots: Readonly<Record<string, string>>;
    },
    declared: DeclaredServer,
  ): Promise<{ ok: true; connection: LiveConnection } | { ok: false; diagnostic: McpDiagnostic }> {
    try {
      const connection = await openMcpServer({
        server: declared.server,
        pluginRoot: input.pluginRoots[declared.capabilityId],
        pluginData: join(this.options.dataDir, "plugin-data", declared.capabilityId),
        authorize:
          declared.server.type === "stdio"
            ? undefined
            : (url) =>
                this.options.authorize(input.sessionId, {
                  url,
                  serverName: declared.server.name,
                }),
      });
      return { ok: true, connection };
    } catch (error) {
      return {
        ok: false,
        diagnostic: diagnosticFromError(declared.capabilityId, declared.server.name, error),
      };
    }
  }
}

interface DeclaredServer {
  readonly capabilityId: string;
  readonly server: McpServerManifest;
}

function serversOf(manifest: AgentManifest): DeclaredServer[] {
  const servers: DeclaredServer[] = [];
  for (const capability of manifest.capabilities)
    for (const server of Object.values(capability.mcpServers ?? {}))
      servers.push({ capabilityId: capability.id, server });
  return servers;
}
