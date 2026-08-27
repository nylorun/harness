import { describe, expect, it } from "vitest";
import { isFailure, parseArgs, type Args, type ParseFailure } from "../../src/local/runtime/cli/args.js";

function ok(argv: string[]): Args {
  const parsed = parseArgs(argv, "/tmp/project");
  if (isFailure(parsed)) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed;
}

function bad(argv: string[]): ParseFailure {
  const parsed = parseArgs(argv, "/tmp/project");
  if (!isFailure(parsed)) throw new Error("expected a failure");
  return parsed;
}

describe("nylo argument parsing", () => {
  it("defaults to help when nothing is asked for", () => {
    expect(ok([]).command).toBe("help");
    expect(ok(["--help"]).command).toBe("help");
    expect(ok(["serve", "-h"]).command).toBe("help");
  });

  it("keeps positionals after the command, in order", () => {
    expect(ok(["runs", "show", "abc"]).positionals).toEqual(["show", "abc"]);
    expect(ok(["adapter", "probe", "harness"]).positionals).toEqual(["probe", "harness"]);
  });

  it("reads flags that take values, and refuses the ones that are missing theirs", () => {
    const parsed = ok(["serve", "--port", "8080", "--project", "/example"]);
    expect(parsed.port).toBe(8080);
    expect(parsed.project).toBe("/example");
    expect(bad(["serve", "--port"]).error).toContain("--port");
    // A following flag is not a value: `--project --json` is a mistake, not a directory named --json.
    expect(bad(["serve", "--project", "--json"]).error).toContain("--project");
  });

  it("refuses a port that is not a port", () => {
    expect(bad(["serve", "--port", "0"]).error).toContain("not a port");
    expect(bad(["serve", "--port", "notanumber"]).error).toContain("not a port");
    expect(ok(["serve", "--port", "8080"]).port).toBe(8080);
  });

  it("names an unknown command and an unknown flag rather than ignoring either", () => {
    expect(bad(["deploy"]).error).toContain("Unknown command deploy");
    expect(bad(["serve", "--turbo"]).error).toContain("Unknown option --turbo");
    expect(bad(["dev"]).error).toContain("Unknown command dev");
    expect(bad(["invoke"]).error).toContain("Unknown command invoke");
  });

  it("defaults the project to the working directory it was given", () => {
    expect(ok(["build"]).project).toBe("/tmp/project");
    expect(ok(["build", "--project", "/elsewhere"]).project).toBe("/elsewhere");
  });

  it("carries the boolean flags each command reads", () => {
    const parsed = ok(["serve", "--json", "--strict", "--yes"]);
    expect(parsed).toMatchObject({ json: true, strict: true, yes: true });
    expect(ok(["publish", "--no-promote"]).noPromote).toBe(true);
    expect(ok(["build", "--check"]).check).toBe(true);
  });
});
