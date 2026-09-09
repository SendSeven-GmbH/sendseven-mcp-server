/**
 * SendSeven OAuth Handler
 *
 * Hono-based handler for the OAuth 2.0 Authorization Code + PKCE flow
 * with SendSeven as the upstream OAuth provider.
 *
 * Flow:
 * 1. MCP client initiates OAuth with our server
 * 2. /authorize → redirect to SendSeven consent screen
 * 3. User approves on SendSeven
 * 4. /callback → exchange code for tokens, extract user info
 * 5. OAuthProvider issues its own tokens to the MCP client
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env, Props } from "./config.js";
import { SKILL_GROUPS, scopesForSkills } from "./config.js";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils.js";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// ─── Authorization Endpoint ─────────────────────────────────────

app.get("/authorize", async (c) => {
  try {
    // parseAuthRequest THROWS a plain Error when the client_id is not
    // registered with this provider ("Invalid client...") or the redirect_uri
    // does not match. Without this try/catch that surfaced as an opaque
    // Cloudflare "Internal Server Error" (500). Per RFC 6749 §4.1.2.1 an
    // unknown client / bad redirect_uri must NOT redirect — return 400.
    let oauthReqInfo;
    try {
      oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (parseError: unknown) {
      const msg = parseError instanceof Error ? parseError.message : "Invalid authorization request";
      console.error("authorize: parseAuthRequest failed:", msg);
      // Clients that receive invalid_client are expected to re-run dynamic
      // client registration (/register) and retry with a fresh client_id.
      return c.text(
        `Invalid authorization request: ${msg}\n\n` +
          "If you configured this connection with a fixed client_id, remove it " +
          "and let the client register automatically (this server supports " +
          "OAuth Dynamic Client Registration).",
        400
      );
    }

    const { clientId } = oauthReqInfo;

    if (!clientId) {
      return c.text("Invalid request", 400);
    }

    // If client is already approved, skip the dialog
    if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
      const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
      const { setCookie: sessionCookie } = await bindStateToSession(stateToken);
      // Already-approved clients get all default skills
      const defaultScopes = scopesForSkills(SKILL_GROUPS.filter(g => g.default).map(g => g.id));
      return redirectToSendSeven(c.req.raw, stateToken, c.env, { "Set-Cookie": sessionCookie }, defaultScopes);
    }

    // Show approval dialog for first-time connections
    const { token: csrfToken, setCookie } = generateCSRFProtection();
    const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId);

    const clientRecord = client as Record<string, unknown> | null;
    const clientName = String(clientRecord?.clientName ?? clientRecord?.name ?? "AI Assistant");

    return renderApprovalPage(c.req.raw, {
      csrfToken,
      clientName,
      setCookie,
      state: { oauthReqInfo },
    });
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("authorize (GET) failed:", msg);
    return c.text(`Internal server error: ${msg}`, 500);
  }
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }

    // Extract selected skills and compute scopes
    const selectedSkills = formData.getAll("skills").map(String);
    const computedScopes = scopesForSkills(selectedSkills);

    const approvedCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedCookie);
    headers.append("Set-Cookie", sessionCookie);

    // Redirect to SendSeven with only the computed scopes
    return redirectToSendSeven(c.req.raw, stateToken, c.env, Object.fromEntries(headers), computedScopes);
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    const msg = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Internal server error: ${msg}`, 500);
  }
});

// ─── OAuth Callback ─────────────────────────────────────────────

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  // Check for errors from SendSeven
  const errorParam = c.req.query("error");
  if (errorParam) {
    const errorDesc = c.req.query("error_description") || errorParam;
    return c.text(`Authorization denied: ${errorDesc}`, 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  // Exchange authorization code for tokens with SendSeven
  const authUrl = c.env.SENDSEVEN_AUTH_URL.replace(/\/+$/, "");
  const callbackUrl = new URL("/callback", c.req.url).href;

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: c.env.SENDSEVEN_OAUTH_CLIENT_ID,
    client_secret: c.env.SENDSEVEN_OAUTH_CLIENT_SECRET,
    redirect_uri: callbackUrl,
  });

  const tokenResponse = await fetch(`${authUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error("Token exchange failed:", tokenResponse.status, errText);
    return c.text("Authentication failed: token exchange error", 500);
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token?: string;
  };

  // Decode JWT access token to get user info
  const claims = decodeJwtPayload(tokens.access_token);
  const userId = (claims.sub as string) || "";
  const tenantId = (claims.tenant_id as string) || "";
  const email = (claims.email as string) || "";
  const scopes = (tokens.scope || "").split(" ").filter(Boolean);

  // Compute token expiry from JWT 'exp' claim, or default to 1 hour
  const tokenExpiresAt = typeof claims.exp === "number"
    ? claims.exp
    : Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

  // Complete the OAuth flow - OAuthProvider issues its own tokens
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId,
    metadata: {
      label: email || userId,
    },
    scope: oauthReqInfo.scope,
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt,
      tenantId,
      userId,
      email,
      scopes,
    } as Props,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearCookie) {
    headers.set("Set-Cookie", clearCookie);
  }

  return new Response(null, { status: 302, headers });
});

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Redirect to SendSeven's frontend consent page.
 *
 * Goes directly to app.sendseven.com/oauth/consent (like Zapier does),
 * NOT through api.sendseven.com/api/v1/oauth-apps/authorize.
 * The frontend handles auth and displays the consent screen.
 */
function redirectToSendSeven(
  request: Request,
  stateToken: string,
  workerEnv: Env,
  headers: Record<string, string> = {},
  scopes?: string[]
): Response {
  const consentUrl = workerEnv.SENDSEVEN_CONSENT_URL.replace(/\/+$/, "");
  const callbackUrl = new URL("/callback", request.url).href;

  const url = new URL(consentUrl);
  url.searchParams.set("client_id", workerEnv.SENDSEVEN_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (scopes || scopesForSkills(SKILL_GROUPS.filter(g => g.default).map(g => g.id))).join(" "));
  url.searchParams.set("state", stateToken);

  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: url.toString() },
  });
}

/**
 * Decode JWT payload without verification (server-side only).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * SVG icons matching Lucide icon set (same as the consent screen uses).
 * Each returns a 20x20 SVG string.
 */
const SVG_ICONS: Record<string, string> = {
  "message-square": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  "send": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  "mail": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  "users": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  "megaphone": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
  "book-open": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  "bar-chart-2": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  "webhook": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/></svg>',
};

/**
 * Render an interactive skill picker for first-time connections.
 * Visual style matches the SendSeven OAuth consent screen (OAuthConsent.tsx).
 */
function renderApprovalPage(
  _request: Request,
  opts: {
    csrfToken: string;
    clientName: string;
    setCookie: string;
    state: { oauthReqInfo: AuthRequest };
  }
): Response {
  const encodedState = btoa(JSON.stringify(opts.state));

  const skillCheckboxes = SKILL_GROUPS.map((group) => `
    <label class="skill-row${group.default ? " checked" : ""}">
      <input type="checkbox" name="skills" value="${group.id}" ${group.default ? "checked" : ""}>
      <span class="skill-icon">${SVG_ICONS[group.icon] || ""}</span>
      <div class="skill-info">
        <span class="skill-label">${sanitize(group.label)}</span>
        <span class="skill-desc">${sanitize(group.description)}</span>
      </div>
      <span class="checkbox"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
    </label>
  `).join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to SendSeven</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0; padding: 1rem;
      background: linear-gradient(135deg, #eff6ff 0%, #e0e7ff 100%);
    }
    .card {
      background: white; border-radius: 12px;
      max-width: 460px; width: 100%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1), 0 4px 20px rgba(0,0,0,0.06);
      overflow: hidden;
    }
    .card-header {
      padding: 1.5rem 1.5rem 0;
      text-align: center;
    }
    .logo {
      width: 48px; height: 48px; margin: 0 auto 1rem;
      background: #E63946; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
    }
    .logo svg { color: white; }
    .card-title {
      font-size: 1.125rem; font-weight: 600; color: #0f172a;
      margin: 0 0 0.375rem;
    }
    .card-subtitle {
      font-size: 0.875rem; color: #64748b; line-height: 1.4;
      margin: 0 0 1.25rem;
    }
    .card-subtitle strong { color: #0f172a; }
    .card-body { padding: 0 1.5rem 1.5rem; }
    .separator {
      height: 1px; background: #e2e8f0; margin: 0 0 1rem;
    }
    .section-label {
      font-size: 0.75rem; font-weight: 500; color: #64748b;
      text-transform: uppercase; letter-spacing: 0.05em;
      margin: 0 0 0.625rem;
    }
    .skills { display: flex; flex-direction: column; gap: 0.375rem; margin-bottom: 1rem; }
    .skill-row {
      display: flex; align-items: center; gap: 0.625rem;
      padding: 0.625rem 0.75rem; border: 1px solid #e2e8f0;
      border-radius: 8px; cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      user-select: none;
    }
    .skill-row:hover { border-color: #94a3b8; }
    .skill-row.checked { border-color: #3B82F6; background: #f8fafc; }
    .skill-row input { display: none; }
    .skill-icon {
      flex-shrink: 0; width: 2rem; height: 2rem;
      display: flex; align-items: center; justify-content: center;
      color: #64748b; border-radius: 6px; background: #f1f5f9;
    }
    .skill-row.checked .skill-icon { color: #3B82F6; background: #eff6ff; }
    .skill-info { flex: 1; min-width: 0; }
    .skill-label {
      display: block; font-size: 0.8125rem; font-weight: 500; color: #0f172a;
    }
    .skill-desc {
      display: block; font-size: 0.6875rem; color: #94a3b8;
      line-height: 1.3; margin-top: 0.0625rem;
    }
    .checkbox {
      width: 1.125rem; height: 1.125rem; flex-shrink: 0;
      border: 1.5px solid #cbd5e1; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s; color: transparent;
    }
    .skill-row.checked .checkbox {
      background: #3B82F6; border-color: #3B82F6; color: white;
    }
    .error-msg {
      color: #dc2626; font-size: 0.75rem; margin: 0.375rem 0 0;
      display: none;
    }
    .btn-primary {
      display: flex; align-items: center; justify-content: center; gap: 0.375rem;
      background: #3B82F6; color: white; border: none;
      padding: 0.625rem 1.5rem; border-radius: 8px;
      font-size: 0.875rem; font-weight: 500;
      cursor: pointer; width: 100%; transition: background 0.15s;
    }
    .btn-primary:hover { background: #2563eb; }
    .btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
    .btn-outline {
      display: flex; align-items: center; justify-content: center; gap: 0.375rem;
      background: transparent; color: #64748b;
      border: 1px solid #e2e8f0;
      padding: 0.5rem 1.5rem; border-radius: 8px;
      font-size: 0.8125rem; cursor: pointer;
      width: 100%; margin-top: 0.5rem; transition: background 0.15s;
    }
    .btn-outline:hover { background: #f8fafc; }
    .footer-note {
      text-align: center; margin-top: 0.75rem;
      font-size: 0.6875rem; color: #94a3b8; line-height: 1.4;
    }
    .footer-note a { color: #64748b; text-decoration: none; }
    .footer-note a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="logo">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
      </div>
      <h1 class="card-title">Connect to SendSeven</h1>
      <p class="card-subtitle"><strong>${sanitize(opts.clientName)}</strong> is requesting access to your SendSeven account.</p>
    </div>
    <div class="card-body">
      <div class="separator"></div>
      <div class="section-label">Select capabilities</div>
      <form method="POST" action="/authorize" id="approveForm">
        <input type="hidden" name="csrf_token" value="${opts.csrfToken}">
        <input type="hidden" name="state" value="${sanitize(encodedState)}">
        <div class="skills">${skillCheckboxes}</div>
        <p class="error-msg" id="errorMsg">Please select at least one capability.</p>
        <button type="submit" class="btn-primary" id="connectBtn">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span id="connectText">Authorize</span>
        </button>
      </form>
      <button class="btn-outline" onclick="window.close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Deny
      </button>
      <p class="footer-note">
        You can revoke access at any time from your <a href="https://app.sendseven.com/settings" target="_blank">account settings</a>.
      </p>
    </div>
  </div>
  <script>
    document.querySelectorAll('.skill-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.tagName === 'A') return;
        var cb = row.querySelector('input[type=checkbox]');
        cb.checked = !cb.checked;
        row.classList.toggle('checked', cb.checked);
        updateBtn();
      });
    });
    function updateBtn() {
      var n = document.querySelectorAll('input[name=skills]:checked').length;
      document.getElementById('connectBtn').disabled = n === 0;
      document.getElementById('errorMsg').style.display = n === 0 ? 'block' : 'none';
      document.getElementById('connectText').textContent = n > 0 ? 'Authorize (' + n + ')' : 'Authorize';
    }
    document.getElementById('approveForm').addEventListener('submit', function(e) {
      if (document.querySelectorAll('input[name=skills]:checked').length === 0) {
        e.preventDefault(); updateBtn();
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Set-Cookie": opts.setCookie,
    },
  });
}

function sanitize(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { app as SendSevenHandler };
