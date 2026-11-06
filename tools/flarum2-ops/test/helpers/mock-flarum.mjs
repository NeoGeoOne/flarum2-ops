// A small in-process Flarum 2.0 API double for testing flarum2-ops end to end
// without a real forum. It mirrors the behaviours the engine depends on
// (verified against flarum/core 2.0.2):
//  - a bad/missing token is treated as a guest (no 401)
//  - POST /api/settings is a flat object -> 204; a broken custom_less -> 422
//    AND leaves custom_less_error behind; a good custom_less clears it
//  - DELETE /api/settings {keys} -> 204 (keys removed)
//  - image uploads are multipart with field name == route name, get a random
//    file name, delete the previous file and answer 200 with the forum doc
//  - DELETE /api/cache streams NDJSON (200)
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export const ADMIN_TOKEN = "admin-token-123456";
export const MEMBER_TOKEN = "member-token-123456";

const IMAGE_ROUTES = {
  logo: "logo_path",
  "logo-dark-mode": "logo_dark_mode_path",
  "email-logo": "email_logo_path",
  favicon: "favicon_path",
};
const URL_ATTR = { logo: "logoUrl", "logo-dark-mode": "logoDarkModeUrl", "email-logo": "emailLogoUrl", favicon: "faviconUrl" };

export function makeForumRoot() {
  const root = mkdtempSync(join(tmpdir(), "flarum2-ops-test-"));
  mkdirSync(join(root, "public", "assets"), { recursive: true });
  return root;
}

export async function startMockFlarum({ forumRoot, settings = {}, tags, extensions = ["flarum-tags"] } = {}) {
  const store = new Map(Object.entries({
    forum_title: "Test Forum",
    theme_primary_color: "#4D698E",
    theme_secondary_color: "#4D698E",
    theme_colored_header: "0",
    color_scheme: "auto",
    custom_less: "",
    extensions_enabled: JSON.stringify(extensions),
    "flarum-tags.max_primary_tags": "1",
    ...settings,
  }));
  const tagMap = new Map(
    (tags ?? [{ id: "1", slug: "general", name: "General", color: "#888", icon: "fas fa-comments", description: "" }]).map((t) => [t.id, { ...t }]),
  );
  const permissions = { viewForum: [2], startDiscussion: [3] };
  const requests = [];
  const behaviour = { cacheFails: false, failSettingsKey: null };

  const actorFor = (req) => {
    const auth = req.headers.authorization ?? "";
    if (auth === `Token ${ADMIN_TOKEN}`) return { id: "1", username: "admin", groups: ["1"] };
    if (auth === `Token ${MEMBER_TOKEN}`) return { id: "2", username: "member", groups: ["3"] };
    return null; // Flarum: unknown token == guest, never 401
  };

  const forumDoc = (actor, base) => ({
    data: {
      type: "forums",
      id: "1",
      attributes: {
        title: store.get("forum_title"),
        baseUrl: base,
        apiUrl: `${base}/api`,
        assetsBaseUrl: `${base}/assets`,
        colorScheme: store.get("color_scheme") ?? "auto",
        themePrimaryColor: store.get("theme_primary_color") ?? "#4D698E",
        themeSecondaryColor: store.get("theme_secondary_color") ?? "#4D698E",
        logoUrl: store.get("logo_path") ? `${base}/assets/${store.get("logo_path")}` : null,
        logoDarkModeUrl: store.get("logo_dark_mode_path") ? `${base}/assets/${store.get("logo_dark_mode_path")}` : null,
        faviconUrl: store.get("favicon_path") ? `${base}/assets/${store.get("favicon_path")}` : null,
      },
      relationships: { actor: { data: actor ? { type: "users", id: actor.id } : null } },
    },
  });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const actor = actorFor(req);
    const base = `http://127.0.0.1:${server.address().port}`;
    requests.push({ method: req.method, path: url.pathname, auth: Boolean(actor), contentType: req.headers["content-type"] ?? "", body: raw.toString("utf8").slice(0, 2000) });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/vnd.api+json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const empty = (status = 204) => {
      res.writeHead(status);
      res.end();
    };
    const forbidden = () => json(403, { errors: [{ status: "403", code: "permission_denied" }] });
    const isAdmin = actor?.groups.includes("1");
    const p = url.pathname;

    if (p === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<html><head><link rel="stylesheet" href="/assets/forum.css?v=abc"></head><body><div id="app"></div></body></html>');
    }
    if (p === "/assets/forum.css") {
      res.writeHead(200, { "content-type": "text/css" });
      return res.end("body{}");
    }
    if (p === "/api" && req.method === "GET") return json(200, forumDoc(actor, base));
    const userMatch = /^\/api\/users\/(\d+)$/.exec(p);
    if (userMatch && req.method === "GET") {
      const id = userMatch[1];
      const groups = id === "1" ? ["1"] : ["3"];
      return json(200, {
        data: { type: "users", id, attributes: { username: id === "1" ? "admin" : "member", displayName: id === "1" ? "Admin" : "Member" }, relationships: { groups: { data: groups.map((g) => ({ type: "groups", id: g })) } } },
      });
    }
    if (p === "/api/discussions" && req.method === "GET") return json(200, { data: [] });

    if (p === "/api/settings") {
      if (!isAdmin) return forbidden();
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      if (req.method === "POST") {
        if (typeof body.custom_less === "string" && body.custom_less.includes("BROKEN")) {
          store.set("custom_less_error", "ParseError: unrecognised input");
          return json(422, { errors: [{ status: "422", code: "validation_error", detail: "ParseError: unrecognised input", source: { pointer: "/data/attributes/custom_less" } }] });
        }
        if (behaviour.failSettingsKey && behaviour.failSettingsKey in body) {
          return json(500, { errors: [{ status: "500", code: "internal" }] });
        }
        for (const [k, v] of Object.entries(body)) {
          store.set(k, v === null ? null : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
        }
        if ("custom_less" in body) store.delete("custom_less_error");
        return empty();
      }
      if (req.method === "DELETE") {
        for (const k of body.keys ?? []) store.delete(k);
        return empty();
      }
    }

    const img = /^\/api\/(logo|logo-dark-mode|email-logo|favicon)$/.exec(p);
    if (img) {
      if (!isAdmin) return forbidden();
      const route = img[1];
      const key = IMAGE_ROUTES[route];
      const old = store.get(key);
      if (req.method === "POST") {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.startsWith("multipart/form-data") || !raw.toString("latin1").includes(`name="${route}"`)) {
          return json(422, { errors: [{ status: "422", code: "validation_error", detail: `missing ${route} file field` }] });
        }
        if (old && existsSync(join(forumRoot, "public", "assets", old))) rmSync(join(forumRoot, "public", "assets", old));
        const file = `${route}-${randomBytes(4).toString("hex")}.${route === "favicon" ? "png" : "webp"}`;
        writeFileSync(join(forumRoot, "public", "assets", file), raw.subarray(0, 64));
        store.set(key, file);
        const doc = forumDoc(actor, base);
        doc.data.attributes[URL_ATTR[route]] = `${base}/assets/${file}`;
        return json(200, doc);
      }
      if (req.method === "DELETE") {
        if (old && existsSync(join(forumRoot, "public", "assets", old))) rmSync(join(forumRoot, "public", "assets", old));
        store.set(key, null);
        return empty();
      }
    }

    if (p === "/api/cache" && req.method === "DELETE") {
      if (!isAdmin) return forbidden();
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ type: "started" }) + "\n");
      res.write(JSON.stringify({ type: behaviour.cacheFails ? "failed" : "progress", step: "assets" }) + "\n");
      return res.end(JSON.stringify({ type: "finished" }) + "\n");
    }

    if (p === "/api/tags" && req.method === "GET") {
      return json(200, { data: [...tagMap.values()].map((t) => ({ type: "tags", id: t.id, attributes: { slug: t.slug, name: t.name, color: t.color, icon: t.icon, description: t.description } })) });
    }
    const tagMatch = /^\/api\/tags\/(\d+)$/.exec(p);
    if (tagMatch && req.method === "PATCH") {
      if (!isAdmin) return forbidden();
      const t = tagMap.get(tagMatch[1]);
      if (!t) return json(404, { errors: [{ status: "404" }] });
      const attrs = JSON.parse(raw.toString("utf8")).data.attributes;
      Object.assign(t, attrs);
      return json(200, { data: { type: "tags", id: t.id, attributes: t } });
    }

    const ext = /^\/api\/extensions\/([a-z0-9-]+)$/.exec(p);
    if (ext && req.method === "PATCH") {
      if (!isAdmin) return forbidden();
      const list = JSON.parse(store.get("extensions_enabled") ?? "[]");
      const { enabled } = JSON.parse(raw.toString("utf8"));
      const next = enabled ? [...new Set([...list, ext[1]])] : list.filter((x) => x !== ext[1]);
      store.set("extensions_enabled", JSON.stringify(next));
      return empty();
    }

    if (p === "/api/permission" && req.method === "POST") {
      if (!isAdmin) return forbidden();
      const { permission, groupIds } = JSON.parse(raw.toString("utf8"));
      permissions[permission] = groupIds;
      return empty();
    }

    json(404, { errors: [{ status: "404", code: "route_not_found" }] });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** SettingsStore backed by the same map the API mutates (stands in for the PHP/PDO reader). */
  const settingsStore = {
    async read(keys, prefixes = []) {
      const out = {};
      const all = new Set(keys);
      for (const k of store.keys()) if (prefixes.some((p) => k.startsWith(p))) all.add(k);
      for (const k of all) {
        if (!store.has(k)) out[k] = { state: "absent" };
        else if (store.get(k) === null) out[k] = { state: "null" };
        else if (/password|secret|token/i.test(k)) out[k] = { state: "redacted" };
        else out[k] = { state: "value", value: store.get(k) };
      }
      return out;
    },
    async listKeys() {
      return [...store.keys()].map((key) => ({ key, secret: /password|secret|token/i.test(key) }));
    },
    async permissions(names) {
      return Object.fromEntries(names.map((n) => [n, permissions[n] ?? []]));
    },
  };

  return {
    base,
    store,
    tags: tagMap,
    permissions,
    requests,
    behaviour,
    settingsStore,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Comparable view of the settings store (volatile keys removed, paths reduced to presence). */
export function normalisedState(store) {
  const out = {};
  for (const [k, v] of [...store.entries()].sort()) {
    if (/^assets_dirty\.|^custom_less_error$/.test(k)) continue;
    out[k] = /_path$/.test(k) ? (v ? "<file>" : v) : v;
  }
  return out;
}

// Minimal valid images (headers only; enough for type/size sniffing).
export function pngBytes(w = 200, h = 120) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
