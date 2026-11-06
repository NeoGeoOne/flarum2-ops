import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlarumClient, normalizeApiPath, parseBody } from "../dist/flarum-client.js";
import { Ops, OpsError } from "../dist/ops.js";
import { whoami, requireAdmin } from "../dist/auth.js";
import { classifyKey, lintLess, validateValue, checkSettingsWrite, normaliseValue } from "../dist/policy.js";
import { sniffImage, checkUpload } from "../dist/images.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN, MEMBER_TOKEN, pngBytes } from "./helpers/mock-flarum.mjs";

// ------------------------------------------------------------- client fixes

test("normalizeApiPath strips an accidental /api prefix (the mcp-for-flarum /api/api trap)", () => {
  assert.equal(normalizeApiPath("/api/settings"), "/settings");
  assert.equal(normalizeApiPath("api/settings"), "/settings");
  assert.equal(normalizeApiPath("/settings"), "/settings");
  assert.equal(normalizeApiPath("settings"), "/settings");
  assert.equal(normalizeApiPath("/api"), "/");
  assert.equal(normalizeApiPath("/api/"), "/");
  assert.equal(normalizeApiPath("/apis/x"), "/apis/x");
  assert.throws(() => normalizeApiPath("http://x/api/settings"), /not a full URL/);
});

test("parseBody parses NDJSON streams into arrays and empty bodies into null", () => {
  assert.deepEqual(parseBody('{"type":"a"}\n{"type":"b"}\n', "application/x-ndjson"), [{ type: "a" }, { type: "b" }]);
  assert.equal(parseBody("", "application/json"), null);
  assert.equal(parseBody("plain", "text/plain"), "plain");
});

// ---------------------------------------------------------------- policy

test("classifyKey separates theme, optional, extension, protected and forbidden keys", () => {
  assert.equal(classifyKey("custom_less"), "theme");
  assert.equal(classifyKey("welcome_title"), "optional");
  assert.equal(classifyKey("flarum-tags.max_primary_tags", ["flarum-tags"]), "extension");
  assert.equal(classifyKey("fof-upload.mimeTypes", ["fof-upload"]), "extension");
  assert.equal(classifyKey("mail_password"), "protected");
  assert.equal(classifyKey("maintenance_mode"), "protected");
  assert.equal(classifyKey("extensions_enabled"), "forbidden");
  assert.equal(classifyKey("logo_path"), "forbidden");
  assert.equal(classifyKey("custom_less_error"), "forbidden");
  assert.equal(classifyKey("something_unknown"), "other");
});

test("validateValue enforces hex colors, color_scheme ids, booleans and routes", () => {
  assert.equal(validateValue("theme_primary_color", "#12abEF").length, 0);
  assert.equal(validateValue("theme_primary_color", "red")[0].level, "error");
  assert.equal(validateValue("theme_primary_color", "#fff;@import 'x'").some((i) => i.level === "error"), true);
  assert.equal(validateValue("color_scheme", "dark-hc").length, 0);
  assert.equal(validateValue("color_scheme", "midnight")[0].level, "error");
  assert.equal(validateValue("theme_colored_header", "yes")[0].level, "error");
  assert.equal(validateValue("default_route", "tags")[0].level, "error");
  assert.equal(validateValue("custom_footer", "<script>x()</script>")[0].level, "warning");
  assert.equal(validateValue("custom_less", "x".repeat(65001)).some((i) => /65000/.test(i.message)), true);
  assert.equal(normaliseValue("theme_colored_header", true), "1");
  assert.equal(normaliseValue("show_theme_selector", "false"), "0");
});

test("lintLess catches data-uri, local/protocol-relative imports, slash division and braces", () => {
  const msgs = (s) => lintLess(s).map((i) => `${i.level}:${i.message}`);
  assert.ok(msgs("a{b:data-uri('x.png')}").some((m) => m.startsWith("error") && /data-uri/.test(m)));
  assert.ok(msgs("@import 'theme.less';").some((m) => m.startsWith("error") && /local @import/.test(m)));
  assert.ok(msgs("@import url(//fonts.example/x.css);").some((m) => m.startsWith("error") && /protocol-relative/.test(m)));
  assert.ok(msgs("@import url(https://fonts.example/x.css);").some((m) => m.startsWith("warning") && /GDPR/.test(m)));
  assert.ok(msgs(".a{grid-column: 1 / 3;}").some((m) => m.startsWith("warning") && /division/.test(m)));
  assert.equal(msgs('.a{grid-column: ~"1 / 3";}').length, 0);
  assert.ok(msgs(".a{color:red;").some((m) => /unbalanced/.test(m)));
  assert.equal(msgs("// data-uri( in a comment\n/* @import 'x'; */ .a{color:red}").length, 0);
});

test("checkSettingsWrite refuses forbidden keys and gates protected ones", () => {
  const r = checkSettingsWrite({ extensions_enabled: "[]", mail_password: "x", theme_primary_color: "#000000" }, { enabledExtensions: [] });
  assert.ok(r.issues.some((i) => i.key === "extensions_enabled" && i.level === "error"));
  assert.ok(r.issues.some((i) => i.key === "mail_password" && /protected/.test(i.message)));
  assert.equal(r.normalised.theme_primary_color, "#000000");
  const ok = checkSettingsWrite({ maintenance_mode: "none" }, { enabledExtensions: [], allowProtected: true });
  assert.equal(ok.issues.length, 0);
});

// ---------------------------------------------------------------- images

test("sniffImage reads type and dimensions from magic bytes, not the extension", () => {
  assert.deepEqual(sniffImage(pngBytes(300, 90)), { mime: "image/png", ext: "png", width: 300, height: 90 });
  const gif = Buffer.from("GIF89a\x40\x00\x20\x00", "latin1");
  assert.equal(sniffImage(gif).mime, "image/gif");
  assert.equal(sniffImage(gif).width, 64);
  assert.equal(sniffImage(Buffer.from("not an image at all")), undefined);
});

test("checkUpload rejects SVG, oversized files and huge images before any request", () => {
  assert.throws(() => checkUpload(Buffer.from('<?xml version="1.0"?><svg></svg>'), "logo.svg"), /SVG/);
  assert.throws(() => checkUpload(Buffer.alloc(2048 * 1024 + 1), "big.png"), /2048 KB/);
  assert.throws(() => checkUpload(pngBytes(6000, 5000), "huge.png"), /MP/);
  assert.equal(checkUpload(pngBytes(), "ok.png").info.mime, "image/png");
});

// ----------------------------------------------------- mock forum fixtures

let mock;
let root;
const cfgFor = (forumRoot) => ({
  name: "test",
  baseUrl: mock.base,
  forumRoot,
  tokenFile: "/nonexistent",
  designSetsDir: join(forumRoot, "sets"),
  publicAssetsSubdir: "design-sets",
  services: [],
  repoRoot: forumRoot,
  source: "test",
});
const opsWith = (token = ADMIN_TOKEN) =>
  new Ops(cfgFor(root), new FlarumClient({ baseUrl: mock.base, apiKey: token }), mock.settingsStore);

before(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({ forumRoot: root });
});
after(async () => {
  await mock.close();
});

// ---------------------------------------------------------------- client

test("raw() reports status codes, including 204 with an empty body", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN });
  const res = await c.raw({ method: "POST", path: "/api/settings", body: { forum_title: "Renamed" } });
  assert.equal(res.status, 204);
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
  assert.equal(mock.store.get("forum_title"), "Renamed");
});

test("upload() sends multipart with the route name as the field name", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN });
  const res = await c.upload({ path: "/logo-dark-mode", field: "logo-dark-mode", filename: "x.png", data: pngBytes(), mimeType: "image/png" });
  assert.equal(res.status, 200);
  const last = mock.requests.at(-1);
  assert.match(last.contentType, /^multipart\/form-data/);
  assert.match(mock.store.get("logo_dark_mode_path"), /^logo-dark-mode-/);
});

test("read-only client refuses uploads before any network call", async () => {
  const c = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN, readOnly: true });
  const n = mock.requests.length;
  await assert.rejects(() => c.upload({ path: "/logo", field: "logo", filename: "x.png", data: pngBytes(), mimeType: "image/png" }), /read-only/);
  assert.equal(mock.requests.length, n);
});

test("per-call timeouts abort with a message that warns the write may have completed", async () => {
  const c = new FlarumClient({ baseUrl: "http://10.255.255.1", apiKey: ADMIN_TOKEN });
  await assert.rejects(() => c.raw({ method: "POST", path: "/settings", body: {}, timeoutMs: 50 }), /timed out after 50 ms[\s\S]*may still have completed/);
});

// ------------------------------------------------------------------ auth

test("whoami detects a rejected token (Flarum silently treats it as a guest)", async () => {
  const bad = new FlarumClient({ baseUrl: mock.base, apiKey: "wrong-token-xyz" });
  const { actor } = await whoami(bad);
  assert.equal(actor.authenticated, false);
  await assert.rejects(() => requireAdmin(bad), /guest/);
});

test("whoami resolves admin vs member through the user's groups", async () => {
  assert.equal((await whoami(new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }))).actor.isAdmin, true);
  const member = new FlarumClient({ baseUrl: mock.base, apiKey: MEMBER_TOKEN });
  assert.equal((await whoami(member)).actor.isAdmin, false);
  await assert.rejects(() => requireAdmin(member), /not an admin/);
});

// ------------------------------------------------------------------- ops

test("settingsSet without confirm is a dry run: nothing is sent", async () => {
  const ops = opsWith();
  const n = mock.requests.filter((r) => r.method === "POST").length;
  const res = await ops.settingsSet({ theme_primary_color: "#112233" });
  assert.equal(res.dryRun, true);
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, n);
  assert.deepEqual(res.wouldSend, [{ key: "theme_primary_color", from: "#4D698E", to: "#112233" }]);
});

test("settingsSet sends custom_less alone first, then the rest, and verifies by read-back", async () => {
  const ops = opsWith();
  const start = mock.requests.length;
  const res = await ops.settingsSet({ custom_less: ".a{color:red}", theme_secondary_color: "#223344" }, { confirm: true });
  const posts = mock.requests.slice(start).filter((r) => r.method === "POST" && r.path === "/api/settings");
  assert.equal(posts.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(posts[0].body)), ["custom_less"]);
  assert.deepEqual(Object.keys(JSON.parse(posts[1].body)), ["theme_secondary_color"]);
  assert.equal(res.verify.ok, true);
});

test("a rejected custom_less (422) restores the previous value, clearing custom_less_error", async () => {
  const ops = opsWith();
  mock.store.set("custom_less", ".keep{color:blue}");
  await assert.rejects(
    () => ops.settingsSet({ custom_less: ".a{BROKEN}", forum_title: "Never" }, { confirm: true }),
    (err) => err instanceof OpsError && /rejected \(422\)/.test(err.message) && /Nothing else was changed/.test(err.message),
  );
  assert.equal(mock.store.get("custom_less"), ".keep{color:blue}");
  assert.equal(mock.store.has("custom_less_error"), false);
  assert.notEqual(mock.store.get("forum_title"), "Never");
});

test("settingsSet blocks forbidden keys even with confirm", async () => {
  const res = await opsWith().settingsSet({ extensions_enabled: "[]" }, { confirm: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.blocked, true);
});

test("settingsReset deletes keys and clears the cache for CSS keys (no auto rebuild after DELETE)", async () => {
  const ops = opsWith();
  mock.store.set("custom_less", ".x{}");
  const start = mock.requests.length;
  const res = await ops.settingsReset(["custom_less"], { confirm: true });
  const calls = mock.requests.slice(start).map((r) => `${r.method} ${r.path}`);
  assert.ok(calls.includes("DELETE /api/settings"));
  assert.ok(calls.includes("DELETE /api/cache"));
  assert.equal(mock.store.has("custom_less"), false);
  assert.equal(res.steps.at(-1).ok, true);
});

test("cacheClear parses NDJSON and fails when a step failed", async () => {
  const ops = opsWith();
  assert.equal((await ops.cacheClear({ confirm: true })).steps[0].ok, true);
  mock.behaviour.cacheFails = true;
  await assert.rejects(() => ops.cacheClear({ confirm: true }), /failure/);
  mock.behaviour.cacheFails = false;
});

test("uploadImage dry-runs, then uploads and returns the new URL", async () => {
  const ops = opsWith();
  const file = join(root, "logo-src.png");
  writeFileSync(file, pngBytes(400, 100));
  const dry = await ops.uploadImage("logo", file);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldUpload.field, "logo");
  const res = await ops.uploadImage("logo", file, { confirm: true });
  assert.match(String(res.url), /\/assets\/logo-[0-9a-f]+\.webp$/);
});

test("uploading a dark-mode logo without a normal logo warns that it will not be shown", async () => {
  const ops = opsWith();
  mock.store.delete("logo_path");
  const file = join(root, "dark-src.png");
  writeFileSync(file, pngBytes(300, 120));
  const dry = await ops.uploadImage("logo_dark_mode", file);
  assert.ok(dry.advice.some((a) => /only shows the dark-mode logo when a normal logo exists/.test(a)));
});

test("extensionSet warns about migrations in the dry run and toggles with confirm", async () => {
  const ops = opsWith();
  const dry = await ops.extensionSet("flarum-gdpr", true);
  assert.equal(dry.dryRun, true);
  assert.match(dry.warning, /migrations/);
  await ops.extensionSet("flarum-gdpr", true, { confirm: true });
  assert.ok(JSON.parse(mock.store.get("extensions_enabled")).includes("flarum-gdpr"));
  await assert.rejects(() => ops.extensionSet("../etc", true), /not an extension id/);
});

test("permissionSet shows the current groups before replacing them", async () => {
  const ops = opsWith();
  const dry = await ops.permissionSet("startDiscussion", [3, 4]);
  assert.deepEqual(dry.currentGroupIds, [3]);
  const res = await ops.permissionSet("startDiscussion", [3, 4], { confirm: true });
  assert.deepEqual(res.previousGroupIds, [3]);
  assert.deepEqual(mock.permissions.startDiscussion, [3, 4]);
});

test("health checks root, API and every stylesheet", async () => {
  const h = await opsWith().health();
  assert.equal(h.ok, true, JSON.stringify(h.problems));
  assert.equal(h.root, 200);
  assert.deepEqual(Object.values(h.stylesheets), [200]);
});
