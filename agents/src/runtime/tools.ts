import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { describeTools } from "../manifest.js";
import { isToolDefinition } from "../tool.js";
import type { Json, ToolChunk, ToolRegistration } from "../session/index.js";
import type { ToolDefinition, ToolDescriptor } from "../types.js";

export type ToolModule = Readonly<{ file: string; exports: Record<string, unknown> }>;

/**
 * Renders one value produced by `run` as tool output. A string passes through verbatim so a
 * streamed sequence concatenates naturally; anything else becomes one NDJSON line, so a stream of
 * objects stays parseable rather than collapsing into `[object Object]`.
 */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return `${JSON.stringify(value)}\n`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * Bridges a typed `defineTool` module to the loop's `ToolRegistration`.
 *
 * Descriptors are re-derived here by the same function the build calls, rather than read back from
 * `nylo.manifest.json`. Holding the live definition is unavoidable — it is what gets validated and
 * invoked — so re-deriving makes build-time and run-time schemas the same value by construction,
 * where reading the manifest would make them two values that agree until they don't.
 */
export function bridgeTools(modules: readonly ToolModule[]): {
  registrations: ToolRegistration[];
  descriptors: ToolDescriptor[];
} {
  const descriptors = describeTools(modules);
  const registrations = descriptors.map((descriptor) => {
    const module = modules.find((entry) => entry.file.replace(/\.tsx?$/u, "") === descriptor.name);
    const definition = module?.exports.default;
    if (!isToolDefinition(definition)) {
      throw new NyloBuildError(
        diagnostic(
          "NYLO_RUN_TOOL_MISSING",
          "run",
          "error",
          `agent/tools/${descriptor.name}.ts`,
          `The built bundle describes a tool "${descriptor.name}" whose module has no usable default export.`,
          "Rebuild the project so the bundle and its tool modules agree."
        )
      );
    }

    if (descriptor.sandbox) {
      // Refused when the project is opened rather than partway through a session: a builder should
      // learn a tool cannot run before a model has already decided to call it.
      throw new NyloBuildError(
        diagnostic(
          "NYLO_RUN_SANDBOX_UNSUPPORTED",
          "run",
          "error",
          `agent/tools/${descriptor.name}.ts`,
          `Tool "${descriptor.name}" declares sandbox: true, and no local sandbox exists.`,
          "Remove sandbox: true to run this tool locally with your own authority, or run the agent hosted."
        )
      );
    }

    const typed = definition as ToolDefinition;
    let calls = 0;

    const registration: ToolRegistration = {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema as ToolRegistration["inputSchema"],
      async *execute(input: Json, context): AsyncIterable<ToolChunk> {
        calls += 1;
        if (descriptor.maxCallsPerSession !== undefined && calls > descriptor.maxCallsPerSession) {
          // Reported to the model rather than thrown: a spent budget is something for it to route
          // around, not a host failure that should end the session.
          yield {
            stream: "stderr",
            text: `Tool "${descriptor.name}" reached its limit of ${descriptor.maxCallsPerSession} calls for this session.`
          };
          yield { exitCode: 1 };
          return;
        }

        // The loop validates against the JSON Schema, but that projection is deliberately lossy —
        // `assertSchemaSubset` rejects the keywords it cannot represent. Zod is the contract `run`
        // is typed against, so it is what the arguments are checked with.
        const parsed = typed.input.safeParse(input);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          yield { stream: "stderr", text: `Invalid arguments for "${descriptor.name}": ${issues}` };
          yield { exitCode: 1 };
          return;
        }

        try {
          const output = typed.run(parsed.data, { signal: context.signal });
          if (isAsyncIterable(output)) {
            for await (const value of output) yield { stream: "stdout", text: render(value) };
          } else {
            yield { stream: "stdout", text: render(await output) };
          }
          yield { exitCode: 0 };
        } catch (cause) {
          if (typed.onErrorMessage !== undefined) {
            // The field exists to control what the model is told, so the real message is withheld.
            yield { stream: "stderr", text: typed.onErrorMessage };
            yield { exitCode: 1 };
            return;
          }
          throw cause;
        }
      }
    };
    return registration;
  });

  return { registrations, descriptors };
}
