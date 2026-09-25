import type { WorkflowManifest } from "@/workflow/types";

export type HookPoint = {
  at: "before" | "after";
  scope: "turn" | "step";
};

/** Agent definition as listed by Runtime (no `kind`, or legacy). */
export type AgentDefinition = {
  id: string;
  name: string;
  kind?: undefined;
  manifest: {
    id?: string;
    kind?: undefined;
    capabilities: readonly {
      id: string;
      tools?: readonly { name: string; description?: string }[];
      hooks?: readonly HookPoint[];
      instructions?: string;
    }[];
  };
};

/** Workflow definition document (`kind: "workflow"`). */
export type WorkflowDefinition = {
  id: string;
  name: string;
  kind: "workflow";
  manifest: WorkflowManifest;
};

export type StudioDefinition = AgentDefinition | WorkflowDefinition;

/** @deprecated Prefer StudioDefinition; kept for existing imports. */
export type AgentManifest = StudioDefinition;

export type SessionSummary = {
  session: string;
  status: string;
  title?: string;
  startedAt: number;
};

export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly StudioDefinition[];
  sessionsByAgent: Record<string, SessionSummary[]>;
};
