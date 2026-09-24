import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { sandboxBanner } from "../src/doctor.js";

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function runtime(report: unknown): Promise<string> {
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer key");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(report));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

const manifest = (sandbox?: Record<string, unknown>) =>
  ({
    manifestSchemaVersion: 4,
    id: "analyst",
    capabilities: [{ id: "sandbox", type: "agent", ...(sandbox ? { sandbox } : {}) }],
  }) as never;

const probes = [
  { name: "microsandbox", isolation: "vm", available: true, reason: "hardware-isolated microVM" },
  { name: "virtual", isolation: "process", available: true, reason: "emulated" },
];

it("says nothing when no agent declares a sandbox", async () => {
  expect(
    await sandboxBanner("http://127.0.0.1:9", "key", [manifest()], "tn_test"),
  ).toBeUndefined();
});

it("names the backend, image and network", async () => {
  const url = await runtime({
    preference: "auto",
    backend: "microsandbox",
    isolation: "vm",
    reason: "hardware-isolated microVM",
    probes,
    defaultImage: "python:3.13-slim",
  });
  expect(await sandboxBanner(url, "key", [manifest({})], "tn_test")).toBe(
    "sandbox: microsandbox VM · image python:3.13-slim · network: dev",
  );
});

it("names the reason and the fix after a fallback", async () => {
  const url = await runtime({
    preference: "auto",
    backend: "virtual",
    isolation: "process",
    reason: "microsandbox unavailable: no usable /dev/kvm",
    probes: [{ ...probes[0], available: false }, probes[1]],
  });
  expect(
    await sandboxBanner(
      url,
      "key",
      [manifest({ network: { preset: "none" } })],
      "tn_test",
    ),
  ).toBe(
    "sandbox: virtual shell (microsandbox unavailable: no usable /dev/kvm) · run `npx nylorun doctor sandbox` for options",
  );
});
