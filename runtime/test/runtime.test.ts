import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAgent, watchAgent, __nyloBindAgent, __nyloUnboundAgent } from "../src/index.js";
import type { BuiltAgent, RuntimeOptions } from "../src/index.js";
import { pathToFileURL } from "node:url";
import type { ModelGatewayAdapter, ModelGatewayChunk, WireSessionEvent } from "../src/index.js";

let imported = 0;

/**
 * Imports the agent a build produced. There is no loader to call: the built module's default
 * export is the agent, and this is the same import a builder's own server would write.
 */
async function built(root: string, host: RuntimeOptions = {}): Promise<BuiltAgent> {
  const url = `${pathToFileURL(join(root, "dist", "agent.mjs")).href}?t=${imported++}`;
  const module = (await import(url)) as { agent: BuiltAgent };
  return module.agent.withHost(host);
}

/**
 * A provider that replays a fixed script. Everything here runs offline: the point is the bridge
 * between a built artifact and a session, not the transport, which has its own coverage.
 */
function scripted(...turns: ModelGatewayChunk[][]): ModelGatewayAdapter {
  let turn = 0;
  return {
    async *complete(): AsyncIterable<ModelGatewayChunk> {
      for (const chunk of turns[Math.min(turn++, turns.length - 1)]) yield chunk;
    }
  };
}

const done = (finishReason: "stop" | "tool_calls"): ModelGatewayChunk => ({
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
  await symlink(packageRoot, join(root, "node_modules", "@nylorun", "runtime"), "dir");
  await symlink(join(packageRoot, "..", "harness"), join(root, "node_modules", "@nylorun", "harness"), "dir");
  // A real install hoists zod alongside the SDK, and a tool module imports it directly.
  await symlink(join(packageRoot, "..", "node_modules", "zod"), join(root, "node_modules", "zod"), "dir");
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(
    join(root, "vite.config.ts"),
    `import { nyloAgent } from "@nylorun/runtime";\nexport default {plugins:[nyloAgent()]};\n`
  );
  await writeFile(
    join(root, "agent", "agent.ts"),
    agentSource ??
      `import { Agent } from "@nylorun/harness";\nimport { Run } from "@nylorun/runtime/agent";\nexport default Run((model,directive)=>Agent(model,directive),{name:"sample",model:"anthropic/example"});\n`
  );
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

const tool = (body: string, extra = "") =>
  `import { tool } from "@nylorun/runtime/tool";\nimport { z } from "zod";\nexport default tool({description:"Echo a value.",input:z.object({value:z.string()}),${extra}run(input){${body}}});\n`;

describe("the built agent", () => {
  it("watches successful agent rebuilds after exposing the initial build", async () => {
    const root = await project();
    let watcher: Awaited<ReturnType<typeof watchAgent>> | undefined;
    const rebuilds: boolean[] = [];
    try {
      watcher = await watchAgent(root, async (result) => { rebuilds.push(result.ok); });
      expect((await watcher.initial).ok).toBe(true);
      await new Promise<void>((done) => setTimeout(done, 100));
      const before = rebuilds.length;
      await writeFile(join(root, "agent", "agent.ts"), `import { Agent } from "@nylorun/harness";\nimport { Run } from "@nylorun/runtime/agent";\nexport default Run((model,directive)=>Agent(model,directive),{name:"rebuilt",model:"anthropic/example"});\n`);
      await expect.poll(() => rebuilds.length, { timeout: 10_000 }).toBeGreaterThan(before);
      expect(rebuilds.at(-1)).toBe(true);
    } finally {
      await watcher?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses by name when imported from source rather than from the build", async () => {
    // Both import paths yield the same type and only one of them is complete, so an unbound agent
    // says so rather than quietly running an agent with no tools.
    const agent = __nyloUnboundAgent({ name: "sample", model: "anthropic/example", secrets: [], mcp: [] });
    expect(agent.bound).toBe(false);
    expect(() => agent.session.start("hi")).toThrowError(/has not been built/u);
    await expect(agent.ready()).rejects.toMatchObject({ diagnostic: { code: "NYLO_RUN_AGENT_UNBOUND" } });
  });

  it("refuses when the manifest half of the artifact is missing", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      await rm(join(root, "dist", "nylo.manifest.json"));
      const agent = await built(root);
      await expect(agent.ready()).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_ARTIFACT_MISSING" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a session and reports the resolved definition", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root, { modelGatewayAdapter: scripted([{ type: "text", text: "Hello." }, done("stop")]) });
      expect(agent.config.name).toBe("sample");
      expect((await agent.ready()).diagnostics).toEqual([]);

      const run = agent.session.start("hi");
      const events: WireSessionEvent[] = [];
      for await (const event of run.events) events.push(event);
      const result = await run.result;

      expect(result.output).toBe("Hello.");
      expect(result.state.status).toBe("paused");
      expect(events.map((event) => event.type)).toContain("session.run.ended");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins the selected local connection and its portable capabilities in model-call evidence", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root, {
        env: {
          NYLO_MODEL_GATEWAY_URL: "https://gateway.test",
          NYLO_MODEL_GATEWAY_PROTOCOL: "anthropic-messages",
          NYLO_MODEL_GATEWAY_ACCESS_MODE: "external-gateway"
        },
        modelGatewayTransport: {
          fetch: async () => new Response([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"example","content":[],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi."}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
        }
      });
      const run = agent.session.start("hello");
      const events: WireSessionEvent[] = [];
      for await (const event of run.events) events.push(event);
      await run.result;

      expect(events.find((event) => event.type === "model.call")?.payload).toMatchObject({
        resolvedModel: "anthropic/example",
        accessMode: "external-gateway",
        protocol: "anthropic-messages",
        capabilities: { portableHistory: true, providerState: false, hostedTools: false },
        attempts: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the bound Harness capability manifest at readiness", async () => {
    const root = await project();
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root, { modelGatewayAdapter: scripted([{ type: "text", text: "unused" }, done("stop")]) });
      expect((await agent.ready()).harness).toMatchObject({
        middleware: [{ id: "nylorun-folder" }],
        model: { id: "anthropic/example" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a typed tool and shapes its output", async () => {
    const root = await project({ "agent/tools/echo.ts": tool(`return "echoed: " + input.value;`) });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root, {
        modelGatewayAdapter: scripted(
          [
            { type: "tool-call", index: 0, id: "call-1", name: "echo", arguments: '{"value":"x"}' },
            done("tool_calls")
          ],
          [{ type: "text", text: "Done." }, done("stop")]
        )
      });
      const run = agent.session.start("use the tool");
      const events: WireSessionEvent[] = [];
      for await (const event of run.events) events.push(event);
      await run.result;

      expect(events).toContainEqual(expect.objectContaining({ type: "harness.observe", payload: expect.objectContaining({ observation: "adapter.completed" }) }));
      expect((await run.result).output).toBe("Done.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects arguments the Zod schema refuses, without ending the session", async () => {
    const root = await project({ "agent/tools/echo.ts": tool(`return input.value;`) });
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root, {
        modelGatewayAdapter: scripted(
          [
            { type: "tool-call", index: 0, id: "call-1", name: "echo", arguments: '{"value":42}' },
            done("tool_calls")
          ],
          [{ type: "text", text: "Recovered." }, done("stop")]
        )
      });
      const run = agent.session.start("use the tool badly");
      for await (const _ of run.events) void _;
      const result = await run.result;

      expect(result.state.status).toBe("paused");
      expect(result.output).toBe("Recovered.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a sandbox tool but refuses to start a local session with one", async () => {
    const root = await project({ "agent/tools/risky.ts": tool(`return input.value;`, "sandbox:true,") });
    try {
      // The build succeeds on purpose: it is the only build, and the artifact is for hosting,
      // where the sandbox exists. Only the local session refuses.
      expect((await buildAgent(root)).ok).toBe(true);
      const agent = await built(root);
      await expect(agent.ready()).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_TOOL_OPTION_UNSUPPORTED" }
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

      const agent = await built(root, { modelGatewayAdapter: scripted([{ type: "text", text: "ok" }, done("stop")]) });
      expect((await agent.ready()).diagnostics.map((item) => item.code)).toContain("NYLO_RUN_SKILL_STALE");

      // The body that actually reaches the session is the one on disk, not the one built.
      // Strict promotion runs after every warning is collected, so a provider is supplied here to
      // keep this a test of the promotion rather than of which warning comes first.
      const strict = await built(root, { strict: true, modelGatewayAdapter: scripted([done("stop")]) });
      await expect(strict.ready()).rejects.toMatchObject({
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
      await expect((await built(root, { env: {}, modelGatewayTransport: { fetch: async () => { throw new Error("offline"); } } })).ready()).rejects.toMatchObject({
        diagnostic: { code: "NYLO_RUN_MODEL_GATEWAY_UNRESOLVED" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers OpenRouter over a direct provider credential, and reports which answered", async () => {
    const root = await project(
      {},
      `import { AgentSpec } from "@nylorun/runtime/agent";\nexport default AgentSpec({name:"sample",model:"openai/gpt-4o"});\n`
    );
    try {
      expect((await buildAgent(root)).ok).toBe(true);
      const both = await built(root, { env: { OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" } });
      expect((await both.ready()).model?.route).toBe("openrouter");
      expect((await both.ready()).model?.credential.variable).toBe("OPENROUTER_API_KEY");
      expect((await both.ready()).model?.upstreamModel).toBe("openai/gpt-4o");

      const direct = await built(root, { env: { OPENAI_API_KEY: "oa" } });
      expect((await direct.ready()).model?.route).toBe("direct");
      expect((await direct.ready()).model?.upstreamModel).toBe("gpt-4o");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
