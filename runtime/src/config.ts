import type { RuntimeAgent } from "./contracts.js";
import type { RuntimePersistence } from "./adapters/journal.js";
import type { RuntimeMedia } from "./adapters/media.js";

export interface RuntimeConfig {
  readonly agents: readonly RuntimeAgent[];
  readonly persistence?: RuntimePersistence;
  readonly media?: RuntimeMedia;
  readonly origins?: readonly string[];
}
export function defineRuntime(config: RuntimeConfig): RuntimeConfig {
  if (!config || !Array.isArray(config.agents))
    throw new Error("Runtime config must declare an agents array.");
  for (const agent of config.agents) {
    if (
      !agent ||
      typeof agent.run !== "function" ||
      typeof agent.id !== "string" ||
      !agent.manifest
    )
      throw new Error("Every registered agent must satisfy RuntimeAgent.");
  }
  return Object.freeze({
    ...config,
    agents: Object.freeze([...config.agents]),
  });
}
