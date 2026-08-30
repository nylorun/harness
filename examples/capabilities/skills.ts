import { tool, type CapabilityDeclaration } from "@nylorun/harness";
import { z } from "zod";
import type { SkillRoster } from "../services/skills.js";

export function skillRoster(roster: SkillRoster): CapabilityDeclaration<{ loaded: Set<string> }> {
  return {
    id: "skills",
    state: { create: () => ({ loaded: new Set<string>() }) },
    tools: [
      tool({
        name: "load_skill",
        description: "Load a local Markdown skill into this session's next model step.",
        parameters: z.object({ name: z.string() }),
        async execute({ name }, context) {
          const skill = roster.get(name);
          if (!skill) {
            return {
              kind: "failed" as const,
              code: "skill.unknown",
              message: `Unknown skill '${name}'.`,
            };
          }
          (await context.state).loaded.add(name);
          return { kind: "completed" as const, output: { loaded: name, body: skill.body } };
        },
      }),
    ],
    async middleware(request, next) {
      const state = await request.state;
      request.configuration.instructions.set("skills.roster", [
        roster
          .list()
          .map((skill) => `- ${skill.name}: ${skill.summary}`)
          .join("\n"),
      ]);
      const bodies = [...state.loaded]
        .map((name) => roster.get(name)?.body)
        .filter((body): body is string => body !== undefined);
      if (bodies.length) request.configuration.instructions.set("skills.loaded", bodies);
      return next();
    },
  };
}
