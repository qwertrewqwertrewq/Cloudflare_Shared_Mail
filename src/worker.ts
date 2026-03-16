import PostalMime from "postal-mime";

type Role = "admin" | "preview";

interface Env {
  MAIL_KV: any;
  MAIL_R2: any;
  ADMIN_SECRET: string;
  SESSION_SIGNING_KEY: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  API_BASE_URL: string;
  PAGES_BASE_URL: string;
  FRONTEND_ORIGIN: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  WORKER_NAME?: string;
}

interface MailboxConfig {
  email: string;
  path: string;
  codeHash: string;
  accessCode?: string;
  autoDeleteHours: number;
  maxStored: number;
  createdAt: string;
  updatedAt: string;
}

interface MailMessageMeta {
  id: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: string;
  hasHtml: boolean;
  size: number;
}

interface StoredMailMessage {
  id: string;
  mailbox: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: string;
  dateHeader: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

interface SignedTokenPayload {
  role: Role;
  exp: number;
  email?: string;
  path?: string;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAILBOX_KEY = "cfg:mailboxes";

export default {
  async email(message: any, env: Env): Promise<void> {
    const email = message.to.toLowerCase();
    const map = await loadMailboxMap(env);
    const mailbox = map[email];
    if (!mailbox) {
      return;
    }

    const raw = await streamToArrayBuffer(message.raw);
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);

    const id = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const subject = safeString(parsed.subject) || safeString(message.headers.get("subject")) || "(No subject)";
    const from = safeString(parsed.from?.address) || safeString(message.from) || "unknown";
    const to = safeString(parsed.to?.[0]?.address) || email;
    const text = safeString(parsed.text);
    const html = safeString(parsed.html);

    const stored: StoredMailMessage = {
      id,
      mailbox: email,
      subject,
      from,
      to,
      receivedAt,
      dateHeader: safeString(parsed.date) || safeString(message.headers.get("date")),
      text,
      html,
      headers: flattenHeaders(parsed.headers)
    };

    const key = r2MessageKey(email, id);
    const body = JSON.stringify(stored);
    await env.MAIL_R2.put(key, body, {
      httpMetadata: { contentType: "application/json" }
    });

    const index = await loadMessageIndex(env, email);
    const next: MailMessageMeta[] = [
      {
        id,
        subject,
        from,
        to,
        receivedAt,
        hasHtml: Boolean(html),
        size: body.length
      },
      ...index
    ];

    const trimmed = trimToMax(next, mailbox.maxStored);
    await saveMessageIndex(env, email, trimmed.keep);

    if (trimmed.remove.length > 0) {
      await Promise.all(trimmed.remove.map((item) => env.MAIL_R2.delete(r2MessageKey(email, item.id))));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/public/config" && request.method === "GET") {
        return json(
          {
            turnstileSiteKey: env.TURNSTILE_SITE_KEY,
            pagesBaseUrl: env.PAGES_BASE_URL
          },
          env
        );
      }

      if (pathname === "/api/admin/login" && request.method === "POST") {
        const data = (await request.json()) as { secret?: string; turnstileToken?: string };
        await requireTurnstile(env, data.turnstileToken, request);
        if (!timingSafeEqual(data.secret || "", env.ADMIN_SECRET)) {
          return json({ error: "Invalid admin secret." }, env, 401);
        }

        const token = await signToken(env, {
          role: "admin",
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12
        });
        return json({ token }, env);
      }

      if (pathname.startsWith("/api/admin/")) {
        const admin = await requireRole(env, request, "admin");
        if (!admin) {
          return json({ error: "Unauthorized" }, env, 401);
        }

        if (pathname === "/api/admin/mailboxes" && request.method === "GET") {
          const map = await loadMailboxMap(env);
          let changed = false;

          for (const mailbox of Object.values(map)) {
            if (!safeString(mailbox.accessCode)) {
              const plainCode = generateStrongPassword(8);
              mailbox.accessCode = plainCode;
              mailbox.codeHash = await hashCode(env, plainCode);
              mailbox.updatedAt = new Date().toISOString();
              changed = true;
            }
          }

          if (changed) {
            await saveMailboxMap(env, map);
          }

          const list = Object.values(map).map((item) => ({
            ...item,
            codeHash: undefined,
            previewUrl: buildPreviewUrl(env, item.path),
            shareUrl: buildShareUrl(env, item.path, item.accessCode)
          }));
          return json({ mailboxes: list }, env);
        }

        if (pathname === "/api/admin/mailboxes" && request.method === "POST") {
          const data = (await request.json()) as { email?: string };
          const email = normalizeEmail(data.email || "");
          if (!email) {
            return json({ error: "Invalid email." }, env, 400);
          }

          const map = await loadMailboxMap(env);
          if (map[email]) {
            return json({ error: "Mailbox already exists." }, env, 409);
          }

          await upsertCloudflareEmailRoute(env, email);

          const path = generatePathCode(16);
          const plainCode = generateStrongPassword(8);
          const now = new Date().toISOString();
          const mailbox: MailboxConfig = {
            email,
            path,
            codeHash: await hashCode(env, plainCode),
            accessCode: plainCode,
            autoDeleteHours: 72,
            maxStored: 200,
            createdAt: now,
            updatedAt: now
          };

          map[email] = mailbox;
          await saveMailboxMap(env, map);
          await env.MAIL_KV.put(pathIndexKey(path), email);

          return json(
            {
              mailbox: {
                ...mailbox,
                codeHash: undefined,
                accessCode: plainCode,
                previewUrl: buildPreviewUrl(env, path),
                shareUrl: buildShareUrl(env, path, plainCode)
              }
            },
            env,
            201
          );
        }

        if (pathname.match(/^\/api\/admin\/mailboxes\/[^/]+$/) && request.method === "PATCH") {
          const email = decodeURIComponent(pathname.split("/").pop() || "").toLowerCase();
          const data = (await request.json()) as { autoDeleteHours?: number; maxStored?: number };
          const map = await loadMailboxMap(env);
          const current = map[email];
          if (!current) {
            return json({ error: "Mailbox not found." }, env, 404);
          }

          const autoDeleteHours = clampNumber(data.autoDeleteHours, 1, 24 * 365, current.autoDeleteHours);
          const maxStored = clampNumber(data.maxStored, 1, 5000, current.maxStored);
          map[email] = {
            ...current,
            autoDeleteHours,
            maxStored,
            updatedAt: new Date().toISOString()
          };
          await saveMailboxMap(env, map);

          const index = await loadMessageIndex(env, email);
          const trimmed = trimToMax(index, maxStored);
          if (trimmed.remove.length > 0) {
            await Promise.all(trimmed.remove.map((item) => env.MAIL_R2.delete(r2MessageKey(email, item.id))));
            await saveMessageIndex(env, email, trimmed.keep);
          }

          return json({ mailbox: { ...map[email], codeHash: undefined } }, env);
        }

        if (pathname.match(/^\/api\/admin\/mailboxes\/[^/]+\/rotate$/) && request.method === "POST") {
          const email = decodeURIComponent(pathname.split("/")[4] || "").toLowerCase();
          const map = await loadMailboxMap(env);
          const current = map[email];
          if (!current) {
            return json({ error: "Mailbox not found." }, env, 404);
          }

          const nextPath = generatePathCode(16);
          const plainCode = generateStrongPassword(8);

          map[email] = {
            ...current,
            path: nextPath,
            codeHash: await hashCode(env, plainCode),
            accessCode: plainCode,
            updatedAt: new Date().toISOString()
          };

          await env.MAIL_KV.delete(pathIndexKey(current.path));
          await env.MAIL_KV.put(pathIndexKey(nextPath), email);
          await saveMailboxMap(env, map);

          return json(
            {
              mailbox: {
                ...map[email],
                codeHash: undefined,
                accessCode: plainCode,
                previewUrl: buildPreviewUrl(env, nextPath),
                shareUrl: buildShareUrl(env, nextPath, plainCode)
              }
            },
            env
          );
        }

        return json({ error: "Admin endpoint not found." }, env, 404);
      }

      if (pathname === "/api/preview/access" && request.method === "POST") {
        const data = (await request.json()) as { path?: string; code?: string; turnstileToken?: string };
        await requireTurnstile(env, data.turnstileToken, request);

        const path = safeString(data.path);
        const code = safeString(data.code);
        if (!path || !code) {
          return json({ error: "Path and access code are required." }, env, 400);
        }

        const email = await env.MAIL_KV.get(pathIndexKey(path));
        if (!email) {
          return json({ error: "Invalid path or access code." }, env, 403);
        }

        const map = await loadMailboxMap(env);
        const mailbox = map[email];
        if (!mailbox) {
          return json({ error: "Mailbox config not found." }, env, 403);
        }

        const ok = (await hashCode(env, code)) === mailbox.codeHash;
        if (!ok) {
          return json({ error: "Invalid path or access code." }, env, 403);
        }

        const token = await signToken(env, {
          role: "preview",
          email,
          path,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12
        });

        return json({ token, mailbox: email }, env);
      }

      if (pathname.startsWith("/api/preview/")) {
        const payload = await requireRole(env, request, "preview");
        if (!payload?.email) {
          return json({ error: "Unauthorized" }, env, 401);
        }

        if (pathname === "/api/preview/messages" && request.method === "GET") {
          const items = await loadMessageIndex(env, payload.email);
          return json({ mailbox: payload.email, messages: items }, env);
        }

        if (pathname.match(/^\/api\/preview\/messages\/[^/]+$/) && request.method === "GET") {
          const id = decodeURIComponent(pathname.split("/").pop() || "");
          const obj = await env.MAIL_R2.get(r2MessageKey(payload.email, id));
          if (!obj) {
            return json({ error: "Message not found." }, env, 404);
          }
          const msg = (await obj.json()) as StoredMailMessage;
          return json({ mailbox: payload.email, message: msg }, env);
        }

        return json({ error: "Preview endpoint not found." }, env, 404);
      }

      return json({ error: "Not found" }, env, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, env, error.status);
      }
      const message = error instanceof Error ? error.message : "Internal error";
      return json({ error: message }, env, 500);
    }
  },

  async scheduled(_event: any, env: Env): Promise<void> {
    const map = await loadMailboxMap(env);
    const now = Date.now();

    for (const mailbox of Object.values(map)) {
      const index = await loadMessageIndex(env, mailbox.email);
      const keep: MailMessageMeta[] = [];
      const remove: MailMessageMeta[] = [];
      const ttlMs = mailbox.autoDeleteHours * 60 * 60 * 1000;

      for (const item of index) {
        const expired = new Date(item.receivedAt).getTime() + ttlMs < now;
        if (expired) {
          remove.push(item);
        } else {
          keep.push(item);
        }
      }

      const trimmed = trimToMax(keep, mailbox.maxStored);
      remove.push(...trimmed.remove);

      if (remove.length > 0) {
        await Promise.all(remove.map((item) => env.MAIL_R2.delete(r2MessageKey(mailbox.email, item.id))));
      }

      await saveMessageIndex(env, mailbox.email, trimmed.keep);
    }
  }
};

function normalizeEmail(input: string): string {
  const value = safeString(input).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

function flattenHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") {
    return out;
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(value ?? "");
  }

  return out;
}

function safeString(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  return "";
}

function generatePathCode(length: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return pickChars(chars, length);
}

function generateStrongPassword(length: number): string {
  const lowers = "abcdefghijklmnopqrstuvwxyz";
  const uppers = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";
  const symbols = "!@#$%^&*()_+-=";
  const all = lowers + uppers + numbers + symbols;

  const required = [
    pickChars(lowers, 1),
    pickChars(uppers, 1),
    pickChars(numbers, 1),
    pickChars(symbols, 1)
  ].join("");
  const rest = pickChars(all, Math.max(0, length - required.length));
  return shuffleString(required + rest);
}

function pickChars(pool: string, length: number): string {
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += pool[arr[i] % pool.length];
  }
  return out;
}

function shuffleString(input: string): string {
  const arr = input.split("");
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

function trimToMax(items: MailMessageMeta[], maxStored: number): { keep: MailMessageMeta[]; remove: MailMessageMeta[] } {
  if (items.length <= maxStored) {
    return { keep: items, remove: [] };
  }

  return {
    keep: items.slice(0, maxStored),
    remove: items.slice(maxStored)
  };
}

function pathIndexKey(path: string): string {
  return `idx:path:${path}`;
}

function messageIndexKey(email: string): string {
  return `idx:mail:${email}`;
}

function buildPreviewUrl(env: Env, path: string): string {
  return `${env.PAGES_BASE_URL.replace(/\/$/, "")}/p/${path}`;
}

function buildShareUrl(env: Env, path: string, accessCode?: string): string {
  const preview = buildPreviewUrl(env, path);
  if (!accessCode) {
    return preview;
  }
  return `${preview}?code=${encodeURIComponent(accessCode)}`;
}

function r2MessageKey(email: string, id: string): string {
  return `mail/${email}/${id}.json`;
}

async function loadMailboxMap(env: Env): Promise<Record<string, MailboxConfig>> {
  const raw = await env.MAIL_KV.get(MAILBOX_KEY, "json");
  return (raw as Record<string, MailboxConfig>) || {};
}

async function saveMailboxMap(env: Env, map: Record<string, MailboxConfig>): Promise<void> {
  await env.MAIL_KV.put(MAILBOX_KEY, JSON.stringify(map));
}

async function loadMessageIndex(env: Env, email: string): Promise<MailMessageMeta[]> {
  const raw = await env.MAIL_KV.get(messageIndexKey(email), "json");
  return (raw as MailMessageMeta[]) || [];
}

async function saveMessageIndex(env: Env, email: string, list: MailMessageMeta[]): Promise<void> {
  await env.MAIL_KV.put(messageIndexKey(email), JSON.stringify(list));
}

async function hashCode(env: Env, code: string): Promise<string> {
  const input = new TextEncoder().encode(`${env.SESSION_SIGNING_KEY}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bufferToHex(digest);
}

function bufferToHex(input: ArrayBuffer): string {
  const arr = new Uint8Array(input);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signToken(env: Env, payload: SignedTokenPayload): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(env.SESSION_SIGNING_KEY, body);
  return `${body}.${signature}`;
}

async function verifyToken(env: Env, token: string): Promise<SignedTokenPayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const expected = await hmacSha256(env.SESSION_SIGNING_KEY, body);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }

  let parsed: SignedTokenPayload;
  try {
    parsed = JSON.parse(base64UrlDecode(body));
  } catch {
    return null;
  }

  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return parsed;
}

async function requireRole(env: Env, request: Request, role: Role): Promise<SignedTokenPayload | null> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return null;
  }

  const payload = await verifyToken(env, token);
  if (!payload || payload.role !== role) {
    return null;
  }

  return payload;
}

async function hmacSha256(secret: string, content: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(content));
  return base64UrlEncode(signature);
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function requireTurnstile(env: Env, token: string | undefined, request: Request): Promise<void> {
  if (!token) {
    throw new Error("Turnstile token is required.");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const form = new URLSearchParams();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) {
    form.set("remoteip", ip);
  }

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });

  if (!res.ok) {
    throw new Error("Turnstile verification failed.");
  }

  const data = (await res.json()) as { success?: boolean };
  if (!data.success) {
    throw new Error("Turnstile verification rejected.");
  }
}

async function upsertCloudflareEmailRoute(env: Env, email: string): Promise<void> {
  const workerName = env.WORKER_NAME || "cfmail-worker";
  const ruleName = `cfmail-${email}`;

  await ensureEmailRoutingEnabled(env);

  const list = await cfApi<{ result?: Array<{ tag: string; name: string }> }>(env, "GET", `/zones/${env.CF_ZONE_ID}/email/routing/rules`);
  const existing = list.result?.find((item) => item.name === ruleName);

  const basePayload = {
    name: ruleName,
    enabled: true,
    matchers: [
      {
        type: "literal",
        field: "to",
        value: email
      }
    ],
    actions: [
      {
        type: "worker",
        value: [workerName]
      }
    ]
  };

  try {
    if (existing?.tag) {
      await cfApi(env, "PUT", `/zones/${env.CF_ZONE_ID}/email/routing/rules/${existing.tag}`, basePayload);
    } else {
      await cfApi(env, "POST", `/zones/${env.CF_ZONE_ID}/email/routing/rules`, basePayload);
    }
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (!message.includes("value")) {
      throw err;
    }
  }

  const compatibilityPayload = {
    ...basePayload,
    actions: [
      {
        type: "worker",
        value: workerName
      }
    ]
  };

  if (existing?.tag) {
    await cfApi(env, "PUT", `/zones/${env.CF_ZONE_ID}/email/routing/rules/${existing.tag}`, compatibilityPayload);
  } else {
    await cfApi(env, "POST", `/zones/${env.CF_ZONE_ID}/email/routing/rules`, compatibilityPayload);
  }
}

async function ensureEmailRoutingEnabled(env: Env): Promise<void> {
  try {
    const settings = await cfApi<{ result?: { enabled?: boolean } }>(env, "GET", `/zones/${env.CF_ZONE_ID}/email/routing`);
    if (!settings.result?.enabled) {
      throw new HttpError(400, "Cloudflare Email Routing is not enabled for this zone.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const isRoutingAuthError = message.includes("/email/routing") && (message.includes("(10000)") || message.toLowerCase().includes("authentication error"));
    if (isRoutingAuthError) {
      throw new HttpError(
        403,
        "Token cannot access /zones/{zone_id}/email/routing. Add Zone permission 'Email Routing: Read' (or Edit) for this zone, then update CF_API_TOKEN secret."
      );
    }
    throw error;
  }
}

async function cfApi<T = unknown>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data: ({ success?: boolean; errors?: Array<{ code?: number; message?: string }> } & T) | null = null;
  let rawText = "";
  try {
    data = (await res.json()) as { success?: boolean; errors?: Array<{ code?: number; message?: string }> } & T;
  } catch {
    rawText = await res.text();
  }

  if (!res.ok || !data?.success) {
    const errorText =
      data?.errors?.map((item) => `(${item.code || "unknown"}) ${item.message || "Unknown error"}`).join("; ") ||
      rawText ||
      "Cloudflare API request failed.";
    const status = res.status === 400 ? 400 : res.status === 401 || res.status === 403 ? 502 : 502;
    throw new HttpError(status, `Cloudflare API ${method} ${path} failed: ${errorText}`);
  }

  return data;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function json(payload: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      ...corsHeaders(env)
    }
  });
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  return await new Response(stream).arrayBuffer();
}
