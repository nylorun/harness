import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface MediaAsset {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly kind: "input" | "generated";
}

/** Opaque reference retained by Harness and resolved only by the examples host. */
export interface MediaReference {
  readonly agentId: string;
  readonly assetId: string;
}

interface StoredMediaAsset extends MediaAsset {
  readonly createdAt: number;
}

/** Explicit local asset store used by the examples host; Harness receives only opaque references. */
export class MediaStore {
  constructor(private readonly root: string) {}

  async saveInput(
    agentId: string,
    sessionId: string,
    mediaType: string,
    base64: string,
  ): Promise<MediaAsset> {
    const bytes = decodeImageBase64(mediaType, base64);
    return this.save(agentId, sessionId, "input", mediaType, bytes);
  }

  async saveGenerated(
    agentId: string,
    sessionId: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<MediaAsset> {
    validateImageBytes(mediaType, bytes);
    return this.save(agentId, sessionId, "generated", mediaType, bytes);
  }

  async dataUrl(
    reference: MediaReference,
    sessionId: string,
  ): Promise<{ readonly asset: MediaAsset; readonly url: string } | undefined> {
    const stored = await this.read(
      reference.agentId,
      sessionId,
      reference.assetId,
    );
    if (!stored) return undefined;
    return Object.freeze({
      asset: stored.asset,
      url: `data:${stored.asset.mediaType};base64,${Buffer.from(stored.bytes).toString("base64")}`,
    });
  }

  async latestInput(
    agentId: string,
    sessionId: string,
  ): Promise<MediaAsset | undefined> {
    const directory = this.directory(agentId, sessionId);
    try {
      const metadata = await Promise.all(
        (await readdir(directory))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => this.readMetadata(directory, name)),
      );
      return metadata
        .filter((entry): entry is StoredMediaAsset => entry?.kind === "input")
        .sort((left, right) => right.createdAt - left.createdAt)[0];
    } catch {
      return undefined;
    }
  }

  async read(
    agentId: string,
    sessionId: string,
    assetId: string,
  ): Promise<{ asset: MediaAsset; bytes: Uint8Array } | undefined> {
    if (!safe(agentId) || !safe(sessionId) || !safe(assetId)) return undefined;
    const directory = this.directory(agentId, sessionId);
    const metadata = await this.readMetadata(directory, `${assetId}.json`);
    if (!metadata) return undefined;
    try {
      return {
        asset: metadata,
        bytes: await readFile(join(directory, `${assetId}.bin`)),
      };
    } catch {
      return undefined;
    }
  }

  private async save(
    agentId: string,
    sessionId: string,
    kind: MediaAsset["kind"],
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<MediaAsset> {
    if (!safe(agentId) || !safe(sessionId))
      throw new Error("Invalid media asset scope.");
    const directory = this.directory(agentId, sessionId);
    const asset: StoredMediaAsset = {
      id: randomUUID(),
      mediaType,
      bytes: bytes.byteLength,
      kind,
      createdAt: Date.now(),
    };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${asset.id}.bin`), bytes);
    await writeFile(join(directory, `${asset.id}.json`), JSON.stringify(asset));
    return omitCreatedAt(asset);
  }

  private async readMetadata(
    directory: string,
    name: string,
  ): Promise<StoredMediaAsset | undefined> {
    try {
      const value = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as StoredMediaAsset;
      return validAsset(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private directory(agentId: string, sessionId: string): string {
    return join(this.root, agentId, sessionId);
  }
}

/** Decode one canonical base64 image before it is persisted or sent to a provider. */
export function decodeImageBase64(
  mediaType: string,
  base64: string,
): Uint8Array {
  if (!IMAGE_MEDIA_TYPES.includes(mediaType))
    throw new Error("Only JPEG, PNG, and WebP images are supported.");
  if (typeof base64 !== "string" || base64 === "")
    throw new Error("Image data is required.");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))
    throw new Error("Image data must be canonical base64.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64)
    throw new Error("Image data must be canonical base64.");
  validateImageBytes(mediaType, bytes);
  return bytes;
}

/** Verify the asserted media type and lightweight file signature for a supported image. */
export function validateImageBytes(mediaType: string, bytes: Uint8Array): void {
  if (!IMAGE_MEDIA_TYPES.includes(mediaType))
    throw new Error("Only JPEG, PNG, and WebP images are supported.");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new Error("Images must be no larger than 8 MiB.");
  const signature =
    mediaType === "image/jpeg"
      ? bytes.byteLength >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      : mediaType === "image/png"
        ? bytes.byteLength >= 8 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47 &&
          bytes[4] === 0x0d &&
          bytes[5] === 0x0a &&
          bytes[6] === 0x1a &&
          bytes[7] === 0x0a
        : bytes.byteLength >= 12 &&
          bytes[0] === 0x52 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x46 &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x45 &&
          bytes[10] === 0x42 &&
          bytes[11] === 0x50;
  if (!signature) throw new Error(`Image bytes do not match ${mediaType}.`);
}

function validAsset(value: unknown): value is StoredMediaAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<StoredMediaAsset>;
  return (
    typeof asset.id === "string" &&
    safe(asset.id) &&
    typeof asset.mediaType === "string" &&
    IMAGE_MEDIA_TYPES.includes(asset.mediaType) &&
    typeof asset.bytes === "number" &&
    (asset.kind === "input" || asset.kind === "generated") &&
    typeof asset.createdAt === "number"
  );
}

function omitCreatedAt(asset: StoredMediaAsset): MediaAsset {
  const { createdAt: _createdAt, ...result } = asset;
  return Object.freeze(result);
}

function safe(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/u.test(value);
}
