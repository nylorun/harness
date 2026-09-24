import { describe, expect, it } from "vitest";
import {
  LAUNCHER_ERROR_EXIT_CODES,
  exitCodeForLauncherError,
  exitCodeForStatusState,
} from "../../src/runtime/exit-codes.js";
import { ERROR_CODES } from "@nylorun/agents";

describe("F1-4 launcher error → CLI exit code table", () => {
  it.each([
    ["foreign_port", 4],
    ["host_start_failed", 7],
    ["incompatible_host", 5],
    ["protocol_unsupported", 5],
    ["version_required", 1],
    ["install_failed", 1],
    ["integrity_mismatch", 1],
    ["lock_timeout", 1],
    ["host_unresponsive", 1],
    ["host_schema_newer", 1],
    ["host_format_newer", 1],
    ["downgrade_refused", 1],
    ["upgrade_failed", 1],
    ["active_work", 1],
    ["platform_unsupported", 1],
  ] as const)("%s → exit %i", (code, exit) => {
    expect(exitCodeForLauncherError(code)).toBe(exit);
    expect(LAUNCHER_ERROR_EXIT_CODES[code]).toBe(exit);
  });

  it("covers every launcher-raised ERROR_CODES entry", () => {
    const launcherCodes = [
      "version_required",
      "platform_unsupported",
      "install_failed",
      "integrity_mismatch",
      "lock_timeout",
      "foreign_port",
      "host_unresponsive",
      "host_start_failed",
      "host_schema_newer",
      "host_format_newer",
      "downgrade_refused",
      "active_work",
      "upgrade_failed",
    ];
    for (const code of launcherCodes) {
      expect(ERROR_CODES).toContain(code);
      expect(exitCodeForLauncherError(code)).toBeTypeOf("number");
    }
  });

  it.each([
    ["running", undefined],
    ["stopped", 3],
    ["absent", 3],
    ["foreign-port", 4],
    ["unresponsive", 1],
  ] as const)("status state %s → %s", (state, code) => {
    expect(exitCodeForStatusState(state)).toBe(code);
  });
});
