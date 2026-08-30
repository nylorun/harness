import type { BuiltAgent, ModelAdapter } from "@nylorun/harness";

export type ExampleAgent = Readonly<{
  id: string;
  name: string;
  description: string;
  capabilities: readonly string[];
  requirements?: Readonly<Record<string, boolean>>;
  agent: BuiltAgent;
  close?: () => Promise<void>;
}>;

export type AgentDependencies = Readonly<{
  adapter: ModelAdapter;
  provider: string;
  model: string;
  dataRoot: string;
}>;

export const modelSelection = (provider: string, model: string) =>
  ({
    id: "model",
    model: { id: `${provider}/${model}`, controls: { temperature: 0.1 } },
    instructions: [
      "Use tools when they are the most reliable way to answer. Be concise and report tool results.",
    ],
  }) as const;
