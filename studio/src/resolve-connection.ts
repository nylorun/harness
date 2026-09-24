/** Re-export agents connection resolution (I1 — CLIENTS-CCR shim removed). */
export {
  resolveConnection,
  ConnectionError as ConnectionMissingError,
  type ResolvedConnection,
} from "@nylorun/agents";
