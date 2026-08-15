import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { diagnostic, NyloBuildError } from "./diagnostics.js";
import { isToolDefinition } from "./tool.js";
import type { AgentConfig, CapabilityManifest, SkillDescriptor, ToolDescriptor } from "./types.js";

export const SDK_VERSION = "0.1.0-rc.1";

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "$schema").map(([key, item]) => [key, stripSchemaMetadata(item)]));
}

const ALLOWED_SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "description"]);

function assertSchemaSubset(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSchemaSubset(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key) && path !== "input.properties") {
      throw new NyloBuildError(diagnostic("NYLO_BUILD_TOOL_SCHEMA_UNSUPPORTED", "build", "error", path, `The derived tool schema uses unsupported keyword ${key}.`, "Use objects, strings, numbers, integers, booleans, and arrays without unions, enums, defaults, or formats."));
    }
    assertSchemaSubset(item, key === "properties" ? "input.properties" : `${path}.${key}`);
  }
}

export function describeTools(entries: readonly { file: string; exports: Record<string, unknown> }[]): ToolDescriptor[] {
  const tools = entries.map(({ file, exports }) => {
    const exported = Object.keys(exports);
    if (exported.length !== 1 || exported[0] !== "default" || !isToolDefinition(exports.default)) {
      throw new NyloBuildError(diagnostic("NYLO_BUILD_TOOL_EXPORT_INVALID", "build", "error", file, "A tool module must default-export exactly one defineTool(...) value.", "Remove other exports and default-export defineTool({...})."));
    }
    const definition = exports.default;
    const schema = stripSchemaMetadata(z.toJSONSchema(definition.input)) as Record<string, unknown>;
    assertSchemaSubset(schema);
    const name = file.replace(/\.tsx?$/, "");
    return Object.freeze({
      name,
      description: definition.description,
      inputSchema: Object.freeze(schema),
      sandbox: definition.sandbox ?? false,
      ...(definition.maxCallsPerSession ? { maxCallsPerSession: definition.maxCallsPerSession } : {})
    });
  });
  tools.sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new NyloBuildError(diagnostic("NYLO_BUILD_TOOL_NAME_DUPLICATE", "build", "error", "agent/tools", "Tool names must be unique.", "Rename one of the colliding tool files."));
  return tools;
}

export async function describeSkills(projectRoot: string): Promise<SkillDescriptor[]> {
  const root = join(projectRoot, "agent", "skills");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills = await Promise.all(names.sort().map(async (name) => {
    const contents = await readFile(join(root, name, "SKILL.md"), "utf8");
    const end = contents.indexOf("\n---", 4);
    const metadata = parseYaml(contents.slice(4, end)) as Record<string, unknown>;
    return Object.freeze({ name, description: String(metadata.description), digest: digest(contents) });
  }));
  return skills;
}

export function createManifest(config: AgentConfig, tools: readonly ToolDescriptor[], skills: readonly SkillDescriptor[], bundle: Uint8Array): CapabilityManifest {
  const base = {
    formatVersion: 1 as const,
    sdkVersion: SDK_VERSION,
    agent: Object.freeze({ name: config.name, model: config.model, secrets: config.secrets }),
    instructionsDigest: digest(config.instructions ?? ""),
    tools,
    skills,
    mcp: config.mcp,
    bundleDigest: digest(bundle)
  };
  return Object.freeze({ ...base, digest: digest(stableJson(base)) });
}
