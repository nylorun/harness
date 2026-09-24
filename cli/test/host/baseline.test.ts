import { expect, it } from "vitest";
import { baselineEnv } from "../../src/host/baseline.js";

it("E1: baseline captures process.env at module load into a frozen map", () => {
  const env = baselineEnv();
  expect(Object.isFrozen(env)).toBe(true);
  expect(env.PATH).toBe(process.env.PATH);
  // Mutation of process.env after load must not appear in the snapshot.
  const marker = `NYLORUN_BASELINE_TEST_${Date.now()}`;
  process.env[marker] = "1";
  expect(env[marker]).toBeUndefined();
  delete process.env[marker];
});
