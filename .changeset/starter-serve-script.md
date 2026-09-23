---
"@nylorun/create-agent": minor
---

Generated projects run `nylorun serve` for `npm start` and plain `nylorun studio`, which
resolves the active Runtime scope instead of a hardcoded loopback URL. The starter README
explains that the Runtime keeps running after `npm run dev` stops, that a source edit
re-registers agents rather than restarting the host, and that `npx nylorun down` stops it.
Release preparation must update the creator CLI compatibility pin with this release.
