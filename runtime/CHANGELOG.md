# Changelog

## 0.1.1-beta

### Patch Changes

- 54ab304: Configure the provider and model after project installation and before development
  starts. Add --skip-config for deferred setup and require it for noninteractive
  creation. Retain the project with recovery instructions when setup fails or is
  cancelled, and cancel pending prompts, authentication, and child processes on
  shutdown.
- 54ab304: Add `--host` and `--allowed-hosts` to `nylorun dev` and `nylorun start`, with
  `HOST` and `ALLOWED_HOSTS` environment equivalents. Loopback binds now answer only
  to their own address on the chosen port, so local development needs no setup on
  any port while DNS-rebinding pages are rejected. Publish with `--host 0.0.0.0` or
  list proxy host names to deploy on your own servers.
- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

Release notes are maintained with Changesets.
