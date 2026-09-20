/**
 * Optional live sandbox smoke against https://sandbox.nylorun.dev.
 *
 * Skips unless both are set:
 *   NYLORUN_URL (or defaults to sandbox) + NYLORUN_SECRET_KEY
 *   and NYLORUN_SMOKE=1
 *
 * Example:
 *   NYLORUN_SMOKE=1 \
 *   NYLORUN_URL=https://sandbox.nylorun.dev \
 *   NYLORUN_SECRET_KEY=nyl_sk_… \
 *   npm test -- agents-api-sandbox-smoke
 *
 * Does not fail CI when secrets are absent.
 */
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/harness";
import {
  AgentsApiClient,
  SANDBOX_AGENTS_API_URL,
  openCloudSession,
  resolveCloudConfig,
} from "../src/index.js";

const smokeEnabled = process.env.NYLORUN_SMOKE === "1";
const config = resolveCloudConfig({
  NYLORUN_MODE: "cloud",
  NYLORUN_URL: process.env.NYLORUN_URL ?? SANDBOX_AGENTS_API_URL,
  NYLORUN_SECRET_KEY: process.env.NYLORUN_SECRET_KEY,
  NYLORUN_API_KEY: process.env.NYLORUN_API_KEY,
  NYLORUN_JWT: process.env.NYLORUN_JWT,
});

describe.runIf(smokeEnabled && !!config)("Agents API sandbox smoke", () => {
  it("registers, opens, messages against live sandbox", async () => {
    const client = new AgentsApiClient(config!);
    const agent = Agent({
      id: `smoke_${Date.now().toString(36)}`,
      name: "Sandbox Smoke",
    }).build();
    const session = await openCloudSession(client, agent, {
      info: { id: "smoke_user" },
    });
    const accepted = await session.input("ping from runtime smoke");
    expect(accepted.status).toBe("accepted");
    if (accepted.status === "accepted") {
      expect(accepted.turnId).toBeTruthy();
      expect(accepted.cursor).toBeTruthy();
    }
  }, 60_000);
});

describe.runIf(!smokeEnabled || !config)(
  "Agents API sandbox smoke (skipped without secrets)",
  () => {
    it("documents how to enable live smoke", () => {
      expect(SANDBOX_AGENTS_API_URL).toBe("https://sandbox.nylorun.dev");
      // Always passes — keeps the suite discoverable in CI without secrets.
    });
  },
);
