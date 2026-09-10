# Changelog

## 0.4.0-beta

### Minor Changes

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
