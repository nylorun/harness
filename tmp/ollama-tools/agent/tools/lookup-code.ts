import { defineTool } from "@nylorun/runtime";
import { z } from "zod";

export default defineTool({
  description: "Resolve a validation code to a deterministic marker.",
  input: z.object({ code: z.string() }),
  run({ code }) {
    const marker = `resolved-${code}`;
    console.log("[tool] lookup-code", code, "=>", marker);
    return { marker };
  },
});
