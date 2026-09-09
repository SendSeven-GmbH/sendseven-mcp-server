/**
 * Conversation Tools Tests
 *
 * Tests the API client methods used by conversation tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendSevenApiClient, ApiClientError } from "../../src/api-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const client = new SendSevenApiClient("https://api.sendseven.com/api/v1", "test-token");

beforeEach(() => {
  mockFetch.mockReset();
});

describe("listConversations", () => {
  it("should return paginated conversations", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: "conv-1",
            status: "open",
            channel_type: "whatsapp",
            contact_id: "contact-1",
            contact: { id: "contact-1", name: "John Doe" },
            assigned_user_id: null,
            subject: "Order inquiry",
            tags: [{ id: "tag-1", name: "VIP", color: "#ff0000" }],
            created_at: "2026-02-16T09:00:00Z",
          },
        ],
        pagination: { total: 1, page: 1, page_size: 10, total_pages: 1 },
      }),
    });

    const result = await client.listConversations({ status: "open", page: 1, page_size: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("conv-1");
    expect(result.items[0].contact?.name).toBe("John Doe");
    expect(result.pagination.total).toBe(1);
  });

  it("should handle empty results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [],
        pagination: { total: 0, page: 1, page_size: 10, total_pages: 0 },
      }),
    });

    const result = await client.listConversations({});
    expect(result.items).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });
});

describe("getConversation", () => {
  it("should return conversation with messages", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "conv-1",
        status: "open",
        channel_type: "whatsapp",
        contact_id: "contact-1",
        messages: [
          { direction: "inbound", content: "Hello", created_at: "2026-02-16T10:00:00Z" },
          { direction: "outbound", content: "Hi!", created_at: "2026-02-16T10:01:00Z" },
        ],
      }),
    });

    const result = await client.getConversation("conv-1");
    expect(result.id).toBe("conv-1");
    expect(result.messages).toHaveLength(2);
  });
});

describe("closeConversation", () => {
  it("should close and return updated conversation", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "conv-1", status: "closed" }),
    });

    const result = await client.closeConversation("conv-1", { notes: "Resolved" });
    expect(result.id).toBe("conv-1");
    expect(result.status).toBe("closed");
  });
});

describe("assignConversation", () => {
  it("should assign and return updated conversation", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "conv-1", assigned_user_id: "user-789" }),
    });

    const result = await client.assignConversation("conv-1", "user-789");
    expect(result.id).toBe("conv-1");
    expect(result.assigned_user_id).toBe("user-789");
  });
});

describe("API Error Handling", () => {
  it("should throw ApiClientError on 403", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ detail: "Forbidden" }),
    });

    await expect(client.listConversations({})).rejects.toThrow(ApiClientError);
  });

  it("should include recovery hints in error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ detail: "Not found" }),
    });

    try {
      await client.getConversation("nonexistent");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.recoverable).toBe(true);
      expect(apiErr.toMcpError().error.code).toBe("not_found");
    }
  });
});
