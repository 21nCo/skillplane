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

- `@mcpfn/auth@0.0.3`
- `@mcpfn/core@0.0.4`
- `@mcpfn/testing@0.0.4`

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

The conformance test deletes raw runner output after inspecting it and retains
one bounded summary at
`.conduct/verification/SKI-6/official-conformance-summary.json`. It fails if the
raw output exceeds the bound or contains the injected credential.

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
