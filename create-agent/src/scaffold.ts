import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { Compatibility } from "./contracts.js";

/** The only renderer used by creation, development, and examples synchronization. */
/**
 * npm never packs files named `.gitignore` and treats them as ignore rules for
 * their directory, so the template stores them as `_gitignore`.
 */
function templatePath(path: string): string {
  return path
    .split(sep)
    .map((segment) => (segment === "_gitignore" ? ".gitignore" : segment))
    .join("/");
}

export async function starterFiles(
  compatibility: Compatibility,
  studio: boolean
): Promise<Readonly<Record<string, string>>> {
  const root = fileURLToPath(new URL("./starter/", import.meta.url));
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else
        files[templatePath(relative(root, absolute))] = (
          await readFile(absolute, "utf8")
        )
          .replaceAll("{{HARNESS_VERSION}}", compatibility.harness)
          .replaceAll("{{RUNTIME_VERSION}}", compatibility.runtime)
          .replaceAll("{{STUDIO_VERSION}}", compatibility.studio);
    }
  }
  await walk(root);
  if (!("." + "gitignore" in files))
    throw new Error("Starter template is missing its .gitignore.");
  if (!studio) {
    const manifest = JSON.parse(files["package.json"]!);
    delete manifest.devDependencies["@nylorun/studio"];
    manifest.scripts.dev = "nylorun dev --no-studio";
    delete manifest.scripts.studio;
    files["package.json"] = JSON.stringify(manifest, null, 2) + "\n";
    files["README.md"] = files["README.md"]!.replace(
      "`npm run dev` starts your app on port 3000, waits until its agent endpoint is ready, then starts Studio and opens it in your browser. Use `npm run dev -- --no-open` to start Studio without opening a browser. Run `npm run studio` in another terminal to attach Studio separately.",
      "`npm run dev` starts your app on port 3000."
    );
  }
  return Object.freeze(files);
}
