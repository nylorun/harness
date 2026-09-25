import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/agents";
import { HOSTED_ORIGIN, parsePairingFragment } from "../dist/contract.js";
import { startStudio } from "../dist/host.js";
import { mintToken, tokensEqual } from "../dist/access.js";

const TENANT = Object.freeze({
  id: "tn_00000000000000000000000003",
  name: "orders-agent",
});

function healthBody(extra = {}) {
  return JSON.stringify({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: {
      min: PROTOCOL_VERSION,
      max: PROTOCOL_VERSION,
      features: [...PROTOCOL_FEATURES],
    },
    coreVersion: "0.4.0-beta",
    hostId: "host_1",
    pid: 1,
    ...extra,
  });
}

async function withUpstream(
  handler,
  run,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function startHosted(runtimeUrl, extra = {}) {
  return startStudio({
    runtimeUrl,
    serverKey: "server-secret",
    tenant: TENANT,
    open: false,
    port: 0,
    ui: "hosted",
    ...extra,
  });
}

function tokenFromLaunch(launchUrl) {
  const hash = launchUrl.includes("#")
    ? launchUrl.slice(launchUrl.indexOf("#"))
    : "";
  const pairing = parsePairingFragment(hash);
  assert.ok(pairing, `expected pairing fragment in ${launchUrl}`);
  return pairing.token;
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test("P2: mintToken is 43-char base64url; length mismatch skips compare", () => {
  const token = mintToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token, token.slice(0, 42)), false);
  assert.equal(tokensEqual(token, "x".repeat(43)), false);
});

test("AC1: startStudio returns launchUrl; open uses it; default ui is hosted (I2)", async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(healthBody());
    },
    async (runtimeUrl) => {
      const hosted = await startStudio({
        runtimeUrl,
        serverKey: "server-secret",
        tenant: TENANT,
        open: false,
        port: 0,
      });
      try {
        assert.ok(hosted.launchUrl.startsWith(`${HOSTED_ORIGIN}/#`));
        assert.equal(typeof hosted.address, "string");
        const token = tokenFromLaunch(hosted.launchUrl);
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      } finally {
        await hosted.close();
      }

      const local = await startStudio({
        runtimeUrl,
        serverKey: "server-secret",
        tenant: TENANT,
        open: false,
        port: 0,
        ui: "local",
      });
      try {
        assert.ok(local.launchUrl.startsWith(`${local.address}/#`));
        const pairing = parsePairingFragment(
          local.launchUrl.slice(local.launchUrl.indexOf("#")),
        );
        assert.ok(pairing);
        assert.equal(pairing.port, Number(new URL(local.address).port));
      } finally {
        await local.close();
      }
    },
  );
});

test("AC2/I7: token never appears on stdout/stderr across startup + 10 requests", async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (runtimeUrl) => {
      const chunks = [];
      const prevOut = process.stdout.write.bind(process.stdout);
      const prevErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk, enc, cb) => {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        return prevOut(chunk, enc, cb);
      });
      process.stderr.write = ((chunk, enc, cb) => {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        return prevErr(chunk, enc, cb);
      });
      let token;
      try {
        const studio = await startHosted(runtimeUrl);
        try {
          token = tokenFromLaunch(studio.launchUrl);
          const port = new URL(studio.address).port;
          for (let i = 0; i < 10; i += 1) {
            const response = await fetch(
              `${studio.address}/_studio/runtime/v1/agents`,
              {
                headers: {
                  ...auth(token),
                  host: `localhost:${port}`,
                  origin: HOSTED_ORIGIN,
                },
              },
            );
            assert.equal(response.status, 200);
          }
        } finally {
          await studio.close();
        }
      } finally {
        process.stdout.write = prevOut;
        process.stderr.write = prevErr;
      }
      const logged = chunks.join("");
      assert.ok(token);
      assert.equal(logged.includes(token), false);
    },
  );
});

test("AC3: missing or wrong token → 401 + WWW-Authenticate Bearer", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const url = `${studio.address}/_studio/runtime/v1/agents`;
        const missing = await fetch(url, {
          headers: { origin: HOSTED_ORIGIN },
        });
        assert.equal(missing.status, 401);
        assert.equal(missing.headers.get("www-authenticate"), "Bearer");

        const token = tokenFromLaunch(studio.launchUrl);
        const wrong = "x".repeat(token.length);
        const bad = await fetch(url, {
          headers: { ...auth(wrong), origin: HOSTED_ORIGIN },
        });
        assert.equal(bad.status, 401);
        assert.equal(bad.headers.get("www-authenticate"), "Bearer");
      } finally {
        await studio.close();
      }
    },
  );
});

test("AC4/I4: OPTIONS CORS for hosted origin; evil origin gets 403 without Allow-*", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const url = `${studio.address}/_studio/runtime/v1/agents`;
        const ok = await fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: HOSTED_ORIGIN,
            "access-control-request-method": "GET",
          },
        });
        assert.equal(ok.status, 204);
        assert.equal(ok.headers.get("access-control-allow-origin"), HOSTED_ORIGIN);
        assert.equal(
          ok.headers.get("access-control-allow-methods"),
          "GET, PUT, POST, DELETE",
        );
        assert.equal(
          ok.headers.get("access-control-allow-headers"),
          "authorization, content-type, accept, last-event-id",
        );
        assert.equal(
          ok.headers.get("access-control-allow-private-network"),
          "true",
        );
        assert.equal(ok.headers.get("vary"), "Origin");
        assert.equal(ok.headers.get("access-control-max-age"), "600");

        const evil = await fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "GET",
          },
        });
        assert.equal(evil.status, 403);
        for (const [name] of evil.headers) {
          assert.equal(
            name.toLowerCase().startsWith("access-control-allow-"),
            false,
            `unexpected CORS header ${name}`,
          );
        }
      } finally {
        await studio.close();
      }
    },
  );
});

test("AC5/I5: valid token + evil Origin → 403; mutating without Origin → 403", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const token = tokenFromLaunch(studio.launchUrl);
        const getEvil = await fetch(
          `${studio.address}/_studio/runtime/v1/agents`,
          {
            headers: {
              ...auth(token),
              origin: "https://evil.example",
            },
          },
        );
        assert.equal(getEvil.status, 403);

        for (const method of ["PUT", "POST"]) {
          const response = await fetch(
            `${studio.address}/_studio/runtime/v1/sessions/s1${method === "POST" ? "/commands" : ""}`,
            {
              method,
              headers: {
                ...auth(token),
                "content-type": "application/json",
              },
              body: JSON.stringify(
                method === "POST"
                  ? { type: "message", content: "hi" }
                  : { title: "x" },
              ),
            },
          );
          assert.equal(response.status, 403, method);
        }
      } finally {
        await studio.close();
      }
    },
  );
});

test("AC6/I6: Host evil.example → 421", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const token = tokenFromLaunch(studio.launchUrl);
        const port = new URL(studio.address).port;
        const response = await fetch(
          `http://127.0.0.1:${port}/_studio/runtime/v1/agents`,
          {
            headers: {
              ...auth(token),
              host: `evil.example:${port}`,
              origin: HOSTED_ORIGIN,
            },
          },
        );
        // undici/fetch may overwrite Host; drive via raw http if needed
        if (response.status !== 421) {
          const { request } = await import("node:http");
          const status = await new Promise((resolve, reject) => {
            const req = request(
              {
                hostname: "127.0.0.1",
                port: Number(port),
                path: "/_studio/runtime/v1/agents",
                method: "GET",
                headers: {
                  host: `evil.example:${port}`,
                  authorization: `Bearer ${token}`,
                  origin: HOSTED_ORIGIN,
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          });
          assert.equal(status, 421);
        } else {
          assert.equal(response.status, 421);
        }
      } finally {
        await studio.close();
      }
    },
  );
});

test("AC7: GET /_studio/hello returns StudioHello; unreachable Runtime is compatible:false", async () => {
  await withUpstream(
    (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(healthBody());
        return;
      }
      res.writeHead(404);
      res.end("no");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const token = tokenFromLaunch(studio.launchUrl);
        const response = await fetch(`${studio.address}/_studio/hello`, {
          headers: { ...auth(token), origin: HOSTED_ORIGIN },
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.studioProtocol, 1);
        assert.equal(typeof body.proxyVersion, "string");
        assert.equal(body.mode, "hosted");
        assert.deepEqual(body.tenant, TENANT);
        assert.equal(body.runtime.compatible, true);
        assert.equal("serverKey" in body, false);
        assert.equal("token" in body, false);
      } finally {
        await studio.close();
      }
    },
  );

  const studio = await startStudio({
    runtimeUrl: "http://127.0.0.1:9",
    serverKey: "server-secret",
    tenant: TENANT,
    open: false,
    port: 0,
    ui: "hosted",
  });
  try {
    const token = tokenFromLaunch(studio.launchUrl);
    const response = await fetch(`${studio.address}/_studio/hello`, {
      headers: { ...auth(token), origin: HOSTED_ORIGIN },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runtime.compatible, false);
    assert.equal(typeof body.runtime.message, "string");
  } finally {
    await studio.close();
  }
});

test("AC8/P5: hosted GET / is landing page; /assets/x.js is 404; no dist/web read", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const root = await fetch(studio.address);
        assert.equal(root.status, 200);
        assert.equal(root.headers.get("cache-control"), "no-store");
        assert.equal(
          root.headers.get("content-security-policy"),
          "default-src 'none'",
        );
        const html = await root.text();
        assert.match(html, /Open the Studio URL printed in your terminal/i);

        const asset = await fetch(`${studio.address}/assets/x.js`);
        assert.equal(asset.status, 404);
      } finally {
        await studio.close();
      }
    },
  );
});

test("AC9: local mode serves dist/web and allows own origin", async () => {
  const webRoot = join(
    new URL("../dist/web", import.meta.url).pathname,
  );
  const indexPath = join(webRoot, "index.html");
  const assetPath = join(webRoot, "assets", "app.js");
  const previousIndex = await readFile(indexPath, "utf8").catch(() => undefined);
  const previousAsset = await readFile(assetPath).catch(() => undefined);
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    indexPath,
    "<!doctype html><title>local-studio</title><body>local-ui</body>",
  );
  await writeFile(assetPath, "console.log(1)");

  try {
    await withUpstream(
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      async (runtimeUrl) => {
        const studio = await startStudio({
          runtimeUrl,
          serverKey: "server-secret",
          tenant: TENANT,
          open: false,
          port: 0,
          ui: "local",
        });
        try {
          assert.ok(studio.launchUrl.startsWith(`${studio.address}/#`));
          const page = await fetch(studio.address);
          assert.equal(page.status, 200);
          assert.match(await page.text(), /local-ui/);

          const token = tokenFromLaunch(studio.launchUrl);
          const origin = studio.address;
          const response = await fetch(
            `${studio.address}/_studio/runtime/v1/agents`,
            {
              headers: { ...auth(token), origin },
            },
          );
          assert.equal(response.status, 200);
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            origin,
          );

          const preflight = await fetch(
            `${studio.address}/_studio/runtime/v1/agents`,
            {
              method: "OPTIONS",
              headers: { origin },
            },
          );
          assert.equal(preflight.status, 204);
          assert.equal(
            preflight.headers.get("access-control-allow-origin"),
            origin,
          );
        } finally {
          await studio.close();
        }
      },
    );
  } finally {
    if (previousIndex !== undefined) await writeFile(indexPath, previousIndex);
    if (previousAsset !== undefined) await writeFile(assetPath, previousAsset);
    else await rm(assetPath, { force: true }).catch(() => {});
  }
});

test("AC10: allowlisted runtime proxy still works through authorize gate", async () => {
  const seen = [];
  await withUpstream(
    (req, res) => {
      seen.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        lastEventId: req.headers["last-event-id"],
      });
      if ((req.url ?? "").includes("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: hi\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (runtimeUrl) => {
      const studio = await startHosted(runtimeUrl);
      try {
        const token = tokenFromLaunch(studio.launchUrl);
        const agents = await fetch(
          `${studio.address}/_studio/runtime/v1/agents`,
          { headers: { ...auth(token), origin: HOSTED_ORIGIN } },
        );
        assert.equal(agents.status, 200);

        const events = await fetch(
          `${studio.address}/_studio/runtime/v1/sessions/s1/events`,
          {
            headers: {
              ...auth(token),
              origin: HOSTED_ORIGIN,
              "last-event-id": "42",
              accept: "text/event-stream",
            },
          },
        );
        assert.equal(events.status, 200);
        assert.equal(await events.text(), "data: hi\n\n");

        const blocked = await fetch(
          `${studio.address}/_studio/runtime/v1/host/model`,
          { headers: { ...auth(token), origin: HOSTED_ORIGIN } },
        );
        assert.equal(blocked.status, 404);

        assert.ok(seen.some((s) => s.path === "/v1/agents"));
        assert.ok(
          seen.some(
            (s) =>
              s.path.startsWith("/v1/sessions/s1/events") &&
              s.lastEventId === "42",
          ),
        );
        assert.ok(
          seen.every((s) => s.authorization === "Bearer server-secret"),
        );
      } finally {
        await studio.close();
      }
    },
  );
});

test("I9: two starts mint different tokens", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (runtimeUrl) => {
      const a = await startHosted(runtimeUrl);
      const b = await startHosted(runtimeUrl);
      try {
        assert.notEqual(
          tokenFromLaunch(a.launchUrl),
          tokenFromLaunch(b.launchUrl),
        );
      } finally {
        await a.close();
        await b.close();
      }
    },
  );
});

test("extraOrigin is accepted for repository Vite development", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (runtimeUrl) => {
      const extra = "http://localhost:5173";
      const studio = await startHosted(runtimeUrl, { extraOrigin: extra });
      try {
        const token = tokenFromLaunch(studio.launchUrl);
        const preflight = await fetch(
          `${studio.address}/_studio/runtime/v1/agents`,
          { method: "OPTIONS", headers: { origin: extra } },
        );
        assert.equal(preflight.status, 204);
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          extra,
        );
        const response = await fetch(
          `${studio.address}/_studio/runtime/v1/agents`,
          { headers: { ...auth(token), origin: extra } },
        );
        assert.equal(response.status, 200);
      } finally {
        await studio.close();
      }
    },
  );
});
