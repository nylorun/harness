# Runtime distribution: no bundled Node

Status: adopted. Supersedes the per-platform Runtime builds (D6 Node pin, D8
platform packages, D17 build publication) of the Runtime Clients design.

## Context

The Runtime shipped as `@nylorun/runtime-<platform>-<arch>` packages: the
pinned Node, `@nylorun/runtime` with production dependencies, and the
`nylorun-runtime` launcher. Clients downloaded a build on first use, checked it
and unpacked it under `<host root>/runtime/<version>/`.

The bundled Node served one case: desktop apps whose users have no Node. For
developers it was redundant, because `@nylorun/cli` already needs Node 24 to
run. It cost a native build job per platform, a zip or tar extraction path per
operating system (broken on Windows when this was decided), and about 3,500
lines of download, verification and packaging code. None of it reached npm.

## Decision

- The Runtime is the plain npm package `@nylorun/runtime`. Its launcher is the
  package's `nylorun-runtime` bin.
- Developers install two prerequisites themselves: Node 24 or newer, and
  `npm install --global @nylorun/runtime`.
- The launcher starts the Host from its own package on the Node it runs on.
- No component downloads Node or the Runtime. A missing or incompatible
  prerequisite is an error that names the exact install command.
- Clients find `nylorun-runtime` on PATH and check its launcher protocol and
  Host protocol, not an exact version. `@nylorun/cli`'s `nylorun.runtime` is
  the recommended version used in install instructions.

## Consequences

- One platform-independent Runtime package per release. No native build jobs,
  no artifact merge, no Node download, far less release tooling.
- Developers take a one-time setup step. The Host runs on their Node 24.x,
  not exactly the version CI pins; CI covers the pin and the newest Node line.
- A project that adds `@nylorun/runtime` as a devDependency also works: npm
  scripts put `node_modules/.bin` on PATH, so the project pins its Runtime.
- Desktop apps for people without Node are out of scope for version 1.

## Reversal

The launcher's command-line contract (launcher protocol 1: `version`, `up`,
`down`, `restart`, `run`, `status`, `logs` with `--json`) does not depend on
how the Runtime was installed. A bundled distribution can come back as a
separate package that wraps the same launcher without changing clients.
