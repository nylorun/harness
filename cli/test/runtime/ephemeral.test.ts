import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startEphemeral } from "../../src/runtime/ephemeral.js";
import { launcher } from "../../src/runtime/launcher.js";
import { installTestRuntime, removeRoot, temporaryRoot } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

describe("F1-5 ephemeral", () => {
  it("runs Host on a temp home, createAdmin({home})+createTenant, cleans up on close", async () => {
    const version = "0.9.0-f1-eph";
    const home = await temporaryRoot("nylorun-cli-eph-");
    const prefix = await temporaryRoot("nylorun-cli-prefix-");
    roots.push(prefix);
    const { env } = await installTestRuntime(prefix, version);

    let createAdminHome: string | undefined;
    const ephemeral = await startEphemeral({
      home,
      env,
      name: "ephemeral-test",
      createAdmin: (options) => {
        createAdminHome = options?.home;
        return {
          url: "http://127.0.0.1:9",
          source: "local-host" as const,
          status: async () => {
            throw new Error("unused");
          },
          listTenants: async () => [],
          getTenant: async () => {
            throw new Error("unused");
          },
          deleteTenant: async () => undefined,
          createTenant: async ({ name }) => {
            const now = new Date().toISOString();
            return {
              tenant: {
                id: "tn_0123456789abcdefghjkmnpq",
                name,
                createdAt: now,
                updatedAt: now,
                schemaVersion: 1,
              },
              applicationKey: "a".repeat(64),
            };
          },
        };
      },
    });

    expect(createAdminHome).toBe(home);
    expect(ephemeral.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ephemeral.tenant.name).toBe("ephemeral-test");
    expect(ephemeral.applicationKey).toHaveLength(64);
    expect(existsSync(home)).toBe(true);

    await ephemeral.close();
    expect(existsSync(home)).toBe(false);
  });

  it("cleans up on AbortSignal (SIGINT path)", async () => {
    const version = "0.9.0-f1-eph-sig";
    const home = await temporaryRoot("nylorun-cli-eph-");
    const prefix = await temporaryRoot("nylorun-cli-prefix-");
    roots.push(prefix);
    const { env } = await installTestRuntime(prefix, version);

    const controller = new AbortController();
    const ephemeral = await startEphemeral({
      home,
      env,
      signal: controller.signal,
      createAdmin: () => ({
        url: "http://127.0.0.1:9",
        source: "local-host" as const,
        status: async () => {
          throw new Error("unused");
        },
        listTenants: async () => [],
        getTenant: async () => {
          throw new Error("unused");
        },
        deleteTenant: async () => undefined,
        createTenant: async ({ name }) => {
          const now = new Date().toISOString();
          return {
            tenant: {
              id: "tn_0123456789abcdefghjkmnpq",
              name,
              createdAt: now,
              updatedAt: now,
              schemaVersion: 1,
            },
            applicationKey: "b".repeat(64),
          };
        },
      }),
    });

    controller.abort();
    // Allow close() scheduled by abort to finish.
    await ephemeral.close();
    expect(existsSync(home)).toBe(false);

    // Ensure no Host left via a fresh install probe (home is gone).
    const probeHome = await temporaryRoot("nylorun-cli-probe-");
    roots.push(probeHome);
    const handle = await launcher(probeHome, { env });
    const status = await handle.invoke(["status"]);
    expect(status.result?.state).toBe("absent");
  });
});
