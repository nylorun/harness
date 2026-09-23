import {
  createProvider,
  defaultProviderAuthContext,
  type CredentialStore,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import {
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type Selection = Readonly<{
  provider: string;
  model: string;
  custom?: Readonly<{ baseUrl: string }>;
}>;

export function modelsFor(
  selection: Selection,
  credentials: CredentialStore,
  options: { environment?: boolean } = {},
) {
  const environmentFirst: CredentialStore = {
    async read(providerId, options) {
      const explicit = process.env.MODEL_PROVIDER_API_KEY;
      if (
        explicit &&
        (!selection.provider || selection.provider === providerId)
      )
        return { type: "api_key", key: explicit };
      const provider = models
        .getProviders()
        .find((item) => item.id === providerId);
      const ambient = await provider?.auth.apiKey?.resolve({
        ctx: defaultProviderAuthContext(),
        signal: options?.signal ?? new AbortController().signal,
      });
      if (ambient) return undefined;
      return credentials.read(providerId, options);
    },
    list: (options) => credentials.list(options),
    modify: (id, fn, options) => credentials.modify(id, fn, options),
    delete: (id, options) => credentials.delete(id, options),
  };
  const models = builtinModels({
    credentials: options.environment === false ? credentials : environmentFirst,
  });
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
        apiKey: envApiKeyAuth("Custom API key", ["MODEL_PROVIDER_API_KEY"]),
      },
      models: [model],
      api: { stream, streamSimple },
    })
  );
  return models;
}
