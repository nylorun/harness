import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ensureProjectNylorunDir,
  readLink,
  writeLink,
  removeLink,
} from "../../src/project/link.js";
import {
  readCredentials,
  writeCredentials,
} from "../../src/project/credentials.js";
import { newTenantId } from "@nylorun/agents";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-link-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"demo"}');
  return root;
}

it("F1: creates .nylorun 0700 with private .gitignore containing *", async () => {
  const root = await fixture();
  const dir = await ensureProjectNylorunDir(root);
  expect(dir).toBe(join(root, ".nylorun"));
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  // Project .gitignore is never edited.
  await expect(readFile(join(root, ".gitignore"))).rejects.toThrow();
});

it("F1: writes link.json and credentials.json mode 0600", async () => {
  const root = await fixture();
  const tenantId = newTenantId();
  await writeLink(root, {
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuv",
    tenantId,
  });
  await writeCredentials(root, {
    applicationKey: "a".repeat(64),
    principalId: "principal_test",
    executors: { agent: "b".repeat(64) },
  });
  expect((await stat(join(root, ".nylorun/link.json"))).mode & 0o777).toBe(
    0o600,
  );
  expect(
    (await stat(join(root, ".nylorun/credentials.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(await readLink(root)).toEqual({
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuv",
    tenantId,
  });
  expect(await readCredentials(root)).toEqual({
    applicationKey: "a".repeat(64),
    principalId: "principal_test",
    executors: { agent: "b".repeat(64) },
  });
  await removeLink(root);
  expect(await readLink(root)).toBeUndefined();
});
