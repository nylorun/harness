import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const catalog = await readFile(join(root, "examples/agents/index.ts"), "utf8");
const index = await readFile(join(root, "examples/src/index.ts"), "utf8");
assert.ok(index.includes("new Runtime({ media })"));
assert.ok(index.includes("serveAgents({ agents, runtime })"));
assert.ok(catalog.includes("createRegistry"));
await access(join(root, "examples/dist/src/index.js"));
await access(join(root, "examples/dist/agents/skills/catalog/structured-summary/SKILL.md"));
console.log("Compiled Hono example assets passed.");
