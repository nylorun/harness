/**
 * // CLIENTS-CCR: owned by WS-F1 — `startEphemeral` (D§12 ephemeral Host).
 */
import { CliError } from "../errors.js";

export interface EphemeralRuntime {
  home: string;
  url: string;
  hostId: string;
  version: string;
  tenant: { id: string; name: string };
  applicationKey: string;
  close(): Promise<void>;
}

export async function startEphemeral(_options?: {
  home?: string;
  name?: string;
}): Promise<EphemeralRuntime> {
  throw new CliError(
    // CLIENTS-CCR: awaiting WS-F1 cli/src/runtime/ephemeral.ts
    "nylorun dev --ephemeral is not available yet (awaiting WS-F1).",
    1,
  );
}

/** @deprecated Prefer startEphemeral; kept for early F2 drafts. */
export async function runEphemeralDev(_options: {
  entry: string;
  projectRoot: string;
}): Promise<number> {
  await startEphemeral();
  return 1;
}
