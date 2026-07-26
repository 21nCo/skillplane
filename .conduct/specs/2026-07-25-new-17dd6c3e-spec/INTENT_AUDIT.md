# Intent audit

## Intent inventory and coverage

| # | Intent item | `SPEC.md` coverage | Requirement IDs | Test vectors |
|---:|---|---|---|---|
| 1 | Create a new project named Skillplane in the requested folder. | Metadata; Overview; Architecture / Monorepo | `PROJ-001`, `PROJ-003` | `TV-PROJ-001-P/N`, `TV-PROJ-003-P/N` |
| 2 | Use a monorepo with `app/`, `mcp/`, `packages/`, and `landing/`. | Overview; Architecture / Monorepo | `PROJ-001` | `TV-PROJ-001-P/N` |
| 3 | Deliver production-ready features with no stubs or scaffolding-only behavior. | Overview; Hard constraints; Failure and recovery | `PROJ-002`, `UI-005`, `QA-001` | `TV-PROJ-002-P/N`, `TV-UI-005-P/N`, `TV-QA-001-P/N` |
| 4 | Use SvelteKit for the authenticated application and landing site. | Context; Architecture / Monorepo | `PROJ-001`, `UI-002`, `UI-003` | `TV-PROJ-001-P/N`, `TV-UI-002-P/N`, `TV-UI-003-P/N` |
| 5 | Use Tailwind CSS. | Context; User interface / Design system | `UI-001` | `TV-UI-001-P/N` |
| 6 | Use Phosphor icons. | Context; User interface / Design system | `UI-001` | `TV-UI-001-P/N` |
| 7 | Use a Linear-inspired application design system. | User interface / Design system | `UI-001`, `UI-004`, `UI-005` | `TV-UI-001-P/N`, `TV-UI-004-P/N`, `TV-UI-005-P/N` |
| 8 | Use Hono for the backend server. | Architecture; Public API; DataFn integration | `DATA-003` | `TV-DATA-003-P/N` |
| 9 | Run a real local Postgres Docker instance and select another deterministic port if 5432 is occupied. | Local topology; Database and migrations | `DATA-001`, `OPS-001` | `TV-DATA-001-P/N`, `TV-OPS-001-P/N` |
| 10 | Use Railway as production Postgres and Cloudflare Hyperdrive as the Worker connection layer. | Runtime topology; Database and migrations | `DATA-001`, `OPS-002` | `TV-DATA-001-P/N`, `TV-OPS-002-P/N` |
| 11 | Accept the Hyperdrive ID later without committing a placeholder. | Runtime topology; Operations | `OPS-002`, `OPS-004` | `TV-OPS-002-P/N`, `TV-OPS-004-P/N` |
| 12 | Store skill files in Cloudflare R2. | Architecture; R2 storage | `DATA-004`, `SKL-003` | `TV-DATA-004-P/N`, `TV-SKL-003-P/N` |
| 13 | Deploy on Cloudflare at `skillplane.dev`. | Runtime topology; Operations | `OPS-003` | `TV-OPS-003-P/N` |
| 14 | Host the landing page at the apex, app at `app.skillplane.dev`, and MCP at `mcp.skillplane.dev`. | Runtime topology | `OPS-003` | `TV-OPS-003-P/N` |
| 15 | Let users create skills. | Goals; Semantics / Skill creation | `SKL-001`, `UI-002` | `TV-SKL-001-P/N`, `TV-UI-002-P/N` |
| 16 | Let users update skills without destroying history. | Versioning; Invariants | `SKL-004`, `SKL-005` | `TV-SKL-004-P/N`, `TV-SKL-005-P/N` |
| 17 | Make skills versioned. | Versioning; Compatibility | `SKL-004`, `SKL-005` | `TV-SKL-004-P/N`, `TV-SKL-005-P/N` |
| 18 | Store portable skill bundles, not only an opaque database text field. | Deterministic bundle; R2 storage | `SKL-002`, `SKL-003`, `DATA-004` | `TV-SKL-002-P/N`, `TV-SKL-003-P/N` |
| 19 | Use `SKILL.md`, manifest metadata, and optional assets/references/scripts. | Data model; MCP asset retrieval | `SKL-002`, `MCP-004` | `TV-SKL-002-P/N`, `TV-MCP-004-P/N` |
| 20 | Expose skills to AI agents through MCP. | Public API / MCP tools | `MCP-001`, `MCP-003`, `MCP-004` | `TV-MCP-001-P/N`, `TV-MCP-003-P/N`, `TV-MCP-004-P/N` |
| 21 | Support MCP skill retrieval. | MCP / `skill_retrieve`; `skill_asset_retrieve` | `MCP-004` | `TV-MCP-004-P/N` |
| 22 | Support an MCP amend tool. | MCP / `skill_amend` | `MCP-006`, `SKL-006` | `TV-MCP-006-P/N`, `TV-SKL-006-P/N` |
| 23 | Allow agents to improve skills over time without silently overwriting them. | Amendment policy; Versioning | `SKL-006`, `SKL-008`, `MCP-006` | `TV-SKL-006-P/N`, `TV-SKL-008-P/N`, `TV-MCP-006-P/N` |
| 24 | Default agent amendments to reviewed candidate versions. | Amendment policy | `SKL-008` | `TV-SKL-008-P/N` |
| 25 | Permit narrowly trusted auto-publication policies. | Amendment policy | `SKL-008` | `TV-SKL-008-P/N` |
| 26 | Require agent, model, client, run, session, conversation, and user attribution for retrieval and amendment. | MCP caller declaration; Invariants | `AUTH-008`, `MCP-002`, `AUD-001` | `TV-AUTH-008-P/N`, `TV-MCP-002-P/N`, `TV-AUD-001-P/N` |
| 27 | Derive authoritative user/service identity from authentication rather than trusting caller input. | Authorization; Security | `AUTH-008` | `TV-AUTH-008-P/N` |
| 28 | Record audit logs for reads and writes. | Observability and analytics / Audit events | `AUD-001` | `TV-AUD-001-P/N` |
| 29 | Provide agent/model/user analytics. | Observability and analytics / UI analytics | `AUD-003`, `AUD-004` | `TV-AUD-003-P/N`, `TV-AUD-004-P/N` |
| 30 | Retain detailed retrieval events for 90 days and permanent mutation/security history and aggregates. | Observability; Limits | `AUD-002` | `TV-AUD-002-P/N` |
| 31 | Avoid storing raw prompts or copying skill bodies into analytics. | Security; Observability | `AUD-002`, `AUD-003` | `TV-AUD-002-P/N`, `TV-AUD-003-P/N` |
| 32 | Let modifications attach structured additional learning metadata. | Learning metadata | `SKL-007` | `TV-SKL-007-P/N` |
| 33 | Show learning metadata, evidence, validation, context, agent, and model in the UI. | Learning metadata; User interface / App surfaces | `SKL-007`, `UI-002` | `TV-SKL-007-P/N`, `TV-UI-002-P/N` |
| 34 | Give every skill contexts for project/customer/environment-specific knowledge. | Context semantics | `CTX-001`, `CTX-004` | `TV-CTX-001-P/N`, `TV-CTX-004-P/N` |
| 35 | Let agents create/update the shared knowledge for a skill context. | Context semantics; MCP context tools | `CTX-002`, `CTX-005`, `MCP-007` | `TV-CTX-002-P/N`, `TV-CTX-005-P/N`, `TV-MCP-007-P/N` |
| 36 | Let agents maintain multiple shared notes per context. | Context semantics | `CTX-003`, `MCP-007` | `TV-CTX-003-P/N`, `TV-MCP-007-P/N` |
| 37 | Support the PR-review skill used with separate knowledge for multiple projects. | Context semantics / Context-aware retrieval | `CTX-004`, `MCP-004` | `TV-CTX-004-P/N`, `TV-MCP-004-P/N` |
| 38 | Keep context revisions separate from core skill revisions until an explicit amendment. | Goals; Context semantics | `CTX-002`, `CTX-004`, `SKL-006` | `TV-CTX-002-P/N`, `TV-CTX-004-P/N`, `TV-SKL-006-P/N` |
| 39 | Use AuthFn for authentication and credentials. | Architecture; Authentication | `AUTH-001`, `AUTH-003`, `AUTH-007` | `TV-AUTH-001-P/N`, `TV-AUTH-003-P/N`, `TV-AUTH-007-P/N` |
| 40 | Use DataFn for application data management. | DataFn integration | `DATA-002` | `TV-DATA-002-P/N` |
| 41 | Use the Nucleus account service as the AuthFn/DataFn/SendFn composition reference. | Architecture; DataFn integration; SendFn integration | `DATA-002`, `DATA-003`, `AUTH-002` | `TV-DATA-002-P/N`, `TV-DATA-003-P/N`, `TV-AUTH-002-P/N` |
| 42 | Use SendFn from the Superfunctions `next` worktree. | SendFn integration; Engineering evidence | `AUTH-002`, `PROJ-004` | `TV-AUTH-002-P/N`, `TV-PROJ-004-P/N` |
| 43 | Add a Cloudflare Email Service adapter to SendFn if it is absent. | SendFn integration | `AUTH-002`, `PROJ-004` | `TV-AUTH-002-P/N`, `TV-PROJ-004-P/N` |
| 44 | Use Cloudflare Email Service for transactional OTP; domain and Workers Paid prerequisites are satisfied. | Runtime topology; SendFn integration | `AUTH-002`, `OPS-003` | `TV-AUTH-002-P/N`, `TV-OPS-003-P/N` |
| 45 | Add MCP-compatible OAuth authorization-server behavior as an AuthFn plugin if feasible. | OAuth authorization-server plugin | `AUTH-005`, `AUTH-006` | `TV-AUTH-005-P/N`, `TV-AUTH-006-P/N` |
| 46 | Avoid a broad AuthFn core change by implementing the OAuth plugin in Skillplane. | Architecture; AuthFn plugin | `AUTH-005`, `PROJ-004` | `TV-AUTH-005-P/N`, `TV-PROJ-004-P/N` |
| 47 | Support standards-compatible OAuth for interactive remote MCP clients. | OAuth authorization-server plugin; MCP metadata | `AUTH-005`, `AUTH-006`, `MCP-001` | `TV-AUTH-005-P/N`, `TV-AUTH-006-P/N`, `TV-MCP-001-P/N` |
| 48 | Support scoped organization-owned service agents. | Authorization / Roles | `AUTH-007` | `TV-AUTH-007-P/N` |
| 49 | Support personal workspaces and organizations with owner/admin/editor/viewer roles. | Authorization; Roles | `TEN-001`, `AUTH-004` | `TV-TEN-001-P/N`, `TV-AUTH-004-P/N` |
| 50 | Support private, workspace, and public skill visibility. | Authorization / Visibility | `TEN-003` | `TV-TEN-003-P/N` |
| 51 | Include full-text search, invitations, and version review. | Search; Workspaces; Amendment policy | `SKL-010`, `TEN-002`, `SKL-008` | `TV-SKL-010-P/N`, `TV-TEN-002-P/N`, `TV-SKL-008-P/N` |
| 52 | Exclude billing, commercial marketplace behavior, semantic search, private agent notes, and inline comments. | Non-goals; Undefined / explicitly user-deferred only | `SKL-010`, `CTX-003`, `UI-003` | `TV-SKL-010-P/N`, `TV-CTX-003-P/N`, `TV-UI-003-P/N` |
| 53 | Never execute stored skill scripts. | Security; Deterministic bundle | `SKL-002`, `SKL-003`, `QA-003` | `TV-SKL-002-P/N`, `TV-SKL-003-P/N`, `TV-QA-003-P/N` |
| 54 | Use pnpm workspaces and Turborepo. | Architecture / Monorepo | `PROJ-001` | `TV-PROJ-001-P/N` |
| 55 | Maintain `.conduct` ledger, decisions, engineering logs, observations, screenshots, tracker, and spec logs. | Engineering evidence | `PROJ-003`, `QA-004` | `TV-PROJ-003-P/N`, `TV-QA-004-P/N` |
| 56 | Log every minor Superfunctions edit in the Skillplane project. | Engineering evidence; SendFn integration | `PROJ-004` | `TV-PROJ-004-P/N` |
| 57 | Never overwrite or absorb pre-existing dirty Superfunctions work. | Engineering evidence; SendFn integration | `PROJ-004` | `TV-PROJ-004-P/N` |
| 58 | Present a complete production UI with loading, empty, success, validation, authorization, error, retry, and confirmation states. | User interface | `UI-002`, `UI-005` | `TV-UI-002-P/N`, `TV-UI-005-P/N` |
| 59 | Meet production accessibility and responsive behavior. | Accessibility | `UI-004` | `TV-UI-004-P/N` |
| 60 | Build a standalone landing page with truthful product claims and public skill discovery. | Landing surfaces | `UI-003`, `TEN-003` | `TV-UI-003-P/N`, `TV-TEN-003-P/N` |
| 61 | Make database, R2, email, OAuth, security, backup, restore, rollback, and deployment behavior production-operable. | Failure and recovery; Database; Operations | `OPS-002`–`OPS-006`, `QA-003` | `TV-OPS-002-P/N`–`TV-OPS-006-P/N`, `TV-QA-003-P/N` |
| 62 | Require evidence-backed completion rather than build-only or screenshot-only claims. | Engineering evidence; Definition of Done | `QA-001`, `QA-002`, `QA-004` | `TV-QA-001-P/N`, `TV-QA-002-P/N`, `TV-QA-004-P/N` |

## Coverage reconciliation

- Every user-provided feature and constraint appears in the intent inventory.
- Every accepted default appears as a requirement or explicit non-goal.
- Every MUST requirement has objective acceptance criteria and referenced positive and negative vectors.
- Every requirement is assigned to one or more execution phases.
- The later Hyperdrive ID is modeled as a required external production input, not an unresolved product question or committed placeholder.
- The pre-existing dirty SendFn/AuthFn worktree state is modeled as a mandatory implementation preflight and stop condition.
- OAuth feasibility is resolved: AuthFn's public plugin boundary is sufficient for a Skillplane-owned authorization-server plugin, with root metadata mounted through Hono.

## Final audit result

No missing intent items.
