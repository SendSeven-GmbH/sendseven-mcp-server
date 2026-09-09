/**
 * Tests for API client methods added in v0.2.0:
 * WhatsApp template send, snooze, internal notes, transcript email,
 * contact update, and webhook management.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendSevenApiClient, ApiClientError } from "../../src/api-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const client = new SendSevenApiClient("https://api.sendseven.com/api/v1", "test-token");

function mockJson(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("sendWhatsAppTemplate", () => {
  it("posts to /whatsapp-templates/{name}/send with recipient selectors", async () => {
    mockJson({ success: true, message_id: "m1", conversation_id: "c1" });

    const result = await client.sendWhatsAppTemplate("order_update", {
      whatsapp_id: "491701234567",
      language: "de",
      variable_values: { "1": "John", url_suffix: "track/123" },
    });

    expect(result.success).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/whatsapp-templates/order_update/send");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.whatsapp_id).toBe("491701234567");
    expect(body.language).toBe("de");
    expect(body.variable_values.url_suffix).toBe("track/123");
  });

  it("URL-encodes template names", async () => {
    mockJson({ success: true, conversation_id: "c1" });
    await client.sendWhatsAppTemplate("weird name/x", { contact_id: "ct1" });
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/whatsapp-templates/weird%20name%2Fx/send");
  });
});

describe("snoozeConversation", () => {
  it("posts snoozed_until with reopen_on_message defaulting to true", async () => {
    mockJson({ id: "conv-1", status: "open" });
    await client.snoozeConversation("conv-1", { snoozed_until: "2026-07-18T09:00:00Z" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/conversations/conv-1/snooze");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.snoozed_until).toBe("2026-07-18T09:00:00Z");
    expect(body.reopen_on_message).toBe(true);
  });

  it("unsnooze issues DELETE", async () => {
    mockJson({ id: "conv-1", status: "open" });
    await client.unsnoozeConversation("conv-1");
    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
  });
});

describe("createInternalNote", () => {
  it("posts to /messages/internal-notes", async () => {
    mockJson({ id: "note-1", conversation_id: "conv-1" });
    await client.createInternalNote({ conversation_id: "conv-1", text: "VIP customer" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/messages/internal-notes");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toBe("VIP customer");
    expect(body.mentioned_user_ids).toEqual([]);
  });
});

describe("emailConversationTranscript", () => {
  it("posts mailbox_id and to_email", async () => {
    mockJson({ success: true });
    await client.emailConversationTranscript("conv-1", {
      mailbox_id: "mb-1",
      to_email: "customer@example.com",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/conversations/conv-1/email-transcript");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.mailbox_id).toBe("mb-1");
    expect(body.to_email).toBe("customer@example.com");
  });
});

describe("updateContact", () => {
  it("PATCHes only provided fields", async () => {
    mockJson({ id: "ct-1", name: "Lisa", phone: "+491709999999" });
    await client.updateContact("ct-1", { phone: "+491709999999" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/contacts/ct-1");
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ phone: "+491709999999" });
  });
});

describe("webhooks", () => {
  it("lists webhook endpoints", async () => {
    mockJson([{ id: "wh-1", name: "n8n", url: "https://n8n.example.com/hook", subscribed_events: ["message.received"], is_active: true, is_verified: true, has_authorization_header: false, tenant_id: "t1", created_at: "2026-07-01T00:00:00Z" }]);
    const result = await client.listWebhooks();
    expect(result).toHaveLength(1);
    expect(result[0].subscribed_events).toContain("message.received");
  });

  it("creates a webhook endpoint", async () => {
    mockJson({ id: "wh-2", name: "crm", url: "https://crm.example.com/hook", subscribed_events: ["conversation.closed"] });
    const result = await client.createWebhook({
      name: "crm",
      url: "https://crm.example.com/hook",
      subscribed_events: ["conversation.closed"],
    });
    expect(result.id).toBe("wh-2");
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/webhook-endpoints");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("surfaces API errors as ApiClientError", async () => {
    mockJson({ detail: "Invalid event type" }, 422);
    await expect(
      client.createWebhook({ name: "x", url: "https://x", subscribed_events: ["bogus.event"] })
    ).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("searchContacts tag_id filter", () => {
  it("sends a repeated ?tag_id=... query param for each tag id, alongside search", async () => {
    mockJson({ items: [], pagination: { total: 0, page: 1, page_size: 10, total_pages: 0 } });

    await client.searchContacts({
      search: "Schmidt",
      tag_id: ["1c994474-dcce-4762-8f21-191d20126b06", "tag-2"],
      page: 1,
      page_size: 10,
    });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.getAll("tag_id")).toEqual([
      "1c994474-dcce-4762-8f21-191d20126b06",
      "tag-2",
    ]);
    expect(parsed.searchParams.get("search")).toBe("Schmidt");
  });

  it("omits tag_id from the query string entirely when not provided", async () => {
    mockJson({ items: [], pagination: { total: 0, page: 1, page_size: 10, total_pages: 0 } });

    await client.searchContacts({ search: "Schmidt" });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.has("tag_id")).toBe(false);
  });
});
