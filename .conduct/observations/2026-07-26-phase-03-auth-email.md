# PHASE_03 auth and email observations

- Observed: `2026-07-26T06:15:01Z`
- Scope: local UI/runtime observation and read-only Cloudflare/Superfunctions
  verification.

## Auth UI

The sign-in and verification flow was exercised through the actual SvelteKit
pages, canonical Hono server, AuthFn routes, local Postgres, SendFn client, and
a test-only implementation of the Cloudflare binding.

Captured states:

- `sign-in-dark.png`: normal dark-theme email entry.
- `sign-in-light.png`: normal light-theme email entry.
- `verify-invalid-dark.png`: invalid-code recovery state.
- `verify-expired-light.png`: expired-code recovery and resend state.
- `verify-rate-limit-light.png`: retry-after/rate-limit state.

The screens preserve a clear primary action, keyboard-operable fields, visible
focus behavior, restrained Phosphor icon use, and a consistent Linear-inspired
surface system. The test harness renders an explicit "Security check complete"
control instead of the production Turnstile widget; production still requires
the real Turnstile keys and verified callback.

## Cloudflare Email Service

`wrangler whoami` confirmed an authenticated account with email-sending write
permission. A temporary ignored Worker resolved the real remote binding as:

```text
SEND_EMAIL — Send Email remote; unrestricted; sender auth@skillplane.dev
```

Calling that binding returned HTTP 500 and the sanitized provider message:

```text
could not find domain config of sending domain
```

This distinguishes binding availability from sending-domain readiness.
`skillplane.dev` must be onboarded in Cloudflare Email Service before a real OTP
can be delivered. No account identifiers, tokens, recipients, or OTP values are
recorded here. The probe Worker and its generated local state were removed.

## Superfunctions boundary

The `next` worktree stayed read-only at revision
`9cf381238d1d8a11c899d6808ffb0bb73dfe839a`. Its diff check and SendFn build
pass. Its SendFn tests independently reproduce one failure:

```text
tests/public_api.test.ts:123
expected adapter.closeCalls 1; received 0
43 passed; 1 failed
```

Additional AuthFn dirty paths appeared in that external worktree during this
phase. They were neither inspected for integration nor modified by Skillplane.

## Resolution observation

Cloudflare rejected root-domain onboarding because
`_domainkey.skillplane.dev` is delegated to Afternic. Rather than remove that
pre-existing delegation, Email Sending was enabled on the dedicated
`auth.skillplane.dev` subdomain. Cloudflare created the required SPF, DKIM,
return-path, and DMARC records and reported the subdomain enabled.

The application binding now permits only
`no-reply@auth.skillplane.dev`. A single non-OTP verification message was
accepted by Cloudflare and subsequently found in the connected Gmail inbox with
the expected sender, subject, and body. The recipient, account identifiers,
Cloudflare subdomain tag, DNS key material, and Gmail message identifiers are
not recorded.

The external SendFn failure was also resolved through the separately logged,
two-file `@superfunctions/db` lifecycle delegation fix. Its final suite passes
44 of 44 tests.
