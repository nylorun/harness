import { tmpdir } from "node:os";
import { join } from "node:path";
import { microsandboxBackend } from "../adapters/sandbox/microsandbox.js";
import { virtualBackend } from "../adapters/sandbox/virtual.js";
import type {
  SandboxBackend,
  SandboxBackendName,
  SandboxIsolation,
  SandboxProbe,
} from "./types.js";

export type SandboxPreference = "auto" | SandboxBackendName;
const PREFERENCES: readonly SandboxPreference[] = ["auto", "microsandbox", "virtual"];

export interface SandboxSelection {
  readonly preference: SandboxPreference;
  readonly backend?: SandboxBackend;
  /** Why this backend was chosen, or why none could be. */
  readonly reason: string;
  readonly probes: readonly SandboxProbe[];
}

/** Serializable view of a selection for the CLI and `GET /v1/host/sandbox`. */
export interface SandboxSelectionReport {
  readonly preference: SandboxPreference;
  readonly backend: SandboxBackendName | null;
  readonly isolation: SandboxIsolation | null;
  readonly reason: string;
  readonly probes: readonly SandboxProbe[];
}

/** The default order: strongest isolation first, then the backend that always works. */
export function defaultSandboxBackends(options: { readonly root: string }): SandboxBackend[] {
  return [microsandboxBackend(), virtualBackend({ root: options.root })];
}

export function parseSandboxPreference(value: string | undefined): SandboxPreference | undefined {
  const normalized = (value ?? "auto").trim().toLowerCase() || "auto";
  return (PREFERENCES as readonly string[]).includes(normalized)
    ? (normalized as SandboxPreference)
    : undefined;
}

/**
 * Probe backends in order and pick one. An explicit preference never falls back, so a
 * production Runtime cannot silently run with weaker isolation than it was configured for.
 */
export async function selectSandboxBackend(
  backends: readonly SandboxBackend[],
  preference: SandboxPreference
): Promise<SandboxSelection> {
  const probes: SandboxProbe[] = [];
  for (const backend of backends) probes.push(await backend.probe());
  const probeOf = (name: string) => probes.find((probe) => probe.name === name);
  if (preference !== "auto") {
    const backend = backends.find((item) => item.name === preference);
    const probe = probeOf(preference);
    if (backend && probe?.available)
      return { preference, backend, reason: `${preference} selected by NYLORUN_SANDBOX`, probes };
    return {
      preference,
      reason: `NYLORUN_SANDBOX=${preference} but ${preference} is unavailable: ${probe?.reason ?? "unknown backend"}. Fix it, or unset NYLORUN_SANDBOX to use the best available backend`,
      probes,
    };
  }
  const index = backends.findIndex((_, i) => probes[i]!.available);
  if (index < 0)
    return {
      preference,
      reason: `no sandbox backend is available (${probes.map((probe) => `${probe.name}: ${probe.reason}`).join("; ")})`,
      probes,
    };
  const skipped = probes.slice(0, index).map((probe) => `${probe.name} unavailable: ${probe.reason}`);
  return {
    preference,
    backend: backends[index]!,
    reason: skipped.length ? skipped.join("; ") : probes[index]!.reason ?? backends[index]!.name,
    probes,
  };
}

export function reportSelection(selection: SandboxSelection): SandboxSelectionReport {
  return {
    preference: selection.preference,
    backend: selection.backend?.name ?? null,
    isolation: selection.backend?.isolation ?? null,
    reason: selection.reason,
    probes: selection.probes,
  };
}

/**
 * Probe this machine the way a Runtime would at startup. Used by `nylorun doctor sandbox`.
 * Nothing is created or booted.
 */
export async function probeSandboxBackends(
  options: { readonly preference?: string } = {}
): Promise<SandboxSelectionReport> {
  const preference = parseSandboxPreference(options.preference ?? process.env.NYLORUN_SANDBOX);
  const backends = defaultSandboxBackends({ root: join(tmpdir(), "nylorun-sandbox-probe") });
  if (!preference)
    return {
      preference: "auto",
      backend: null,
      isolation: null,
      reason: "NYLORUN_SANDBOX must be auto, microsandbox or virtual",
      probes: await Promise.all(backends.map((backend) => backend.probe())),
    };
  return reportSelection(await selectSandboxBackend(backends, preference));
}
