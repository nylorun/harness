/**
 * Pack studio/dist/web into a deterministic POSIX ustar archive (P8).
 * Writes dist/bundle.tar and dist/ui-digest.json { version, sha256 }.
 * Node built-ins only; idempotent over one dist/web tree.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const studioRoot = fileURLToPath(new URL("..", import.meta.url));

const BLOCK = 512;
const USTAR_MAGIC = Buffer.from("ustar\0", "utf8");
const USTAR_VERSION = Buffer.from("00", "utf8");

function walkFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Split a path into ustar name (≤100) and prefix (≤155). */
function splitName(archivePath) {
  if (Buffer.byteLength(archivePath, "utf8") <= 100)
    return { name: archivePath, prefix: "" };
  const parts = archivePath.split("/");
  let prefix = "";
  let name = archivePath;
  for (let i = 1; i < parts.length; i++) {
    const candidatePrefix = parts.slice(0, i).join("/");
    const candidateName = parts.slice(i).join("/");
    if (
      Buffer.byteLength(candidatePrefix, "utf8") <= 155 &&
      Buffer.byteLength(candidateName, "utf8") <= 100
    ) {
      prefix = candidatePrefix;
      name = candidateName;
    }
  }
  if (
    Buffer.byteLength(name, "utf8") > 100 ||
    Buffer.byteLength(prefix, "utf8") > 155
  )
    throw new Error(`Path too long for ustar: ${archivePath}`);
  return { name, prefix };
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "utf8");
  buffer[offset + length - 1] = 0;
}

function ustarHeader(archivePath, size) {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(archivePath);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // deterministic mtime
  header.fill(0x20, 148, 156); // checksum field as spaces while summing
  header[156] = 0x30; // typeflag '0' = regular file
  USTAR_MAGIC.copy(header, 257);
  USTAR_VERSION.copy(header, 263);
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const checksum = sum.toString(8).padStart(6, "0");
  header.write(checksum, 148, 6, "utf8");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padToBlock(size) {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export function packUi({
  root = studioRoot,
  web = join(root, "dist/web"),
  outBundle = join(root, "dist/bundle.tar"),
  outDigest = join(root, "dist/ui-digest.json"),
} = {}) {
  if (!existsSync(web))
    throw new Error(`Missing ${web}; run the Studio web build first.`);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = manifest.version;
  if (typeof version !== "string" || !version)
    throw new Error("studio/package.json is missing version.");

  const files = walkFiles(web)
    .map((file) => ({
      file,
      archivePath: relative(web, file).split(sep).join("/"),
    }))
    .sort((a, b) => (a.archivePath < b.archivePath ? -1 : 1));
  if (files.length === 0) throw new Error(`No files under ${web}.`);

  const chunks = [];
  for (const { file, archivePath } of files) {
    const content = readFileSync(file);
    const size = statSync(file).size;
    if (size !== content.length)
      throw new Error(`Size mismatch packing ${archivePath}`);
    chunks.push(ustarHeader(archivePath, size));
    chunks.push(content);
    const pad = padToBlock(size);
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));

  const tarball = Buffer.concat(chunks);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(outBundle, tarball);
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const digest = { version, sha256 };
  writeFileSync(outDigest, `${JSON.stringify(digest, null, 2)}\n`);
  return digest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const digest = packUi();
  console.log(
    `Packed Studio UI bundle (${digest.version}, sha256 ${digest.sha256.slice(0, 12)}…).`,
  );
}
