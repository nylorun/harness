import { expect, it } from "vitest";
import {
  isStudioDiscovery,
  manifestCapabilities,
} from "../../studio/src/protocol.js";
const capabilities = [{ id: "agent", instructions: ["hello"] }];
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
    manifestCapabilities({
      protocolVersion: 1,
      id: "test",
      name: "Test",
      endpoints,
      harness: {
        manifest: { id: "test", name: "Test", middleware: capabilities },
      },
    })
  ).toEqual(capabilities);
  expect(
    manifestCapabilities({
      protocolVersion: 2,
      id: "test",
      name: "Test",
      endpoints,
      manifest: { id: "test", name: "Test", capabilities },
    })
  ).toEqual(capabilities);
  expect(
    manifestCapabilities({
      protocolVersion: 2,
      id: "test",
      name: "Test",
      endpoints,
      manifest: { id: "test", name: "Test", middleware: capabilities },
    })
  ).toEqual(capabilities);
  expect(
    manifestCapabilities({
      protocolVersion: 2,
      id: "other",
      name: "Other",
      endpoints,
      manifest: { id: "other", name: "Other" },
    })
  ).toEqual([]);
});
