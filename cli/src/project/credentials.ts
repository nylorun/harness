import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import {
  credentialsPath,
  ensureProjectNylorunDir,
} from "./link.js";

/** Project-local credentials (mode 0600). Never log cleartext keys. */
export interface ProjectCredentials {
  applicationKey: string;
  principalId: string;
  executors: Record<string, string>;
}

export async function readCredentials(
  projectRoot: string,
): Promise<ProjectCredentials | undefined> {
  const path = credentialsPath(projectRoot);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value?.applicationKey !== "string" ||
      typeof value?.principalId !== "string" ||
      !value.executors ||
      typeof value.executors !== "object"
    ) {
      throw new CliError(
        `Invalid Project credentials at ${path}. Remove .nylorun/credentials.json and run nylorun dev.`,
        1,
      );
    }
    await chmod(path, 0o600);
    return {
      applicationKey: value.applicationKey,
      principalId: value.principalId,
      executors: value.executors as Record<string, string>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeCredentials(
  projectRoot: string,
  credentials: ProjectCredentials,
): Promise<void> {
  await ensureProjectNylorunDir(projectRoot);
  const path = credentialsPath(projectRoot);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(
    {
      applicationKey: credentials.applicationKey,
      principalId: credentials.principalId,
      executors: credentials.executors,
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeCredentials(projectRoot: string): Promise<void> {
  await rm(credentialsPath(projectRoot), { force: true });
}
