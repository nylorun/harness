export type AgentManifest = {
  id: string;
  name: string;
  manifest: {
    capabilities: readonly {
      id: string;
      tools?: readonly { name: string; description?: string }[];
    }[];
  };
};

export type SessionSummary = {
  session: string;
  status: string;
  title?: string;
  startedAt: number;
};

export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly AgentManifest[];
  sessionsByAgent: Record<string, SessionSummary[]>;
};
