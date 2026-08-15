import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAgent, openAgent } from "../src/index.js";
import type { ProviderAdapter, ProviderChunk, SessionEvent } from "../src/index.js";

/**
 * A provider that replays a fixed script. Everything here runs offline: the point is the bridge
 * between a built artifact and a session, not the transport, which has its own coverage.
 */
function scripted(...turns: ProviderChunk[][]): ProviderAdapter {
  let turn = 0;
  return {
    async *complete(): AsyncIterable<ProviderChunk> {
      for (const chunk of turns[Math.min(turn++, turns.length - 1)]) yield chunk;
    }
  };
}

const done = (finishReason: "stop" | "tool_calls"): ProviderChunk => ({
  type: "done",
  finishReason,
  usage: { tokensIn: 1, tokensOut: 1 }
});

async function project(
  files: Readonly<Record<string, string>> = {},
  agentSource?: string
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-runtime-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(root, "node_modules", "@nylorun"), { recursive: true });
  const packageRoot = new URL("../", import.meta.url).pathname;
  await symlink(packageRoot, join(root, "node_modules", "@nylorun", "agents"), "dir");
  // A real install hoists zod alongside the SDK, and a tool module imports it directly.
  await symlink(join(packageRoot, "node_modules", "zod"), join(root, "node_modules", "zod"), "dir");
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(
    join(root, "vite.config.ts"),
    `import { nyloAgent } from "@nylorun/agents";\nexport default {plugins:[nyloAgent()]};\n`
  );
  await writeFile(
    join(root, "agent", "agent.ts"),
    agentSource ??
      `import { Agent } from "@nylorun/agents";\nexport default Agent({name:"sample",model:"anthropic/example"});\n`
  );
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

const tool = (body: string, extra = "") =>
  `import { defineTool } from "@nylorun/agents";\nimport { z } from "zod";\nexport default defineTool({description:"Echo a value.",input:z.object({value:z.string()}),${extra}run(input){${body}}});\n`;

describe("openAgent", () => {
  it("refuses a project that has not been built", async () => {
    const root = await project();
    try {
      await expect(openAgent(root)).rejects.toMatchObject({ diagnostic: { code: "NYLO_RUN_ARTIFACT_MISSING" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a session and reports the resolved definition", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await openAgent(root, { provider: scripted([{ type: "text", text: "Hello." }, done("stop")]) });
      expect(agent.config.name).toBe("sample");
      expect(agent.diagnostics).toEqual([]);

      const run = agent.run("hi");
      const events: SessionEvent[] = [];
      for await (const event of run.events) events.push(event);
      const result = await run.result;

      expect(result.output).toBe("Hello.");
      expect(result.state.status).toBe("completed");
      expect(events.map((event) => event.type)).toContain("session.ended");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a typed tool and shapes its output", async () => {
    const root = await project({ "agent/tools/echo.ts": tool(`return "echoed: " + input.value;`) });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await openAgent(root, {
        provider: scripted(
          [
            { type: "tool-call", index: 0, id: "call-1", name: "echo", arguments: '{"value":"x"}' },
            done("tool_calls")
          ],
          [{ type: "text", text: "Done." }, done("stop")]
        )
      });
      const run = agent.run("use the tool");
      const events: SessionEvent[] = [];
      for await (const event of run.events) events.push(event);
      await run.result;

      const call = events.find((event) => event.type === "tool.call");
      expect(JSON.stringify(call)).toContain("echoed: x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects arguments the Zod schema refuses, without ending the session", async () => {
    const root = await project({ "agent/tools/echo.ts": tool(`return input.value;`) });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await openAgent(root, {
        provider: scripted(
          [
            { type: "tool-call", index: 0, id: "call-1", name: "echo", arguments: '{"value":42}' },
            done("tool_calls")
          ],
          [{ type: "text", text: "Recovered." }, done("stop")]
        )
      });
      const run = agent.run("use the tool badly");
      for await (const _ of run.events) void _;
      const result = await run.result;

      expect(result.state.status).toBe("completed");
      expect(result.output).toBe("Recovered.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a sandbox tool when the project is opened", async () => {
    const root = await project({ "agent/tools/risky.ts": tool(`return input.value;`, "sandbox:true,") });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      await expect(openAgent(root)).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_SANDBOX_UNSUPPORTED" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns rather than refuses when an edited skill no longer matches the manifest", async () => {
    const skill = (body: string) => `---\nname: helper\ndescription: Helps with things.\n---\n\n${body}\n`;
    const root = await project({ "agent/skills/helper/SKILL.md": skill("Original guidance.") });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      await writeFile(join(root, "agent", "skills", "helper", "SKILL.md"), skill("Edited guidance."));

      const agent = await openAgent(root, { provider: scripted([{ type: "text", text: "ok" }, done("stop")]) });
      expect(agent.diagnostics.map((item) => item.code)).toContain("NYLO_RUN_SKILL_STALE");

      // The body that actually reaches the session is the one on disk, not the one built.
      await expect(openAgent(root, { strict: true })).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_SKILL_STALE" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names the fix when a model identity has no reachable provider", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      await expect(openAgent(root, { env: {} })).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_PROVIDER_UNSUPPORTED" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers OpenRouter over a direct provider credential, and reports which answered", async () => {
    const root = await project(
      {},
      `import { Agent } from "@nylorun/agents";\nexport default Agent({name:"sample",model:"openai/gpt-4o"});\n`
    );
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const both = await openAgent(root, { env: { OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" } });
      expect(both.model?.route).toBe("openrouter");
      expect(both.model?.credential.variable).toBe("OPENROUTER_API_KEY");
      expect(both.model?.upstreamModel).toBe("openai/gpt-4o");

      const direct = await openAgent(root, { env: { OPENAI_API_KEY: "oa" } });
      expect(direct.model?.route).toBe("direct");
      expect(direct.model?.upstreamModel).toBe("gpt-4o");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
