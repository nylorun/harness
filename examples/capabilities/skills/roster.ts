import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_NAMES = new Set([".git", "node_modules", "dist"]);
const SPEC_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export type SkillDiagnostic = Readonly<{
  kind: "skipped" | "warning";
  path: string;
  message: string;
}>;

export type SkillDefinition = Readonly<{
  name: string;
  description: string;
  instructions: string;
  files?: Readonly<Record<string, string>>;
}>;

export type Skill = Readonly<{
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Readonly<Record<string, string>>;
  allowedTools?: string;
  directory?: string;
  resources: readonly string[];
  files?: Readonly<Record<string, string>>;
}>;

export class SkillRoster {
  private constructor(
    private readonly skills: ReadonlyMap<string, Skill>,
    readonly diagnostics: readonly SkillDiagnostic[],
  ) {}

  static from(skills: readonly Skill[]): SkillRoster {
    const map = new Map<string, Skill>();
    const diagnostics: SkillDiagnostic[] = [];
    for (const skill of skills) {
      if (map.has(skill.name)) {
        diagnostics.push({
          kind: "warning",
          path: skill.directory ?? skill.name,
          message: `Skill '${skill.name}' already loaded; later definition ignored.`,
        });
        continue;
      }
      map.set(skill.name, skill);
    }
    return new SkillRoster(map, diagnostics);
  }

  static async fromDirectory(root: string): Promise<SkillRoster> {
    await stat(root);
    return SkillRoster.fromDirectories([root]);
  }

  static async fromDirectories(roots: readonly string[]): Promise<SkillRoster> {
    const map = new Map<string, Skill>();
    const diagnostics: SkillDiagnostic[] = [];
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        diagnostics.push({
          kind: "skipped",
          path: root,
          message: error instanceof Error ? error.message : "Directory could not be read.",
        });
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_NAMES.has(entry.name) || entry.name.startsWith("."))
          continue;
        const directory = join(root, entry.name);
        const location = join(directory, "SKILL.md");
        let text: string;
        try {
          text = await readFile(location, "utf8");
        } catch {
          continue;
        }
        const parsed = parseSkillMarkdown(text, { directoryName: entry.name, location });
        if (!parsed.ok) {
          diagnostics.push({ kind: "skipped", path: location, message: parsed.message });
          continue;
        }
        diagnostics.push(...parsed.warnings);
        if (map.has(parsed.skill.name)) {
          diagnostics.push({
            kind: "warning",
            path: location,
            message: `Skill '${parsed.skill.name}' already loaded; later definition ignored.`,
          });
          continue;
        }
        map.set(parsed.skill.name, {
          ...parsed.skill,
          directory,
          resources: await collectResources(directory),
        });
      }
    }
    return new SkillRoster(map, diagnostics);
  }

  list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async readResource(name: string, path: string): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) throw new SkillResourceError("unknown_skill", `Unknown skill '${name}'.`);
    const normalized = normalizeResourcePath(path);
    if (!normalized || !skill.resources.includes(normalized)) {
      throw new SkillResourceError(
        "unknown_resource",
        `Skill '${name}' has no resource '${path}'.`,
      );
    }
    if (skill.files && normalized in skill.files) return skill.files[normalized]!;
    if (!skill.directory) {
      throw new SkillResourceError(
        "unknown_resource",
        `Skill '${name}' has no resource '${path}'.`,
      );
    }
    const resolved = resolveUnder(skill.directory, normalized);
    if (!resolved) {
      throw new SkillResourceError("unknown_resource", `Skill '${name}' has no resource '${path}'.`);
    }
    try {
      return await readFile(resolved, "utf8");
    } catch {
      throw new SkillResourceError("missing_resource", `Could not read '${path}' for '${name}'.`);
    }
  }
}

export class SkillResourceError extends Error {
  readonly code: "unknown_skill" | "unknown_resource" | "missing_resource";

  constructor(code: SkillResourceError["code"], message: string) {
    super(message);
    this.name = "SkillResourceError";
    this.code = code;
  }
}

export function defineSkill(definition: SkillDefinition): Skill {
  const name = assertName(definition.name);
  const description = assertDescription(definition.description);
  const files = definition.files
    ? Object.fromEntries(
        Object.entries(definition.files).map(([path, content]) => [
          normalizeResourcePath(path) ?? path,
          content,
        ]),
      )
    : undefined;
  return {
    name,
    description,
    body: definition.instructions,
    resources: files ? Object.keys(files).sort() : [],
    ...(files ? { files } : {}),
  };
}

type ParsedSkill =
  | { readonly ok: true; readonly skill: Skill; readonly warnings: readonly SkillDiagnostic[] }
  | { readonly ok: false; readonly message: string };

function parseSkillMarkdown(
  text: string,
  context: { directoryName: string; location: string },
): ParsedSkill {
  const extracted = extractFrontmatter(text);
  if (!extracted) return { ok: false, message: "SKILL.md must start with YAML frontmatter." };
  const fields = parseFrontmatterFields(extracted.frontmatter);
  if (!fields) return { ok: false, message: "SKILL.md frontmatter could not be parsed." };
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) return { ok: false, message: "SKILL.md is missing a description." };
  if (description.length > 1024) {
    return { ok: false, message: "SKILL.md description exceeds 1024 characters." };
  }
  const warnings: SkillDiagnostic[] = [];
  const resolvedName = name || context.directoryName;
  if (!NAME_PATTERN.test(resolvedName) || resolvedName.length > 64) {
    return { ok: false, message: `Invalid skill name '${resolvedName}'.` };
  }
  if (name && name !== context.directoryName) {
    warnings.push({
      kind: "warning",
      path: context.location,
      message: `Skill name '${name}' does not match directory '${context.directoryName}'.`,
    });
  }
  const skill: Skill = {
    name: resolvedName,
    description,
    body: extracted.body,
    resources: [],
    ...(typeof fields.license === "string" ? { license: fields.license } : {}),
    ...(typeof fields.compatibility === "string" ? { compatibility: fields.compatibility } : {}),
    ...(typeof fields["allowed-tools"] === "string"
      ? { allowedTools: fields["allowed-tools"] }
      : {}),
    ...(isStringMap(fields.metadata) ? { metadata: fields.metadata } : {}),
  };
  return { ok: true, skill, warnings };
}

function extractFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const match = /^-{3}\r?\n([\s\S]*?)\r?\n-{3}(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length).replace(/^\r?\n/, "") };
}

function parseFrontmatterFields(source: string): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);
  let currentKey: string | undefined;
  let metadata: Record<string, string> | undefined;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indented = /^(?: {2}|\t)([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (indented && currentKey === "metadata") {
      metadata ??= {};
      metadata[indented[1]!] = unquote(repairScalar(indented[2] ?? ""));
      continue;
    }
    const line = /^([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (!line) return undefined;
    const key = line[1]!;
    const value = line[2] ?? "";
    currentKey = key;
    if (!SPEC_FIELDS.has(key)) continue;
    if (key === "metadata") {
      metadata = {};
      fields.metadata = metadata;
      continue;
    }
    fields[key] = unquote(repairScalar(value));
  }
  return fields;
}

function repairScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (
    !/^(["']).*\1$/.test(trimmed) &&
    trimmed.includes(":") &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
    return trimmed;
  }
  return trimmed;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function assertName(name: string): string {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      `Skill name '${name}' must be 1–64 characters of lowercase letters, numbers, and single hyphens.`,
    );
  }
  return name;
}

function assertDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed || trimmed.length > 1024) {
    throw new Error("Skill description must be 1–1024 non-empty characters.");
  }
  return trimmed;
}

async function collectResources(directory: string): Promise<string[]> {
  const resources: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (depth === 0 && entry.name === "SKILL.md") continue;
      resources.push(toPosix(relative(directory, full)));
    }
  }
  await walk(directory, 0);
  return resources.sort();
}

function normalizeResourcePath(path: string): string | undefined {
  const trimmed = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) return undefined;
  return trimmed;
}

function resolveUnder(root: string, relativePath: string): string | undefined {
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return undefined;
  return resolved;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
