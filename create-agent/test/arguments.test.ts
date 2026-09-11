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
  it("combines explicit skipping with Studio selection", () => {
    expect(parse(["demo", "--skip-config", "--no-studio"])).toMatchObject({
      skipConfig: true,
      studio: false,
    });
  });
  it("opens Studio by default and supports suppressing the browser", () => {
    expect(parse(["demo"])).toMatchObject({ studio: true, open: true });
    expect(parse(["demo", "--no-open"])).toMatchObject({ open: false });
  });
  it("rejects unknown options", () => {
    expect(() => parse(["demo", "--skip-conf"])).toThrow("Usage:");
    expect(() => parse(["demo", "--studio"])).toThrow("Usage:");
  });
});
