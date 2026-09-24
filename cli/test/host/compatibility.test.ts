import { afterEach, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import { assertHostCompatible } from "../../src/host/compatibility.js";
import { removeRoot, startStubHost, temporaryRoot } from "./support.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

it("E10: compatible Host protocol passes", async () => {
  const stub = await startStubHost();
  closers.push(stub.close);
  const report = await assertHostCompatible(stub.url);
  expect(report.ok).toBe(true);
  expect(report.protocol.min).toBe(2);
  expect(report.hostId).toBe(stub.hostId);
});

it("E10: out-of-range client prints upgrade/downgrade remedy", async () => {
  const stub = await startStubHost({
    protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
  });
  closers.push(stub.close);
  await expect(
    assertHostCompatible(stub.url, { clientVersion: 1, required: [] }),
  ).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(5);
    expect((error as CliError).message).toMatch(/nylorun runtime restart/);
    return true;
  });
  await expect(
    assertHostCompatible(stub.url, { clientVersion: 99, required: [] }),
  ).rejects.toSatisfy((error: unknown) => {
    expect((error as CliError).message).toMatch(/npm i -D @nylorun\/cli@/);
    return true;
  });
});

it("E10: missing required feature names the feature and remedy", async () => {
  const stub = await startStubHost({
    protocol: { min: 2, max: 2, features: [] },
  });
  closers.push(stub.close);
  await expect(
    assertHostCompatible(stub.url, {
      clientVersion: 2,
      required: ["runtime-tenants"],
    }),
  ).rejects.toSatisfy((error: unknown) => {
    expect((error as CliError).message).toMatch(/runtime-tenants/);
    expect((error as CliError).message).toMatch(/nylorun runtime restart|npm i -D/);
    return true;
  });
});

it("unused temporary root helper stays importable", async () => {
  const root = await temporaryRoot();
  await removeRoot(root);
});
