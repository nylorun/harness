import { expect, it } from "vitest";
import { Agent } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
import { hashManifest } from "../src/utils/hash.js";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

function manifest(capabilities: readonly Record<string, unknown>[]) {
  return {
    manifestSchemaVersion: 4 as const,
    id: "issue-bot",
    capabilities,
  };
}

it("round-trips a v4 capability and a named streamable-http server", () => {
  const built = Agent({ id: "issue-bot", name: "Issue bot" }).build();
  expect(built.manifest.manifestSchemaVersion).toBe(4);
  expect(built.manifest).not.toHaveProperty("runtime");
  const json = manifest([
    {
      id: "issue-management",
      type: "agent-plugin",
      metadata: { source: "package" },
      mcpServers: { github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, { "issue-management": {} });
  expect(restored.manifest.capabilities[0]).toMatchObject({
    id: "issue-management",
    type: "agent-plugin",
    metadata: { source: "package" },
    mcpServers: { github },
  });
  expect(restored.toJSON()).toEqual(restored.manifest);
});

it("accepts a skill name and description and rejects file contents", () => {
  const skill = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(skill).success).toBe(true);
  const restored = Agent.from(skill, { docs: {} });
  expect(restored.manifest.capabilities[0]?.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue.",
  });
  expect(
    restored.getBinding().tools.some((tool) => tool.name === "load_skill")
  ).toBe(false);

  const withBody = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
          instructions: "Body",
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(withBody).success).toBe(false);

  const withResources = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
          resources: { "references/labels.md": "# Labels\n" },
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(withResources).success).toBe(false);
});

it("rejects a server key that differs from name and a duplicate server", () => {
  const mismatched = manifest([
    {
      id: "issue-management",
      type: "agent",
      mcpServers: { other: github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(mismatched).success).toBe(false);
  expect(() => Agent.from(mismatched, { "issue-management": {} })).toThrow(
    HarnessError,
  );

  const duplicated = manifest([
    {
      id: "one",
      type: "agent",
      mcpServers: { github },
    },
    {
      id: "two",
      type: "agent",
      mcpServers: { github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(duplicated).success).toBe(false);
  expect(() =>
    Agent.from(duplicated, { one: {}, two: {} }),
  ).toThrow(HarnessError);
});

it("projects registered hooks in canonical order with a stable hash", () => {
  const noop = () => ({});
  const first = Agent({ id: "hooked" })
    .use({ id: "policy", after: { turn: noop, step: noop }, before: { step: noop } })
    .after("step", noop)
    .before("turn", noop)
    .build();
  const policy = first.manifest.capabilities.find((item) => item.id === "policy");
  expect(policy?.hooks).toEqual([
    { at: "before", scope: "step" },
    { at: "after", scope: "step" },
    { at: "after", scope: "turn" },
  ]);
  const agent = first.manifest.capabilities.find((item) => item.id === "agent");
  expect(agent?.hooks).toEqual([
    { at: "before", scope: "turn" },
    { at: "after", scope: "step" },
  ]);
  expect(AgentManifestSchema.safeParse(first.manifest).success).toBe(true);
  const second = Agent({ id: "hooked" })
    .use({ id: "policy", before: { step: noop }, after: { step: noop, turn: noop } })
    .before("turn", noop)
    .after("step", noop)
    .build();
  expect(hashManifest(second.manifest)).toBe(hashManifest(first.manifest));
  expect(first.manifest.capabilities.some((item) => "beforeModelCall" in item)).toBe(false);
});

it("rejects duplicate, unknown and out-of-order hook lists", () => {
  const withHooks = (hooks: unknown) =>
    manifest([{ id: "policy", type: "agent", hooks }]);
  const noop = () => ({});
  const impl = { policy: { before: { step: noop, turn: noop } } };
  for (const hooks of [
    [{ at: "before", scope: "step" }, { at: "before", scope: "turn" }],
    [{ at: "before", scope: "step" }, { at: "before", scope: "step" }],
    [{ at: "during", scope: "step" }],
    [],
  ]) {
    expect(AgentManifestSchema.safeParse(withHooks(hooks)).success).toBe(false);
    expect(() => Agent.from(withHooks(hooks), impl as never)).toThrow(HarnessError);
  }
});

it("requires hook implementations to match the manifest", () => {
  const noop = () => ({});
  const json = manifest([
    { id: "policy", type: "agent", hooks: [{ at: "before", scope: "step" }] },
  ]);
  expect(() => Agent.from(json, {})).toThrow(/Missing before\("step"\) implementation/);
  expect(() =>
    Agent.from(json, { policy: { before: { step: noop, turn: noop } } })
  ).toThrow(/does not declare it/);
  expect(
    Agent.from(json, { policy: { before: { step: noop } } }).manifest.capabilities[0]?.hooks
  ).toEqual([{ at: "before", scope: "step" }]);
});

it("rejects schema 3 manifests and the removed hook flags", () => {
  expect(() =>
    Agent.from({ manifestSchemaVersion: 3, id: "old", capabilities: [] }, {})
  ).toThrow(/MIGRATION\.md/);
  expect(() =>
    Agent.from(manifest([{ id: "old", type: "agent", beforeModelCall: true }]), {})
  ).toThrow(/replaced by hooks/);
});

it("reports a duplicate agent-level hook as a build diagnostic", () => {
  const noop = () => ({});
  expect(() => Agent({ id: "twice" }).before("step", noop).before("step", noop).build()).toThrow(
    /registered more than once/
  );
});
