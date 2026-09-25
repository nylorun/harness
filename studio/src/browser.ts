import { spawn } from "node:child_process";

/**
 * The command that opens a URL in the developer's browser. Inside WSL,
 * `wslview` (wslu) opens the Windows browser, which reaches WSL's localhost.
 */
export function browserCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return "open";
  if (env.WSL_DISTRO_NAME) return "wslview";
  return "xdg-open";
}

/**
 * Open `address` in the browser. A missing opener (no xdg-open on a minimal
 * Linux or WSL) is reported, not thrown: the caller has printed the URL.
 */
export function openBrowser(
  address: string,
  command: string = browserCommand(),
  report: (message: string) => void = (message) => console.error(message),
): void {
  const child = spawn(command, [address], { detached: true, stdio: "ignore" });
  child.once("error", () => {
    report(`Could not start ${command} to open a browser; open the Studio URL above.`);
  });
  child.unref();
}
