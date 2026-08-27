import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
      })
    )
  ).flat();
}

/** A static `import … from "vite"` that is not erased by `verbatimModuleSyntax`. */
const VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+["']vite["']/mu;

describe("package boundary", () => {
  it("never loads Vite from the export barrel", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(resolve(ROOT, "src", "local", "runtime"))) {
      if (VALUE_IMPORT.test(await readFile(file, "utf8"))) offenders.push(relative(ROOT, file));
    }

    // Vite is a build tool. The barrel is imported by runtime callers that never build —
    // `nylo`, the Agent Server — so `buildAgent` reaches it through `await import("vite")`
    // and everything else takes types only. A static value import here would pull the whole
    // bundler into every consumer's module graph.
    expect(offenders).toEqual([]);
  });

  it("keeps the runtime dependency surface to the declared set", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@ag-ui/core",
      "@ag-ui/encoder",
      "@earendil-works/pi-ai",
      "@nylorun/harness",
      "typebox",
      "yaml",
      "zod"
    ]);
  });
});
