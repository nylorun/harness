/**
 * Install `@nylorun/runtime` the way a developer does, into a private prefix,
 * and return a PATH that finds its `nylorun-runtime` launcher. Never touches
 * the real global npm prefix or ~/.nylorun.
 *
 * - `source` a folder (default: the workspace `runtime/`) or a registry spec:
 *   `npm install --global --prefix <prefix> <source>`. A folder is linked,
 *   so rebuilds are picked up.
 * - `source` an array of tarballs (the Runtime plus its unpublished @nylorun
 *   dependencies): a local install, the project-devDependency layout, so npm
 *   resolves the packed versions together instead of fetching them from the
 *   registry.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { npm, root } from "./repo.mjs";

export async function installRuntime(
  prefix,
  source = join(root, "runtime"),
  { env = process.env } = {},
) {
  await mkdir(prefix, { recursive: true });
  let bin;
  if (!Array.isArray(source)) {
    await npm(
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        source,
      ],
      { capture: true, env },
    );
    bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  } else {
    await writeFile(
      join(prefix, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
    );
    await npm(
      ["install", "--no-audit", "--no-fund", "--no-package-lock", ...source],
      { cwd: prefix, capture: true, env },
    );
    bin = join(prefix, "node_modules", ".bin");
  }
  return {
    bin,
    /** `env` with this install's launcher first on PATH. */
    env: (env = process.env) => ({
      ...env,
      PATH: `${bin}${delimiter}${env.PATH ?? env.Path ?? ""}`,
    }),
  };
}
