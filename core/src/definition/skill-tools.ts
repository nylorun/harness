import { z } from "zod";
import type { SkillRecord } from "../types/middleware.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";
import { tool } from "./helpers.js";

const USAGE =
  "Load the full instructions for a named skill. Call this before following a skill.";

export function createSkillTools(
  skills: ReadonlyMap<string, SkillRecord>
): readonly ToolDefinition[] {
  const names = [...skills.keys()].sort();
  const nameSchema =
    names.length === 1
      ? z.literal(names[0]!)
      : z.enum(names as [string, ...string[]]);
  const definitions: ToolDefinition[] = [
    tool({
      name: "load_skill",
      description: USAGE,
      inputSchema: z.object({ name: nameSchema }),
      effects: "read",
      async execute(args): Promise<JsonObject> {
        const name = (args as { name: string }).name;
        const skill = skills.get(name);
        if (!skill) return { unknown: name, available: names };
        const loaded: JsonObject = {
          name: skill.name,
          content: skill.instructions,
        };
        const resources = Object.keys(skill.resources ?? {}).sort();
        if (resources.length === 0) return loaded;
        return { ...loaded, resources };
      },
    }),
  ];
  const hasResources = [...skills.values()].some(
    (skill) => skill.resources !== undefined && Object.keys(skill.resources).length > 0
  );
  if (hasResources) {
    definitions.push(
      tool({
        name: "read_skill_resource",
        description: "Read one text resource from a skill after load_skill.",
        inputSchema: z.object({
          name: nameSchema,
          path: z.string().min(1),
        }),
        effects: "read",
        async execute(args) {
          const { name, path } = args as { name: string; path: string };
          const skill = skills.get(name);
          const content = skill?.resources?.[path];
          if (!skill || content === undefined)
            return {
              kind: "failed" as const,
              code: "skill.unknown_resource",
              message: `Skill '${name}' has no resource '${path}'.`,
            };
          return { kind: "completed" as const, output: { name, path, content } };
        },
      })
    );
  }
  return definitions;
}
