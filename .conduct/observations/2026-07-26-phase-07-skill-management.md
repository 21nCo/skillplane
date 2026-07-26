# PHASE_07 skill-management observations

## Product workflow

The inventory is deliberately dense without becoming a dashboard of cards:
search, visibility, lifecycle, and pagination sit in a compact control band,
while every result exposes current semantic version, publication state, tags,
and last modification. Archived skills are absent by default and discoverable
through an explicit lifecycle filter.

Creation supports two equivalent production paths. Direct authoring constructs
a deterministic bundle from `SKILL.md`; upload validates the selected ZIP
before submission. Required-field validation is native and visible. Success
lands on the persisted overview and survives reload.

The detail surface keeps overview, content, versions, and settings as direct
routes. Content browsing is exact-version-aware and shows manifest paths,
media types, byte sizes, and shortened digests. Markdown is sanitized before
rendering. Text, image, and binary files each have a deliberate presentation
or download path.

## Version and conflict evidence

Revision 1 was published as `1.0.0`. Editing created immutable revision 2 with
a base pointer to revision 1 and a proposed patch bump. Its exact route showed
the changed instructions in a unified diff and remained stable after reload.
Publication assigned `1.0.1`; history then rendered both unified and
side-by-side comparisons.

The conflict workflow created two candidates from one published base. The
first approval advanced the current version. Approval of the second returned
the typed stale-base conflict, and the UI retained the candidate while
explaining that no state changed.

## Authorization and public access

Owners/admins can publish or reject candidates. Editors can author candidate
content but cannot perform approval-only operations. Viewers receive a
read-only UI: create/edit/archive controls are absent, settings controls are
disabled, and a direct `PATCH` receives `403 FORBIDDEN`.

Public skill and file endpoints never rely on browser membership. They return
only an active, public skill's current published version. Private and archived
states produce `404`, including for a signed-in browser without a workspace
header, so public URLs behave consistently without leaking private existence.

## Accessibility matrix

The WCAG scan covers eight core routes across three viewports and two themes:

| Route family | 390x844 | 768x1024 | 1440x900 |
|---|---:|---:|---:|
| Inventory/create | 0 violations | 0 violations | 0 violations |
| Overview/content | 0 violations | 0 violations | 0 violations |
| Versions/exact version | 0 violations | 0 violations | 0 violations |
| Settings/public | 0 violations | 0 violations | 0 violations |

The suite runs WCAG 2.0 A/AA, 2.1 AA, and 2.2 AA tags in dark and light themes.
Dialog focus moves to the destructive action, Escape closes and restores
focus, scroll regions are named and keyboard reachable, and no checked
viewport has page-level horizontal overflow.

## Visual regression inventory

Nine Chromium goldens use reduced motion and disabled animations:

- `skills-list-desktop-dark-darwin.png`
- `skill-create-desktop-light-darwin.png`
- `skill-overview-desktop-dark-darwin.png`
- `skill-overview-mobile-light-darwin.png`
- `skill-content-desktop-dark-darwin.png`
- `skill-versions-tablet-dark-darwin.png`
- `skill-version-detail-desktop-light-darwin.png`
- `skill-settings-dialog-desktop-light-darwin.png`
- `skill-public-desktop-light-darwin.png`

Manual inspection of the narrative captures found a restrained
Linear-inspired hierarchy, readable diffs, clear destructive/conflict states,
and no clipped core control at mobile width.

## Narrative screenshot index

| Screenshot | Observation |
|---|---|
| `skills-error-retry-desktop-dark.png` | storage error is distinct and retryable |
| `skill-create-validation-desktop-dark.png` | required create fields block submission |
| `skill-overview-created-desktop-dark.png` | persisted `1.0.0` overview after reload |
| `skill-candidate-exact-diff-desktop-dark.png` | revision 2 provenance and exact diff |
| `skill-publish-conflict-desktop-dark.png` | stale-base conflict preserves candidate |
| `skill-public-share-desktop-dark.png` | anonymous current published content |
| `skill-archive-confirmation-desktop-dark.png` | focus-managed destructive confirmation |
| `skill-archived-settings-desktop-dark.png` | archive persists after reload |
| `skill-viewer-authorization-desktop-dark.png` | viewer settings and controls are read-only |
| `skill-overview-mobile-light.png` | 390-pixel responsive overview in light theme |
