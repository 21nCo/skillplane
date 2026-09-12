# Local workspaces and agent projections

Skillplane's local client runs on Node 22.13–24 on macOS or Linux. It needs no
cloud account, Postgres, Worker, or network for local workspaces. SQLite stores
transactional metadata; canonical ZIP bundles are immutable and addressed by
SHA-256. Node 22 currently prints an experimental SQLite warning.

## Install and initialize

From a checked-out repository with dependencies installed:

```sh
pnpm client:install
# Ensure ~/.local/bin is on PATH, then in your project:
skillplane init Personal --target codex
# Alternatively: skillplane init Personal --target claude
```

The installer builds one standalone executable and refuses to replace an existing
executable. To test a different destination, build with `pnpm client:bundle`, then
run `node scripts/install-local-client.mjs /your/empty/bin`. It does not download or
execute a remote installation script. The single bundled artifact is suitable for
a future signed bootstrap/desktop installer; release signing and distribution are
separate from installing a source checkout.

Private state defaults to `~/.skillplane`; `SKILLPLANE_HOME` or `--home` selects a
different installation. Credentials never enter that database or `skillplane.json`.
`--project` selects a project without changing directory. Setup is idempotent and
preserves an existing project configuration. `Runtime.setup` and `Runtime.configure`
are the same exported operations for CLI and a future desktop setup frontend.
There is no second desktop authority or separate native desktop application in this
repository.

## Create, retrieve, amend, and review

Create `new-skill.json`:

```json
{
  "slug": "review",
  "name": "Review",
  "description": "Review changes carefully",
  "instructions": "Read the changes and explain problems.",
  "idempotencyKey": "create-review-1"
}
```

```sh
skillplane create new-skill.json
skillplane list
skillplane retrieve SKILL_ID
skillplane sync
```

Creation publishes an initial immutable `1.0.0`, matching the existing cloud domain
service. The returned ID is the stable skill ID. Amendments use the same request
shape as `skill_amend`, excluding `caller` (declared by the CLI), with an exact
`skillId`, `baseVersionId`, idempotency key, bump, digest-checked file changes, and
learning rationale/evidence. Obtain file SHA-256 values from `retrieve`'s manifest.

```sh
skillplane amend amendment.json
skillplane candidates SKILL_ID
skillplane decide decision.json
```

`decision.json` supplies `skillId`, `reviewId`, `expectedUpdatedAt`, `approve`,
`reason`, and `idempotencyKey`. Local review IDs are candidate version IDs. Cloud
review IDs come from the cloud review record. Rejected or superseded bases are
never silently rebased. Local amendments require review; cloud amendments follow
the workspace's existing authorization and approval policies, including trusted
auto-publication. Both reuse the domain's initial bundle construction, file-operation
validation, learning validation, canonicalization, and semantic version arithmetic.

Cloud contexts remain available through existing MCP operations. Local amendments
reject cloud context references rather than pretending that context provenance was
verified locally.

Explicit `export SKILL_ID FILE [VERSION_ID]` and `import FILE IDEMPOTENCY_KEY` move
canonical bundles between authorities. Import creates a new skill identity in the
primary workspace; it does not replicate, merge, or overwrite an existing slug.

## Multiple accounts and sources

Register a named profile by piping a bearer token from your secret manager:

```sh
secret-manager-command | skillplane profile add work https://mcp.skillplane.dev/mcp ACCOUNT_ID
skillplane profile list
```

macOS uses Keychain; Linux uses Secret Service through `secret-tool`. There is no
plaintext file fallback. Tokens pass through stdin, never command arguments.
Profiles bind the alias, endpoint, and account identifier; changing that identity
requires a new alias. Rotating a token within the same profile is supported. A
workspace reference includes its immutable workspace ID, endpoint, and profile.
No cloud operation selects a workspace by slug.

Edit a separate configuration document and apply it with `skillplane configure FILE`:

```json
{
  "formatVersion": 1,
  "primary": { "provider": "local", "id": "LOCAL_WORKSPACE_UUID" },
  "mounts": [
    {
      "workspace": {
        "provider": "cloud",
        "profile": "work",
        "endpoint": "https://mcp.skillplane.dev/mcp",
        "id": "workspace:EXACT_ID"
      },
      "namespace": "work"
    }
  ],
  "aliases": {},
  "collisions": "error",
  "targets": [{ "adapter": "codex" }]
}
```

All creation, import, amendment, and review operations use the single explicit
`primary`. Mounts are read sources in order. Same-name skills fail before projection
unless given a namespace, an alias keyed by `QUALIFIED_WORKSPACE/SKILL_ID` from
`list`, or explicit `"collisions": "precedence"`. Precedence gives the primary
priority, then each mount in order. No failure causes a write to another account.

## Supported targets

| Adapter        | Project directory             | User directory              | Invocation / freshness                       |
| -------------- | ----------------------------- | --------------------------- | -------------------------------------------- |
| Claude         | `.claude/skills`              | `~/.claude/skills`          | `/name`; dynamic CLI injection               |
| Codex          | `.agents/skills`              | `~/.agents/skills`          | `$name`; instruction-driven check            |
| Generic export | Explicit `directory` required | Explicit directory required | Host-dependent discovery; instruction-driven |

Use `"scope": "user"` for a user target. `directory` overrides the destination.
Optional `skills` lists visible names to project; omit it to project the catalog.
This also permits separate per-skill pinned policies in multiple target entries.
Names are lowercase and at most 64 characters; use an explicit alias for longer
source slugs. Claude's reserved `synced` name is rejected.

Claude metadata affecting tools, model, invocation, execution context, and hooks is
preserved only after trust review. Targets that cannot represent those restrictions
reject the projection rather than silently dropping them. Generic export requires
a host capable of following directory symlinks and reading sibling resources; it
makes no promise of native slash commands. Capability references:
[Claude skills](https://code.claude.com/docs/en/skills) and
[Codex skills](https://learn.chatgpt.com/docs/build-skills).

## Freshness and trust

Each entry points to a self-contained generation with `SKILL.md`, `projection.json`,
and `snapshot/` containing the complete canonical bundle. The manifest records
exact workspace/skill/version identity, canonical digest, synchronization time,
policy, and trust envelope. No resolver program is copied into each skill folder.

A projection chooses exactly one source: live CLI, live MCP, cached CLI, then
embedded snapshot. Matching live digests produce `useEmbedded: true` and no duplicate
instructions. A permitted newer version returns its instructions and exact resource
directory and queues a refresh for the next `sync`; it does not overwrite the
currently parsed host metadata during invocation. Never combine live instructions
with older embedded assets.

Policies in a target:

- `{"mode":"resilient","version":{"kind":"latest"}}`: prefer live, allow disclosed fallback.
- `{"mode":"strict-live","version":{"kind":"latest"}}`: successful live resolution required.
- `{"mode":"pinned","version":{"kind":"pinned","id":"EXACT_VERSION_ID"}}`: never advance.
- `{"mode":"resilient","version":{"kind":"compatible","major":1}}`: latest published version in major 1.

The permission envelope conservatively tracks frontmatter, script-capable files
(including scripts outside `scripts/`), declared destinations, and execution/tool
statements. Changes that expand this envelope create a pending approval. Initial
projections with permission-bearing content also require approval:

```sh
skillplane doctor
skillplane approve-trust PROJECTION_ID EXACT_PENDING_DIGEST
skillplane sync
```

Approval is scoped to an exact digest, never a blanket allow flag. Even approved
frontmatter changes must be installed by `sync` before invoking. This is a
conservative metadata check, not a semantic proof that natural-language instructions
are safe. Skill content is untrusted, and execution still requires host/user
permissions. Ordinary document text changes are permitted by policy; arbitrary
natural-language intent cannot be inferred with certainty.

CLI/MCP absence and expired credentials leave permitted snapshots usable. Cached
and embedded use disclose the exact version and unverified freshness. An access
rejection, digest mismatch, missing version, or trust block is not treated as an
outage. Agents can skip instruction-driven checks: deterministic freshness is not
claimed for Codex or generic targets, or when a host cannot execute Claude injection.
For local authorities, MCP cannot manufacture access to the local-only workspace.

## Ownership, atomicity, and recovery

Generations live in `.skillplane-projections` beside the discovery directory, outside
agent scanning. The visible skill directory is a relative symlink. A fully written,
fsynced generation becomes visible through one atomic symlink rename. Old and new
files never mix. Each skill is atomic; a multi-skill sync may finish some entries
before another fails. Re-running sync safely completes the remaining work.

A SQLite journal survives a crash before the state commit. `doctor`, `resolve`, or
`sync` reconcile a completed swap; a staged but uninstalled generation is retained
for inspection. Hash inventories detect edited/extra files. Existing unmanaged
folders, divergent projections, and symlinks in destination ancestors are refused.
`rollback ID` restores the previous verified bundle and pins it so the next invocation
does not immediately advance again. An explicit later `sync` uses project policy.
Uninstall removes only the verified owned discovery link. Local authority and old
generations remain intact. Copy/export a projected directory with symlinks
dereferenced when moving it outside its original parent layout.

`doctor --online` additionally checks source freshness and credentials. Offline
`doctor` checks ownership, missing/corrupt content, pending approvals/refreshes, CLI
availability, and local project collisions; cloud catalog checks are explicitly
marked unchecked.

## Honest observed analytics

`skillplane usage` reports installation, resolution, observed invocation, instrumented
action, completion report, and independently verified success as separate event types.
Delivery mode, confidence, declared agent/model, and pseudonymous installation are
separate fields. Projection installation never increments an invocation counter.
Retrieval success does not establish task success. Disconnected embedded invocations
cannot be counted and are explicitly excluded from completeness claims.

Events queue transactionally and remain local by default. `usage-record FILE` accepts
an instrumented action or completion event, with the full event fields displayed by
the exported `usageEventSchema`; it cannot assert independently verified success.
Only the independent-verifier integration can record that local event type. Cloud
MCP rejects verified-success assertions from client uploads.

```sh
skillplane usage-consent on
skillplane usage-upload
skillplane usage-consent off
```

Upload selects events for the exact primary **cloud** workspace, sends authenticated
`skill_usage_report` requests, and marks only acknowledged IDs uploaded. Per-event
receipts make retries idempotent, including loss of a batch acknowledgment. Cloud
stores client events with `reported` confidence regardless of client claims. Local
workspace events remain local; no implicit workspace association or identity upload
is performed. The cloud dashboard describes its observed API/MCP coverage.

Ephemeral agents still use MCP discovery, retrieval, creation, amendments, contexts,
and usage reporting with scoped credentials. They require no local database or
projection. Native invocation syntax remains a host capability.

## Verification

```sh
pnpm --filter @skillplane/local-runtime test:unit
pnpm --filter @skillplane/local-runtime typecheck
pnpm test:mcp:contract
NODE_OPTIONS=--conditions=development pnpm --filter @skillplane/mcp exec vitest run tests/integration/local-provider-contract.test.ts
```

The local suite includes a packaged executable installed into a temporary directory,
offline authority, immutable amendments, multi-account routing, trust expansion,
projection interruption recovery, ownership/symlink security, and analytics replay.
The MCP integration suite uses the repository's disposable test database to exercise
the actual cloud domain and authorization contracts.
