/**
 * Team Management Tools
 *
 * Tools for listing team members. Essential for assign_conversation to work
 * since users need to know agent IDs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerTeamTools(server: McpServer, ctx: ToolContext): void {
  if (hasAnyScope(ctx.scopes, ["team:read"])) {
    server.tool(
      "list_team_members",
      `List all team members in your workspace. Returns user IDs, names, emails, and roles. Use this to find agent IDs for assign_conversation.

Examples:
- "Who's on the team?" → list_team_members()
- "Find the support agents" → list_team_members()`,
      {
        page: z.number().optional().describe("Page number (default: 1)"),
        page_size: z.number().optional().describe("Results per page (default: 50)"),
      },
      { title: "List Team Members", readOnlyHint: true, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.listTeamMembers({
            page: params.page ?? 1,
            page_size: params.page_size ?? 50,
          });

          const members = result.items.map((m) => ({
            id: m.id,
            name: m.name || m.email,
            email: m.email,
            role: m.role,
            rbac_roles: m.rbac_roles?.map((r) => r.role_name) || [],
            chat_nickname: m.chat_nickname,
            live_chat_available: m.live_chat_available,
          }));

          return wrapResult({
            team_members: members,
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

  if (hasAnyScope(ctx.scopes, ["team:read"])) {
    server.tool(
      "set_out_of_office",
      `Switch the connected user's OWN out of office on (or schedule it), optionally handing their conversations to a substitute. While absent, new conversations of the user's contacts and their assigned conversations that get a new customer message move to the substitute. Acts only on the user who connected this server.

substitute_mode: "none" (default), "user" (needs substitute_user_id from list_team_members), "round_robin_inbox" / "least_busy_inbox" (needs substitute_inbox_id), "round_robin_tag" / "least_busy_tag" (needs substitute_tag_id).

Examples:
- "I'm out of office until Monday, Anna covers" → ends_at=<Monday 08:00 ISO>, substitute_mode="user", substitute_user_id=<Anna's id>
- "Mark me out of office" → no arguments (until switched off)`,
      {
        starts_at: z.string().optional().describe("ISO 8601 start (default: now)"),
        ends_at: z.string().nullable().optional().describe("ISO 8601 end; omit or null = until switched off"),
        substitute_mode: z
          .enum(["none", "user", "round_robin_inbox", "round_robin_tag", "least_busy_inbox", "least_busy_tag"])
          .optional()
          .describe("Who takes over (default: none)"),
        substitute_user_id: z.string().optional().describe("Team member id when substitute_mode=user"),
        substitute_inbox_id: z.string().optional().describe("Inbox id for the inbox modes"),
        substitute_tag_id: z.string().optional().describe("Tag id for the tag modes"),
        note: z.string().max(255).optional().describe("Internal reason, never shown to customers"),
      },
      { title: "Set Out of Office", readOnlyHint: false, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const absence = await client.createMyAbsence({
            ...params,
            ends_at: params.ends_at ?? undefined,
          });
          return wrapResult({
            success: true,
            absence_id: absence.id,
            starts_at: absence.starts_at,
            ends_at: absence.ends_at ?? null,
            substitute_mode: absence.substitute_mode,
            substitute_user_id: absence.substitute_user_id ?? null,
            is_active: absence.is_active,
            message: absence.is_active ? "You are now out of office." : "Out of office scheduled.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "end_out_of_office",
      `End the connected user's running out of office now ("I'm back"). Acts only on the user who connected this server.`,
      {},
      { title: "End Out of Office", readOnlyHint: false, destructiveHint: false },
      async () => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.endMyAbsencesNow();
          return wrapResult({
            success: result.success,
            ended: result.ended,
            message: result.ended > 0 ? "Welcome back, your out of office has ended." : "No running out of office to end.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }
}
