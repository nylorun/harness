import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTED_ORIGIN,
  PAIRING_STORAGE_KEY,
  PROXY_HOST,
  STUDIO_PROTOCOL,
  SUPPORTED_STUDIO_PROTOCOLS,
  pairingFragment,
  parsePairingFragment,
  proxyOrigin,
} from "../src/contract.ts";

const VALID_TOKEN = "q3vABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-ab"; // 43 base64url chars

test("contract constants", () => {
  assert.equal(STUDIO_PROTOCOL, 1);
  assert.deepEqual([...SUPPORTED_STUDIO_PROTOCOLS], [1]);
  assert.equal(HOSTED_ORIGIN, "https://local.nylorun.studio");
  assert.equal(PROXY_HOST, "127.0.0.1");
  assert.equal(PAIRING_STORAGE_KEY, "nylorun.studio.pairing.v1");
});

test("pairingFragment builds studio, port and token", () => {
  const fragment = pairingFragment({
    protocol: 1,
    port: 4161,
    token: VALID_TOKEN,
  });
  assert.equal(fragment[0], "#");
  const params = new URLSearchParams(fragment.slice(1));
  assert.equal(params.get("studio"), "1");
  assert.equal(params.get("port"), "4161");
  assert.equal(params.get("token"), VALID_TOKEN);
});

test("parsePairingFragment accepts a valid hash", () => {
  const pairing = parsePairingFragment(
    `#studio=1&port=4161&token=${VALID_TOKEN}`,
  );
  assert.deepEqual(pairing, {
    protocol: 1,
    port: 4161,
    token: VALID_TOKEN,
  });
});

test("parsePairingFragment accepts a hash without leading #", () => {
  const pairing = parsePairingFragment(
    `studio=1&port=4161&token=${VALID_TOKEN}`,
  );
  assert.equal(pairing?.port, 4161);
});

test("parsePairingFragment ignores host and still pairs (I8)", () => {
  const pairing = parsePairingFragment(
    `#studio=1&port=4161&token=${VALID_TOKEN}&host=evil.example`,
  );
  assert.ok(pairing);
  assert.equal(pairing.port, 4161);
  assert.equal(proxyOrigin(pairing.port), "http://127.0.0.1:4161");
  assert.equal(proxyOrigin(pairing.port).includes("evil"), false);
});

test("parsePairingFragment rejects a non-integer studio value", () => {
  assert.equal(
    parsePairingFragment(`#studio=1.5&port=4161&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=abc&port=4161&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=&port=4161&token=${VALID_TOKEN}`),
    undefined,
  );
});

test("parsePairingFragment rejects ports outside 1–65535", () => {
  assert.equal(
    parsePairingFragment(`#studio=1&port=0&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=1&port=65536&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=1&port=-1&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=1&port=4.2&token=${VALID_TOKEN}`),
    undefined,
  );
});

test("parsePairingFragment rejects tokens that are not 43 base64url characters", () => {
  assert.equal(
    parsePairingFragment(`#studio=1&port=4161&token=short`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(
      `#studio=1&port=4161&token=${VALID_TOKEN}x`,
    ),
    undefined,
  );
  assert.equal(
    parsePairingFragment(
      `#studio=1&port=4161&token=${VALID_TOKEN.slice(0, 42)}+`,
    ),
    undefined,
  );
  // padding and non-base64url characters
  const withPlus = `${VALID_TOKEN.slice(0, 42)}+`;
  assert.equal(withPlus.length, 43);
  assert.equal(
    parsePairingFragment(`#studio=1&port=4161&token=${withPlus}`),
    undefined,
  );
});

test("parsePairingFragment rejects missing fields and empty hash", () => {
  assert.equal(parsePairingFragment(""), undefined);
  assert.equal(parsePairingFragment("#"), undefined);
  assert.equal(
    parsePairingFragment(`#port=4161&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(
    parsePairingFragment(`#studio=1&token=${VALID_TOKEN}`),
    undefined,
  );
  assert.equal(parsePairingFragment("#studio=1&port=4161"), undefined);
});

test("proxyOrigin always uses 127.0.0.1 and never another host", () => {
  assert.equal(proxyOrigin(4161), "http://127.0.0.1:4161");
  assert.equal(proxyOrigin(1), "http://127.0.0.1:1");
  assert.equal(proxyOrigin(65535), "http://127.0.0.1:65535");
  assert.throws(() => proxyOrigin(0), RangeError);
  assert.throws(() => proxyOrigin(65536), RangeError);
  assert.throws(() => proxyOrigin(3.14), RangeError);
});

test("pairingFragment round-trips through parsePairingFragment", () => {
  const original = {
    protocol: STUDIO_PROTOCOL,
    port: 4200,
    token: VALID_TOKEN,
  };
  assert.deepEqual(parsePairingFragment(pairingFragment(original)), original);
});
