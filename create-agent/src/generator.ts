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
  agentsSpec?: string;
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

function packageJson(name: string, agentsSpec: string): string {
  return `${JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      check: "tsc --noEmit",
      build: "node --input-type=module -e \"import('@nylorun/agents').then(async ({buildAgent})=>{const result=await buildAgent('.');if(!result.ok){for(const d of result.diagnostics)console.error(d.code+': '+d.message);process.exit(1)}})\""
    },
    dependencies: { "@nylorun/agents": agentsSpec },
    devDependencies: { typescript: "^5.9.3", vite: "^8.0.0" },
    engines: { node: ">=22.14 <23" }
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

export async function generateAgentProject(options: GeneratorOptions): Promise<GeneratorResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const target = resolve(cwd, options.directory);
  if (await exists(target) && (await readdir(target)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  const name = options.name ?? basename(target);
  if (!NAME.test(name)) throw new Error(`Invalid agent name: ${name}`);
  if (!MODEL.test(options.model)) throw new Error(`Invalid model identity: ${options.model}`);
  const selected = await detectPackageManager(cwd, options.userAgent ?? process.env.npm_config_user_agent);
  const agentsSpec = options.agentsSpec ?? process.env.NYLO_AGENTS_SPEC ?? "^0.1.0-rc.0";
  await mkdir(join(target, "agent"), { recursive: true });
  await writeFile(join(target, "package.json"), packageJson(name, agentsSpec));
  await writeFile(join(target, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["agent/**/*.ts", "vite.config.ts"] }, null, 2)}\n`);
  await writeFile(join(target, "vite.config.ts"), `import { nyloAgent } from "@nylorun/agents";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [nyloAgent()] });\n`);
  await writeFile(join(target, ".gitignore"), "node_modules/\ndist/\n.env\n");
  await writeFile(join(target, "README.md"), `# ${name}\n\nGenerated with @nylorun/create-agent.\n\n\`\`\`sh\n${runPrefix(selected.packageManager)} check\n${runPrefix(selected.packageManager)} build\n\`\`\`\n`);
  await writeFile(join(target, "agent", "agent.ts"), `import { Agent } from "@nylorun/agents";\n\nexport default Agent({\n  name: ${JSON.stringify(name)},\n  model: ${JSON.stringify(options.model)}\n});\n`);
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
