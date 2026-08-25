import { describe, expect, it } from "vitest";
import { AGENT_HARNESS, HARNESS_PROTOCOL, createAgentHarness, deriveAgentRequirements, isAgentHarness, isProtocolV1Description, parseAgentHarness, validateExecutionConformance, validateHarnessCompatibility, type AdapterDescription } from "../src/index.js";

const description: AdapterDescription = {
  protocol: HARNESS_PROTOCOL,
  harness: "test",
  harnessVersion: "1",
  capabilities: { tools: "none", skills: "none", mcp: "none", streaming: "messages", modelRouting: "harness-owned", sessions: "none", usage: "none", cancellation: "none", limits: { maxTurns: true, maxTokens: false, maxToolResultBytes: false } },
  portable: true,
  unsupported: [],
  eventCoverage: [],
  durability: "none",
  concurrency: "serial",
  compaction: "none"
};

describe("agent contract", () => {
  const adapter = { describe: () => description, prepare: () => ({ start: () => ({ done: Promise.resolve({ status: "completed" as const }), abort: () => undefined }) }) };

  it("creates a protocol-branded harness without naming an implementation", () => {
    const value = createAgentHarness(adapter, { instructions: "Be precise." });
    expect(isAgentHarness(value)).toBe(true);
    expect(value[AGENT_HARNESS]).toBe(true);
    expect(value.protocol).toBe(HARNESS_PROTOCOL);
    expect(value.adapter).toBe(adapter);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects a missing brand, unsupported protocol, and malformed adapter", () => {
    expect(() => parseAgentHarness({ protocol: HARNESS_PROTOCOL, adapter })).toThrow("NYLO_HARNESS_INVALID");
    expect(() => parseAgentHarness({ [AGENT_HARNESS]: true, protocol: "nylorun.harness/v0", adapter })).toThrow("NYLO_HARNESS_PROTOCOL_UNSUPPORTED");
    expect(() => parseAgentHarness({ [AGENT_HARNESS]: true, protocol: HARNESS_PROTOCOL, adapter: {} })).toThrow("NYLO_HARNESS_ADAPTER_INVALID");
  });

  it("derives requirements independently and rejects unsupported harness guarantees", () => {
    const requirements = deriveAgentRequirements({ toolCount: 1, policy: { requireModelRouting: "nylorun", requireTokenStreaming: true } });
    expect(validateHarnessCompatibility(requirements, description).map((item) => item.code)).toEqual([
      "NYLO_HARNESS_TOOLS_UNSUPPORTED",
      "NYLO_HARNESS_TOKEN_STREAMING_UNSUPPORTED",
      "NYLO_HARNESS_MODEL_ROUTING_UNSUPPORTED"
    ]);
  });

  it("recognizes only complete protocol-v1 descriptions", () => {
    expect(isProtocolV1Description(description)).toBe(true);
    expect(isProtocolV1Description({ ...description, protocol: "nylorun.harness/v0" })).toBe(false);
  });

  it("checks execution evidence against declared usage guarantees", () => {
    const capable: AdapterDescription = { ...description, capabilities: { ...description.capabilities, usage: "per-model-call" } };
    expect(validateExecutionConformance(capable, [], { status: "completed" })[0]?.code).toBe("NYLO_HARNESS_USAGE_EVENT_MISSING");
    expect(validateExecutionConformance(capable, [{ type: "model.call" }], { status: "completed" })).toEqual([]);
  });
});
