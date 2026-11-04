/**
 * Regression tests for MCP tool errors found in the connector usage data
 * (list_conversations 69%, send_message_to_contact 69%, send_reply 39%, ...).
 * Drives the REAL tools through a real McpServer + SDK client, with only the
 * HTTP layer (fetch) mocked, so outputSchema validation is exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerConversationTools } from "../src/tools/conversations.js";
import { registerMessagingTools } from "../src/tools/messaging.js";
import { registerKnowledgeTools } from "../src/tools/knowledge.js";
import { SendSevenApiClient } from "../src/api-client.js";
import { SKILL_GROUPS } from "../src/config.js";
import type { ToolContext } from "../src/types.js";

const allScopes = Array.from(new Set(SKILL_GROUPS.flatMap((g) => g.scopes)));
const ctx: ToolContext = {
  accessToken: "t",
  tenantId: "tenant",
  userId: "u",
  apiUrl: "https://api.sendseven.com/api/v1",
  scopes: allScopes,
};

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;
const calls: Array<{ method: string; path: string; search: string; body?: unknown }> = [];
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function useRoutes(routes: Route[]) {
  mockFetch.mockImplementation(async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({
      method: init.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      search: url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) {
        const status = hit.status ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () => hit.body,
          text: async () => JSON.stringify(hit.body),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({ detail: "no route" }) };
  });
}

const on = (method: string, path: RegExp | string, body: unknown, status = 200): Route =>
  (url, init) => {
    const p = url.pathname.replace("/api/v1", "");
    const matches = typeof path === "string" ? p === path : path.test(p);
    return matches && (init.method ?? "GET") === method ? { status, body } : undefined;
  };

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerConversationTools(server, ctx);
  registerMessagingTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

const text = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]).text);

beforeEach(() => {
  mockFetch.mockReset();
  calls.length = 0;
});

describe("outputSchema tools tolerate null backend fields", () => {
  it("list_conversations survives channel_type=null and other nulls", async () => {
    useRoutes([
      on("GET", "/conversations", {
        items: [
          { id: "c1", status: "open", channel_type: null, contact_id: null, contact: null, assigned_user_id: null, subject: null, tags: null, created_at: "2026-01-01T00:00:00Z" },
          { id: "c2", status: "open", channel_type: "whatsapp", contact_id: "x", contact: { name: "A" }, tags: [{ id: "t", name: "VIP" }], created_at: "2026-01-01T00:00:00Z", last_customer_message_at: null },
        ],
        pagination: { total: 2, page: 1, page_size: 10, total_pages: 1 },
      }),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "list_conversations", arguments: { status: "all" } })) as { isError?: boolean; structuredContent?: { conversations: Array<{ channel: string }> } };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.conversations[0].channel).toBe("unknown");
    expect(calls[0].search).toContain("status=all");
  });

  it("get_conversation survives null external_id, attachment and email fields", async () => {
    useRoutes([
      on("GET", "/conversations/c1", { id: "c1", status: "open", channel_type: "email", contact_id: "x", contact: { id: "x", name: null }, created_at: "2026-01-01T00:00:00Z" }),
      on("GET", "/messages", {
        items: [{ id: "m1", direction: "inbound", text: "hi", status: "received", external_id: null, created_at: "2026-01-01T00:00:00Z", attachments: [{ id: "a", filename: null, content_type: null, file_size: null, url: null }] }],
        pagination: { total: 1, page: 1, page_size: 20, total_pages: 1 },
      }),
      on("GET", "/email-integrations/conversations/c1/email-thread", {
        messages: [{ id: "e1", message_id: null, direction: "inbound", from_email: null, to_emails: [{ email: "a@b.c" }], subject: null, html_body: null, text_body: "t", status: "received", created_at: "2026-01-01T00:00:00Z" }],
      }),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "get_conversation", arguments: { conversation_id: "c1" } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });

  it("query_knowledge_base survives null source fields", async () => {
    useRoutes([
      on("POST", "/knowledge-base/search", { query: "q", answer: "A", sources: [{ title: null, uri: null, excerpt: null, score: null }] }),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "query_knowledge_base", arguments: { query: "q" } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });
});

describe("send_reply", () => {
  it("still sends when GET /contacts/{id} is forbidden (no contacts:read)", async () => {
    useRoutes([
      on("GET", "/conversations/c1", { id: "c1", status: "open", channel_type: "telegram", channel_id: "ch1", contact_id: "x", contact: { name: "Eve" }, created_at: "x" }),
      on("GET", "/contacts/x", { detail: "forbidden" }, 403),
      on("POST", "/messages", { id: "m1", conversation_id: "c1" }, 201),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_reply", arguments: { conversation_id: "c1", text: "hi" } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(text(res).contact).toBe("Eve");
  });

  it("returns an actionable WhatsApp-window error code, not http_400", async () => {
    useRoutes([
      on("GET", "/conversations/c1", { id: "c1", status: "open", channel_type: "whatsapp", channel_id: "ch1", contact_id: "x", contact: { name: "Eve" }, created_at: "x" }),
      on("GET", "/contacts/x", { id: "x", name: "Eve" }),
      on("POST", "/messages", { detail: { error: "WHATSAPP_WINDOW_EXPIRED", message: "WhatsApp 24-hour messaging window has expired." } }, 400),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_reply", arguments: { conversation_id: "c1", text: "hi" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const err = text(res).error;
    expect(err.code).toBe("whatsapp_window_expired");
    expect(err.suggestion).toContain("send_whatsapp_template");
  });
});

describe("send_message_to_contact", () => {
  const sent = () => calls.filter((c) => c.method === "POST" && c.path === "/messages");

  it("does NOT create a junk contact from a bare name", async () => {
    useRoutes([on("GET", "/contacts", { items: [], pagination: { total: 0, page: 1, page_size: 5, total_pages: 0 } })]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_message_to_contact", arguments: { to: "Lisa", message: "hi" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(text(res).error.code).toBe("contact_not_found");
    expect(calls.some((c) => c.method === "POST" && c.path === "/contacts")).toBe(false);
  });

  it("searches the normalised phone and reuses the duplicate on 409 instead of failing", async () => {
    useRoutes([
      on("GET", "/contacts", { items: [], pagination: { total: 0, page: 1, page_size: 5, total_pages: 0 } }),
      on("POST", "/contacts", { detail: { detail: "duplicate_contact", duplicates: [{ id: "dup1" }] } }, 409),
      on("GET", "/contacts/dup1", { id: "dup1", name: "Dup" }),
      on("GET", "/contacts/dup1/available-channels", { channels: [{ channel_id: "ch1", channel_type: "whatsapp", channel_name: "WA", identifier: "491701234567", status: "available" }] }),
      on("POST", "/messages", { id: "m1", conversation_id: "c1" }, 201),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_message_to_contact", arguments: { to: "+49 170 123-4567", message: "hi" } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(calls[0].search).toContain(encodeURIComponent("+491701234567"));
    expect(sent()).toHaveLength(1);
  });

  it("returns whatsapp_window_expired up front (no backend send) when only a closed-window WhatsApp channel exists", async () => {
    useRoutes([
      on("GET", "/contacts", { items: [{ id: "c", name: "Eve" }], pagination: { total: 1, page: 1, page_size: 5, total_pages: 1 } }),
      on("GET", "/contacts/c/available-channels", { channels: [{ channel_id: "ch1", channel_type: "whatsapp", channel_name: "WA", identifier: "1", status: "template_required" }] }),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_message_to_contact", arguments: { to: "Eve", message: "hi" } })) as { isError?: boolean };
    expect(text(res).error.code).toBe("whatsapp_window_expired");
    expect(sent()).toHaveLength(0);
  });

  it("auto never picks email and prefers a channel that can send free-form", async () => {
    useRoutes([
      on("GET", "/contacts", { items: [{ id: "c", name: "Eve" }], pagination: { total: 1, page: 1, page_size: 5, total_pages: 1 } }),
      on("GET", "/contacts/c/available-channels", { channels: [
        { channel_id: "e", channel_type: "email", channel_name: "Mail", identifier: "a@b.c", status: "available" },
        { channel_id: "w", channel_type: "whatsapp", channel_name: "WA", identifier: "1", status: "template_required" },
        { channel_id: "t", channel_type: "telegram", channel_name: "TG", identifier: "2", status: "available" },
      ] }),
      on("POST", "/messages", { id: "m1", conversation_id: "c1" }, 201),
    ]);
    const client = await connect();
    const res = (await client.callTool({ name: "send_message_to_contact", arguments: { to: "Eve", message: "hi" } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(sent()[0].body).toMatchObject({ channel_id: "t" });
  });
});

describe("ApiClient", () => {
  it("clamps page_size to the backend maximum instead of provoking a 422", async () => {
    useRoutes([on("GET", "/tags", { items: [], pagination: { total: 0, page: 1, page_size: 100, total_pages: 0 } })]);
    await new SendSevenApiClient(ctx.apiUrl, "t").listTags({ page_size: 500 });
    expect(calls[0].search).toContain("page_size=100");
  });

  it("surfaces Meta error_code and details of a template send failure", async () => {
    useRoutes([on("POST", /whatsapp-templates/, { detail: { message: "Template paused", error_code: 132015, error_details: "Quality" } }, 400)]);
    await expect(new SendSevenApiClient(ctx.apiUrl, "t").sendWhatsAppTemplate("x", { contact_id: "c" })).rejects.toMatchObject({
      statusCode: 400,
      apiErrorCode: "whatsapp_132015",
    });
  });
});

describe("actionable auth/billing/plan errors", () => {
  const emptyConv = on("GET", "/conversations", {});
  async function errFor(status: number, body: unknown) {
    useRoutes([on("GET", "/conversations", body, status)]);
    const client = await connect();
    const res = await client.callTool({ name: "list_conversations", arguments: {} });
    return text(res).error as { code: string; suggestion: string };
  }
  void emptyConv;

  it("401 -> reauthorization_required with reconnect advice", async () => {
    const e = await errFor(401, { detail: "Could not validate credentials" });
    expect(e.code).toBe("reauthorization_required");
    expect(e.suggestion).toMatch(/Reconnect SendSeven/);
  });

  it("402 billing gate -> billing_required", async () => {
    const e = await errFor(402, { detail: { message: "Payment required", reason: "payment_failed" } });
    expect(e.code).toBe("billing_required");
    expect(e.suggestion).toMatch(/billing/i);
  });

  it("403 deactivated tenant (plain string) -> workspace_deactivated", async () => {
    const e = await errFor(403, { detail: "Access blocked for deactivated tenant" });
    expect(e.code).toBe("workspace_deactivated");
  });

  it("403 feature_disabled -> plan_upgrade_required", async () => {
    const e = await errFor(403, { detail: { code: "feature_disabled", feature: "flows" } });
    expect(e.code).toBe("plan_upgrade_required");
    expect(e.suggestion).toMatch(/plan/i);
  });

  it("plain 403 stays forbidden", async () => {
    expect((await errFor(403, { detail: "Missing scope" })).code).toBe("forbidden");
  });

  it("401 after a failed token refresh still maps to reauthorization_required", async () => {
    useRoutes([on("GET", "/conversations", { detail: "expired" }, 401)]);
    const client = new SendSevenApiClient(ctx.apiUrl, "t", async () => {
      throw new Error("Token refresh failed: 401");
    });
    await expect(client.listConversations({})).rejects.toMatchObject({ statusCode: 401 });
    try { await client.listConversations({}); } catch (e) {
      expect((e as { toMcpError(): { error: { code: string } } }).toMcpError().error.code).toBe("reauthorization_required");
    }
  });
});
