import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import {
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProjectCredentialStore } from "./auth-store.js";

export type Selection = Readonly<{
  provider: string;
  model: string;
  custom?: Readonly<{ baseUrl: string }>;
}>;

export function modelsFor(
  selection: Selection,
  credentials: ProjectCredentialStore,
) {
  const models = builtinModels({ credentials });
  if (!selection.custom) return models;
  const model: Model<"openai-completions"> = {
    id: selection.model,
    name: selection.model,
    api: "openai-completions",
    provider: "custom",
    baseUrl: selection.custom.baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
  models.setProvider(
    createProvider({
      id: "custom",
      name: "Custom OpenAI-compatible",
      baseUrl: selection.custom.baseUrl,
      auth: {
        apiKey: envApiKeyAuth("Custom API key", ["NYLO_CUSTOM_API_KEY"]),
      },
      models: [model],
      api: { stream, streamSimple },
    }),
  );
  return models;
}
