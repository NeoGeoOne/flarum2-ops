# __PACKAGE_TITLE__ — Flarum 2 Theme Extension

This package is a deliberately small Flarum 2 theme-extension scaffold.

It contains:

- `composer.json` with Flarum extension metadata
- `extend.php` with `Frontend` asset registration
- `less/forum.less` for public forum design
- `less/admin.less` for optional admin design

It does not install or enable itself. Review the package and the current official Flarum 2 documentation before installing it.

If the design needs structural frontend behavior, use the current official Flarum frontend tooling and Mithril extension patterns. Do not edit compiled assets or `vendor/` directly.

Official references:

- https://docs.flarum.org/extend/start/
- https://docs.flarum.org/extend/theme/
- https://docs.flarum.org/extend/frontend/
