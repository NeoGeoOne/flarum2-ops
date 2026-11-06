/** Single source of the version string (kept in sync with package.json by a test). */
export const VERSION = "1.0.0";

/**
 * Outbound User-Agent: explicit and identifiable (WAFs such as Cloudflare block
 * empty/generic agents). Override with FLARUM_USER_AGENT.
 */
export const DEFAULT_USER_AGENT = `flarum2-ops/${VERSION} (fork of mcp-for-flarum 0.8.0)`;
