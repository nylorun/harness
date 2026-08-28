import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type GeneratorOptions = Readonly<{
  directory: string;
  name?: string;
  model: string;
  cwd?: string;
  install?: boolean;
  userAgent?: string;
  /** Development only: pins the transitive harness while neither package is published. */
  harnessSpec?: string;
  /** Development only: pins the local-development helper package. */
  createAgentSpec?: string;
  /** Development only: selects the optional Studio package. */
  studioSpec?: string;
}>;

export type GeneratorResult = Readonly<{
  directory: string;
  name: string;
  packageManager: PackageManager;
  reason: string;
}>;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function detectPackageManager(context: string, userAgent: string | undefined): Promise<{ packageManager: PackageManager; reason: string }> {
  const candidates: readonly [string, PackageManager][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["package-lock.json", "npm"]];
  for (const [file, packageManager] of candidates) {
    if (await exists(join(context, file))) return { packageManager, reason: `found ${file}` };
  }
  try {
    const manifest = JSON.parse(await readFile(join(context, "package.json"), "utf8")) as { packageManager?: string };
    const declared = manifest.packageManager?.match(/^(npm|pnpm|yarn|bun)@/)?.[1] as PackageManager | undefined;
    if (declared) return { packageManager: declared, reason: `package.json declares ${manifest.packageManager}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const runner = userAgent?.match(/^(npm|pnpm|yarn|bun)\//)?.[1] as PackageManager | undefined;
  return runner ? { packageManager: runner, reason: `invoked by ${runner}` } : { packageManager: "npm", reason: "defaulted to npm" };
}

function packageJson(
  name: string,
  packageManager: PackageManager,
  harnessSpec: string | undefined,
  createAgentSpec: string,
  studioSpec: string
): string {
  return `${JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      check: "nylo check && tsc --noEmit",
      dev: "nylo dev --studio",
      build: "nylo build",
      serve: `${runPrefix(packageManager)} build && nylo serve`,
      studio: "nylo studio"
    },
    dependencies: {
      "@nylorun/harness": harnessSpec ?? "0.5.0-beta.1",
      "zod": "^4.1.12"
    },
    devDependencies: { "@nylorun/create-agent": createAgentSpec, "@nylorun/studio": studioSpec, typescript: "^5.9.3", vite: "^8.0.0" },
    // Before publication, a tarball pin keeps the scaffold, its helper, Studio, and Harness on
    // one tested release line. This disappears from ordinary registry-generated projects.
    ...([harnessSpec, createAgentSpec, studioSpec].some((spec) => spec?.startsWith("file:"))
      ? {
          overrides: {
            ...(harnessSpec?.startsWith("file:") ? { "@nylorun/harness": harnessSpec } : {}),
            ...(createAgentSpec.startsWith("file:") ? { "@nylorun/create-agent": createAgentSpec } : {}),
            ...(studioSpec.startsWith("file:") ? { "@nylorun/studio": studioSpec } : {})
          }
        }
      : {}),
    // The local helper supports the same active Node lines as this generator.
    engines: { node: "^22.14.0 || ^24.0.0 || >=26.0.0" }
  }, null, 2)}\n`;
}

function runPrefix(packageManager: PackageManager): string {
  return packageManager === "npm" ? "npm run" : `${packageManager} run`;
}

function installCommand(packageManager: PackageManager): { command: string; args: string[] } {
  switch (packageManager) {
    case "pnpm": return { command: "pnpm", args: ["install"] };
    case "yarn": return { command: "yarn", args: ["install"] };
    case "bun": return { command: "bun", args: ["install"] };
    default: return { command: "npm", args: ["install"] };
  }
}

async function runInstall(target: string, packageManager: PackageManager): Promise<void> {
  const { command, args } = installCommand(packageManager);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: target, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)));
  });
}

/**
 * OpenRouter leads because it is the path the hosted gateway takes, and because the identities most
 * builders start from — Anthropic's and Google's — are not directly routable: their APIs do not
 * speak `POST /chat/completions`. Leading with a direct key would fail the very first run.
 */
function envExample(model: string): string {
  if (model.startsWith("local/")) return [
    "# Pin local inference to Ollama (no API key is required).",
    "NYLO_MODEL_GATEWAY_URL=http://127.0.0.1:11434/v1",
    "NYLO_MODEL_GATEWAY_PROTOCOL=openai-chat-completions",
    "NYLO_MODEL_GATEWAY_ACCESS_MODE=private-or-local-endpoint",
    ""
  ].join("\n");
  return [
    "# Optional: any OpenAI-compatible model gateway.",
    "# NYLO_MODEL_GATEWAY_URL=http://127.0.0.1:1234/v1",
    "# NYLO_MODEL_GATEWAY_API_KEY=",
    "# NYLO_MODEL_GATEWAY_AUTH_HEADER=authorization",
    "# NYLO_MODEL_GATEWAY_AUTH_PREFIX=Bearer ",
    "# NYLO_MODEL_GATEWAY_HEADERS={}",
    ""
  ].join("\n");
}

function readme(name: string, model: string, packageManager: PackageManager): string {
  const run = runPrefix(packageManager);
  return `# ${name}

Generated with @nylorun/create-agent.

\`\`\`sh
${run} check
${run} dev
${run} build
${run} serve
${run} studio
\`\`\`

## Model gateway

Copy \`.env.example\` to \`.env\` only when your model gateway needs configuration. A local
OpenAI-compatible server is detected automatically; any compatible gateway can be configured with
\`NYLO_MODEL_GATEWAY_URL\` and, when needed, \`NYLO_MODEL_GATEWAY_API_KEY\`.

Start sessions through the REST API after \`npm run serve\`. Credentials are read from your
environment first, then \`.env\`; values are never printed or uploaded. Each session writes
\`.nylo/<session-id>/record.jsonl\` and \`.nylo/<session-id>/observe.jsonl\`.

\`\`\`sh
# Start a session, then follow its event stream.
curl -X POST http://127.0.0.1:4111/v1/sessions \\
  -H 'content-type: application/json' \\
  -d '{"agent_id":"${name}","message":"Hello"}'
curl -N http://127.0.0.1:4111/v1/sessions/<session-id>/stream
\`\`\`
`;
}

export async function generateAgentProject(options: GeneratorOptions): Promise<GeneratorResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const target = resolve(cwd, options.directory);
  if (await exists(target) && (await readdir(target)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  const name = options.name ?? basename(target);
  if (!NAME.test(name)) throw new Error(`Invalid agent name: ${name}`);
  if (!MODEL.test(options.model)) throw new Error(`Invalid model identity: ${options.model}`);
  const selected = await detectPackageManager(cwd, options.userAgent ?? process.env.npm_config_user_agent);
  const harnessSpec = options.harnessSpec ?? process.env.NYLO_HARNESS_SPEC;
  const createAgentSpec = options.createAgentSpec ?? process.env.NYLO_CREATE_AGENT_SPEC ?? "0.1.0-rc.1";
  const studioSpec = options.studioSpec ?? process.env.NYLO_STUDIO_SPEC ?? "0.1.0-rc.1";
  await mkdir(join(target, "agent"), { recursive: true });
  await writeFile(join(target, "package.json"), packageJson(name, selected.packageManager, harnessSpec, createAgentSpec, studioSpec));
  await writeFile(join(target, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["agent/**/*.ts", "nylo.local.ts", "vite.config.ts"] }, null, 2)}\n`);
  await writeFile(join(target, "nylo.local.ts"), `/** Local development contract generated by @nylorun/create-agent. */\nexport { Agent, AgentSpec, Run, tool, nyloAgent } from "@nylorun/create-agent/local";\nexport type { BuildResult, LocalRuntimeHost, RuntimeOptions } from "@nylorun/create-agent/local";\n`);
  await writeFile(join(target, "vite.config.ts"), `import { nyloAgent } from "./nylo.local.js";\n\nexport default { plugins: [nyloAgent()] };\n`);
  await writeFile(join(target, ".gitignore"), "node_modules/\ndist/\n.env\n.nylo/\n");
  await writeFile(join(target, ".env.example"), envExample(options.model));
  await writeFile(join(target, "README.md"), readme(name, options.model, selected.packageManager));
  await writeFile(join(target, "agent", "agent.ts"), `import { Agent } from "@nylorun/harness";\nimport { Run } from "../nylo.local.js";\n\nexport default Run(\n  (model, directive) => Agent(model, directive),\n  {\n    name: ${JSON.stringify(name)},\n    model: ${JSON.stringify(options.model)}\n  }\n);\n`);
  await writeFile(join(target, "agent", "AGENT.md"), "You are a helpful assistant.\n");
  if (options.install !== false) {
    try {
      await runInstall(target, selected.packageManager);
    } catch (error) {
      const recovery = installCommand(selected.packageManager);
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Project files were kept. Recover with: cd ${JSON.stringify(target)} && ${recovery.command} ${recovery.args.join(" ")}`);
    }
  }
  return Object.freeze({ directory: target, name, ...selected });
}
