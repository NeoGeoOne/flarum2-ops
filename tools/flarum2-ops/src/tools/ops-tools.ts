/**
 * MCP tools for flarum2-ops: admin settings, uploads, cache, extensions,
 * permissions, health and the design-set engine.
 *
 * Contract for every mutating tool: without `confirm: true` it is a dry run
 * returning exactly what would change; the agent shows that to the user and
 * calls again with confirm only after approval. Mutating tools are only
 * registered in write mode (FLARUM_MODE=write).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { Ops, OpsError } from "../ops.js";
import { DesignSets } from "../designset.js";
import { IMAGE_KINDS, type ImageKind } from "../policy.js";
import { errorResult, result } from "./shared.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const confirmField = z
  .boolean()
  .optional()
  .default(false)
  .describe("false (default) = dry run that changes nothing. Set true only after the user approved the dry-run result.");

function failure(err: unknown) {
  if (err instanceof OpsError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: err.message, steps: err.steps }, null, 2) }],
    };
  }
  return errorResult(err);
}

const kindEnum = z.enum(Object.keys(IMAGE_KINDS) as [ImageKind, ...ImageKind[]]);

export function registerOpsTools(server: McpServer, ops: Ops): void {
  const sets = new DesignSets(ops);
  const wrap =
    <A>(fn: (a: A) => Promise<unknown> | unknown) =>
    async (a: A) => {
      try {
        return result(await fn(a));
      } catch (err) {
        return failure(err);
      }
    };

  // ------------------------------------------------------------ read tools

  server.registerTool(
    "flarum_doctor",
    {
      title: "Forum + design-set status",
      description:
        "One-shot status for this forum: config, token/admin check (a bad token silently acts as guest), health " +
        "(services, root/API/CSS 200, storage/logs errors, custom_less_error), enabled extensions, applied design-set and drift. " +
        "Call this first in every task.",
      inputSchema: {},
      annotations: READ,
    },
    wrap(() => sets.doctor()),
  );

  server.registerTool(
    "flarum_health",
    {
      title: "Forum health check",
      description: "Services active, forum root / API / stylesheet return 200, new ERROR lines in storage/logs, custom_less_error flag.",
      inputSchema: {
        sinceMinutes: z.number().int().min(1).max(10080).optional().default(15).describe("Log window in minutes."),
      },
      annotations: READ,
    },
    wrap(({ sinceMinutes }: { sinceMinutes: number }) => ops.health(new Date(Date.now() - sinceMinutes * 60_000))),
  );

  if (ops.local) {
    server.registerTool(
      "flarum_settings_get",
      {
        title: "Read Flarum settings",
        description:
          "Read settings straight from the forum database (Flarum has no GET settings endpoint; custom_less, " +
          "theme_colored_header and extension settings are not on GET /api). Each key reports state absent | null | value | redacted " +
          "(credentials are never shown). Use keys for exact names, prefixes like \"flarum-tags.\" for extension settings, or listKeys for names only.",
        inputSchema: {
          keys: z.array(z.string()).optional().default([]).describe("Exact setting keys."),
          prefixes: z.array(z.string()).optional().default([]).describe('Key prefixes, e.g. ["flarum-tags."].'),
          listKeys: z.boolean().optional().default(false).describe("Return every key name (no values)."),
        },
        annotations: READ,
      },
      wrap(async ({ keys, prefixes, listKeys }: { keys: string[]; prefixes: string[]; listKeys: boolean }) => {
        if (listKeys) return ops.db.listKeys();
        if (!keys.length && !prefixes.length) throw new Error("pass keys and/or prefixes (or listKeys: true)");
        return ops.settingsGet(keys, prefixes);
      }),
    );

    server.registerTool(
      "designset_list",
      {
        title: "List design-sets",
        description: "All design-sets with title, colors, screenshot count and which one is applied; plus snapshots when includeSnapshots.",
        inputSchema: { includeSnapshots: z.boolean().optional().default(false) },
        annotations: READ,
      },
      wrap(({ includeSnapshots }: { includeSnapshots: boolean }) =>
        includeSnapshots ? { sets: sets.list(), snapshots: sets.listSnapshots(), applied: sets.marker() } : { sets: sets.list(), applied: sets.marker() },
      ),
    );

    server.registerTool(
      "designset_validate",
      {
        title: "Validate a design-set",
        description:
          "Schema, key policy, colors, color_scheme, value sizes, LESS lint (data-uri, @import, a / b division, -hc coverage), " +
          "static file types, image limits, required extensions and tag slugs. Read-only.",
        inputSchema: { name: z.string() },
        annotations: READ,
      },
      wrap(({ name }: { name: string }) => sets.validate(name)),
    );

    server.registerTool(
      "designset_diff",
      {
        title: "Plan a design-set apply",
        description: "Exactly what apply would change: settings (from → to), resets to default, image uploads/deletes, tag patches, static files, cache clear. Read-only.",
        inputSchema: { name: z.string() },
        annotations: READ,
      },
      wrap(({ name }: { name: string }) => sets.plan(name)),
    );

    server.registerTool(
      "designset_screenshot",
      {
        title: "Screenshot the live forum",
        description:
          "Headless-Chromium screenshots of the forum as a guest (pages × schemes × viewports) with console errors and failed requests. " +
          "Saved to design-sets/<name>/screenshots (or _live-screenshots). Does not change the forum.",
        inputSchema: {
          name: z.string().optional().describe("Store under this set's screenshots/ (omit for _live-screenshots)."),
          viewports: z.array(z.number().int().min(320).max(3840)).optional(),
          pages: z.array(z.string()).optional().describe('Forum paths, default ["/", "/all", first discussion, "/tags"].'),
          schemes: z.array(z.enum(["light", "dark", "light-hc", "dark-hc"])).optional(),
        },
        annotations: { ...READ, idempotentHint: false },
      },
      wrap(({ name, viewports, pages, schemes }: { name?: string; viewports?: number[]; pages?: string[]; schemes?: string[] }) =>
        sets.screenshot({ outDir: name ? join(sets.setDir(name), "screenshots") : join(ops.cfg.designSetsDir, "_live-screenshots"), viewports, pages, schemes }),
      ),
    );

    server.registerTool(
      "designset_gallery",
      {
        title: "Build the design-set gallery",
        description: "Write design-sets/gallery.html: every set with its screenshots side by side, for choosing. Local file only.",
        inputSchema: {},
        annotations: { ...READ, idempotentHint: false },
      },
      wrap(() => sets.gallery()),
    );

    server.registerTool(
      "designset_snapshot",
      {
        title: "Snapshot the live design",
        description:
          "Save the live design state (theme/design settings, all enabled-extension settings, served logo/favicon files, tag colors/icons) " +
          "to design-sets/_snapshots/<id>. With exportAs, also create a new design-set from it. Reads the forum only.",
        inputSchema: {
          reason: z.string().optional().default("manual"),
          exportAs: z.string().optional().describe("Name of a new design-set to create from the live design."),
        },
        annotations: { ...READ, idempotentHint: false },
      },
      wrap(async ({ reason, exportAs }: { reason: string; exportAs?: string }) =>
        exportAs ? sets.exportLive(exportAs) : { id: (await sets.snapshot(reason)).id },
      ),
    );

    server.registerTool(
      "designset_new",
      {
        title: "Create a design-set",
        description: "Create design-sets/<name>/ from the template (set.json, custom.less, header/footer HTML, static/, images/). Local files only.",
        inputSchema: { name: z.string(), title: z.string().optional() },
        annotations: { ...READ, idempotentHint: false },
      },
      wrap(({ name, title }: { name: string; title?: string }) => sets.create(name, title)),
    );
  }

  // ----------------------------------------------------------- write tools
  if (ops.client.readOnly) return;

  server.registerTool(
    "flarum_settings_set",
    {
      title: "Write Flarum settings",
      description:
        "POST /api/settings with key policy and validation (hex colors, color_scheme ids, booleans → '1'/'0', 65000-char limit, LESS lint). " +
        "custom_less is sent alone first; if Flarum rejects it (422) the previous value is restored so custom_less_error is cleared. " +
        "Image paths, extensions_enabled etc. are refused; mail/maintenance/driver keys need allowProtected. Dry run unless confirm.",
      inputSchema: {
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
        allowProtected: z.boolean().optional().default(false),
        confirm: confirmField,
      },
      annotations: WRITE,
    },
    wrap(({ values, allowProtected, confirm }: { values: Record<string, unknown>; allowProtected: boolean; confirm: boolean }) =>
      ops.settingsSet(values, { confirm, allowProtected }),
    ),
  );

  server.registerTool(
    "flarum_settings_reset",
    {
      title: "Reset settings to defaults",
      description: "DELETE /api/settings {keys}. Flarum does not rebuild CSS after a reset, so a cache clear follows automatically for CSS keys. Dry run unless confirm.",
      inputSchema: { keys: z.array(z.string()).min(1), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ keys, confirm }: { keys: string[]; confirm: boolean }) => ops.settingsReset(keys, { confirm })),
  );

  server.registerTool(
    "flarum_upload_image",
    {
      title: "Upload logo / dark logo / email logo / favicon",
      description:
        "Multipart upload to /api/logo, /api/logo-dark-mode, /api/email-logo or /api/favicon (field name = route name). " +
        "Checks first: ≤2 MB, ≤24 MP, real type png/jpeg/gif/webp/bmp (no SVG/ICO). Flarum scales logos to 60px high (WebP) and " +
        "favicons to fit 64x64 (PNG), replaces the previous file and returns the new URL. Dry run unless confirm.",
      inputSchema: { kind: kindEnum, file: z.string().describe("Absolute path of a local image file."), confirm: confirmField },
      annotations: WRITE,
    },
    wrap(({ kind, file, confirm }: { kind: ImageKind; file: string; confirm: boolean }) => ops.uploadImage(kind, file, { confirm })),
  );

  server.registerTool(
    "flarum_delete_image",
    {
      title: "Remove logo / dark logo / email logo / favicon",
      description: "DELETE the image endpoint (removes the file and clears the setting). Dry run unless confirm.",
      inputSchema: { kind: kindEnum, confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ kind, confirm }: { kind: ImageKind; confirm: boolean }) => ops.deleteImage(kind, { confirm })),
  );

  server.registerTool(
    "flarum_cache_clear",
    {
      title: "Clear the Flarum cache",
      description:
        "DELETE /api/cache (runs as the web-server user, unlike `php flarum cache:clear` from a shell). Parses the NDJSON progress stream " +
        "and fails if any step failed. Heavy (seconds) and resets login throttles; only needed after resets, fontawesome changes or for admin CSS. Dry run unless confirm.",
      inputSchema: { confirm: confirmField },
      annotations: WRITE,
    },
    wrap(({ confirm }: { confirm: boolean }) => ops.cacheClear({ confirm })),
  );

  server.registerTool(
    "flarum_extension_set",
    {
      title: "Enable or disable an extension",
      description:
        "PATCH /api/extensions/{id} {enabled}. Enabling RUNS DATABASE MIGRATIONS and publishes assets; disabling never rolls them back. " +
        "Requires its own explicit user approval (separate from design changes) and a DB backup first. Uninstall is deliberately not offered. Dry run unless confirm.",
      inputSchema: { id: z.string().describe('Extension id, e.g. "flarum-gdpr".'), enabled: z.boolean(), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ id, enabled, confirm }: { id: string; enabled: boolean; confirm: boolean }) => ops.extensionSet(id, enabled, { confirm })),
  );

  server.registerTool(
    "flarum_permission_set",
    {
      title: "Set a permission",
      description:
        "POST /api/permission {permission, groupIds}: REPLACES every group holding the permission. The dry run shows the current groups. " +
        "Default group ids: 1 admin, 2 guest, 3 member, 4 mod.",
      inputSchema: { permission: z.string(), groupIds: z.array(z.number().int().positive()), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ permission, groupIds, confirm }: { permission: string; groupIds: number[]; confirm: boolean }) =>
      ops.permissionSet(permission, groupIds, { confirm }),
    ),
  );

  if (!ops.local) return;

  server.registerTool(
    "designset_apply",
    {
      title: "Apply a design-set to the live forum",
      description:
        "Snapshot → copy static files → custom_less (alone) → settings → resets of omitted theme keys → images → tags → verify read-back, " +
        "custom_less_error and health. Any failure rolls back to the snapshot automatically. Without confirm returns the plan (dry run).",
      inputSchema: { name: z.string(), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ name, confirm }: { name: string; confirm: boolean }) => sets.apply(name, { confirm })),
  );

  server.registerTool(
    "designset_preview",
    {
      title: "Try on a design-set",
      description:
        "Snapshot → apply → screenshot matrix → automatic rollback, so the forum ends exactly as before. Screenshots go to the set's screenshots/ " +
        "(then run designset_gallery). Without confirm returns the plan (dry run).",
      inputSchema: {
        name: z.string(),
        viewports: z.array(z.number().int().min(320).max(3840)).optional(),
        pages: z.array(z.string()).optional(),
        confirm: confirmField,
      },
      annotations: DESTRUCTIVE,
    },
    wrap(({ name, viewports, pages, confirm }: { name: string; viewports?: number[]; pages?: string[]; confirm: boolean }) =>
      sets.preview(name, { confirm, viewports, pages }),
    ),
  );

  server.registerTool(
    "designset_rollback",
    {
      title: "Roll back to a snapshot",
      description:
        "Restore settings exactly (value / NULL / absent), images (re-upload or delete), tag styling and the applied-set marker from a snapshot " +
        "(default: latest), then verify. Dry run (shows what differs) unless confirm.",
      inputSchema: { snapshot: z.string().optional(), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    wrap(({ snapshot, confirm }: { snapshot?: string; confirm: boolean }) => sets.rollback(snapshot, { confirm })),
  );
}
