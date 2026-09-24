import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LauncherError } from "../../src/launcher/errors.js";
import {
  INSTALL_LOCK_WAIT_MS,
  LIFECYCLE_LOCK_WAIT_MS,
  recoverStaleLock,
  withProcessLock,
  writeProcessLockForTest,
} from "../../src/launcher/locks.js";
import {
  ensureHostLayout,
  hostPaths,
  installLockPath,
} from "../../src/launcher/paths.js";
import { removeRoot, temporaryRoot } from "./fixtures/registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function home() {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  return paths;
}

it("E1-3: install lock recovers stale PID and times out on a live holder", async () => {
  const paths = await home();
  const lock = installLockPath(paths, "0.9.0-beta");
  writeProcessLockForTest(lock, { pid: 999_999_999, startTime: "0" });
  recoverStaleLock(lock);

  let entered = false;
  await withProcessLock(lock, INSTALL_LOCK_WAIT_MS, async () => {
    entered = true;
  });
  expect(entered).toBe(true);

  // Hold with this process, then a waiter must time out.
  await withProcessLock(lock, 10_000, async () => {
    await expect(
      withProcessLock(lock, 150, async () => "nope", { pollMs: 20 }),
    ).rejects.toMatchObject({ code: "lock_timeout" } satisfies Partial<LauncherError>);
  });
});

it("E1-3: lifecycle lock uses .lifecycle.lock with 60s default wait", async () => {
  const paths = await home();
  expect(paths.lifecycleLock).toBe(join(paths.root, ".lifecycle.lock"));
  expect(LIFECYCLE_LOCK_WAIT_MS).toBe(60_000);

  let held = false;
  await withProcessLock(paths.lifecycleLock, LIFECYCLE_LOCK_WAIT_MS, async () => {
    held = true;
  });
  expect(held).toBe(true);
});
