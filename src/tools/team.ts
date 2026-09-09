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
}
