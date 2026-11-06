# flarum2-ops

[![CI](https://github.com/NeoGeoOne/flarum2-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/NeoGeoOne/flarum2-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Lets an AI agent run a [Flarum 2](https://flarum.org) forum through its official admin API and switch between
complete looks ("design-sets") that are previewed, applied and rolled back safely. Three parts:

- **An MCP server and CLI** (`tools/flarum2-ops`) for the Flarum 2 REST API: everything the JSON:API offers,
  plus the admin endpoints that generic clients get wrong (settings, logo/favicon uploads, cache, extensions,
  permissions).
- **A design-set engine**: a look is a folder with settings, LESS, header/footer HTML, images, fonts and tag
  colours. It is validated, applied with a snapshot first and an automatic rollback on failure, previewed with
  screenshots in every colour scheme, and compared in a gallery.
- **An agent skill** (`skills/flarum2-design-ops`) that tells the agent when to use which tool, what needs the
  owner's approval, and the Flarum 2 theming knowledge (LESS variables, selectors, pitfalls), each fact checked
  against the Flarum 2.0 source.

Flarum itself has no theme switching; design-sets add it on top of the official settings API.

## What it handles that plain API scripts get wrong

Verified against Flarum 2.0.2:

| Pitfall | flarum2-ops |
|---|---|
| A wrong token is not rejected; requests silently run as a guest | Checks that the actor is an admin before any write |
| A rejected `custom_less` leaves `custom_less_error` behind and Flarum then drops your custom LESS on every compile | Sends `custom_less` alone, restores the previous value on 422, verifies the flag is clear |
| `DELETE /api/settings` (reset) does not rebuild the CSS | Clears the cache when a CSS key was reset |
| There is no API to read settings; `null` and "not set" behave differently | Read-only database reader that keeps absent / NULL / value apart and redacts secrets |
| Image uploads are multipart with a field name equal to the route; files get random names | Dedicated upload tool with type/size checks; snapshots keep their own copies |
| `custom_less` is compiled before extension LESS; the dark page background is pinned by inline CSS | Documented in the skill, flagged by validation |

## Requirements

- Flarum 2.0.x. Database-backed features (settings reads, snapshots, design-set apply, health) need the tools
  to run on the forum's host with read access to its `config.php`; pure API features work against any forum.
- Node.js 18+, PHP CLI with PDO (the forum's PHP is fine).
- Optional: Python 3.9+ with [Playwright](https://playwright.dev/python/) and Chromium for screenshots.

## Setup

```bash
git clone https://github.com/NeoGeoOne/flarum2-ops.git
cd flarum2-ops/tools/flarum2-ops && npm ci && npm run build && cd ../..
cp forum.example.json forum.json      # set base_url and forum_root of your forum
bash skills/flarum2-design-ops/scripts/ops.sh login    # in a terminal: admin login, password typed hidden
bash skills/flarum2-design-ops/scripts/ops.sh doctor   # health, token, applied set
```

`login` stores a remember-token in `~/.config/flarum2/token` (mode 0600). Alternatively put an access token or
API key there yourself, or set `FLARUM_API_KEY`.

### Skill

Link the skill folder into your agent's skills directory:

| Agent | Personal (all projects) | Per project |
|---|---|---|
| Claude Code | `~/.claude/skills/flarum2-design-ops/` | `.claude/skills/flarum2-design-ops/` |
| OpenCode | `~/.config/opencode/skills/flarum2-design-ops/` | `.opencode/skills/flarum2-design-ops/` |
| Other Agent Skills hosts | `~/.agents/skills/flarum2-design-ops/` | `.agents/skills/flarum2-design-ops/` |

```bash
ln -s "$PWD/skills/flarum2-design-ops" /path/to/your/forum/.claude/skills/flarum2-design-ops
```

The skill's scripts find the repository through the link, so the skill works from any location.

### MCP server

```json
{
  "mcpServers": {
    "flarum2-ops": {
      "command": "bash",
      "args": ["/absolute/path/to/flarum2-ops/tools/flarum2-ops/run-mcp.sh"],
      "env": { "FLARUM_MODE": "read" }
    }
  }
}
```

The server is read-only unless `FLARUM_MODE` is `write`. Even then every mutating tool is a dry run until it is
called with `confirm: true`. Without MCP, the CLI (`skills/flarum2-design-ops/scripts/ops.sh help`) offers the
same operations.

## Design-sets

`ops.sh` below is `skills/flarum2-design-ops/scripts/ops.sh`.

```bash
ops.sh designset new my-look              # from the template
ops.sh designset validate my-look
ops.sh designset diff my-look             # what would change
ops.sh designset preview my-look --confirm   # apply, screenshots, automatic rollback
ops.sh designset gallery                  # design-sets/gallery.html
ops.sh designset apply my-look --confirm
ops.sh designset rollback --confirm       # back to the snapshot taken before the last write
```

The format and its rules are in [skills/flarum2-design-ops/references/design-sets.md](skills/flarum2-design-ops/references/design-sets.md).
Two examples ship with the repository: `flarum-stock` (Flarum's default look) and `slate-amber`.

## Safety model

- Every write is a dry run unless confirmed, takes a snapshot first and is verified by reading it back.
- Design-set writes hold a lock; a failure rolls back automatically.
- Extension toggles (which run database migrations) and permission changes are separate tools that the skill
  always puts in front of the owner on their own.
- The token never appears in output, logs or process arguments. The settings reader uses a read-only database
  session and never prints credentials.

## Validation

```bash
(cd tools/flarum2-ops && npm test)   # offline suite against a mock Flarum 2 server
python3 tools/validate.py            # Agent Skills spec checks for the skill
```

## Contributing

Bug reports and ideas are welcome as [issues](https://github.com/NeoGeoOne/flarum2-ops/issues/new/choose).
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security issues: see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). `tools/flarum2-ops` is a fork of [mcp-for-flarum](https://github.com/linkrobins/mcp-for-flarum)
by Link Robins (MIT); see its [NOTICE](tools/flarum2-ops/NOTICE). The Karla font in `design-sets/slate-amber`
is licensed under the [SIL Open Font License 1.1](design-sets/slate-amber/OFL.txt).
