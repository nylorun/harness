import { expect, it } from "vitest";
import {
  isStudioDiscovery,
  manifestMiddleware,
} from "../../studio/src/protocol.js";
const manifest = {
  id: "test",
  name: "Test",
  middleware: [{ id: "agent", instructions: ["hello"] }],
};
const endpoints = { agUi: "/run", sessions: "/sessions" };
it("accepts Studio discovery protocol 1 and 2", () => {
  const agents = [{ id: "echo", manifestUrl: "/agents/echo/manifest.json" }];
  expect(isStudioDiscovery({ protocolVersion: 1, agents })).toBe(true);
  expect(isStudioDiscovery({ protocolVersion: 2, agents })).toBe(true);
  expect(isStudioDiscovery({ protocolVersion: 3, agents })).toBe(false);
  expect(isStudioDiscovery({ protocolVersion: 2 })).toBe(false);
});

it("supports legacy and neutral Studio manifests", () => {
  expect(
    manifestMiddleware({
      protocolVersion: 1,
      id: "test",
      name: "Test",
      endpoints,
      harness: { manifest },
    }),
  ).toEqual(manifest.middleware);
  expect(
    manifestMiddleware({
      protocolVersion: 2,
      id: "test",
      name: "Test",
      endpoints,
      manifest,
    }),
  ).toEqual(manifest.middleware);
  expect(
    manifestMiddleware({
      protocolVersion: 2,
      id: "other",
      name: "Other",
      endpoints,
      manifest: { id: "other", name: "Other" },
    }),
  ).toEqual([]);
});
