# AGENTS.md

Conventions for everyone changing this repository, contributors and coding agents alike. README.md explains
what the project does and how to install it; this file holds only what is easy to get wrong.

## Commands

```bash
cd tools/flarum2-ops && npm ci && npm test   # builds (tsc) and runs the offline suite against a mock Flarum 2 server
python3 tools/validate.py                    # Agent Skills spec checks for skills/*
php -l tools/flarum2-ops/helpers/settings_read.php
```

## Where to edit

- `tools/flarum2-ops/src/`: the engine. `flarum-client.ts` (HTTP), `ops.ts` (admin operations),
  `designset.ts` (design-set engine), `policy.ts` (key policy, LESS lint), `cli.ts` and `server.ts`/`tools/`
  (the two front ends). Both front ends must stay thin: logic belongs in `ops.ts` / `designset.ts`.
- `skills/flarum2-design-ops/`: the agent skill. Facts about Flarum go into `references/`, each with its source
  (file in flarum/core or the official docs). Keep `SKILL.md` a short router.
- `design-sets/`: example sets only. Personal sets of a forum do not belong in the repository.

## Constraints

- Every mutating operation is a dry run unless confirmed (`--confirm` / `confirm: true`). Do not add a write
  path that skips this, the pre-write snapshot or the read-back verification.
- The credential is read only from `FLARUM_API_KEY` or the token file. Never print it, log it, put it in
  process arguments or add a tool that returns it.
- The MCP server starts read-only; write tools are registered only in write mode.
- Claims about Flarum behaviour must be checked against the Flarum 2.0.x source before they go into code or
  references. Write a test with the mock server (`test/helpers/mock-flarum.mjs`) for every engine change.
- Node 18+; the helpers use PHP (PDO) and optional Python 3.9+ with Playwright for screenshots.
