# flarum2-ops (engine)

The TypeScript engine behind this repository: one code base, two front ends.

- `dist/index.js` (`flarum2-ops-mcp`): MCP server over stdio (or Streamable HTTP with `--http`).
  Start it with `run-mcp.sh`, which loads `../../forum.json` and is **read-only** unless `FLARUM_MODE=write`.
- `dist/cli.js` (`flarum2-ops`): the same operations as a CLI with JSON output. Every write is a dry run unless
  `--confirm` is given (exit code 3 = dry run).

```bash
npm ci
npm run build
npm test        # builds and runs the offline suite against a mock Flarum 2 server
```

`helpers/settings_read.php` reads settings through a read-only PDO session using the forum's own `config.php`;
`helpers/screenshot.py` drives headless Chromium through Playwright.

Setup, configuration, the tool list and the safety model are in the [main README](../../README.md).
This package is a fork of [mcp-for-flarum](https://github.com/linkrobins/mcp-for-flarum) 0.8.0 (MIT); see
[NOTICE](NOTICE) for what changed.
