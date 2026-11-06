import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FlarumClient } from "../dist/flarum-client.js";
import { Ops } from "../dist/ops.js";
import { DesignSets } from "../dist/designset.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN, normalisedState, pngBytes } from "./helpers/mock-flarum.mjs";

let mock;
let root;
let sets;

function makeSets() {
  const cfg = {
    name: "test",
    baseUrl: mock.base,
    forumRoot: root,
    tokenFile: "/nonexistent",
    designSetsDir: join(root, "design-sets"),
    publicAssetsSubdir: "design-sets",
    services: [],
    repoRoot: root,
    source: "test",
  };
  return new DesignSets(new Ops(cfg, new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN }), mock.settingsStore));
}

/** Write a set folder from a spec object + extra files. */
function writeSet(name, spec, files = {}) {
  const dir = join(root, "design-sets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "set.json"), JSON.stringify({ name, title: name, ...spec }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

beforeEach(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({
    forumRoot: root,
    settings: { custom_header: "<p>old header</p>", welcome_title: "Welcome!" },
  });
  sets = makeSets();
});
afterEach(async () => {
  await mock.close();
});

// --------------------------------------------------------------- authoring

test("new creates a valid set from the template", async () => {
  const res = sets.create("ocean-blue", "Ocean Blue");
  assert.ok(existsSync(join(res.created, "set.json")));
  assert.equal(sets.load("ocean-blue").title, "Ocean Blue");
  const v = await sets.validate("ocean-blue");
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.throws(() => sets.create("ocean-blue"), /already exists/);
  assert.throws(() => sets.create("Bad Name"), /invalid design-set name/);
});

test("validate rejects schema errors, unknown keys, .php statics, missing assets and unlisted extension keys", async () => {
  writeSet(
    "broken",
    {
      settings: { theme_primary_color: "blue", color_scheme: "midnight", mystery_setting: "x", "flarum-tags.max_primary_tags": "2" },
      less: "custom.less",
    },
    { "custom.less": ".a{src:url('@@ASSET:fonts/missing.woff2@@')}", "static/evil.php": "<?php echo 1;" },
  );
  const { ok, issues } = await sets.validate("broken");
  assert.equal(ok, false);
  const text = issues.map((i) => `${i.key}: ${i.message}`).join("\n");
  assert.match(text, /theme_primary_color: must be a hex color/);
  assert.match(text, /color_scheme: must be one of/);
  assert.match(text, /mystery_setting: not a design key/);
  assert.match(text, /flarum-tags\.max_primary_tags: extension key: add "flarum-tags" to requires_extensions/);
  assert.match(text, /static\/evil\.php: file type not allowed/);
  assert.match(text, /@@ASSET:fonts\/missing\.woff2@@ refers to a file that is not in static/);
});

test("validate catches a folder/name mismatch and unknown tag slugs", async () => {
  writeSet("aaa", { name: "bbb" });
  assert.match((await sets.validate("aaa")).issues[0].message, /folder is "aaa"/);
  writeSet("tagged", { tags: { nope: { color: "#ff0000" } } });
  assert.match(JSON.stringify((await sets.validate("tagged")).issues), /no tag with slug \\"nope\\"/);
});

test("validate warns when @body-bg-dark is redefined without beating the inline dark body background", async () => {
  writeSet("darkbg", { settings: { color_scheme: "dark" }, less: "c.less" }, { "c.less": "@body-bg-dark: #2E3440;" });
  assert.match(JSON.stringify((await sets.validate("darkbg")).issues), /inline critical CSS/);
  writeSet("darkbg-ok", { settings: { color_scheme: "dark" }, less: "c.less" }, { "c.less": "@body-bg-dark: #2E3440;\nhtml[data-theme^=dark] body { background: var(--body-bg); }" });
  assert.doesNotMatch(JSON.stringify((await sets.validate("darkbg-ok")).issues), /inline critical CSS/);
});

// -------------------------------------------------------------------- plan

test("plan lists changes from → to and resets omitted theme keys to defaults", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155", color_scheme: "dark" } });
  const plan = await sets.plan("slate");
  assert.equal(plan.blocked, false, JSON.stringify(plan.issues));
  const byKey = Object.fromEntries(plan.settings.map((s) => [s.key, s]));
  assert.equal(byKey.theme_primary_color.to, "#334155");
  assert.equal(byKey.color_scheme.from, "auto");
  assert.equal(byKey.custom_header.action, "reset");
  assert.equal(byKey.theme_colored_header.action, "reset");
  assert.ok(!("welcome_title" in byKey), "optional keys untouched when the set does not list them");
  assert.equal(plan.needsCacheClear, false);
});

test("apply without confirm is a dry run and never writes", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  const before = normalisedState(mock.store);
  const res = await sets.apply("slate");
  assert.equal(res.dryRun, true);
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.requests.filter((r) => r.method !== "GET").length, 0);
});

// ------------------------------------------------------------------- apply

test("apply: snapshot first, custom_less alone, assets resolved + copied, images, tags, marker", async () => {
  writeSet(
    "amber",
    {
      settings: { theme_primary_color: "#B45309", theme_secondary_color: "#1F2937", theme_colored_header: true, color_scheme: "auto" },
      less: "custom.less",
      footer: "footer.html",
      images: { logo: "images/logo.png" },
      tags: { general: { color: "#B45309", icon: "fas fa-fire" } },
    },
    {
      "custom.less": "@font-face{font-family:X;src:url('@@ASSET:fonts/x.woff2@@') format('woff2')}\nhtml{.Hero{color:red}}",
      "footer.html": "<footer>amber</footer>",
      "static/fonts/x.woff2": "WOFF2DATA",
      "images/logo.png": pngBytes(400, 120),
    },
  );
  const res = await sets.apply("amber", { confirm: true });
  assert.equal(res.dryRun, false, JSON.stringify(res));

  const writes = mock.requests.filter((r) => r.method !== "GET");
  const firstSettingsPost = writes.find((r) => r.path === "/api/settings" && r.method === "POST");
  assert.deepEqual(Object.keys(JSON.parse(firstSettingsPost.body)), ["custom_less"], "custom_less is sent alone first");

  const less = mock.store.get("custom_less");
  assert.match(less, /url\('\/assets\/design-sets\/amber\/fonts\/x\.woff2\?v=[0-9a-f]{8}'\)/);
  assert.equal(readFileSync(join(root, "public", "assets", "design-sets", "amber", "fonts", "x.woff2"), "utf8"), "WOFF2DATA");
  assert.equal(mock.store.get("theme_colored_header"), "1");
  assert.equal(mock.store.get("custom_footer"), "<footer>amber</footer>");
  assert.equal(mock.store.has("custom_header"), false, "omitted theme key reset to default");
  assert.equal(mock.store.get("welcome_title"), "Welcome!", "optional key untouched");
  assert.match(mock.store.get("logo_path"), /^logo-/);
  assert.equal(mock.tags.get("1").color, "#B45309");
  assert.equal(sets.marker().set, "amber");
  assert.ok(sets.listSnapshots().length >= 1);
  assert.match(res.logEntry, /design-set apply: amber/);
});

test("apply is idempotent: a second apply of the same set changes nothing", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" }, images: { favicon: "images/f.png" } }, { "images/f.png": pngBytes(64, 64) });
  await sets.apply("slate", { confirm: true });
  const plan = await sets.plan("slate");
  assert.deepEqual(plan.settings, []);
  assert.deepEqual(plan.images.filter((i) => i.action !== "keep"), []);
});

test("a rejected custom_less (422) during apply rolls the forum back automatically", async () => {
  const before = normalisedState(mock.store);
  writeSet("bad-less", { settings: { theme_primary_color: "#000000" }, less: "custom.less" }, { "custom.less": ".a{BROKEN}" });
  await assert.rejects(() => sets.apply("bad-less", { confirm: true }), /custom_less rejected \(422\)[\s\S]*rolled back/);
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.store.has("custom_less_error"), false, "the restore save clears custom_less_error");
});

test("a failure after partial writes rolls back every step (settings, images, tags)", async () => {
  mock.behaviour.failSettingsKey = "theme_secondary_color";
  const before = normalisedState(mock.store);
  const tagBefore = { ...mock.tags.get("1") };
  writeSet(
    "half",
    { settings: { theme_primary_color: "#111111", theme_secondary_color: "#222222" }, less: "c.less", tags: { general: { color: "#123456" } } },
    { "c.less": ".ok{color:red}" },
  );
  await assert.rejects(() => sets.apply("half", { confirm: true }), /rolled back/);
  assert.deepEqual(normalisedState(mock.store), before);
  assert.deepEqual(mock.tags.get("1"), tagBefore);
});

// ---------------------------------------------------------------- rollback

test("rollback restores absent, NULL and value states exactly", async () => {
  mock.store.set("custom_footer", null); // a NULL row (e.g. after an admin cleared it)
  const before = normalisedState(mock.store);
  writeSet("x", { settings: { theme_primary_color: "#0F766E", show_theme_selector: false }, footer: "f.html", less: "c.less" }, { "f.html": "<b>f</b>", "c.less": ".a{color:red}" });
  const res = await sets.apply("x", { confirm: true });
  assert.notDeepEqual(normalisedState(mock.store), before);

  const dry = await sets.rollback(res.snapshot);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.settings.length > 0);

  const rb = await sets.rollback(res.snapshot, { confirm: true });
  assert.equal(rb.verify.ok, true, JSON.stringify(rb.verify));
  assert.deepEqual(normalisedState(mock.store), before);
  assert.equal(mock.store.get("custom_footer"), null, "NULL row restored as NULL, not deleted");
  assert.equal(mock.store.has("show_theme_selector"), false, "key absent before is deleted again");
  assert.equal(sets.marker(), null, "applied marker restored");
});

test("rollback re-uploads a removed logo and removes one that did not exist", async () => {
  // Start with a logo, apply a set that deletes it and adds a favicon.
  writeFileSync(join(root, "public", "assets", "logo-orig.webp"), pngBytes());
  mock.store.set("logo_path", "logo-orig.webp");
  writeSet("swap", { images: { logo: null, favicon: "images/f.png" } }, { "images/f.png": pngBytes(64, 64) });
  const res = await sets.apply("swap", { confirm: true });
  assert.equal(mock.store.get("logo_path"), null);
  assert.ok(mock.store.get("favicon_path"));
  await sets.rollback(res.snapshot, { confirm: true });
  assert.match(mock.store.get("logo_path"), /^logo-/, "logo re-uploaded from the snapshot copy");
  assert.equal(mock.store.get("favicon_path"), null, "favicon that did not exist is removed");
});

test("rollback restores a NULL tag icon as NULL, not as an empty string", async () => {
  mock.tags.get("1").icon = null;
  writeSet("iconic", { tags: { general: { icon: "fas fa-star" } } });
  const res = await sets.apply("iconic", { confirm: true });
  assert.equal(mock.tags.get("1").icon, "fas fa-star");
  await sets.rollback(res.snapshot, { confirm: true });
  assert.strictEqual(mock.tags.get("1").icon, null);
});

// ----------------------------------------------------------------- preview

test("preview applies, screenshots and always rolls back", async () => {
  const fake = join(root, "fake-python");
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"count":2,"shots":[{"file":"home__light__1440.png"}],"problems":[],"ok":true}\'\n');
  chmodSync(fake, 0o755);
  process.env.FLARUM2_OPS_PYTHON = fake;
  try {
    const before = normalisedState(mock.store);
    writeSet("trial", { settings: { theme_primary_color: "#7C3AED", color_scheme: "dark" } });
    const res = await sets.preview("trial", { confirm: true });
    assert.equal(res.screenshots.count, 2);
    assert.equal(res.rollback.ok, true);
    assert.deepEqual(normalisedState(mock.store), before);
  } finally {
    delete process.env.FLARUM2_OPS_PYTHON;
  }
});

// ------------------------------------------------------------- safety/misc

test("a live lock held by another process blocks concurrent writes", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  mkdirSync(join(root, "design-sets"), { recursive: true });
  writeFileSync(join(root, "design-sets", ".lock"), `${process.ppid} 2026-01-01T00:00:00Z\n`);
  await assert.rejects(() => sets.apply("slate", { confirm: true }), /another design-set write is running/);
});

test("doctor reports drift when the live design was changed outside the set", async () => {
  writeSet("slate", { settings: { theme_primary_color: "#334155" } });
  await sets.apply("slate", { confirm: true });
  assert.equal((await sets.doctor()).drift, undefined);
  mock.store.set("theme_primary_color", "#FF0000"); // e.g. edited in the admin UI
  const d = await sets.doctor();
  assert.deepEqual(d.drift, ["theme_primary_color"]);
  assert.equal(d.ok, false);
});

test("export captures the live design as a new, valid set", async () => {
  mock.store.set("custom_less", ".live{color:green}");
  const res = await sets.exportLive("live-copy");
  assert.equal(readFileSync(join(res.exported, "custom.less"), "utf8"), ".live{color:green}");
  assert.equal(res.set.header, "header.html");
  const v = await sets.validate("live-copy");
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test("gallery writes an HTML page listing every set", async () => {
  sets.create("one");
  sets.create("two");
  const g = sets.gallery();
  const html = readFileSync(g.file, "utf8");
  assert.equal(g.sets, 2);
  assert.match(html, /designset preview one --confirm/);
  assert.match(html, /<title>Design-set gallery<\/title>/);
});
