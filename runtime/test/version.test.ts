import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SDK_VERSION } from "../src/manifest.js";

describe("version", () => {
  // `SDK_VERSION` is a second place the version is written, and it feeds the manifest digest —
  // so a drift between the two silently changes every recorded digest without changing the package.
  it("matches the package manifest", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
  });
});
