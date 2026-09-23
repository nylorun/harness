---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

Let a running Runtime learn its executors instead of receiving them all at startup.
`PUT /v1/executors` registers or rotates scoped executor credentials with the application
credential, `DELETE /v1/executors/:agentId` removes one, and `GET /v1/executors` lists them
without disclosing secrets. Registrations persist in SQLite with the token hashed at rest and
are restored on the next start; scopes supplied through `NYLORUN_EXECUTORS_JSON` still apply
to that process, take precedence for their agent, and are never written to the database. An
unchanged registration is idempotent and keeps open streams, while a rotation ends the
replaced token's work stream and stops it authorizing. Unauthenticated `/health` now also
reports the Runtime version, a non-reversible scope digest of the database path, and the
process id; all three are optional in the contract so an older host still parses. Token
hashing is adequate only because these credentials are high-entropy values minted by the
host; it is not a password derivation.
