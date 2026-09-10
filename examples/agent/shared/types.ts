import type { BuiltAgent, ModelAdapter } from "@nylorun/harness";
import type { MediaStore } from "@nylorun/runtime";
import type { ImageEditor } from "../interior-design/image-editor.js";

export type ExampleAgent = BuiltAgent & { close?: () => Promise<void> };

export type AgentDependencies = Readonly<{
  adapter: ModelAdapter;
  provider: string;
  model: string;
  dataRoot: string;
  media: MediaStore;
  imageEditor?: ImageEditor;
}>;

export const exampleInstructions =
  "Use tools when they are the most reliable way to answer. Be concise and report tool results.";

export const modelSelection = (provider: string, model: string) =>
  ({
    id: "model",
    model: { id: `${provider}/${model}`, controls: { temperature: 0.1 } },
  }) as const;
