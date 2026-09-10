import { describe, expect, it } from "vitest";
import { parse } from "../dist/arguments.js";

describe("creator arguments", () => {
  it("configures by default, including with --yes", () => {
    expect(parse(["demo"]).skipConfig).toBe(false);
    expect(parse(["demo", "--yes"])).toMatchObject({
      yes: true,
      skipConfig: false,
    });
  });
  it("combines explicit skipping with the existing startup options", () => {
    expect(
      parse(["demo", "--skip-config", "--no-studio", "--no-open"]),
    ).toMatchObject({
      skipConfig: true,
      studio: false,
      open: false,
    });
  });
  it("rejects unknown options", () => {
    expect(() => parse(["demo", "--skip-conf"])).toThrow("Usage:");
  });
});
