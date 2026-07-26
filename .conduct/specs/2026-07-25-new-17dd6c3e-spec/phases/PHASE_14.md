# PHASE_14 — Landing site and public skill discovery

## Phase goal

Complete the standalone landing site and public skill surfaces with accurate claims, full-text discovery, SEO, accessibility, and production navigation.

## In scope

- Landing page and responsive navigation.
- Product workflow and security content.
- Public skill directory/search without marketplace commerce.
- Public skill detail and published version history.
- SEO, sitemap, robots, canonical URLs, and social metadata.

## Out of scope

- Billing/pricing plans.
- Marketplace transactions.
- Public contexts or candidate versions.

## Deliverables

- `landing/src/routes/+page.svelte`
- `landing/src/routes/skills/+page.svelte`
- `landing/src/routes/skills/[workspaceSlug]/[skillSlug]/+page.svelte`
- `landing/src/routes/sitemap.xml/+server.ts`
- `landing/src/routes/robots.txt/+server.ts`
- `landing/src/lib/components/Hero.svelte`
- `landing/src/lib/components/Workflow.svelte`
- `landing/src/lib/components/FeatureGrid.svelte`
- `landing/src/lib/components/Security.svelte`
- `landing/src/lib/components/PublicSkillCard.svelte`
- `landing/src/lib/components/Footer.svelte`
- public API/cache policy additions
- crawl/content-contract/accessibility/visual tests
- engineering log, screenshots, phase report, and ledger append

## Requirements covered

- `TEN-003`
- `SKL-010`
- `UI-001`
- `UI-003`
- `UI-004`
- `UI-005`
- `OPS-005`
- `QA-002`
- `QA-004`

## Implementation tasks

1. Build hero and workflow around create, contextualize, retrieve, amend, review, and publish.
2. Present versioning, context, audit, MCP, security, and deployment behavior accurately.
3. Build public skill search and detail using only published public metadata/content.
4. Keep candidate versions, contexts, notes, audit dimensions, and private workspace data unavailable.
5. Implement sign-in and create-account CTAs to the app host.
6. Implement canonical, OpenGraph, social, sitemap, and robots metadata.
7. Apply immutable caching by published digest and correct invalidation at new publication.
8. Run content-contract checks to prevent billing/marketplace or unshipped claims.
9. Capture responsive light/dark visual evidence.

## Verification steps

```bash
pnpm test:unit --filter landing
pnpm test:integration --filter public-skills
pnpm test:security --filter public-visibility
pnpm test:a11y --filter landing
pnpm test:e2e --grep @landing
pnpm test:crawl
pnpm test:visual --filter landing
```

Expected outcomes:

- Public pages expose only published public versions.
- Search, canonical URLs, sitemap, robots, and CTAs work.
- Landing claims map to shipped behavior.
- Accessibility and visual matrices pass.

## Stop condition

Report crawl output, public/private isolation, content-contract result, SEO evidence, and screenshots before `PHASE_15`.
