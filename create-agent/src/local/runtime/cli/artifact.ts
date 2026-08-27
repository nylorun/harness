import type { BuiltAgent } from "../runtime/bind.js";

/** Selects the local runtime handle without confusing it with the bundle's default HTTP door. */
export function runtimeAgentFrom(module: unknown): BuiltAgent | undefined {
  if (typeof module !== "object" || module === null || !("agent" in module)) return undefined;
  const agent = (module as { agent?: BuiltAgent }).agent;
  return typeof agent?.session?.start === "function" ? agent : undefined;
}
