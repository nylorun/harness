import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Directories and files that never travel, excluded **by construction** rather than by a builder
 * remembering. `.env` is the one that matters most: an archive is uploaded, and a credential that
 * reaches an object store is a credential that has left the machine.
 */
export const EXCLUDED = Object.freeze([
  ".env",
  ".git",
  ".hg",
  ".svn",
  ".nylo",
  "dist",
  "node_modules"
]);

export type ArchiveEntry = Readonly<{ path: string; bytes: number }>;

export type Archive = Readonly<{
  /** gzipped tar, deterministic for identical inputs. */
  data: Uint8Array;
  digest: string;
  entries: readonly ArchiveEntry[];
  excluded: readonly string[];
}>;

function isExcluded(name: string): boolean {
  return EXCLUDED.includes(name) || name.endsWith(".tgz");
}

async function collect(root: string, directory: string, found: string[], skipped: string[]): Promise<void> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = directory === "" ? entry.name : posix.join(directory, entry.name);
    if (isExcluded(entry.name)) {
      skipped.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) await collect(root, relativePath, found, skipped);
    else if (entry.isFile()) found.push(relativePath);
  }
}

/** One 512-byte ustar header, with everything a clock or a user id could vary pinned to a constant. */
function header(path: string, size: number): Uint8Array {
  const block = Buffer.alloc(512, 0);
  const write = (value: string, offset: number, length: number): void => {
    block.write(value.slice(0, length), offset, length, "utf8");
  };
  const octal = (value: number, offset: number, length: number): void => {
    write(value.toString(8).padStart(length - 1, "0"), offset, length);
  };

  write(path, 0, 100);
  octal(0o644, 100, 8); // mode
  octal(0, 108, 8); // uid — normalized
  octal(0, 116, 8); // gid — normalized
  octal(size, 124, 12);
  octal(0, 136, 12); // mtime — normalized, which is what makes two archives digest alike
  write("        ", 148, 8); // checksum placeholder
  write("0", 156, 1); // regular file
  write("ustar", 257, 6);
  write("00", 263, 2);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/**
 * Builds the authoring archive: the builder's project as she wrote it, minus what must never leave.
 *
 * Determinism is the point rather than a nicety — two publishes of an unchanged project from two
 * machines must digest identically, which is what makes "nothing changed" detectable and lets the
 * store be content-addressed.
 */
export async function createAuthoringArchive(projectRoot: string): Promise<Archive> {
  const found: string[] = [];
  const skipped: string[] = [];
  await collect(projectRoot, "", found, skipped);
  found.sort();
  skipped.sort();

  const blocks: Uint8Array[] = [];
  const entries: ArchiveEntry[] = [];
  for (const path of found) {
    const contents = await readFile(join(projectRoot, ...path.split(posix.sep)));
    blocks.push(header(path, contents.byteLength));
    blocks.push(contents);
    const remainder = contents.byteLength % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
    entries.push(Object.freeze({ path, bytes: contents.byteLength }));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two empty blocks close a tar

  // Node's gzip writes a zero mtime into the header, so the compressed bytes stay deterministic too.
  const data = gzipSync(Buffer.concat(blocks), { level: 9 });
  return Object.freeze({
    data,
    digest: createHash("sha256").update(data).digest("hex"),
    entries: Object.freeze(entries),
    excluded: Object.freeze(skipped)
  });
}

/** Present for symmetry with the other two artifacts, which are read rather than built. */
export async function readArtifact(projectRoot: string, name: string): Promise<Uint8Array | undefined> {
  try {
    const path = join(projectRoot, "dist", name);
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

export function relativeToProject(projectRoot: string, absolute: string): string {
  return relative(projectRoot, absolute).split(sep).join(posix.sep);
}
