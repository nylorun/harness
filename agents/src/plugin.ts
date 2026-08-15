import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { diagnostic, NyloBuildError } from "./diagnostics.js";
import { createManifest, describeSkills, describeTools, stableJson } from "./manifest.js";
import type { AgentConfig } from "./types.js";

const VIRTUAL_ID = "\0nylo:agent-entry";
const ENTRY_BASENAME = ".nylo-agent-entry.ts";

async function toolFiles(projectRoot: string): Promise<string[]> {
  const root = join(projectRoot, "agent", "tools");
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

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
            external: [/^@nylorun\/agents(?:\/|$)/],
            output: { entryFileNames: "agent.mjs" }
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
      const names = await toolFiles(projectRoot);
      const agentPath = join(projectRoot, "agent", "agent.ts");
      const instructionPath = join(projectRoot, "agent", "AGENT.md");
      let fileInstructions: string | undefined;
      try { fileInstructions = await readFile(instructionPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const imports = names.map((name, index) => `import * as tool${index} from ${JSON.stringify(join(projectRoot, "agent", "tools", name))};`).join("\n");
      return `${imports}\nimport declaredConfig from ${JSON.stringify(agentPath)};\nconst fileInstructions=${JSON.stringify(fileInstructions)};\nif (declaredConfig.instructions !== undefined && fileInstructions !== undefined) throw new Error("NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS: Use inline instructions or agent/AGENT.md, not both.");\nif (declaredConfig.instructions === undefined && fileInstructions === undefined) throw new Error("NYLO_BUILD_INSTRUCTIONS_ABSENT: Add inline instructions or agent/AGENT.md.");\nexport const config=Object.freeze({...declaredConfig,instructions:declaredConfig.instructions ?? fileInstructions});\nexport const toolModules=[${names.map((name, index) => `{file:${JSON.stringify(name)},exports:tool${index}}`).join(",")}];\n`;
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
      if (!loaded.config || !Array.isArray(loaded.config.secrets) || !Array.isArray(loaded.config.mcp)) {
        throw new NyloBuildError(diagnostic("NYLO_BUILD_DEFINITION_INVALID", "build", "error", "agent/agent.ts", "The default export is not an Agent({...}) configuration.", "Default-export the value returned by Agent({...})."));
      }
      const tools = describeTools(loaded.toolModules ?? []);
      const skills = await describeSkills(projectRoot);
      const bundle = await readFile(output);
      const manifest = createManifest(loaded.config, tools, skills, bundle);
      await writeFile(join(config.root, config.build.outDir, "nylo.manifest.json"), `${stableJson(manifest)}\n`, { mode: 0o644 });
    }
  };
}
