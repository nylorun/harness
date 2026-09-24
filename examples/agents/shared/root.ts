import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the examples package root (parent of `agents/`). */
export const EXAMPLES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
