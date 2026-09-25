import {
  joinPath,
  nodeKeyOf,
  type WorkflowManifest,
  type WorkflowNode,
  type WorkflowTreeNode,
} from "./types.ts";

function leaf(
  path: string,
  kind: WorkflowTreeNode["kind"],
  label: string,
  extra: Partial<WorkflowTreeNode> = {},
): WorkflowTreeNode {
  return {
    path,
    key: nodeKeyOf(path),
    kind,
    layout: "leaf",
    label,
    children: [],
    ...extra,
  };
}

function partId(node: WorkflowNode): string | undefined {
  if ("agent" in node) return node.agent;
  if ("tool" in node) return node.tool.name;
  if ("chain" in node) return node.chain.id;
  if ("switch" in node) return node.switch.id;
  if ("parallel" in node) return node.parallel.id;
  if ("map" in node) return node.map.id;
  if ("loop" in node) return node.loop.id;
  if ("slot" in node) return node.slot.id ?? partId(node.slot.run);
  return undefined;
}

function walk(
  node: WorkflowNode,
  parentPath: string,
  partOverride?: string,
): WorkflowTreeNode {
  if ("slot" in node) {
    // Slot id renames the child path part (workflows.md §4 / §6).
    return walk(node.slot.run, parentPath, node.slot.id ?? partOverride);
  }
  if ("agent" in node) {
    const part = partOverride ?? node.agent;
    const path = joinPath(parentPath, part);
    return leaf(path, "agent", part, { agentId: node.agent });
  }
  if ("tool" in node) {
    const part = partOverride ?? node.tool.name;
    const path = joinPath(parentPath, part);
    return leaf(path, "tool", part);
  }
  if ("chain" in node) {
    const part = partOverride ?? node.chain.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "chain",
      layout: "row",
      label: part,
      children: node.chain.steps.map((step) => walk(step, path)),
    };
  }
  if ("switch" in node) {
    const part = partOverride ?? node.switch.id;
    const path = joinPath(parentPath, part);
    const cases = Object.entries(node.switch.cases).map(([name, child]) => {
      const casePath = joinPath(path, name);
      return {
        path: casePath,
        key: nodeKeyOf(casePath),
        kind: "case" as const,
        layout: "leaf" as const,
        label: name,
        children: [walk(child, casePath)],
      };
    });
    if (node.switch.default) {
      const casePath = joinPath(path, "default");
      cases.push({
        path: casePath,
        key: nodeKeyOf(casePath),
        kind: "case",
        layout: "leaf",
        label: "default",
        children: [walk(node.switch.default, casePath)],
      });
    }
    return {
      path,
      key: nodeKeyOf(path),
      kind: "switch",
      layout: "fork",
      label: part,
      children: cases,
    };
  }
  if ("parallel" in node) {
    const part = partOverride ?? node.parallel.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "parallel",
      layout: "lanes",
      label: part,
      children: Object.entries(node.parallel.branches).map(([name, child]) => {
        const branchPath = joinPath(path, name);
        return {
          path: branchPath,
          key: nodeKeyOf(branchPath),
          kind: "branch" as const,
          layout: "leaf" as const,
          label: name,
          children: [walk(child, branchPath)],
        };
      }),
    };
  }
  if ("map" in node) {
    const part = partOverride ?? node.map.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "map",
      layout: "map",
      label: part,
      children: [walk(node.map.each, path)],
    };
  }
  if ("loop" in node) {
    const part = partOverride ?? node.loop.id;
    const path = joinPath(parentPath, part);
    const run = walk(node.loop.run, path);
    const verify =
      "fn" in node.loop.verify
        ? leaf(path, "fn", "verify")
        : walk(node.loop.verify, path);
    const decide = leaf(joinPath(path, "decide"), "fn", "decide");
    return {
      path,
      key: nodeKeyOf(path),
      kind: "loop",
      layout: "loop",
      label: part,
      children: [run, verify, decide],
    };
  }
  throw new Error("Unknown workflow node");
}

/**
 * Build a drawable tree from a workflow manifest (workflows.md §11).
 * Chain → row, Switch → fork, Parallel → lanes, Map → one lane, Loop → iteration badge host.
 */
export function treeFromManifest(manifest: WorkflowManifest): WorkflowTreeNode {
  return walk(manifest.root, "");
}

/** Expand a Map node into indexed item lanes for drill-down. */
export function expandMapItems(
  mapNode: WorkflowTreeNode,
  count: number,
): readonly WorkflowTreeNode[] {
  if (mapNode.kind !== "map" || count < 0) return mapNode.children;
  const template = mapNode.children[0];
  if (!template) return [];
  const items: WorkflowTreeNode[] = [];
  for (let i = 0; i < count; i++) {
    const itemPath = `${mapNode.path}[${i}]`;
    items.push({
      path: itemPath,
      key: nodeKeyOf(itemPath),
      kind: "item",
      layout: "leaf",
      label: `[${i}]`,
      children: [rebasePath(template, mapNode.path, itemPath)],
    });
  }
  return items;
}

function rebasePath(
  node: WorkflowTreeNode,
  from: string,
  to: string,
): WorkflowTreeNode {
  const path =
    node.path === from
      ? to
      : node.path.startsWith(from + "/") || node.path.startsWith(from + "[")
        ? to + node.path.slice(from.length)
        : joinPath(to, node.label);
  return {
    ...node,
    path,
    key: nodeKeyOf(path),
    children: node.children.map((child) => rebasePath(child, from, to)),
  };
}

export { partId };
