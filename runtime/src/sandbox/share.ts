/**
 * Shared workflow sandbox: one sandbox per owning session, attached via
 * PutSession.sandbox = { session }. Specs must match; keys use the owner id.
 */
import {
  canonical,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";

export type SessionSandboxRef = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly manifest: AgentManifest | WorkflowManifest | Record<string, unknown>;
  /** Session whose id keys the sandbox. Absent means this session owns its own. */
  readonly sandboxOwnerId?: string | null;
};

/** Sandbox spec declared on an agent capability or a workflow manifest. */
export function sandboxSpecOf(
  manifest: AgentManifest | WorkflowManifest | Record<string, unknown> | undefined
): SandboxManifest | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  if ((manifest as { kind?: unknown }).kind === "workflow")
    return (manifest as WorkflowManifest).sandbox;
  const capabilities = (manifest as AgentManifest).capabilities;
  if (!Array.isArray(capabilities)) return undefined;
  for (const capability of capabilities)
    if (capability.sandbox) return capability.sandbox;
  return undefined;
}

export function sandboxSpecsEqual(
  a: SandboxManifest | undefined,
  b: SandboxManifest | undefined
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return canonical(a) === canonical(b);
}

/** Synthetic capability so SandboxManager.run can use a workflow (or shared) spec. */
export function capabilityForSandbox(sandbox: SandboxManifest): CapabilityManifest {
  return {
    id: "sandbox",
    type: "agent",
    sandbox,
    tools: [],
  };
}

/**
 * Resolve the session id that keys the sandbox. Walks one hop via sandboxOwnerId;
 * cycles fall back to the starting session.
 */
export function owningSandboxSessionId(
  session: SessionSandboxRef,
  lookup: (id: string) => SessionSandboxRef | undefined
): string {
  const seen = new Set<string>();
  let current: SessionSandboxRef | undefined = session;
  while (current) {
    if (seen.has(current.id)) return session.id;
    seen.add(current.id);
    const ownerId = current.sandboxOwnerId;
    if (!ownerId || ownerId === current.id) return current.id;
    current = lookup(ownerId);
  }
  return session.id;
}

export function sessionHasSandbox(
  session: SessionSandboxRef,
  lookup: (id: string) => SessionSandboxRef | undefined
): boolean {
  const ownerId = owningSandboxSessionId(session, lookup);
  const owner = ownerId === session.id ? session : lookup(ownerId) ?? session;
  return sandboxSpecOf(owner.manifest) !== undefined || sandboxSpecOf(session.manifest) !== undefined;
}
