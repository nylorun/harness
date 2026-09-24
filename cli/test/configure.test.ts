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

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (_options: { credentials: CredentialStore }) => {
    state.store = _options.credentials;
    return {
      getProviders: () => [
        {
          id: "fixture",
          name: "Fixture",
          auth: { oauth: {}, ...(state.apiKey ? { apiKey: {} } : {}) },
        },
      ],
      getProvider: (id: string) =>
        id === "fixture"
          ? {
              id: "fixture",
              name: "Fixture",
              auth: { oauth: {}, ...(state.apiKey ? { apiKey: {} } : {}) },
            }
          : undefined,
      getModels: () => [{ id: "fixture-model", name: "Fixture model" }],
      checkAuth: async () => false,
      login,
      setProvider() {},
    };
  },
}));

const catalog = {
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      models: [{ id: "fixture-model", name: "Fixture model" }],
      auth: { oauth: {} },
    },
  ],
};

const roots: string[] = [];
afterEach(async () => {
  login.mockReset();
  state.apiKey = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
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
  return { root, input, output, text: () => text, catalog };
}

it("F2-4: saves selection from Tenant model catalog and cleans up listeners", async () => {
  const test = await fixture();
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => ({
      type: "api_key",
      key: "fixture-key",
    })),
  );
  const controller = new AbortController();
  await expect(
    configureProvider({
      ...test,
      signal: controller.signal,
      catalog: test.catalog,
    }),
  ).resolves.toMatchObject({
    provider: "fixture",
    model: "fixture-model",
    auth: { type: "api_key", key: "fixture-key" },
  });
  expect(test.text()).toContain("Provider configuration saved.");
  expect(test.text()).toContain("0. Custom OpenAI-compatible provider");
  expect(test.text()).toContain("1. Fixture (fixture)");
  expect(test.input.listenerCount("data")).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("defaults to API keys without writing secrets to dotenv", async () => {
  state.apiKey = true;
  const test = await fixture(["1", "1", ""]);
  const apiCatalog = {
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        models: [{ id: "fixture-model", name: "Fixture model" }],
        auth: { apiKey: {}, oauth: {} },
      },
    ],
  };
  await writeFile(join(test.root, ".env"), "# integration\nINTEGRATION=keep\n");
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => ({
      type: "api_key",
      key: "key-with-#-and-'",
      env: { PROVIDER_ACCOUNT: "account" },
    })),
  );
  await expect(
    configureProvider({ ...test, catalog: apiCatalog }),
  ).resolves.toMatchObject({
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
});

it("keeps OAuth credentials out of dotenv", async () => {
  state.apiKey = true;
  const test = await fixture(["1", "1", "2"]);
  const apiCatalog = {
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        models: [{ id: "fixture-model", name: "Fixture model" }],
        auth: { apiKey: {}, oauth: {} },
      },
    ],
  };
  const credential = {
    type: "oauth" as const,
    access: "oauth-access",
    refresh: "oauth-refresh",
    expires: 9999999999999,
  };
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => credential),
  );
  await expect(
    configureProvider({ ...test, catalog: apiCatalog }),
  ).resolves.toMatchObject({
    provider: "fixture",
    model: "fixture-model",
    auth: credential,
  });
  expect(login).toHaveBeenCalledWith("fixture", "oauth", expect.anything());
  await expect(readFile(join(test.root, ".env"))).rejects.toThrow();
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "aborts a pending prompt on %s",
  async (name) => {
    const test = await fixture([]);
    const controller = new AbortController();
    const result = configureProvider({
      ...test,
      signal: controller.signal,
      catalog: test.catalog,
    });
    const rejected = expect(result).rejects.toMatchObject({
      exitCode: name === "SIGINT" ? 130 : 143,
    });
    controller.abort(new ConfigurationCancelled(name));
    await rejected;
    expect(login).not.toHaveBeenCalled();
    expect(test.input.listenerCount("data")).toBe(0);
  },
);

it("fails rather than hanging when stdin ends during a question", async () => {
  const test = await fixture([]);
  const result = configureProvider({ ...test, catalog: test.catalog });
  const rejected = expect(result).rejects.toThrow("input closed");
  test.input.end();
  await rejected;
  expect(login).not.toHaveBeenCalled();
});

it("rejects a pre-cancelled configuration without prompting", async () => {
  const test = await fixture();
  await expect(
    configureProvider({
      ...test,
      catalog: test.catalog,
      signal: AbortSignal.abort(new ConfigurationCancelled("SIGTERM")),
    }),
  ).rejects.toMatchObject({ exitCode: 143 });
  expect(test.text()).toBe("");
  expect(login).not.toHaveBeenCalled();
});

it("preserves unrelated config files", async () => {
  const test = await fixture();
  await mkdir(join(test.root, "config"));
  await writeFile(
    join(test.root, "config/model.json"),
    '{"provider":"old","model":"old"}',
  );
  login.mockImplementation(async () =>
    state.store!.modify("fixture", async () => ({
      type: "api_key",
      key: "next-key",
    })),
  );
  await expect(
    configureProvider({ ...test, catalog: test.catalog }),
  ).resolves.toMatchObject({
    model: "fixture-model",
    auth: { key: "next-key" },
  });
  expect(await readFile(join(test.root, "config/model.json"), "utf8")).toBe(
    '{"provider":"old","model":"old"}',
  );
});
