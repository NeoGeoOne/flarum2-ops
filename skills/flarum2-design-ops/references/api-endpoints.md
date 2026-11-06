# Flarum 2.0.2 REST API: endpoints for operators

Generated from `vendor/flarum/core/src/Api/routes.php` and the JSON:API resource classes of the installed
version; the official docs (https://docs.flarum.org/rest-api/) only show examples and recommend reading the
admin SPA's network requests for the rest. Paths are relative to `<base_url>/api`. With the
flarum2-ops tools a leading `/api` is optional.

## Auth (official docs + `Http/Middleware/AuthenticateWithHeader.php`)

- `Authorization: Token <access-token>`: token from `POST /token {identification, password, remember: 1}`
  (`session_remember`, 5-year sliding lifetime; without remember: 1 h). This is what `flarum2-ops login` stores.
- `Authorization: Token <api-key>; userId=<id>`: master key from the `api_keys` table (DB insert; needs approval).
- Either header bypasses CSRF. **An invalid token is not rejected; the request runs as a guest** (reads succeed,
  admin calls 403). Always verify with `flarum_whoami` / `doctor`.
- Failed logins are throttled (5/min per IP + identification, 30 per 10 min per IP → 429).
- No header + non-GET → `400 csrf_token_mismatch`.

## Admin endpoints (all require an admin actor)

| Method & path | Body | Success | Side effects / notes |
|---|---|---|---|
| `POST /settings` | flat object `{"key": "value", …}` | 204 | Saving `custom_less` runs a trial compile first (422 on error, and `custom_less_error` may be left set); colours/custom_less mark forum CSS for rebuild |
| `DELETE /settings` | `{"keys": [...]}` | 204 | Back to defaults; **no CSS rebuild** |
| `POST /logo` · `/logo-dark-mode` · `/email-logo` · `/favicon` | multipart, field name = route name | 200 + forum document | ≤2 MB, ≤24 MP, jpeg/png/gif/webp/bmp; random file name; previous file deleted |
| `DELETE /logo` (same 4 routes) | – | 204 | Removes file; setting becomes NULL |
| `DELETE /cache` | – | 200 NDJSON stream | Clears cache store (also login throttles), formatter/locale/views; rebuilds all assets; seconds |
| `PATCH /extensions/{id}` | `{"enabled": true}` | 204 | **Enable runs migrations** + publishes assets; disable keeps data |
| `DELETE /extensions/{id}` | – | – | **Uninstall: rolls migrations back and drops data. Never use.** |
| `POST /extension-bisect` | – | – | Finds a breaking extension; uses maintenance mode. CLI `php flarum extension:bisect` is safer |
| `POST /permission` | `{"permission": "startDiscussion", "groupIds": [3]}` | 204 | **Replaces** all groups for that permission |
| `POST /groups/order` | order payload | – | Reorders groups |
| `GET /mail/settings` · `POST /mail/test` | – | – | Mail driver info / test mail |
| `POST /queue/pause` · `GET /queue/stats` · `GET /queue/failed` · `POST /queue/failed/retry` · `POST /queue/failed/{id}/retry` · `DELETE /queue/failed/{id}` | – | – | Queue management (sync queue here) |
| `POST /extensions/abandoned/sync` | – | – | Refreshes abandoned-extension list (network) |

## JSON:API resources (`GET /<type>`, `GET /<type>/{id}`, `POST`, `PATCH`, `DELETE`)

| Type | Endpoints | Typical use |
|---|---|---|
| `forums` | `GET /` (the forum document) | public settings as attributes; `relationships.actor` = current user (null = guest) |
| `discussions` | index, show, create, update, delete | content |
| `posts` | index, show, create, update, delete | content |
| `users` | index, show, create, update, delete | `GET /users/{id}?include=groups` for the actor's groups |
| `groups` | index, show, create, update, delete | group 1 admin, 2 guest, 3 member, 4 mod |
| `tags` (flarum-tags) | index, show, create, update, delete | PATCH attributes: `name`, `description` (≤700), `slug`, `color` (hex), `icon`, `isHidden`, `isPrimary`, `defaultSort`; `isRestricted` on update. No background fields in 2.0.2 |
| `POST /tags/order` (flarum-tags) | `{"order":[{"id":"1","children":[…]}]}` | **resets position/parent/primary of every tag first**; omitted tags become secondary |
| `flags` (flarum-flags) | index, create | moderation |
| `notifications` | index, show, update | per user |
| `access-tokens` | index, create, delete | token management |
| `mail-settings`, `system-info`, `extension-readmes` | show | admin dashboard data |

JSON:API write shape: `{"data": {"type": "tags", "id": "1", "attributes": {"color": "#B45309"}}}`.
Lists page with `page[limit]` (≤50) and `page[offset]`; follow `links.next`.

## Errors
- `400 csrf_token_mismatch`: no/invalid `Authorization` header on a write.
- `403 permission_denied`: actor lacks permission (check whoami: often a guest because the token is invalid).
- `404 route_not_found`: wrong path (e.g. `/api/api/...` from tools that prepend `/api`).
- `422 validation_error`: `errors[].source.pointer` names the field (`/data/attributes/<field>`; for settings `/data/attributes/<key>`, e.g. `/data/attributes/custom_less` with the less.php message in `detail`).
- Timeouts on writes: the change may still have happened; re-read state before retrying. Never retry blindly.

## Reading settings
There is **no** settings GET (`GET /settings` → 405). `GET /` exposes only public ones
(`themePrimaryColor`, `colorScheme`, `headerHtml`, `logoUrl`…; not `custom_less`, `theme_colored_header` or
extension settings). Use `flarum_settings_get` (read-only DB access with secrets redacted).
