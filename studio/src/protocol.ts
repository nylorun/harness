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
  value: unknown,
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

export type StudioMiddlewareManifest = Readonly<{
  id: string;
  instructions?: readonly string[];
  tools?: readonly Readonly<{ name: string; description?: string }>[];
  model?: Readonly<{ id?: string; controls?: Readonly<{ temperature?: number; maxOutputTokens?: number }> }>;
}>;

/** A generated, JSON-safe description of one direct Harness agent. */
export type StudioAgentManifest = Readonly<{
  protocolVersion: 1 | 2;
  id: string;
  name: string;
  manifest?: Readonly<{ id: string; name: string; middleware?: readonly StudioMiddlewareManifest[] }>;
  engine?: Readonly<{ name: string; details?: unknown }>;
  harness?: Readonly<{
    manifest: Readonly<{
      id: string;
      name: string;
      middleware: readonly StudioMiddlewareManifest[];
    }>;
  }>;
  endpoints: StudioEndpointSet;
}>;

export function manifestMiddleware(agent: StudioAgentManifest): readonly StudioMiddlewareManifest[] {
  return agent.manifest?.middleware ?? agent.harness?.manifest.middleware ?? [];
}
