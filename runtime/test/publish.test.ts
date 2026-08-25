import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { upload } from "../src/cli/publish.js";
import type { Args } from "../src/cli/args.js";
import type { CapabilityManifest } from "../src/types.js";

const bundle = Buffer.from("export default {}");
const manifest: CapabilityManifest = {
  formatVersion: 3,
  sdkVersion: "test",
  agent: { name: "publish-test", model: "google/gemini-2.5-flash-lite", secrets: [] },
  instructionsDigest: "a".repeat(64),
  tools: [],
  skills: [],
  mcp: [],
  harness: {
    protocol: "nylorun.harness/v2",
    harness: "test",
    harnessVersion: "1",
    capabilities: { tools: "none", skills: "none", mcp: "none", streaming: "none", modelRouting: "nylorun", sessions: "none", usage: "none", cancellation: "none", limits: { maxTurns: false, maxTokens: false, maxToolResultBytes: false } },
    portable: true,
    unsupported: [],
    eventCoverage: [],
    durability: "none",
    concurrency: "serial",
    compaction: "none"
  },
  requirements: { tools: false, skills: false, mcp: false, tokenStreaming: false, durableSessions: false, maxTokens: false, maxToolResultBytes: false },
  bundleDigest: createHash("sha256").update(bundle).digest("hex"),
  digest: "b".repeat(64)
};

function args(noPromote: boolean): Args {
  return {
    command: "publish",
    positionals: [],
    json: true,
    strict: false,
    yes: true,
    check: false,
    noPromote,
    project: "/tmp/project",
    port: 4111
  };
}

afterEach(() => vi.restoreAllMocks());

describe("publish service contract", () => {
  it("uploads exactly three artifacts with a credential, then explicitly promotes", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        const form = await request.formData();
        expect([...form.keys()].sort()).toEqual(["archive", "bundle", "manifest"]);
        return Response.json({ name: "publish-test", version: 7, state: "stored" }, { status: 201 });
      }
      return Response.json({ name: "publish-test", current_version: 7, promoted_at: "now" });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(upload("http://registry.test", "credential", manifest, bundle, Buffer.from("archive"), args(false), {})).resolves.toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer credential");
    expect(requests[1]?.url).toBe("http://registry.test/agents/publish-test/versions/7/promote");
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer credential");
  });

  it("stores without promotion when --no-promote is explicit", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetch = vi.fn(async () => Response.json({ name: "publish-test", version: 8, state: "stored" }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await expect(upload("http://registry.test", "credential", manifest, bundle, Buffer.from("archive"), args(true), {})).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
