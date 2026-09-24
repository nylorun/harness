/**
 * Project link/credential modes and createClient tenant guard.
 * Host layout checks moved with WS-F1 (host/ deleted).
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createClient } from "@nylorun/agents";
import { writeCredentials } from "../../src/project/credentials.js";
import { writeLink } from "../../src/project/link.js";
import { newTenantId } from "@nylorun/agents";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("createClient() without tenant throws before fetch is called", async () => {
  const calls: string[] = [];
  expect(() =>
    createClient({
      url: "http://127.0.0.1:8787",
      key: "application-key-value",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("{}");
      },
    }),
  ).toThrow("Set tenant explicitly or via NYLORUN_TENANT");
  expect(calls).toEqual([]);
});

it("project link/credential modes are 0600/0700", async () => {
  const project = await mkdtemp(join(tmpdir(), "cli-sec-project-"));
  roots.push(project);
  await writeFile(join(project, "package.json"), "{}");
  const tenantId = newTenantId();
  await writeLink(project, {
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuvw",
    tenantId,
  });
  await writeCredentials(project, {
    applicationKey: "ab".repeat(32),
    principalId: "pr_test",
  });
  expect(
    (await stat(join(project, ".nylorun"))).mode & 0o777,
  ).toBe(0o700);
  expect(
    (await stat(join(project, ".nylorun/link.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(
    (await stat(join(project, ".nylorun/credentials.json"))).mode & 0o777,
  ).toBe(0o600);
});
