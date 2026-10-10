# Superfunctions ownership boundaries

Skillplane composes the released `authfn@0.2.0`, `@authfn/client@0.2.0`,
AuthFn plugins at `0.1.1`, and `sendfn@0.0.2`. AuthFn owns its HTTP routes,
wire envelopes, browser transport, request correlation, validation, sessions,
and generated schema contract. Skillplane retains OTP abuse policy in the
supported `beforeChallengeSend` hook and its provider-specific email adapter.

The local Postgres OTP limiter remains intentionally. AuthFn's released shared
rate limiter requires an `AtomicKVStoreAdapter` (`incr`, `get`, `set`, and
expiry semantics). Skillplane's existing relational bucket table exposes only
an atomic SQL consume operation and cannot implement the required KV contract
without adding a second persistence abstraction or changing expiry behavior.
The policy hook therefore preserves the current recipient/network two-key
transactional Postgres behavior until a compatible upstream Postgres atomic-KV
adapter is released.

`.conduct/authfn-schema.lock.json` is a deterministic digest of the composed
released AuthFn schema. `pnpm preflight` recomputes it and fails on package or
plugin schema drift, requiring an explicit migration review and lock update.
