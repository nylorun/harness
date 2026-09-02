import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  model,
  type CapabilityDeclaration,
  type CapabilityItems,
  type ToolDefinition,
} from "@nylorun/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineSkill,
  formatSkillCatalog,
  skills,
  SKILLS_USAGE,
} from "../capabilities/skills/index.js";
import { SkillRoster } from "../capabilities/skills/roster.js";

const adapter = model(async () => ({
  output: [{ type: "text" as const, text: "ok" }],
  finishReason: "stop" as const,
}));

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-test-"));
  temps.push(root);
  return root;
}

async function writeSkill(
  root: string,
  directoryName: string,
  frontmatter: string,
  body: string,
  extras: Readonly<Record<string, string>> = {},
): Promise<string> {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  for (const [path, content] of Object.entries(extras)) {
    const full = join(directory, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return directory;
}

function items<T>(value: CapabilityItems<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return "items" in value ? value.items : value;
}

function toolNamed(declaration: CapabilityDeclaration, name: string): ToolDefinition {
  const found = items(declaration.tools).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function context() {
  return {
    sessionId: "session",
    turnId: "turn",
    stepId: "step",
    callId: "call",
    invocationId: "invocation",
    signal: new AbortController().signal,
  };
}

describe("SkillRoster", () => {
  it("parses a valid SKILL.md and lists supporting files", async () => {
    const root = await tempDir();
    await writeSkill(
      root,
      "pdf-processing",
      [
        "name: pdf-processing",
        "description: Extract PDF text. Use when handling PDFs.",
        "license: Apache-2.0",
        "metadata:",
        '  version: "1.0"',
      ].join("\n"),
      "Read references/FORMS.md first.",
      { "references/FORMS.md": "# Forms\n" },
    );
    const roster = await SkillRoster.fromDirectory(root);
    expect(roster.list()).toMatchObject([
      {
        name: "pdf-processing",
        description: "Extract PDF text. Use when handling PDFs.",
        body: "Read references/FORMS.md first.\n",
        license: "Apache-2.0",
        metadata: { version: "1.0" },
        resources: ["references/FORMS.md"],
      },
    ]);
    expect(roster.diagnostics).toEqual([]);
  });

  it("skips a skill with no description", async () => {
    const root = await tempDir();
    await writeSkill(root, "broken", "name: broken", "Body.");
    const roster = await SkillRoster.fromDirectory(root);
    expect(roster.list()).toEqual([]);
    expect(roster.diagnostics).toEqual([
      expect.objectContaining({
        kind: "skipped",
        message: "SKILL.md is missing a description.",
      }),
    ]);
  });

  it("loads when name does not match the directory and records a warning", async () => {
    const root = await tempDir();
    await writeSkill(
      root,
      "other-name",
      "name: pdf-processing\ndescription: Extract PDF text. Use when handling PDFs.",
      "Body.",
    );
    const roster = await SkillRoster.fromDirectory(root);
    expect(roster.get("pdf-processing")?.body).toBe("Body.\n");
    expect(roster.diagnostics).toEqual([
      expect.objectContaining({
        kind: "warning",
        message: "Skill name 'pdf-processing' does not match directory 'other-name'.",
      }),
    ]);
  });

  it("tolerates a colon inside an unquoted description", async () => {
    const root = await tempDir();
    await writeSkill(
      root,
      "pdf-processing",
      "name: pdf-processing\ndescription: Use this skill when: the user asks about PDFs",
      "Body.",
    );
    const roster = await SkillRoster.fromDirectory(root);
    expect(roster.get("pdf-processing")?.description).toBe(
      "Use this skill when: the user asks about PDFs",
    );
  });
});

describe("skills()", () => {
  it("puts usage text and a name-description catalog in one declaration", async () => {
    const declaration = await skills({
      skills: [
        defineSkill({
          name: "structured-summary",
          description: "Produce a fixed-heading summary. Use when asked to summarize.",
          instructions: "## Claim",
        }),
      ],
    });
    expect(items(declaration.instructions)).toEqual([
      SKILLS_USAGE,
      formatSkillCatalog([
        {
          name: "structured-summary",
          description: "Produce a fixed-heading summary. Use when asked to summarize.",
          body: "## Claim",
          resources: [],
        },
      ]),
    ]);
    expect(items(declaration.instructions)[1]).toContain("<name>structured-summary</name>");
    expect(items(declaration.instructions)[1]).not.toContain("## Claim");
    expect(formatSkillCatalog([])).toBe("");
    expect(items(declaration.tools).map((tool) => tool.name)).toEqual(["load_skill"]);
  });

  it("returns a wrapped body and resource list from load_skill", async () => {
    const root = await tempDir();
    await writeSkill(
      root,
      "code-review",
      "name: code-review\ndescription: Review a change. Use when editing code.",
      "Read CHECKLIST.md, then review.",
      { "CHECKLIST.md": "- tests\n" },
    );
    const declaration = await skills({ directory: root });
    const result = await toolNamed(declaration, "load_skill").execute(
      { name: "code-review" },
      context(),
    );
    expect(result).toMatchObject({
      kind: "completed",
      output: {
        content: expect.stringContaining("Read CHECKLIST.md, then review."),
      },
    });
    if (result.kind !== "completed" || typeof result.output !== "object" || result.output === null) {
      throw new Error("expected a completed skill body");
    }
    const content = (result.output as { content: string }).content;
    expect(content).toContain('<skill_content name="code-review">');
    expect(content).toContain("<file>CHECKLIST.md</file>");
    expect(content).not.toContain("Review a change.");
  });

  it("reads a supporting file through read_skill_resource", async () => {
    const declaration = await skills({
      skills: [
        defineSkill({
          name: "code-review",
          description: "Review a change. Use when editing code.",
          instructions: "Read CHECKLIST.md.",
          files: { "CHECKLIST.md": "- tests\n" },
        }),
      ],
    });
    expect(items(declaration.tools).map((tool) => tool.name)).toEqual([
      "load_skill",
      "read_skill_resource",
    ]);
    await expect(
      toolNamed(declaration, "read_skill_resource").execute(
        { name: "code-review", path: "CHECKLIST.md" },
        context(),
      ),
    ).resolves.toEqual({
      kind: "completed",
      output: { name: "code-review", path: "CHECKLIST.md", content: "- tests\n" },
    });
  });

  it("omits tools and catalog when no skills are discovered", async () => {
    const root = await tempDir();
    await expect(skills({ directory: root })).resolves.toEqual({ id: "skills" });
  });

  it("builds an agent with one skills middleware and no skill-use", async () => {
    const root = await tempDir();
    await writeSkill(
      root,
      "structured-summary",
      "name: structured-summary\ndescription: Produce a fixed-heading summary. Use when asked to summarize.",
      "## Claim",
    );
    const agent = Agent({
      id: "skills",
      name: "Skills",
      instructions: "Be concise.",
    })
      .use(await skills({ directory: root }))
      .with(adapter)
      .build();
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual(["agent", "skills"]);
    expect(agent.manifest.middleware.find((item) => item.id === "skills")).toEqual({
      id: "skills",
      instructions: [
        SKILLS_USAGE,
        expect.stringContaining("<name>structured-summary</name>"),
      ],
      tools: [{ name: "load_skill", description: "Load the full instructions for a named skill." }],
    });
  });
});
