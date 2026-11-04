/**
 * Shared plumbing for the Agent Builder tools (agents, skills, knowledge,
 * custom fields, lists, flows, deployment).
 */

import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import { capabilitiesForScopes, scopeGranted } from "../permissions.js";
import type { ToolContext } from "../types.js";
import { wrapError, wrapStructured } from "./helpers.js";

export function makeClient(ctx: ToolContext): SendSevenApiClient {
  return new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher, ctx.scopes);
}

/** True when the connection holds at least one of the scopes. */
export function can(ctx: ToolContext, ...scopes: string[]): boolean {
  return scopes.some((s) => scopeGranted(ctx.scopes, s));
}

/**
 * Error result for an action the connection was not granted. The tool is
 * registered (so the LLM can explain) but refuses with a clear reconnect hint.
 */
export function permissionMissing(scopes: string[], what: string) {
  const caps = capabilitiesForScopes(scopes);
  const capText = caps.length ? `the "${caps.join('" / "')}" capability` : `the ${scopes.join(", ")} permission`;
  return wrapError({
    error: {
      code: "permission_missing",
      message: `This SendSeven connection was not granted the permission ${scopes.join(", ")} needed to ${what}${caps.length ? ` (capability: ${caps.join(", ")})` : ""}.`,
      recoverable: false,
      suggestion: `Reconnect SendSeven in your AI client (remove and re-add the connector) and approve ${capText} to use this.`,
      missing_scopes: scopes,
      capabilities: caps,
    },
  });
}

/** Plain tool-level error (not an API error). */
export function toolError(code: string, message: string, suggestion: string, extra: Record<string, unknown> = {}) {
  return wrapError({ error: { code, message, recoverable: true, suggestion, ...extra } });
}

/** Run a handler body: API errors become the shared MCP error envelope. */
export async function guard(fn: () => Promise<ReturnType<typeof wrapStructured> | ReturnType<typeof wrapError>>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiClientError) return wrapError(err.toMcpError());
    throw err;
  }
}

// ─── Loose, null-tolerant shapes ────────────────────────────────────────
// The backend returns null for many optional fields. An outputSchema that
// rejects null fails the WHOLE tool call (this bit us in production), so every
// optional output field is nullable + optional.
export const nStr = z.string().nullable().optional();
export const nNum = z.number().nullable().optional();
export const nBool = z.boolean().nullable().optional();
export const nObj = z.record(z.unknown()).nullable().optional();
export const nArr = z.array(z.unknown()).nullable().optional();

export type Json = Record<string, unknown>;

/** Replace undefined with null so structuredContent matches nullable schemas and is stable JSON. */
export function nn<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

export function asRecord(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

export function items(v: unknown): Json[] {
  const r = asRecord(v);
  const arr = Array.isArray(v) ? v : Array.isArray(r.items) ? r.items : [];
  return arr.map(asRecord);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** "Name!" -> "name" for idempotent lookups. */
export function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || "skill";
}
