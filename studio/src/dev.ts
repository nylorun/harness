import { startLocalRuntime, type LocalRuntimeHost } from "@nylorun/create-agent/local/runtime-host";
import { createFileRecorder, watchAgent, type BuildResult, type AgentBuildWatcher } from "@nylorun/create-agent/local";
import { resolve } from "node:path";
import { loadLocalAgent, startStaticStudio, type StudioHost } from "./host.js";

export type DevOptions = Readonly<{ project: string; port: number; studio: boolean; open: boolean }>;
export type DevHost = Readonly<{ agentServerUrl: string; studioAddress?: string; close(): Promise<void> }>;

function buildFailure(result: BuildResult): Error {
  const details = result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");
  return new Error(details === "" ? "Agent build failed." : details);
}

function portFailure(port: number, error: unknown): Error {
  if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
    return new Error(`Agent Server port ${port} is already in use. Choose another with --port or PORT.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
function recordSecrets(): string[] {
  return Object.entries(process.env).flatMap(([name, value]) => value !== undefined && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) ? [value] : []);
}

/** Coordinates a watched local Agent Server and, when requested, its static Studio companion. */
export async function startDevelopment(options: DevOptions): Promise<DevHost> {
  const project = resolve(options.project);
  let studio: StudioHost | undefined;
  let runtime: LocalRuntimeHost | undefined;
  let watcher: AgentBuildWatcher | undefined;
  let generation = 0;

  const startRuntime = async (): Promise<LocalRuntimeHost> => {
    const agent = (await loadLocalAgent(project, String(++generation))).withHost({
      recorder: createFileRecorder({ projectRoot: project, redact: recordSecrets() })
    });
    try {
      return await startLocalRuntime(agent, {
        port: options.port,
        ...(studio === undefined ? {} : { cors: { allowedOrigins: [studio.address] } })
      });
    } catch (error) {
      throw portFailure(options.port, error);
    }
  };

  const replaceRuntime = async (): Promise<void> => {
    studio?.setAgentServerUrl(undefined);
    await runtime?.close();
    runtime = undefined;
    runtime = await startRuntime();
    studio?.setAgentServerUrl(runtime.address);
  };

  try {
    if (options.studio) studio = await startStaticStudio({ open: false });
    watcher = await watchAgent(project, async (result) => {
      if (!result.ok) {
        process.stderr.write(`Agent rebuild failed; the previous Agent Server remains available.\n${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n")}\n`);
        return;
      }
      try {
        await replaceRuntime();
        process.stdout.write(`Agent Server restarted on ${runtime!.address}\n`);
      } catch (error) {
        process.stderr.write(`Agent Server restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
    const initial = await watcher.initial;
    if (!initial.ok) throw buildFailure(initial);
    runtime = await startRuntime();
    studio?.setAgentServerUrl(runtime.address);
    if (options.studio && options.open) studio!.open();
    return Object.freeze({
      agentServerUrl: runtime.address,
      ...(studio === undefined ? {} : { studioAddress: studio.address }),
      close: async () => {
        await watcher?.close();
        await studio?.close();
        await runtime?.close();
      }
    });
  } catch (error) {
    await watcher?.close();
    await studio?.close();
    await runtime?.close();
    throw error;
  }
}
