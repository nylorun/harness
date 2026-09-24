/**
 * Legacy watcher entry. `nylorun dev` now runs the Project entry with
 * `tsx watch` directly (D§12).
 */
export function legacyDevEntryRemoved(): never {
  throw new Error(
    "cli/src/dev-entry.ts is no longer used. Point nylorun dev at your Project entry (default src/main.ts).",
  );
}
