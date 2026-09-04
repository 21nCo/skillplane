# mdfn authoring and rendering

Skillplane consumes published mdfn packages for Markdown authoring and
read-only rendering. It does not implement an mdfn engine or change skill,
knowledge, or note persistence.

## Ownership boundary

| Concern                                                                                          | Authority                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Named Skillplane profile, environment-neutral parse/render, `renderSafeMarkdown`, `SafeMarkdown` | `@skillplane/ui` over `@mdfn/markdown`, `@mdfn/render`, and `@mdfn/extensions` |
| Shared editor wrapper, source fallback, per-surface flags, lazy visual loading                   | `@skillplane/app` over `@mdfn/svelte`                                          |
| Canonical Markdown strings, bundle construction, revisions, authorization, audits                | Existing Skillplane domain and API services                                    |

The durable value across the boundary is a Markdown string. mdfn runtime state
never enters API requests, skill bundles, revisions, or agent-facing contracts.

Consumer manifests pin exact stable versions. Unused workspace catalog entries
are intentionally omitted so `pnpm mdfn:verify` can assert the registry pin
directly from each package.json.

## Registry package pin

Skillplane consumes the reviewed stable npm releases directly:

- `@mdfn/markdown@0.1.0`
- `@mdfn/render@0.1.0`
- `@mdfn/extensions@0.1.0`
- `@mdfn/core@0.1.0`
- `@mdfn/svelte@0.1.0`

Consumer manifests use exact versions and `pnpm-lock.yaml` records the registry
artifacts and integrity hashes. Run:

```bash
pnpm mdfn:verify
```

## Feature switches

Unset flags keep mdfn enabled. Set a value of `0`, `false`, `off`, or `legacy`
to roll a surface back to the previous source control over the same canonical
Markdown. App flags are read from SvelteKit `$env/dynamic/public` (Cloudflare
Worker bindings at request time). The UI renderer flag is applied from those
same runtime values in `hooks.server.ts` and `hooks.client.ts`, so production
rollback does not require a rebuild.

| Flag                                           | Effect                                          |
| ---------------------------------------------- | ----------------------------------------------- |
| `PUBLIC_SKILLPLANE_MDFN_RENDERER`              | Read-only `renderSafeMarkdown` / `SafeMarkdown` |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR`                | Master switch for every authoring surface       |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR_SKILL_CREATE`   | New-skill `SKILL.md`                            |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR_SKILL_AMEND`    | Skill amendment `SKILL.md`                      |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR_CONTEXT_CREATE` | Initial context knowledge                       |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR_KNOWLEDGE`      | Knowledge revisions                             |
| `PUBLIC_SKILLPLANE_MDFN_EDITOR_NOTE`           | Context note bodies                             |

Rollback does not rewrite stored Markdown or require a database migration.
