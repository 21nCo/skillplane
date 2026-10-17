# McpFn runtime ownership and release gates

Skillplane's production MCP endpoint is an McpFn server. The migration is a
clean ownership transfer: Skillplane does not retain a parallel SDK server,
transport, OAuth protocol router, Client ID Metadata Document loader, or legacy
dynamic-registration management API.

## Ownership boundary

| Concern                                                                                                                                                                                                                                       | Authority                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| MCP declaration, tool registration, server identity, protocol server, and Streamable HTTP transport                                                                                                                                           | `@mcpfn/core`                  |
| Bearer challenge, authenticated `authInfo`, required-scope enforcement, redirect policy, OAuth discovery, authorization request validation, dynamic registration, Client ID Metadata Document loading, token and revocation endpoint protocol | `@mcpfn/auth`                  |
| Official authenticated conformance runner and credential-injecting loopback proxy                                                                                                                                                             | `@mcpfn/testing`               |
| User/service credential verification, tenant and actor mapping, consent/login UI, authorization-code and token persistence, rotation/reuse handling, audit, rate limits, and the outbound Client ID Metadata Document network allow-policy    | Skillplane and AuthFn adapters |

AuthFn remains the identity and token authority. McpFn owns the MCP and OAuth
protocol mechanics around that authority. Tool handlers consume only the
server-derived Skillplane identity propagated through McpFn `authInfo`; caller
body fields never establish identity or authorization.

## Registry package pin

Skillplane consumes the reviewed stable npm releases directly:

- `@mcpfn/auth@0.0.5`
- `@mcpfn/core@0.0.5`
- `@mcpfn/testing@0.0.5`

Consumer manifests use exact versions and `pnpm-lock.yaml` records the registry
artifacts and integrity hashes. Run:

```bash
pnpm mcpfn:verify
```

The command fails if a consumer uses a range, local link, or mismatched McpFn
version; if Skillplane constructs the SDK server or transport again; if legacy
registration-management routes return; or if Skillplane resumes local Client ID
Metadata Document hydration. Package upgrades must update the exact manifest
versions and frozen lockfile together, then pass the same gates below. Do not
introduce a compatibility shim or dual runtime.

The 0.0.5 release contains the Cloudflare Worker packaging correction from
MCP-4 and selects a code-generation-free schema validator under workerd.
Skillplane keeps its direct MCP SDK and Zod pins unchanged and needs no
consumer-side `zod/v4` alias. Local, development, production, and rendered
regional MCP configurations retain only `nodejs_compat` with compatibility
date `2026-05-03`; startup evaluation is already enabled by default for that
date.

AuthFn is pinned to `0.4.0`, which supports explicitly unowned service API
keys. Service credentials retain `userId: null`; no user-owner workaround or
database migration is required.
The workspace override keeps AuthFn plugins on that same runtime so policy
errors retain their intended HTTP status instead of crossing duplicate core
error classes.

For the SKI-19 rollout, verify real local workerd readiness in addition to
bundling. Then run the full `pnpm deploy:dev:topology` path, including MCP,
from an approved committed clean worktree and run `pnpm smoke:dev` to confirm
the deployed endpoint still rejects unauthenticated access. Record local
startup, Cloudflare development upload, and deployed authentication smoke
results separately. A dry-run or a selective deployment does not complete
this rollout, and production deployment requires separate authorization.

## Authenticated client profiles

`mcp/src/client-profiles.ts` declares the McpFn client profiles. McpFn selects
one from the verified identity that AuthFn established, never from the client's
self-reported `initialize` metadata:

| Verified identity                                                            | Profile                          |
| ---------------------------------------------------------------------------- | -------------------------------- |
| OAuth client `https://claude.ai/oauth/mcp-oauth-client-metadata`             | `skillplane/oauth-claude@1`      |
| OAuth client `https://linear.app/.well-known/oauth-client-metadata/mcp.json` | `skillplane/oauth-linear@1`      |
| Any other OAuth client                                                       | `skillplane/oauth-generic@1`     |
| Service principal (agent credential)                                         | `skillplane/service-principal@1` |

Caller policy: for every OAuth profile, `caller` is server-owned. It is removed
from every model-visible input schema, and a supplied `caller` is discarded
before McpFn enrichment, so it is overwritten rather than rejected. Enrichment
then writes the profile's attribution with fresh per-invocation run, session
and conversation IDs before canonical validation. Service principals keep the
canonical contract: `caller` remains visible, required and client-declared.

Linear rejects `tools/list` payloads above 32 KiB. McpFn projection must keep
output schemas and model-owned input constraints, so the Linear profile adds a
wire compaction after McpFn builds its effective catalog. Compaction drops
presentation metadata and constraint keywords only; tool names, property names
and required sets match the other OAuth profiles, and calls are still
validated against the canonical schema.

Discovery tools share one workspace selector: `skills_list` and
`skills_search` take `workspace: { id }` or `workspace: { slug }`. For every
identity, an unambiguous flat string `workspaceId` on either tool is rewritten
to `workspace: { id }` before validation. This is a deprecated alias. Sending
both forms, or another spelling such as `workspace_id`, is still rejected by
the strict schema. Other workspace-aware tools keep their current selectors.

A call that McpFn stops before its handler returns `MCPFN_INVALID_ARGUMENTS`
(or another McpFn lifecycle code) with each issue's `keyword`, `instancePath`,
`schemaPath`, and `rejectedProperty` or `missingProperty`. Argument values are
never included. The evidence hook also logs one
`mcp.tool.rejected_before_handler` event carrying the same issue structure,
the tool and `profileId` when McpFn resolved them, the lifecycle stage and the
code, together with the request correlation ID that the response returns in
`x-skillplane-request-id`. The event uses the same operational log channel and
retention as other MCP operational events rather than the workspace audit
table, which records only calls whose handler ran.

McpFn validates with Ajv under Node and with `@cfworker/json-schema` on
Cloudflare Workers. The Workers engine quotes argument values in its messages
and also reports enclosing subschemas and an `additionalProperties` failure for
a declared property whose value was invalid. `mcp/src/schema-issues.ts`
reduces both engines' issues to the same leaf failures, rebuilds each message
from structural fields only, and sorts them. It also drops an `anyOf` branch's
rejection of a property that a sibling branch declares, and restores the empty
property name `""`, which McpFn 0.0.5 omits. The client result and the
evidence event both use this normalized form, so a declared property is never
reported as unknown.

In a gateway deployment, a workspace tool call whose arguments name no
workspace (for example `skills_list` with `workspace_id`, or with no selector)
cannot be routed to a cell. The gateway serves it with its local MCP app. That
app authenticates the call and McpFn reports the same diagnostic and event.
A control deployment rejects a call that names a workspace with
`CONTROL_ROUTE_NOT_FOUND` before McpFn runs. Workspace tool handlers never run
against control-plane data: a locally served call that passes validation gets
`VALIDATION_FAILED` without any workspace read, and one operational event under
its `x-skillplane-request-id`. A routed call that fails validation in its cell
returns the cell's diagnostic and `x-skillplane-request-id` through the gateway
unchanged.

Each stateless request creates its own McpFn server. When a request contains
only `tools/call` messages, the server's visible catalog is limited to the
called tools, so McpFn does not re-project the full catalog for every call.

`mcp/src/client-profiles.test.ts` runs the `@mcpfn/testing` client-profile
contract against the production Hono app. Reviewed per-profile effective
catalog snapshots live in `mcp/tests/conformance/__snapshots__/client-profiles`.
Regenerate them with `vitest run -u` only after reviewing an intended catalog
change.

## Required release gates

Run these before deploying either the app authorization server or MCP Worker:

```bash
pnpm mcpfn:verify
pnpm test:mcp:contract
pnpm test:mcp:conformance
pnpm test:unit
pnpm test:integration
pnpm test:security
pnpm typecheck
pnpm build
```

`test:mcp:contract` exercises Skillplane's complete production tool catalog and
authorization behavior. `test:mcp:conformance` runs the pinned official MCP
server suite through an authenticated loopback proxy. The official suite is
built around an everything-server fixture, so
`mcp/tests/conformance/expected-failures.yml` contains only reviewed scenarios
for capabilities Skillplane does not advertise and synthetic `test_*` tools it
does not implement. Initialization, ping, tool inventory, HTTP request handling,
and DNS-rebinding protection are unbaselined hard gates. A newly failing or
newly passing scenario fails the gate until the baseline and rationale are
reviewed.

Authenticated McpFn testing rejects raw artifact directories. The conformance
test inspects the runner's redacted output in memory and retains one bounded summary at
`.conduct/verification/SKI-6/official-conformance-summary.json`. It fails if the
captured output exceeds the bound or contains the injected credential. The
active suite verifies the full scenario catalog and baseline; individual verbose
runs supply the check IDs needed to verify exact failure and warning evidence.
The summary uses schema version 3 and records `artifactHygiene.redactedOutputBytes`
for the captured suite and scenario output. Regenerate the tracked summary from
a successful suite run whenever its format changes; historical raw-artifact
measurements must not be relabeled as redacted-output evidence.

The UTC rollup integration gate covers half-open day boundaries in UTC,
Asia/Kolkata, and New York across both DST transitions, including workspace
discovery and explicit-workspace rebuilds. Distinct decimal latency samples
check interpolated p50/p95 values for workspace and per-skill summaries rather
than allowing mean, maximum, or swapped-percentile calculations to pass.

## Controlled provider proof

Automated gates do not prove a hosted provider's current connector behavior.
Before production release, use a controlled development workspace and perform a
fresh authorization from both Claude and ChatGPT against the exact development
MCP resource. For each provider:

1. complete discovery, registration or Client ID Metadata Document resolution,
   PKCE authorization, consent, and token exchange;
2. reconnect with the issued access token, list tools, and execute one scoped
   read in the controlled workspace;
3. refresh once without changing the resource audience, then confirm the old
   refresh credential cannot be reused;
4. verify the audit trail records the expected client, actor, resource, scopes,
   and outcome without tokens, codes, verifiers, cookies, or secrets; and
5. retain only a sanitized result summary with timestamps and provider/client
   identity, not raw HTTP captures.

Stop the release if either provider cannot complete a fresh flow, if discovery
advertises a route Skillplane does not serve, if the resource or scopes drift,
if identity is derived from request content, or if evidence contains secret
material. A locally green conformance run is not a substitute for this proof.

## Rollback

This migration adds no database migration. App and MCP Worker versions form one
compatibility set: the app serves the McpFn-backed authorization surface and the
MCP Worker consumes the corresponding authenticated principal contract. Do not
roll back only selected source files or add old routes as a fallback.

For a release incident, follow `docs/operations/rollback.md` and use the exact
recorded Worker versions. Roll back MCP before app, run
`pnpm smoke:production:release`, and confirm OAuth discovery and an
authenticated tool call against the restored pair. The content-addressed bundle
store and PostgreSQL schema remain unchanged. If rollback does not restore the
flow, roll forward to the recorded release pair and investigate before changing
token or client records.
