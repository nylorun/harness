import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  develop,
  developmentOptions,
  availablePort,
} from "../lib/development.mjs";
import { writeJson } from "../lib/repo.mjs";

test(
  "package edits rebuild and restart; a compiler error retains the working service and recovers",
  { timeout: 60_000 },
  async () => {
    const repo = await mkdtemp(join(tmpdir(), "nylorun-dev-test-"));
    const logs = [];
    let app;
    try {
      await mkdir(join(repo, "examples"));
      await writeJson(join(repo, "examples", "package.json"), {
        type: "module",
        scripts: { dev: "node ../runtime/src/main.js" },
      });
      for (const name of ["harness", "runtime"]) {
        await mkdir(join(repo, name, "src"), { recursive: true });
        await writeJson(join(repo, name, "package.json"), {
          type: "module",
          scripts: {
            typecheck: "node --check src/main.js",
            build: "node build.mjs",
          },
        });
        await writeFile(
          join(repo, name, "build.mjs"),
          `import { mkdir, copyFile } from 'node:fs/promises'; await mkdir('dist', {recursive:true}); await copyFile('src/main.js', 'dist/${
            name === "runtime" ? "cli" : "main"
          }.js');`
        );
      }
      const source = join(repo, "harness/src/main.js");
      await writeFile(source, 'export const name = "before";');
      await writeFile(
        join(repo, "runtime/src/main.js"),
        `
      import { name } from '../../harness/dist/main.js';
      import { createServer } from 'node:http';
      const port = Number(process.env.PORT);
      const server = createServer((req, res) => res.end(name));
      server.listen(port, '127.0.0.1');
      process.on('SIGTERM', () => server.close());
    `
      );
      const port = await availablePort();
      const url = `http://127.0.0.1:${port}/v1/agents`;
      app = await develop(
        { studio: false, open: false, port },
        {
          repo,
          project: join(repo, "examples"),
          log: (line) => logs.push(line),
        }
      );
      assert.equal(await (await fetch(url)).text(), "before");
      const until = async (check) => {
        for (let i = 0; i < 150; i++) {
          if (await check().catch(() => false)) return;
          await delay(100);
        }
        assert.fail(logs.join("\n"));
      };
      await writeFile(source, 'export const name = "after";');
      await until(async () => (await (await fetch(url)).text()) === "after");
      await writeFile(source, "export const name = ;");
      await until(async () =>
        logs.some((line) => line.includes("running application was retained"))
      );
      assert.equal(await (await fetch(url)).text(), "after");
      await writeFile(source, 'export const name = "recovered";');
      await until(
        async () => (await (await fetch(url)).text()) === "recovered"
      );
      const runtimeSource = join(repo, "runtime/src/main.js");
      await writeFile(
        runtimeSource,
        (
          await readFile(runtimeSource, "utf8")
        ).replace("res.end(name)", "res.end('runtime-updated')")
      );
      await until(
        async () => (await (await fetch(url)).text()) === "runtime-updated"
      );
      await assert.rejects(availablePort(port), /unavailable/);
      await app.close();
      await availablePort(port);
      const controller = new AbortController();
      await assert.rejects(
        develop(
          { studio: false, open: false, port },
          {
            repo,
            project: join(repo, "examples"),
            signal: controller.signal,
            log: (line) => {
              if (line.startsWith("[dev] Runtime http")) controller.abort();
            },
          }
        ),
        /Development stopped/
      );
      await availablePort(port);
    } finally {
      await app?.close();
      await rm(repo, { recursive: true, force: true });
    }
  }
);

test("headless and custom-port options reject ambiguous or invalid ports", () => {
  assert.deepEqual(
    developmentOptions(["--no-studio", "--no-open", "--port", "4200"]),
    { studio: false, open: false, port: 4200, studioPort: 4161 }
  );
  assert.throws(
    () => developmentOptions(["--port", "4161"]),
    /different ports/
  );
  assert.throws(() => developmentOptions(["--port", "0"]), /Invalid port/);
  assert.throws(
    () => developmentOptions(["--port", "--no-open"]),
    /Invalid port/
  );
});
