import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  configureProvider,
  ConfigurationCancelled,
} from "../src/model/configure.js";

const { login, state } = vi.hoisted(() => ({
  login: vi.fn(),
  state: { store: undefined as CredentialStore | undefined, apiKey: false },
}));
vi.mock("@nylorun/runtime/configuration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nylorun/runtime/configuration")>()),
  modelsFor: (_selection: unknown, store: CredentialStore) => {
    state.store = store;
    return {
      getProviders: () => [
        {
          id: "fixture",
          name: "Fixture",
          auth: { oauth: {}, ...(state.apiKey ? { apiKey: {} } : {}) },
        },
      ],
      getModels: () => [{ id: "fixture-model", name: "Fixture model" }],
      checkAuth: async () => false,
      login,
    };
  },
}));
const roots: string[] = [];
afterEach(async () => {
  login.mockReset();
  state.apiKey = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(answers = ["1", "1"]) {
  const root = await mkdtemp(join(tmpdir(), "configure-test-"));
  roots.push(root);
  const input = new PassThrough();
  let text = "";
  let index = 0;
  const output = new Writable({
    write(chunk, _encoding, done) {
      const value = String(chunk);
      text += value;
      if (value.startsWith("Choose ") && index < answers.length) {
        const answer = answers[index++];
        queueMicrotask(() => input.write(answer + "\n"));
      }
      done();
    },
  });
  return { root, input, output, text: () => text };
}

it("saves selection after authentication and cleans up prompt and abort listeners", async () => {
  const test = await fixture();
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => ({
      type: "api_key",
      key: "fixture-key",
    }))
  );
  const controller = new AbortController();
  await expect(
    configureProvider({ ...test, signal: controller.signal })
  ).resolves.toMatchObject({
    provider: "fixture",
    model: "fixture-model",
    auth: { type: "api_key", key: "fixture-key" },
  });
  expect(test.text()).toContain("Provider configuration saved.");
  expect(test.text()).not.toContain("Return to Studio");
  expect(test.input.listenerCount("data")).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("defaults to API keys and saves entered provider settings without a vault", async () => {
  state.apiKey = true;
  const test = await fixture(["1", "1", ""]);
  await writeFile(join(test.root, ".env"), "# integration\nINTEGRATION=keep\n");
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => ({
      type: "api_key",
      key: "key-with-#-and-'",
      env: { PROVIDER_ACCOUNT: "account" },
    }))
  );
  await expect(configureProvider(test)).resolves.toMatchObject({
    provider: "fixture",
    model: "fixture-model",
    auth: {
      type: "api_key",
      key: "key-with-#-and-'",
      env: { PROVIDER_ACCOUNT: "account" },
    },
  });
  expect(login).toHaveBeenCalledWith("fixture", "api_key", expect.anything());
  const text = await readFile(join(test.root, ".env"), "utf8");
  expect(text).toContain("# integration\nINTEGRATION=keep\n");
  expect(text).not.toContain("key-with");
  await expect(
    readFile(join(test.root, ".nylorun/auth.json"))
  ).rejects.toThrow();
});

it("keeps explicitly selected OAuth credentials separate from dotenv", async () => {
  state.apiKey = true;
  const test = await fixture(["1", "1", "2"]);
  const credential = {
    type: "oauth" as const,
    access: "oauth-access",
    refresh: "oauth-refresh",
    expires: 9999999999999,
  };
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => credential)
  );
  await expect(configureProvider(test)).resolves.toMatchObject({
    provider: "fixture",
    model: "fixture-model",
    auth: credential,
  });
  expect(login).toHaveBeenCalledWith("fixture", "oauth", expect.anything());
  await expect(readFile(join(test.root, ".nylorun/auth.json"))).rejects.toThrow();
  await expect(readFile(join(test.root, ".env"))).rejects.toThrow();
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "aborts a pending prompt on %s",
  async (name) => {
    const test = await fixture([]);
    const controller = new AbortController();
    const result = configureProvider({ ...test, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({
      exitCode: name === "SIGINT" ? 130 : 143,
    });
    controller.abort(new ConfigurationCancelled(name));
    await rejected;
    expect(login).not.toHaveBeenCalled();
    expect(test.input.listenerCount("data")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it("fails rather than hanging when stdin ends during a question", async () => {
  const test = await fixture([]);
  const result = configureProvider(test);
  const rejected = expect(result).rejects.toThrow("input closed");
  test.input.end();
  await rejected;
  expect(login).not.toHaveBeenCalled();
});

it.each(["signal", "eof"])(
  "cancels authentication on %s without replacing existing configuration",
  async (mode) => {
    const test = await fixture();
    await mkdir(join(test.root, "config"));
    await mkdir(join(test.root, ".env"));
    const selection = '{"provider":"existing","model":"existing"}\n';
    const credentials =
      '{"existing":{"type":"api_key","key":"fixture-secret"}}\n';
    await writeFile(join(test.root, "config/model.json"), selection);
    await writeFile(join(test.root, ".env/auth.json"), credentials);
    const controller = new AbortController();
    let authSignal: AbortSignal | undefined;
    login.mockImplementation(async (_provider, _method, interaction) => {
      authSignal = interaction.signal;
      // Simulate authentication finishing just as cancellation arrives. The save
      // boundary must still reject the result rather than replace model selection.
      if (mode === "signal")
        controller.abort(new ConfigurationCancelled("SIGINT"));
      else {
        test.input.end();
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    await expect(
      configureProvider({ ...test, signal: controller.signal })
    ).rejects.toThrow();
    expect(authSignal?.aborted).toBe(true);
    expect(await readFile(join(test.root, "config/model.json"), "utf8")).toBe(
      selection
    );
    expect(await readFile(join(test.root, ".env/auth.json"), "utf8")).toBe(
      credentials
    );
    expect(test.input.listenerCount("data")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
);

it("rejects a pre-cancelled configuration without prompting", async () => {
  const test = await fixture();
  await expect(
    configureProvider({
      ...test,
      signal: AbortSignal.abort(new ConfigurationCancelled("SIGTERM")),
    })
  ).rejects.toMatchObject({ exitCode: 143 });
  expect(test.text()).toBe("");
  expect(login).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves legacy selection and unrelated config files (%s)",
  async (otherFile) => {
    const test = await fixture();
    await mkdir(join(test.root, "config"));
    await writeFile(
      join(test.root, "config/model.json"),
      '{"provider":"old","model":"old"}'
    );
    if (otherFile) await writeFile(join(test.root, "config/keep.json"), "{}");
    login.mockImplementation(async () =>
      state.store!.modify("fixture", async () => ({
        type: "api_key",
        key: "next-key",
      }))
    );
    await expect(configureProvider(test)).resolves.toMatchObject({
      model: "fixture-model",
      auth: { key: "next-key" },
    });
    expect(await readFile(join(test.root, "config/model.json"), "utf8")).toBe(
      '{"provider":"old","model":"old"}'
    );
    if (otherFile)
      expect(await readFile(join(test.root, "config/keep.json"), "utf8")).toBe(
        "{}"
      );
  }
);
