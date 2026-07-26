# PHASE_03 — AuthFn OTP and Cloudflare SendFn delivery

## Phase goal

Deliver real email-OTP authentication with secure sessions and a production Cloudflare Email Service adapter for SendFn.

## In scope

- AuthFn app/server composition.
- AuthFn email OTP and API-key plugins.
- Cloudflare Email Service SendFn adapter.
- OTP and invitation email renderers.
- Session, CSRF, rate-limit, Turnstile, and redaction behavior.
- Minimal auth UI required to verify the flow.

## Out of scope

- OAuth MCP grants.
- Organization invitations beyond email rendering.
- Service principals.
- Skill features.

## Deliverables

- `packages/auth/src/app.ts`
- `packages/auth/src/server.ts`
- `packages/auth/src/session.ts`
- `packages/auth/src/rate-limit.ts`
- `packages/auth/src/turnstile.ts`
- `packages/auth/src/index.ts`
- `packages/email/src/cloudflare-provider.ts`
- `packages/email/src/sendfn.ts`
- `packages/email/src/templates/otp.ts`
- `packages/email/src/templates/invitation.ts`
- `app/src/routes/sign-in/+page.svelte`
- `app/src/routes/verify/+page.svelte`
- `app/src/lib/auth/client.ts`
- `app/src/hooks.server.ts`
- AuthFn/SendFn integration tests
- `.conduct/logs/superfunctions/<timestamp>-sendfn-cloudflare-adapter.md` if the shared adapter is added upstream
- engineering log, screenshots, phase report, and ledger append

## Requirements covered

- `AUTH-001`
- `AUTH-002`
- `AUTH-003`
- `PROJ-004`
- `OPS-004`
- `QA-001`
- `QA-002`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Re-check the Superfunctions `next` worktree status and create the required pre-edit log.
2. If non-overlapping, add a Cloudflare Email Service adapter to SendFn with provider contract tests, exports, and documentation; if overlapping, stop for user direction.
3. Compose SendFn with the Cloudflare binding and AuthFn delivery provider.
4. Implement branded OTP and invitation templates with text and sanitized HTML.
5. Configure AuthFn email OTP, sessions, API keys, observability, and Postgres storage following the Nucleus composition pattern.
6. Implement CSRF, session cookies, rate limits, generic OTP responses, and Turnstile risk policy.
7. Build functional sign-in and verify screens with resend, expiry, invalid-code, rate-limit, and recovery states.
8. Prove production dependency injection cannot select a fake provider.
9. Record all shared-package changes and verification.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/email --filter @skillplane/auth
pnpm test:integration --filter auth-otp
pnpm test:security --filter auth
pnpm test:e2e --grep @auth
pnpm build
git -C "$SENDFN_WORKTREE" diff --check
npm --prefix "$SENDFN_WORKTREE/sendfn/typescript" test -- --run
npm --prefix "$SENDFN_WORKTREE/sendfn/typescript" run build
```

Expected outcomes:

- Real provider contract tests pass.
- OTP creates a durable AuthFn session.
- Invalid/unknown identities do not enumerate accounts.
- CSRF, rate limits, and Turnstile negatives pass.
- Screenshots cover auth states in both themes.

## Stop condition

Report whether SendFn was changed, the exact logged scope, provider tests, delivered test message evidence, and auth E2E results before `PHASE_04`.
