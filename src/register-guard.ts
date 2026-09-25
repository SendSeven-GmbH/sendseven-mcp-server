/**
 * Dynamic Client Registration (DCR) Guard
 *
 * Open DCR itself stays: the MCP spec requires it, and Claude.ai, ChatGPT,
 * Claude Code and Cursor all self-register with no Initial Access Token.
 * This module only curbs registration *spam* on POST /register:
 *
 *   1. Per-IP rate limiting, generous enough that no legitimate client
 *      ever hits it.
 *   2. A short KV TTL on freshly-registered clients, cleared once the
 *      client actually completes an authorization (see
 *      workers-oauth-utils.ts's persistApprovedClient, called from
 *      auth-handler.ts's /callback). Clients that register and never come
 *      back to finish the OAuth flow — scanners, spam — expire on their
 *      own instead of accumulating forever in OAUTH_KV.
 *
 * @cloudflare/workers-oauth-provider's OAuthProvider handles POST /register
 * itself, inside its own fetch() dispatch, before our Hono app
 * (auth-handler.ts) ever sees the request — so this can't be a Hono
 * middleware. Instead src/index.ts's default export wraps the whole
 * Worker fetch and special-cases this one route.
 */

import type { Env } from "./config.js";

/** ~10 requests/minute/IP: generous for real clients, tight enough to blunt spam. */
const REGISTER_RATE_LIMIT = { limit: 10, periodSeconds: 60 } as const;

/** Freshly-registered clients that never finish authorizing expire after this long. */
const UNUSED_CLIENT_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days

/**
 * True if this IP is still under the POST /register rate limit.
 *
 * Prefers the Workers Rate Limiting binding (`RATE_LIMITER`, configured via
 * `ratelimits` in wrangler.jsonc) since it's shared/accurate across
 * isolates. Falls back to a simple fixed-window OAUTH_KV counter when the
 * binding isn't configured (e.g. local dev, or before the binding is added
 * to wrangler.jsonc) — approximate under concurrency, but that's fine for
 * curbing spam rather than enforcing a hard security boundary.
 */
export async function isRegisterAllowed(ip: string, env: Env): Promise<boolean> {
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return success;
    } catch (err) {
      console.error("RATE_LIMITER binding call failed, falling back to KV counter:", err);
      // fall through to the KV fallback below
    }
  }
  return isRegisterAllowedByKvCounter(ip, env);
}

async function isRegisterAllowedByKvCounter(ip: string, env: Env): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / REGISTER_RATE_LIMIT.periodSeconds);
  const key = `register_rl:${ip}:${bucket}`;
  const current = parseInt((await env.OAUTH_KV.get(key)) || "0", 10);
  if (current >= REGISTER_RATE_LIMIT.limit) return false;
  // TTL a bit longer than the bucket so a clock-skewed read never resurrects
  // a stale counter into the next window.
  await env.OAUTH_KV.put(key, String(current + 1), {
    expirationTtl: REGISTER_RATE_LIMIT.periodSeconds * 2,
  });
  return true;
}

/** RFC 7591-style JSON error body, matching the shape workers-oauth-provider itself uses. */
export function registerRateLimitedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "too_many_requests",
      error_description: "Too many client registration attempts from this IP. Please try again in a minute.",
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * After a successful POST /register (201, per RFC 7591), give the new
 * client's KV record a TTL. Non-fatal on failure — the client still works,
 * it just won't auto-expire if it's abandoned.
 */
export async function applyUnusedClientTtl(response: Response, env: Env): Promise<void> {
  if (response.status !== 201) return;
  try {
    const body = (await response.clone().json()) as { client_id?: string };
    if (!body.client_id) return;
    const key = `client:${body.client_id}`;
    const raw = await env.OAUTH_KV.get(key);
    if (!raw) return;
    await env.OAUTH_KV.put(key, raw, { expirationTtl: UNUSED_CLIENT_TTL_SECONDS });
  } catch (err) {
    console.error("Failed to apply registration TTL:", err);
  }
}
