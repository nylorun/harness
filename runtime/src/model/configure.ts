import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { saveEnvironment } from "../environment.js";
import type { AuthInteraction, CredentialStore } from "@earendil-works/pi-ai";
import { ProjectCredentialStore } from "./auth-store.js";
import { modelsFor, type Selection } from "./models.js";

export class ConfigurationCancelled extends Error {
  readonly exitCode: number;
  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`Provider configuration cancelled (${signal}).`);
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

// Internal options also allow isolated prompt tests without changing process globals.
export async function configureProvider(
  options: {
    signal?: AbortSignal;
    root?: string;
    input?: Readable;
    output?: Writable;
  } = {}
) {
  const root = options.root ?? process.cwd();
  const output = options.output ?? process.stdout;
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardAbort = () => controller.abort(options.signal!.reason);
  options.signal?.throwIfAborted();
  let enteredKey: string | undefined;
  let enteredEnvironment: Record<string, string | undefined> = {};
  const oauthStore = new ProjectCredentialStore(
    join(root, ".nylorun", "auth.json"),
    join(root, ".env", "auth.json")
  );
  const store: CredentialStore = {
    read: (id) => oauthStore.read(id),
    list: () => oauthStore.list(),
    delete: (id) => oauthStore.delete(id),
    async modify(id, fn) {
      const next = await fn(await oauthStore.read(id));
      if (next?.type === "api_key") {
        if (next.key === "") throw new Error("An API key is required.");
        enteredKey = next.key;
        enteredEnvironment = { ...next.env };
        return next;
      }
      return oauthStore.modify(id, async () => next);
    },
  };
  const models = modelsFor({ provider: "", model: "" }, store);
  const providers = models.getProviders();
  const prompt = createInterface({
    input: options.input ?? process.stdin,
    output,
  });

  const onInt = () => controller.abort(new ConfigurationCancelled("SIGINT"));
  const onClose = () =>
    controller.abort(
      new Error("Configuration input closed before setup completed.")
    );
  const closeOnAbort = () => prompt.close();
  prompt.on("SIGINT", onInt);
  prompt.on("close", onClose);
  signal.addEventListener("abort", closeOnAbort, { once: true });
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  async function question(message: string): Promise<string> {
    signal.throwIfAborted();
    return prompt.question(message, { signal });
  }

  try {
    signal.throwIfAborted();
    output.write("0. Custom OpenAI-compatible provider\n");
    providers.forEach((provider, index) =>
      output.write(`${index + 1}. ${provider.name} (${provider.id})\n`)
    );
    const choice = Number(await question("Choose a provider: "));
    if (choice === 0) {
      const baseUrl = (await question("OpenAI-compatible base URL: "))
        .trim()
        .replace(/\/$/, "");
      const model = (await question("Model id: ")).trim();
      if (!baseUrl || !model)
        throw new Error("A base URL and model id are required.");
      const selection: Selection = {
        provider: "custom",
        model,
        custom: { baseUrl },
      };
      const customModels = modelsFor(selection, store);
      if (!(await customModels.checkAuth("custom", { signal })))
        await customModels.login("custom", "api_key", interaction());
      await save(selection);
    } else {
      const chosen = providers[choice - 1];
      if (!chosen) throw new Error("Choose a listed provider.");
      const available = models.getModels(chosen.id);
      available.forEach((model, index) =>
        output.write(`${index + 1}. ${model.name} (${model.id})\n`)
      );
      const model = available[Number(await question("Choose a model: ")) - 1];
      if (!model) throw new Error("Choose a listed model.");
      if (!(await models.checkAuth(chosen.id, { signal }))) {
        let method: "api_key" | "oauth" = chosen.auth.apiKey
          ? "api_key"
          : "oauth";
        if (chosen.auth.apiKey && chosen.auth.oauth) {
          const answer = (
            await question(
              "Choose authentication: 1. API key (default), 2. OAuth: "
            )
          ).trim();
          if (answer && !["1", "2"].includes(answer))
            throw new Error("Choose authentication 1 or 2.");
          if (answer === "2") method = "oauth";
        }
        await models.login(chosen.id, method, interaction());
      }
      await save({ provider: chosen.id, model: model.id });
    }
    signal.throwIfAborted();
    output.write("Provider configuration saved.\n");
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    signal.removeEventListener("abort", closeOnAbort);
    prompt.removeListener("SIGINT", onInt);
    prompt.removeListener("close", onClose);
    prompt.close();
  }

  function interaction(): AuthInteraction {
    return {
      signal,
      prompt: async (item) => {
        if (item.type !== "select") return question(item.message + ": ");
        item.options.forEach((option, index) =>
          output.write(`${index + 1}. ${option.label}\n`)
        );
        const answer = (await question(item.message + " ")).trim();
        const option =
          item.options.find((option) => option.id === answer) ??
          item.options[Number(answer) - 1];
        if (!option) throw new Error("Choose a listed authentication option.");
        return option.id;
      },
      notify: (event) => {
        output.write(
          ("url" in event
            ? event.url
            : "verificationUri" in event
            ? event.verificationUri
            : event.message) + "\n"
        );
      },
    };
  }

  async function save(selection: Selection) {
    signal.throwIfAborted();
    await saveEnvironment(
      root,
      {
        ...enteredEnvironment,
        MODEL_PROVIDER: selection.provider,
        MODEL: selection.model,
        MODEL_PROVIDER_BASE_URL: selection.custom?.baseUrl,
        ...(enteredKey === undefined
          ? {}
          : { MODEL_PROVIDER_API_KEY: enteredKey }),
      },
      signal
    );
  }
}
