# Contributing to Nylorun Harness

Thanks for contributing. The public workspace contains [`@nylorun/harness`](./harness) and [`@nylorun/studio`](./studio).

## Development workflow

Use Node.js 22.19 or newer for the full workspace, then run:

```sh
npm ci
npm run check
```

The core package itself continues to support Node.js 22.14, 24, and 26 or later. Run a package-specific gate with `npm run check --workspace @nylorun/<package>`.

Keep changes focused, include tests for behavioral changes, and update the affected package README, reference documentation, and changelog when the public API or observable behavior changes. Open a pull request using the provided template and include a concise compatibility and release note.

## Contributions

By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](./LICENSE). No contributor license agreement is required.

For vulnerabilities, do not open a public issue; follow [SECURITY.md](./SECURITY.md).
