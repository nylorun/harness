# Nylorun Harness

Nylorun Harness is a provider-neutral, in-memory agent loop for TypeScript. The published package lives in [`harness/`](./harness) as [`@nylorun/harness`](https://www.npmjs.com/package/@nylorun/harness).

> **Experimental beta.** The public API is intentionally experimental until 1.0. Install the current beta with `npm install @nylorun/harness@beta`.

## Use Harness

Read the package [quick start](./harness/README.md), [loop model](./harness/docs/loop.md), [model-call projection](./harness/docs/model-call-projection.md), and [public reference](./harness/docs/reference.md).

## Development

Harness supports Node.js 22.14, 24, and 26 or later.

```sh
npm ci
npm run check
```

The root workspace currently contains Harness only. Studio and Create Agent are planned as future sibling packages and are not part of this repository release.

## Community and security

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Use [GitHub Discussions](https://github.com/nylorun/harness/discussions) for questions and ideas, [Issues](https://github.com/nylorun/harness/issues) for reproducible bugs or feature requests, and [SECURITY.md](./SECURITY.md) for vulnerability reporting.

Licensed under [Apache-2.0](./LICENSE).
