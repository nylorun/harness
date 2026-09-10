import assert from "node:assert/strict";
import { test } from "node:test";
import { registry } from "../release/registry.mjs";

test("publication waits through npm processing lasting longer than twenty seconds", async () => {
  let lookups = 0;
  let elapsed = 0;
  const published = { integrity: "sha512-reviewed-artifact" };
  const result = await registry.waitFor.call({
    lookup: async () => ++lookups < 16 ? undefined : published,
  }, "runtime", "0.1.1-beta", { sleep: async (ms) => { elapsed += ms; } });
  assert.deepEqual(result, published);
  assert.equal(lookups, 16);
  assert.equal(elapsed, 75000);
});

test("publication visibility polling remains bounded when npm never exposes a version", async () => {
  let lookups = 0;
  let elapsed = 0;
  await assert.rejects(registry.waitFor.call({
    lookup: async () => { lookups++; return undefined; },
  }, "runtime", "0.1.1-beta", { sleep: async (ms) => { elapsed += ms; } }),
  /Registry has not exposed runtime@0.1.1-beta/);
  assert.equal(lookups, 120);
  assert.equal(elapsed, 600000);
});
