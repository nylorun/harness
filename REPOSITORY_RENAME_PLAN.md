# Rename `nylorun/harness` to `nylorun/agents`

Audit date: 2026-09-21. This is a proposed migration plan, not a completed rename.
No GitHub settings, npm settings, package releases, deployments, or Git remotes were changed.

## Scope and evidence

Inspected the current public workspace, `NYLORUN-AGENTS-API`, and
`NYLORUN-WEB-PLATFORM`; queried GitHub repository/settings APIs and the npm
registry; fetched the production website and docs; checked official GitHub/npm
documentation. Both the public workspace and website contain active uncommitted
implementation work. File contents are a snapshot, not proof of what is deployed.

The proposed naming boundary is:

| Surface | Proposed treatment |
| --- | --- |
| GitHub repository | `nylorun/agents` |
| Public repository title | Nylorun Agents |
| Main product site | Keep `nylorun.com`; align copy with the approved positioning |
| Documentation | Keep `docs.nylorun.com`; use Nylorun Agents Docs or Nylorun Docs consistently |
| Application SDK | Keep `@nylorun/agents` |
| Execution foundation | Keep `@nylorun/harness` and the `harness/` package directory |
| Runtime, Studio, creator | Keep `@nylorun/runtime`, `@nylorun/studio`, `@nylorun/create-agent` |
| Scaffolding command | Keep `npm create @nylorun/agent@beta my-agent` |
| API/Cloud contracts and domains | No rename required by this repository migration |

This avoids making the repository rename an import/API migration. The separate
SDK/runtime architecture changes already underway still need their own release validation.

## Confirmed live state

- [GitHub repo](https://github.com/nylorun/harness): public, default branch `main`,
  description “A provider-neutral, in-memory agent loop for TypeScript.”,
  homepage `https://nylorun.com/harness`, topics `ai-agents` and `harness`.
- `https://github.com/nylorun/agents` currently returns a 301 to the harness repo.
  The API also resolves that name to harness; the visible organization repository
  listing contains no separate `agents` repository. Recheck rename eligibility at
  cutover; this existing redirect is not itself a reservation guarantee.
- GitHub Pages is disabled. Repository webhook listing returned an empty list.
  An active `Main merge queue` ruleset and protected `npm` environment exist.
- The `npm` environment has a bootstrap token secret configured (only its name
  was inspected). Repository-level Actions secret and variable listings were empty.
  This does not inventory organization-level settings or GitHub App installations.
- [Production website](https://nylorun.com) still leads with Nylorun Harness and
  the older Hono integration example. `/harness` resolves to `/#harness`.
- [Production docs](https://docs.nylorun.com/docs) still call the product Nylorun
  Harness, link to the harness GitHub/npm pages, and list Node 22.19+; the local
  candidate requires Node 24. These docs must be matched to the release they describe.

Registry snapshot (`npm view`, default public registry):

| Package | `latest` and `beta` | Repository metadata |
| --- | --- | --- |
| `@nylorun/harness` | `0.13.0-beta` | old harness URL |
| `@nylorun/runtime` | `0.5.0-beta` | old harness URL |
| `@nylorun/studio` | `0.5.0-beta` | old harness URL |
| `@nylorun/create-agent` | `0.6.0-beta` | old harness URL |
| `@nylorun/agents` | public registry returned E404 | local package exists; first public publication remains a gate |

The E404 is evidence of current public availability, not proof that nobody has
reserved the package name. Verify npm organization rights before scheduling launch.

## Required changes by workstream

### 1. Public repository and GitHub

| Files/settings | Action |
| --- | --- |
| GitHub repository name | Rename the existing repository in place; do not create/copy into a replacement repo |
| GitHub About | Update description, homepage to `https://nylorun.com`, and topics to reflect the complete stack; keep a harness topic if useful |
| `README.md` | Product title, introduction, clone URL, and `cd agents` instructions; explain Agents/Harness/Runtime boundaries |
| All five package manifests | Change `repository.url` to `git+https://github.com/nylorun/agents.git`; retain each `repository.directory` |
| `harness/package.json`, `studio/package.json`, `create-agent/package.json` | Update repository-derived bugs/homepage fields and stale product descriptions; review all five manifests for complete metadata |
| `harness/scripts/check-package.mjs`, `studio/scripts/check-package.mjs` | Update hardcoded expected URLs and description alongside manifests or package validation will fail |
| `.github/workflows/dependabot-automerge.yml` | Change exact `github.repository == 'nylorun/harness'` guard to the new repository; this is a functional fix |
| `.github/ISSUE_TEMPLATE/config.yml` | Update discussions and security advisory links |
| `harness/CHANGELOG.md` | Update current link destinations to the canonical repository while preserving historical release descriptions |
| `package.json`, `package-lock.json` | Optional coherent private workspace rename from `nylorun-harness-workspace` to `nylorun-agents-workspace`; update description |
| `examples/package.json`, `examples/package-lock.json`, `create-agent/examples.recipe.json` | Optional private example name change to `nylorun-agents-examples`; keep recipe and generated output synchronized |
| `create-agent/package.json`, READMEs | Replace umbrella-product “Nylorun Harness” wording; preserve actual harness package documentation |
| `RELEASING.md` | Record the canonical repository and required npm trust configuration |

`scripts/release/publish.mjs` uses `GITHUB_REPOSITORY` for GitHub release API calls,
so that path already adapts to the rename. The checked workflows use third-party
actions; no `uses: nylorun/harness/...` caller was found in the inspected workspaces.
External callers are not exhaustively discoverable from these local searches.

### 2. npm and release identity

For every package being published:

1. Update repository/bugs/homepage metadata and bundled README content in source.
2. Configure a trusted-publisher connection for owner `nylorun`, repository
   `agents`, workflow `publish.yml`, environment `npm`.
3. Preserve permission for direct publication, which this workflow uses.
4. Retain existing trust until the new connection is verified, then remove obsolete
   harness trust. Current npm docs say connections cannot be edited and allow up to
   ten connections per package: add a new connection rather than assuming an edit.
5. For the not-yet-public SDK, verify first-publication/bootstrap access and follow
   the existing reviewed-artifact process in `RELEASING.md`.
6. Release updated metadata through new versions under the existing package names.
   Use this repo's changeset/release preparation policy, not manual version edits.
   A Harness change propagates to SDK/Runtime and creator compatibility pins; inspect
   the generated plan and both lockfiles.

Provenance requires package repository metadata to match the publishing repository.
GitHub redirects alone do not satisfy npm trust configuration. Updating GitHub or
local manifests does not update already-published npm artifacts. Keep historical
versions, attestations and tags; do not unpublish, recreate or overwrite them.
Sources: [npm metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/).

### 3. Website (`NYLORUN-WEB-PLATFORM/website`)

| Files/surface | Action |
| --- | --- |
| `lib/constants.ts` | Update central GitHub URL; optionally rename `HARNESS_GITHUB_URL` to `AGENTS_GITHUB_URL` or `GITHUB_URL` with all imports |
| `lib/faq.ts` | Update three hardcoded repo/package-directory links and product availability claims |
| `components/layout/navbar.tsx`, `components/sections/home/hero.tsx`, `components/mockups/harness-code.tsx` | Verify central-constant consumers lead to the canonical repo |
| `app/layout.tsx`, `app/opengraph-image.tsx` | Page title, description, keywords, Open Graph/social card text and organization links |
| `lib/structured-data.ts` | Software/product identity and repository `sameAs`; update linked schema IDs consistently if changing them |
| `app/page.tsx`, section/mockup components | Finish the approved Agents/Harness/Runtime positioning; validate shown code against the package set being advertised |
| `app/harness/page.tsx` | Keep a compatibility redirect. Recommend permanent redirect to `/`, unless an actual new `/agents` landing page is deliberately introduced |
| Hero `id="harness"` and schema `/#harness` | Preserve old fragment links or provide an anchor alias if changing to `agents`; fragments are client-side |
| `README.md` | Update product description and route documentation |
| `lib/seo.ts`, `app/sitemap.ts`, `app/robots.ts` | Verify canonical URLs and sitemap after the route choice; current sitemap contains `/` and `/privacy` only |

No domain/DNS migration is required. There is no need to create `/agents` solely
because the GitHub repository is renamed. Current local files already contain
substantial uncommitted positioning changes: coordinate with that work.

Analytics events such as `harness_docs_click` and `harness_github_click` exist in
the hero. Keeping them preserves reporting continuity; changing them requires
coordinated dashboard/funnel updates. Component filenames can be cleaned up later.

### 4. Documentation (`NYLORUN-WEB-PLATFORM/docs-site`)

| Files/surface | Action |
| --- | --- |
| `app/layout.tsx`, `lib/shared.ts` | Documentation brand, metadata and social titles |
| `lib/layout.shared.tsx`, `components/docs-header.tsx` | GitHub navigation and primary npm destination; link to `@nylorun/agents` only once publicly available, or clearly identify preview/source setup |
| `content/docs/index.mdx`, `overview.mdx`, `compatibility.mdx` | Product name, package roles, supported versions and prerequisites |
| `content/docs/examples.mdx` | Clone URL, clone directory and all source/example links |
| `content/docs/run-agents/host.mdx`, `troubleshooting.mdx` | Starter source and issue links |
| `content/docs/build-agents/*`, `api-reference/*` | Separate SDK authoring/session APIs from low-level Harness APIs; compile examples against the chosen release |
| `next.config.mjs` | Retain existing redirects; add explicit redirects only for docs routes deliberately moved |
| `app/llms.txt/route.ts`, `app/llms-full.txt/route.ts`, MDX routes | Rebuild generated agent-readable docs from updated source and verify links/content |
| Search index, sitemap, navigation | Rebuild and check the canonical docs paths |

Do not globally replace `/api-reference/harness/...`: those routes can remain the
correct home of the existing `@nylorun/harness` API. Add SDK reference pages where
needed. A repository rename alone does not justify changing working code imports.

The current docs' Node version and examples reflect a different release than the
local architecture candidate. Either ship version-aligned docs with the new beta,
or clearly distinguish published-stable instructions from preview instructions.

### 5. API, hosting and developer environments

The API workspace consumes `@nylorun/harness` through
`vendor/nylorun-harness-0.14.0-beta.3.tgz` and matching lockfile entries. No literal
old GitHub repo URL or local public-checkout path was found in the targeted API
search. Keep imports, archive names, protocol versions and hashes intact for this
rename. If the architecture release replaces that artifact, track it as a separate
compatibility change with its own digest and conformance checks.

The website/docs repository remote is
`onebabai/NYLORUN-WEB-PLATFORM`; the API remote is
`onebabai/NYLORUN-AGENTS-API`. Those repositories do not need renaming. No direct
old-repo reference was found in the targeted Console/API portal search.

Update public-repo clone remotes after cutover:

```sh
git remote set-url origin https://github.com/nylorun/agents.git
git remote -v
git ls-remote origin HEAD
```

Renaming the local `harness` checkout directory is optional. Defer it until active
tasks and worktrees are settled; inventory saved editor/Codex project paths, shell
scripts and absolute paths before moving it.

## External settings still requiring inspection

These are audit gates, not confirmed defects or an assertion every service exists:

- Each npm package's private trusted-publisher settings and organization access.
- GitHub App installations and organization-level secrets, policies, bots and
  integrations. The attempted installation listing did not establish an inventory.
- Name-bound cloud OIDC policies (`repo:nylorun/harness:...`, repository/workflow
  claims); repository-ID-based trust may already survive. [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- Hosting dashboards and Git source bindings, deploy hooks, build filters, coverage
  or security services. Verify whether they track stable repo IDs or literal names.
  The marketing/docs sites live in another repo, so do not reconnect hosting blindly.
- Organization profile, pinned repositories, social profile links, existing
  announcements, badges, templates, external tutorials and any downstream workflow
  callers. No global reverse-link inventory can be guaranteed.
- GitHub environment branch restrictions: reviewers are confirmed; the branch-policy
  endpoint returned 404, so this audit does not establish the restriction settings.

GitHub redirects old web and Git URLs after an in-place rename, preserving repository
history and community links. Never create another `nylorun/harness` repository,
which would replace that redirect. Pages is off here, but GitHub Pages project URLs
are an exception to redirects. Actions/reusable-workflow `uses:` references also
do not follow rename redirects. Sources: [GitHub rename guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository),
[workflow reuse](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).

## Execution sequence and gates

### Phase 1 — Prepare reviewable changes

- [ ] Agree on repo title and docs brand; preserve package names and domains.
- [ ] Settle or isolate the ongoing architecture/website edits before composing release changes.
- [ ] Prepare public-repo URL, metadata, README and workflow changes together.
- [ ] Prepare website/docs changes and legacy redirects in the platform repo.
- [ ] Decide whether SDK publication and architecture docs ship with this cutover or
  later; the rename itself can precede the SDK, but public runnable SDK claims cannot.
- [ ] Inventory external settings above; pre-add new npm trust where supported.
- [ ] Run code/package/site checks and preview changes before renaming.

Suggested review units: (1) public repository identity and automation,
(2) website/docs identity and redirects, (3) reviewed release artifacts and metadata.
Keep architecture fixes out of a rename-only diff where possible.

### Phase 2 — Short coordinated cutover

- [ ] Pause release dispatches during the transition; do not publish old-metadata tarballs after renaming.
- [ ] Recheck target-name eligibility and rename the existing GitHub repo to `agents`.
- [ ] Merge the prepared changes through the existing review/merge-queue process.
- [ ] Update remotes, About metadata and verified name-bound integrations/trust.
- [ ] Confirm CI, merge queue, issue links and Dependabot conditions still work.
- [ ] Prepare the release from a clean branch using `release:prepare`; review the new
  plan, metadata, dependency pins and packed artifacts; run `release:check`.
- [ ] Publish the reviewed SHA through `publish.yml` and the protected `npm` environment.
- [ ] Confirm npm availability before deploying docs/site snippets that depend on new packages.
- [ ] Deploy the prepared website/docs changes and verify production navigation.

### Phase 3 — Acceptance checks

- [ ] New repository page and clone work; old repo, issue and representative source URLs redirect.
- [ ] `npm view` reports the new repository for newly released versions; tags reflect
  the intended channel, with no premature `latest` promotion.
- [ ] Trusted publication succeeds, provenance points to the renamed repository, and
  `npm audit signatures` verifies an installed candidate where supported.
- [ ] A clean temporary project scaffolds through the public creator command, starts
  Runtime/Studio and can follow the documented quickstart with the supported Node version.
- [ ] Public workspace: existing build/check/stack, example synchronization and release
  validation pass for the actual change set; do not add tests for string replacements alone.
- [ ] Website: existing lint/typecheck/build and SEO checks pass. Docs: typecheck/build pass.
- [ ] Production GitHub/npm CTAs, metadata/social preview, `/harness`, `/#harness`,
  docs navigation, sitemap and `llms` endpoints resolve correctly.
- [ ] Rerun targeted stale-URL search; classify legitimate package names, historical
  evidence and compatibility aliases rather than deleting every `harness` occurrence.
- [ ] Remove obsolete npm trust after verification; retain old URL redirects indefinitely.

## Recovery

If CI or npm trust fails, stop releases, correct the URL/identity mismatch and retry
the reviewed workflow; preserve any accepted npm version and inspect registry
integrity before retrying. Website/docs can roll back independently while GitHub
redirects continue serving old links. Prefer fixing forward rather than repeatedly
renaming the repository. If GitHub rename eligibility fails, leave settings and
publication unchanged and resolve the target-name issue first.

## Recommended critical path

Prepare source + docs changes → verify npm access/trust → rename GitHub in place →
merge and validate metadata/workflow changes → publish the reviewed compatible
package set → deploy release-aligned website/docs → verify old/new entry points.
