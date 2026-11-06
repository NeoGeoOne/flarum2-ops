/**
 * Thin wrapper around the Flarum JSON:API.
 *
 * Flarum exposes every resource (discussions, posts, users, tags, groups,
 * notifications, flags, settings, and any third-party extension resource)
 * through one uniform JSON:API at `{baseUrl}/api`. This client speaks that
 * protocol generically, so the MCP tools on top of it cover the whole surface.
 *
 * Auth uses Flarum's token header, which accepts both kinds of credential:
 *   Authorization: Token <access-token>            (from POST /api/token)
 *   Authorization: Token <api-key>; userId=<id>    (master key from `api_keys`)
 * Either one bypasses CSRF. An invalid credential does NOT fail: Flarum then
 * treats the request as a guest, so callers must verify the actor (see auth.ts).
 *
 * flarum2-ops fork notes (vs mcp-for-flarum 0.8.0): paths are normalised
 * ("/api/x" == "/x"), raw() returns status + parsed body (incl. NDJSON),
 * upload() sends multipart, and timeouts can be set per call.
 */

export interface FlarumClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Act as this user id when using a master API key. */
  userId?: string | number;
  timeoutMs?: number;
  /**
   * User-Agent sent on every request to the Flarum API. An explicit, identifiable
   * UA matters because many forums sit behind Cloudflare (or similar) WAFs that
   * block requests with a generic/empty user-agent (Cloudflare error 1010,
   * "browser_signature_banned"). A descriptive UA both dodges those default rules
   * and lets admins allowlist this tool specifically. Defaults are set by the
   * caller (see server.ts); a falsy value sends no UA header.
   */
  userAgent?: string;
  /**
   * When true, the client refuses any mutating request (POST/PUT/PATCH/DELETE).
   * Enforced centrally in request() so no tool -- including the raw
   * flarum_request escape hatch -- can bypass it.
   */
  readOnly?: boolean;
}

export interface FlarumRequestOptions {
  method?: string;
  /** Path relative to the API root, e.g. "/discussions" or "/users/1". */
  path: string;
  /** Query params; arrays/objects are JSON-encoded where Flarum expects it. */
  query?: Record<string, unknown>;
  /** JSON:API request body (already shaped as { data: {...} }), or raw object. */
  body?: unknown;
  /** Per-call timeout override in ms (e.g. cache clears, extension toggles). */
  timeoutMs?: number;
}

/** Full response of a Flarum API call, including the status code. */
export interface FlarumResponse<T = unknown> {
  status: number;
  ok: boolean;
  contentType: string;
  /** Parsed JSON, parsed NDJSON (array of objects), raw text, or null for empty bodies. */
  body: T;
}

/** Strip an accidental leading "/api" so "/api/settings" and "/settings" both work. */
export function normalizeApiPath(path: string): string {
  let p = path.trim();
  if (/^https?:\/\//i.test(p)) {
    throw new Error(`Pass an API path such as "/settings", not a full URL (${p}).`);
  }
  if (!p.startsWith("/")) p = `/${p}`;
  // "/api", "/api/", "/api/x" -> "/", "/", "/x". Leaves "/apis" etc. alone.
  if (p === "/api" || p === "/api/") return "/";
  if (p.startsWith("/api/")) p = p.slice(4);
  return p;
}

/** Parse a body according to its content type (JSON, NDJSON or text). */
export function parseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (/ndjson/i.test(contentType)) {
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class FlarumError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "FlarumError";
    this.status = status;
    this.body = body;
  }
}

export class FlarumClient {
  private baseUrl: string;
  private apiKey?: string;
  private userId?: string | number;
  private timeoutMs: number;
  private userAgent?: string;
  readonly readOnly: boolean;

  constructor(opts: FlarumClientOptions) {
    // Normalise: strip trailing slash, ensure we target the /api root.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.userId = opts.userId;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent;
    this.readOnly = opts.readOnly ?? false;
  }

  private apiRoot(): string {
    return this.baseUrl.endsWith("/api") ? this.baseUrl : `${this.baseUrl}/api`;
  }

  private headers(json = true): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.api+json, application/json",
    };
    if (json) headers["Content-Type"] = "application/json";
    if (this.userAgent) {
      headers["User-Agent"] = this.userAgent;
    }
    if (this.apiKey) {
      let token = `Token ${this.apiKey}`;
      if (this.userId !== undefined && this.userId !== "") {
        token += `; userId=${this.userId}`;
      }
      headers["Authorization"] = token;
    }
    return headers;
  }

  /** Flatten nested query objects into JSON:API's bracketed form. */
  private buildQuery(query?: Record<string, unknown>): string {
    if (!query) return "";
    const params = new URLSearchParams();
    const add = (key: string, value: unknown) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        params.append(key, value.join(","));
      } else if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          add(`${key}[${k}]`, v);
        }
      } else {
        params.append(key, String(value));
      }
    };
    for (const [key, value] of Object.entries(query)) add(key, value);
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  /** True when an API credential is configured. */
  get hasCredentials(): boolean {
    return Boolean(this.apiKey);
  }

  /** Public base URL of the forum (without /api). */
  get forumUrl(): string {
    return this.baseUrl.replace(/\/api$/, "");
  }

  private guard(method: string, path: string): boolean {
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    // Read-only guard: the single chokepoint every tool flows through.
    if (this.readOnly && mutating) {
      throw new Error(
        `Refusing ${method} ${path}: server is in read-only mode. ` +
          `Set FLARUM_MODE=write to allow writes.`,
      );
    }
    return mutating;
  }

  private async send(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    init: { body?: BodyInit; json: boolean },
    timeoutMs?: number,
  ): Promise<FlarumResponse> {
    const url = `${this.apiRoot()}${path === "/" ? "" : path}${this.buildQuery(query)}`;
    const controller = new AbortController();
    const ms = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers(init.json),
          body: init.body,
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(
            `Flarum API ${method} ${path} timed out after ${ms} ms. ` +
              (method === "GET" ? "" : "The write may still have completed on the server; re-read state before retrying."),
          );
        }
        throw err;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      return { status: res.status, ok: res.ok, contentType, body: parseBody(text, contentType) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Make a request and return the full response (status, content type, parsed
   * body) without throwing on HTTP errors. Read-only mode still throws.
   */
  async raw<T = unknown>(opts: FlarumRequestOptions): Promise<FlarumResponse<T>> {
    const method = (opts.method ?? "GET").toUpperCase();
    const path = normalizeApiPath(opts.path);
    this.guard(method, path);
    const body =
      opts.body !== undefined && method !== "GET" && method !== "HEAD"
        ? JSON.stringify(opts.body)
        : undefined;
    return (await this.send(method, path, opts.query, { body, json: true }, opts.timeoutMs)) as FlarumResponse<T>;
  }

  async request<T = unknown>(opts: FlarumRequestOptions): Promise<T> {
    const method = (opts.method ?? "GET").toUpperCase();
    const res = await this.raw<T>({ ...opts, method });
    if (!res.ok) {
      throw new FlarumError(
        `Flarum API ${method} ${normalizeApiPath(opts.path)} failed: ${res.status}`,
        res.status,
        res.body,
      );
    }
    return res.body;
  }

  /**
   * Multipart upload (logo, logo-dark-mode, email-logo, favicon). The form
   * field name must equal the route name in Flarum 2 (UploadImageController).
   */
  async upload<T = unknown>(opts: {
    path: string;
    field: string;
    filename: string;
    data: Uint8Array;
    mimeType: string;
    timeoutMs?: number;
  }): Promise<FlarumResponse<T>> {
    const path = normalizeApiPath(opts.path);
    this.guard("POST", path);
    const form = new FormData();
    form.append(opts.field, new Blob([new Uint8Array(opts.data)], { type: opts.mimeType }), opts.filename);
    return (await this.send("POST", path, undefined, { body: form, json: false }, opts.timeoutMs)) as FlarumResponse<T>;
  }
}
