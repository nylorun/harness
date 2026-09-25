---
"@nylorun/studio": patch
---

Opening the browser no longer crashes Studio when no opener is installed (no `xdg-open` on a minimal Linux or WSL): it reports that and leaves the printed Studio URL to open by hand. Inside WSL, Studio opens the Windows browser with `wslview`.
