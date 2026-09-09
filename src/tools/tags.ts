/**
 * Tag Management Tools
 *
 * Tools for creating tags and managing tag assignments on conversations and contacts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  const hasTagRead = hasAnyScope(ctx.scopes, ["contacts:read", "conversations:read"]);
  const hasTagWrite = hasAnyScope(ctx.scopes, ["contacts:update", "conversations:update"]);
  const hasConvUpdate = hasAnyScope(ctx.scopes, ["conversations:update"]);
  const hasContactUpdate = hasAnyScope(ctx.scopes, ["contacts:update"]);

  if (hasTagRead) {
    server.tool(
      "list_tags",
      `List all tags in your workspace. Tags are color-coded labels you can apply to conversations and contacts for organization and filtering.

Examples:
- "Show all tags" → list_tags()
- "Search for VIP tag" → search="VIP"`,
      {
        search: z.string().optional().describe("Filter tags by name"),
        page: z.number().optional().describe("Page number (default: 1)"),
        page_size: z.number().optional().describe("Results per page (default: 50)"),
      },
      { title: "List Tags", readOnlyHint: true, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.listTags({
            search: params.search,
            page: params.page ?? 1,
            page_size: params.page_size ?? 50,
          });

          const tags = result.items.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            created_at: t.created_at,
          }));

          return wrapResult({
            tags,
            total: result.pagination.total,
            page: result.pagination.page,
            total_pages: result.pagination.total_pages,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasTagWrite) {
    server.tool(
      "create_tag",
      `Create a new tag. Tags can be applied to conversations and contacts for organization.

Examples:
- "Create a VIP tag in red" → name="VIP", color="#EF4444"
- "Add an Urgent tag" → name="Urgent"`,
      {
        name: z.string().describe("Tag name (max 50 characters)"),
        color: z.string().optional().describe("Hex color code (e.g., #EF4444)"),
        description: z.string().optional().describe("Tag description (max 255 characters)"),
      },
      { title: "Create Tag", readOnlyHint: false, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const tag = await client.createTag({
            name: params.name,
            color: params.color,
            description: params.description,
          });

          return wrapResult({
            success: true,
            tag_id: tag.id,
            name: tag.name,
            color: tag.color,
            message: `Tag "${tag.name}" created successfully.`,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasConvUpdate) {
    server.tool(
      "tag_conversation",
      "Add a tag to a conversation. Use list_tags first to find available tag IDs.",
      {
        conversation_id: z.string().describe("The conversation ID"),
        tag_id: z.string().describe("The tag ID to add"),
      },
      { title: "Tag Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, tag_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          await client.addTagToConversation(conversation_id, tag_id);
          return wrapResult({
            success: true,
            message: "Tag added to conversation successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "untag_conversation",
      "Remove a tag from a conversation.",
      {
        conversation_id: z.string().describe("The conversation ID"),
        tag_id: z.string().describe("The tag ID to remove"),
      },
      { title: "Untag Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, tag_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          await client.removeTagFromConversation(conversation_id, tag_id);
          return wrapResult({
            success: true,
            message: "Tag removed from conversation successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasContactUpdate) {
    server.tool(
      "tag_contact",
      "Add a tag to a contact. Use list_tags first to find available tag IDs.",
      {
        contact_id: z.string().describe("The contact ID"),
        tag_id: z.string().describe("The tag ID to add"),
      },
      { title: "Tag Contact", readOnlyHint: false, destructiveHint: false },
      async ({ contact_id, tag_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          await client.addTagToContact(contact_id, tag_id);
          return wrapResult({
            success: true,
            message: "Tag added to contact successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "untag_contact",
      "Remove a tag from a contact.",
      {
        contact_id: z.string().describe("The contact ID"),
        tag_id: z.string().describe("The tag ID to remove"),
      },
      { title: "Untag Contact", readOnlyHint: false, destructiveHint: false },
      async ({ contact_id, tag_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          await client.removeTagFromContact(contact_id, tag_id);
          return wrapResult({
            success: true,
            message: "Tag removed from contact successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }
}
