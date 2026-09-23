---
"@nylorun/cli": minor
---

Remove `nylorun start`. The compiled agent process is now `nylorun serve [entry]`, with the
same `dist/agents/index.js` default, and generated projects must change `scripts.start` to
`nylorun serve`. The local Runtime becomes a persistent process of its own under
`nylorun runtime start|stop|status|logs`, with `nylorun up` and `nylorun down` as aliases.
`dev` and `serve` attach to that Runtime, start one when nothing is listening, and leave it
running, so a watch restart re-registers agents and reconnects executors instead of
destroying in-flight sessions; `--no-autostart` fails instead and is what continuous
integration should use. Scope is per project by default in `.nylorun/`, created on first use,
with `--global` and `NYLORUN_HOME` for a shared Runtime in the home directory. Commands
report a resolved scope in every message, accept `--port` and `--db` alongside the existing
environment variables, expose `nylorun runtime status --output json`, and use documented exit
codes for usage errors, port conflicts, version skew, refused autostart and failed starts.
