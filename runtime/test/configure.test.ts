import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  configureProvider,
  ConfigurationCancelled,
} from "../src/model/configure.js";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../src/model/models.js", () => ({
  modelsFor: () => ({
    getProviders: () => [
      { id: "fixture", name: "Fixture", auth: { oauth: {} } },
    ],
    getModels: () => [{ id: "fixture-model", name: "Fixture model" }],
    checkAuth: async () => false,
    login,
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  login.mockReset();
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
  return { root, input, output, text: () => text };
}

it("saves selection after authentication and cleans up prompt and abort listeners", async () => {
  const test = await fixture();
  login.mockResolvedValue(undefined);
  const controller = new AbortController();
  await configureProvider({ ...test, signal: controller.signal });
  expect(
    JSON.parse(await readFile(join(test.root, "config/model.json"), "utf8")),
  ).toEqual({
    provider: "fixture",
    model: "fixture-model",
  });
  expect(test.text()).toContain("Provider configuration saved.");
  expect(test.text()).not.toContain("Return to Studio");
  expect(test.input.listenerCount("data")).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
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
  },
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
      configureProvider({ ...test, signal: controller.signal }),
    ).rejects.toThrow();
    expect(authSignal?.aborted).toBe(true);
    expect(await readFile(join(test.root, "config/model.json"), "utf8")).toBe(
      selection,
    );
    expect(await readFile(join(test.root, ".env/auth.json"), "utf8")).toBe(
      credentials,
    );
    expect(test.input.listenerCount("data")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  },
);

it("rejects a pre-cancelled configuration without prompting", async () => {
  const test = await fixture();
  await expect(
    configureProvider({
      ...test,
      signal: AbortSignal.abort(new ConfigurationCancelled("SIGTERM")),
    }),
  ).rejects.toMatchObject({ exitCode: 143 });
  expect(test.text()).toBe("");
  expect(login).not.toHaveBeenCalled();
});
