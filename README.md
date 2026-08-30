# Nylorun Harness

Nylorun Harness is a provider-neutral TypeScript agent loop with direct capability composition.
This repository contains the core package, a loopback-only Studio dashboard, and runnable examples.

> **Experimental beta.** APIs may change before 1.0.

## Packages

- [`@nylorun/harness`](./harness) — model/tool loop and capability composition.
- [`@nylorun/studio`](./studio) — local dashboard for compatible agent servers.
- [`examples`](./examples) — direct-Harness multi-agent starter with Hono, MCP, Docker, skills, and code mode.

## Develop

```sh
git clone https://github.com/nylorun/harness.git
cd harness
npm ci
npm run check
```

See the [Harness package](./harness/README.md), [Studio](./studio/README.md), and
[Examples](./examples/README.md). Contributions follow [CONTRIBUTING.md](./CONTRIBUTING.md);
security reports follow [SECURITY.md](./SECURITY.md).

Licensed under [Apache-2.0](./LICENSE).
