import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Selection } from "./models.js";

export function modelSelection(root = process.cwd()): Selection {
  try {
    let contents: string;
    try {
      contents = readFileSync(join(root, ".env", "model.json"), "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      contents = readFileSync(join(root, "config", "model.json"), "utf8");
    }
    const value = JSON.parse(contents);
    if (
      typeof value.provider === "string" &&
      value.provider &&
      typeof value.model === "string" &&
      value.model &&
      (value.custom === undefined || typeof value.custom.baseUrl === "string")
    )
      return value;
  } catch {
    /* Report one actionable setup error without file or credential contents. */
  }
  throw new Error("Run nylorun configure to connect a model provider.");
}
export function projectSecrets(root = process.cwd()): readonly string[] {
  const values = Object.entries(process.env)
    .filter(([key]) => /key|token|secret|password|credential/i.test(key))
    .flatMap(([, value]) => (value ? [value] : []));
  try {
    const collect = (value: unknown): void => {
      if (typeof value === "string") values.push(value);
      else if (value && typeof value === "object")
        Object.values(value).forEach(collect);
    };
    collect(JSON.parse(readFileSync(join(root, ".env", "auth.json"), "utf8")));
  } catch {
    /* The vault may not exist before setup. */
  }
  return values;
}
