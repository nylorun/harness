import { describe, expect, it, vi } from "vitest";

import { runtimeAgentFrom } from "../../src/local/runtime/cli/artifact.js";
import type { BuiltAgent } from "../../src/local/runtime/runtime/bind.js";

describe("CLI artifact selection", () => {
  it("uses the named runtime handle rather than the default HTTP door", () => {
    const agent = { session: { start: vi.fn() } } as unknown as BuiltAgent;
    const door = Object.assign(vi.fn(), { fetch: vi.fn() });

    expect(runtimeAgentFrom({ default: door, agent })).toBe(agent);
    expect(runtimeAgentFrom({ default: door })).toBeUndefined();
  });
});
