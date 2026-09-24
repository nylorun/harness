/**
 * // CLIENTS-CCR: owned by WS-F1 — `nylorun dev --ephemeral` (D§12).
 * F2's develop() delegates here when `--ephemeral` is set.
 */
import { CliError } from "../errors.js";

export async function runEphemeralDev(_options: {
  entry: string;
  projectRoot: string;
}): Promise<number> {
  throw new CliError(
    // CLIENTS-CCR: awaiting WS-F1 cli/src/runtime/ephemeral.ts
    "nylorun dev --ephemeral is not available yet (awaiting WS-F1).",
    1,
  );
}
