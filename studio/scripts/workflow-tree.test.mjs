import assert from "node:assert/strict";
import test from "node:test";
import {
  expandMapItems,
  treeFromManifest,
} from "../web/src/workflow/manifest-tree.ts";

/** Design example from workflows.md §18. */
const shipFeature = {
  kind: "workflow",
  workflowSchemaVersion: 1,
  id: "ship-feature",
  root: {
    chain: {
      id: "ship-feature",
      steps: [
        { agent: "planner" },
        {
          map: {
            id: "implement",
            over: { fn: true },
            each: {
              loop: {
                id: "code",
                run: { agent: "coder" },
                verify: { fn: true },
                decide: { fn: true },
              },
            },
          },
        },
        { tool: { name: "open-pr", inputSchema: { type: "array" } } },
      ],
    },
  },
};

test("WF-EV9/WF-C10: treeFromManifest draws Chain as row, Map as map, Loop as loop", () => {
  const tree = treeFromManifest(shipFeature);
  assert.equal(tree.kind, "chain");
  assert.equal(tree.layout, "row");
  assert.equal(tree.path, "ship-feature");
  assert.equal(tree.children.length, 3);
  assert.equal(tree.children[0]?.kind, "agent");
  assert.equal(tree.children[0]?.path, "ship-feature/planner");
  assert.equal(tree.children[0]?.agentId, "planner");
  const map = tree.children[1];
  assert.equal(map?.kind, "map");
  assert.equal(map?.layout, "map");
  assert.equal(map?.path, "ship-feature/implement");
  const loop = map?.children[0];
  assert.equal(loop?.kind, "loop");
  assert.equal(loop?.layout, "loop");
  assert.equal(loop?.path, "ship-feature/implement/code");
  assert.equal(loop?.children[0]?.agentId, "coder");
  assert.equal(tree.children[2]?.kind, "tool");
  assert.equal(tree.children[2]?.path, "ship-feature/open-pr");
});

test("WF-C10: Switch is a fork and Parallel uses lanes", () => {
  const tree = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: "route",
    root: {
      switch: {
        id: "route",
        on: { fn: true },
        cases: {
          bug: { agent: "fixer" },
          feature: {
            parallel: {
              id: "review",
              branches: {
                security: { agent: "sec" },
                style: { agent: "style" },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(tree.layout, "fork");
  assert.equal(tree.children[0]?.kind, "case");
  const parallel = tree.children[1]?.children[0];
  assert.equal(parallel?.layout, "lanes");
  assert.equal(parallel?.children.length, 2);
  assert.equal(parallel?.children[0]?.label, "security");
});

test("WF-C10: Map item drill-down expands indexed lanes", () => {
  const tree = treeFromManifest(shipFeature);
  const map = tree.children[1];
  assert.ok(map);
  const items = expandMapItems(map, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.path, "ship-feature/implement[0]");
  assert.equal(items[0]?.kind, "item");
  assert.equal(
    items[0]?.children[0]?.path,
    "ship-feature/implement[0]/code",
  );
  assert.equal(
    items[1]?.children[0]?.children[0]?.path,
    "ship-feature/implement[1]/code/coder",
  );
});

test("slot id renames the child path part", () => {
  const tree = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: "draft-twice",
    root: {
      chain: {
        id: "draft-twice",
        steps: [
          { slot: { id: "draft", run: { agent: "writer" } } },
          { agent: "critic" },
        ],
      },
    },
  });
  assert.equal(tree.children[0]?.path, "draft-twice/draft");
  assert.equal(tree.children[0]?.agentId, "writer");
});
