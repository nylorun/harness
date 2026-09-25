import assert from "node:assert/strict";
import test from "node:test";
import {
  PAIRING_STORAGE_KEY,
  pairingFragment,
  proxyOrigin,
} from "../src/contract.ts";
import {
  classifyProxyFailure,
  clearPairing,
  compatibleBuildVersion,
  currentPairing,
  fetchHello,
  protocolSupported,
  proxyFetch,
  proxyUrl,
  ProxyAuthError,
  readPairing,
  redirectToCompatibleBuild,
} from "../web/src/proxy-client.ts";

const VALID_TOKEN = "q3vABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-ab"; // 43 chars

function memoryStorage(initial = new Map()) {
  const map = new Map(initial);
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

test("readPairing prefers the fragment, stores JSON, and strips the hash", () => {
  const storage = memoryStorage();
  const replaced = [];
  const loc = {
    hash: `#studio=1&port=4161&token=${VALID_TOKEN}&host=evil.example`,
    pathname: "/v/0.8.0-beta/",
    search: "",
    origin: "https://local.nylorun.studio",
    href: "https://local.nylorun.studio/v/0.8.0-beta/",
  };
  const pairing = readPairing(loc, storage, {
    replaceState(_state, _title, url) {
      replaced.push(url);
    },
  });
  assert.deepEqual(pairing, {
    protocol: 1,
    port: 4161,
    token: VALID_TOKEN,
  });
  assert.equal(replaced[0], "/v/0.8.0-beta/");
  const stored = JSON.parse(storage.getItem(PAIRING_STORAGE_KEY));
  assert.equal(stored.port, 4161);
  assert.equal(stored.token, VALID_TOKEN);
  assert.equal(stored.protocol, 1);
  // I8: crafted host never becomes the proxy origin
  assert.equal(proxyOrigin(pairing.port), "http://127.0.0.1:4161");
});

test("readPairing falls back to sessionStorage when there is no fragment", () => {
  const storage = memoryStorage([
    [
      PAIRING_STORAGE_KEY,
      JSON.stringify({ port: 4200, token: VALID_TOKEN, protocol: 1 }),
    ],
  ]);
  const pairing = readPairing(
    {
      hash: "",
      pathname: "/",
      search: "",
      origin: "https://local.nylorun.studio",
      href: "https://local.nylorun.studio/",
    },
    storage,
    { replaceState() {} },
  );
  assert.equal(pairing?.port, 4200);
  assert.equal(pairing?.token, VALID_TOKEN);
});

test("readPairing returns undefined when unpaired (no network)", () => {
  const storage = memoryStorage();
  assert.equal(
    readPairing(
      {
        hash: "",
        pathname: "/",
        search: "",
        origin: "https://local.nylorun.studio",
        href: "https://local.nylorun.studio/",
      },
      storage,
      { replaceState() {} },
    ),
    undefined,
  );
  assert.equal(currentPairing(storage), undefined);
});

test("proxyUrl always uses 127.0.0.1 even when fragment carried a host (I8)", () => {
  const pairing = {
    protocol: 1,
    port: 4161,
    token: VALID_TOKEN,
  };
  assert.equal(
    proxyUrl("/_studio/hello", pairing),
    "http://127.0.0.1:4161/_studio/hello",
  );
  assert.equal(
    proxyUrl("/_studio/runtime", pairing),
    "http://127.0.0.1:4161/_studio/runtime",
  );
});

test("proxyFetch attaches Bearer token and targetAddressSpace loopback", async () => {
  const pairing = { protocol: 1, port: 4161, token: VALID_TOKEN };
  let seen;
  const response = await proxyFetch(
    "/_studio/hello",
    { method: "GET" },
    {
      pairing,
      fetcher: async (url, init) => {
        seen = { url: String(url), init };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(seen.url, "http://127.0.0.1:4161/_studio/hello");
  assert.equal(seen.init.targetAddressSpace, "loopback");
  const headers = new Headers(seen.init.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${VALID_TOKEN}`);
});

test("fetchHello clears pairing on 401", async () => {
  const storage = memoryStorage([
    [
      PAIRING_STORAGE_KEY,
      JSON.stringify({ port: 4161, token: VALID_TOKEN, protocol: 1 }),
    ],
  ]);
  await assert.rejects(
    () =>
      fetchHello({
        pairing: { protocol: 1, port: 4161, token: VALID_TOKEN },
        storage,
        fetcher: async () => new Response("", { status: 401 }),
      }),
    (error) => error instanceof ProxyAuthError,
  );
  assert.equal(storage.getItem(PAIRING_STORAGE_KEY), null);
});

test("clearPairing removes the storage key", () => {
  const storage = memoryStorage([
    [PAIRING_STORAGE_KEY, JSON.stringify({ port: 1, token: VALID_TOKEN })],
  ]);
  clearPairing(storage);
  assert.equal(storage.getItem(PAIRING_STORAGE_KEY), null);
});

test("protocolSupported follows SUPPORTED_STUDIO_PROTOCOLS", () => {
  assert.equal(protocolSupported(1), true);
  assert.equal(protocolSupported(2), false);
});

test("compatibleBuildVersion reads protocols map", () => {
  assert.equal(
    compatibleBuildVersion(2, {
      latest: "0.9.0",
      protocols: { "1": "0.8.0-beta", "2": "0.9.0" },
    }),
    "0.9.0",
  );
  assert.equal(
    compatibleBuildVersion(9, { latest: "0.9.0", protocols: { "1": "0.8.0" } }),
    undefined,
  );
});

test("redirectToCompatibleBuild replaces to /v/<version>/ keeping fragment", async () => {
  const pairing = { protocol: 2, port: 4161, token: VALID_TOKEN };
  const replaced = [];
  const loc = {
    hash: "",
    pathname: "/v/0.8.0-beta/",
    search: "?x=1",
    origin: "https://local.nylorun.studio",
    href: "https://local.nylorun.studio/v/0.8.0-beta/?x=1",
    replace(url) {
      replaced.push(url);
    },
  };
  const redirected = await redirectToCompatibleBuild(pairing, {
    loc,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          latest: "0.9.0",
          protocols: { "2": "0.9.0" },
        }),
        { status: 200 },
      ),
  });
  assert.equal(redirected, true);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0], `/v/0.9.0/?x=1${pairingFragment(pairing)}`);
});

test("redirectToCompatibleBuild returns false when no compatible build", async () => {
  const pairing = { protocol: 9, port: 4161, token: VALID_TOKEN };
  const redirected = await redirectToCompatibleBuild(pairing, {
    loc: {
      hash: "",
      pathname: "/v/0.8.0-beta/",
      search: "",
      origin: "https://local.nylorun.studio",
      href: "https://local.nylorun.studio/v/0.8.0-beta/",
      replace() {
        throw new Error("should not replace");
      },
    },
    fetcher: async () =>
      new Response(JSON.stringify({ latest: "0.8.0", protocols: { "1": "0.8.0" } }), {
        status: 200,
      }),
  });
  assert.equal(redirected, false);
});

test("classifyProxyFailure maps auth, local-access, and network", () => {
  assert.equal(classifyProxyFailure(new ProxyAuthError(), true), "auth");
  assert.equal(
    classifyProxyFailure(new TypeError("Failed to fetch"), true),
    "local-access",
  );
  assert.equal(
    classifyProxyFailure(new TypeError("Failed to fetch"), false),
    "network",
  );
  assert.equal(classifyProxyFailure(new Error("offline"), true), "network");
});
