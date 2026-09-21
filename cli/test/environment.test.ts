import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { loadProjectEnvironment, saveEnvironment } from "../src/environment.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-env-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("loads only .env, keeps process overrides, and permits missing files", async () => {
  const root = await fixture();
  loadProjectEnvironment(root);
  vi.stubEnv("MODEL", "host-model");
  vi.stubEnv("MODEL_PROVIDER", undefined);
  vi.stubEnv("MODEL_PROVIDER_API_KEY", undefined);
  await writeFile(
    join(root, ".env"),
    "MODEL=local-model\nMODEL_PROVIDER=custom\n"
  );
  await writeFile(
    join(root, ".env.local"),
    "MODEL_PROVIDER_API_KEY=not-loaded\n"
  );
  loadProjectEnvironment(root);
  expect(process.env.MODEL).toBe("host-model");
  expect(process.env.MODEL_PROVIDER).toBe("custom");
  expect(process.env.MODEL_PROVIDER_API_KEY).toBeUndefined();
});

it("rejects a legacy directory without modifying it", async () => {
  const root = await fixture();
  await mkdir(join(root, ".env"));
  await writeFile(join(root, ".env", "auth.json"), "private");
  expect(() => loadProjectEnvironment(root)).toThrow("migrated manually");
  expect(await readFile(join(root, ".env", "auth.json"), "utf8")).toBe(
    "private"
  );
});

it("preserves unrelated dotenv content and replaces complete multiline assignments", async () => {
  const root = await fixture();
  const unrelated =
    '# Integration settings\nexport INTEGRATION="hello # world" # keep\n\n';
  await writeFile(
    join(root, ".env"),
    unrelated +
      'MODEL="old\nmodel" # selection\nMODEL=duplicate\nMODEL_PROVIDER_BASE_URL=old\n'
  );
  await saveEnvironment(root, {
    MODEL: "new",
    MODEL_PROVIDER: "openai",
    MODEL_PROVIDER_BASE_URL: undefined,
  });
  const text = await readFile(join(root, ".env"), "utf8");
  expect(text).toContain(unrelated);
  expect(text).toContain("# selection");
  expect(parseEnv(text)).toEqual({
    INTEGRATION: "hello # world",
    MODEL: "new",
    MODEL_PROVIDER: "openai",
  });
  expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
  expect(await readdir(root)).toEqual([".env"]);
});

it.each([
  " spaces # $value\\n ",
  "a'b",
  "a'b\"c",
  "multiline\nsecret",
  "back\\slash",
])("round-trips credentials without changing their bytes (%s)", async (key) => {
  const root = await fixture();
  await saveEnvironment(root, { MODEL_PROVIDER_API_KEY: key });
  expect(
    parseEnv(await readFile(join(root, ".env"), "utf8")).MODEL_PROVIDER_API_KEY
  ).toBe(key);
});

it("keeps existing settings on cancellation or unrepresentable input", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), "MODEL=original\n");
  await expect(
    saveEnvironment(root, { MODEL: "new" }, AbortSignal.abort())
  ).rejects.toThrow();
  await expect(
    saveEnvironment(root, { MODEL_PROVIDER_API_KEY: "all'\"`quotes" })
  ).rejects.toThrow("quote delimiters");
  expect(await readFile(join(root, ".env"), "utf8")).toBe("MODEL=original\n");
});
