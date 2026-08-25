import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentFolderDefinition } from "./definition.js";

export { mergeAgentFolderDefinition } from "./definition.js";

/**
 * Build-tool-neutral view of the files that make up a Nylo agent. A bundler is
 * still responsible for loading TypeScript modules; this layer owns directory
 * conventions and deterministic source discovery only.
 */
export type AgentFolder = Readonly<AgentFolderDefinition & {
  root: string;
  definitionPath: string;
  instructions?: string;
  packageName?: string;
  tools: readonly Readonly<{ file: string; path: string }>[];
}>;

export async function discoverAgentFolder(projectRoot: string): Promise<AgentFolder> {
  const root = resolve(projectRoot);
  const toolsRoot = join(root, "agent", "tools");
  let tools: readonly Readonly<{ file: string; path: string }>[] = [];
  try {
    tools = Object.freeze((await readdir(toolsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => Object.freeze({ file: entry.name, path: join(toolsRoot, entry.name) }))
      .sort((left, right) => left.file.localeCompare(right.file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let instructions: string | undefined;
  try {
    instructions = await readFile(join(root, "agent", "AGENT.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let packageName: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown };
    if (typeof parsed.name === "string") packageName = parsed.name.replace(/^@[^/]+\//, "");
  } catch {
    // The caller produces the contextual diagnostic when a name is required.
  }

  return Object.freeze({
    root,
    definitionPath: join(root, "agent", "agent.ts"),
    ...(instructions === undefined ? {} : { instructions }),
    ...(packageName === undefined ? {} : { packageName }),
    tools
  });
}
