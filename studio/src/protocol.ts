/** The dependency-free JSON contract a developer-owned agent server exposes to Studio. */
export type StudioDiscoveryDocument = Readonly<{
  protocolVersion: 1;
  agents: readonly StudioDiscoveryEntry[];
}>;

export type StudioDiscoveryEntry = Readonly<{
  id: string;
  manifestUrl: string;
}>;

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
  protocolVersion: 1;
  id: string;
  name: string;
  harness: Readonly<{
    manifest: Readonly<{
      id: string;
      name: string;
      middleware: readonly StudioMiddlewareManifest[];
    }>;
  }>;
  endpoints: StudioEndpointSet;
}>;
