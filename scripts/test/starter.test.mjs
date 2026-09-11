import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, readJson } from "../lib/repo.mjs";
import { renderPreview } from "../starter.mjs";

test("starter previews resolve local packages and never overwrite an earlier preview", async () => {
  const first = await renderPreview();
  let second;
  try {
    const manifest = await readJson(join(first, "package.json"));
    assert.equal(
      manifest.dependencies["@nylorun/runtime"],
      `file:${join(root, "runtime").replaceAll("\\", "/")}`,
    );
    assert.equal(
      manifest.devDependencies["@nylorun/studio"],
      `file:${join(root, "studio").replaceAll("\\", "/")}`,
    );
    await writeFile(
      join(first, "agents/assistant/agent.ts"),
      "authored preview",
    );
    await writeFile(join(first, ".env/auth.json"), '{"fixture":"local-only"}');
    second = await renderPreview({ studio: false });
    assert.notEqual(first, second);
    assert.equal(
      (await readJson(join(second, "package.json"))).devDependencies[
        "@nylorun/studio"
      ],
      undefined,
    );
    assert.equal(
      await readFile(join(first, "agents/assistant/agent.ts"), "utf8"),
      "authored preview",
    );
    assert.equal(
      await readFile(join(first, ".env/auth.json"), "utf8"),
      '{"fixture":"local-only"}',
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    if (second) await rm(second, { recursive: true, force: true });
  }
});
