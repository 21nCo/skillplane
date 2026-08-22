# Skillplane

Skillplane is a management and delivery platform for versioned AI-agent skills.
Agents can search and retrieve skills, propose audited amendments, and maintain
versioned knowledge and notes for each skill context through MCP.

## Local database

Start the project-owned Postgres instance with:

```bash
pnpm db:up
```

Skillplane binds Postgres to `127.0.0.1:5703` by default, leaving the standard
Postgres port available to other projects. An existing Skillplane runtime still
using the former `5432` default is remapped automatically the next time this
command runs; its Docker volume and database credentials are preserved. Explicit
custom ports remain unchanged.

`db:up` updates only the database assignments it owns in `app/.dev.vars` and
`mcp/.dev.vars`. Existing authentication, OAuth, and custom variables are
preserved.

Initialize stable local AuthFn and OAuth secrets plus Cloudflare's paired
Turnstile test credentials once:

```bash
pnpm local:init
```

This command is idempotent, keeps both Workers' OAuth pepper synchronized, uses
mode-`0600` ignored files, and never prints secret values.

Start the default Worker with authentication explicitly disabled:

```bash
pnpm dev:app:worker
```

This mode supports readiness checks and unauthenticated/public development
without establishing a remote email connection. To exercise the complete
AuthFn email-OTP flow through the real Cloudflare Email Service binding, use:

```bash
pnpm dev:app:auth
```

Authenticated local development requires `pnpm local:init`, Wrangler access to
the Skillplane Cloudflare account, and an onboarded sender. The checked-in local
configuration uses Cloudflare's official always-pass Turnstile test pair; a
custom site-key/secret pair can be placed together in `app/.dev.vars`.
Production configuration is separate and always forces OTP authentication,
production Turnstile credentials, and the Cloudflare email provider.

## MCP usage

Skillplane exposes a stateless MCP server over Streamable HTTP. Every MCP request
must authenticate with either an OAuth access token or a scoped Skillplane agent
credential.

| Environment                     | Transport       | Authentication  | URL                              | Headers                               |
| ------------------------------- | --------------- | --------------- | -------------------------------- | ------------------------------------- |
| Local Skillplane                | Streamable HTTP | Request headers | `http://127.0.0.1:5701/mcp`      | `Authorization=Bearer spk_your_token` |
| Hosted Skillplane               | Streamable HTTP | Auto (OAuth)    | `https://mcp.skillplane.dev/mcp` | Leave empty                           |
| Hosted with an agent credential | Streamable HTTP | Request headers | `https://mcp.skillplane.dev/mcp` | `Authorization=Bearer spk_your_token` |

Do not select **No auth**. The Skillplane MCP endpoint requires a bearer
credential for every request.

### Local connection

Start the local MCP worker:

```bash
pnpm dev:mcp
```

Create an agent credential from **Skillplane → Settings → Agent credentials**.
For complete read, creation, amendment, and context testing, use an `Editor` credential
with these scopes:

- `skills:read`
- `skills:write`
- `skills:amend`
- `contexts:read`
- `contexts:write`

Candidate approval, rejection, and amendment-policy changes require a user OAuth
token with `skills:publish` and an `Admin` or `Owner` workspace role. Service
credentials deliberately cannot publish or change review policy.

The credential is displayed only once. In clients whose request-header field
uses `key=value` syntax, enter:

```text
Authorization=Bearer spk_your_token
```

Use **Request headers** for ordinary loopback development. To validate **Auto**
against the local authorization server and database, use the complete tunneled
OAuth workflow below.

The client must run on the same machine to reach `127.0.0.1`. A cloud-hosted MCP
client cannot connect to the local endpoint.

### Complete local OAuth through Cloudflare Tunnel

The loopback endpoint is sufficient for request-header credentials and automated
tests. To exercise a real MCP client's OAuth discovery, browser consent, token
exchange, and authenticated MCP call against the local database, route two stable
HTTPS hostnames through one named Cloudflare Tunnel:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /absolute/path/to/YOUR_TUNNEL_ID.json
ingress:
  - hostname: app-local.skillplane.dev
    service: http://127.0.0.1:5700
  - hostname: mcp-local.skillplane.dev
    service: http://127.0.0.1:5701
  - service: http_status:404
```

After creating the tunnel and DNS routes, configure the exact OAuth identities:

```bash
pnpm db:up
pnpm local:init
pnpm local:oauth:configure -- \
  --app-url https://app-local.skillplane.dev \
  --mcp-url https://mcp-local.skillplane.dev
```

Start `pnpm dev:app:auth`, `pnpm dev:mcp`, and `pnpm local:tunnel` in separate
terminals. Then run:

```bash
pnpm test:local:oauth
```

The verifier dynamically registers a loopback client, opens the browser for OTP
sign-in and consent, exchanges the PKCE authorization code, connects to MCP with
the resulting access token, calls `workspaces_list`, and revokes the token. The
tunnel must not require a separate Cloudflare Access login because OAuth discovery
and token endpoints must remain reachable by the MCP client.

#### Codex

Keep the credential out of the Codex configuration by referencing an environment
variable:

```bash
codex mcp add skillplane_local \
  --url http://127.0.0.1:5701/mcp \
  --bearer-token-env-var SKILLPLANE_LOCAL_MCP_TOKEN
```

Set `SKILLPLANE_LOCAL_MCP_TOKEN` to the `spk_...` credential before starting
Codex. On macOS, Codex Desktop can receive it through the launch environment:

```bash
launchctl setenv SKILLPLANE_LOCAL_MCP_TOKEN 'spk_your_token'
```

Fully quit and reopen Codex, then start a new task so the MCP tools are
discovered.

### Hosted connection

For an interactive user, configure the hosted endpoint with **Auto**
authentication and leave request headers empty. The client discovers Skillplane
OAuth and obtains a user-bound access token after login and consent.

For CI, headless agents, or organization-owned agents, use **Request headers**
with a scoped Skillplane agent credential instead.

The hosted endpoint must be deployed and reachable over HTTPS before a
cloud-hosted client can connect to it.

### Exposed tools

Skillplane currently exposes:

- `workspaces_list`
- `skills_list`
- `skills_search`
- `skill_retrieve`
- `skill_asset_retrieve`
- `skill_versions_list`
- `skill_versions_diff`
- `skill_create`
- `skill_visibility_update`
- `skill_archive`
- `skill_restore`
- `skill_amend`
- `skill_candidates_list`
- `skill_candidate_approve`
- `skill_candidate_reject`
- `skill_amendment_policy_get`
- `skill_amendment_policy_update`
- `contexts_list`
- `context_get`
- `context_create`
- `context_update`
- `context_archive`
- `context_restore`
- `context_knowledge_history`
- `context_notes_list`
- `context_knowledge_update`
- `context_note_upsert`

To retrieve all of the authenticated principal's skills without already knowing
a workspace ID, call `workspaces_list`, then call `skills_list` for each returned
workspace until `nextCursor` is `null`. `skills_search` remains the ranked
full-text operation and intentionally requires a non-empty query.

To manage contextual knowledge without out-of-band identifiers, continue from a
listed skill with `contexts_list`. Authorized agents with `contexts:write` can
then use `context_create`, `context_update`, `context_archive`, and
`context_restore`. Metadata and lifecycle writes require the exact `updatedAt`
returned by the latest context read/list/mutation. Knowledge remains immutable:
use `context_knowledge_update` to append a revision and
`context_knowledge_history` to exhaust its history.

The skill lifecycle follows the same discovery-first model. OAuth users with
`skills:write` can create skills, change visibility, and archive or restore them.
Agents propose immutable versions through `skill_amend`; authorized reviewers
use `skill_candidates_list` and approve or reject each proposal. Workspace
owners can inspect or update per-skill amendment policy, and
`skill_versions_diff` compares any two visible versions without downloading the
entire bundles. Every state-changing tool requires an idempotency key and the
latest `updatedAt` concurrency token.

OAuth refresh requests may omit the RFC 8707 `resource` parameter for clients
that do not repeat it during refresh, including affected Codex releases. In
that case Skillplane derives the audience from the stored refresh token and
still rejects duplicate or explicitly mismatched resources. Authorization-code
exchange continues to require the exact MCP resource.

Tool calls require caller-declared agent, model, client, run, session, and
conversation metadata. Authenticated user or service-principal identity is
derived and verified by Skillplane rather than accepted from those caller
fields.
