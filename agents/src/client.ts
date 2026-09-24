import type {
  AgentManifest,
  BuiltAgent,
  BuiltWorkflow,
  JsonValue,
  WorkflowManifest,
} from "@nylorun/core/define";
import { delegateOf, isBuiltWorkflow } from "@nylorun/core/define";
import {
  LiveEventSchema,
  SessionItemsResponseSchema,
  type AcceptedResponse,
  type CredentialInfo,
  type CredentialSelection,
  type SessionCommand,
  type VaultInfo,
} from "@nylorun/core/contracts";
import { resolveConnection } from "./connection.js";
import { Transport, id, segment, type Destination } from "./http.js";
import { observeSSE } from "./sse.js";
export interface AgentSource {
  readonly id: string;
  readonly manifest: AgentManifest | WorkflowManifest;
  build?(): BuiltAgent | BuiltWorkflow;
  getBinding?: BuiltAgent["getBinding"] | BuiltWorkflow["getBinding"];
}

const middlewareClosure =
  "Hosted definitions support declarative capabilities and before/after hooks, not middleware closures";

/** The agent's declarations, then those of each agent it uses as a tool, keyed `<child>/<capability>`. */
function declarationsOf(agent: AgentSource) {
  if (isBuiltWorkflow(agent) || (agent.manifest as { kind?: string }).kind === "workflow")
    return [];
  const built = agent.build?.() ?? agent;
  if (isBuiltWorkflow(built)) return [];
  const binding = built.getBinding?.();
  if (!binding || !("declarations" in binding)) return [];
  const found = (binding.declarations ?? []).map((item) => ({ key: item.id, item }));
  for (const tool of binding.tools ?? []) {
    const child = delegateOf(tool)?.agent;
    for (const item of child?.getBinding().declarations ?? [])
      found.push({ key: `${child!.id}/${item.id}`, item });
  }
  return found;
}

function pluginRootsOf(agent: AgentSource): Record<string, string> | undefined {
  const roots: Record<string, string> = {};
  for (const { key, item } of declarationsOf(agent))
    if (item.pluginRoot) roots[key] = item.pluginRoot;
  return Object.keys(roots).length === 0 ? undefined : roots;
}

/** Closures stay on the live binding. The published manifest cannot name them. */
export function assertNoMiddlewareClosures(agent: AgentSource): void {
  if (declarationsOf(agent).some(({ item }) => item.hasMiddleware))
    throw new Error(middlewareClosure);
}
export interface SessionView {
  id: string;
  agentId: string;
  ownerUserId: string;
  status: string;
  activeTurnId: string | null;
  [key: string]: unknown;
}
export class AgentsClient {
  readonly transport: Transport;
  constructor(destination: Destination = {}) {
    this.transport = new Transport(destination);
  }
  listAgents(
    options: { signal?: AbortSignal } = {}
  ): Promise<{ agents: { manifest: AgentManifest }[] }> {
    return this.transport.json("/v1/agents", "GET", undefined, options.signal);
  }
  listSessions(
    options: { agentId?: string; signal?: AbortSignal } = {}
  ): Promise<{ sessions: SessionView[] }> {
    const query = options.agentId
      ? `?agentId=${encodeURIComponent(options.agentId)}`
      : "";
    return this.transport.json(
      `/v1/sessions${query}`,
      "GET",
      undefined,
      options.signal
    );
  }
  async saveAgent(
    agent: AgentSource | BuiltWorkflow,
    options: { implementationVersion: string; requestId?: string }
  ) {
    if (isBuiltWorkflow(agent)) {
      for (const binding of Object.values(agent.getBinding().agents)) {
        await this.saveAgent(
          {
            id: binding.manifest.id,
            manifest: binding.manifest,
            getBinding: () => binding,
          },
          options,
        );
      }
      return this.transport.json(`/v1/agents/${segment(agent.id)}`, "PUT", {
        requestId: options.requestId ?? id(),
        manifest: agent.manifest,
        implementationVersion: options.implementationVersion,
      });
    }
    assertNoMiddlewareClosures(agent);
    const pluginRoots = pluginRootsOf(agent);
    return this.transport.json(`/v1/agents/${segment(agent.id)}`, "PUT", {
      requestId: options.requestId ?? id(),
      manifest: agent.manifest,
      implementationVersion: options.implementationVersion,
      ...(pluginRoots === undefined ? {} : { pluginRoots }),
    });
  }
  async createSession(options: {
    id?: string;
    agentId: string;
    ownerUserId: string;
    info?: Record<string, unknown>;
    requestId?: string;
    vaultIds?: readonly string[];
    credentialSelections?: readonly CredentialSelection[];
  }): Promise<SessionClient> {
    const sessionId = options.id ?? id();
    await this.transport.json(`/v1/sessions/${segment(sessionId)}`, "PUT", {
      requestId: options.requestId ?? id(),
      agentId: options.agentId,
      ownerUserId: options.ownerUserId,
      ...(options.info ? { info: options.info } : {}),
      ...(options.vaultIds ? { vaultIds: options.vaultIds } : {}),
      ...(options.credentialSelections
        ? { credentialSelections: options.credentialSelections }
        : {}),
    });
    return this.session(sessionId);
  }
  createVault(options: {
    name: string;
    ownerUserId: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
    requestId?: string;
  }): Promise<VaultInfo> {
    return this.transport.json("/v1/vaults", "POST", {
      requestId: options.requestId ?? id(),
      idempotencyKey: options.idempotencyKey,
      name: options.name,
      ownerUserId: options.ownerUserId,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
  }
  listVaults(ownerUserId: string, signal?: AbortSignal): Promise<{ vaults: VaultInfo[] }> {
    return this.transport.json(
      `/v1/vaults?ownerUserId=${encodeURIComponent(ownerUserId)}`,
      "GET",
      undefined,
      signal,
    );
  }
  getVault(vaultId: string, signal?: AbortSignal): Promise<VaultInfo> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}`,
      "GET",
      undefined,
      signal,
    );
  }
  deleteVault(vaultId: string): Promise<{ id: string }> {
    return this.transport.json(`/v1/vaults/${segment(vaultId)}`, "DELETE");
  }
  createCredential(
    vaultId: string,
    options: {
      name: string;
      idempotencyKey: string;
      requestId?: string;
      auth:
        | { type: "bearer"; url: string; token: string }
        | {
            type: "oauth";
            url: string;
            accessToken: string;
            expiresAt?: string | null;
            refresh?: {
              tokenEndpoint: string;
              clientId: string;
              refreshToken: string;
              tokenEndpointAuth:
                | { type: "none" }
                | { type: "client_secret_basic"; clientSecret: string }
                | { type: "client_secret_post"; clientSecret: string };
            };
          };
    },
  ): Promise<CredentialInfo> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}/credentials`,
      "POST",
      {
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        name: options.name,
        auth: options.auth,
      },
    );
  }
  listCredentials(
    vaultId: string,
    signal?: AbortSignal,
  ): Promise<{ credentials: CredentialInfo[] }> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}/credentials`,
      "GET",
      undefined,
      signal,
    );
  }
  getCredential(
    vaultId: string,
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<CredentialInfo> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}/credentials/${segment(credentialId)}`,
      "GET",
      undefined,
      signal,
    );
  }
  rotateCredential(
    vaultId: string,
    credentialId: string,
    options: {
      idempotencyKey: string;
      requestId?: string;
      auth:
        | { type: "bearer"; token: string }
        | { type: "oauth"; accessToken: string; expiresAt?: string | null };
    },
  ): Promise<CredentialInfo> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}/credentials/${segment(credentialId)}`,
      "POST",
      {
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        auth: options.auth,
      },
    );
  }
  deleteCredential(vaultId: string, credentialId: string): Promise<{ id: string }> {
    return this.transport.json(
      `/v1/vaults/${segment(vaultId)}/credentials/${segment(credentialId)}`,
      "DELETE",
    );
  }
  session(sessionId: string): SessionClient {
    return new SessionClient(this.transport, sessionId);
  }
}
export type CommandOptions = {
  idempotencyKey: string;
  requestId?: string;
  signal?: AbortSignal;
};
export class SessionClient {
  constructor(private readonly transport: Transport, readonly id: string) {}
  private get path() {
    return `/v1/sessions/${segment(this.id)}`;
  }
  inspect(signal?: AbortSignal) {
    return this.transport.json<SessionView>(
      this.path,
      "GET",
      undefined,
      signal
    );
  }
  command(command: SessionCommand, signal?: AbortSignal) {
    return this.transport.json<AcceptedResponse>(
      `${this.path}/commands`,
      "POST",
      command,
      signal
    );
  }
  input(content: string, options: CommandOptions) {
    return this.command(
      {
        type: "message",
        content,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  approve(interactionId: string, approved: boolean, options: CommandOptions) {
    return this.command(
      {
        type: "approve",
        interactionId,
        approved,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  respond(interactionId: string, value: JsonValue, options: CommandOptions) {
    return this.command(
      {
        type: "respond",
        interactionId,
        value,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  cancel(options: CommandOptions & { reason?: string }) {
    return this.command(
      {
        type: "cancel",
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        ...(options.reason ? { reason: options.reason } : {}),
      },
      options.signal
    );
  }
  /** `agent` narrows to one agent used as a tool: its delegationId or its path. */
  async history(
    options: { cursor?: string; agent?: string; signal?: AbortSignal } = {}
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.agent) query.set("agent", options.agent);
    const search = query.toString();
    return SessionItemsResponseSchema.parse(
      await this.transport.json(
        `${this.path}/items${search ? `?${search}` : ""}`,
        "GET",
        undefined,
        options.signal
      )
    );
  }
  async *observe(options: { cursor?: string; signal?: AbortSignal } = {}) {
    for await (const frame of observeSSE(
      this.transport,
      `${this.path}/events`,
      options
    )) {
      if (frame.event === "heartbeat" || frame.event === "ready") continue;
      yield LiveEventSchema.parse(JSON.parse(frame.data));
    }
  }
}
/**
 * Build a Tenant API client.
 * Explicit connection fields keep today's sync Transport resolution (including
 * environment fill-ins). With no connection fields, resolves via
 * `resolveConnection` (environment → project link).
 */
export function createClient(destination: Destination): AgentsClient;
export function createClient(destination?: undefined): Promise<AgentsClient>;
export function createClient(
  destination: Destination = {},
): AgentsClient | Promise<AgentsClient> {
  if (
    destination.url !== undefined ||
    destination.key !== undefined ||
    destination.tenant !== undefined
  ) {
    return new AgentsClient(destination);
  }
  return resolveConnection().then(
    (connection) =>
      new AgentsClient({
        url: connection.url,
        key: connection.key,
        tenant: connection.tenant,
        ...(destination.fetch ? { fetch: destination.fetch } : {}),
      }),
  );
}

export { RuntimeError, IncompatibleRuntimeError } from "./http.js";
export type { Destination, IncompatibleReason } from "./http.js";
export type { LiveEvent } from "@nylorun/core/contracts";
