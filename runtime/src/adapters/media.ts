import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  decodeImageBase64,
  validateImageBytes,
  type MediaAsset,
  type MediaReference,
} from "../media.js";
export * from "../media.js";
interface StoredMediaAsset extends MediaAsset {
  readonly createdAt: number;
}

/** Explicit local asset store; agents receive only opaque references. */
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
  return value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/u.test(value);
}

export function localMedia(options: { root?: string } = {}): MediaStore {
  return new MediaStore(options.root ?? join(process.cwd(), ".data", "media"));
}
