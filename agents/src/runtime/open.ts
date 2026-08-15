import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { stableJson } from "../manifest.js";
import {
  createSession,
  type EventSink,
  type ProviderAdapter,
  type SessionEvent,
  type SessionLimits,
  type SessionState
} from "../session/index.js";
import type { AgentConfig, CapabilityManifest, FolderDiagnostic } from "../types.js";
import { resolveCredential } from "./credentials.js";
import { resolveModel, type ResolvedModel } from "./model.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { loadSkills } from "./skills.js";
import { bridgeTools, type ToolModule } from "./tools.js";

export type OpenOptions = Readonly<{
  /** Overrides provider resolution entirely. When given, no credential is looked up. */
  provider?: ProviderAdapter;
  /** Overrides the resolved provider origin. Intended for testing against a local stub. */
  baseUrl?: string;
  env?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<SessionLimits>;
  /** Promotes run-phase warnings to errors. */
  strict?: boolean;
}>;

export type RunResult = Readonly<{
  state: SessionState;
  output: string;
}>;

export type AgentRun = Readonly<{
  events: AsyncIterable<SessionEvent>;
  result: Promise<RunResult>;
  cancel(reason?: string): void;
}>;

export type EmbeddedAgent = Readonly<{
  config: AgentConfig;
  manifest: CapabilityManifest;
  /** Non-fatal findings from opening the project — a stale skill digest, most often. */
  diagnostics: readonly FolderDiagnostic[];
  /** Absent when `options.provider` was supplied. */
  model?: ResolvedModel;
  run(input: string, options?: Readonly<{ signal?: AbortSignal }>): AgentRun;
}>;

type Bundle = Readonly<{ config?: AgentConfig; toolModules?: readonly ToolModule[] }>;

function missing(file: string): NyloBuildError {
  return new NyloBuildError(
    diagnostic(
      "NYLO_RUN_ARTIFACT_MISSING",
      "run",
      "error",
      file,
      `The built artifact ${file} is missing or unreadable.`,
      "Run the project's build before opening it; openAgent does not build on your behalf."
    )
  );
}

/**
 * Opens a project that has already been built.
 *
 * It does not build on the caller's behalf: a program that silently rebuilds is one whose startup
 * cost and execution boundary are both invisible. The scaffold's `dev` script composes the two
 * steps explicitly instead, so both stay visible in the builder's own `package.json`.
 */
export async function openAgent(projectRoot: string, options: OpenOptions = {}): Promise<EmbeddedAgent> {
  const root = resolve(projectRoot);
  const bundlePath = join(root, "dist", "agent.mjs");
  const manifestPath = join(root, "dist", "nylo.manifest.json");

  let manifest: CapabilityManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CapabilityManifest;
  } catch {
    throw missing("dist/nylo.manifest.json");
  }

  let bundle: Bundle;
  try {
    bundle = (await import(pathToFileURL(bundlePath).href)) as Bundle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") throw missing("dist/agent.mjs");
    throw error;
  }

  const config = bundle.config;
  if (config === undefined || typeof config.model !== "string") {
    throw new NyloBuildError(
      diagnostic(
        "NYLO_RUN_ARTIFACT_INVALID",
        "run",
        "error",
        "dist/agent.mjs",
        "The built bundle does not export an Agent configuration.",
        "Rebuild the project."
      )
    );
  }

  const diagnostics: FolderDiagnostic[] = [];
  const { registrations, descriptors } = bridgeTools(bundle.toolModules ?? []);

  // The manifest is a staleness check, not a source of truth: the descriptors above were re-derived
  // from the live modules, so a disagreement means the artifact halves are out of step.
  if (stableJson(descriptors) !== stableJson(manifest.tools)) {
    diagnostics.push(
      diagnostic(
        "NYLO_RUN_ARTIFACT_STALE",
        "run",
        "warning",
        "dist/nylo.manifest.json",
        "The manifest's tools do not match the bundle's; running with the bundle.",
        "Rebuild the project so both halves of dist/ come from the same source."
      )
    );
  }

  const loadedSkills = await loadSkills(root, manifest.skills ?? []);
  diagnostics.push(...loadedSkills.diagnostics);

  if (options.strict) {
    const promoted = diagnostics.filter((item) => item.severity === "warning");
    if (promoted.length > 0) throw new NyloBuildError(promoted[0]);
  }

  let model: ResolvedModel | undefined;
  let provider = options.provider;
  if (provider === undefined) {
    model = await resolveModel(config.model, {
      projectRoot: root,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl })
    });
    provider = new OpenAICompatibleProvider({
      baseUrl: model.baseUrl,
      model: config.model,
      upstreamModel: model.upstreamModel,
      apiKey: model.credential.value
    });
  }

  // Declared secrets are resolved once, here, so a missing one is reported before a session starts
  // rather than when a tool first reaches for it.
  for (const name of config.secrets ?? []) {
    const found = await resolveCredential([name], {
      projectRoot: root,
      ...(options.env === undefined ? {} : { env: options.env })
    });
    if (found === undefined) {
      diagnostics.push(
        diagnostic(
          "NYLO_RUN_SECRET_MISSING",
          "run",
          "warning",
          ".env",
          `The agent declares a secret named ${name}, which is not set.`,
          `Set ${name} in your environment or .env before running.`
        )
      );
    }
  }

  const resolvedProvider = provider;
  const definition = Object.freeze({
    name: config.name,
    model: config.model,
    instructions: config.instructions ?? "",
    skills: loadedSkills.skills
  });

  return Object.freeze({
    config,
    manifest,
    diagnostics: Object.freeze(diagnostics),
    ...(model === undefined ? {} : { model }),
    run(input, runOptions = {}) {
      const queue: SessionEvent[] = [];
      let notify: (() => void) | undefined;
      let finished = false;
      const sink: EventSink = {
        append(event) {
          queue.push(event);
          notify?.();
        }
      };

      const session = createSession({
        sessionId: randomUUID(),
        definition,
        provider: resolvedProvider,
        tools: registrations,
        sink,
        ...(options.limits === undefined ? {} : { limits: options.limits })
      });

      // The loop owns cancellation; an external signal is forwarded into it rather than racing it.
      runOptions.signal?.addEventListener("abort", () => session.abort("cancelled"), { once: true });

      const result = session
        .start(input)
        .then((state) => Object.freeze({ state, output: finalOutput(state) }))
        .finally(() => {
          finished = true;
          notify?.();
        });
      // The consumer may only await `result`; without this the rejection is unhandled.
      result.catch(() => undefined);

      return Object.freeze({
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
            while (true) {
              while (queue.length > 0) yield queue.shift() as SessionEvent;
              if (finished) return;
              await new Promise<void>((wake) => {
                notify = wake;
              });
              notify = undefined;
            }
          }
        },
        result,
        cancel(reason?: string) {
          session.abort(reason ?? "cancelled");
        }
      });
    }
  });
}

function finalOutput(state: SessionState): string {
  for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
    const entry = state.transcript[index];
    if (entry.kind === "assistant" && entry.content !== "") return entry.content;
  }
  return "";
}
