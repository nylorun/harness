import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { modelSelection } from "../src/model/settings.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it("reads legacy selection only when the new file is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-settings-"));
  roots.push(root);
  await mkdir(join(root, "config"));
  await mkdir(join(root, ".env"));
  const legacy = { provider: "old", model: "old" };
  const current = { provider: "new", model: "new" };
  await writeFile(join(root, "config/model.json"), JSON.stringify(legacy));
  expect(modelSelection(root)).toEqual(legacy);
  await writeFile(join(root, ".env/model.json"), JSON.stringify(current));
  expect(modelSelection(root)).toEqual(current);
  for (const invalid of ["{", "null", "{}", '{"provider":"","model":"x"}']) {
    await writeFile(join(root, ".env/model.json"), invalid);
    expect(() => modelSelection(root)).toThrow("Run nylorun configure");
  }
});
