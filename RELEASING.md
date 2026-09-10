# Releasing npm packages

Packages have independent versions. Every Harness, Runtime, or Studio release
also releases creator with updated compatibility pins. A creator-only release
preserves its existing pins. Nothing publishes on merge or tag push.

## Administrator setup

- Use the toolchain and setup in [CONTRIBUTING.md](./CONTRIBUTING.md).
- Confirm npm organization access for all four `@nylorun` packages.
- Configure each package's npm trusted publisher for this repository,
  workflow `publish.yml`, and GitHub environment `npm`, allowing publication.
- Protect the `npm` environment with administrator reviewers and restrict its
  deployment branch to `main`. Protect `main` with required CI/review checks.
- Ensure GitHub Actions can create package tags and GitHub releases.

These are external settings; checked-in workflow permissions do not configure
them. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
If npm requires an initial authenticated publication before trust can be set up,
an administrator must bootstrap that package using the verified candidate
artifact, then configure trust. Never substitute an untested local build.

## Prepare a release PR

Start from updated `main`, with the intended changesets already committed:

```sh
git switch -c codex/release-next
npm run setup
npm run release:prepare -- --channel beta
npm run release:check
```

Preparation requires a clean branch. It applies Changesets, ensures a creator
bump, updates compatibility pins, synchronizes examples, refreshes both lockfiles,
and writes `.release/plan.json`. It does not commit, push, or publish.

Review and commit the versions, changelogs, compatibility, generated shell,
lockfiles and release plan together. Open a normal PR.
Changesets supplies release intent and changelog entries. The release policy uses
`major.minor.patch-beta` for beta and `major.minor.patch` for stable, with no
numeric prerelease counter. Packages remain independently versioned. Fixes bump
patch, features bump minor, and breaking changes bump minor before 1.0 or major
afterward. Every changed beta publication advances the numeric core; for example,
`0.11.0-beta` plus a patch becomes `0.11.1-beta`.

Historical numbered prereleases are accepted as inputs, but their numeric core
is bumped rather than stripping the counter and moving backward. Legacy Changesets
prerelease state is retired during preparation, without replaying consumed intent.
Use `release:prepare`, not `changeset version` or `changeset pre`, to apply versions.

For a stable release, use `--channel latest` explicitly. With no pending changes,
this promotes beta packages without changing their numeric core (`0.11.2-beta`
becomes `0.11.2`). Pending changes bump the core according to their impact before
publication. Creator also releases whenever its compatibility pins change.
Review the complete resulting stack; never retag a beta-version package as stable.
Subsequent beta releases use `--channel beta`. The release plan controls publication.

`release:check` validates the exact creator combination, using candidate tarballs
for changed packages and registry versions for unchanged pins. It also exercises
CLI commands and production assets. An unavailable unchanged pin blocks release.
Artifacts are saved under `.tmp/release-artifacts/` for inspection.

## Publish the reviewed commit

1. Merge the release PR after CI passes.
2. Open **Actions → Publish reviewed release → Run workflow** on `main`.
3. Enter the full 40-character SHA of the merge/squash commit that changed the
   release plan. Do not use an unrelated later commit.
4. Review the validated candidate artifacts and approve the `npm` environment.
5. Check the workflow summary, npm versions/dist-tags, and package GitHub releases.

The workflow verifies that the selected commit belongs to `main`, validates the
checkout and exact release stack, and passes those same tarballs to publishing.
Harness/Runtime/Studio publish before creator. The workflow verifies registry
availability and installation through the public creator command without making
model calls. Tags use `@nylorun/<package>@<version>`.

## Recovery

| Failure | Action |
|---|---|
| Preparation interrupted | Review retained changes; restore deliberately or finish the preparation before committing |
| Validation failed | Fix in a reviewed PR and prepare the corrected release |
| Missing npm trust/access | Correct the external setting, then rerun the same workflow |
| Partial publication/network failure | Rerun for the same release commit; matching artifact integrity allows completed packages to be skipped |
| Published integrity differs | Stop; investigate the existing release and prepare a new version |
| Missing/older dist-tag after publication | An npm administrator must verify/correct it, then retry; trusted publishing does not authenticate standalone tag edits |
| A newer dist-tag exists | Do not move it backward; prepare a newer release |
| Public creator smoke or GitHub release creation failed | Inspect the already-published versions, then rerun the same commit |

Publication cannot be treated as an atomic transaction. Do not delete/reuse a
published version to recover. Record the affected versions and ship a corrective
release. Keep credentials and access tokens out of release notes and logs.
