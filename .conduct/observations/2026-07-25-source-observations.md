# Source observations

## Superfunctions `next`

- SendFn is present under `sendfn/typescript`.
- Its provider contract is sufficient for a Cloudflare Email Service binding adapter.
- No Cloudflare adapter currently exists.
- The worktree was dirty before Skillplane work began.
- Relevant dirty paths include SendFn exports, edge composition, package metadata, AuthFn delivery types, and a shared delivery package.

## Superfunctions `dev`

- AuthFn and DataFn are the versions used by the Nucleus account service.
- AuthFn plugins can add schema and HTTP routes and receive runtime-only dependencies.
- The plugin boundary can host OAuth authorization codes, consents, clients, access tokens, refresh tokens, metadata endpoints, and token verification without embedding Skillplane logic into AuthFn core.

## Nucleus

- The account service is the reference composition for AuthFn server creation, plugin runtime injection, DataFn authentication, namespace resolution, rate limiting, and SendFn OTP delivery.
- Skillplane MUST copy the composition pattern, not Nucleus product semantics or source.

## Local environment

- Port 5432 was free at specification time.
- Docker Desktop engine was reachable through its bundled CLI.
- Implementation MUST still re-check both facts before starting the local database.
