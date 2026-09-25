import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { logs } from "../../src/launcher/logs.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import type { LauncherEvent } from "../../src/launcher/protocol.js";
import { removeRoot, temporaryRoot } from "./fixtures/roots.js";

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

it("E1-6: logs reads runtime.log with --lines and tenant/all filters", async () => {
  const paths = await home();
  await writeFile(
    paths.log,
    ["h1", "h2", "h3", "h4"].join("\n") + "\n",
  );
  const tenantId = "tn_0123456789abcdefghjkmnpq";
  await mkdir(join(paths.tenants, tenantId, "logs"), { recursive: true });
  await writeFile(
    join(paths.tenants, tenantId, "logs", "tenant.log"),
    ["t1", "t2"].join("\n") + "\n",
  );

  const hostOnly: Array<Extract<LauncherEvent, { type: "log" }>> = [];
  await logs(paths, {
    lines: 2,
    emit: (event) => hostOnly.push(event),
  });
  expect(hostOnly.map((e) => e.line)).toEqual(["h3", "h4"]);
  expect(hostOnly.every((e) => e.source === "host")).toBe(true);

  const tenantOnly: Array<Extract<LauncherEvent, { type: "log" }>> = [];
  await logs(paths, {
    tenant: tenantId,
    emit: (event) => tenantOnly.push(event),
  });
  expect(tenantOnly).toEqual([
    { type: "log", source: "tenant", tenantId, line: "t1" },
    { type: "log", source: "tenant", tenantId, line: "t2" },
  ]);

  const all: Array<Extract<LauncherEvent, { type: "log" }>> = [];
  await logs(paths, {
    all: true,
    emit: (event) => all.push(event),
  });
  expect(all.some((e) => e.source === "host" && e.line === "h1")).toBe(true);
  expect(all.some((e) => e.source === "tenant" && e.line === "t1")).toBe(true);
});

it("E1-6: logs --follow emits new lines until aborted", async () => {
  const paths = await home();
  await writeFile(paths.log, "start\n");
  const lines: string[] = [];
  const controller = new AbortController();
  const done = logs(paths, {
    follow: true,
    lines: 10,
    signal: controller.signal,
    emit: (event) => lines.push(event.line),
  });
  await new Promise((r) => setTimeout(r, 100));
  await writeFile(paths.log, "start\nmore\n");
  await new Promise((r) => setTimeout(r, 700));
  controller.abort();
  await done;
  expect(lines).toContain("start");
  expect(lines).toContain("more");
});
