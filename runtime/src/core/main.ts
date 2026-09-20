import { piModel } from "../model/pi-model.js";
import { startRuntime } from "./runtime.js";
import { gatewayModel, scriptedModel, toolFixtureModel } from "./provider.js";
const serverToken = process.env.NYLORUN_SERVER_KEY;
if (!serverToken)
  throw new Error("Set NYLORUN_SERVER_KEY (at least 16 characters)");
const executors = JSON.parse(process.env.NYLORUN_EXECUTORS_JSON ?? "[]");
const configured = piModel();
const projectModel: import("./provider.js").ModelProvider = (effect, signal) =>
  configured(effect.input as any, {
    request: effect.context.request as any,
    invocationId: String(effect.context.invocationId),
    signal,
    reportPreparedCall() {},
  });
const model =
  process.env.NYLORUN_DEV_MODEL === "fixture"
    ? toolFixtureModel()
    : process.env.NYLORUN_PROJECT_PROVIDER === "1"
      ? projectModel
      : process.env.NYLORUN_MODEL_GATEWAY_URL
        ? gatewayModel({
            url: process.env.NYLORUN_MODEL_GATEWAY_URL,
            token: process.env.NYLORUN_MODEL_GATEWAY_KEY ?? "",
            model: process.env.NYLORUN_MODEL ?? "",
          })
        : scriptedModel(process.env.NYLORUN_SCRIPTED_OUTPUT);
const runtime = await startRuntime({
  sqlitePath: process.env.NYLORUN_SQLITE_PATH ?? "./nylorun.sqlite",
  serverToken,
  executors,
  model,
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? "127.0.0.1",
});
console.log(`Nylorun Runtime listening at ${runtime.url}`);
process.send?.({ type: "ready", url: runtime.url });
let closing: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    closing ??= runtime.close().then(() => { process.exit(0); });
  });
