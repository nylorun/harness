/**
 * WS-J desktop contract tests (J1–J4). J5 CI matrix is WS-G Wave 3.
 *
 * Verification:
 *   node --test scripts/test/desktop-contract.test.mjs
 *   node scripts/smoke-desktop-contract.mjs
 */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../lib/repo.mjs";
import {
  runDesktopContractSmoke,
  runIncompatibleHostCase,
} from "../smoke-desktop-contract.mjs";

test("J3: incompatible_host from Admin /health mismatch", async () => {
  await runIncompatibleHostCase();
});

test("J1–J4: desktop contract smoke (installed Runtime, up, tenant, agents, failures, Origin)", async (t) => {
  try {
    await access(join(root, "runtime/dist/host/main.js"));
    await access(join(root, "admin/dist/index.js"));
    await access(join(root, "agents/dist/index.js"));
  } catch (error) {
    // In CI a missing build is a broken job, not a reason to pass silently.
    if (process.env.CI) throw error;
    t.skip("workspace dist missing; run npm run build first");
    return;
  }

  const result = await runDesktopContractSmoke({
    log: (line) => {
      // Keep CI logs useful without drowning the runner.
      if (typeof line === "string" && /^(J[1-4]|Desktop|Using|NYLORUN_)/.test(line)) {
        console.log(line);
      }
    },
  });
  assert.equal(typeof result.version, "string");
});
