import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";

/** Validate the actual tarball without reaching the registry or running install scripts. */
export function checkPackedConsumer(cache) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args, cwd) =>
    execFileSync(npm, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
      shell: process.platform === "win32",
    });
  const pack = (cwd) =>
    join(
      cache,
      JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", cache], cwd))[0]
        .filename,
    );
  const harness = pack(process.cwd());
  const require = createRequire(import.meta.url);
  const zod = pack(dirname(require.resolve("zod/package.json")));
  const consumer = join(cache, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "interface-consumer", private: true, type: "module" }),
  );
  run(
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", harness, zod],
    consumer,
  );
  const usage = readFileSync("test/types/usage.ts", "utf8").replaceAll(
    "../../src/index.js",
    "@nylorun/harness",
  );
  const file = join(consumer, "usage.ts");
  writeFileSync(
    file,
    usage +
      '\n// @ts-expect-error Compiled definition pieces are not exported.\nimport type { AgentDefinition } from "@nylorun/harness/definition/agent-definition.js";\n',
  );
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => consumer,
        getCanonicalFileName: (path) => path,
        getNewLine: () => "\n",
      }),
    );
  writeFileSync(
    join(consumer, "check.mjs"),
    `
    import assert from 'node:assert/strict';
    import * as api from '@nylorun/harness';
    import { z } from 'zod';
    assert.equal('BuiltAgent' in api, false);
    const agent = api.Agent({ id: 'packed', name: 'Packed', outputSchema: z.object({ count: z.number() }) }).build();
    assert.deepEqual(Object.keys(agent).sort(), ['hash', 'id', 'manifest', 'name', 'run', 'toJSON']);
    assert.equal(typeof agent.hash, 'string');
    assert.equal(agent.toJSON().schemaVersion, 2);
    const state = api.createExecutionState(agent);
    const result = await agent.run({ state, input: 'go', onModelCall: async () => ({ output: [{type: 'json', value: {count: 1}}] }) });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, {count: 1});
    assert.throws(() => api.createExecutionState({...agent}), /original agent/);
    await assert.rejects(import('@nylorun/harness/definition/agent-definition.js'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    const engine = await import('@nylorun/harness/engine');
    assert.equal(typeof engine.run, 'function');
  `,
  );
  execFileSync(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer, stdio: "pipe" });
  console.log("Packed consumer runtime and declaration checks passed.");
}
