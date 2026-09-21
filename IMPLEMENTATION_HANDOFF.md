# OSS release implementation handoff

Package architecture follow-up: [design](docs/design/package-architecture.md).
Definitions/contracts now live in core and the local launcher lives in CLI. SDK
and OSS host dependencies follow that document. Cloud installs published packages
from npm independently; this repo does not coordinate Cloud vendor artifacts.


2026-09-20. Latest scope: the minimal local developer release, against **Target Architecture and Development Roadmap v1.1**.

The preceding core-runtime pass was **Build/startup verification only; functional correctness and end-to-end behavior remain unverified.** This follow-up adds the focused local acceptance results below. Those results supersede that restriction only for the exercised local workflow; they do not complete M0–M6 functional gates.

## Built in this pass

- **CLI:** `configure`, `dev`, `start`, and `studio --runtime-url` use the new architecture. The registry exports definitions; a separate SQLite Runtime process executes the shared engine, while the project process connects customer tools through the SDK. Source edits restart the stack. Compiled start loads `dist/agents/index.js` and runs headless.
- **Credentials:** generated application-server and exact scoped executor credentials in `.nylorun/local-credentials.json` (0600); persistent SQLite in `.nylorun/runtime.sqlite`. Credentials remain outside browser configuration.
- **Creator/default examples:** SDK, Runtime, Zod, optional Studio, one order-lookup tool, Node 24, updated scripts/configuration and synchronized provenance. Advanced examples are preserved in source and a separate historical registry, outside the default release registry.
- **Studio:** existing sidebar/layout with registered agents, sessions, text input, history, completed replies, tool inputs/results, cancellation, and canonical SSE. Its local proxy allowlists session operations and rejects executor claims/results. A build guard excludes harness engine modules from the browser bundle.
- **Runtime integration:** authenticated local agent/session discovery and tool-detail event payloads; existing pi-model provider connected to the core host; deterministic tool fixture for release checks.
- **Release tooling:** SDK included in package ordering, dependency bump propagation, compatibility pins and artifact checks. Changesets record breaking beta intent. CI prepares Chromium and targets Node 24+. Deployment/Worker qualification is deferred.
- **Cleanup/regressions:** migrated removed `agent.run()` call sites to explicit engine execution, retaining behavioral assertions. Hosted incompatibility errors now use structured HarnessError codes. Cloud-specific Agents API client modules are removed from OSS Runtime.

Pre-existing foundations from the core pass: shared contracts/definitions/hosted engine, SDK session and SSE executor implementation, SQLite checkpoint/action/command persistence and coordination. This pass integrated those foundations into the developer workflow; it did not newly implement all runtime durability behavior.

Breaking migration: remove the starter Hono app and old `serveAgents`/`Runtime`/`openSession` usage; adopt the SDK registry and session-first API. No automatic session-file migration or active-session upgrade.

## Architecture status

“Built” means code exists. Local acceptance is explicitly limited to the scenarios below; no full roadmap milestone is declared complete.

| Target area / milestone | Implementation status | Built evidence | Pending implementation | Verification required |
|---|---|---|---|---|
| Harness isolation/contracts / M0 | Built | Four harness entry points, structured errors, SDK import and Studio bundle guards | External contract/conformance tooling | Full schema/version/profile matrix |
| Shared engine and independent hosts / M1 | Built | Existing hosted engine; core Runtime/provider integration | Broader model profiles | Hosted hook/output semantics and equal behavior on both hosts |
| SDK and SSE executor / M2 | Built | Actual packed customer tool execution and HTTP results | Progress/remote convenience APIs | Reconnect, competing claims, lease loss, duplicate/conflicting results |
| OSS persistence/coordination / M2 | Partial | SQLite, scoped credentials, command receipts, history after ordinary restart | Pagination/retention, credential administration, uncertainty reconciliation | Contention, authorization matrix, commit/event ordering |
| Recovery/waits/cancellation / M3 | Partial | Existing recovery/uncertainty code; Studio cancel action; ordinary clean restart exercised | Timed/external wakeups and reconciliation workflows | Crash windows, approvals/responses, cancellation races, stale effects |
| CLI/creator/Studio/distribution / M4 | Built | Fresh packed starter, browser tool flow, compiled start, headless mode, setup and release-preparation checks | npm publication; deployment packaging deferred | Live configured-provider acceptance; published-registry install after release |
| Compatibility/migration/conformance / M5 | Partial | Distinct protocol/schema/checkpoint versions; release pins; migrated regressions | External conformance runner, support matrix, session export/import | Cross-runtime and upgrade/migration gates |
| Managed pilot / M6 | Deferred by scope | No new public managed operations | Out of scope for this OSS repo | Not an OSS release gate |

## Run and verification

Prerequisites: Node **24**, npm **11**. Browser acceptance uses Chrome or `NYLORUN_CHROME_PATH`; Linux CI installs Chromium with `npx playwright-core install --with-deps chromium`.

```sh
npm run setup
npm run configure
npm run dev
# Generated project, or examples:
npm run build
npm start
```

CLI configuration: `MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY`, optional `MODEL_PROVIDER_BASE_URL`; `PORT` defaults to 8787. Studio chooses 4161–4260. `NYLORUN_IMPLEMENTATION_VERSION` defaults to `dev`. `NYLORUN_DEV_MODEL=fixture` is only the deterministic order-tool release fixture. Explicit standalone host/SDK credentials and destination variables are documented in the package READMEs.

Passed:

- `npm run build`: five packages, including Studio browser/server.
- `node scripts/validate.mjs check --built`: formatting, type checks, **155 harness + Runtime + creator + example + tooling tests**; package allowlists/import boundaries and installed harness declarations; example build and provenance.
- `node create-agent/scripts/smoke-starter.mjs`: exact local tarballs installed outside the workspace; Studio and headless starters compile; real browser sends input; shared engine requests a customer tool through SSE/claim/HTTP result; Studio displays result; follow-up sees history; reload restores it; source edit restarts/registers the new definition; compiled start preserves history and executes another tool; headless startup/shutdown and missing-configuration error. Checks private credential mode, absent browser secrets, rejected executor proxy routes and rejected cross-origin mutations.
- `node scripts/smoke-development.mjs`: repository supervisor with temporary supported example, Runtime/Studio readiness, IPv4 same-origin proxy mutation, shutdown and released ports.
- `node scripts/smoke-setup.mjs`: clean temporary checkout installs/builds; simulated release preparation updates creator/pins/lockfiles and preserves authored files and local credentials. No commit/publication performed.
- SDK engine-import check and Studio engine-exclusion build; `git diff --check`.

The local checkout contains an existing legacy `examples/.env/` directory. Direct root development reports the existing migration error until it is converted to the documented `.env` file layout. Its credentials were left untouched. Fresh starter and supervisor acceptance used isolated projects.

No live provider requests, crash qualification, cross-runtime conformance or npm publication. Changesets/version preparation on the real branch and published-registry verification remain release operations.

## Artifacts and publish boundary

Tested local versions: harness **0.14.0-beta.3**, SDK **0.1.0-beta.1**, Runtime **0.5.0-beta**, Studio **0.5.0-beta**, creator **0.6.0-beta**. These are local candidate bytes, not republished versions. Changesets advance release versions and exact dependency pins before publication. Local artifact digests and browser screenshot are recorded under `.tmp/release-local/`. The verified local harness artifact SHA-256 is `f04f17322fab9b0cec5638e596de96817fd92acb8624cb4ae25f104ec3d5c7ee`.

Cloud upgrades by installing published npm packages in its own repository. This OSS handoff does not track private vendor tarballs or digest sync. Package versions remain distinct from protocol 1, definition schema 2, hosted checkpoint 1 and engine hosted-1.

## Remaining implementation and testing handoff

**Missing/deferred implementation:** live definition upgrades; bounded history/retention; timed/external wait wakeups; uncertainty reconciliation; managed credential rotation; progress transport; external conformance; session export/import; deployment packaging/ingress; advanced Studio UI/media/approvals; advanced-example migration; managed-pilot operations (out of scope for this OSS repo).

**Implemented but not qualified:** hosted hooks and structured output across remote boundaries, broad provider support, approval/response/cancellation semantics, executor reconnect/lease/duplicate-result fencing, contention/authorization, event ordering, and crash recovery. Existing unit tests are regression evidence, not substitutes for these gates.

Later functional agent priorities:

1. Real configured-provider text/tool conversation; history, instructions, structured output, hook order/state and errors.
2. SSE reconnect and rediscovery, notification ordering, lease renewal/loss, competing claims, duplicate/conflicting results and scope/version mismatch.
3. Approvals/responses/denials, cancellation races, uncertainty visibility and crash/restart windows without repeating ambiguous effects.
4. Empty/history cursors, command idempotency, authorization, event ordering and supported checkpoint/definition compatibility on the local Runtime path.
