import { afterEach, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import { ensureHostConfig, hostPaths } from "../../src/host/root.js";
import {
  removeRoot,
  startForeignListener,
  temporaryRoot,
} from "./support.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await Promise.all(roots.splice(0).map(removeRoot));
});

it("E2/port: foreign process on explicit port fails with exit 4", async () => {
  const foreign = await startForeignListener();
  closers.push(foreign.close);
  const root = await temporaryRoot();
  roots.push(root);
  await expect(
    ensureHostConfig(hostPaths(root), { port: foreign.port }),
  ).rejects.toMatchObject({ exitCode: 4 } satisfies Partial<CliError>);
});
