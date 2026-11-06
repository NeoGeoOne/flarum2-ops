/**
 * Actor verification and token login.
 *
 * Flarum 2 never rejects a bad Authorization header: AuthenticateWithHeader
 * simply finds no ApiKey/AccessToken and the request continues as a guest.
 * Reads then look fine while every admin call 403s. whoami() therefore always
 * resolves the actor and its groups so callers can fail loudly instead.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FlarumClient } from "./flarum-client.js";

export const ADMIN_GROUP_ID = "1";

export interface Actor {
  authenticated: boolean;
  id?: string;
  username?: string;
  displayName?: string;
  groupIds: string[];
  isAdmin: boolean;
}

interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] | null }>;
}

interface JsonApiDoc {
  data?: JsonApiResource;
  included?: JsonApiResource[];
}

export async function whoami(client: FlarumClient): Promise<{ actor: Actor; forum: Record<string, unknown> }> {
  const doc = await client.request<JsonApiDoc>({ path: "/" });
  const forum = (doc.data?.attributes ?? {}) as Record<string, unknown>;
  const actorRef = doc.data?.relationships?.actor?.data as { id: string } | null | undefined;
  if (!actorRef) {
    return { actor: { authenticated: false, groupIds: [], isAdmin: false }, forum };
  }
  // The forum document does not reliably embed the actor's groups; ask for them.
  const user = await client.request<JsonApiDoc>({ path: `/users/${actorRef.id}`, query: { include: "groups" } });
  const groups = user.data?.relationships?.groups?.data;
  const groupIds = Array.isArray(groups) ? groups.map((g) => String(g.id)) : [];
  return {
    actor: {
      authenticated: true,
      id: String(actorRef.id),
      username: user.data?.attributes?.username as string | undefined,
      displayName: user.data?.attributes?.displayName as string | undefined,
      groupIds,
      isAdmin: groupIds.includes(ADMIN_GROUP_ID),
    },
    forum,
  };
}

/** Throw a clear error unless the configured credential acts as an admin. */
export async function requireAdmin(client: FlarumClient): Promise<Actor> {
  if (!client.hasCredentials) {
    throw new Error("No API credential configured. Run `flarum2-ops login` (writes the 0600 token file) first.");
  }
  const { actor } = await whoami(client);
  if (!actor.authenticated) {
    throw new Error(
      "The configured token is not accepted: Flarum treats the request as a guest (expired, revoked, or wrong forum). " +
        "Run `flarum2-ops login` again.",
    );
  }
  if (!actor.isAdmin) {
    throw new Error(`The token acts as user "${actor.username}" (groups ${actor.groupIds.join(",") || "none"}), not an admin.`);
  }
  return actor;
}

/** Read a line from a TTY without echoing it (for passwords). */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("login needs an interactive terminal (run it yourself, e.g. `! node …/dist/cli.js login`)."));
      return;
    }
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

export function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

/**
 * POST /api/token with remember=1 (session_remember token: 5-year sliding
 * lifetime) and store it in a 0600 file. Returns the user id only.
 */
export async function loginAndStore(
  forumUrl: string,
  identification: string,
  password: string,
  tokenFile: string,
): Promise<{ userId: string }> {
  const client = new FlarumClient({ baseUrl: forumUrl });
  const res = await client.raw<{ token?: string; userId?: string | number; errors?: unknown }>({
    method: "POST",
    path: "/token",
    body: { identification, password, remember: 1 },
  });
  if (res.status === 429) throw new Error("Too many login attempts (Flarum allows 5 per minute). Wait a minute and retry.");
  if (!res.ok || !res.body || typeof res.body !== "object" || !res.body.token) {
    throw new Error(`Login failed (HTTP ${res.status}). Check the username/email and password.`);
  }
  const dir = dirname(tokenFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${res.body.token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return { userId: String(res.body.userId ?? "") };
}
