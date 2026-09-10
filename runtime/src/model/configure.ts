import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
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
  } = {},
) {
  const root = options.root ?? process.cwd();
  const output = options.output ?? process.stdout;
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardAbort = () => controller.abort(options.signal!.reason);
  options.signal?.throwIfAborted();
  const store = new ProjectCredentialStore(join(root, ".env", "auth.json"));
  const models = modelsFor({ provider: "", model: "" }, store);
  const providers = models.getProviders();
  const prompt = createInterface({
    input: options.input ?? process.stdin,
    output,
  });

  const onInt = () => controller.abort(new ConfigurationCancelled("SIGINT"));
  const onClose = () =>
    controller.abort(
      new Error("Configuration input closed before setup completed."),
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
      output.write(`${index + 1}. ${provider.name} (${provider.id})\n`),
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
      await customModels.login("custom", "api_key", interaction());
      await save(selection);
    } else {
      const chosen = providers[choice - 1];
      if (!chosen) throw new Error("Choose a listed provider.");
      const available = models.getModels(chosen.id);
      available.forEach((model, index) =>
        output.write(`${index + 1}. ${model.name} (${model.id})\n`),
      );
      const model = available[Number(await question("Choose a model: ")) - 1];
      if (!model) throw new Error("Choose a listed model.");
      if (!(await models.checkAuth(chosen.id, { signal }))) {
        await models.login(
          chosen.id,
          chosen.auth.oauth ? "oauth" : "api_key",
          interaction(),
        );
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

  function interaction() {
    return {
      signal,
      prompt: async (item: any) => question(item.message + ": "),
      notify: (event: any) =>
        output.write(
          (event.url ?? event.verificationUri ?? event.message) + "\n",
        ),
    };
  }

  async function save(selection: Selection) {
    signal.throwIfAborted();
    const directory = join(root, "config");
    const temporary = join(directory, `.model-${randomUUID()}.json`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(selection, null, 2) + "\n", {
        signal,
      });
      signal.throwIfAborted();
      await rename(temporary, join(directory, "model.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
