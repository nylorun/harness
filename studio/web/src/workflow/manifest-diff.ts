import type { AgentManifestLike } from "./types.ts";

function toolsOf(manifest: AgentManifestLike): readonly string[] {
  return (manifest.capabilities ?? []).flatMap((capability) =>
    (capability.tools ?? []).map((tool) => tool.name),
  );
}

function instructionsOf(manifest: AgentManifestLike): readonly string[] {
  return (manifest.capabilities ?? [])
    .map((capability) => capability.instructions)
    .filter((value): value is string => typeof value === "string" && value !== "");
}

/**
 * Summarise a decide patch between consecutive iteration manifests (loops.md §4.6).
 * Example: `instructions +1, tool deploy removed`.
 */
export function summarizeManifestPatch(
  previous: AgentManifestLike | undefined,
  next: AgentManifestLike | undefined,
): string | undefined {
  if (!previous || !next) return undefined;
  const parts: string[] = [];
  const prevInstructions = instructionsOf(previous);
  const nextInstructions = instructionsOf(next);
  const instructionDelta = nextInstructions.length - prevInstructions.length;
  if (instructionDelta !== 0)
    parts.push(
      `instructions ${instructionDelta > 0 ? "+" : ""}${instructionDelta}`,
    );
  else if (
    prevInstructions.join("\0") !== nextInstructions.join("\0") &&
    nextInstructions.length > 0
  )
    parts.push("instructions changed");

  const prevTools = new Set(toolsOf(previous));
  const nextTools = new Set(toolsOf(next));
  for (const name of prevTools)
    if (!nextTools.has(name)) parts.push(`tool \`${name}\` removed`);
  for (const name of nextTools)
    if (!prevTools.has(name)) parts.push(`tool \`${name}\` added`);

  if (previous.model !== next.model && next.model !== undefined)
    parts.push(`model → ${next.model}`);
  if (previous.name !== next.name && next.name !== undefined)
    parts.push(`name → ${next.name}`);
  if (previous.description !== next.description && next.description !== undefined)
    parts.push("description changed");

  return parts.length > 0 ? parts.join(", ") : undefined;
}
