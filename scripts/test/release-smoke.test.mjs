import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { publicCreatorArguments } from "../release/smoke.mjs";
import { parse } from "../../create-agent/dist/arguments.js";
import { createProject } from "../../create-agent/dist/project.js";

test("the publication smoke creates and starts a project without a terminal or provider calls", async () => {
  const args = publicCreatorArguments("0.2.0-beta");
  assert.ok(args.includes("--package=@nylorun/create-agent@0.2.0-beta"));
  const options = parse(args.slice(args.indexOf("--") + 2));
  const commands = [];
  await createProject(
    options,
    { harness: "1.0.0", runtime: "1.0.0", studio: "1.0.0" },
    {
      currentDirectory: () => resolve(".tmp/release-smoke-test"),
      isInteractive: () => false,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => {},
      rename: async () => {},
      remove: async () => {},
      write: async () => {},
      run: async (_command, args) => {
        commands.push(args);
        return { status: 0 };
      },
    },
  );
  assert.deepEqual(commands, [
    ["install", "--yes"],
    ["run", "dev", "--", "--no-open"],
  ]);
});
