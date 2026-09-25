import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../../src/errors.js";
import { runtimeCommand } from "../../src/runtime/commands.js";
import { launcher } from "../../src/runtime/launcher.js";
import { installTestRuntime, removeRoot, temporaryRoot } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
  vi.restoreAllMocks();
});

async function homeWithBuild(version = "0.9.0-f1-cmd") {
  const home = await temporaryRoot("nylorun-cli-home-");
  roots.push(home);
  const prefix = await temporaryRoot("nylorun-cli-prefix-");
  roots.push(prefix);
  const { env } = await installTestRuntime(prefix, version);
  return { home, version, env };
}

describe("F1-4 runtime commands", () => {
  it("up starts the Host and prints Tenants-era messages", async () => {
    const { home, env } = await homeWithBuild();
    const handle = await launcher(home, { env });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runtimeCommand(["up", "--port", "0"], {
        home,
        handle,
      });
    } finally {
      console.log = original;
    }
    const joined = logs.join("\n");
    expect(joined).toMatch(/Started the Runtime Host|already running|URL/);
    expect(joined).toContain("→ npx nylorun dev");

    await handle.invoke(["down", "--force"]);
  });

  it("status sets exit code 3 when absent", async () => {
    const { home, env } = await homeWithBuild();
    const handle = await launcher(home, { env });
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await runtimeCommand(["status"], { home, handle });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previous;
    }
  });

  it("down reports when nothing is running", async () => {
    const { home, env } = await homeWithBuild();
    const handle = await launcher(home, { env });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runtimeCommand(["down"], { home, handle });
    } finally {
      console.log = original;
    }
    expect(logs.join("\n")).toContain("No Runtime Host is running.");
  });

  it("maps foreign_port to CliError exit 4", async () => {
    const { home, env } = await homeWithBuild();
    const handle = await launcher(home, { env });
    // Occupy a port with a non-Nylorun listener, then up with that port.
    const { createServer } = await import("node:http");
    const foreign = createServer((_req, res) => {
      res.writeHead(200);
      res.end("x");
    });
    const port = await new Promise<number>((resolve, reject) => {
      foreign.listen(0, "127.0.0.1", () => {
        const address = foreign.address();
        if (!address || typeof address === "string") reject(new Error("bind"));
        else resolve(address.port);
      });
    });
    try {
      await expect(
        runtimeCommand(["up", "--port", String(port)], {
          home,
          handle,
        }),
      ).rejects.toMatchObject({ exitCode: 4 } satisfies Partial<CliError>);
    } finally {
      await new Promise<void>((resolve, reject) =>
        foreign.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it("rejects unknown flags with exit 2", async () => {
    const { home, env } = await homeWithBuild();
    const handle = await launcher(home, { env });
    await expect(
      runtimeCommand(["up", "--nope"], { home, handle }),
    ).rejects.toMatchObject({ exitCode: 2 } satisfies Partial<CliError>);
  });
});
