import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../release/runtime-builds.mjs";

test("runtime-builds parseArgs requires exactly one of --local or --release", () => {
  assert.deepEqual(parseArgs(["node", "runtime-builds.mjs", "--local"]), {
    local: true,
    release: false,
    out: undefined,
  });
  assert.deepEqual(
    parseArgs(["node", "runtime-builds.mjs", "--release", "--out", "/tmp/x"]),
    { local: false, release: true, out: "/tmp/x" },
  );
  assert.throws(
    () => parseArgs(["node", "runtime-builds.mjs"]),
    /--local\|--release/,
  );
  assert.throws(
    () => parseArgs(["node", "runtime-builds.mjs", "--local", "--release"]),
    /--local\|--release/,
  );
});
