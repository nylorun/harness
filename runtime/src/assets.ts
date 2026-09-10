import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
/** Resolve authored catalogs and subprocess assets in source or a built application. */
export function projectAsset(path: string): string {
  const root = process.cwd();
  const source = resolve(root, path);
  if (relative(root, source).startsWith(".."))
    throw new Error("Asset must be inside the project.");
  return existsSync(source) ? source : resolve(root, "dist", path);
}
