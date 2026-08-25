/**
 * The pure portion of folder compilation. It is intentionally independent of
 * Node I/O and Vite so a builder, CLI, hosted compiler or generated entrypoint
 * applies precisely the same definition rules.
 */
export type AgentFolderDefinition = Readonly<{
  instructions?: string;
  packageName?: string;
}>;

export function mergeAgentFolderDefinition<T extends Readonly<{ name?: unknown; instructions?: unknown }>>(
  folder: AgentFolderDefinition,
  declared: T
): T & Readonly<{ name: string; instructions: string }> {
  if (declared.instructions !== undefined && folder.instructions !== undefined) {
    throw new Error("NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS: Use inline instructions or agent/AGENT.md, not both.");
  }
  if (declared.instructions === undefined && folder.instructions === undefined) {
    throw new Error("NYLO_BUILD_INSTRUCTIONS_ABSENT: Add inline instructions or agent/AGENT.md.");
  }
  const name = declared.name ?? folder.packageName;
  if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("NYLO_BUILD_NAME_UNDERIVABLE: package.json name is absent or is not a portable Nylo slug.");
  }
  const instructions = declared.instructions ?? folder.instructions;
  return Object.freeze({ ...declared, name, instructions }) as T & Readonly<{ name: string; instructions: string }>;
}
