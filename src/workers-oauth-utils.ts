/**
 * OAuth 2.1 Security Utilities for Cloudflare Workers
 *
 * Handles CSRF protection, state management, and session binding
 * for the OAuth authorization flow.
 *
 * Adapted from Cloudflare's MCP OAuth demo.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public status: number = 400
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ error: this.code, error_description: this.description }),
      { status: this.status, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Generate a CSRF token and a Set-Cookie header.
 */
export function generateCSRFProtection(): {
  token: string;
  setCookie: string;
} {
  const token = crypto.randomUUID();
  const setCookie = `__Host-CSRF_TOKEN=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

/**
 * Validate CSRF token from form data against cookie.
 */
export function validateCSRFToken(formData: FormData, request: Request): string {
  const formToken = formData.get("csrf_token");
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookieToken = parseCookie(cookieHeader, "__Host-CSRF_TOKEN");

  if (!formToken || !cookieToken || formToken !== cookieToken) {
    throw new OAuthError("invalid_request", "CSRF validation failed", 403);
  }

  return `__Host-CSRF_TOKEN=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Store OAuth request info in KV, return a state token.
 */
export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  await kv.put(
    `oauth_state:${stateToken}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 }
  );
  return { stateToken };
}

/**
 * Bind state token to session cookie for defense-in-depth.
 */
export async function bindStateToSession(
  stateToken: string
): Promise<{ setCookie: string }> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(stateToken));
  const digest = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const setCookie = `__Host-CONSENTED_STATE=${digest}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return { setCookie };
}

/**
 * Validate OAuth state from callback: check KV + session cookie.
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string }> {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");

  if (!stateToken) {
    throw new OAuthError("invalid_request", "Missing state parameter");
  }

  // Retrieve from KV
  const stored = await kv.get(`oauth_state:${stateToken}`);
  if (!stored) {
    throw new OAuthError("invalid_request", "Invalid or expired state");
  }

  // Verify session binding
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionDigest = parseCookie(cookieHeader, "__Host-CONSENTED_STATE");

  if (sessionDigest) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(stateToken));
    const expectedDigest = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (sessionDigest !== expectedDigest) {
      throw new OAuthError("invalid_request", "State/session mismatch - possible CSRF");
    }
  }

  // Delete from KV (one-time use)
  await kv.delete(`oauth_state:${stateToken}`);

  const oauthReqInfo = JSON.parse(stored) as AuthRequest;
  const clearCookie = `__Host-CONSENTED_STATE=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

  return { oauthReqInfo, clearCookie };
}

/**
 * Check if a client is already approved (skip approval dialog).
 */
export async function isClientApproved(
  request: Request,
  clientId: string,
  encryptionKey: string
): Promise<boolean> {
  const cookieHeader = request.headers.get("Cookie") || "";
  const approvedCookie = parseCookie(cookieHeader, "__Host-APPROVED_CLIENTS");
  if (!approvedCookie) return false;

  try {
    const data = await verifySignedCookie(approvedCookie, encryptionKey);
    const clients = JSON.parse(data) as string[];
    return clients.includes(clientId);
  } catch {
    return false;
  }
}

// ─── Known Redirect Hosts (consent-phishing UX only) ─────────────
//
// This list is display-only. It is NOT a security boundary: DCR stays
// open (the MCP spec requires it, and Claude.ai/ChatGPT/Claude Code/Cursor
// all self-register with no allowlist), and @cloudflare/workers-oauth-provider
// already validates redirect_uri against the client's own registered URIs
// regardless of what's below.
//
// The only purpose of this list is to decide whether the /authorize approval
// page shows a "Verified" badge or an "Unverified" warning next to the
// client name, so a client that registers itself as "Claude" with an
// evil.com callback looks visibly different from the real thing. Adding a
// host here only removes the warning banner for it — never gate any
// functionality on membership in this set.
const KNOWN_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
]);

// Loopback callbacks (CLI/desktop clients like Claude Code, Cursor, and
// other local MCP clients bind an ephemeral port on localhost for the OAuth
// redirect) are always "known" regardless of port.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function isKnownRedirectHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || KNOWN_REDIRECT_HOSTS.has(hostname.toLowerCase());
}

/**
 * Parse a redirect_uri for display on the approval page: the hostname to
 * show the user, plus the port when it's a loopback address (the port is
 * the only thing distinguishing one local CLI tool's callback from
 * another). Falls back to showing the raw string if the URI doesn't parse.
 */
export function describeRedirectDestination(redirectUri: string): { host: string; known: boolean } {
  try {
    const url = new URL(redirectUri);
    const loopback = isLoopbackHost(url.hostname);
    const host = loopback && url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return { host, known: isKnownRedirectHost(url.hostname) };
  } catch {
    return { host: redirectUri, known: false };
  }
}

// ─── Registered-Client TTL (DCR spam control) ────────────────────

/**
 * Make a freshly-registered client permanent by re-storing its KV record
 * without an expiration. Call this once a client actually completes the
 * OAuth flow (see auth-handler.ts's /callback).
 *
 * New client records are given a short TTL at registration time (see
 * index.ts's POST /register wrapper) so clients that never come back to
 * finish authorizing — registration spam/scanners — expire on their own.
 * A `put` with no `expirationTtl` fully replaces the KV entry including any
 * previously-set TTL, so this is safe to call on every successful callback,
 * including for clients registered before this change (which never had a
 * TTL to begin with — this is a harmless no-op re-put for them).
 */
export async function persistApprovedClient(clientId: string, kv: KVNamespace): Promise<void> {
  const key = `client:${clientId}`;
  const raw = await kv.get(key);
  if (!raw) return;
  await kv.put(key, raw);
}

/**
 * Add a client to the approved list.
 */
export async function addApprovedClient(
  request: Request,
  clientId: string,
  encryptionKey: string
): Promise<string> {
  let clients: string[] = [];

  const cookieHeader = request.headers.get("Cookie") || "";
  const approvedCookie = parseCookie(cookieHeader, "__Host-APPROVED_CLIENTS");

  if (approvedCookie) {
    try {
      const data = await verifySignedCookie(approvedCookie, encryptionKey);
      clients = JSON.parse(data) as string[];
    } catch {
      clients = [];
    }
  }

  if (!clients.includes(clientId)) {
    clients.push(clientId);
  }

  const signed = await signCookie(JSON.stringify(clients), encryptionKey);
  return `__Host-APPROVED_CLIENTS=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
}

// ─── Cookie Helpers ──────────────────────────────────────────────

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function signCookie(data: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return btoa(JSON.stringify({ d: data, s: sigHex }));
}

async function verifySignedCookie(cookie: string, key: string): Promise<string> {
  const { d: data, s: sigHex } = JSON.parse(atob(cookie)) as {
    d: string;
    s: string;
  };

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signature = new Uint8Array(
    sigHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    signature,
    encoder.encode(data)
  );

  if (!valid) throw new Error("Invalid cookie signature");
  return data;
}
