/**
 * Authentication Utilities
 *
 * Helper functions for API token validation and scope checking.
 * The OAuth flow is handled by auth-handler.ts.
 */

import type { TokenInfo } from "./types.js";

/**
 * Check if a token is an API token (static) rather than OAuth JWT.
 */
export function isApiToken(token: string): boolean {
  return token.startsWith("s7_api_");
}

/**
 * Validate an API token by calling the SendSeven API.
 */
export async function validateApiToken(
  apiUrl: string,
  token: string
): Promise<TokenInfo> {
  const response = await fetch(`${apiUrl}/auth/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "SendSeven-MCP/1.0.0",
    },
  });

  if (!response.ok) {
    throw new Error("Invalid API token");
  }

  const data = (await response.json()) as {
    user_id: string;
    tenant_id: string;
    scopes?: string[];
  };

  return {
    accessToken: token,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    scopes: data.scopes || [],
    tenantId: data.tenant_id,
    userId: data.user_id,
  };
}

/**
 * Check if the user has a specific scope.
 */
export function hasScope(scopes: string[], scope: string): boolean {
  if (scopes.includes("*:*")) return true;
  if (scopes.includes(scope)) return true;
  const [resource] = scope.split(":");
  return scopes.includes(`${resource}:*`);
}

/**
 * Check multiple scopes (any match = authorized).
 */
export function hasAnyScope(scopes: string[], required: string[]): boolean {
  return required.some((scope) => hasScope(scopes, scope));
}
