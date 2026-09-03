import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const canonicalLicense = readFileSync("../LICENSE", "utf8");
const forbidden = ["@nylorun/runtime", "@nylorun/agent"];
if (manifest.description !== "Nylorun's TypeScript agent runtime. See github.com/nylorun/harness.")
  throw new Error("Harness package description must direct users to the canonical repository.");
if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0)
  throw new Error("Harness package must declare npm keywords.");
if (manifest.author !== "Nylo") throw new Error("Harness package must identify its author.");
if (manifest.homepage !== "https://github.com/nylorun/harness")
  throw new Error("Harness package homepage must point to its canonical repository.");
if (manifest.bugs !== "https://github.com/nylorun/harness/issues")
  throw new Error("Harness package bugs field must point to the canonical issue tracker.");
if (
  manifest.repository?.url !== "git+https://github.com/nylorun/harness.git" ||
  manifest.repository?.directory !== "harness"
)
  throw new Error(
    "Harness package repository metadata must point to the canonical source directory.",
  );
if (readFileSync("LICENSE", "utf8") !== canonicalLicense)
  throw new Error("Harness package LICENSE must contain the complete canonical Apache-2.0 text.");
const production = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
for (const name of forbidden) {
  if (name in production) throw new Error(`Forbidden production dependency: ${name}`);
}
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
for (const file of sourceFiles("src").filter((path) => path.endsWith(".ts"))) {
  const source = readFileSync(file, "utf8");
  for (const name of forbidden) {
    if (source.includes(name))
      throw new Error(`Forbidden source import reference ${name} in ${file}`);
  }
  if (source.includes("message.startsWith("))
    throw new Error(`Message text must not classify a Harness outcome in ${file}`);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Error", "TypeError", "RangeError"].includes(node.expression.text)
    )
      throw new Error(`Unstructured ${node.expression.text} construction in ${file}`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

const cache = mkdtempSync(join(tmpdir(), "nylo-harness-pack-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
    shell: process.platform === "win32",
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  const allowed = (path) =>
    path === "package.json" ||
    path === "README.md" ||
    path === "CHANGELOG.md" ||
    path === "LICENSE" ||
    /^dist\/.+\.(?:js|d\.ts)$/.test(path);
  const unexpected = files.filter((path) => !allowed(path));
  if (unexpected.length) throw new Error(`Unexpected tarball files: ${unexpected.join(", ")}`);
  for (const required of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/model/adapters.js",
    "dist/model/adapters.d.ts",
  ]) {
    if (!files.includes(required)) throw new Error(`Missing tarball file: ${required}`);
  }
  const entry = await import(new URL("../dist/index.js", import.meta.url));
  const adapters = await import(new URL("../dist/model/adapters.js", import.meta.url));
  for (const name of [
    "AgentBuilder",
    "BoundAgentBuilder",
    "AgentBuildError",
    "AgentLifecycleError",
    "HarnessError",
    "isHarnessError",
    "Agent",
    "BuiltAgent",
    "tool",
    "model",
    "middleware",
  ]) {
    if (!(name in entry)) throw new Error(`Missing public export: ${name}`);
  }
  for (const name of [
    "toChatCompletions",
    "fromChatCompletions",
    "chatCompletionsAdapter",
    "toResponses",
    "fromResponses",
    "responsesAdapter",
    "toMessages",
    "fromMessages",
    "anthropicAdapter",
  ]) {
    if (!(name in adapters)) throw new Error(`Missing model adapter export: ${name}`);
  }
  console.log(`Tarball and dependency boundary passed (${files.length} files).`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
