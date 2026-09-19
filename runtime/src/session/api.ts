import type { BuiltAgent } from "@nylorun/harness";
import {
  getDefaultRuntime,
  setDefaultRuntime,
} from "./default.js";
import type { OpenSessionOptions, SessionHandle } from "./handle.js";

export { setDefaultRuntime };
export type { OpenSessionOptions, SessionHandle };

/** Open-or-create a local session with an agent (bound to the default Runtime). */
export function openSession(
  agent: BuiltAgent<any, any>,
  options?: OpenSessionOptions,
): SessionHandle {
  return getDefaultRuntime().openSession(agent, options);
}

export async function listSessions(agentId: string) {
  return getDefaultRuntime().listSessions(agentId);
}

export async function getSession(agentId: string, sessionId: string) {
  return getDefaultRuntime().getSession(agentId, sessionId);
}

export async function deleteSession(agentId: string, sessionId: string) {
  return getDefaultRuntime().deleteSession(agentId, sessionId);
}
