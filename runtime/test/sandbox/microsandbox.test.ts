import { describe, it } from "vitest";
import { microsandboxBackend } from "../../src/adapters/sandbox/microsandbox.js";
import { conformance } from "./conformance.js";

// Boots real microVMs, so it runs only when asked: NYLORUN_TEST_MICROSANDBOX=1.
const enabled = process.env.NYLORUN_TEST_MICROSANDBOX === "1";
const available = enabled && (await microsandboxBackend().probe()).available;

if (available)
  conformance("microsandbox", {
    backend: () => microsandboxBackend(),
    fetch: (url) =>
      `python3 -c "import urllib.request as u; print(u.urlopen('${url}', timeout=10).status)"`,
    network: process.env.NYLORUN_TEST_NETWORK !== "0",
  });
else
  describe("microsandbox sandbox conformance", () => {
    it.skip(enabled ? "microsandbox is unavailable on this machine" : "set NYLORUN_TEST_MICROSANDBOX=1 to run", () => {});
  });
