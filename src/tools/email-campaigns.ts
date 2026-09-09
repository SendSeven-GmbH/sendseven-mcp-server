/**
 * Email Campaign Tools
 *
 * Tools for listing email campaigns and viewing their analytics.
 * Email campaigns are created in the SendSeven dashboard and can be
 * monitored and sent via these tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerEmailCampaignTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["campaigns:read"])) return;

  server.tool(
    "list_email_campaigns",
    `List email campaigns with their status, subject line, and delivery statistics. Shows draft, scheduled, sending, and completed email campaigns.

Examples:
- "Show me our email campaigns"
- "What email campaigns have been sent?"
- "List all draft email campaigns"`,
    {
      page: z.number().optional().describe("Page number (default: 1)"),
      page_size: z.number().optional().describe("Results per page (default: 20)"),
    },
    { title: "List Email Campaigns", readOnlyHint: true, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.listEmailCampaigns({
          page: params.page ?? 1,
          page_size: params.page_size ?? 20,
        });

        const campaigns = result.items.map((c) => ({
          id: c.id,
          campaign_id: c.campaign_id,
          name: c.name || c.campaign_name,
          subject_line: c.subject_line,
          status: c.status || c.campaign_status,
          from_name: c.from_name || undefined,
          from_email: c.from_email || undefined,
          stats: {
            sent: c.sent_count ?? 0,
            delivered: c.delivered_count ?? 0,
            opened: c.opened_count ?? 0,
            clicked: c.clicked_count ?? 0,
          },
          created_at: c.created_at,
        }));

        return wrapResult({
          campaigns,
          total: result.pagination.total,
          page: result.pagination.page,
          total_pages: result.pagination.total_pages,
          hint: campaigns.length > 0
            ? "Use get_email_campaign_analytics with a campaign ID for detailed analytics."
            : "No email campaigns found. Create email campaigns in the SendSeven dashboard.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "get_email_campaign_analytics",
    `Get detailed analytics for a specific email campaign, including open rates, click rates, bounce rates, and engagement metrics.

list_email_campaigns rows carry two different IDs: "id" (this campaign's own identifier — pass this) and "campaign_id" (an internal reference to a related base campaign record — do NOT pass this). If you accidentally pass a "campaign_id" value, this tool will automatically look it up and retry with the correct "id" behind the scenes, so either value works, but prefer "id" going forward.

Examples:
- "Show analytics for campaign abc123"
- "What's the open rate for our latest email campaign?"
- "How did the newsletter perform?"`,
    {
      campaign_id: z.string().describe("The email campaign's 'id' from list_email_campaigns (its 'campaign_id' field also works but is not preferred)"),
    },
    { title: "Get Email Campaign Analytics", readOnlyHint: true, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        try {
          const analytics = await client.getEmailCampaignAnalytics(params.campaign_id);
          return wrapResult({
            campaign_id: params.campaign_id,
            analytics,
            hint: "Use list_email_campaigns to see all campaigns and their IDs.",
          });
        } catch (err) {
          if (!(err instanceof ApiClientError) || err.statusCode !== 404) throw err;

          // The given value might be a campaign's "campaign_id" (FK to the base
          // Campaign record) rather than its own "id" — the analytics endpoint
          // only accepts "id". Search a few pages of list_email_campaigns for a
          // row whose campaign_id matches, and retry with its id.
          let resolvedId: string | undefined;
          for (let page = 1; page <= 5 && !resolvedId; page++) {
            const result = await client.listEmailCampaigns({ page, page_size: 100 });
            const match = result.items.find((c) => c.campaign_id === params.campaign_id);
            if (match) resolvedId = match.id;
            if (page >= result.pagination.total_pages) break;
          }

          if (!resolvedId) throw err;

          const analytics = await client.getEmailCampaignAnalytics(resolvedId);
          return wrapResult({
            campaign_id: resolvedId,
            analytics,
            hint: `Note: "${params.campaign_id}" was a campaign_id value, not the campaign's id. Resolved automatically to id="${resolvedId}" — use that value directly next time.`,
          });
        }
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
