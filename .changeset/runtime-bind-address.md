---
"@nylorun/runtime": patch
---

Add `--host` and `--allowed-hosts` to `nylorun dev` and `nylorun start`, with
`HOST` and `ALLOWED_HOSTS` environment equivalents. Loopback binds now answer only
to their own address on the chosen port, so local development needs no setup on
any port while DNS-rebinding pages are rejected. Publish with `--host 0.0.0.0` or
list proxy host names to deploy on your own servers.
