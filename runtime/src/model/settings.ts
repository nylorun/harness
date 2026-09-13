import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Selection } from "./models.js";

export function modelSelection(root = process.cwd()): Selection {
  const {
    MODEL_PROVIDER: provider,
    MODEL: model,
    MODEL_PROVIDER_BASE_URL: baseUrl,
  } = process.env;
  if (provider !== undefined || model !== undefined || baseUrl !== undefined) {
    if (!provider?.trim() || !model?.trim())
      throw new Error(
        "Set both MODEL_PROVIDER and MODEL, or run nylorun configure."
      );
    if (provider === "custom" && !baseUrl?.trim())
      throw new Error("Set MODEL_PROVIDER_BASE_URL for MODEL_PROVIDER=custom.");
    if (baseUrl && provider !== "custom")
      throw new Error(
        "MODEL_PROVIDER_BASE_URL requires MODEL_PROVIDER=custom."
      );
    if (baseUrl) {
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new Error("MODEL_PROVIDER_BASE_URL must be an HTTP(S) URL.");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("MODEL_PROVIDER_BASE_URL must be an HTTP(S) URL.");
    }
    return { provider, model, ...(baseUrl ? { custom: { baseUrl } } : {}) };
  }
  try {
    let contents: string;
    try {
      contents = readFileSync(join(root, ".env", "model.json"), "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR"].includes(String(error.code))
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
  for (const directory of [".nylorun", ".env"])
    try {
      const collect = (value: unknown): void => {
        if (typeof value === "string") values.push(value);
        else if (value && typeof value === "object")
          Object.values(value).forEach(collect);
      };
      collect(
        JSON.parse(readFileSync(join(root, directory, "auth.json"), "utf8"))
      );
    } catch {
      /* The vault may not exist before setup. */
    }
  return values;
}
