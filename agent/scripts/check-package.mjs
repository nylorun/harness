import { readdir } from "node:fs/promises";
const allowed = new Set(["LICENSE", "README.md", "package.json", ...await readdir("dist")]);
for (const name of await readdir(".")) if (!allowed.has(name) && !["dist", "src", "scripts", "test", "tsconfig.json", "node_modules"].includes(name)) throw new Error(`Unexpected package file: ${name}`);
console.log("Tarball allowlist passed.");
