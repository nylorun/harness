import { describe, expect, it } from "vitest";
import { parse } from "../dist/arguments.js";

describe("creator arguments", () => {
  it("installs by default, including with --yes", () => {
    expect(parse(["demo", "--yes"])).toMatchObject({
      yes: true,
      studio: true,
    });
  });
  it("can create a headless project", () => {
    expect(parse(["demo", "--no-studio"])).toMatchObject({
      studio: false,
    });
  });
  it("opens Studio by default and supports suppressing the browser", () => {
    expect(parse(["demo"])).toMatchObject({ studio: true, open: true });
    expect(parse(["demo", "--no-open"])).toMatchObject({ open: false });
  });
  it("rejects unknown options", () => {
    expect(() => parse(["demo", "--skip-config"])).toThrow("Usage:");
    expect(() => parse(["demo", "--studio"])).toThrow("Usage:");
  });
});
