import { describe, expect, it } from "vitest";
import { parseAgentServerUrl } from "../src/host.js";

describe("Studio direct-Agent configuration", () => {
  it("accepts an HTTP(S) Agent Server URL and strips a trailing slash", () => {
    expect(parseAgentServerUrl("https://agents.example.internal/")).toBe("https://agents.example.internal");
    expect(parseAgentServerUrl("http://127.0.0.1:4111")).toBe("http://127.0.0.1:4111");
  });

  it("rejects unsafe or ambiguous Agent Server URLs", () => {
    expect(() => parseAgentServerUrl("file:///tmp/agent")).toThrow("http or https");
    expect(() => parseAgentServerUrl("https://token@example.internal")).toThrow("credentials");
    expect(() => parseAgentServerUrl("https://agent.example.internal/?debug=true")).toThrow("query string");
  });
});
