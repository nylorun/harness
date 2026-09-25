import type { JsonValue } from "@nylorun/core/define";
import type { WorkflowParallelNode } from "@nylorun/core";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowContext } from "./context.js";
import { failureOf, markFailFastCancels } from "./context.js";
import { FlowNodeError } from "./types.js";
import { joinPath } from "./paths.js";
import { runNode } from "./node.js";

/**
 * Parallel: all branches ready at once; output object in declaration order; fail-fast.
 */
export async function runParallel(
  ctx: FlowContext,
  node: WorkflowParallelNode["parallel"],
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  const names = Object.keys(node.branches);
  const outputs: Record<string, JsonValue> = {};
  const suspensions: HostSuspension[] = [];
  const failures: FlowNodeError[] = [];

  await Promise.all(
    names.map(async (name) => {
      const branch = node.branches[name]!;
      const branchPath = joinPath(path, name);
      try {
        outputs[name] = await runNode(ctx, branch, branchPath, input);
      } catch (error) {
        if (error instanceof HostSuspension) {
          suspensions.push(error);
          return;
        }
        failures.push(
          error instanceof FlowNodeError ? error : new FlowNodeError(failureOf(error, branchPath)),
        );
      }
    }),
  );

  if (failures.length > 0) {
    markFailFastCancels(ctx);
    // First failure in declaration order wins when several settle together.
    const ordered = failures.sort((a, b) => {
      const ai = names.findIndex(
        (n) => (a.failure.path ?? "").includes(`/${n}`) || a.failure.path?.endsWith(n),
      );
      const bi = names.findIndex(
        (n) => (b.failure.path ?? "").includes(`/${n}`) || b.failure.path?.endsWith(n),
      );
      return (ai === -1 ? names.length : ai) - (bi === -1 ? names.length : bi);
    });
    throw ordered[0]!;
  }

  if (suspensions.length > 0) {
    // Re-throw one suspension; pending map already holds every branch effect id.
    throw suspensions[0]!;
  }

  // Declaration order.
  const result: Record<string, JsonValue> = {};
  for (const name of names) result[name] = outputs[name]!;
  return result;
}
