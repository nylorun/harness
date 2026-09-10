# `@nylorun/studio`

Local developer Studio for Nylorun agents.

See [docs.nylorun.com](https://docs.nylorun.com) for installation, configuration, and usage.

## Package independence

Studio exposes `startStudio()` and has no engine or Runtime dependency. The `nylorun` executable is supplied by `@nylorun/runtime`; Studio no longer publishes `nylo`. Runtime loads the application-installed Studio for development or dashboard attachment. Studio accepts neutral version-2 manifests as well as legacy `harness.manifest` documents.

Repository development: [contributing](../CONTRIBUTING.md). Package publication: [releasing](../RELEASING.md).
