import { spawn } from "node:child_process";

const child = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "inherit" });
child.once("error", () => {
  process.stderr.write(
    "Docker is unavailable. Install and start Docker Desktop before using the Docker agents.\n",
  );
  process.exitCode = 1;
});
child.once("exit", (code) => {
  if (code !== 0) {
    process.stderr.write(
      "Docker daemon is unavailable. The Docker agent manifests remain visible in Studio.\n",
    );
    process.exitCode = code ?? 1;
  }
});
