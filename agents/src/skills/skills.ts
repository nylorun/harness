import { basename } from "node:path";
import type { CapabilityDeclaration } from "@nylorun/core/define";
import { formatSkillCatalog, SKILLS_USAGE } from "./catalog.js";
import {
  loadSkillsFromDirectory,
  resolveSkillsRoot,
  type SkillDiagnostic,
} from "./load.js";

export interface SkillsOptions {
  /** Capability id. Defaults to the catalog directory basename. */
  readonly id?: string;
}

export interface SkillsCapability extends CapabilityDeclaration {
  readonly diagnostics: readonly SkillDiagnostic[];
  /** Absolute catalog directory that was loaded. */
  readonly root: string;
}

/**
 * Load an agentskills.io catalog folder and return one capability for `Agent.use`.
 *
 * Expected layout:
 * ```
 * assistant-skills/
 *   lookup-order/SKILL.md
 *   refund/
 *     SKILL.md
 *     references/policy.md
 * ```
 *
 * Sets both `skills` (manifest names/descriptions) and `skillRecords` (bodies +
 * resources) so callers do not duplicate content. The harness injects
 * `load_skill` / `read_skill_resource` from the records.
 */
export function skills(
  directory: string,
  options: SkillsOptions = {}
): SkillsCapability {
  const root = resolveSkillsRoot(directory);
  const diagnostics: SkillDiagnostic[] = [];
  const records = loadSkillsFromDirectory(root, diagnostics);
  const listed = Object.values(records);
  const id = options.id ?? basename(root);
  if (listed.length === 0) {
    return { id, root, diagnostics };
  }
  const skillManifest = Object.fromEntries(
    listed.map((skill) => [
      skill.name,
      { name: skill.name, description: skill.description },
    ])
  );
  return {
    id,
    root,
    instructions: [
      SKILLS_USAGE,
      formatSkillCatalog(
        listed.map((skill) => ({
          name: skill.name,
          description: skill.description,
        }))
      ),
    ],
    skills: skillManifest,
    skillRecords: records,
    diagnostics,
  };
}
