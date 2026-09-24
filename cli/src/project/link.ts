import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isTenantId } from "@nylorun/agents";
import { CliError } from "../errors.js";

/** Project-local link to a Runtime Host Tenant (§7). */
export interface ProjectLink {
  hostUrl: string;
  hostId: string;
  tenantId: string;
}

export function nylorunDir(projectRoot: string): string {
  return join(projectRoot, ".nylorun");
}

export function linkPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "link.json");
}

export function credentialsPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "credentials.json");
}

/**
 * Create `.nylorun/` mode 0700 with a private `.gitignore` containing `*`.
 * The Project's own `.gitignore` is never edited (F1).
 */
export async function ensureProjectNylorunDir(
  projectRoot: string,
): Promise<string> {
  const dir = nylorunDir(projectRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 }).catch(
    async () => {
      /* already present is fine; rewrite to keep `*` */
      await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
    },
  );
  return dir;
}

export async function readLink(
  projectRoot: string,
): Promise<ProjectLink | undefined> {
  try {
    const value = JSON.parse(await readFile(linkPath(projectRoot), "utf8"));
    if (
      typeof value?.hostUrl !== "string" ||
      typeof value?.hostId !== "string" ||
      typeof value?.tenantId !== "string" ||
      !isTenantId(value.tenantId)
    ) {
      throw new CliError(
        `Invalid Project link at ${linkPath(projectRoot)}. Remove .nylorun/link.json and run nylorun dev.`,
        1,
      );
    }
    return {
      hostUrl: value.hostUrl.replace(/\/$/, ""),
      hostId: value.hostId,
      tenantId: value.tenantId,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeLink(
  projectRoot: string,
  link: ProjectLink,
): Promise<void> {
  await ensureProjectNylorunDir(projectRoot);
  const path = linkPath(projectRoot);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(
    {
      hostUrl: link.hostUrl.replace(/\/$/, ""),
      hostId: link.hostId,
      tenantId: link.tenantId,
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeLink(projectRoot: string): Promise<void> {
  await rm(linkPath(projectRoot), { force: true });
}
