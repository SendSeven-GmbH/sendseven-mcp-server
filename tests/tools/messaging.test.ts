/**
 * Messaging Tools Tests
 *
 * Tests the API client methods used by messaging workflows, plus a
 * handler-level test of send_message_to_contact that exercises the
 * contact_methods[]-aware resolution path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendSevenApiClient } from "../../src/api-client.js";
import { registerMessagingTools } from "../../src/tools/messaging.js";
import type { ToolContext } from "../../src/types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const client = new SendSevenApiClient("https://api.sendseven.com/api/v1", "test-token");

beforeEach(() => {
  mockFetch.mockReset();
});

describe("searchContacts", () => {
  it("should find contacts by phone number", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: "contact-1",
            // Backend uses a single `name` field; platform IDs live in contact_methods[].
            name: "John Doe",
            phone: "+491701234567",
            contact_methods: [
              { method_type: "phone", value: "+491701234567", is_primary: true },
              { method_type: "whatsapp_id", value: "491701234567", is_primary: true },
            ],
          },
        ],
        pagination: { total: 1, page: 1, page_size: 5, total_pages: 1 },
      }),
    });

    const result = await client.searchContacts({ search: "+491701234567", page_size: 5 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].phone).toBe("+491701234567");
    expect(result.items[0].contact_methods?.[1].method_type).toBe("whatsapp_id");
  });
});

describe("createContact", () => {
  it("should create contact with email", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        id: "contact-new",
        name: null,
        email: "john@example.com",
        contact_methods: [{ method_type: "email", value: "john@example.com", is_primary: true }],
      }),
    });

    const result = await client.createContact({ email: "john@example.com" });
    expect(result.id).toBe("contact-new");
    expect(result.email).toBe("john@example.com");
  });
});

describe("getContactAvailableChannels", () => {
  it("should return available channels for contact", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        contact_id: "contact-1",
        channels: [
          { channel_type: "whatsapp", channel_id: "ch-wa", channel_name: "WA", identifier: "491701234567", status: "available" },
          { channel_type: "sms", channel_id: "ch-sms", channel_name: "SMS", identifier: "+491701234567", status: "available" },
        ],
      }),
    });

    const result = await client.getContactAvailableChannels("contact-1");
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0].channel_type).toBe("whatsapp");
    expect(result.channels[0].identifier).toBe("491701234567");
  });
});

describe("initiateConversation", () => {
  it("should create conversation and send message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        conversation_id: "conv-1",
        message_id: "msg-1",
        status: "sent",
      }),
    });

    const result = await client.initiateConversation({
      contact_id: "contact-1",
      channel_id: "ch-wa",
      content: "Hello!",
    });

    expect(result.conversation_id).toBe("conv-1");
    expect(result.message_id).toBe("msg-1");
    expect(result.status).toBe("sent");
  });
});

describe("sendMessageToContact (api-client)", () => {
  it("addresses via contact_id + channel_id and does NOT send `to`", async () => {
    let sentBody: Record<string, unknown> = {};
    mockFetch.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ id: "msg-1", conversation_id: "conv-1" }) };
    });

    await client.sendMessageToContact({ contact_id: "contact-1", channel_id: "ch-tg", text: "hi" });

    expect(sentBody.contact_id).toBe("contact-1");
    expect(sentBody.channel_id).toBe("ch-tg");
    expect(sentBody.text).toBe("hi");
    expect("to" in sentBody).toBe(false); // must NOT pass `to` for known-contact sends
  });
});

/**
 * Minimal fake McpServer that captures registered tool handlers so we can
 * invoke them directly. Mirrors the McpServer.tool(name, desc, schema, [annotations,] handler)
 * signature used by the tool modules — the handler is always the last
 * argument, regardless of whether an annotations object was also passed.
 */
function makeFakeServer() {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool(name: string, ..._rest: unknown[]) {
      const handler = _rest[_rest.length - 1] as (params: Record<string, unknown>) => Promise<unknown>;
      handlers.set(name, handler);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { server: server as any, handlers };
}

describe("send_message_to_contact (tool handler)", () => {
  const ctx: ToolContext = {
    accessToken: "test-token",
    tenantId: "t1",
    userId: "u1",
    apiUrl: "https://api.sendseven.com/api/v1",
    scopes: ["messages:create"],
  };

  it("resolves a Telegram send via contact_methods[] / available-channels and omits `to`", async () => {
    const { server, handlers } = makeFakeServer();
    registerMessagingTools(server, ctx);
    const handler = handlers.get("send_message_to_contact")!;
    expect(handler).toBeTypeOf("function");

    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    mockFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, body });

      // 1) search_contacts → returns a contact with a Telegram method only
      if (url.includes("/contacts?") || url.endsWith("/contacts")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "contact-tg",
                name: "Telegram User",
                contact_methods: [
                  { method_type: "telegram_id", value: "tg-12345", is_primary: true },
                ],
              },
            ],
            pagination: { total: 1, page: 1, page_size: 5, total_pages: 1 },
          }),
        };
      }

      // 2) available-channels → Telegram resolved with identifier
      if (url.includes("/available-channels")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            contact_id: "contact-tg",
            channels: [
              { channel_type: "telegram", channel_id: "ch-tg", channel_name: "TG", identifier: "tg-12345", status: "available" },
            ],
          }),
        };
      }

      // 3) POST /messages → success
      if (url.endsWith("/messages")) {
        return { ok: true, status: 200, json: async () => ({ id: "msg-1", conversation_id: "conv-1" }) };
      }

      throw new Error(`unexpected request: ${url}`);
    });

    const result = (await handler({ to: "Telegram User", message: "hi", channel: "telegram" })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.channel_used).toBe("telegram");

    // The POST /messages body must address by contact_id + channel_id, never `to`.
    const sendReq = requests.find((r) => r.url.endsWith("/messages") && r.body);
    expect(sendReq?.body?.contact_id).toBe("contact-tg");
    expect(sendReq?.body?.channel_id).toBe("ch-tg");
    expect(sendReq?.body && "to" in sendReq.body).toBe(false);
  });
});
