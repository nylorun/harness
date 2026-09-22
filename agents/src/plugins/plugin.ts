import type { CapabilityDeclaration } from "@nylorun/core/define";
import {
  loadPlugin,
  type LoadedPlugin,
  type PluginDiagnostic,
} from "./load.js";

const SKILL_USAGE =
  "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.";

export interface PluginCapability extends CapabilityDeclaration {
  readonly diagnostics: readonly PluginDiagnostic[];
}

/** Read an Agent Plugin package and return one capability for `Agent.use`. */
export function plugin(directory: string): PluginCapability {
  const loaded = loadPlugin(directory);
  return capabilityFromPlugin(loaded);
}

export function capabilityFromPlugin(loaded: LoadedPlugin): PluginCapability {
  const names = Object.values(loaded.skills);
  const instructions =
    names.length === 0
      ? undefined
      : [SKILL_USAGE, formatCatalog(names.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })))];
  const skills = Object.fromEntries(
    names.map((skill) => [
      skill.name,
      { name: skill.name, description: skill.description },
    ])
  );
  return {
    id: loaded.name,
    type: "agent-plugin",
    pluginRoot: loaded.root,
    ...(loaded.description === undefined ? {} : { description: loaded.description }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(names.length === 0 ? {} : { skills, skillRecords: loaded.skills }),
    ...(Object.keys(loaded.mcpServers).length === 0
      ? {}
      : { mcpServers: loaded.mcpServers }),
    diagnostics: loaded.diagnostics,
  };
}

function formatCatalog(
  skills: readonly { name: string; description: string }[]
): string {
  const entries = skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`
    )
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
