import { Harness } from "@nylorun/harness";
import { Run } from "@nylorun/runtime";

export default Run(
  (options) => new Harness(options),
  {
    name: "ollama-simple",
    model: "local/gemma4:e2b-mlx"
  }
);
