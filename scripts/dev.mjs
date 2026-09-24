import { developmentOptions, develop } from "./lib/development.mjs";
import { verifyToolchain } from "./lib/repo.mjs";

try {
  const options = developmentOptions(process.argv.slice(2));
  await verifyToolchain();
  const controller = new AbortController();
  let app;
  const stop = () => {
    controller.abort();
    if (app) void app.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Uses the shared Host under NYLORUN_HOME or ~/.nylorun. Acceptance and
  // smoke scripts pass a temporary Host root via develop({ hostRoot, home }).
  app = await develop(options, { signal: controller.signal });
  if (controller.signal.aborted) await app.close();
  process.exitCode = await app.done;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
