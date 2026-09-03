import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  decodeImageBase64,
  validateImageBytes,
} from "../services/media.js";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);

describe("examples media validation", () => {
  it.each([
    ["image/jpeg", jpeg],
    ["image/png", png],
    ["image/webp", webp],
  ] as const)("accepts a canonical %s payload", (mediaType, bytes) => {
    expect([
      ...decodeImageBase64(mediaType, Buffer.from(bytes).toString("base64")),
    ]).toEqual([...bytes]);
  });

  it("rejects malformed or non-canonical base64", () => {
    expect(() => decodeImageBase64("image/png", "not-base64!")).toThrow(
      "canonical base64",
    );
    expect(() => decodeImageBase64("image/png", "iVBORw0KGgo")).toThrow(
      "canonical base64",
    );
    expect(() => decodeImageBase64("image/png", "iVBORw0KGgo===")).toThrow(
      "canonical base64",
    );
  });

  it("rejects a MIME/signature mismatch and oversized output", () => {
    expect(() => validateImageBytes("image/png", jpeg)).toThrow("do not match");
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(png);
    expect(() => validateImageBytes("image/png", oversized)).toThrow("8 MiB");
  });
});
