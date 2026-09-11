import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "nylorun-hono-stack-"));
try {
  const { starterFiles } = await import(
    pathToFileURL(join(root, "create-agent/dist/scaffold.js")).href
  );
  const compatibility = (await import("node:fs/promises")).readFile;
  const versions = JSON.parse(
    await compatibility(join(root, "create-agent/compatibility.json"), "utf8")
  );
  const files = await starterFiles(versions, true);
  for (const [path, content] of Object.entries(files)) {
    const target = join(temporary, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  assert.ok(
    files["src/index.ts"]?.includes("serveAgents({ agents, runtime })")
  );
  assert.ok(files["src/index.ts"]?.includes("@hono/node-server"));
  assert.equal(files["nylorun.config.ts"], undefined);
  const manifest = JSON.parse(files["package.json"]);
  assert.equal(manifest.scripts.dev, "node scripts/dev.mjs");
  assert.equal(manifest.scripts["dev:app"], "tsx watch src/index.ts");
  assert.ok(files["scripts/dev.mjs"]?.includes("waitForReady"));
  assert.equal(manifest.scripts.start, "node dist/src/index.js");
  assert.ok(manifest.dependencies.hono);
  assert.ok(manifest.dependencies["@hono/node-server"]);
  console.log("Hono-first starter stack contract passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
