/**
 * // CLIENTS-CCR: owned by WS-F1 (moves from cli/src/host/baseline.ts).
 * Snapshot of the process environment at CLI module load.
 */
const snapshot: Readonly<Record<string, string | undefined>> = Object.freeze({
  ...process.env,
});

/** Frozen map captured when this module first loads. */
export function baselineEnv(): Readonly<Record<string, string | undefined>> {
  return snapshot;
}
