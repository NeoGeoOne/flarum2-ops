# Contributing

Thanks for your interest in flarum2-ops.

## Issues

Bug reports and ideas are welcome. Use one of the [issue forms](https://github.com/NeoGeoOne/flarum2-ops/issues/new/choose) and include
the Flarum version, the steps to reproduce, what you expected and what happened.

## Pull requests

Please open an issue first and wait for a reply before you start on a pull request, so that no work is
wasted on a change that does not fit the project. Then:

1. Keep the pull request to one topic and link the issue.
2. Run the local checks; CI runs the same:
   ```bash
   (cd tools/flarum2-ops && npm ci && npm test)
   python3 tools/validate.py
   ```
3. Follow the conventions in [AGENTS.md](AGENTS.md); they apply to humans and coding agents alike.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).
