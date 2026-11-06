/**
 * Admin operations shared by the MCP tools and the CLI.
 *
 * Every mutating operation follows one contract:
 *   - without confirm: a dry run that returns exactly what would be sent
 *     (plus validation issues and the current values), and changes nothing;
 *   - with confirm: performs the write, verifies the result and reports the
 *     HTTP status of every request it made.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { FlarumClient, FlarumError, type FlarumResponse } from "./flarum-client.js";
import type { OpsConfig } from "./config.js";
import { requireAdmin, whoami, type Actor } from "./auth.js";
import {
  CSS_KEYS,
  IMAGE_KINDS,
  NEEDS_CACHE_CLEAR_KEYS,
  checkSettingsWrite,
  isSecretKey,
  type ImageKind,
  type ValidationIssue,
} from "./policy.js";
import {
  listSettingKeys,
  readPermissions,
  readSettings,
  recentLogErrors,
  serviceStates,
  valueOf,
  type SettingsMap,
} from "./local.js";

/**
 * Read access to the forum's settings/permissions tables. The default goes
 * through helpers/settings_read.php (read-only PDO); tests inject a fake.
 */
export interface SettingsStore {
  read(keys: string[], prefixes?: string[]): Promise<SettingsMap>;
  listKeys(): Promise<{ key: string; secret: boolean }[]>;
  permissions(names: string[]): Promise<Record<string, number[]>>;
}

export class PhpSettingsStore implements SettingsStore {
  constructor(private readonly forumRoot: string) {}
  read(keys: string[], prefixes: string[] = []) {
    return readSettings(this.forumRoot, keys, prefixes);
  }
  listKeys() {
    return listSettingKeys(this.forumRoot);
  }
  permissions(names: string[]) {
    return readPermissions(this.forumRoot, names);
  }
}
import { checkUpload, kindAdvice } from "./images.js";

export interface StepResult {
  step: string;
  method?: string;
  path?: string;
  status?: number;
  ok: boolean;
  detail?: unknown;
}

export class OpsError extends Error {
  steps: StepResult[];
  constructor(message: string, steps: StepResult[] = []) {
    super(message);
    this.name = "OpsError";
    this.steps = steps;
  }
}

/** Compact error description of a non-2xx response (JSON:API errors[] when present). */
export function describeFailure(res: FlarumResponse): string {
  const body = res.body as { errors?: { code?: string; detail?: string; source?: { pointer?: string } }[] } | null;
  if (body && Array.isArray(body.errors) && body.errors.length) {
    return body.errors
      .map((e) => [e.code, e.source?.pointer, e.detail].filter(Boolean).join(" "))
      .join("; ");
  }
  return typeof res.body === "string" ? res.body.slice(0, 500) : JSON.stringify(res.body)?.slice(0, 500) ?? "";
}

export class Ops {
  readonly store?: SettingsStore;

  constructor(
    readonly cfg: OpsConfig,
    readonly client: FlarumClient,
    store?: SettingsStore,
  ) {
    this.store = store ?? (cfg.forumRoot ? new PhpSettingsStore(cfg.forumRoot) : undefined);
  }

  /** Settings store; throws a clear error when there is no local install. */
  get db(): SettingsStore {
    if (!this.store) throw new Error("This needs a local install: set forum_root in forum.json (or FLARUM_ROOT).");
    return this.store;
  }

  get local(): boolean {
    return Boolean(this.store);
  }

  // ---------------------------------------------------------------- reads

  async whoami(): Promise<{ actor: Actor; forum: Record<string, unknown> }> {
    return whoami(this.client);
  }

  async enabledExtensions(): Promise<string[]> {
    if (!this.store) return [];
    const raw = valueOf(await this.store.read(["extensions_enabled"]), "extensions_enabled");
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** Settings by key/prefix from the database (secret keys redacted). */
  async settingsGet(keys: string[], prefixes: string[] = []): Promise<SettingsMap> {
    return this.db.read(keys, prefixes);
  }

  async customLessError(): Promise<string | undefined> {
    if (!this.store) return undefined;
    return valueOf(await this.store.read(["custom_less_error"]), "custom_less_error");
  }

  /** Health: services, root/API/stylesheet HTTP status, new log errors, custom_less_error. */
  async health(since: Date = new Date(Date.now() - 15 * 60_000)): Promise<Record<string, unknown> & { ok: boolean }> {
    const problems: string[] = [];
    const base = this.client.forumUrl;
    const fetchStatus = async (url: string) => {
      try {
        const r = await fetch(url, { redirect: "manual" });
        return { status: r.status, text: r.headers.get("content-type")?.includes("html") ? await r.text() : "" };
      } catch (e) {
        return { status: 0, text: "", error: (e as Error).message };
      }
    };
    const root = await fetchStatus(`${base}/`);
    const api = await fetchStatus(`${base}/api`);
    if (root.status !== 200) problems.push(`forum root returned ${root.status}`);
    if (api.status !== 200) problems.push(`API root returned ${api.status}`);

    const assets: Record<string, number> = {};
    for (const m of root.text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, "&");
      const r = await fetchStatus(href.startsWith("http") ? href : `${base}${href}`);
      assets[href] = r.status;
      if (r.status !== 200) problems.push(`stylesheet ${href} returned ${r.status}`);
    }
    if (root.status === 200 && Object.keys(assets).length === 0) problems.push("no stylesheet link found in the forum HTML");

    const out: Record<string, unknown> & { ok: boolean } = { ok: false, root: root.status, api: api.status, stylesheets: assets };
    if (this.local && this.cfg.forumRoot) {
      out.services = await serviceStates(this.cfg.services);
      for (const [s, st] of Object.entries(out.services as Record<string, string>)) {
        if (st !== "active") problems.push(`service ${s} is ${st}`);
      }
      const logs = recentLogErrors(this.cfg.forumRoot, since);
      out.logErrorsSince = since.toISOString();
      out.logErrors = logs.errors;
      if (logs.unreadable.length) out.unreadableLogs = logs.unreadable;
      if (logs.errors.length) problems.push(`${logs.errors.length} error line(s) in storage/logs since ${since.toISOString()}`);
    }
    if (this.local) {
      const cle = await this.customLessError();
      if (cle) {
        out.customLessError = cle;
        problems.push("custom_less_error is set: Flarum is silently dropping custom_less until a valid custom_less is saved");
      }
    }
    out.problems = problems;
    out.ok = problems.length === 0;
    return out;
  }

  // --------------------------------------------------------------- writes

  /**
   * POST /api/settings. custom_less goes in its own request first so a 422
   * from the trial compile is attributable and nothing else is persisted; on
   * failure the previous custom_less is re-saved, which clears the
   * custom_less_error flag Flarum leaves behind.
   */
  async settingsSet(
    values: Record<string, unknown>,
    opts: { confirm?: boolean; allowProtected?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const ext = await this.enabledExtensions();
    const { normalised, issues } = checkSettingsWrite(values, { enabledExtensions: ext, allowProtected: opts.allowProtected });
    const errors = issues.filter((i) => i.level === "error");
    const keys = Object.keys(normalised);
    const current = this.local && keys.length ? await this.db.read(keys) : {};
    const changes = keys.map((k) => ({
      key: k,
      from: isSecretKey(k) ? "***" : summarise(current[k]),
      to: isSecretKey(k) ? "***" : preview(normalised[k]),
    }));
    if (!opts.confirm || errors.length) {
      return { dryRun: true, wouldSend: changes, issues, blocked: errors.length > 0 };
    }
    await requireAdmin(this.client);
    const steps: StepResult[] = [];
    if ("custom_less" in normalised) {
      const prev = valueOf(current, "custom_less") ?? "";
      const res = await this.client.raw({ method: "POST", path: "/settings", body: { custom_less: normalised.custom_less } });
      steps.push({ step: "custom_less", method: "POST", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? undefined : describeFailure(res) });
      if (!res.ok) {
        const restore = await this.client.raw({ method: "POST", path: "/settings", body: { custom_less: prev } });
        steps.push({ step: "restore previous custom_less (clears custom_less_error)", method: "POST", path: "/api/settings", status: restore.status, ok: restore.ok });
        throw new OpsError(`custom_less was rejected (${res.status}): ${describeFailure(res)}. Nothing else was changed.`, steps);
      }
    }
    const rest = Object.fromEntries(Object.entries(normalised).filter(([k]) => k !== "custom_less"));
    if (Object.keys(rest).length) {
      const res = await this.client.raw({ method: "POST", path: "/settings", body: rest });
      steps.push({ step: "settings", method: "POST", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? Object.keys(rest) : describeFailure(res) });
      if (!res.ok) throw new OpsError(`settings write failed (${res.status}): ${describeFailure(res)}`, steps);
    }
    if (keys.some((k) => NEEDS_CACHE_CLEAR_KEYS.includes(k))) {
      steps.push(await this.cacheClearStep());
    }
    const verify = await this.verifySettings(normalised);
    return { dryRun: false, steps, issues, verify };
  }

  /** Compare stored values with what was written (secret keys only checked for presence). */
  async verifySettings(expected: Record<string, string | null>): Promise<{ ok: boolean; mismatches: unknown[]; customLessError?: string }> {
    if (!this.local) return { ok: true, mismatches: [] };
    const keys = Object.keys(expected);
    const now = await this.db.read([...keys, "custom_less_error"]);
    const mismatches: unknown[] = [];
    for (const k of keys) {
      const want = expected[k];
      const got = now[k];
      if (isSecretKey(k)) continue;
      const okValue = want === null ? got?.state === "null" : got?.state === "value" && got.value === want;
      if (!okValue) mismatches.push({ key: k, expected: preview(want), actual: summarise(got) });
    }
    const cle = valueOf(now, "custom_less_error");
    return { ok: mismatches.length === 0 && !cle, mismatches, ...(cle ? { customLessError: cle } : {}) };
  }

  /** DELETE /api/settings {keys}: back to Flarum's defaults. Clears the cache when CSS is affected. */
  async settingsReset(keys: string[], opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const blocked = keys.filter((k) => /^(extensions_enabled|version)$/.test(k));
    if (!opts.confirm || blocked.length) {
      const current = this.local ? await this.db.read(keys) : {};
      return {
        dryRun: true,
        wouldDelete: keys.map((k) => ({ key: k, current: isSecretKey(k) ? "***" : summarise(current[k]) })),
        blocked,
        note: "DELETE /api/settings does not trigger a CSS rebuild; a cache clear follows automatically when CSS keys are reset.",
      };
    }
    await requireAdmin(this.client);
    const steps: StepResult[] = [];
    const res = await this.client.raw({ method: "DELETE", path: "/settings", body: { keys } });
    steps.push({ step: "reset", method: "DELETE", path: "/api/settings", status: res.status, ok: res.ok, detail: res.ok ? keys : describeFailure(res) });
    if (!res.ok) throw new OpsError(`settings reset failed (${res.status}): ${describeFailure(res)}`, steps);
    if (keys.some((k) => CSS_KEYS.includes(k) || NEEDS_CACHE_CLEAR_KEYS.includes(k))) steps.push(await this.cacheClearStep());
    return { dryRun: false, steps };
  }

  /** DELETE /api/cache, parsing the NDJSON progress stream Flarum 2 returns. */
  async cacheClear(opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!opts.confirm) {
      return {
        dryRun: true,
        note: "Clears the cache store (also resets login throttles), deletes storage/formatter, locale and views, and rebuilds every asset bundle. Takes seconds; not destructive.",
      };
    }
    await requireAdmin(this.client);
    const step = await this.cacheClearStep();
    if (!step.ok) throw new OpsError("cache clear reported a failure", [step]);
    return { dryRun: false, steps: [step] };
  }

  async cacheClearStep(): Promise<StepResult> {
    const res = await this.client.raw({ method: "DELETE", path: "/cache", timeoutMs: 300_000 });
    const lines = Array.isArray(res.body) ? (res.body as Record<string, unknown>[]) : [];
    const failed = lines.filter((l) => l.type === "failed" || l.status === "failed" || l.error);
    return {
      step: "cache clear",
      method: "DELETE",
      path: "/api/cache",
      status: res.status,
      ok: res.ok && failed.length === 0,
      detail: failed.length ? failed : { events: lines.length },
    };
  }

  async uploadImage(kind: ImageKind, file: string, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const spec = IMAGE_KINDS[kind];
    if (!spec) throw new Error(`unknown image kind "${kind}" (use ${Object.keys(IMAGE_KINDS).join(", ")})`);
    const data = readFileSync(file);
    const { info } = checkUpload(data, basename(file));
    const advice = kindAdvice(kind, info);
    if (kind === "logo_dark_mode" && this.local) {
      // views/frontend/forum.blade.php renders the dark logo only inside @if ($forum['logoUrl']).
      const normal = valueOf(await this.db.read(["logo_path"]), "logo_path");
      if (!normal) advice.push("No normal logo is set: Flarum only shows the dark-mode logo when a normal logo exists (forum.blade.php). Upload a normal logo too, or the dark logo stays invisible.");
    }
    if (!opts.confirm) {
      return { dryRun: true, wouldUpload: { kind, route: `/api${spec.route}`, field: spec.field, file, ...info, bytes: data.byteLength }, advice };
    }
    await requireAdmin(this.client);
    const res = await this.client.upload<{ data?: { attributes?: Record<string, unknown> } }>({
      path: spec.route,
      field: spec.field,
      filename: `${kind}.${info.ext}`,
      data,
      mimeType: info.mime,
      timeoutMs: 120_000,
    });
    if (!res.ok) throw new OpsError(`upload failed (${res.status}): ${describeFailure(res)}`, [{ step: "upload", method: "POST", path: `/api${spec.route}`, status: res.status, ok: false }]);
    const url = (res.body as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes?.[spec.urlAttr];
    return { dryRun: false, steps: [{ step: "upload", method: "POST", path: `/api${spec.route}`, status: res.status, ok: true }], url, advice };
  }

  async deleteImage(kind: ImageKind, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const spec = IMAGE_KINDS[kind];
    if (!spec) throw new Error(`unknown image kind "${kind}"`);
    const current = this.local ? valueOf(await this.db.read([spec.pathKey]), spec.pathKey) : undefined;
    if (!opts.confirm) return { dryRun: true, wouldDelete: { kind, route: `/api${spec.route}`, current: current ?? "(none)" } };
    if (this.local && !current) return { dryRun: false, steps: [], note: `no ${kind} is set; nothing to delete` };
    await requireAdmin(this.client);
    const res = await this.client.raw({ method: "DELETE", path: spec.route });
    if (!res.ok) throw new OpsError(`delete failed (${res.status}): ${describeFailure(res)}`);
    return { dryRun: false, steps: [{ step: `delete ${kind}`, method: "DELETE", path: `/api${spec.route}`, status: res.status, ok: true }] };
  }

  /**
   * PATCH /api/extensions/{id} {"enabled": bool}. Enabling runs the
   * extension's migrations (schema changes) and publishes its assets, so this
   * always needs an explicit approval. Uninstalling is not offered.
   */
  async extensionSet(id: string, enabled: boolean, opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" is not an extension id (e.g. flarum-gdpr)`);
    const current = this.local ? (await this.enabledExtensions()).includes(id) : undefined;
    if (current === enabled) return { dryRun: !opts.confirm, note: `${id} is already ${enabled ? "enabled" : "disabled"}`, steps: [] };
    if (!opts.confirm) {
      return {
        dryRun: true,
        wouldSend: { method: "PATCH", path: `/api/extensions/${id}`, body: { enabled } },
        currentlyEnabled: current,
        warning: enabled
          ? "Enabling runs the extension's database migrations and publishes its assets. Take a DB backup first; disabling later does NOT roll migrations back."
          : "Disabling hides the extension's features; its data and migrations stay.",
      };
    }
    await requireAdmin(this.client);
    const started = new Date();
    const res = await this.client.raw({ method: "PATCH", path: `/extensions/${id}`, body: { enabled }, timeoutMs: 300_000 });
    const steps: StepResult[] = [{ step: `${enabled ? "enable" : "disable"} ${id}`, method: "PATCH", path: `/api/extensions/${id}`, status: res.status, ok: res.ok, detail: res.ok ? undefined : describeFailure(res) }];
    const health = await this.health(started);
    if (!res.ok) throw new OpsError(`extension toggle failed (${res.status}): ${describeFailure(res)}`, steps);
    return { dryRun: false, steps, health };
  }

  /** POST /api/permission replaces ALL groups for the permission; shows the current groups first. */
  async permissionSet(permission: string, groupIds: number[], opts: { confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const current = this.local ? (await this.db.permissions([permission]))[permission] ?? [] : undefined;
    if (!opts.confirm) {
      return {
        dryRun: true,
        permission,
        currentGroupIds: current,
        newGroupIds: groupIds,
        note: "Replaces every group currently holding this permission. Groups: 1 admin, 2 guest, 3 member, 4 mod (default ids).",
      };
    }
    await requireAdmin(this.client);
    const res = await this.client.raw({ method: "POST", path: "/permission", body: { permission, groupIds } });
    if (!res.ok) throw new OpsError(`permission update failed (${res.status}): ${describeFailure(res)}`);
    return { dryRun: false, steps: [{ step: "permission", method: "POST", path: "/api/permission", status: res.status, ok: true }], previousGroupIds: current };
  }
}

export function summarise(s: SettingsMap[string] | undefined): string {
  if (!s || s.state === "absent") return "(absent)";
  if (s.state === "null") return "(null)";
  if (s.state === "redacted") return "***";
  return preview(s.value);
}

export function preview(v: string | null | undefined): string {
  if (v === null || v === undefined) return "(null)";
  return v.length > 120 ? `${v.slice(0, 117)}… [${v.length} chars]` : v;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export { FlarumError };
