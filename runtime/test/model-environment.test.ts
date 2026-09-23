import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { modelsFor } from "../src/model/models.js";
import { ProjectCredentialStore } from "../src/model/auth-store.js";
import { projectSecrets } from "../src/model/settings.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "model-env-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it.each(["explicit", "native", "stored"])(
  "resolves %s credentials in order",
  async (source) => {
    const root = await fixture();
    const store = new ProjectCredentialStore(
      join(root, ".nylorun", "auth.json")
    );
    await store.modify("openai", async () => ({
      type: "api_key",
      key: "stored-key",
    }));
    vi.stubEnv(
      "MODEL_PROVIDER_API_KEY",
      source === "explicit" ? "explicit-key" : ""
    );
    vi.stubEnv("OPENAI_API_KEY", source === "stored" ? "" : "native-key");
    const registry = modelsFor({ provider: "openai", model: "unused" }, store);
    expect((await registry.getAuth("openai"))?.auth.apiKey).toBe(
      `${source}-key`
    );
  }
);

it("environment credentials bypass even malformed credential files", async () => {
  const root = await fixture();
  await mkdir(join(root, ".nylorun"));
  await writeFile(join(root, ".nylorun", "auth.json"), "invalid-json");
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "explicit-key");
  const registry = modelsFor(
    { provider: "openai", model: "unused" },
    new ProjectCredentialStore(join(root, ".nylorun", "auth.json"))
  );
  expect((await registry.getAuth("openai"))?.auth.apiKey).toBe("explicit-key");
});

it("reads legacy OAuth state and includes new credentials in redaction", async () => {
  const root = await fixture();
  await mkdir(join(root, ".env"));
  const credential = {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: 9999999999999,
  };
  await writeFile(
    join(root, ".env", "auth.json"),
    JSON.stringify({ fixture: credential })
  );
  const store = new ProjectCredentialStore(
    join(root, ".nylorun", "auth.json"),
    join(root, ".env", "auth.json")
  );
  expect(await store.read("fixture")).toEqual(credential);
  await store.modify("fixture", async () => ({
    ...credential,
    type: "oauth",
    access: "new-secret",
  }));
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "explicit-secret");
  expect(projectSecrets(root)).toEqual(
    expect.arrayContaining([
      "explicit-secret",
      "new-secret",
      "refresh-secret",
      "access-secret",
    ])
  );
});
