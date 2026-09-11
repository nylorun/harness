import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Compatibility,
  CreateOptions,
  CreatorDependencies,
} from "./contracts.js";
import { starterFiles } from "./scaffold.js";
import { CreationCancelled } from "./process.js";

export class CreationError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export async function createProject(
  options: CreateOptions,
  compatibility: Compatibility,
  dependencies: CreatorDependencies
): Promise<void> {
  const currentDirectory = resolve(dependencies.currentDirectory());
  const destination = resolve(currentDirectory, options.directory);
  const pathFromCurrentDirectory = relative(currentDirectory, destination);
  if (
    isAbsolute(options.directory) ||
    pathFromCurrentDirectory === "" ||
    pathFromCurrentDirectory === ".." ||
    pathFromCurrentDirectory.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`
    )
  )
    throw new Error(
      "Target directory must be a new child of the current directory."
    );
  if (await dependencies.exists(destination))
    throw new Error(`Target directory already exists: ${destination}`);
  if (!options.skipConfig && !dependencies.isInteractive())
    throw new Error(
      "Provider configuration requires interactive stdin and stdout. " +
        `To configure later, run: npm create @nylorun/agent@beta ${quote(
          options.directory
        )} -- --skip-config`
    );
  dependencies.signal?.throwIfAborted();
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}-${randomUUID()}`
  );
  await dependencies.makeDirectory(temporary);
  try {
    const files = {
      ...(await starterFiles(compatibility, options.studio)),
    };
    const name = packageName(basename(destination));
    const manifest = JSON.parse(files["package.json"]!);
    manifest.name = name;
    files["package.json"] = JSON.stringify(manifest, null, 2) + "\n";
    files["README.md"] = files["README.md"]!.replace(/^# .+\n/u, `# ${name}\n`);
    for (const [relative, content] of Object.entries(files)) {
      const file = join(temporary, relative);
      await dependencies.makeDirectory(dirname(file));
      await dependencies.write(file, content);
      dependencies.signal?.throwIfAborted();
    }
    await dependencies.rename(temporary, destination);
  } catch (error) {
    await dependencies.remove(temporary);
    throw error;
  }
  dependencies.log("Installing dependencies...");
  await stage("Installation", ["install", ...(options.yes ? ["--yes"] : [])]);
  if (options.skipConfig) {
    dependencies.log(
      `Provider configuration skipped. Configure later in another terminal:\ncd ${quote(
        destination
      )}\nnpm run configure`
    );
  } else {
    dependencies.log("Configuring your provider and model...");
    await stage("Provider configuration", ["run", "configure"]);
  }
  dependencies.log("Starting development...");
  await stage("Development", [
    "run",
    "dev",
    ...(options.open ? [] : ["--", "--no-open"]),
  ]);

  async function stage(name: string, args: readonly string[]): Promise<void> {
    try {
      dependencies.signal?.throwIfAborted();
      const result = await dependencies.run("npm", args, destination);
      dependencies.signal?.throwIfAborted();
      if (result.signal === "SIGINT" || result.status === 130)
        throw new CreationCancelled("SIGINT");
      if (result.signal === "SIGTERM" || result.status === 143)
        throw new CreationCancelled("SIGTERM");
      if (result.status !== 0 || result.signal)
        throw new Error(`${name} failed.`);
    } catch (error) {
      const cancelled = error instanceof CreationCancelled;
      const configured = name === "Development" && !options.skipConfig;
      const recovery = [
        `cd ${quote(destination)}`,
        ...(name === "Installation" ? ["npm install"] : []),
        ...(configured ? [] : ["npm run configure"]),
        "npm run dev",
      ].join("\n");
      throw new CreationError(
        `${
          cancelled ? error.message : `${name} failed.`
        } The generated project was kept.\n${
          name === "Development" ? "Restart" : "Resume"
        } with:\n${recovery}`,
        cancelled ? error.exitCode : 1
      );
    }
  }
}

function packageName(directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .replace(/-+/gu, "-");
  return name || "my-nylorun-agent";
}

function quote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value;
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
