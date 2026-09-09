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
