import { expect, it } from "vitest";
import { allowedHost, loopbackHosts } from "../src/server/host.js";

it("loopback binds answer to their own address on the chosen port", () => {
  const hosts = loopbackHosts(4200);
  expect(allowedHost("127.0.0.1:4200", hosts)).toBe(true);
  expect(allowedHost("localhost:4200", hosts)).toBe(true);
  expect(allowedHost("[::1]:4200", hosts)).toBe(true);
  expect(allowedHost("127.0.0.1:4111", hosts)).toBe(false);
  expect(allowedHost("agent.example.com", hosts)).toBe(false);
  expect(allowedHost(undefined, hosts)).toBe(false);
});

it("published hosts match exactly or by bare name, and * accepts everything", () => {
  const hosts = ["agent.example.com", "api.example.com:8443"];
  expect(allowedHost("agent.example.com", hosts)).toBe(true);
  expect(allowedHost("agent.example.com:443", hosts)).toBe(true);
  expect(allowedHost("Agent.Example.com", hosts)).toBe(true);
  expect(allowedHost("api.example.com:8443", hosts)).toBe(true);
  expect(allowedHost("api.example.com:9000", hosts)).toBe(false);
  expect(allowedHost("evil.example.com", hosts)).toBe(false);
  expect(allowedHost("evil.example.com", ["*"])).toBe(true);
  expect(allowedHost("not a host", hosts)).toBe(false);
});
