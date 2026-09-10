import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  root,
  readJson,
  writeJson,
  node,
  npm,
  verifyToolchain,
} from "./lib/repo.mjs";
import { developmentOptions, develop } from "./lib/development.mjs";

export async function renderPreview({ repo = root, studio = true } = {}) {
  const { starterFiles } = await import(
    pathToFileURL(join(repo, "create-agent/dist/scaffold.js")).href
  );
  await mkdir(join(repo, ".tmp"), { recursive: true });
  const project = await mkdtemp(join(repo, ".tmp/starter-"));
  const compatibility = await readJson(
    join(repo, "create-agent/compatibility.json"),
  );
  for (const [path, content] of Object.entries(
    await starterFiles(compatibility, studio),
  )) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = await readJson(join(project, "package.json"));
  for (const name of ["harness", "runtime"])
    manifest.dependencies[`@nylorun/${name}`] =
      `file:${join(repo, name).replaceAll("\\", "/")}`;
  if (studio)
    manifest.devDependencies["@nylorun/studio"] =
      `file:${join(repo, "studio").replaceAll("\\", "/")}`;
  await writeJson(join(project, "package.json"), manifest);
  return project;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = developmentOptions(process.argv.slice(2));
    await verifyToolchain();
    await node("scripts/validate.mjs", ["build"]);
    const project = await renderPreview({ studio: options.studio });
    console.log(
      `Starter preview: ${project}\nTemplate changes require a new preview; this directory will be retained.`,
    );
    await npm(["install"], { cwd: project });
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    const app = await develop(options, {
      project,
      signal: controller.signal,
      built: true,
    });
    process.exitCode = await app.done;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
