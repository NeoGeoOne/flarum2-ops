import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer, clientFromEnv } from "../dist/server.js";
import { FlarumClient } from "../dist/flarum-client.js";
import { Ops } from "../dist/ops.js";
import { startMockFlarum, makeForumRoot, ADMIN_TOKEN } from "./helpers/mock-flarum.mjs";

let mock;
let root;
before(async () => {
  root = makeForumRoot();
  mock = await startMockFlarum({ forumRoot: root });
});
after(async () => {
  await mock.close();
});

const cfg = () => ({
  name: "t",
  baseUrl: mock.base,
  forumRoot: root,
  tokenFile: "/nonexistent",
  designSetsDir: join(root, "design-sets"),
  publicAssetsSubdir: "design-sets",
  services: [],
  repoRoot: root,
  source: "test",
});

async function toolsFor(readOnly) {
  const client = new FlarumClient({ baseUrl: mock.base, apiKey: ADMIN_TOKEN, readOnly });
  const server = createMcpServer(client, new Ops(cfg(), client, mock.settingsStore));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const { tools } = await c.listTools();
  return { tools, c };
}

test("clientFromEnv is read-only unless FLARUM_MODE=write", () => {
  const saved = { ...process.env };
  try {
    process.env.FLARUM_URL = "http://forum.test";
    delete process.env.FLARUM_MODE;
    assert.equal(clientFromEnv().readOnly, true);
    process.env.FLARUM_MODE = "write";
    assert.equal(clientFromEnv().readOnly, false);
    process.env.READ_ONLY = "1";
    assert.equal(clientFromEnv().readOnly, true);
  } finally {
    process.env = saved;
  }
});

test("read-only server exposes ops read tools but no mutating tool", async () => {
  const { tools, c } = await toolsFor(true);
  const names = tools.map((t) => t.name);
  for (const n of ["flarum_doctor", "flarum_health", "flarum_settings_get", "designset_list", "designset_diff", "designset_validate"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const n of ["designset_apply", "designset_rollback", "flarum_settings_set", "flarum_upload_image", "flarum_extension_set", "flarum_create"]) {
    assert.ok(!names.includes(n), `${n} must be hidden in read-only mode`);
  }
  await c.close();
});

test("write server exposes the mutating tools and every tool carries annotations", async () => {
  const { tools, c } = await toolsFor(false);
  const names = tools.map((t) => t.name);
  for (const n of ["designset_apply", "designset_preview", "designset_rollback", "flarum_settings_set", "flarum_settings_reset", "flarum_upload_image", "flarum_cache_clear", "flarum_extension_set", "flarum_permission_set"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const missing = tools.filter((t) => !t.annotations || typeof t.annotations.readOnlyHint !== "boolean").map((t) => t.name);
  assert.deepEqual(missing, [], "tools without annotations");
  const apply = tools.find((t) => t.name === "designset_apply");
  assert.equal(apply.annotations.destructiveHint, true);
  assert.ok("confirm" in apply.inputSchema.properties);
  await c.close();
});

test("designset_apply through MCP is a dry run without confirm", async () => {
  mkdirSync(join(root, "design-sets", "mcp-set"), { recursive: true });
  writeFileSync(join(root, "design-sets", "mcp-set", "set.json"), JSON.stringify({ name: "mcp-set", title: "MCP", settings: { theme_primary_color: "#0EA5E9" } }));
  const { c } = await toolsFor(false);
  const res = await c.callTool({ name: "designset_apply", arguments: { name: "mcp-set" } });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.dryRun, true);
  assert.notEqual(mock.store.get("theme_primary_color"), "#0EA5E9");
  await c.close();
});

// ------------------------------------------------------------------- CLI

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, ...args], {
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test("CLI: dry runs exit 3, usage errors exit 2, output is JSON, token never printed", async () => {
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, ADMIN_TOKEN + "\n", { mode: 0o600 });
  const env = { FLARUM2_OPS_CONFIG: join(root, "forum.json") };
  writeFileSync(env.FLARUM2_OPS_CONFIG, JSON.stringify({ base_url: mock.base, token_file: tokenFile, design_sets_dir: "design-sets", services: [] }));
  const dry = await cli(["settings", "set", "theme_primary_color=#111111"], env);
  assert.equal(dry.code, 3, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  const who = await cli(["whoami"], env);
  assert.equal(JSON.parse(who.stdout).actor.isAdmin, true);
  assert.ok(!who.stdout.includes(ADMIN_TOKEN) && !who.stderr.includes(ADMIN_TOKEN));
  const bad = await cli(["nonsense"], env);
  assert.equal(bad.code, 2);
  const help = await cli([], env);
  assert.match(help.stdout, /designset apply/);
});
