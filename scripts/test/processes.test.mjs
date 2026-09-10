import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessGroup } from "../lib/processes.mjs";

test("a supervised service becomes ready and releases its port on shutdown", async () => {
  const group = new ProcessGroup({ log: () => {} });
  const child = group.start("fixture", process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => res.end('ready'));
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
    process.on('SIGTERM', () => server.close());
  `,
  ]);
  try {
    const line = await child.line((line) => line.startsWith("{"));
    const url = `http://127.0.0.1:${JSON.parse(line).port}`;
    await child.ready(url);
    assert.equal(await (await fetch(url)).text(), "ready");
    await group.close();
    await assert.rejects(fetch(url));
  } finally {
    await group.close();
  }
});
