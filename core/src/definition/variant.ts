import type {
  AgentManifest,
  SkillManifest,
  ToolManifest,
} from "../types/manifest.js";
import { canonical } from "../utils/canonical.js";

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function toolsByName(
  tools: readonly ToolManifest[] | undefined
): Map<string, ToolManifest> {
  const map = new Map<string, ToolManifest>();
  for (const tool of tools ?? []) map.set(tool.name, tool);
  return map;
}

/** Candidate tools/skills/agents-as-tools may only be removed, never added or changed. */
function removeOnlyTools(
  pinned: readonly ToolManifest[] | undefined,
  candidate: readonly ToolManifest[] | undefined
): boolean {
  const base = toolsByName(pinned);
  for (const tool of candidate ?? []) {
    const prior = base.get(tool.name);
    if (!prior || !same(prior, tool)) return false;
  }
  return true;
}

function removeOnlySkills(
  pinned: Readonly<Record<string, SkillManifest>> | undefined,
  candidate: Readonly<Record<string, SkillManifest>> | undefined
): boolean {
  const base = pinned ?? {};
  for (const [name, skill] of Object.entries(candidate ?? {})) {
    const prior = base[name];
    if (!prior || !same(prior, skill)) return false;
  }
  return true;
}

/**
 * Whether `candidate` is a valid turn-manifest variant of the session's pinned
 * manifest (`loops.md` §3.4). Hooks and setup (MCP, sandbox) are fixed;
 * code-backed tools/skills/agents-as-tools are remove-only; plain data may change.
 */
export function isVariantOf(
  candidate: AgentManifest,
  pinned: AgentManifest
): boolean {
  if (candidate.id !== pinned.id) return false;
  if (candidate.manifestSchemaVersion !== pinned.manifestSchemaVersion)
    return false;
  if (!same(candidate.runtime ?? {}, pinned.runtime ?? {})) return false;

  const pinnedById = new Map(
    pinned.capabilities.map((capability) => [capability.id, capability])
  );
  const candidateById = new Map(
    candidate.capabilities.map((capability) => [capability.id, capability])
  );

  for (const [, prior] of pinnedById) {
    const next = candidateById.get(prior.id);
    if (prior.hooks?.length) {
      // Hooks — and any capability that registers them — must not change or be removed.
      if (!next || !same(next.hooks, prior.hooks)) return false;
    }
    if (prior.mcpServers !== undefined) {
      if (!next || !same(next.mcpServers, prior.mcpServers)) return false;
    }
    if (prior.sandbox !== undefined) {
      if (!next || !same(next.sandbox, prior.sandbox)) return false;
    }
  }

  for (const [id, next] of candidateById) {
    const prior = pinnedById.get(id);
    if (!prior) return false; // cannot add capabilities
    if (next.type !== prior.type) return false;
    if (!removeOnlyTools(prior.tools, next.tools)) return false;
    if (!removeOnlySkills(prior.skills, next.skills)) return false;
    // Free: name, description, metadata, instructions (and model once it exists).
    if (prior.hooks?.length) {
      if (!same(next.hooks, prior.hooks)) return false;
    } else if (next.hooks?.length) {
      return false; // cannot add hooks
    }
    if (!same(next.mcpServers, prior.mcpServers)) return false;
    if (!same(next.sandbox, prior.sandbox)) return false;
  }

  // Dropping a capability is allowed only when it had no hooks / MCP / sandbox
  // (those are enforced above). Tools and skills on a dropped capability are
  // removals, which §3.4 permits.
  return true;
}
