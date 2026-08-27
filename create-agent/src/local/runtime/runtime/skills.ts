import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { digest } from "../manifest.js";
import type { FolderDiagnostic, SkillDescriptor } from "../types.js";
import { diagnostic } from "../diagnostics.js";

export type LoadedSkill = Readonly<{ name: string; description: string; body: string }>;
export type LoadedSkills = Readonly<{
  skills: LoadedSkill[];
  diagnostics: FolderDiagnostic[];
}>;

/**
 * Splits `SKILL.md` the same way the build does, and returns both halves from one read: the build
 * digests the *whole file including its frontmatter*, while the session needs only the body after
 * the closing fence.
 */
function split(contents: string): { description: string; body: string; digest: string } {
  const end = contents.indexOf("\n---", 4);
  const metadata = (end < 0 ? {} : (parseYaml(contents.slice(4, end)) as Record<string, unknown>)) ?? {};
  const afterFence = end < 0 ? 0 : contents.indexOf("\n", end + 1);
  return {
    description: String(metadata.description ?? ""),
    body: afterFence < 0 ? "" : contents.slice(afterFence + 1),
    digest: digest(contents)
  };
}

/**
 * Reads skill bodies from the source tree.
 *
 * The bundle carries no bodies and the manifest carries only digests, so a local run needs the
 * project rather than just `dist/`. Embedding them would change `bundleDigest`, bump the manifest
 * format version, and pre-commit the hosted artifact protocol — the digest check below is the seam
 * through which that later closes.
 */
export async function loadSkills(
  projectRoot: string,
  manifestSkills: readonly SkillDescriptor[]
): Promise<LoadedSkills> {
  const root = join(projectRoot, "agent", "skills");
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ skills: [], diagnostics: [] });
    throw error;
  }

  const skills: LoadedSkill[] = [];
  const diagnostics: FolderDiagnostic[] = [];
  for (const name of names) {
    const file = join("agent", "skills", name, "SKILL.md");
    let contents: string;
    try {
      contents = await readFile(join(root, name, "SKILL.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = split(contents);
    const declared = manifestSkills.find((entry) => entry.name === name);

    // A warning, never a refusal: editing a skill and immediately re-running is the loop this
    // capability exists to serve, and a stale digest is worth reporting, not blocking.
    if (declared !== undefined && declared.digest !== parsed.digest) {
      diagnostics.push(
        diagnostic(
          "NYLO_RUN_SKILL_STALE",
          "run",
          "warning",
          file,
          `Skill "${name}" has changed since the last build; running with the version on disk.`,
          "Rebuild to bring nylo.manifest.json back in step."
        )
      );
    }

    skills.push(
      Object.freeze({
        name,
        description: declared?.description ?? parsed.description,
        body: parsed.body
      })
    );
  }

  return Object.freeze({ skills, diagnostics });
}
