import { join } from "node:path";
import { tool, type CapabilityDeclaration } from "@nylorun/harness";
import { z } from "zod";
import {
  defineSkill,
  SkillResourceError,
  SkillRoster,
  type Skill,
  type SkillDefinition,
} from "./roster.js";

export { defineSkill };
export type { Skill, SkillDefinition };

export const SKILLS_USAGE =
  "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.";

export const SKILLS_CATALOG = join(process.cwd(), "capabilities/skills/catalog");

export type SkillsSource =
  | { readonly directory: string }
  | { readonly directories: readonly string[] }
  | { readonly skills: readonly Skill[] };

export async function skills(
  source: SkillsSource = { directory: SKILLS_CATALOG },
): Promise<CapabilityDeclaration> {
  const roster = await loadRoster(source);
  const listed = roster.list();
  if (listed.length === 0) return { id: "skills" };

  const tools = [
    loadSkillTool(roster, listed),
    ...(listed.some((skill) => skill.resources.length > 0)
      ? [readSkillResourceTool(roster, listed)]
      : []),
  ];

  return {
    id: "skills",
    instructions: [SKILLS_USAGE, formatSkillCatalog(listed)],
    tools,
  };
}

async function loadRoster(source: SkillsSource): Promise<SkillRoster> {
  if ("skills" in source) return SkillRoster.from(source.skills);
  if ("directories" in source) return SkillRoster.fromDirectories(source.directories);
  return SkillRoster.fromDirectory(source.directory);
}

function loadSkillTool(roster: SkillRoster, listed: readonly Skill[]) {
  return tool({
    name: "load_skill",
    description: "Load the full instructions for a named skill.",
    parameters: z.object({ name: skillNameSchema(listed) }),
    async execute({ name }) {
      const skill = roster.get(name);
      if (!skill) {
        return {
          kind: "completed" as const,
          output: { unknown: name, available: listed.map((item) => item.name) },
        };
      }
      return { kind: "completed" as const, output: renderSkillContent(skill) };
    },
  });
}

function readSkillResourceTool(roster: SkillRoster, listed: readonly Skill[]) {
  return tool({
    name: "read_skill_resource",
    description: "Read a supporting file from a skill directory after load_skill.",
    parameters: z.object({
      name: skillNameSchema(listed),
      path: z.string().min(1),
    }),
    async execute({ name, path }) {
      try {
        return {
          kind: "completed" as const,
          output: { name, path, content: await roster.readResource(name, path) },
        };
      } catch (error) {
        if (error instanceof SkillResourceError) {
          return { kind: "failed" as const, code: `skill.${error.code}`, message: error.message };
        }
        throw error;
      }
    },
  });
}

function skillNameSchema(listed: readonly Skill[]) {
  const names = listed.map((skill) => skill.name);
  return names.length === 1 ? z.literal(names[0]!) : z.enum(names as [string, ...string[]]);
}

export function formatSkillCatalog(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const entries = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`,
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function renderSkillContent(skill: Skill): { content: string } {
  const parts = [`<skill_content name="${escapeXml(skill.name)}">`, skill.body];
  if (skill.directory) {
    parts.push(
      "",
      `Skill directory: ${skill.directory}`,
      "Relative paths in this skill are relative to the skill directory.",
    );
  }
  if (skill.resources.length) {
    parts.push(
      "",
      "<skill_resources>",
      ...skill.resources.map((path) => `  <file>${escapeXml(path)}</file>`),
      "</skill_resources>",
    );
  }
  parts.push("</skill_content>");
  return { content: parts.join("\n") };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
