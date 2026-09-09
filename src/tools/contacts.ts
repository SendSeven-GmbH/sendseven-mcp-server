/**
 * Contact Management Tools
 *
 * Tools for searching and managing contacts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapStructured, wrapError } from "./helpers.js";

export function registerContactTools(server: McpServer, ctx: ToolContext): void {
  if (hasAnyScope(ctx.scopes, ["contacts:read"])) {
    server.registerTool(
      "search_contacts",
      {
        description: `Search contacts by name, phone number, or email, and/or filter by tag membership. Returns matching contacts with their available channels, tags, and full contact_methods list (each with its own id, type, value, and is_primary flag).

\`query\` is free-text over name/email/phone/contact-id only — it does NOT match by tag name. To find contacts carrying a specific tag, use \`tag_id\` instead: call list_tags first to get the tag's id, then pass that id here. If both \`query\` and \`tag_id\` are given, the text search applies within the set of contacts carrying the tag(s); multiple tag_ids match contacts with ANY of them (OR).

Examples:
- "Find all VIP customers" → look up the "VIP" tag via list_tags, then tag_id=<that tag's id>
- "Look up +49 170 1234567" → query="+49170123456"
- "Find contacts named Schmidt" → query="Schmidt"
- "Find contacts named Schmidt who are also VIP" → query="Schmidt", tag_id=<VIP tag id>`,
        inputSchema: {
          query: z.string().optional().describe("Search by name, phone number, or email address. Does NOT match tag names - use tag_id for that."),
          tag_id: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe("Filter to contacts carrying this tag id (or any of these tag ids). Get tag ids from list_tags - never pass a tag name here."),
          page: z.number().optional().describe("Page number (default: 1)"),
          page_size: z.number().optional().describe("Results per page (default: 10, max: 50)"),
        },
        outputSchema: {
          contacts: z.array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              phone: z.string().nullable().optional(),
              email: z.string().nullable().optional(),
              channels: z.array(z.string()),
              contact_methods: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    method_type: z.string(),
                    value: z.string(),
                    is_primary: z.boolean().optional(),
                  })
                )
                .optional(),
              tags: z.array(z.string()),
              created_at: z.string(),
            })
          ),
          total: z.number(),
          page: z.number(),
          total_pages: z.number(),
          hint: z.string().optional(),
        },
        annotations: { title: "Search Contacts", readOnlyHint: true, destructiveHint: false },
      },
      async (params) => {
        if (!params.query && !params.tag_id) {
          return wrapError({
            error: {
              code: "missing_filter",
              message: "Provide at least one of query or tag_id.",
              recoverable: true,
              suggestion: "Pass a text query (name/phone/email), a tag_id (from list_tags), or both.",
            },
          });
        }

        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.searchContacts({
            search: params.query,
            tag_id: params.tag_id === undefined ? undefined : ([] as string[]).concat(params.tag_id),
            page: params.page ?? 1,
            page_size: params.page_size ?? 10,
          });

          const contacts = result.items.map((c) => {
            // Platform identifiers now live in contact_methods[]; phone/email
            // remain denormalized on the contact itself.
            const methodTypes = new Set((c.contact_methods ?? []).map((m) => m.method_type));
            const channels = [
              methodTypes.has("whatsapp_id") ? "whatsapp" : null,
              methodTypes.has("telegram_id") ? "telegram" : null,
              methodTypes.has("messenger_id") ? "messenger" : null,
              methodTypes.has("instagram_id") ? "instagram" : null,
              c.phone || methodTypes.has("phone") ? "sms" : null,
              c.email || methodTypes.has("email") ? "email" : null,
            ].filter(Boolean);
            return {
              id: c.id,
              name: c.name || undefined,
              phone: c.phone,
              email: c.email,
              channels,
              contact_methods: c.contact_methods?.length
                ? c.contact_methods.map((m) => ({
                    id: m.id,
                    method_type: m.method_type,
                    value: m.value,
                    is_primary: m.is_primary,
                  }))
                : undefined,
              tags: c.tags?.map((t) => t.name) || [],
              created_at: c.created_at,
            };
          });

          return wrapStructured({
            contacts,
            total: result.pagination.total,
            page: result.pagination.page,
            total_pages: result.pagination.total_pages,
            hint: result.pagination.total > result.pagination.page * result.pagination.page_size
              ? `Showing ${contacts.length} of ${result.pagination.total}. Use page=${result.pagination.page + 1} for more.`
              : "Each contact's contact_methods[] includes each method's own id, useful for targeting a specific method (e.g. setting it primary) in the SendSeven dashboard.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasAnyScope(ctx.scopes, ["contacts:create"])) {
    server.tool(
      "create_contact",
      `Create a new contact. Provide at least one identifier (name, phone, or email). The contact can then be messaged on any available channel.

Examples:
- "Add contact Lisa Mueller, +49 170 5551234, lisa@example.com"
- "Create a contact for +49 160 9876543"`,
      {
        name: z.string().optional().describe("Contact's full name"),
        phone: z.string().optional().describe("Phone number in international format (e.g., +49170123456)"),
        email: z.string().optional().describe("Email address"),
      },
      { title: "Create Contact", readOnlyHint: false, destructiveHint: false },
      async (params) => {
        if (!params.phone && !params.email && !params.name) {
          return wrapError({
            error: {
              code: "missing_identifier",
              message: "At least one of name, phone, or email is required.",
              recoverable: true,
              suggestion: "Provide a phone number, email address, or name for the contact.",
            },
          });
        }

        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const contact = await client.createContact({
            name: params.name,
            phone: params.phone,
            email: params.email,
          });

          return wrapResult({
            success: true,
            contact_id: contact.id,
            name: contact.name || undefined,
            phone: contact.phone,
            email: contact.email,
            message: "Contact created successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasAnyScope(ctx.scopes, ["contacts:update"])) {
    server.tool(
      "update_contact",
      `Update an existing contact. Only the fields you provide are changed. Use search_contacts first to find the contact ID.

Examples:
- "Update Lisa's phone number to +49 170 9999999"
- "Set the contact's email to new@example.com"
- "The contact speaks German and English" → languages="de,en"`,
      {
        contact_id: z.string().describe("The contact ID to update"),
        name: z.string().optional().describe("Full name"),
        phone: z.string().optional().describe("Phone number in international E.164 format (e.g., +49170123456)"),
        email: z.string().optional().describe("Email address"),
        languages: z.string().optional().describe("Comma-separated ISO 639-1 language codes the contact speaks (e.g., 'en,de')"),
        birthday: z.string().optional().describe("Date of birth (YYYY-MM-DD)"),
      },
      { title: "Update Contact", readOnlyHint: false, destructiveHint: false },
      async (params) => {
        const { contact_id, ...fields } = params;
        if (Object.values(fields).every((v) => v === undefined)) {
          return wrapError({
            error: {
              code: "no_fields",
              message: "Provide at least one field to update.",
              recoverable: true,
              suggestion: "Pass name, phone, email, languages, or birthday.",
            },
          });
        }

        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const contact = await client.updateContact(contact_id, fields);
          return wrapResult({
            success: true,
            contact_id: contact.id,
            name: contact.name || undefined,
            phone: contact.phone,
            email: contact.email,
            message: "Contact updated successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }
}
