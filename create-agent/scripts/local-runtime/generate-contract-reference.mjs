import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "src/contract-reference.ts"), "utf8");
const list = (label) => [...source.matchAll(new RegExp(`${label}[\\s\\S]*?\\[([\\s\\S]*?)\\]`, "g"))]
  .flatMap((match) => [...match[1].matchAll(/"([A-Z0-9_.-]+|[a-zA-Z]+)"/g)].map((item) => item[1]));
const options = list("options");
const diagnostics = list("diagnostics");
const index = { generation: "0.1", factory: "Run(harnessFactory, options)", options, diagnostics };
const markdown = `<!-- Generated from src/contract-reference.ts; do not edit. -->\n# Nylo authoring contract\n\nUse \`Run((model, directive) => Agent(model, directive), { model, … })\`.\n\n## Run options\n\n${options.map((option) => `- \`${option}\``).join("\n")}\n\n## Stable diagnostics\n\n${diagnostics.map((code) => `- \`${code}\``).join("\n")}\n`;
const targets = [
  [resolve(root, "CONTRACT-REFERENCE.md"), markdown],
  [resolve(root, "contract-index.json"), `${JSON.stringify(index, null, 2)}\n`]
];
const check = process.argv.includes("--check");
for (const [target, content] of targets) {
  try {
    const current = await readFile(target, "utf8");
    if (current === content) continue;
  } catch { /* generated below */ }
  if (check) throw new Error(`Generated contract reference is stale: ${target}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
