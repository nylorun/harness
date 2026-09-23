import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillRecord } from "@nylorun/core/define";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillDiagnostic {
  readonly severity: "info" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class SkillsError extends Error {
  readonly code: string;
  readonly diagnostics: readonly SkillDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly SkillDiagnostic[] = []
  ) {
    super(message);
    this.name = "SkillsError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** Resolve a skills catalog directory; throws when missing or not a directory. */
export function resolveSkillsRoot(directory: string): string {
  const resolved = resolve(directory);
  if (!existsSync(resolved))
    throw new SkillsError(
      "skills.missing",
      `Skills directory does not exist: ${directory}`
    );
  const real = realpathSync(resolved);
  if (!statSync(real).isDirectory())
    throw new SkillsError(
      "skills.missing",
      `Skills path is not a directory: ${directory}`
    );
  return real;
}

/**
 * Load Agent Skills (agentskills.io) from a catalog directory.
 * Each immediate subdirectory with a valid SKILL.md becomes one skill.
 */
export function loadSkillsFromDirectory(
  directory: string,
  diagnostics: SkillDiagnostic[],
  options: { readonly boundary?: string; readonly codePrefix?: string } = {}
): Readonly<Record<string, SkillRecord>> {
  const root = resolveSkillsRoot(directory);
  const boundary = options.boundary ?? root;
  const prefix = options.codePrefix ?? "skills";
  const skills: Record<string, SkillRecord> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const skillDir = join(root, entry.name);
    const directoryReal = realInside(boundary, skillDir);
    if (!directoryReal) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because its directory escapes the package`,
        path: skillDir,
      });
      continue;
    }
    const skillFile = join(directoryReal, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const skillReal = realInside(boundary, skillFile);
    if (!skillReal || !statSync(skillReal).isFile()) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because SKILL.md escapes the package`,
        path: skillFile,
      });
      continue;
    }
    const parsed = parseSkill(readFileSync(skillReal, "utf8"), entry.name);
    if (!parsed) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because SKILL.md is not a valid Agent Skill`,
        path: skillFile,
      });
      continue;
    }
    if (skills[parsed.name]) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped duplicate skill '${parsed.name}'`,
        path: skillFile,
      });
      continue;
    }
    const resources = readResources(boundary, directoryReal, diagnostics, prefix);
    skills[parsed.name] = {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      ...(Object.keys(resources).length === 0 ? {} : { resources }),
    };
  }
  return skills;
}

export function parseSkill(
  text: string,
  directoryName: string
): { name: string; description: string; instructions: string } | undefined {
  const match = /^-{3}\r?\n([\s\S]*?)\r?\n-{3}(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const raw of (match[1] ?? "").split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const line = /^([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (!line || line[1] === "metadata") continue;
    fields[line[1]!] = unquote(line[2] ?? "");
  }
  const name = fields.name?.trim() ?? "";
  const description = fields.description?.trim() ?? "";
  if (!name || !description || description.length > 1024) return undefined;
  if (name.length > 64 || !SKILL_NAME.test(name) || name !== directoryName)
    return undefined;
  return {
    name,
    description,
    instructions: text.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}

function readResources(
  boundary: string,
  directory: string,
  diagnostics: SkillDiagnostic[],
  prefix: string
): Record<string, string> {
  const resources: Record<string, string> = {};
  const walk = (current: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const real = realInside(boundary, full);
        if (!real) continue;
        walk(real, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (depth === 0 && entry.name === "SKILL.md") continue;
      const real = realInside(boundary, full);
      if (!real || !statSync(real).isFile()) {
        diagnostics.push({
          severity: "warning",
          code: `${prefix}.resource-denied`,
          message: `Denied resource outside the package: ${entry.name}`,
          path: full,
        });
        continue;
      }
      const bytes = readFileSync(real);
      if (bytes.includes(0)) continue;
      const rel = relative(directory, real).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      resources[rel] = bytes.toString("utf8");
    }
  };
  walk(directory, 0);
  return resources;
}

function realInside(root: string, candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined;
  try {
    const real = realpathSync(candidate);
    return isInside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}
