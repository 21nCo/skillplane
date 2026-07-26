# PHASE_11 verification evidence

Recorded: `2026-07-26T12:27:09Z`

## Exact phase gates

| Command | Result |
|---|---|
| `pnpm test:unit --filter @skillplane/mcp-schema` | PASS — 1 file, 16 tests |
| `pnpm test:integration --filter mcp-read` | PASS — 1 file, 7 tests |
| `pnpm test:security --filter mcp-read` | PASS — 1 file, 14 tests |
| `pnpm test:mcp:conformance` | PASS — 1 file, 5 tests |
| `pnpm build --filter mcp` | PASS — 12 tasks; Worker dry-run upload 3131.83 KiB / gzip 561.67 KiB |

## Additional gates

| Command | Result |
|---|---|
| `pnpm --filter @skillplane/db test:unit` | PASS — 2 files, 4 tests |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS — 27 tasks |
| `pnpm format:check` | PASS |
| `pnpm db:migrate` | PASS — applied migration 0012 |
| `pnpm db:verify` | PASS — 28 tables, 12 migrations |
| `pnpm boundaries:verify` | PASS — `WORKSPACE_BOUNDARIES_VALID` |
| `pnpm client-secrets:verify` | PASS — `CLIENT_BUNDLES_SECRET_FREE` |

## MCP protocol evidence

- Negotiated protocol: `2025-11-25`.
- Transport: Web Standard Streamable HTTP in stateless JSON response mode.
- Server: `skillplane` / `Skillplane` / `1.0.0`.
- Tools advertised: exactly six.
- Every tool advertises object-rooted input and output JSON Schema.
- Every tool advertises `readOnlyHint=true`, `destructiveHint=false`,
  `idempotentHint=true`, and `openWorldHint=false`.
- Ping, list, and real `skills_search` execution pass through the official SDK
  client.
- Invalid Accept, media type, JSON, protocol version, and HTTP method produce
  standards-shaped safe errors.

## Exact digest proof

The integration fixture created a real canonical archive, persisted it through
`R2BundleRepository`, and retrieved it through the MCP SDK client.

The passing assertions prove:

```text
database skill_versions.content_digest
  == MCP version.digest
  == MCP version.manifest.digest
  == recomputed canonical archive digest
```

The R2 read path additionally proves:

- R2 repository digest verification passed;
- re-canonicalized bytes equal stored canonical bytes byte-for-byte;
- re-canonicalized manifest stable JSON equals the immutable database
  manifest;
- returned `SKILL.md` and file descriptors came from that same archive;
- a forced R2 failure returned `R2_READ_FAILED` and no instructions;
- no alternate or stale version was substituted;
- signed large-asset download returned byte-for-byte fixture content.

## Security and audit evidence

- Missing, revoked, wrong-audience, query-string bearer, insufficient-scope,
  and stale-session requests fail safely.
- Missing caller fields and a caller-supplied `userId` fail schema validation
  before any R2 read.
- Cross-workspace callers can read only published public skill content; private
  skills, contexts, and candidates remain concealed.
- `../`, absolute, and backslash asset paths fail with
  `SKILL_PATH_INVALID` before any R2 read.
- Cursor filter mismatch and signature tampering return distinct stable codes.
- Oversized download grants fail under a different valid credential and
  succeed under the issuing credential.
- An injected generic audit-writer failure maps to
  `AUDIT_WRITE_FAILED`; private instructions, storage details, connection
  strings, and bearer values are absent.
- Successful audit rows keep authenticated actor/credential fields separate
  from the complete caller declaration labeled `caller-declared`.
- A non-delegated service principal records `user_id = NULL` while retaining
  agent/model analytics fields.
- Audit rows contain no skill instructions or bearer values.
