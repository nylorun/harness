import { summarizeManifestPatch } from "./manifest-diff.ts";
import {
  payloadOf,
  type AgentManifestLike,
  type EventLike,
  type IterationRecord,
} from "./types.ts";

/**
 * Build a per-Loop iteration timeline from `loop.*` events (loops.md §4.6).
 * When decide patched the manifest, attach a diff vs the previous iteration.
 */
export function iterationTimelineFromEvents(
  events: readonly EventLike[],
  options: {
    readonly path?: string;
    /** Optional manifests keyed by iteration n (from fixtures / inspect). */
    readonly manifestsByIteration?: ReadonlyMap<number, AgentManifestLike>;
  } = {},
): readonly IterationRecord[] {
  const byKey = new Map<string, IterationRecord>();
  const keyOf = (path: string, n: number) => `${path}#${n}`;

  for (const event of events) {
    if (!event.type.startsWith("loop.")) continue;
    const payload = payloadOf(event);
    const path = typeof payload.path === "string" ? payload.path : undefined;
    const n = Number(payload.n);
    if (!path || !Number.isFinite(n)) continue;
    if (options.path !== undefined && path !== options.path) continue;
    const key = keyOf(path, n);
    const prior = byKey.get(key) ?? { n, path };
    switch (event.type) {
      case "loop.iteration":
        byKey.set(key, {
          ...prior,
          ...(typeof payload.sessionId === "string"
            ? { sessionId: payload.sessionId }
            : {}),
          ...(typeof payload.turnId === "string"
            ? { turnId: payload.turnId }
            : {}),
          ...(typeof payload.manifestHash === "string"
            ? { manifestHash: payload.manifestHash }
            : {}),
        });
        break;
      case "loop.waiting":
        byKey.set(key, {
          ...prior,
          waiting: true,
          ...(typeof payload.sessionId === "string"
            ? { sessionId: payload.sessionId }
            : {}),
        });
        break;
      case "loop.verified":
        byKey.set(key, {
          ...prior,
          pass: payload.pass === true,
          ...(typeof payload.feedback === "string"
            ? { feedback: payload.feedback }
            : {}),
        });
        break;
      case "loop.decided": {
        const patched = payload.patched === true;
        let patchSummary: string | undefined;
        if (patched && options.manifestsByIteration) {
          const previous = options.manifestsByIteration.get(n);
          const next = options.manifestsByIteration.get(n + 1);
          // Decide at iteration n patches the manifest used for n+1.
          patchSummary = summarizeManifestPatch(previous, next);
          if (!patchSummary && previous && !next)
            patchSummary = "manifest patched";
        } else if (patched) {
          patchSummary = "manifest patched";
        }
        byKey.set(key, {
          ...prior,
          decided: payload.next === "output" ? "output" : "input",
          patched,
          ...(patchSummary ? { patchSummary } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.path === b.path ? a.n - b.n : a.path.localeCompare(b.path),
  );
}

/** Group timeline rows by Loop path. */
export function groupIterationsByPath(
  rows: readonly IterationRecord[],
): ReadonlyMap<string, readonly IterationRecord[]> {
  const groups = new Map<string, IterationRecord[]>();
  for (const row of rows) {
    const list = groups.get(row.path) ?? [];
    list.push(row);
    groups.set(row.path, list);
  }
  return groups;
}
