# Skillplane CLI

Install, manage, and synchronize versioned AI-agent skills from local or hosted
workspaces. Skillplane is local-first: an offline workspace needs no account,
database, server, or network connection.

- Project skills into Codex or Claude
- Combine one writable primary workspace with ordered, read-only mounts
- Review permission changes before installing updated skills
- Pin, roll back, export, and import immutable skill versions
- Connect to hosted Skillplane workspaces without storing tokens in project files

## Requirements

- Node.js 22.13–24
- macOS or Linux
- macOS Keychain or Linux Secret Service only when using hosted credentials

## Install

```bash
npm install --global skillplane
skillplane --help
```

## Quick start

From the project where you want agent skills to be available:

```bash
skillplane init Personal --target codex
skillplane list
skillplane sync
skillplane doctor
```

Use `--target claude` instead to create a Claude skill projection. Initialization
creates a local primary workspace and a project `skillplane.json`. Private runtime
state defaults to `~/.skillplane`; select another location with
`SKILLPLANE_HOME` or `--home`.

Local workspaces work entirely offline. Skillplane writes only to the configured
primary workspace; mounted workspaces remain read-only.

## Create and retrieve a local skill

Create a request file such as `new-skill.json`:

```json
{
  "slug": "review",
  "name": "Review",
  "description": "Review changes carefully",
  "instructions": "Read the changes and explain concrete problems.",
  "idempotencyKey": "create-review-1"
}
```

Then create, inspect, and project the skill:

```bash
skillplane create new-skill.json
skillplane list
skillplane retrieve SKILL_ID
skillplane sync
```

Every published version is immutable. Amendments are based on an exact version
and remain reviewable instead of silently replacing existing content.

## Hosted workspaces

Register a hosted profile by piping its bearer token from your secret manager:

```bash
secret-manager-command | skillplane profile add work https://mcp.skillplane.dev/mcp ACCOUNT_ID
skillplane profile list
```

Credentials pass through standard input and are stored in the operating system's
credential store. They are never accepted as command arguments or written to
`skillplane.json` or the local SQLite database.

Configure hosted primary workspaces and read-only mounts with:

```bash
skillplane configure path/to/workspace-config.json
skillplane list
skillplane sync
```

See the
[local-first workspace guide](https://github.com/21nCo/skillplane/blob/main/docs/local-first-workspaces.md)
for the complete configuration format, profiles, collision policies, projections,
trust review, recovery, and observed usage reporting.

## Commands

| Command                              | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `init [NAME] [--target TARGET]`      | Create a workspace; target is `claude` or `codex`   |
| `configure FILE`                     | Validate and save a project configuration           |
| `profile add ALIAS ENDPOINT ACCOUNT` | Read a hosted credential from standard input        |
| `profile list`                       | List profiles without revealing credentials         |
| `list`                               | Show the ordered visible skill catalog              |
| `create FILE`                        | Create a skill in the primary workspace             |
| `retrieve SKILL_ID [VERSION_ID]`     | Read a skill version from the primary workspace     |
| `amend FILE`                         | Propose an exact-base amendment                     |
| `candidates SKILL_ID`                | List pending reviews for a skill                    |
| `decide FILE`                        | Approve or reject an exact review                   |
| `export SKILL_ID FILE [VERSION_ID]`  | Export an immutable bundle                          |
| `import FILE KEY`                    | Import a bundle as a new skill                      |
| `sync`                               | Atomically install or update configured projections |
| `resolve PROJECTION_ID`              | Resolve a projected skill from live or cached state |
| `approve-trust ID DIGEST`            | Approve the exact reviewed permission digest        |
| `rollback ID`                        | Restore and pin the previous verified version       |
| `uninstall ID`                       | Remove a verified Skillplane-owned projection       |
| `doctor [--online]`                  | Check ownership, divergence, trust, and freshness   |
| `usage`                              | Show observed usage and coverage disclosure         |
| `usage-upload`                       | Upload queued cloud-workspace events after consent  |
| `usage-record FILE`                  | Record a local action or completion report          |
| `usage-consent MODE`                 | Set explicit event-upload consent to `on` or `off`  |

Global options:

- `--project DIR` selects a project without changing directories.
- `--home DIR` selects the private runtime state directory.
- `--agent PRODUCT` declares the calling product when resolving or recording use.
- `resolve` accepts `--live-only` or `--cache-only`.

Run `skillplane --help` for the authoritative command summary.

## Trust and recovery

Skillplane projects self-contained, immutable generations. Permission-expanding
updates wait for approval of their exact digest. A resolver chooses one source—live,
cached, or embedded—and never combines instructions from one version with assets
from another.

Use `skillplane doctor` to inspect local ownership and pending trust. Use
`skillplane doctor --online` when cloud freshness should also be checked.

## Links

- [Skillplane](https://skillplane.dev)
- [Documentation](https://github.com/21nCo/skillplane/tree/main/docs)
- [Local-first workspace guide](https://github.com/21nCo/skillplane/blob/main/docs/local-first-workspaces.md)
- [Issue tracker](https://github.com/21nCo/skillplane/issues)

## License

[MIT](./LICENSE)
