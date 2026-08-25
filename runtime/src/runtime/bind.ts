import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentManifest as HarnessManifest, BuiltAgent as HarnessAgent, InputEvent, InputHandle, ObserveEvent, Session, SessionEvent } from "@nylorun/harness";
import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { stableJson } from "../manifest.js";
import type { AgentConfig, CapabilityManifest, FolderDiagnostic } from "../types.js";
import { resolveCredential } from "./credentials.js";
import type { ModelGatewayAdapter, RuntimeSessionState, WireSessionEvent } from "./contracts.js";
import { resolveModel, type ResolvedModel } from "./model.js";
import { GatewayModelInvoker } from "./model-invoker.js";
import { PiModelGatewayAdapter, type RetryPolicy } from "./pi-model-gateway.js";
import type { RecordWriter, SessionRecorder } from "./record-store.js";
import { createMemorySessionStore, type SessionRecord, type SessionStore } from "./session-store.js";
import { loadSkills } from "./skills.js";
import { bridgeTools, type ToolModule } from "./tools.js";

export type RuntimeOptions = Readonly<{
  modelGatewayAdapter?: ModelGatewayAdapter;
  modelGatewayTransport?: Readonly<{ fetch?: typeof globalThis.fetch; retry?: RetryPolicy; headers?: Readonly<Record<string, string>>; requestIdHeader?: string }>;
  env?: Readonly<Record<string, string | undefined>>;
  strict?: boolean;
  store?: SessionStore;
  recorder?: SessionRecorder;
}>;

export type StartOptions = Readonly<{ signal?: AbortSignal; sessionId?: string }>;
export type RunResult = Readonly<{ state: RuntimeSessionState; output: string }>;
export type AgentRun = Readonly<{ id: string; events: AsyncIterable<WireSessionEvent>; result: Promise<RunResult>; cancel(reason?: string): void }>;
export type AgentReadiness = Readonly<{ manifest: CapabilityManifest; diagnostics: readonly FolderDiagnostic[]; model?: ResolvedModel; harness: HarnessManifest }>;
export type AgentSessions = Readonly<{
  start(input?: string, options?: StartOptions): AgentRun;
  send(id: string, input: string): Promise<boolean>;
  interact(id: string, input: Extract<InputEvent, { kind: "approve" | "respond" }>): Promise<boolean>;
  cancel(id: string, reason?: string): Promise<boolean>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(): Promise<readonly SessionRecord[]>;
  events(id: string, cursor?: number): Promise<readonly WireSessionEvent[] | undefined>;
  follow(id: string, cursor?: number): AsyncIterable<WireSessionEvent> | undefined;
  settled(id: string): Promise<void> | undefined;
  claim(key: string, id: string): Promise<string>;
}>;
export type BuiltAgent = Readonly<{
  config: AgentConfig;
  inspect(): Promise<Readonly<{ manifest: CapabilityManifest }>>;
  ready(): Promise<AgentReadiness>;
  session: AgentSessions;
  bound: boolean;
  withHost(options: RuntimeOptions): BuiltAgent;
  close(): Promise<void>;
  readonly records?: SessionRecorder;
}>;
export type BindInput = Readonly<{ moduleUrl: string; config: AgentConfig; toolModules: readonly ToolModule[] }>;

type Live = {
  session?: Session;
  events: WireSessionEvent[];
  waiters: Set<() => void>;
  active?: InputHandle;
  activeAbort?: AbortController;
  settled?: Promise<void>;
  running: boolean;
  state: RuntimeSessionState;
};

export function __nyloBindAgent(input: BindInput): BuiltAgent {
  const root = resolve(dirname(fileURLToPath(input.moduleUrl)), "..");
  const sharedStore = createMemorySessionStore();
  const build = (host: RuntimeOptions): BuiltAgent => {
    const store = host.store ?? sharedStore;
    const live = new Map<string, Live>();
    let readiness: Promise<AgentReadiness> | undefined;
    let closed = false;

    const readManifest = async (): Promise<CapabilityManifest> => {
      try { return JSON.parse(await readFile(join(root, "dist", "nylo.manifest.json"), "utf8")) as CapabilityManifest; }
      catch { throw missing("dist/nylo.manifest.json"); }
    };

    const append = (id: string, type: string, payload: Record<string, unknown>): WireSessionEvent | undefined => {
      const found = live.get(id);
      if (found === undefined) return undefined;
      const event = Object.freeze({ session: id, seq: found.events.length + 1, ts: new Date().toISOString(), type, payload: jsonRecord(payload) });
      found.events.push(event);
      for (const waiter of found.waiters) waiter();
      found.waiters.clear();
      return event;
    };

    const prepare = (): Promise<AgentReadiness> => {
      readiness ??= (async () => {
        const manifest = await readManifest();
        const diagnostics: FolderDiagnostic[] = [];
        const bridged = bridgeTools(input.toolModules);
        if (stableJson(bridged.descriptors) !== stableJson(manifest.tools)) diagnostics.push(diagnostic("NYLO_RUN_ARTIFACT_STALE", "run", "warning", "dist/nylo.manifest.json", "The manifest tools differ from the bundle tools; running the bundle.", "Rebuild the project."));
        const loaded = await loadSkills(root, manifest.skills ?? []);
        diagnostics.push(...loaded.diagnostics);
        let model: ResolvedModel | undefined;
        let gateway = host.modelGatewayAdapter;
        if (gateway === undefined) {
          model = await resolveModel(input.config.model, { projectRoot: root, ...(host.env === undefined ? {} : { env: host.env }), ...(host.modelGatewayTransport?.fetch === undefined ? {} : { fetch: host.modelGatewayTransport.fetch }) });
          const selected = model;
          gateway = new PiModelGatewayAdapter({
            baseUrl: selected.baseUrl,
            model: input.config.model,
            upstreamModel: selected.upstreamModel,
            protocol: selected.protocol,
            accessMode: selected.accessMode,
            capabilities: selected.capabilities,
            credential: async () => (await resolveCredential(selected.credentialVariables, { projectRoot: root, ...(host.env === undefined ? {} : { env: host.env }) }))?.value,
            credentialRequired: selected.credentialRequired,
            credentialHeader: selected.credentialHeader,
            credentialPrefix: selected.credentialPrefix,
            headers: { ...selected.headers, ...host.modelGatewayTransport?.headers },
            requestIdHeader: host.modelGatewayTransport?.requestIdHeader ?? selected.requestIdHeader,
            retry: host.modelGatewayTransport?.retry,
            fetch: host.modelGatewayTransport?.fetch
          });
        }
        for (const name of input.config.secrets) if (await resolveCredential([name], { projectRoot: root, ...(host.env === undefined ? {} : { env: host.env }) }) === undefined) diagnostics.push(diagnostic("NYLO_RUN_SECRET_MISSING", "run", "warning", ".env", `The agent declares missing secret ${name}.`, `Set ${name} before running.`));
        if (host.strict === true) {
          const warning = diagnostics.find((item) => item.severity === "warning");
          if (warning !== undefined) throw new NyloBuildError(warning);
        }
        const invoker = new GatewayModelInvoker(input.config.model, gateway, (call) => {
          append(call.sessionId, "model.call", { content: call.content, tool_calls: call.toolCalls.map((item) => ({ id: item.id, name: item.name, arguments: JSON.stringify(item.args) })), tokens_in: call.usage.tokensIn, tokens_out: call.usage.tokensOut, ...(call.evidence ?? {}) });
        });
        const builder = input.config.harness(invoker);
        builder.with(bridged.adapter);
        const instructions = [input.config.instructions ?? "", ...loaded.skills.map((skill) => `Skill: ${skill.name}\n${skill.body}`)].filter(Boolean);
        builder.prepend("nylorun-folder", async (request, next) => {
          for (const item of bridged.tools) request.tools.add(item);
          for (const text of instructions) request.instructions.add(text);
          return next();
        });
        boundAgent = builder.build();
        return Object.freeze({ manifest, diagnostics: Object.freeze(diagnostics), ...(model === undefined ? {} : { model }), harness: boundAgent.manifest });
      })();
      return readiness;
    };
    let boundAgent: HarnessAgent;

    const startInput = (id: string, event: InputEvent, options: StartOptions = {}): AgentRun => {
      if (closed) throw new Error("Agent runtime is closed.");
      let found = live.get(id);
      const from = found?.events.length ?? 0;
      if (found === undefined) {
        found = { events: [], waiters: new Set(), running: true, state: Object.freeze({ session: id, status: "requested", seq: 0, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, output: "" }) };
        live.set(id, found);
        void store.create({ id, status: "requested", startedAt: Date.now() });
      } else if (found.running) throw new Error(`Session ${id} already has an active input.`);
      found.running = true;
      let cancel = (reason?: string): void => { live.get(id)?.activeAbort?.abort(new Error(reason ?? "cancelled")); };
      const result = (async (): Promise<RunResult> => {
        const ready = await prepare();
        const found = live.get(id)!;
        if (found.session === undefined) {
          found.session = boundAgent.run({ id });
          found.session.observe((event) => projectObservation(event, id, append));
          void (async () => {
            for await (const harnessEvent of found.session!.stream()) appendHarnessEvent(id, harnessEvent, append);
          })();
        }
        const abort = new AbortController();
        found.activeAbort = abort;
        const run = found.session.input(event, { signal: options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]) });
        append(id, "session.run.started", event.kind === "user-message" || event.kind === "interrupt" ? { input: event.text, input_kind: event.kind } : { input_kind: event.kind, interaction_id: event.interactionId });
        await store.setStatus(id, "running");
        const writer = await openWriter(host.recorder, id, input.config, ready.manifest);
        const writeFrom = found.events.length - 1;
        found.active = run;
        cancel = (reason?: string) => abort.abort(new Error(reason ?? "cancelled"));
        const completion = await run.completed;
        await waitForSessionEvents(found, completion.events);
        found.running = false;
        found.active = undefined;
        found.activeAbort = undefined;
        found.state = runtimeState(id, found.session, found.events.length, finalOutput(found.events));
        append(id, "session.run.ended", { state: found.state.status, completion: completion.status });
        found.state = runtimeState(id, found.session, found.events.length, finalOutput(found.events));
        const status = found.state.status;
        await store.setStatus(id, status);
        if (writer !== undefined) {
          for (const item of found.events.slice(writeFrom)) writer.append(item);
          await writer.close(found.state);
        }
        return Object.freeze({ state: found.state, output: found.state.output });
      })();
      const settled = result.then(() => undefined, () => undefined).then(() => { const found = live.get(id); if (found) { found.running = false; for (const waiter of found.waiters) waiter(); found.waiters.clear(); } });
      void result.catch(() => undefined);
      live.get(id)!.settled = settled;
      return Object.freeze({ id, events: followFrom(id, from, live), result, cancel: (reason) => cancel(reason) });
    };

    const sessions: AgentSessions = Object.freeze({
      start(text, options = {}) { return startInput(options.sessionId ?? randomUUID(), { kind: "user-message", text: text ?? "" }, options); },
      async send(id, text) { if (text.trim() === "" || !live.has(id) || live.get(id)!.running) return false; startInput(id, { kind: "user-message", text }); return true; },
      async interact(id, event) { const found = live.get(id); if (found?.session === undefined || found.running || found.session.state.status !== "waiting") return false; startInput(id, event); return true; },
      async cancel(id, reason) { const found = live.get(id); if (found === undefined) return false; found.activeAbort?.abort(new Error(reason ?? "cancelled")); return true; },
      get: (id) => store.get(id), list: () => store.list(), claim: (key, id) => store.claim(key, id),
      async events(id, cursor = 0) { const found = live.get(id); if (found !== undefined) return Object.freeze(found.events.filter((event) => event.seq > cursor)); const recorded = await host.recorder?.read(id); return recorded === undefined ? undefined : Object.freeze(recorded.filter((event) => event.seq > cursor)); },
      follow(id, cursor = 0) { return live.has(id) ? followFrom(id, cursor, live) : undefined; },
      settled(id) { return live.get(id)?.settled; }
    });

    return Object.freeze({
      config: input.config,
      inspect: async () => Object.freeze({ manifest: await readManifest() }),
      ready: prepare,
      session: sessions,
      bound: true,
      withHost(next) { return build({ ...host, ...next }); },
      async close() {
        if (closed) return;
        closed = true;
        for (const found of live.values()) found.activeAbort?.abort(new Error("Runtime closing"));
        await Promise.allSettled([...live.values()].flatMap((found) => found.settled === undefined ? [] : [found.settled]));
        for (const found of live.values()) await found.session?.stop("Runtime closing");
        if (readiness !== undefined) await readiness;
      },
      ...(host.recorder === undefined ? {} : { records: host.recorder })
    });
  };
  return build({});
}

export function __nyloUnboundAgent(config: AgentConfig): BuiltAgent {
  const refuse = (): never => { throw new NyloBuildError(diagnostic("NYLO_RUN_AGENT_UNBOUND", "run", "error", "agent/agent.ts", "This agent has not been built.", "Run the build and import dist/agent.mjs.")); };
  return Object.freeze({ config, bound: false, inspect: async () => refuse(), ready: async () => refuse(), session: { start: refuse, send: async () => refuse(), interact: async () => refuse(), cancel: async () => refuse(), get: async () => refuse(), list: async () => refuse(), events: async () => refuse(), follow: refuse, settled: refuse, claim: async () => refuse() }, withHost: () => __nyloUnboundAgent(config), close: async () => {} });
}

function appendHarnessEvent(id: string, event: SessionEvent, append: (id: string, type: string, payload: Record<string, unknown>) => unknown): void {
  const { type, ...payload } = event;
  append(id, type, payload);
}
async function waitForSessionEvents(found: Live, events: readonly SessionEvent[]): Promise<void> {
  for (const event of events) {
    while (!found.events.some((item) => sameConversationEvent(item, event))) {
      await new Promise<void>((resume) => found.waiters.add(resume));
    }
  }
}
function sameConversationEvent(wire: WireSessionEvent, event: SessionEvent): boolean {
  if (wire.type !== event.type) return false;
  const { type: _type, ...payload } = event;
  return JSON.stringify(wire.payload) === JSON.stringify(jsonRecord(payload));
}
function projectObservation(event: ObserveEvent, id: string, append: (id: string, type: string, payload: Record<string, unknown>) => unknown): void {
  append(id, "harness.observe", {
    observation: event.type,
    ...("turnId" in event && event.turnId !== undefined ? { turn_id: event.turnId } : {}),
    ...("stepId" in event && event.stepId !== undefined ? { step_id: event.stepId } : {}),
    ...("adapterId" in event && event.adapterId !== undefined ? { adapter_id: event.adapterId } : {}),
    ...("attributes" in event && event.attributes !== undefined ? { attributes: event.attributes } : {})
  });
}
function runtimeState(id: string, session: Session, seq: number, output: string): RuntimeSessionState {
  const status = session.state.status === "idle" ? "paused" : session.state.status === "stopped" ? "completed" : session.state.status;
  return Object.freeze({ session: id, status, seq, turns: session.state.turnCount, tokensIn: 0, tokensOut: 0, costUsd: 0, output, ...(session.state.pendingInteraction === undefined ? {} : { pendingInteraction: session.state.pendingInteraction }) });
}
function finalOutput(events: readonly WireSessionEvent[]): string { for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]!; if (event.type === "final" && typeof event.payload.output === "string") return event.payload.output; } return ""; }
function followFrom(id: string, cursor: number, live: Map<string, Live>): AsyncIterable<WireSessionEvent> { return { async *[Symbol.asyncIterator]() { let at = cursor; while (true) { const found = live.get(id); if (found === undefined) return; while (at < found.events.length) yield found.events[at++]!; if (!found.running) return; await new Promise<void>((resume) => found.waiters.add(resume)); } } }; }
function jsonRecord(value: Record<string, unknown>): Record<string, import("@nylorun/harness").JsonValue> { try { return JSON.parse(JSON.stringify(value)) as Record<string, import("@nylorun/harness").JsonValue>; } catch { return { error: "unserializable runtime event" }; } }
async function openWriter(recorder: SessionRecorder | undefined, id: string, config: AgentConfig, manifest: CapabilityManifest): Promise<RecordWriter | undefined> { try { return await recorder?.open(id, { agent: config.name, model: config.model, bundleDigest: manifest.bundleDigest, manifestDigest: manifest.digest }); } catch { return undefined; } }
function missing(file: string): NyloBuildError { return new NyloBuildError(diagnostic("NYLO_RUN_ARTIFACT_MISSING", "run", "error", file, `The built artifact ${file} is missing or unreadable.`, "Run the project build.")); }
