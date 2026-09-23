import { join } from "node:path";
import type { AgentManifest, McpServerManifest } from "@nylorun/core/define";
import { delegatesOf } from "@nylorun/core/define";
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
    // Each agent names its own tools, so collisions are checked per agent.
    const taken = new Map<string | undefined, Set<string>>();
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
        if (!taken.has(declared.agentId))
          taken.set(declared.agentId, declaredToolNames(declared.manifest));
        const listed = await listMcpTools(opened.connection.client, {
          capabilityId: declared.capabilityId,
          serverName: declared.server.name,
          taken: taken.get(declared.agentId)!,
        });
        tools.push(...listed.tools.map((tool) => owned(declared, tool)));
        diagnostics.push({
          ...ownerOf(declared),
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
          owned(declared, diagnosticFromError(declared.capabilityId, declared.server.name, error)),
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
      const key = this.liveKey(input.sessionId, tool.agentId, tool.capabilityId, tool.serverName);
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.live.has(key)) continue;
      input.signal?.throwIfAborted();
      const declared = findServer(input.manifest, tool.agentId, tool.capabilityId, tool.serverName);
      if (!declared) {
        diagnostics.push({
          ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
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
    agentId?: string;
    capabilityId: string;
    serverName: string;
    serverToolName: string;
    args: unknown;
    manifest: AgentManifest;
    pluginRoots: Readonly<Record<string, string>>;
  }): Promise<Awaited<ReturnType<typeof callMcpTool>>> {
    const key = this.liveKey(input.sessionId, input.agentId, input.capabilityId, input.serverName);
    let live = this.live.get(key);
    if (!live) {
      const declared = findServer(
        input.manifest,
        input.agentId,
        input.capabilityId,
        input.serverName,
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
    this.live.set(
      this.liveKey(sessionId, declared.agentId, declared.capabilityId, declared.server.name),
      {
        capabilityId: declared.capabilityId,
        serverName: declared.server.name,
        connection,
      },
    );
  }

  private liveKey(
    sessionId: string,
    agentId: string | undefined,
    capabilityId: string,
    serverName: string,
  ): string {
    return JSON.stringify([sessionId, agentId ?? null, capabilityId, serverName]);
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
        pluginRoot: input.pluginRoots[pluginKey(declared)],
        pluginData: join(this.options.dataDir, "plugin-data", ...pluginKey(declared).split("/")),
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
        diagnostic: owned(
          declared,
          diagnosticFromError(declared.capabilityId, declared.server.name, error),
        ),
      };
    }
  }
}

interface DeclaredServer {
  /** Absent for the session's root agent. */
  readonly agentId?: string;
  /** The manifest of the agent that declares the server. */
  readonly manifest: AgentManifest;
  readonly capabilityId: string;
  readonly server: McpServerManifest;
}

/** Servers of the root agent, then of each agent it uses as a tool. */
export function serversOf(manifest: AgentManifest): DeclaredServer[] {
  const servers: DeclaredServer[] = [];
  const add = (agent: AgentManifest, agentId?: string) => {
    for (const capability of agent.capabilities)
      for (const server of Object.values(capability.mcpServers ?? {}))
        servers.push({
          ...(agentId === undefined ? {} : { agentId }),
          manifest: agent,
          capabilityId: capability.id,
          server,
        });
  };
  add(manifest);
  for (const child of delegatesOf(manifest)) add(child.manifest, child.manifest.id);
  return servers;
}

function findServer(
  manifest: AgentManifest,
  agentId: string | undefined,
  capabilityId: string,
  serverName: string,
): DeclaredServer | undefined {
  return serversOf(manifest).find(
    (item) =>
      item.agentId === agentId &&
      item.capabilityId === capabilityId &&
      item.server.name === serverName,
  );
}

/** Plugin roots of agents used as tools are registered as `<agent>/<capability>`. */
function pluginKey(declared: DeclaredServer): string {
  return declared.agentId === undefined
    ? declared.capabilityId
    : `${declared.agentId}/${declared.capabilityId}`;
}

function ownerOf(declared: DeclaredServer): { agentId?: string } {
  return declared.agentId === undefined ? {} : { agentId: declared.agentId };
}

function owned<T extends object>(declared: DeclaredServer, value: T): T {
  return { ...ownerOf(declared), ...value };
}
