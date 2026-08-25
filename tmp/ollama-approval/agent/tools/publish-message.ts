import { defineTool } from "@nylorun/runtime";
import { z } from "zod";

export default defineTool({
  description: "Publish a validation message after Harness approval.",
  input: z.object({ message: z.string() }),
  run({ message }) {
    console.log("[tool] publish-message", message);
    return { published: message };
  },
});
