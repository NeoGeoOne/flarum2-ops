/**
 * Local-install bridge: things the HTTP API cannot do for a forum on this host.
 *
 *  - readSettings(): full settings read through helpers/settings_read.php
 *    (read-only PDO; Flarum has no settings GET endpoint).
 *  - serviceStates(): `systemctl is-active` for the configured units.
 *  - recentLogErrors(): ERROR/CRITICAL lines in storage/logs/flarum-*.log.
 *
 * Everything here is read-only with respect to the forum.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./config.js";

export type SettingState =
  | { state: "absent" }
  | { state: "null" }
  | { state: "redacted" }
  | { state: "value"; value: string };

export type SettingsMap = Record<string, SettingState>;

function run(cmd: string, args: string[], input?: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === "ENOENT" ? 127 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export function settingsHelperPath(): string {
  return join(packageRoot(), "helpers", "settings_read.php");
}

async function helper<T>(forumRoot: string, request: Record<string, unknown>): Promise<T> {
  if (!existsSync(join(forumRoot, "config.php"))) {
    throw new Error(`No config.php in ${forumRoot}; settings reads need a local Flarum install (set forum_root).`);
  }
  const res = await run("php", [settingsHelperPath(), forumRoot], JSON.stringify(request));
  if (res.code === 127) throw new Error("php CLI not found in PATH; it is required for local settings reads.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`settings helper returned non-JSON (exit ${res.code}): ${res.stdout.slice(0, 300)}${res.stderr.slice(0, 300)}`);
  }
  const obj = parsed as { error?: string };
  if (obj.error) throw new Error(`settings helper: ${obj.error}`);
  return parsed as T;
}

/** Read settings by exact key and/or key prefix. Secret-looking keys come back as "redacted". */
export async function readSettings(forumRoot: string, keys: string[], prefixes: string[] = []): Promise<SettingsMap> {
  const out = await helper<{ settings: SettingsMap | unknown[] }>(forumRoot, { mode: "get", keys, prefixes });
  // PHP encodes an empty associative array as [].
  return Array.isArray(out.settings) ? {} : (out.settings as SettingsMap);
}

/** All setting key names (no values) with a secret flag. */
export async function listSettingKeys(forumRoot: string): Promise<{ key: string; secret: boolean }[]> {
  const out = await helper<{ keys: { key: string; secret: boolean }[] }>(forumRoot, { mode: "keys" });
  return out.keys;
}

/** Current group ids per permission name. */
export async function readPermissions(forumRoot: string, names: string[]): Promise<Record<string, number[]>> {
  const out = await helper<{ permissions: Record<string, number[]> | unknown[] }>(forumRoot, { mode: "permissions", names });
  return Array.isArray(out.permissions) ? {} : (out.permissions as Record<string, number[]>);
}

/** Value of a setting, or undefined when absent/null/redacted. */
export function valueOf(map: SettingsMap, key: string): string | undefined {
  const s = map[key];
  return s && s.state === "value" ? s.value : undefined;
}

/** Enabled extension ids from the extensions_enabled setting. */
export async function enabledExtensions(forumRoot: string): Promise<string[]> {
  const map = await readSettings(forumRoot, ["extensions_enabled"]);
  const raw = valueOf(map, "extensions_enabled");
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function serviceStates(services: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    services.map(async (s) => {
      const r = await run("systemctl", ["is-active", s], undefined, 10_000);
      out[s] = r.code === 127 ? "unknown (no systemctl)" : r.stdout.trim() || (r.code === 0 ? "active" : "inactive");
    }),
  );
  return out;
}

export interface LogError {
  file: string;
  time: string;
  line: string;
}

/**
 * ERROR/CRITICAL/ALERT/EMERGENCY lines from storage/logs/flarum*.log written at
 * or after `since` (ISO string or Date). Lines are truncated to 400 chars.
 */
export function recentLogErrors(forumRoot: string, since: Date, max = 20): { errors: LogError[]; unreadable: string[] } {
  const dir = join(forumRoot, "storage", "logs");
  const errors: LogError[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { errors, unreadable };
  const files = readdirSync(dir)
    .filter((f) => /^flarum.*\.log$/.test(f) && f !== "flarum-installer.log")
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).mtime >= since);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})[^\]]*\]\s+\S+\.(ERROR|CRITICAL|ALERT|EMERGENCY):/.exec(line);
      if (!m) continue;
      const t = new Date(m[1].replace(" ", "T"));
      if (t >= since) errors.push({ file, time: m[1], line: line.slice(0, 400) });
    }
  }
  return { errors: errors.slice(-max), unreadable };
}
