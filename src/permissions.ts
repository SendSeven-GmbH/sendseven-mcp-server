/**
 * Permission helpers: tell the user (and the LLM) WHY something is not possible.
 *
 *  - parseRequiredScopes(): reads the scope(s) a denied 403 needed.
 *  - capabilitiesForScopes(): maps scopes to the consent-group labels the user
 *    has to approve when reconnecting.
 *  - buildPermissionReport(): granted vs missing capability groups for the
 *    always-registered `check_permissions` tool.
 */

import { SKILL_GROUPS } from "./config.js";

const SCOPE_RE = /^[a-z_*]+:[a-z_*]+$/;

/** Same matching rules as hasAnyScope() in tools/helpers.ts for a single scope. */
export function scopeGranted(granted: string[], scope: string): boolean {
  if (granted.includes("*:*") || granted.includes(scope)) return true;
  const [resource] = scope.split(":");
  return granted.includes(`${resource}:*`);
}

/**
 * Extract required scopes from a 403 body. Understands the structured forms
 * (`required_scopes` / `missing_scopes` arrays, e.g. agent_publish_not_allowed,
 * missing_scope, insufficient_scope) and the plain string
 * "Missing required permission(s): a:b, c:d" used by require_scope().
 */
export function parseRequiredScopes(detail: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && SCOPE_RE.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  };
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    for (const key of ["required_scopes", "missing_scopes"]) {
      const arr = d[key];
      if (Array.isArray(arr)) arr.forEach(add);
    }
    if (out.length === 0 && typeof d.message === "string") return parseRequiredScopes(d.message);
    if (out.length === 0 && typeof d.error === "string") return parseRequiredScopes(d.error);
    return out;
  }
  if (typeof detail === "string") {
    const m = detail.match(/(?:Missing required permission\(s\)|requires the)\s*:?\s*([^()\n]*?)(?:\s+scope)?\.?\s*$/i);
    if (m) m[1].split(/[,\s]+/).forEach(add);
  }
  return out;
}

/** Consent-group labels that contain any of the scopes (primary capability first). */
export function capabilitiesForScopes(scopes: string[]): string[] {
  const labels: string[] = [];
  for (const group of SKILL_GROUPS) {
    if (scopes.some((s) => (group.scopes as readonly string[]).includes(s)) && !labels.includes(group.label)) {
      labels.push(group.label);
    }
  }
  return labels;
}

export interface CapabilityStatus {
  id: string;
  capability: string;
  description: string;
  status: "granted" | "partial" | "missing";
  missing_scopes: string[];
}

export function buildPermissionReport(granted: string[]): {
  capabilities: CapabilityStatus[];
  missing_capabilities: string[];
  all_granted: boolean;
  how_to_get_missing: string | null;
} {
  const capabilities: CapabilityStatus[] = SKILL_GROUPS.map((g) => {
    const missing = (g.scopes as readonly string[]).filter((s) => !scopeGranted(granted, s));
    const status: CapabilityStatus["status"] =
      missing.length === 0 ? "granted" : missing.length === g.scopes.length ? "missing" : "partial";
    return { id: g.id, capability: g.label, description: g.description, status, missing_scopes: missing };
  });
  const missingCaps = capabilities.filter((c) => c.status !== "granted").map((c) => c.capability);
  return {
    capabilities,
    missing_capabilities: missingCaps,
    all_granted: missingCaps.length === 0,
    how_to_get_missing: missingCaps.length
      ? `Reconnect SendSeven in your AI client (remove and re-add the connector) and approve: ${missingCaps.join(", ")}. A permission your SendSeven user role does not allow cannot be granted this way; a workspace admin has to grant it.`
      : null,
  };
}
