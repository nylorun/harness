import { HarnessError } from "../errors.js";
import type { JsonObject, JsonValue } from "../types/shared.js";

export function assertJson(value: unknown, path = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new HarnessError("json.invalid-data", `${path} must be plain JSON data`, {
        details: { path },
      });
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined)
        throw new HarnessError("json.invalid-data", `${path}.${key} cannot be undefined`, {
          details: { path: `${path}.${key}` },
        });
      assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new HarnessError("json.invalid-data", `${path} must be JSON-serializable`, {
    details: { path },
  });
}

export function copyJson<T>(value: T): T {
  assertJson(value);
  if (Array.isArray(value)) return Object.freeze(value.map((item) => copyJson(item))) as T;
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)])),
    ) as T;
  }
  return value;
}

export function copyJsonObject(value: unknown, path: string): JsonObject {
  assertJson(value, path);
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new HarnessError("json.invalid-object", `${path} must be a JSON object`, {
      details: { path },
    });
  return copyJson(value) as JsonObject;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
