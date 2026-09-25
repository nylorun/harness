/**
 * Root Hosted Studio entry.
 * Paired URLs (#studio=1&port=&token=) redirect into /v/<latest>/ keeping the fragment.
 * Unpaired visits show the welcome guide.
 */
(function () {
  const boot = document.getElementById("boot");
  const welcome = document.getElementById("welcome");
  const status = document.getElementById("status");

  function showWelcome(message) {
    if (boot) boot.hidden = true;
    if (welcome) welcome.hidden = false;
    if (message && status) status.textContent = message;
  }

  function hasPairingFragment(hash) {
    if (!hash || hash === "#") return false;
    const params = new URLSearchParams(
      hash.startsWith("#") ? hash.slice(1) : hash,
    );
    const studio = params.get("studio");
    const port = params.get("port");
    const token = params.get("token");
    return (
      studio !== null &&
      port !== null &&
      token !== null &&
      /^[A-Za-z0-9_-]{43}$/.test(token)
    );
  }

  async function redirectPaired(hash) {
    try {
      const response = await fetch("/versions.json", {
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) throw new Error("versions " + response.status);
      const manifest = await response.json();
      const version =
        typeof manifest.latest === "string" && manifest.latest
          ? manifest.latest
          : null;
      if (!version) throw new Error("missing latest");
      const target = "/v/" + encodeURIComponent(version) + "/" + hash;
      location.replace(target);
    } catch {
      showWelcome(
        "Could not load a Studio build yet. Keep this tab open and retry the URL from your terminal.",
      );
    }
  }

  const hash = location.hash || "";
  if (hasPairingFragment(hash)) {
    void redirectPaired(hash);
    return;
  }
  showWelcome();
})();
