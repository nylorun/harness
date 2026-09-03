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

## Releases

Releases use two manual GitHub Actions workflows so version changes still pass through the protected `main` branch:

1. Run **Prepare package release** from `main`. Select `harness`, `studio`, or `both`; choose
   `beta` or `stable`; select the version action; and start with `dry_run` enabled to inspect the
   calculated versions. Beta releases accept `major`, `minor`, or `patch` and create new base
   prereleases (`beta.0` for Harness and `rc.0` for Studio). Stable releases accept only `promote`,
   which removes an existing prerelease suffix.
2. Run it again with `dry_run` disabled to create the release PR. Merge that PR after CI passes.
3. Run **Publish package release** from `main`, select the same package scope, and confirm the
   publication. It rechecks the packages, publishes prereleases to npm's `beta` tag (stable releases
   to `latest`), then creates generated GitHub Releases.

Harness tags use `v<version>`; Studio tags use `studio-v<version>`. The workflows reject already
published npm versions and do not rewrite changelogs.

## Contributions

By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](./LICENSE). No contributor license agreement is required.

For vulnerabilities, do not open a public issue; follow [SECURITY.md](./SECURITY.md).
