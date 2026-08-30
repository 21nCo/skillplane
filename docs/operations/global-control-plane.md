# Global control plane and regional workspace cells

Skillplane has one public identity: `https://app.skillplane.dev` is the AuthFn
issuer and `https://mcp.skillplane.dev/mcp` is the MCP resource. Public clients
never receive a regional hostname. The public Workers are gateways; regional
Workers are private service-binding targets.

The production topology is declared in
`deployment/topology.production.json`. Region IDs are Skillplane identifiers,
not provider region names. The initial manifest has `in-south` and `us-east`,
and requires a separate Postgres database and private bundle store per cell.

## Ownership boundaries

The global control database owns users, sessions, AuthFn/OAuth state, workspace
metadata and membership, invitations, service principals, the authoritative
workspace placement directory, the resource-to-workspace routing projection,
DataFn permission-directory records, replay nonces, public skill projections,
control-plane audit records, and topology/migration state.

A regional database owns skills and versions, contexts and notes, amendments,
regional audit and analytics, idempotency records, and its projection outbox.
Its bundle store contains private and workspace-visible bundles. There are no
cross-database foreign keys. A regional `workspace_id` or `user_id` is an
opaque, service-validated reference to global state.

Published public bundles are copied into the global public store by digest.
The projector verifies the regional bytes, performs an immutable destination
write, reads and verifies the destination, and only then updates the global
metadata/search projection. A regional outbox event is accepted only when its
region and fencing epoch still match the active placement.

Each cell runs the exported `drainRegionalProjectionOutbox` consumer against
its regional database. The consumer atomically leases only the oldest pending
event for each workspace, applies the digest-verified global projection, and
acknowledges it afterward. A terminated worker's lease expires for retry;
attempt count and a redacted error code remain operator-visible. Repeated
publication is safe because global object keys are content-addressed and the
metadata write is an upsert. A failed event blocks later events for the same
workspace while unrelated workspaces continue.

This design can state that new regional workspace data is written to the
selected home cell. It must not be described as comprehensive legal data
residency: global identity, membership, routing, public projections, audit
metadata, backups, logs, and provider control-plane metadata remain outside
the regional workspace store.

## Routing and threat model

The placement directory is a linearizable compare-and-set authority with one
writable home and a monotonically increasing epoch. Gateways authenticate and
authorize against global state before resolving placement. They dispatch only
through a private service binding and sign a short-lived assertion containing
the workspace, region, epoch, request ID, method/path, audience, expiry, and a
single-use nonce. Cells verify the signature, audience, placement, epoch, and
nonce before local execution. Caller-supplied internal headers are removed at
public ingress. Cell responses and errors never contain a cell host or storage
destination.

The routing keyring contains one active key and at most two verification-only
keys. Routing keys must be independent of AuthFn and OAuth secrets. Replay
claims are durable in the global database; an in-memory replay cache is not a
production substitute.

AuthFn remains the sole identity/session framework and is configured with its
multi-region plugin. Skillplane uses a global identity authority; the plugin's
canonical-gateway runtime is available when the public edge and the private
control Worker are separated. DataFn supplies placement, signed routing,
permission projection, replay prevention, and fenced migration semantics for
workspace data. Skillplane composes these contracts and does not fork them.

Cloudflare is one adapter, not an application contract. The checked-in
Cloudflare renderer maps the manifest to canonical custom-domain gateways and
private service-bound cells. An alternative platform can bind the same
`RegionalCellRegistry`, placement directory, replay store, and immutable
publication interfaces to mutually authenticated private HTTP/RPC endpoints,
a strongly consistent PostgreSQL-compatible directory, regional SQL stores,
and S3-compatible object stores. The internal RPC transport must preserve the
request method/path and signed assertion, reject public ingress at cells, and
must never advertise its endpoint to clients.

## Failure behavior and SLOs

Routing fails closed:

- missing/invalid credentials: `401`; missing membership/scope: `403`;
- unknown resource/workspace: safe `404` with no placement detail;
- moving or stale epoch: retryable `409`; no old-cell fallback;
- control database, placement, keyring, replay store, or cell unavailable:
  safe `503`; no best-effort regional write;
- a global public projection may continue serving its last verified immutable
  version while a regional cell is unavailable; unpublished/private data may
  not use this path.

Targets: gateway routing p95 under 100 ms excluding regional execution,
placement lookup p99 under 50 ms, control-plane availability 99.95%, regional
cell availability 99.9%, and projection lag p99 under 60 seconds. Alert on
`DATAFN_NAMESPACE_MOVING` older than 15 minutes, any stale-epoch write attempt,
assertion verification/replay failures above baseline, projection lag over 60
seconds, outbox oldest age over five minutes, cell dispatch failures, or
placement cache disagreement.

Every routing/migration log must include request ID, workspace ID (or a stable
non-secret hash where required), region ID, epoch, route family, outcome, and
latency. Never log assertion values, credentials, bundle bytes, database URLs,
internal service targets, or routing keys.

## Workspace move runbook

1. Confirm source placement is `active`, target capacity is healthy, both
   bundle stores are private, backups are current, and no other move is active.
2. Create a `workspace_migration_runs` record and use DataFn's fenced migration
   transition. The first compare-and-set changes the placement to `moving` and
   increments the epoch. Gateways must now return retryable `409` for writes.
3. Quiesce source writes and drain its permission/publication outboxes. After
   placement is fenced, use a short table barrier only to drain transactions
   that entered before the fence; release it before retaining the
   workspace-filtered repeatable-read snapshot so other workspaces remain
   writable during copy and verification.
4. Copy every regional table row for the workspace and every referenced bundle
   to the target. Do not copy global identity or membership tables.
5. Verify row counts per table, stable logical checksums, bundle count/bytes,
   and every bundle digest. Store each check and its source/target values in the
   migration evidence.
6. Rebuild the global resource and permission projections, warm the target, and
   atomically change placement to target `active` with another higher epoch.
   Invalidate gateway caches and probe an authenticated read and write.
7. Retain the source as read-only recovery data until the rollback window
   expires. Record the final epoch, timings, checks, and probe results.

If copy or validation fails, DataFn invokes the rollback hook: keep the target
fenced, restore the source as the only active home with a higher epoch,
invalidate caches, resume the source, verify read/write probes, and record the
failure plus rollback evidence. A rollback drill is complete only when it
demonstrates that a stale target assertion and a stale source assertion are
both rejected after the final transition.

## Combined-database cutover

The initial conversion is a batch of the same fenced workspace move, not a
schema-only role change. `db:migrate:topology` retains the combined database's
regional tables while it creates the control schema and records
`topology_cutover_state=copying`. Database triggers then allow compatibility
writes only for workspaces whose placement is still `legacy` and `active`.
Each workspace is quiesced, copied into the first declared cell, checked table
by table and bundle by bundle, rollback-drilled, and promoted with a higher
placement epoch. The legacy application therefore cannot resume source writes
after promotion.

Before control ownership is finalized, the command copies every published
version of every currently public skill from the regional bucket to the global
public bucket. Source and destination SHA-256 digests must both match before
the metadata row becomes visible. Only after all placements are active in the
declared cell and all public projection copies succeed does the command mark
the cutover complete and prune regional tables from the control database. A
retry verifies already-promoted workspaces instead of trusting placement state
alone.

## Regional outage and control-plane outage

For a regional outage, do not redirect writes to another cell. Return `503`,
preserve the placement, and restore the cell. Promote a recovered copy only via
the normal fenced move protocol with database and bundle verification. Global
public projections remain read-only and may serve last verified content.

For a control-plane outage, all new sessions, membership changes, placement
lookups, replay claims, and regional writes fail closed. Do not bypass the
gateway or extend assertion TTLs. Restore the control database, verify placement
epochs against cell logs, purge expired nonces/caches, and probe both cells
before reopening traffic.

## Routing-key rotation

1. Generate a new independent key and add its ID as verification-only on every
   gateway and cell. Deploy and verify all cells accept assertions signed by the
   old active key.
2. Change `activeKeyId` at gateways, retain the old key for verification, and
   deploy. Confirm new-key success in every cell and no unknown-key errors.
3. Wait longer than the maximum assertion TTL plus clock skew and deployment
   propagation window. Remove the old key from gateways and cells. The manifest
   must never contain more than three verification key IDs.
4. Record key IDs, deployment versions, timestamps, probes, and rollback result
   in the control-plane audit trail. Never record secret material.

## Compatibility mode

Without `SKILLPLANE_TOPOLOGY`, runtime configuration creates an explicit
single-cell compatibility topology over the legacy `HYPERDRIVE` and
`SKILL_BUNDLES` bindings. It preserves local development and rollback behavior
but does not make multi-region or residency claims.
