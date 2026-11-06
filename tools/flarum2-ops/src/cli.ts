#!/usr/bin/env node
/**
 * flarum2-ops CLI: same engine as the MCP server, for terminals, cron and
 * agents without MCP. Output is JSON on stdout; diagnostics go to stderr.
 *
 * Every mutating command is a dry run unless --confirm is given.
 * Exit codes: 0 ok · 1 error · 2 usage · 3 dry run (nothing changed; re-run with --confirm).
 */

import { loadConfig, loadToken, redact } from "./config.js";
import { FlarumClient } from "./flarum-client.js";
import { Ops, OpsError } from "./ops.js";
import { DesignSets } from "./designset.js";
import { loginAndStore, promptHidden, promptVisible } from "./auth.js";
import { IMAGE_KINDS, type ImageKind } from "./policy.js";
import { VERSION, DEFAULT_USER_AGENT } from "./version.js";

const HELP = `flarum2-ops ${VERSION} — Flarum 2 admin + design-set CLI

Usage: flarum2-ops <command> [args] [--confirm] [--compact]

Setup
  login                         ask for admin login (hidden), store a remember token (0600)
  whoami                        forum + acting user (admin check)
  doctor                        one-shot status: config, token, health, drift, sets
  health                        services, root/API/CSS HTTP, logs, custom_less_error

Settings & admin API
  settings get <key>... [--prefix p.]   read from DB (secrets redacted)
  settings keys                          list all setting key names
  settings set k=v [k=v...] [--allow-protected] [--confirm]
  settings set-file <key> <file> [--confirm]       e.g. custom_less from a .less file
  settings reset <key>... [--confirm]               back to Flarum defaults
  image upload <logo|logo_dark_mode|email_logo|favicon> <file> [--confirm]
  image delete <kind> [--confirm]
  cache clear [--confirm]
  extension <id> on|off [--confirm]                 enabling runs migrations!
  permission <name> <groupId,...> [--confirm]       replaces all groups
  api <GET|POST|PATCH|DELETE> <path> [json-body] [--confirm for non-GET]

Design-sets
  designset list | snapshots
  designset new <name> [title]
  designset export <name> [title]       live design → new set
  designset validate <name>
  designset diff <name>                 what apply would change
  designset apply <name> [--confirm] [--no-auto-rollback]
  designset preview <name> [--confirm] [--viewports 1440,390]
  designset rollback [snapshot-id] [--confirm]   default: latest snapshot
  designset screenshot [name] [--viewports 1440,390] [--pages /,/all]
  designset gallery
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (["prefix", "viewports", "pages"].includes(k) && argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function emit(data: unknown, compact: boolean): void {
  process.stdout.write(JSON.stringify(data, null, compact ? 0 : 2) + "\n");
}

function isDryRun(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { dryRun?: boolean }).dryRun);
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = positional;
  const compact = Boolean(flags.compact);
  const confirm = Boolean(flags.confirm);
  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === "version" || flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cfg = loadConfig();
  if (!cfg.baseUrl) {
    process.stderr.write("No forum URL: set base_url in forum.json or FLARUM_URL.\n");
    return 2;
  }

  if (cmd === "login") {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "login needs an interactive terminal (the password is typed hidden and never passes through an agent).\n" +
          "Claude Code '!' commands and pipes have no keyboard input. Open a normal terminal window and run:\n" +
          `  bash ${process.argv[1].replace(/tools\/flarum2-ops\/dist\/cli\.js$/, "skills/flarum2-design-ops/scripts/ops.sh")} login\n`,
      );
      return 2;
    }
    const ident = await promptVisible(`Admin username or email for ${cfg.baseUrl}: `);
    const password = await promptHidden("Password (hidden): ");
    const { userId } = await loginAndStore(cfg.baseUrl, ident, password, cfg.tokenFile);
    const ops = new Ops(cfg, new FlarumClient({ baseUrl: cfg.baseUrl, apiKey: loadToken(cfg).token, userAgent: DEFAULT_USER_AGENT }));
    const { actor } = await ops.whoami();
    emit({ stored: cfg.tokenFile, mode: "0600", userId, admin: actor.isAdmin }, compact);
    if (!actor.isAdmin) process.stderr.write("Warning: this user is not an admin; design-set and settings writes will fail.\n");
    return 0;
  }

  const token = loadToken(cfg);
  if (token.warning) process.stderr.write(`Warning: ${token.warning}\n`);
  const client = new FlarumClient({ baseUrl: cfg.baseUrl, apiKey: token.token, userAgent: DEFAULT_USER_AGENT, readOnly: false });
  const ops = new Ops(cfg, client);
  const sets = new DesignSets(ops);
  const csv = (v: string | boolean | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const viewports = csv(flags.viewports)?.map(Number);
  const pages = csv(flags.pages);

  let out: unknown;
  switch (cmd) {
    case "whoami":
      out = await ops.whoami();
      break;
    case "doctor":
      out = await sets.doctor();
      break;
    case "health":
      out = await ops.health();
      break;
    case "settings": {
      if (sub === "get") {
        const prefixes = csv(flags.prefix) ?? [];
        if (!rest.length && !prefixes.length) throw new Error("settings get <key>... [--prefix p.]");
        out = await ops.settingsGet(rest, prefixes);
      } else if (sub === "keys") {
        out = await ops.db.listKeys();
      } else if (sub === "set") {
        const values: Record<string, string> = {};
        for (const kv of rest) {
          const i = kv.indexOf("=");
          if (i < 1) throw new Error(`expected key=value, got "${kv}"`);
          values[kv.slice(0, i)] = kv.slice(i + 1);
        }
        out = await ops.settingsSet(values, { confirm, allowProtected: Boolean(flags["allow-protected"]) });
      } else if (sub === "set-file") {
        const [key, file] = rest;
        if (!key || !file) throw new Error("settings set-file <key> <file>");
        const { readFileSync } = await import("node:fs");
        out = await ops.settingsSet({ [key]: readFileSync(file, "utf8") }, { confirm });
      } else if (sub === "reset") {
        out = await ops.settingsReset(rest, { confirm });
      } else throw new Error("settings get|keys|set|set-file|reset");
      break;
    }
    case "image": {
      const kind = rest[0] as ImageKind;
      if (!(kind in IMAGE_KINDS)) throw new Error(`image ${sub} <${Object.keys(IMAGE_KINDS).join("|")}>`);
      if (sub === "upload") out = await ops.uploadImage(kind, rest[1], { confirm });
      else if (sub === "delete") out = await ops.deleteImage(kind, { confirm });
      else throw new Error("image upload|delete");
      break;
    }
    case "cache":
      if (sub !== "clear") throw new Error("cache clear");
      out = await ops.cacheClear({ confirm });
      break;
    case "extension": {
      const state = rest[0];
      if (!sub || !["on", "off"].includes(state)) throw new Error("extension <id> on|off");
      out = await ops.extensionSet(sub, state === "on", { confirm });
      break;
    }
    case "permission": {
      if (!sub || !rest[0]) throw new Error("permission <name> <groupId,...>");
      out = await ops.permissionSet(sub, rest[0].split(",").map(Number), { confirm });
      break;
    }
    case "api": {
      const method = (sub ?? "GET").toUpperCase();
      const path = rest[0];
      if (!path) throw new Error("api <METHOD> <path> [json-body]");
      const body = rest[1] ? JSON.parse(rest[1]) : undefined;
      if (method !== "GET" && !confirm) {
        out = { dryRun: true, wouldSend: { method, path, body } };
      } else {
        out = await client.raw({ method, path, body });
      }
      break;
    }
    case "designset": {
      const name = rest[0];
      switch (sub) {
        case "list":
          out = sets.list();
          break;
        case "snapshots":
          out = sets.listSnapshots();
          break;
        case "new":
          out = sets.create(name, rest[1]);
          break;
        case "export":
          out = await sets.exportLive(name, rest[1]);
          break;
        case "validate":
          out = await sets.validate(name);
          break;
        case "diff":
          out = await sets.plan(name);
          break;
        case "apply":
          out = await sets.apply(name, { confirm, autoRollback: !flags["no-auto-rollback"] });
          break;
        case "preview":
          out = await sets.preview(name, { confirm, viewports, pages });
          break;
        case "rollback":
          out = await sets.rollback(name, { confirm });
          break;
        case "screenshot": {
          const { join } = await import("node:path");
          const outDir = name ? join(sets.setDir(name), "screenshots") : join(cfg.designSetsDir, "_live-screenshots");
          out = await sets.screenshot({ outDir, viewports, pages });
          break;
        }
        case "gallery":
          out = sets.gallery();
          break;
        default:
          throw new Error("designset list|snapshots|new|export|validate|diff|apply|preview|rollback|screenshot|gallery");
      }
      break;
    }
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
  emit(out, compact);
  if (isDryRun(out)) {
    const blocked = (out as { plan?: { blocked?: boolean }; blocked?: boolean }).plan?.blocked || (out as { blocked?: boolean }).blocked;
    process.stderr.write(blocked ? "Blocked by validation errors (see issues); nothing was changed.\n" : "Dry run: nothing was changed. Re-run with --confirm after approval.\n");
    return blocked ? 1 : 3;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const cfg = (() => {
      try {
        return loadToken(loadConfig()).token;
      } catch {
        return undefined;
      }
    })();
    const e = err as Error & { steps?: unknown };
    const payload: Record<string, unknown> = { error: redact(e.message, cfg) };
    if (err instanceof OpsError && e.steps) payload.steps = e.steps;
    process.stdout.write(redact(JSON.stringify(payload, null, 2), cfg) + "\n");
    process.exit(1);
  });
