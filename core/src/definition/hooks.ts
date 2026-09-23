import type {
  AfterHooks,
  BeforeHooks,
  HookAt,
  HookManifest,
  HookScope,
} from "../types/dynamics.js";
import type { Implementations } from "./implementations.js";

/** Every hook point, in the order the loop reaches them and the manifest lists them. */
export const HOOK_POINTS: readonly HookManifest[] = Object.freeze([
  Object.freeze({ at: "before", scope: "turn" }),
  Object.freeze({ at: "before", scope: "step" }),
  Object.freeze({ at: "after", scope: "step" }),
  Object.freeze({ at: "after", scope: "turn" }),
] as const);

const pointIndex = (point: HookManifest): number =>
  HOOK_POINTS.findIndex(
    (item) => item.at === point.at && item.scope === point.scope
  );

/** Canonical manifest list for a capability's hooks, or undefined when it has none. */
export function hooksFrom(
  before: BeforeHooks<any> | undefined,
  after: AfterHooks<any> | undefined
): readonly HookManifest[] | undefined {
  const hooks = HOOK_POINTS.filter((point) =>
    typeof (point.at === "before" ? before : after)?.[point.scope] ===
    "function"
  );
  return hooks.length ? Object.freeze(hooks) : undefined;
}

export function hasHook(
  hooks: readonly HookManifest[] | undefined,
  at: HookAt,
  scope: HookScope
): boolean {
  return hooks?.some((hook) => hook.at === at && hook.scope === scope) ?? false;
}

/** Why a manifest `hooks` value is invalid, or undefined when it is valid. */
export function hookListIssue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "hooks must be an array";
  if (value.length === 0) return "hooks must be omitted when empty";
  let previous = -1;
  for (const item of value) {
    if (
      item === null ||
      typeof item !== "object" ||
      Object.keys(item).some((key) => key !== "at" && key !== "scope")
    )
      return "each hook must be { at, scope }";
    const index = pointIndex(item as HookManifest);
    if (index < 0)
      return `unknown hook point '${String(item.at)} ${String(item.scope)}'`;
    if (index === previous)
      return `duplicate hook '${item.at} ${item.scope}'`;
    if (index < previous)
      return "hooks must be listed as before turn, before step, after step, after turn";
    previous = index;
  }
  return undefined;
}

/**
 * Run one hook point for the listed capabilities, concurrently.
 * Never throws: a missing or failing hook blocks with its message, so a
 * re-delivered hook cannot fail the same way forever.
 */
export async function runHookPoint(
  implementations: Implementations<any>,
  hook: {
    readonly at: HookAt;
    readonly scope: HookScope;
    readonly capabilityIds: readonly string[];
  },
  args: unknown
): Promise<Readonly<Record<string, unknown>>> {
  const entries = await Promise.all(
    hook.capabilityIds.map(async (id): Promise<[string, unknown]> => {
      const fn = implementations[id]?.[hook.at]?.[hook.scope] as
        | ((value: unknown) => unknown)
        | undefined;
      if (typeof fn !== "function")
        return [
          id,
          {
            block: `Missing ${hook.at}("${hook.scope}") implementation for capability '${id}'`,
          },
        ];
      try {
        return [id, (await fn(args)) ?? {}];
      } catch (error) {
        return [
          id,
          { block: error instanceof Error ? error.message : String(error) },
        ];
      }
    })
  );
  return Object.freeze(Object.fromEntries(entries));
}
