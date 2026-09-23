/** The dependency-free JSON contract a developer-owned agent server exposes to Studio. */
export type StudioDiscoveryDocument = Readonly<{
  protocolVersion: 1 | 2;
  agents: readonly StudioDiscoveryEntry[];
  /** A host-owned, non-secret instruction shown before agents can be used. */
  setup?: Readonly<{
    state: "required";
    title: string;
    detail: string;
    command: string;
  }>;
}>;

export type StudioDiscoveryEntry = Readonly<{
  id: string;
  manifestUrl: string;
}>;

export function isStudioDiscovery(
  value: unknown
): value is StudioDiscoveryDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.protocolVersion === 1 || candidate.protocolVersion === 2) &&
    Array.isArray(candidate.agents)
  );
}

export type StudioEndpointSet = Readonly<{
  agUi: string;
  sessions: string;
}>;

export type StudioManifestTool = Readonly<{
  name: string;
  description?: string;
  inputSchema?: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
}>;

export type StudioHookPoint = Readonly<{
  at: "before" | "after";
  scope: "turn" | "step";
}>;

export type StudioCapabilityManifest = Readonly<{
  id: string;
  instructions?: readonly string[];
  hooks?: readonly StudioHookPoint[];
  tools?: readonly StudioManifestTool[];
  model?: Readonly<{
    id?: string;
    controls?: Readonly<{ temperature?: number; maxOutputTokens?: number }>;
  }>;
}>;

type StudioInnerManifest = Readonly<{
  id: string;
  name: string;
  outputSchema?: Readonly<Record<string, unknown>>;
  capabilities?: readonly StudioCapabilityManifest[];
  middleware?: readonly StudioCapabilityManifest[];
}>;

/** A generated, JSON-safe description of one direct Harness agent. */
export type StudioAgentManifest = Readonly<{
  protocolVersion: 1 | 2;
  id: string;
  name: string;
  manifest?: StudioInnerManifest;
  engine?: Readonly<{ name: string; details?: unknown }>;
  harness?: Readonly<{
    manifest: StudioInnerManifest;
  }>;
  endpoints: StudioEndpointSet;
}>;

export function manifestCapabilities(
  agent: StudioAgentManifest
): readonly StudioCapabilityManifest[] {
  return (
    agent.manifest?.capabilities ??
    agent.manifest?.middleware ??
    agent.harness?.manifest.capabilities ??
    agent.harness?.manifest.middleware ??
    []
  );
}
