import { tool } from "@nylorun/harness";
import { z } from "zod";
import { DockerWorkspace } from "../services/docker.js";

export function sandboxTools(workspaces: Map<string, DockerWorkspace>) {
  const workspace = (sessionId: string): DockerWorkspace => {
    const found = workspaces.get(sessionId);
    if (found) return found;
    const created = new DockerWorkspace();
    workspaces.set(sessionId, created);
    return created;
  };

  return {
    id: "sandbox",
    instructions: [
      "All workspace commands run in an isolated, network-disabled Docker container. Use safe relative paths only.",
    ],
    tools: [
      tool({
        name: "list_files",
        description: "List files in the isolated Docker workspace.",
        parameters: z.object({}),
        async execute(_, context) {
          try {
            return {
              kind: "completed" as const,
              output: { files: await workspace(context.sessionId).list() },
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
      tool({
        name: "read_file",
        description: "Read a UTF-8 file from the isolated workspace.",
        parameters: z.object({ path: z.string().min(1).max(200) }),
        async execute({ path }, context) {
          try {
            return {
              kind: "completed" as const,
              output: { path, content: await workspace(context.sessionId).read(path) },
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
      tool({
        name: "write_file",
        description: "Write a UTF-8 file to the isolated workspace after approval.",
        parameters: z.object({ path: z.string().min(1).max(200), content: z.string().max(20_000) }),
        async execute({ path, content }, context) {
          if (context.resume?.approved === false) {
            return { kind: "denied" as const, reason: "The user declined the workspace write." };
          }
          try {
            await workspace(context.sessionId).write(path, content);
            return {
              kind: "completed" as const,
              output: { path, bytes: Buffer.byteLength(content) },
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
      tool({
        name: "run_shell",
        description: "Run a shell script inside the isolated Docker workspace.",
        parameters: z.object({ script: z.string().min(1).max(4_000) }),
        async execute({ script }, context) {
          try {
            return {
              kind: "completed" as const,
              output: await workspace(context.sessionId).shell(script, context.signal),
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
    ],
  } as const;
}

function failure(error: unknown) {
  return {
    kind: "failed" as const,
    code: "sandbox.unavailable",
    message: error instanceof Error ? error.message : "Docker sandbox unavailable.",
  };
}
