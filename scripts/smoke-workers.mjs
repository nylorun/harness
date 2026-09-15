import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./lib/repo.mjs";
import { ProcessGroup } from "./lib/processes.mjs";
import { availablePort } from "./lib/development.mjs";

await mkdir(join(root, ".tmp"), { recursive: true });
const directory = await mkdtemp(join(root, ".tmp/workers-smoke-"));
const group = new ProcessGroup();
let calls = 0;
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(request.headers.authorization, "Bearer fixture-key");
  assert.equal(body.model, "fixture-model");
  calls++;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: body.messages.some((item) => item.role === "tool")
            ? { content: "worker completed" }
            : {
                tool_calls: [
                  {
                    id: "tool",
                    type: "function",
                    function: {
                      name: "echo",
                      arguments: '{"text":"bound environment"}',
                    },
                  },
                ],
              },
        },
      ],
    }),
  );
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
try {
  const providerPort = provider.address().port;
  const port = await availablePort();
  await writeFile(
    join(directory, "index.ts"),
    `
    import {Hono} from 'hono';
    import {z} from 'zod';
    import {Agent, defineToolFamily} from '../../harness/dist/index.js';
    import {Runtime, serveAgents} from '../../runtime/dist/index.js';
    const family = defineToolFamily({id:'echo',version:'1',bindingSchema:z.object({resource:z.string()}),describe:()=>({name:'echo',inputSchema:z.object({text:z.string()})}),execute:async(args,{binding,scope})=>({kind:'completed',output:{text:args.text,resource:binding.resource,scope:scope.sessionId}})});
    const agent=Agent({id:'worker',name:'Worker'}).use({id:'tools',toolFamilies:[family],middleware:async(request,next)=>{request.configuration.tools.set('echo',[family.bind({resource:'original'})]);return next();}}).build();
    const app=new Hono(); app.route('/agents',serveAgents({agents:[agent],runtime:new Runtime()}));
    export default app;
  `,
  );
  await writeFile(
    join(directory, "wrangler.json"),
    JSON.stringify({
      name: "nylorun-portability-smoke",
      main: "index.ts",
      compatibility_date: "2026-09-14",
      vars: {
        MODEL_PROVIDER: "custom",
        MODEL: "fixture-model",
        MODEL_PROVIDER_API_KEY: "fixture-key",
        MODEL_PROVIDER_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      },
    }),
  );
  const child = group.start(
    "workers",
    process.execPath,
    [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--config",
      join(directory, "wrangler.json"),
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    },
  );
  const url = `http://127.0.0.1:${port}/agents`;
  await child.ready(`${url}/v1/agents`);
  const response = await fetch(`${url}/worker/v1/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "smoke",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const events = await response.text();
  assert.equal(response.status, 200);
  assert.match(events, /worker completed/);
  assert.match(events, /RUN_FINISHED/);
  assert.equal(calls, 2);
  const state = await (await fetch(`${url}/worker/v1/sessions/smoke`)).json();
  assert.equal(state.state, "completed");
  console.log(
    "Workers local smoke passed: portable imports without nodejs_compat, environment bindings, HTTP model calls, family dispatch, streamed events, and stored history. No deployed support claim is implied.",
  );
} finally {
  await group.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
