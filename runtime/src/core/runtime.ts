import {
  createServer,
  type Server,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  AgentManifestSchema,
  CreateCredentialRequestSchema,
  CreateVaultRequestSchema,
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  RotateCredentialRequestSchema,
  SessionCommandSchema,
  ActionClaimRequestSchema,
  ActionHeartbeatRequestSchema,
  type Action,
  type CredentialSelection,
  type ExecutorScope,
  type SessionCommand,
  type LiveEvent,
} from "@nylorun/core/contracts";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableCheckpoint,
  type DurableSessionTool,
  type HostEffect,
  type EffectResolution,
} from "@nylorun/harness/run";
import { hashManifest } from "@nylorun/core/compatibility";
import { schemaFromJSON, type AgentManifest, type JsonObject } from "@nylorun/core/define";
import { Store, canonical } from "./store.js";
import { scriptedModel, type ModelProvider } from "./provider.js";
import { scrub } from "../redact.js";
import { createKekFile, defaultKekPath, readVaultKek } from "../vault/kek.js";
import { VaultError } from "../vault/error.js";
import { VaultService, type AuthorizeResult } from "../vault/service.js";
import { McpPool } from "../mcp/pool.js";
import type { McpDiagnostic, McpSnapshot, McpToolRecord } from "../mcp/snapshot.js";
export interface RuntimeOptions {
  sqlitePath: string;
  serverToken: string;
  executors: readonly (ExecutorScope & { token: string })[];
  model?: ModelProvider;
  leaseMs?: number;
  /** 32-byte key, or base64 of that key. `null` disables env and file lookup. */
  vaultKek?: Buffer | string | null;
  vaultKekPath?: string;
  vaultFetch?: typeof fetch;
}
interface Session {
  id: string;
  agentId: string;
  ownerUserId: string;
  manifest: any;
  manifestHash: string;
  implementationVersion: string;
  info?: any;
  status: string;
  activeTurnId: string | null;
  checkpoint?: DurableCheckpoint;
  state?: any;
  turnStartState?: any;
  waits?: unknown;
  error?: string;
  creation: unknown;
  vaultIds?: readonly string[];
  credentialSelections?: readonly CredentialSelection[];
  pluginRoots?: Readonly<Record<string, string>>;
  mcpSnapshot?: McpSnapshot;
  mcpDiagnostics?: readonly McpDiagnostic[];
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
function sessionToolsOf(
  snapshot: McpSnapshot | undefined,
): readonly DurableSessionTool[] | undefined {
  if (!snapshot?.mcpTools.length) return undefined;
  return snapshot.mcpTools.map((tool) => ({
    capabilityId: tool.capabilityId,
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  }));
}
function mcpToolOf(
  session: Session,
  capabilityId?: string,
  toolName?: string,
): McpToolRecord | undefined {
  return session.mcpSnapshot?.mcpTools.find(
    (tool) => tool.capabilityId === capabilityId && tool.name === toolName,
  );
}
function pinnedTool(
  manifest: AgentManifest,
  capabilityId?: string,
  toolName?: string,
) {
  const capability = manifest.capabilities.find((item) => item.id === capabilityId);
  return capability?.tools?.find((tool) => tool.name === toolName);
}
function acceptedToolResult(
  action: Action,
  command: Extract<SessionCommand, { type: "action_result" }>,
): Extract<SessionCommand, { type: "action_result" }> {
  if (action.kind !== "tool" || !action.outputSchema) return command;
  const value = command.outcome.value;
  if (isFailedToolValue(value)) return command;
  // Executors wrap successful tool output as `{ kind: "completed", output }`.
  // Validate the tool payload, not the outcome envelope.
  const candidate = completedToolOutput(value);
  let matches = false;
  try {
    matches = schemaFromJSON(action.outputSchema as JsonObject).validate(
      candidate,
    ).ok;
  } catch {
    matches = false;
  }
  if (matches) return command;
  return {
    ...command,
    outcome: {
      ...command.outcome,
      value: {
        kind: "failed",
        code: "tool.invalid-output",
        message: "Tool result does not match the output schema stored on the action",
      },
    },
  };
}
function completedToolOutput(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "completed" &&
    "output" in (value as object)
  ) {
    return (value as { output: unknown }).output;
  }
  return value;
}
function isFailedToolValue(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "failed"
  );
}
const semantic = (value: any): string => {
  const { requestId: _, ...body } = value;
  return canonical(body);
};
const sessionIdentity = (value: any): string => {
  const {
    requestId: _requestId,
    vaultIds: _vaultIds,
    credentialSelections: _selections,
    ...body
  } = value ?? {};
  return canonical(body);
};
const equals = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export class CoreRuntime {
  private readonly store: Store;
  private readonly vault: VaultService;
  private kek: Buffer | undefined;
  private readonly kekPath: string;
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<string>();
  private readonly observers = new Map<string, Set<ServerResponse>>();
  private readonly executors = new Set<ServerResponse>();
  private readonly mcp: McpPool;
  private server?: Server;
  private closing = false;
  private readonly lockPath?: string;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly options: RuntimeOptions) {
    if (
      options.leaseMs !== undefined &&
      (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0)
    )
      throw new Error("leaseMs must be finite and positive");
    if (
      new Set(options.executors.map((e) => e.token)).size !==
      options.executors.length
    )
      throw new Error("Executor tokens must be unique");
    if (!options.serverToken || options.serverToken.length < 16)
      throw new Error("A server token of at least 16 characters is required");
    if (
      options.executors.some(
        (e) =>
          e.token.length < 16 ||
          equals(e.token, options.serverToken) ||
          !e.agentId ||
          !e.implementationVersion,
      )
    )
      throw new Error(
        "Executor tokens require independent credentials and an agent id",
      );
    if (options.sqlitePath !== ":memory:") {
      mkdirSync(dirname(options.sqlitePath), { recursive: true });
      this.lockPath = options.sqlitePath + ".runtime-lock";
      // One local scheduling owner; recover a stale process lock only after checking that its PID is absent.
      try {
        const oldPid = Number(readFileSync(this.lockPath, "utf8"));
        if (!Number.isSafeInteger(oldPid) || oldPid < 1)
          throw new Error("Invalid runtime lock; inspect before removing");
        try {
          process.kill(oldPid, 0);
          throw new Error("Another Runtime owns this SQLite database");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          unlinkSync(this.lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fd = openSync(this.lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    }
    this.kekPath = options.vaultKekPath ?? defaultKekPath();
    let store: Store | undefined;
    try {
      store = new Store(options.sqlitePath);
      this.kek = readVaultKek({
        vaultKek: options.vaultKek,
        vaultKekPath: this.kekPath,
      });
      if (store.credentialCount() > 0 && !this.kek)
        throw new Error(
          "Vault key-encryption key is required to open this database",
        );
      this.store = store;
    } catch (e) {
      store?.db.close();
      if (this.lockPath) unlinkSync(this.lockPath);
      throw e;
    }
    this.vault = new VaultService(
      this.store.db,
      (fn) => this.store.tx(fn),
      () => this.ensureKek(),
      options.vaultFetch ?? globalThis.fetch,
    );
    this.mcp = new McpPool({
      dataDir: dirname(options.sqlitePath),
      authorize: (sessionId, request) => this.authorize(sessionId, request),
    });
    this.store.tx(() => {
      for (const effect of this.store.all("effects"))
        if (effect.status === "invoking") {
          effect.status = "uncertain";
          this.store.put("effects", effect.request.effectId, effect);
          const s = this.store.get<Session>(
            "sessions",
            effect.request.sessionId,
          );
          if (
            s &&
            s.status !== "cancelled" &&
            s.activeTurnId === effect.request.turnId
          ) {
            s.status = "uncertain";
            this.store.put("sessions", s.id, s);
            this.store.event(s.id, s.activeTurnId, "effect.uncertain", {
              effectId: effect.request.effectId,
            });
          }
        }
    });
    this.expireClaims();
    this.timer = setInterval(
      () => this.expireClaims(),
      Math.min(options.leaseMs ?? 30000, 5000),
    );
    this.timer.unref();
    for (const s of this.store.all<Session>("sessions"))
      if (s.status === "running" || s.status === "runnable")
        this.schedule(s.id);
  }
  private session(id: string): Session {
    return (
      this.store.get<Session>("sessions", id) ?? fail(404, "Session not found")
    );
  }
  private publish(event: LiveEvent): void {
    for (const response of this.observers.get(event.sessionId) ?? [])
      this.send(
        response,
        `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
  }
  private send(response: ServerResponse, data: string): void {
    if (!response.write(data)) response.destroy();
  }
  private notify(): void {
    for (const response of this.executors)
      this.send(
        response,
        'event: work_available\ndata: {"type":"work_available"}\n\n',
      );
  }
  private expireClaims(): void {
    const events: LiveEvent[] = [];
    this.store.tx(() => {
      for (const action of this.store.all<Action>("actions"))
        if (
          action.status === "claimed" &&
          Date.parse(action.leaseExpiresAt!) <= Date.now()
        ) {
          action.status = "uncertain";
          this.store.put("actions", action.actionId, action);
          const effect = this.store.get("effects", action.actionId);
          effect.status = "uncertain";
          this.store.put("effects", action.actionId, effect);
          const s = this.session(action.sessionId);
          if (s.status !== "cancelled" && s.activeTurnId === action.turnId) {
            s.status = "uncertain";
            this.store.put("sessions", s.id, s);
            events.push(
              this.store.event(s.id, s.activeTurnId, "action.uncertain", {
                actionId: action.actionId,
              }),
            );
          }
        }
    });
    events.forEach((e) => this.publish(e));
  }
  private schedule(id: string): void {
    if (this.closing) return;
    this.pending.add(id);
    setImmediate(() => {
      if (!this.running.has(id) && this.pending.delete(id) && !this.closing)
        void this.execute(id);
    });
  }
  private async execute(id: string): Promise<void> {
    const s = this.session(id);
    if (!s.checkpoint || !["running", "runnable"].includes(s.status)) return;
    s.status = "running";
    this.store.tx(() => this.store.put("sessions", id, s));
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      await this.prepareMcp(id, controller.signal);
      const current = this.session(id);
      const result = await runDurable({
        manifest: current.manifest,
        checkpoint: current.checkpoint!,
        signal: controller.signal,
        sessionTools: sessionToolsOf(current.mcpSnapshot),
        host: {
          resolveEffect: (e) => this.resolveEffect(e, controller.signal),
        },
      });
      let event: LiveEvent | undefined;
      this.store.tx(() => {
        const current = this.session(id);
        if (
          current.status === "cancelled" ||
          current.activeTurnId !== s.activeTurnId
        )
          return;
        // A result can arrive during concurrent action persistence. Preserve the runnable marker.
        const resumeRequested = current.status === "runnable";
        if (result.status === "waiting" || result.status === "uncertain") {
          current.status = resumeRequested
            ? "runnable"
            : current.status === "uncertain"
              ? "uncertain"
              : result.status;
          current.waits = { effectIds: result.effectIds };
        } else if ("result" in result) {
          current.state =
            result.status === "failed"
              ? current.turnStartState
              : result.result.state;
          current.checkpoint = result.checkpoint;
          this.store.put(
            "checkpoints",
            JSON.stringify([id, s.activeTurnId, result.checkpoint.segment]),
            { checkpoint: result.checkpoint, status: result.status },
          );
          current.status = result.status;
          current.waits =
            result.status === "paused"
              ? (result.result as any).pending
              : undefined;
          if (result.status !== "paused") current.activeTurnId = null;
          event = this.store.event(
            id,
            s.activeTurnId,
            `turn.${result.status}`,
            result.status === "completed"
              ? { output: (result.result as any).output }
              : result.status === "paused"
                ? {
                    interactions: ((result.result as any).pending ?? []).map(
                      (call: any) => ({
                        invocationId: call.invocationId,
                        interaction: call.interaction,
                        wait: call.wait,
                        status: call.status,
                      }),
                    ),
                  }
                : result.status === "failed"
                  ? {
                      error: {
                        code: (result.result as any).error?.code,
                        message: (result.result as any).error?.message,
                      },
                    }
                  : {},
          );
        }
        this.store.put("sessions", id, current);
      });
      if (event) this.publish(event);
    } catch (error) {
      let event: LiveEvent | undefined;
      this.store.tx(() => {
        const current = this.session(id);
        if (
          current.status === "cancelled" ||
          current.activeTurnId !== s.activeTurnId
        )
          return;
        current.status = "failed";
        current.state = current.turnStartState;
        if (current.checkpoint)
          this.store.put(
            "checkpoints",
            JSON.stringify([id, s.activeTurnId, current.checkpoint.segment]),
            { checkpoint: current.checkpoint, status: "failed" },
          );
        current.error = error instanceof Error ? error.message : String(error);
        this.store.put("sessions", id, current);
        event = this.store.event(id, current.activeTurnId, "turn.failed", {
          message: current.error,
        });
        current.activeTurnId = null;
        this.store.put("sessions", id, current);
      });
      if (event) this.publish(event);
    } finally {
      this.running.delete(id);
      if (
        !this.closing &&
        (this.pending.has(id) || this.session(id).status === "runnable")
      )
        this.schedule(id);
    }
  }
  private async resolveEffect(
    request: HostEffect,
    signal: AbortSignal,
  ): Promise<EffectResolution> {
    let invoke: "model" | "mcp" | undefined;
    let notify = false;
    let event: LiveEvent | undefined;
    const resolution = this.store.tx((): EffectResolution | undefined => {
      const s = this.session(request.sessionId);
      if (
        s.status === "cancelled" ||
        s.activeTurnId !== request.turnId ||
        signal.aborted
      )
        throw new Error("Turn cancelled");
      const existing = this.store.get("effects", request.effectId);
      if (existing) {
        if (canonical(existing.request) !== canonical(request))
          throw new Error("Effect identity request drift");
        return existing.status === "completed"
          ? { status: "completed", outcome: existing.outcome }
          : {
              status:
                existing.status === "uncertain" ||
                existing.status === "invoking"
                  ? "uncertain"
                  : "pending",
            };
      }
      const mcpTool =
        request.kind === "tool"
          ? mcpToolOf(s, request.capabilityId, request.toolName)
          : undefined;
      this.store.put("effects", request.effectId, {
        request,
        status: request.kind === "model" || mcpTool ? "invoking" : "pending",
      });
      if (request.kind === "model" || mcpTool) {
        invoke = mcpTool ? "mcp" : "model";
        return undefined;
      }
      const tool =
        request.kind === "tool"
          ? pinnedTool(s.manifest, request.capabilityId, request.toolName)
          : undefined;
      const action: Action = {
        actionId: request.effectId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        agentId: request.agentId,
        manifestHash: request.manifestHash,
        implementationVersion: s.implementationVersion,
        kind: request.kind,
        capabilityId: request.capabilityId!,
        ...(request.toolName ? { toolName: request.toolName } : {}),
        ...(tool?.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool?.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        input: request.input,
        context: request.context,
        status: "pending",
        generation: 0,
        claimId: null,
        leaseExpiresAt: null,
      };
      this.store.put("actions", action.actionId, action);
      event = this.store.event(s.id, s.activeTurnId, "action.pending", {
        actionId: action.actionId,
        kind: action.kind,
        toolName: action.toolName,
        input: action.input,
      });
      notify = true;
      return { status: "pending" };
    });
    if (event) this.publish(event);
    if (notify) this.notify();
    if (!invoke) return resolution!;
    try {
      const value =
        invoke === "mcp"
          ? await this.callMcpTool(request)
          : await (this.options.model ?? scriptedModel())(request, signal);
      return this.store.tx(() => {
        const s = this.session(request.sessionId);
        if (
          s.status === "cancelled" ||
          s.activeTurnId !== request.turnId ||
          signal.aborted
        )
          throw new Error("Turn cancelled");
        const effect = this.store.get("effects", request.effectId);
        effect.status = "completed";
        effect.outcome = { value };
        this.store.put("effects", request.effectId, effect);
        return { status: "completed" as const, outcome: effect.outcome };
      });
    } catch (error) {
      let event: LiveEvent | undefined;
      this.store.tx(() => {
        const effect = this.store.get("effects", request.effectId);
        effect.status = "uncertain";
        effect.error = error instanceof Error ? error.message : String(error);
        this.store.put("effects", request.effectId, effect);
        const s = this.session(request.sessionId);
        if (s.status !== "cancelled" && s.activeTurnId === request.turnId)
          event = this.store.event(s.id, request.turnId, "effect.uncertain", {
            effectId: request.effectId,
            message: effect.error,
          });
      });
      if (event) this.publish(event);
      return { status: "uncertain" };
    }
  }
  private scope(request: IncomingMessage): ExecutorScope | "server" {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (token && equals(token, this.options.serverToken)) return "server";
    const executor = this.options.executors.find(
      (e) => token && equals(token, e.token),
    );
    if (!executor) return fail(401, "Invalid credentials");
    return executor;
  }
  private scoped(scope: ExecutorScope | "server", action: Action): void {
    if (scope === "server" || scope.agentId !== action.agentId)
      fail(403, "Executor scope does not authorize this action");
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    let data = "";
    for await (const chunk of request) {
      data += chunk;
      if (Buffer.byteLength(data) > 1024 * 1024) fail(413, "Request too large");
    }
    try {
      return JSON.parse(data);
    } catch {
      return fail(400, "Invalid JSON");
    }
  }
  private command(
    id: string,
    input: SessionCommand,
    scope: ExecutorScope | "server",
  ): unknown {
    let event: LiveEvent | undefined;
    let schedule = false;
    const response = this.store.tx(() => {
      const s = this.session(id);
      let command = input;
      if (command.type === "action_result") {
        const a =
          this.store.get<Action>("actions", command.actionId) ??
          fail(404, "Action not found");
        if (a.sessionId !== id) fail(403, "Action belongs to another session");
        this.scoped(scope, a);
        command = acceptedToolResult(a, command);
      } else if (scope !== "server")
        fail(403, "Application credential required");
      const key = JSON.stringify([id, command.idempotencyKey]);
      const existing = this.store.get("commands", key);
      if (existing) {
        if (semantic(existing.command) !== semantic(command))
          fail(409, "Idempotency key already binds another command");
        return existing.response;
      }
      if (command.type === "action_result") {
        const action = this.store.get<Action>("actions", command.actionId)!;
        const prior = this.store.get("effects", command.actionId);
        if (action.status === "completed") {
          if (
            action.claimId !== command.claimId ||
            action.generation !== command.generation ||
            canonical(prior.outcome) !== canonical(command.outcome)
          )
            fail(409, "Conflicting action result");
          this.store.put("commands", key, { command, response: prior.receipt });
          return prior.receipt;
        }
        if (
          s.status === "cancelled" ||
          s.activeTurnId !== action.turnId ||
          action.status !== "claimed" ||
          action.claimId !== command.claimId ||
          action.generation !== command.generation ||
          Date.parse(action.leaseExpiresAt!) <= Date.now()
        )
          fail(409, "Stale, expired, or cancelled claim");
        action.status = "completed";
        this.store.put("actions", action.actionId, action);
        prior.status = "completed";
        prior.outcome = command.outcome;
        s.status = "runnable";
        schedule = true;
        event = this.store.event(id, s.activeTurnId, "action.completed", {
          actionId: action.actionId,
          toolName: action.toolName,
          kind: action.kind,
          result: command.outcome.value,
        });
        const receipt = {
          status: "accepted",
          turnId: s.activeTurnId,
          cursor: event.cursor,
          requestId: command.requestId,
        };
        prior.receipt = receipt;
        this.store.put("effects", action.actionId, prior);
      } else if (command.type === "cancel") {
        const cancelledTurnId = s.activeTurnId;
        s.status = "cancelled";
        for (const a of this.store.all<Action>("actions"))
          if (
            a.sessionId === id &&
            a.turnId === cancelledTurnId &&
            ["pending", "claimed"].includes(a.status)
          ) {
            // Claimed work may already have an external effect. Preserve it for reconciliation.
            a.status = a.status === "claimed" ? "uncertain" : "cancelled";
            this.store.put("actions", a.actionId, a);
            const effect = this.store.get("effects", a.actionId);
            effect.status = a.status;
            this.store.put("effects", a.actionId, effect);
          }
        for (const effect of this.store.all("effects"))
          if (
            effect.request.sessionId === id &&
            effect.request.turnId === cancelledTurnId &&
            effect.status === "invoking"
          ) {
            effect.status = "uncertain";
            effect.error =
              "Turn cancelled before model outcome was durably recorded";
            this.store.put("effects", effect.request.effectId, effect);
          }
        event = this.store.event(id, cancelledTurnId, "turn.cancelled", {
          reason: command.reason,
        });
        s.activeTurnId = null;
        // The next turn starts from the state preceding the cancelled turn, never its paused plan.
        if (cancelledTurnId !== null) s.state = s.turnStartState;
        s.checkpoint = undefined;
        s.waits = undefined;
        s.error = undefined;
      } else {
        if (command.type === "message") {
          if (!["idle", "completed", "failed", "cancelled"].includes(s.status))
            fail(409, "Session has active or unresolved work");
          s.turnStartState = s.state;
          s.activeTurnId = randomUUID();
          s.checkpoint = createDurableCheckpoint({
            manifest: s.manifest,
            sessionId: id,
            turnId: s.activeTurnId,
            input: command.content,
            state: s.state,
            info: s.info,
          });
        } else {
          if (s.status !== "paused" || !s.state || !s.activeTurnId)
            fail(409, "Session is not awaiting a response");
          const pending = s.state.plan?.calls ?? [];
          if (
            !pending.some(
              (c: any) =>
                c.status === "interaction" &&
                c.interaction?.id === command.interactionId &&
                (command.type === "approve") ===
                  (c.interaction?.kind === "approval"),
            )
          )
            fail(409, "Unknown interaction");
          const input =
            command.type === "approve"
              ? {
                  kind: "approve" as const,
                  interactionId: command.interactionId,
                  approved: command.approved,
                }
              : {
                  kind: "respond" as const,
                  interactionId: command.interactionId,
                  value: command.value,
                };
          s.checkpoint = createDurableCheckpoint({
            manifest: s.manifest,
            sessionId: id,
            turnId: s.activeTurnId!,
            input: input as any,
            state: s.state,
            info: s.info,
            segment: (s.checkpoint?.segment ?? 0) + 1,
          });
        }
        this.store.put(
          "checkpoints",
          JSON.stringify([id, s.activeTurnId, s.checkpoint!.segment]),
          { checkpoint: s.checkpoint, status: "runnable" },
        );
        s.status = "runnable";
        s.waits = undefined;
        schedule = true;
        event = this.store.event(
          id,
          s.activeTurnId,
          `command.${command.type}`,
          command,
        );
      }
      this.store.put("sessions", id, s);
      const response = {
        status: "accepted",
        turnId: s.activeTurnId,
        cursor: event?.cursor ?? this.store.history(id).cursor,
        requestId: command.requestId,
      };
      this.store.put("commands", key, { command, response });
      return response;
    });
    if (event) this.publish(event);
    if (input.type === "cancel") this.running.get(id)?.abort();
    if (schedule) this.schedule(id);
    return response;
  }
  private sse(
    request: IncomingMessage,
    response: ServerResponse,
    set: Set<ServerResponse>,
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    set.add(response);
    const timer = setInterval(
      () => this.send(response, ": keepalive\n\n"),
      15000,
    );
    timer.unref();
    request.on("close", () => {
      clearInterval(timer);
      set.delete(response);
    });
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://runtime");
      const path = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const method = request.method;
      if (url.pathname === "/health")
        return json({ status: "ok", service: "oss-runtime" });
      if (url.pathname === "/ready") {
        this.store.db.prepare("SELECT 1").get();
        return json(
          {
            status: this.closing ? "not_ready" : "ready",
            service: "oss-runtime",
            checks: {
              sqlite: true,
              scheduler: !this.closing,
              modelConfigured: true,
            },
          },
          this.closing ? 503 : 200,
        );
      }
      const scope = this.scope(request);
      if (path[0] !== "v1") fail(404, "Route not found");
      if (
        path[1] === "executors" &&
        path[2] === "connect" &&
        method === "GET"
      ) {
        if (scope === "server") fail(403, "Executor credential required");
        this.sse(request, response, this.executors);
        this.send(
          response,
          'event: work_available\ndata: {"type":"work_available"}\n\n',
        );
        return;
      }
      if (path[1] === "actions") {
        if (scope === "server")
          return fail(403, "Executor credential required");
        this.expireClaims();
        if (path.length === 2 && method === "GET")
          return json({
            actions: this.store
              .all<Action>("actions")
              .filter(
                (a) => a.status === "pending" && a.agentId === scope.agentId,
              ),
          });
        const actionId = path[2];
        if (!actionId) fail(404, "Action not found");
        const body = await this.body(request);
        let event: LiveEvent | undefined;
        const result = this.store.tx(() => {
          const action =
            this.store.get<Action>("actions", actionId) ??
            fail(404, "Action not found");
          this.scoped(scope, action);
          if (method === "POST" && path[3] === "claim") {
            ActionClaimRequestSchema.parse(body);
            if (
              action.status !== "pending" ||
              this.session(action.sessionId).status === "cancelled" ||
              this.session(action.sessionId).activeTurnId !== action.turnId
            )
              fail(409, "Action unavailable");
            action.status = "claimed";
            action.generation++;
            action.claimId = randomUUID();
            action.leaseExpiresAt = new Date(
              Date.now() + (this.options.leaseMs ?? 30000),
            ).toISOString();
            this.store.put("actions", actionId, action);
            event = this.store.event(
              action.sessionId,
              action.turnId,
              "action.claimed",
              { actionId, generation: action.generation },
            );
            return {
              action,
              claimId: action.claimId,
              generation: action.generation,
              leaseExpiresAt: action.leaseExpiresAt,
            };
          }
          if (method === "POST" && path[3] === "heartbeat") {
            const beat = ActionHeartbeatRequestSchema.parse(body);
            if (
              this.session(action.sessionId).activeTurnId !== action.turnId ||
              action.status !== "claimed" ||
              action.claimId !== beat.claimId ||
              action.generation !== beat.generation ||
              Date.parse(action.leaseExpiresAt!) <= Date.now()
            )
              fail(409, "Stale or expired claim");
            action.leaseExpiresAt = new Date(
              Date.now() + (this.options.leaseMs ?? 30000),
            ).toISOString();
            this.store.put("actions", actionId, action);
            return { leaseExpiresAt: action.leaseExpiresAt };
          }
          return fail(404, "Route not found");
        });
        if (event) this.publish(event);
        return json(result);
      }
      if (
        path[1] === "sessions" &&
        path[2] &&
        path[3] === "commands" &&
        method === "POST"
      )
        return json(
          this.command(
            path[2],
            SessionCommandSchema.parse(await this.body(request)),
            scope,
          ),
        );
      if (path[1] === "vaults")
        return json(await this.dispatchVault(scope, method, path, url, request));
      if (scope !== "server") fail(403, "Application credential required");
      if (path[1] === "agents" && path.length === 2 && method === "GET")
        return json({
          agents: this.store
            .all("definitions")
            .map((d) => ({
              agentId: d.manifest.id,
              manifest: d.manifest,
              manifestHash: d.manifestHash,
              implementationVersion: d.implementationVersion,
            })),
        });
      if (path[1] === "sessions" && path.length === 2 && method === "GET")
        return json({
          sessions: this.store
            .all<Session>("sessions")
            .filter(
              (s) =>
                !url.searchParams.has("agentId") ||
                s.agentId === url.searchParams.get("agentId"),
            )
            .map((s) => ({
              id: s.id,
              agentId: s.agentId,
              ownerUserId: s.ownerUserId,
              status: s.status,
              activeTurnId: s.activeTurnId,
            })),
        });
      if (
        path[1] === "agents" &&
        path[2] &&
        path.length === 3 &&
        method === "PUT"
      ) {
        const body = PutAgentRequestSchema.parse(await this.body(request));
        if (body.manifest.id !== path[2]) fail(400, "Agent id mismatch");
        AgentManifestSchema.parse(body.manifest);
        const definition = {
          ...body,
          manifestHash: hashManifest(body.manifest),
        };
        this.store.tx(() => {
          this.store.put("definitions", path[2]!, definition);
        });
        return json({
          agentId: path[2],
          manifestHash: definition.manifestHash,
          implementationVersion: body.implementationVersion,
        });
      }
      if (path[1] === "sessions" && path[2]) {
        const id = path[2];
        if (method === "PUT" && path.length === 3) {
          const body = PutSessionRequestSchema.parse(await this.body(request));
          const vaultIds = body.vaultIds ?? [];
          const credentialSelections = body.credentialSelections ?? [];
          const result = this.store.tx(() => {
            this.vault.assertAttachment(
              body.ownerUserId,
              vaultIds,
              credentialSelections,
            );
            const prior = this.store.get<Session>("sessions", id);
            if (prior) {
              if (sessionIdentity(prior.creation) !== sessionIdentity(body))
                fail(
                  409,
                  "Session already exists with different creation parameters",
                );
              prior.vaultIds = vaultIds;
              prior.credentialSelections = credentialSelections;
              prior.creation = body;
              this.store.put("sessions", id, prior);
              this.vault.recordAttachment(id, vaultIds);
              return prior;
            }
            const definition =
              this.store.get("definitions", body.agentId) ??
              fail(404, "Definition not found");
            const s: Session = {
              id,
              agentId: body.agentId,
              ownerUserId: body.ownerUserId,
              manifest: definition.manifest,
              manifestHash: definition.manifestHash,
              implementationVersion: definition.implementationVersion,
              info: body.info,
              status: "idle",
              activeTurnId: null,
              creation: body,
              vaultIds,
              credentialSelections,
              pluginRoots: definition.pluginRoots ?? {},
            };
            this.store.put("sessions", id, s);
            this.vault.recordAttachment(id, vaultIds);
            return s;
          });
          return json(this.view(result));
        }
        const s = this.session(id);
        if (method === "GET" && path.length === 3) return json(this.view(s));
        const cursor =
          url.searchParams.get("cursor") ??
          (typeof request.headers["last-event-id"] === "string"
            ? request.headers["last-event-id"]
            : undefined);
        if (method === "GET" && path[3] === "items")
          return json(this.store.history(id, cursor));
        if (method === "GET" && path[3] === "events") {
          const history = this.store.history(id, cursor);
          const set = this.observers.get(id) ?? new Set<ServerResponse>();
          this.observers.set(id, set);
          this.sse(request, response, set);
          for (const event of history.items)
            this.send(
              response,
              `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          return;
        }
      }
      fail(404, "Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof HttpError || error instanceof VaultError
          ? error.status
          : (error as any)?.name === "ZodError" ||
              (error as Error)?.message === "Invalid cursor"
            ? 400
            : 500;
      json(
        {
          status: "rejected",
          code: status === 500 ? "internal_error" : "request_rejected",
          message:
            status === 500
              ? "Runtime request failed"
              : (error as Error).message,
        },
        status,
      );
    }
  }
  private view(s: Session): unknown {
    return {
      id: s.id,
      agentId: s.agentId,
      ownerUserId: s.ownerUserId,
      manifestHash: s.manifestHash,
      implementationVersion: s.implementationVersion,
      status: s.status,
      activeTurnId: s.activeTurnId,
      vaultIds: s.vaultIds ?? [],
      credentialSelections: s.credentialSelections ?? [],
      mcpSnapshot: s.mcpSnapshot ?? null,
      mcpDiagnostics: s.mcpDiagnostics ?? [],
      waits: Array.isArray(s.waits)
        ? s.waits.map((call: any) => ({
            invocationId: call.invocationId,
            interaction: call.interaction,
            wait: call.wait,
            status: call.status,
          }))
        : s.waits,
      error: s.error,
      actions: this.store
        .all<Action>("actions")
        .filter(
          (a) =>
            a.sessionId === s.id &&
            !["completed", "cancelled"].includes(a.status),
        ),
      uncertainEffects: this.store
        .all("effects")
        .filter((e) => e.request.sessionId === s.id && e.status === "uncertain")
        .map((e) => ({
          effectId: e.request.effectId,
          turnId: e.request.turnId,
          kind: e.request.kind,
          error: e.error,
        })),
    };
  }
  private async prepareMcp(id: string, signal: AbortSignal): Promise<void> {
    const s = this.session(id);
    const declared = s.manifest.capabilities.some(
      (capability: { mcpServers?: object }) =>
        capability.mcpServers !== undefined &&
        Object.keys(capability.mcpServers).length > 0,
    );
    if (!declared) return;
    if (!s.mcpSnapshot) {
      const found = await this.mcp.discover({
        sessionId: id,
        manifest: s.manifest,
        manifestHash: s.manifestHash,
        pluginRoots: s.pluginRoots ?? {},
        signal,
      });
      this.store.tx(() => {
        const current = this.session(id);
        if (current.mcpSnapshot) return;
        current.mcpSnapshot = found.snapshot;
        current.mcpDiagnostics = found.diagnostics;
        this.store.put("sessions", id, current);
      });
      return;
    }
    const diagnostics = await this.mcp.reconnect({
      sessionId: id,
      manifest: s.manifest,
      pluginRoots: s.pluginRoots ?? {},
      tools: s.mcpSnapshot.mcpTools,
      signal,
    });
    if (diagnostics.length === 0) return;
    this.store.tx(() => {
      const current = this.session(id);
      const prior = [...(current.mcpDiagnostics ?? [])];
      for (const item of diagnostics) {
        const index = prior.findIndex(
          (existing) =>
            existing.capabilityId === item.capabilityId &&
            existing.serverName === item.serverName,
        );
        if (index >= 0) prior[index] = item;
        else prior.push(item);
      }
      current.mcpDiagnostics = prior;
      this.store.put("sessions", id, current);
    });
  }
  private async callMcpTool(request: HostEffect): Promise<unknown> {
    const s = this.session(request.sessionId);
    const tool = mcpToolOf(s, request.capabilityId, request.toolName);
    if (!tool)
      throw new Error(
        `MCP tool '${request.toolName ?? ""}' is not in the session snapshot`,
      );
    return this.mcp.call({
      sessionId: s.id,
      capabilityId: tool.capabilityId,
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
      args: request.input,
      manifest: s.manifest,
      pluginRoots: s.pluginRoots ?? {},
    });
  }
  async authorize(
    sessionId: string,
    request: { url: string; serverName?: string },
  ): Promise<AuthorizeResult> {
    const s = this.session(sessionId);
    const result = await this.vault.authorize({
      sessionId,
      vaultIds: s.vaultIds ?? [],
      credentialSelections: s.credentialSelections ?? [],
      url: request.url,
      serverName: request.serverName,
    });
    if (result.status === "authorized") {
      const token = result.headers.authorization.slice("Bearer ".length);
      scrub({ authorization: result.headers.authorization, url: result.url }, [
        token,
      ]);
    }
    return result;
  }
  private ensureKek(): Buffer {
    if (this.kek) return this.kek;
    if (this.options.vaultKek === null)
      throw new Error("Vault key-encryption key is required");
    this.kek = createKekFile(this.kekPath);
    return this.kek;
  }
  private async dispatchVault(
    scope: ExecutorScope | "server",
    method: string | undefined,
    path: string[],
    url: URL,
    request: IncomingMessage,
  ): Promise<unknown> {
    if (scope !== "server") {
      this.vault.reject(path.join("/"));
      fail(403, "Application credential required");
    }
    if (path.length === 2 && method === "POST") {
      const body = CreateVaultRequestSchema.parse(await this.body(request));
      return this.vault.createVault(body);
    }
    if (path.length === 2 && method === "GET") {
      const ownerUserId =
        url.searchParams.get("ownerUserId") ??
        fail(400, "ownerUserId is required");
      return { vaults: this.vault.listVaults(ownerUserId) };
    }
    const vaultId = path[2];
    if (!vaultId) fail(404, "Vault not found");
    if (path.length === 3 && method === "GET") return this.vault.getVault(vaultId);
    if (path.length === 3 && method === "DELETE")
      return this.vault.deleteVault(vaultId);
    if (path[3] !== "credentials") fail(404, "Route not found");
    if (path.length === 4 && method === "POST") {
      const body = CreateCredentialRequestSchema.parse(await this.body(request));
      return this.vault.createCredential(vaultId, body);
    }
    if (path.length === 4 && method === "GET")
      return { credentials: this.vault.listCredentials(vaultId) };
    const credentialId = path[4];
    if (!credentialId) fail(404, "Credential not found");
    if (path.length === 5 && method === "GET")
      return this.vault.getCredential(vaultId, credentialId);
    if (path.length === 5 && method === "POST") {
      const body = RotateCredentialRequestSchema.parse(await this.body(request));
      return this.vault.rotateCredential(vaultId, credentialId, body);
    }
    if (path.length === 5 && method === "DELETE")
      return this.vault.deleteCredential(vaultId, credentialId);
    fail(404, "Route not found");
  }
  async listen(port = 8787, hostname = "127.0.0.1"): Promise<{ url: string }> {
    if (this.server) throw new Error("Already listening");
    this.server = createServer((q, s) => {
      void this.handle(q, s);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, hostname, resolve);
    });
    const address = this.server.address();
    return {
      url: `http://${hostname}:${typeof address === "object" && address ? address.port : port}`,
    };
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const c of this.running.values()) c.abort();
    await this.mcp.close();
    for (const r of this.executors) r.end();
    for (const set of this.observers.values()) for (const r of set) r.end();
    if (this.server)
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.closeIdleConnections();
      });
    // Providers must honor AbortSignal. Keep storage open until any in-flight journal writes have drained.
    while (this.running.size)
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.store.db.close();
    if (this.lockPath) unlinkSync(this.lockPath);
  }
}
export function createRuntime(options: RuntimeOptions): CoreRuntime {
  return new CoreRuntime(options);
}
export async function startRuntime(
  options: RuntimeOptions & { port?: number; hostname?: string },
): Promise<CoreRuntime & { url: string }> {
  const runtime = createRuntime(options);
  try {
    const { url } = await runtime.listen(options.port, options.hostname);
    return Object.assign(runtime, { url });
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
