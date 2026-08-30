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

/** A generated, JSON-safe description of one direct Harness agent. */
export type StudioAgentManifest = Readonly<{
  protocolVersion: 1;
  id: string;
  name: string;
  description: string;
  capabilities: readonly string[];
  requirements?: Readonly<Record<string, boolean>>;
  model: Readonly<{ provider: string; id: string }>;
  harness: Readonly<{ name: "@nylorun/harness"; version: string; manifest: Readonly<{ middleware: readonly Readonly<{ id: string }>[] }> }>;
  endpoints: StudioEndpointSet;
  records?: Readonly<{ path: string }>;
}>;
