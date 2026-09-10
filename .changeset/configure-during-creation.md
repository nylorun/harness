---
"@nylorun/create-agent": minor
"@nylorun/runtime": patch
---

Configure the provider and model after project installation and before development
starts. Add --skip-config for deferred setup and require it for noninteractive
creation. Retain the project with recovery instructions when setup fails or is
cancelled, and cancel pending prompts, authentication, and child processes on
shutdown.
