import { readFile, readdir } from "node:fs/promises";
import { basename, extname, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { diagnostic } from "./diagnostics.js";
import type { FolderEntry, FolderReader, ValidateOptions, ValidationResult } from "./types.js";

const RESERVED_ROOT = new Set(["evals"]);
const RESERVED_AGENT = new Set(["memory", "subagents"]);
const ALLOWED_AGENT = new Set(["agent.ts", "AGENT.md", "tools", "skills", "mcp"]);
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"]);

function safeRelative(path: string): string {
  const value = normalize(path).replaceAll("\\", "/");
  if (value === ".." || value.startsWith("../") || value.startsWith("/")) throw new Error("FolderReader paths must remain inside the project root");
  return value === "." ? "" : value;
}

export function createFilesystemReader(projectRoot: string): FolderReader {
  const root = resolve(projectRoot);
  const pathFor = (path: string) => {
    const target = resolve(root, safeRelative(path));
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Path escapes the project root");
    return target;
  };
  return {
    async read(path) {
      try {
        return await readFile(pathFor(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async list(path) {
      try {
        const entries = await readdir(pathFor(path), { withFileTypes: true });
        return entries.map((entry): FolderEntry => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : "file"
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }
  };
}

function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const parsed = parseYaml(text.slice(4, end));
  return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
}

export async function validateAgent(source: string | FolderReader, options: ValidateOptions = {}): Promise<ValidationResult> {
  const reader = typeof source === "string" ? createFilesystemReader(source) : source;
  const diagnostics = [];
  const rootEntries = await reader.list("");
  const rootNames = new Set(rootEntries.map((entry) => entry.name));

  for (const name of RESERVED_ROOT) {
    if (rootNames.has(name)) diagnostics.push(diagnostic("NYLO_CHECK_COMPONENT_RESERVED", "check", "error", name, `${name}/ is recognized but is not supported in this release.`, `Remove ${name}/ until its capability ships.`));
  }
  if (!rootNames.has("package.json")) diagnostics.push(diagnostic("NYLO_CHECK_PACKAGE_MISSING", "check", "error", "package.json", "package.json is required.", "Add an ordinary TypeScript package.json at the project root."));
  if (!rootNames.has("vite.config.ts")) diagnostics.push(diagnostic("NYLO_CHECK_VITE_CONFIG_MISSING", "check", "error", "vite.config.ts", "vite.config.ts is required.", "Add a Vite config containing nyloAgent()."));
  if (![...LOCKFILES].some((name) => rootNames.has(name))) diagnostics.push(diagnostic("NYLO_CHECK_LOCKFILE_ABSENT", "check", "warning", ".", "No supported text lockfile was found.", "Run the project package manager and commit its lockfile."));

  const agentEntries = await reader.list("agent");
  if (agentEntries.length === 0) {
    diagnostics.push(diagnostic("NYLO_CHECK_AGENT_DIRECTORY_MISSING", "check", "error", "agent", "agent/ is required.", "Create agent/agent.ts."));
  } else {
    const names = new Set(agentEntries.map((entry) => entry.name));
    if (!names.has("agent.ts")) diagnostics.push(diagnostic("NYLO_CHECK_DEFINITION_MISSING", "check", "error", "agent/agent.ts", "agent/agent.ts is required.", "Default-export Agent({...}) from agent/agent.ts."));
    for (const entry of agentEntries) {
      if (RESERVED_AGENT.has(entry.name)) {
        diagnostics.push(diagnostic("NYLO_CHECK_COMPONENT_RESERVED", "check", "error", `agent/${entry.name}`, `${entry.name}/ is recognized but is not supported in this release.`, `Remove agent/${entry.name}/ until its capability ships.`));
      } else if (!ALLOWED_AGENT.has(entry.name) && !entry.name.startsWith(".")) {
        diagnostics.push(diagnostic("NYLO_CHECK_COMPONENT_UNKNOWN", "check", "error", `agent/${entry.name}`, `${entry.name} is not a recognized agent component.`, "Move project-only files to the project root or remove the unknown component."));
      }
    }
  }

  for (const entry of await reader.list("agent/skills")) {
    if (entry.kind !== "directory") {
      diagnostics.push(diagnostic("NYLO_CHECK_SKILL_ENTRY_INVALID", "check", "error", `agent/skills/${entry.name}`, "Every entry under agent/skills must be a directory.", "Place each skill in agent/skills/<name>/SKILL.md."));
      continue;
    }
    const path = `agent/skills/${entry.name}/SKILL.md`;
    const contents = await reader.read(path);
    if (!contents) {
      diagnostics.push(diagnostic("NYLO_CHECK_SKILL_FILE_MISSING", "check", "error", path, "SKILL.md is required for every skill.", "Add a SKILL.md with name and description frontmatter."));
      continue;
    }
    const metadata = parseFrontmatter(new TextDecoder().decode(contents));
    if (!metadata || metadata.name !== entry.name || typeof metadata.description !== "string" || metadata.description.length === 0 || metadata.description.length > 1024) {
      diagnostics.push(diagnostic("NYLO_CHECK_SKILL_FRONTMATTER_INVALID", "check", "error", path, "Skill frontmatter must contain the directory name and a 1–1024 character description.", `Set name: ${entry.name} and add a concise description.`));
    }
  }

  for (const entry of await reader.list("agent/tools")) {
    const path = `agent/tools/${entry.name}`;
    if (entry.kind !== "file" || extname(entry.name) !== ".ts" || entry.name === "index.ts") {
      diagnostics.push(diagnostic("NYLO_CHECK_TOOL_PATH_INVALID", "check", "error", path, "Every tool must be one TypeScript file named for the tool.", "Use agent/tools/<portable-name>.ts; nested folders, index files, and TSX are unsupported."));
      continue;
    }
    const name = entry.name.slice(0, -3);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
      diagnostics.push(diagnostic("NYLO_CHECK_TOOL_NAME_INVALID", "check", "error", path, "The tool filename is not a portable slug.", "Rename it using lowercase letters, numbers, and internal hyphens."));
      continue;
    }
    const contents = await reader.read(path);
    const text = contents ? new TextDecoder().decode(contents) : "";
    if (!/export\s+default\s+defineTool\s*\(/.test(text)) {
      diagnostics.push(diagnostic("NYLO_CHECK_TOOL_DECLARATION_MALFORMED", "check", "error", path, "The tool does not visibly default-export defineTool(...).", "Default-export one defineTool(...) declaration; the build will perform the semantic check."));
    }
  }

  if (options.strict) {
    for (let index = 0; index < diagnostics.length; index += 1) {
      if (diagnostics[index].severity === "warning") diagnostics[index] = Object.freeze({ ...diagnostics[index], severity: "error" });
    }
  }
  return Object.freeze({ ok: diagnostics.every((item) => item.severity !== "error"), diagnostics: Object.freeze(diagnostics) });
}

export function projectRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || basename(path);
}
