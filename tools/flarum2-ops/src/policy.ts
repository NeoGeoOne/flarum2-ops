/**
 * Settings key policy and value validation for Flarum 2.0.x.
 *
 * Facts (verified against flarum/core 2.0.2):
 *  - POST /api/settings stores every value as a string; booleans become '1'/'0'.
 *  - Values longer than 65000 chars are rejected (SettingsValidator).
 *  - color_scheme is NOT validated server-side; valid ids come from
 *    js/src/common/components/ThemeMode.tsx.
 *  - allow_user_color_scheme is written by the admin UI but read nowhere.
 *  - custom_less: data-uri() refused, local @import only from Flarum's own
 *    import dirs, compiled BEFORE extension LESS (ForumServiceProvider:140).
 */

export const COLOR_SCHEMES = ["auto", "light", "dark", "light-hc", "dark-hc"] as const;
export const MAX_SETTING_LENGTH = 65000;

/**
 * "Theme" keys: a design-set fully defines these. When a set omits one, apply
 * resets it to Flarum's default so switching sets is deterministic.
 */
export const THEME_KEYS = [
  "theme_primary_color",
  "theme_secondary_color",
  "theme_colored_header",
  "color_scheme",
  "show_theme_selector",
  "custom_less",
  "custom_header",
  "custom_footer",
] as const;

/** Optional presentation/content keys: only touched when a set specifies them. */
export const OPTIONAL_DESIGN_KEYS = [
  "forum_title",
  "forum_description",
  "welcome_title",
  "welcome_message",
  "default_route",
  "show_language_selector",
  "fontawesome_source",
  "fontawesome_cdn_url",
  "fontawesome_kit_url",
  "fontawesome_forced_style",
] as const;

/** Image setting keys (managed through the upload endpoints, never POSTed directly). */
export const IMAGE_KINDS = {
  logo: { route: "/logo", field: "logo", pathKey: "logo_path", urlAttr: "logoUrl" },
  logo_dark_mode: { route: "/logo-dark-mode", field: "logo-dark-mode", pathKey: "logo_dark_mode_path", urlAttr: "logoDarkModeUrl" },
  email_logo: { route: "/email-logo", field: "email-logo", pathKey: "email_logo_path", urlAttr: "emailLogoUrl" },
  favicon: { route: "/favicon", field: "favicon", pathKey: "favicon_path", urlAttr: "faviconUrl" },
} as const;
export type ImageKind = keyof typeof IMAGE_KINDS;

/** Keys whose change needs DELETE /api/cache to show up (no automatic rebuild). */
export const NEEDS_CACHE_CLEAR_KEYS = ["fontawesome_source", "fontawesome_cdn_url", "fontawesome_kit_url"];

/** Keys that the forum CSS depends on (rebuild triggers / reset side effects). */
export const CSS_KEYS = ["custom_less", "theme_primary_color", "theme_secondary_color"];

/** Never writable through this tool: managed by Flarum itself, writing them breaks things. */
const FORBIDDEN: RegExp[] = [
  /^extensions_enabled$/,
  /^version$/,
  /^assets_dirty\./,
  /^custom_less_error$/,
  /^(logo|logo_dark_mode|email_logo|favicon)_path$/,
  /^(email_logo|logo_email_copy)_(path|size)$/,
  /^logo_email_copy_path$/,
];

/** Writable only with an explicit protected-key confirmation. */
const PROTECTED: RegExp[] = [
  /^maintenance_mode$/,
  /^safe_mode_extensions$/,
  /^mail_/,
  /(pass(word)?|secret|token|api_?key|private|credential|(^|[._-])key$)/i,
  /^(slug|search|display_name|avatar)_driver/,
  /^default_locale$/,
  /^allow_sign_up$/,
];

/** Same rule as the PHP reader: values of these keys are never displayed. */
export function isSecretKey(key: string): boolean {
  if (/^mail_/.test(key) && !["mail_driver", "mail_format", "mail_from"].includes(key)) return true;
  return /(pass(word)?|secret|token|api_?key|private|credential|(^|[._-])key$)/i.test(key);
}

export type KeyClass = "theme" | "optional" | "extension" | "protected" | "forbidden" | "other";

export function classifyKey(key: string, enabledExtensionIds: string[] = []): KeyClass {
  if (FORBIDDEN.some((r) => r.test(key))) return "forbidden";
  if (PROTECTED.some((r) => r.test(key))) return "protected";
  if ((THEME_KEYS as readonly string[]).includes(key)) return "theme";
  if ((OPTIONAL_DESIGN_KEYS as readonly string[]).includes(key)) return "optional";
  if (extensionPrefixOf(key, enabledExtensionIds)) return "extension";
  return "other";
}

/**
 * Extension settings are conventionally prefixed with the extension id
 * ("flarum-tags.max_primary_tags", "fof-upload.mimeTypes") or the vendor-name
 * form with a dash. Returns the matching extension id, if any.
 */
export function extensionPrefixOf(key: string, extensionIds: string[]): string | undefined {
  const head = key.split(".")[0];
  return extensionIds.find((id) => head === id || head === id.replace(/^flarum-/, ""));
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BOOL_KEYS = new Set(["theme_colored_header", "show_theme_selector", "show_language_selector"]);

export interface ValidationIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

/** Normalise a value to what Flarum stores (strings; booleans as '1'/'0'). */
export function normaliseValue(key: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (BOOL_KEYS.has(key) && /^(true|false)$/i.test(value)) return /^true$/i.test(value) ? "1" : "0";
    return value;
  }
  return JSON.stringify(value);
}

export function validateValue(key: string, value: string | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === null) {
    issues.push({
      key,
      level: "warning",
      message: "null stores a NULL row that hides Flarum's default; use a reset (DELETE) to return to the default",
    });
    return issues;
  }
  if (value.length > MAX_SETTING_LENGTH) {
    issues.push({ key, level: "error", message: `value is ${value.length} chars; Flarum rejects values over ${MAX_SETTING_LENGTH}` });
  }
  if ((key === "theme_primary_color" || key === "theme_secondary_color") && !HEX.test(value)) {
    issues.push({ key, level: "error", message: `must be a hex color like #4D698E (got "${value.slice(0, 40)}")` });
  }
  if ((key === "theme_primary_color" || key === "theme_secondary_color") && /@impor|data-uri\s*\(/i.test(value)) {
    issues.push({ key, level: "error", message: "LESS directives are refused in color settings" });
  }
  if (key === "color_scheme" && !(COLOR_SCHEMES as readonly string[]).includes(value)) {
    issues.push({ key, level: "error", message: `must be one of ${COLOR_SCHEMES.join(", ")} (the server does not validate this)` });
  }
  if (BOOL_KEYS.has(key) && value !== "0" && value !== "1") {
    issues.push({ key, level: "error", message: 'must be "1"/"0" (or true/false)' });
  }
  if (key === "default_route" && !value.startsWith("/")) {
    issues.push({ key, level: "error", message: 'must be a forum route such as "/all" or "/tags"' });
  }
  if (key === "custom_less") issues.push(...lintLess(value));
  if ((key === "custom_header" || key === "custom_footer" || key === "welcome_message") && /<script\b/i.test(value)) {
    issues.push({
      key,
      level: "warning",
      message: "contains <script>: it runs for every visitor (raw, unescaped HTML) and is readable by guests via /api",
    });
  }
  if (key === "allow_user_color_scheme") {
    issues.push({ key, level: "warning", message: "Flarum 2.0 never reads this key; users may pick a scheme exactly when color_scheme is auto" });
  }
  return issues;
}

/** Static checks that catch the common custom_less failures before Flarum's trial compile. */
export function lintLess(less: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const code = stripLessComments(less);
  if (/data-uri\s*\(/i.test(code)) {
    issues.push({ key: "custom_less", level: "error", message: "data-uri() is refused by Flarum (ValidateCustomLess)" });
  }
  for (const m of code.matchAll(/@import\s+(?:\([^)]*\)\s*)?(?:url\()?\s*["']?([^"');\s]+)/gi)) {
    const target = m[1];
    if (/^https:\/\//i.test(target) || /^http:\/\//i.test(target)) {
      issues.push({
        key: "custom_less",
        level: "warning",
        message: `remote @import ${target}: allowed by Flarum but every visitor's browser contacts that host (privacy/GDPR); prefer self-hosted files`,
      });
    } else if (target.startsWith("//")) {
      issues.push({ key: "custom_less", level: "error", message: `protocol-relative @import ${target} is refused by Flarum` });
    } else {
      issues.push({
        key: "custom_less",
        level: "error",
        message: `local @import ${target} is refused (only Flarum's own import dirs are allowed); inline the rules or use @font-face url()`,
      });
    }
  }
  // less.php evaluates a / b in property values as division (grid-column: 1 / 3 -> 0.333).
  const division = /(grid-(?:column|row|area)|aspect-ratio|font)\s*:\s*[^;{}~"']*\d\s*\/\s*\d/i.exec(code);
  if (division) {
    issues.push({
      key: "custom_less",
      level: "warning",
      message: `"${division[0].trim()}" contains "a / b", which less.php may compute as a division; escape it as ~"1 / 3"`,
    });
  }
  const opens = (code.match(/{/g) ?? []).length;
  const closes = (code.match(/}/g) ?? []).length;
  if (opens !== closes) {
    issues.push({ key: "custom_less", level: "error", message: `unbalanced braces ({ ${opens} vs } ${closes})` });
  }
  return issues;
}

function stripLessComments(s: string): string {
  // Remove /* */ blocks and // line comments outside of strings/urls (good enough for linting).
  // A "//" only starts a comment at line start or after whitespace, ";", "{" or "}"
  // (never inside url(//host/…) or "https://…").
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}])\/\/[^\n]*/g, "$1");
}

/** Validate a whole settings write. */
export function checkSettingsWrite(
  values: Record<string, unknown>,
  opts: { enabledExtensions: string[]; allowProtected?: boolean; allowOther?: boolean },
): { normalised: Record<string, string | null>; issues: ValidationIssue[] } {
  const normalised: Record<string, string | null> = {};
  const issues: ValidationIssue[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const cls = classifyKey(key, opts.enabledExtensions);
    if (cls === "forbidden") {
      issues.push({
        key,
        level: "error",
        message: /_path$|_size$/.test(key)
          ? "image paths are managed by the upload endpoints; use flarum_upload_image / flarum_delete_image"
          : "managed by Flarum itself; writing it can break the forum",
      });
      continue;
    }
    if (cls === "protected" && !opts.allowProtected) {
      issues.push({ key, level: "error", message: "protected key (security/availability); requires allowProtected:true with explicit user approval" });
      continue;
    }
    if (cls === "other" && opts.allowOther === false) {
      issues.push({ key, level: "error", message: "not a known design key and not prefixed by an enabled extension id" });
      continue;
    }
    const value = normaliseValue(key, raw);
    issues.push(...validateValue(key, value));
    normalised[key] = value;
  }
  return { normalised, issues };
}
