import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type Skill = Readonly<{ name: string; summary: string; body: string }>;

export class SkillRoster {
  private constructor(private readonly skills: ReadonlyMap<string, Skill>) {}

  static async fromDirectory(root: string): Promise<SkillRoster> {
    const entries = await readdir(root, { withFileTypes: true });
    const values = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const body = await readFile(join(root, entry.name), "utf8");
          const summary =
            body
              .split("\n")
              .find((line) => line.trim() && !line.startsWith("#"))
              ?.trim() ?? "Local skill";
          return [
            entry.name.slice(0, -3),
            { name: entry.name.slice(0, -3), summary, body },
          ] as const;
        }),
    );
    return new SkillRoster(new Map(values));
  }

  list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}
