import { describe, expect, it } from "vitest";
import { loadBrowserStudioConfig, parseBrowserStudioConfig } from "./config";

describe("browser Studio configuration", () => {
  it("permits direct HTTP local and HTTPS remote Agent Servers", () => {
    expect(parseBrowserStudioConfig({ agentServerUrl: "http://127.0.0.1:4111/" }, "http:")).toEqual({ agentServerUrl: "http://127.0.0.1:4111" });
    expect(parseBrowserStudioConfig({ agentServerUrl: "https://agent.example.internal" }, "https:")).toEqual({ agentServerUrl: "https://agent.example.internal" });
  });
  it("rejects mixed content and unsupported values", () => {
    expect(() => parseBrowserStudioConfig({ agentServerUrl: "http://agent.example.internal" }, "https:")).toThrow("HTTPS Studio");
    expect(() => parseBrowserStudioConfig({ agentServerUrl: "file:///tmp/agent" }, "http:")).toThrow("http or https");
  });
  it("loads configuration from the static-host root on SPA routes", async () => {
    let requested: string | undefined;
    await loadBrowserStudioConfig(async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ agentServerUrl: "http://127.0.0.1:4111" }));
    }, "http://localhost:4162/session/example");
    expect(requested).toBe("http://localhost:4162/nylo-studio.config.json");
  });
});
