import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { discoverAgentFolder } from "@nylorun/agent/compiler";
import { diagnostic, NyloBuildError } from "./diagnostics.js";
import { createManifest, describeSkills, describeTools, stableJson } from "./manifest.js";
import type { AgentConfig } from "./types.js";

const VIRTUAL_ID = "\0nylo:agent-entry";
const ENTRY_BASENAME = ".nylo-agent-entry.ts";

export function nyloAgent(): Plugin {
  let config: ResolvedConfig;
  let projectRoot = "";
  return {
    name: "nylo:agent",
    enforce: "pre",
    async config(userConfig) {
      projectRoot = resolve(userConfig.root ?? process.cwd());
      return {
        build: {
          emptyOutDir: true,
          outDir: "dist",
          lib: { entry: join(projectRoot, ENTRY_BASENAME), formats: ["es"], fileName: () => "agent.mjs" },
          rollupOptions: {
            // A published agent is deployed into a generic, package-free host.  The
            // runtime is therefore part of the artifact, not a dependency the host
            // resolves at boot.  Node built-ins remain external because the host is
            // explicitly a Node runtime.
            external: [/^node:/],
            output: { entryFileNames: "agent.mjs", codeSplitting: false }
          }
        }
      };
    },
    configResolved(resolved) {
      config = resolved;
      projectRoot = resolved.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID || id.endsWith(`/${ENTRY_BASENAME}`) || id === ENTRY_BASENAME) return VIRTUAL_ID;
    },
    async load(id) {
      if (id !== VIRTUAL_ID) return undefined;
      const folder = await discoverAgentFolder(projectRoot);
      // The generated entry is virtual, so declare the folder inputs explicitly
      // for Vite/Rollup watch mode as well as importing the TypeScript modules.
      // This also covers instruction and tool discovery, which are read by the
      // plugin rather than all being ordinary module-graph imports.
      this.addWatchFile(folder.definitionPath);
      this.addWatchFile(join(projectRoot, "agent", "AGENT.md"));
      for (const tool of folder.tools) this.addWatchFile(tool.path);
      const imports = folder.tools.map((entry, index) => `import * as tool${index} from ${JSON.stringify(entry.path)};`).join("\n");
      // The runtime handle is the named `agent` export, and the build is what makes it one: the authored
      // definition cannot know its own tools, because discovery is the directory's job. `config`
      // and `toolModules` stay exported because writeBundle below reads them to derive the
      // manifest, and because they keep the artifact introspectable without starting anything.
      return `${imports}\nimport declaredConfig from ${JSON.stringify(folder.definitionPath)};\nimport { mergeAgentFolderDefinition } from "@nylorun/agent/definition";\nimport { __nyloBindAgent, Fetchable } from "@nylorun/runtime/runtime-host";\nexport const config=mergeAgentFolderDefinition(${JSON.stringify({ instructions: folder.instructions, packageName: folder.packageName })},declaredConfig);\nexport const toolModules=[${folder.tools.map((entry, index) => `{file:${JSON.stringify(entry.file)},exports:tool${index}}`).join(",")}];\nexport const agent=__nyloBindAgent({moduleUrl:import.meta.url,config,toolModules});\nconst hostOptions=globalThis[Symbol.for("nylo.runtime.host-options")];\nexport default Fetchable(agent.withHost(hostOptions ?? {}));\n`;
    },
    async writeBundle() {
      const output = join(config.root, config.build.outDir, "agent.mjs");
      let loaded: { config?: AgentConfig; toolModules?: readonly { file: string; exports: Record<string, unknown> }[] };
      try {
        loaded = await import(`${pathToFileURL(output).href}?nylo=${Date.now()}`);
      } catch (error) {
        if (error instanceof NyloBuildError) throw error;
        const message = error instanceof Error ? error.message : "Agent module evaluation failed.";
        const named = message.match(/(NYLO_BUILD_[A-Z_]+):\s*(.*)/);
        if (named) throw new NyloBuildError(diagnostic(named[1], "build", "error", "agent", named[2], "Correct the named build error and retry."));
        if (message.includes("agent.mjs") && /cannot find module/i.test(message)) {
          throw new NyloBuildError(diagnostic("NYLO_BUILD_PLUGIN_OUTPUT_OVERRIDDEN", "build", "error", "vite.config.ts", "A later Vite setting overrode the Nylo plugin's required output.", "Remove settings or plugins that change the Nylo entry, output directory, or agent.mjs filename."));
        }
        throw new NyloBuildError(diagnostic("NYLO_BUILD_MODULE_EVALUATION_FAILED", "build", "error", "agent/agent.ts", message, "Fix the definition or tool module that threw during build."));
      }
      if (!loaded.config || !Array.isArray(loaded.config.secrets) || !Array.isArray(loaded.config.mcp) || typeof loaded.config.harness !== "function") {
        throw new NyloBuildError(diagnostic("NYLO_BUILD_DEFINITION_INVALID", "build", "error", "agent/agent.ts", "The default export is not a Harness-backed Run(...) definition.", "Default-export Run((options) => new Harness(options), {...})."));
      }
      const tools = describeTools(loaded.toolModules ?? []);
      const skills = await describeSkills(projectRoot);

      // A warning rather than a refusal, and deliberately so: the developer's build is the only
      // build, so refusing here would make a sandbox tool unbuildable for hosting — the one place
      // the sandbox exists. The local refusal happens when a session starts.
      for (const tool of tools) {
        if (!tool.sandbox) continue;
        process.stderr.write(
          `NYLO_BUILD_SANDBOX_LOCAL_UNSUPPORTED agent/tools/${tool.name}.ts — tool "${tool.name}" declares sandbox: true, which no local session can run. The artifact is still built, for hosted use.\n`
        );
      }

      const bundle = await readFile(output);
      const manifest = createManifest(loaded.config, tools, skills, bundle);
      await writeFile(join(config.root, config.build.outDir, "nylo.manifest.json"), `${stableJson(manifest)}\n`, { mode: 0o644 });
      // A publishable Nylo artifact is deliberately closed: one bundled module and its manifest.
      // Vite may leave an unreferenced compatibility chunk while resolving Node entry shims; it is
      // neither loaded by the bundle nor part of the artifact contract.
      for (const file of await readdir(join(config.root, config.build.outDir))) {
        if (file === "agent.mjs" || file === "nylo.manifest.json") continue;
        await rm(join(config.root, config.build.outDir, file), { recursive: true, force: true });
      }
    }
  };
}
