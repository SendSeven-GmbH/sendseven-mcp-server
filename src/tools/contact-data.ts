/**
 * Contact data model tools (Agent Builder): custom fields and lists.
 * Tags reuse the existing create_tag / list_tags tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapStructured } from "./helpers.js";
import { asRecord, can, guard, items, makeClient, nArr, nStr, nn, norm, permissionMissing, str, toolError, type Json } from "./builder-common.js";

const FIELD_TYPES = ["text", "number", "boolean", "date", "datetime", "select", "multiselect", "email", "phone", "url", "location", "collection"] as const;

const fieldOut = (f: Json) => ({
  id: nn(str(f.id)),
  key: nn(str(f.key)),
  name: nn(str(f.name)),
  field_type: nn(str(f.field_type)),
  description: nn(str(f.description)),
  options: Array.isArray(f.options) ? (f.options as unknown[]) : null,
  ai_access: nn(str(f.ai_access)),
  is_active: typeof f.is_active === "boolean" ? f.is_active : null,
});

export function registerContactDataTools(server: McpServer, ctx: ToolContext): void {
  if (hasAnyScope(ctx.scopes, ["custom_fields:read", "custom_fields:create", "custom_fields:update"])) {
    server.registerTool(
      "manage_custom_fields",
      {
        description: `List, create or update contact custom fields (extra attributes on a contact, e.g. company_size, order_number). Skill goals bind collected answers to these fields by key.

action:
- list: all fields (id, key, type, options, ai_access).
- create: needs name, key (snake_case, starts with a letter, cannot change later) and field_type. IDEMPOTENT: if a field with that key already exists it is returned unchanged (already_existed=true).
- update: needs field_id (from list). Cannot change key or type.

ai_access controls whether agents may use the field: none (default), read, read_write, fill_if_empty (agent saves a value only when empty; best for goals that collect answers).
For select/multiselect give options.`,
        inputSchema: {
          action: z.enum(["list", "create", "update"]),
          field_id: z.string().optional().describe("update: field id"),
          name: z.string().optional().describe("Display name"),
          key: z.string().optional().describe("create: snake_case key"),
          field_type: z.enum(FIELD_TYPES).optional().describe("create: data type"),
          description: z.string().optional(),
          options: z.array(z.string()).optional().describe("select/multiselect options"),
          ai_access: z.enum(["none", "read", "read_write", "fill_if_empty"]).optional(),
          ai_hint: z.string().optional().describe("What the field means and how an agent should use it (max 1000 chars)"),
          include_inactive: z.boolean().optional().describe("list: include deactivated fields"),
        },
        outputSchema: {
          action: z.string(),
          fields: z.array(
            z.object({ id: nStr, key: nStr, name: nStr, field_type: nStr, description: nStr, options: nArr, ai_access: nStr, is_active: z.boolean().nullable().optional() })
          ),
          already_existed: z.boolean().nullable().optional(),
        },
        annotations: { title: "Manage Custom Fields", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (p) =>
        guard(async () => {
          const client = makeClient(ctx);
          const listAll = async (inactive = false) =>
            items(await client.call("GET", "/custom-fields", { params: { page_size: 100, active_only: !inactive } }));

          if (p.action === "list") {
            if (!can(ctx, "custom_fields:read")) return permissionMissing(["custom_fields:read"], "list custom fields");
            return wrapStructured({ action: "list", fields: (await listAll(p.include_inactive)).map(fieldOut), already_existed: null });
          }
          if (p.action === "create") {
            if (!can(ctx, "custom_fields:create")) return permissionMissing(["custom_fields:create"], "create custom fields");
            if (!p.name || !p.key || !p.field_type) {
              return toolError("missing_parameter", "name, key and field_type are required to create a field.", "Provide all three and retry.");
            }
            if (can(ctx, "custom_fields:read")) {
              const hit = (await listAll(true)).find((f) => norm(f.key) === norm(p.key));
              if (hit) return wrapStructured({ action: "create", fields: [fieldOut(hit)], already_existed: true });
            }
            const created = asRecord(
              await client.call("POST", "/custom-fields", {
                body: {
                  name: p.name, key: p.key, field_type: p.field_type, description: p.description, options: p.options,
                  ai_access: p.ai_access, ai_hint: p.ai_hint,
                },
              })
            );
            return wrapStructured({ action: "create", fields: [fieldOut(created)], already_existed: false });
          }
          if (!can(ctx, "custom_fields:update")) return permissionMissing(["custom_fields:update"], "update custom fields");
          if (!p.field_id) return toolError("missing_parameter", "field_id is required to update a field.", "Use action=list to find the id.");
          const updated = asRecord(
            await client.call("PUT", `/custom-fields/${encodeURIComponent(p.field_id)}`, {
              body: { name: p.name, description: p.description, options: p.options, ai_access: p.ai_access, ai_hint: p.ai_hint },
            })
          );
          return wrapStructured({ action: "update", fields: [fieldOut(updated)], already_existed: null });
        })
    );
  }

  if (hasAnyScope(ctx.scopes, ["lists:read", "lists:create", "lists:update"])) {
    server.registerTool(
      "manage_lists",
      {
        description: `Work with contact lists: list them, create one, or add/remove contacts.

action:
- list: existing lists (id, name, type).
- create: needs name; list_type "newsletter" (default; contacts opt in per channel). IDEMPOTENT by name: an existing list with the same name is returned (already_existed=true).
- add_members / remove_members: needs list_id, contact_ids and channel_type (email, whatsapp, sms, telegram, ...). Only add contacts who agreed to receive messages from you.`,
        inputSchema: {
          action: z.enum(["list", "create", "add_members", "remove_members"]),
          name: z.string().optional(),
          description: z.string().optional(),
          list_type: z.enum(["newsletter"]).optional().describe("create: only newsletter lists are offered"),
          list_id: z.string().optional(),
          contact_ids: z.array(z.string()).max(100).optional().describe("add/remove: up to 100 contact ids"),
          channel_type: z.string().optional().describe("add/remove: channel of the subscription, e.g. email"),
          channel_id: z.string().optional().describe("add: channel id, only for telegram/messenger/instagram lists"),
        },
        outputSchema: {
          action: z.string(),
          lists: z.array(z.object({ id: nStr, name: nStr, list_type: nStr, description: nStr })),
          already_existed: z.boolean().nullable().optional(),
          succeeded: z.number().nullable().optional(),
          failed: z.array(z.object({ contact_id: z.string(), error: z.string() })).nullable().optional(),
        },
        annotations: { title: "Manage Lists", readOnlyHint: false, destructiveHint: false },
      },
      async (p) =>
        guard(async () => {
          const client = makeClient(ctx);
          const listOut = (l: Json) => ({ id: nn(str(l.id)), name: nn(str(l.name)), list_type: nn(str(l.list_type)), description: nn(str(l.description)) });
          if (p.action === "list") {
            if (!can(ctx, "lists:read")) return permissionMissing(["lists:read"], "list contact lists");
            const res = items(await client.call("GET", "/lists", { params: { page_size: 100 } }));
            return wrapStructured({ action: "list", lists: res.map(listOut), already_existed: null, succeeded: null, failed: null });
          }
          if (p.action === "create") {
            if (!can(ctx, "lists:create")) return permissionMissing(["lists:create"], "create lists");
            if (!p.name) return toolError("missing_parameter", "name is required.", "Provide a list name.");
            if (can(ctx, "lists:read")) {
              const hit = items(await client.call("GET", "/lists", { params: { page_size: 100 } })).find((l) => norm(l.name) === norm(p.name));
              if (hit) return wrapStructured({ action: "create", lists: [listOut(hit)], already_existed: true, succeeded: null, failed: null });
            }
            const created = asRecord(
              await client.call("POST", "/lists", { body: { name: p.name, description: p.description, list_type: p.list_type ?? "newsletter" } })
            );
            return wrapStructured({ action: "create", lists: [listOut(created)], already_existed: false, succeeded: null, failed: null });
          }
          if (!can(ctx, "lists:update")) return permissionMissing(["lists:update"], "change list members");
          if (!p.list_id || !p.contact_ids?.length || !p.channel_type) {
            return toolError("missing_parameter", "list_id, contact_ids and channel_type are required.", "Provide all three and retry.");
          }
          const failed: Array<{ contact_id: string; error: string }> = [];
          let ok = 0;
          for (const cid of p.contact_ids) {
            try {
              if (p.action === "add_members") {
                await client.call("POST", `/lists/${encodeURIComponent(p.list_id)}/members`, {
                  body: { contact_id: cid, channel_type: p.channel_type, channel_id: p.channel_id },
                });
              } else {
                await client.call("DELETE", `/lists/${encodeURIComponent(p.list_id)}/members/${encodeURIComponent(cid)}`, {
                  params: { channel_type: p.channel_type },
                });
              }
              ok++;
            } catch (err) {
              const e = err as { statusCode?: number; message?: string };
              if (e.statusCode && [401, 402, 403].includes(e.statusCode)) throw err;
              failed.push({ contact_id: cid, error: e.message ?? "error" });
            }
          }
          return wrapStructured({ action: p.action, lists: [], already_existed: null, succeeded: ok, failed });
        })
    );
  }
}
