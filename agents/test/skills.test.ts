import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@nylorun/core/define";
import { expect, it } from "vitest";
import {
  loadSkillsFromDirectory,
  skills,
  SkillsError,
} from "../src/skills/index.js";

function catalog(): string {
  return mkdtempSync(join(tmpdir(), "nylorun-skills-"));
}

function write(directory: string, path: string, contents: string): void {
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

it("loads an agentskills.io catalog without duplicating skills and skillRecords", async () => {
  const root = catalog();
  write(
    root,
    "triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue. Use when labeling.\n---\nBody stays stored.\n"
  );
  write(root, "triage/references/labels.md", "# Labels\n");

  const declaration = skills(root);
  expect(declaration.id).toBe(realpathSync(root).split(/[/\\]/).pop());
  expect(declaration.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue. Use when labeling.",
  });
  expect(declaration.skillRecords?.triage).toEqual({
    name: "triage",
    description: "Triage an issue. Use when labeling.",
    instructions: "Body stays stored.\n",
    resources: { "references/labels.md": "# Labels\n" },
  });
  expect(declaration.instructions?.join("\n")).toContain("<name>triage</name>");
  expect(declaration.instructions?.join("\n")).not.toContain("Body stays stored.");

  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .use(skills(root))
    .build();

  const capability = agent.manifest.capabilities.find(
    (item) => item.id === declaration.id
  );
  expect(capability?.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue. Use when labeling.",
  });
  expect(JSON.stringify(agent.manifest)).not.toContain("Body stays stored.");
  expect(JSON.stringify(agent.manifest)).not.toContain("# Labels");

  const load = agent.getBinding().tools.find((item) => item.name === "load_skill");
  const read = agent
    .getBinding()
    .tools.find((item) => item.name === "read_skill_resource");
  expect(load).toBeDefined();
  const loaded = await load!.execute({ name: "triage" }, {} as never);
  expect(loaded).toMatchObject({
    name: "triage",
    content: expect.stringContaining("Body stays stored."),
    resources: ["references/labels.md"],
  });
  const resource = await read!.execute(
    { name: "triage", path: "references/labels.md" },
    {} as never
  );
  expect(resource).toMatchObject({
    kind: "completed",
    output: { content: "# Labels\n" },
  });
});

it("accepts an explicit capability id and omits tools when the catalog is empty", () => {
  const root = catalog();
  const declaration = skills(root, { id: "assistant-skills" });
  expect(declaration).toMatchObject({
    id: "assistant-skills",
    root: realpathSync(root),
  });
  expect(declaration.skills).toBeUndefined();
  expect(declaration.skillRecords).toBeUndefined();
  expect(declaration.instructions).toBeUndefined();

  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(skills(root, { id: "assistant-skills" }))
    .build();
  expect(
    agent.getBinding().tools.some((tool) => tool.name === "load_skill")
  ).toBe(false);
});

it("throws when the catalog directory is missing", () => {
  expect(() => skills(join(tmpdir(), "missing-skills-catalog"))).toThrow(
    SkillsError
  );
  try {
    skills(join(tmpdir(), "missing-skills-catalog"));
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError);
    expect((error as SkillsError).code).toBe("skills.missing");
  }
});

it("skips invalid skills and keeps siblings", () => {
  const root = catalog();
  write(root, "broken/SKILL.md", "no frontmatter");
  write(
    root,
    "triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue.\n---\nOk.\n"
  );
  const diagnostics: { code: string }[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics as never);
  expect(Object.keys(loaded)).toEqual(["triage"]);
  expect(diagnostics.some((item) => item.code === "skills.skill-skipped")).toBe(
    true
  );
});

it("parses YAML frontmatter with gray-matter including quoted colons", () => {
  const root = catalog();
  write(
    root,
    "pdf-processing/SKILL.md",
    '---\nname: pdf-processing\ndescription: "Use this skill when: the user asks about PDFs"\nlicense: Apache-2.0\n---\nExtract text.\n'
  );
  write(
    root,
    "invalid-yaml/SKILL.md",
    "---\nname: invalid-yaml\ndescription: Use this skill when: unquoted colon breaks YAML\n---\nNope.\n"
  );
  const diagnostics: { code: string }[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics as never);
  expect(loaded["pdf-processing"]).toMatchObject({
    name: "pdf-processing",
    description: "Use this skill when: the user asks about PDFs",
    instructions: "Extract text.\n",
  });
  expect(loaded["invalid-yaml"]).toBeUndefined();
  expect(diagnostics.some((item) => item.code === "skills.skill-skipped")).toBe(
    true
  );
});
