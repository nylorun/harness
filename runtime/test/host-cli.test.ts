import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

it.each([
  ["::1", "[::1]"],
  ["[::1]", "[::1]"],
  ["0.0.0.0", "127.0.0.1"],
  ["::", "127.0.0.1"],
  ["[::]", "127.0.0.1"],
])(
  "--host %s prints a reachable %s URL",
  async (host, advertised) => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, host.replace(/^\[(.*)\]$/u, "$1"), resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve()))
    );

    const root = await mkdtemp(join(tmpdir(), "host-cli-"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/nylorun.config.js"),
      "export default { agents: [] };\n"
    );
    const child = spawn(
      process.execPath,
      [cli, "start", "--host", host, "--port", String(port)],
      {
        cwd: root,
        env: { ...process.env, ALLOWED_HOSTS: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    let output = "";
    let exited = false;
    child.once("close", () => {
      exited = true;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => reject(new Error(output)));
        child.stdout.on("data", () => {
          if (output.includes("Agent runtime on")) resolve();
        });
      });
      const url = `http://${advertised}:${port}`;
      expect(output).toContain(`Agent runtime on ${url}`);
      const response = await fetch(`${url}/v1/agents`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ agents: [] });
    } finally {
      if (!exited) child.kill("SIGTERM");
      await closed;
      clearTimeout(timeout);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);
