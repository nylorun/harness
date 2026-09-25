import assert from "node:assert/strict";
import test from "node:test";
import { browserCommand, openBrowser } from "../dist/browser.js";

test("the browser opener suits the platform, using wslview inside WSL", () => {
  assert.equal(browserCommand("darwin", {}), "open");
  assert.equal(browserCommand("linux", {}), "xdg-open");
  assert.equal(browserCommand("linux", { WSL_DISTRO_NAME: "Ubuntu" }), "wslview");
});

test("a missing browser opener is reported instead of crashing Studio", async () => {
  const reported = await new Promise<string>((resolve) => {
    openBrowser(
      "http://127.0.0.1:4161/v/0.0.0/#studio=1&port=4161&token=t",
      "nylorun-no-such-browser-opener",
      resolve,
    );
  });
  assert.match(reported, /nylorun-no-such-browser-opener/);
  assert.match(reported, /open the Studio URL above/);
});
