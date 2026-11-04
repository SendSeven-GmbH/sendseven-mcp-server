/**
 * Privacy-preserving tool-usage analytics (Cloudflare Workers Analytics Engine).
 *
 * Every tool is covered automatically: `instrumentServer()` wraps
 * `server.tool()` / `server.registerTool()` BEFORE the tool modules register,
 * so a new tool needs no extra code.
 *
 * PRIVACY CONTRACT (the CTO is also the DPO): we record ONLY metadata about the
 * call, never what was in it.
 *   recorded:  tool name, tenant id, opaque user id, MCP client name (as sent in
 *              the MCP `initialize` clientInfo, e.g. "claude-ai"), outcome,
 *              error code, latency, server version.
 *   NEVER:     tool arguments, tool results, message text, contact data, tokens,
 *              error messages (only the short machine error code).
 *
 * A failure to record must never affect the tool call: the data point write is
 * synchronous fire-and-forget and everything is wrapped in try/catch. With no
 * `ANALYTICS` binding (local dev, tests, before setup) this is a no-op.
 *
 * Data point layout (keep in sync with scripts/usage-report.mjs):
 *   index1  = tenant id
 *   blob1   = tool name
 *   blob2   = tenant id
 *   blob3   = MCP client name (clientInfo.name, truncated) or "unknown"
 *   blob4   = outcome: "ok" | "error"
 *   blob5   = error class ("" when ok): API error code (e.g. "forbidden",
 *             "not_found", "validation_error", "http_500") or "exception"
 *   blob6   = server version
 *   blob7   = user id (opaque UUID, for distinct-user counts)
 *   double1 = latency in ms
 *   double2 = 1 (call count; use SUM(_sample_interval * double2))
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SERVER_VERSION } from "./version.js";

export interface AnalyticsContext {
  dataset?: AnalyticsEngineDataset;
  tenantId: string;
  userId: string;
}

const MAX_BLOB = 64;
const ERROR_CODE_RE = /^[a-z0-9_]{1,40}$/;

function clip(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_BLOB) : "";
}

/** Extract the short machine error code from an error result, never the message. */
export function classifyResult(result: unknown): { outcome: "ok" | "error"; errorClass: string } {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = r?.content?.[0]?.text;
  const looksLikeEnvelope = typeof text === "string" && /^\{\s*"error"\s*:/.test(text);
  if (!r?.isError && !looksLikeEnvelope) return { outcome: "ok", errorClass: "" };

  let code = "error";
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown } };
      const c = parsed?.error?.code;
      if (typeof c === "string" && ERROR_CODE_RE.test(c)) code = c;
    } catch {
      // not JSON: keep the generic class, do NOT record the text
    }
  }
  return { outcome: "error", errorClass: code };
}

function record(
  actx: AnalyticsContext,
  server: McpServer,
  tool: string,
  startedAt: number,
  outcome: "ok" | "error",
  errorClass: string
): void {
  try {
    if (!actx.dataset) return;
    let client = "unknown";
    try {
      client = clip(server.server.getClientVersion()?.name) || "unknown";
    } catch {
      // clientInfo unavailable
    }
    actx.dataset.writeDataPoint({
      indexes: [clip(actx.tenantId)],
      blobs: [tool, clip(actx.tenantId), client, outcome, errorClass, MCP_SERVER_VERSION, clip(actx.userId)],
      doubles: [Date.now() - startedAt, 1],
    });
  } catch (err) {
    // Never let analytics break a tool call. Keep the log argument-free.
    console.warn("analytics write failed:", err instanceof Error ? err.name : "unknown");
  }
}

type AnyFn = (...args: unknown[]) => unknown;

function wrapHandler(server: McpServer, actx: AnalyticsContext, tool: string, handler: AnyFn): AnyFn {
  return async function instrumented(this: unknown, ...args: unknown[]) {
    const startedAt = Date.now();
    try {
      const result = await handler.apply(this, args);
      const { outcome, errorClass } = classifyResult(result);
      record(actx, server, tool, startedAt, outcome, errorClass);
      return result;
    } catch (err) {
      record(actx, server, tool, startedAt, "error", "exception");
      throw err;
    }
  };
}

/**
 * Wrap tool registration on `server` so every tool call is recorded.
 * Call once, before any `register*Tools()`. No-op without a dataset binding.
 */
export function instrumentServer(server: McpServer, actx: AnalyticsContext): void {
  if (!actx.dataset) return;

  const originalTool = server.tool.bind(server) as unknown as (...a: unknown[]) => unknown;
  (server as unknown as { tool: unknown }).tool = (...args: unknown[]) => {
    const last = args.length - 1;
    if (typeof args[0] === "string" && typeof args[last] === "function") {
      args[last] = wrapHandler(server, actx, args[0], args[last] as AnyFn);
    }
    return originalTool(...args);
  };

  const originalRegister = server.registerTool.bind(server) as unknown as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (...args: unknown[]) => {
    if (typeof args[0] === "string" && typeof args[2] === "function") {
      args[2] = wrapHandler(server, actx, args[0], args[2] as AnyFn);
    }
    return originalRegister(...args);
  };
}
