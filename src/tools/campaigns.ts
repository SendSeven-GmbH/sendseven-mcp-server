/**
 * Campaign & List Management Tools
 *
 * Tools for listing contact lists/newsletters and creating marketing campaigns
 * across all channels: WhatsApp, Telegram, SMS, Browser Push, Email.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerCampaignTools(server: McpServer, ctx: ToolContext): void {

  // ─── List Contact Lists ───────────────────────────────────────
  if (hasAnyScope(ctx.scopes, ["lists:read"])) {
    server.tool(
      "list_contact_lists",
      `List all contact lists and newsletter lists. Shows list name, type (static/dynamic/newsletter), subscriber count, and ID. Use the list IDs when creating campaigns to target specific audiences.

Examples:
- "Show me all our lists"
- "Which newsletter lists do we have?"
- "How many subscribers are in the VIP list?"`,
      {
        page: z.number().optional().describe("Page number (default: 1)"),
        page_size: z.number().optional().describe("Results per page (default: 50)"),
      },
      { title: "List Contact Lists", readOnlyHint: true, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.listContactLists({
            page: params.page ?? 1,
            page_size: params.page_size ?? 50,
          });

          const lists = result.items.map((l) => ({
            id: l.id,
            name: l.name,
            type: l.list_type,
            description: l.description || undefined,
            contact_count: parseInt(l.contact_count, 10) || 0,
            slug: l.slug || undefined,
            created_at: l.created_at,
          }));

          return wrapResult({
            lists,
            total: result.pagination.total,
            page: result.pagination.page,
            total_pages: result.pagination.total_pages,
            hint: lists.length > 0
              ? "Use these list IDs with create_and_send_campaign to target specific audiences."
              : "No lists found. Create lists in the SendSeven dashboard.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  // ─── List Campaigns & Status ──────────────────────────────────
  if (hasAnyScope(ctx.scopes, ["campaigns:read"])) {
    server.tool(
      "list_campaigns",
      `List messaging campaigns (WhatsApp, Telegram, SMS, browser push) with their status and delivery counts. For EMAIL campaigns use list_email_campaigns.

Note: "total" in the response reflects only the number of campaigns returned in this call (bounded by "limit"), NOT the true total number of matching campaigns on the server — the server does not report an overall count. If "total" equals your requested "limit", there may be more campaigns you aren't seeing; narrow with "status" to check.

Examples:
- "Show me our campaigns"
- "Which campaigns are still sending?" → status="sending"
- "List draft campaigns" → status="draft"`,
      {
        status: z.enum(["draft", "scheduled", "sending", "completed", "paused", "failed", "cancelled"]).optional().describe("Filter by campaign status"),
        limit: z.number().optional().describe("Max results (default: 20)"),
      },
      { title: "List Campaigns", readOnlyHint: true, destructiveHint: false },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const campaigns = await client.listCampaigns({
            campaign_status: params.status,
            limit: params.limit ?? 20,
          });

          return wrapResult({
            campaigns: campaigns.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              channels: c.channel_filter || ["all"],
              message_type: c.message_type || "text",
              scheduled_at: c.scheduled_at || undefined,
              total_recipients: c.total_recipients ?? undefined,
              sent: c.sent_count ?? undefined,
              delivered: c.delivered_count ?? undefined,
              failed: c.failed_count ?? undefined,
              created_at: c.created_at,
            })),
            total: campaigns.length,
            hint: campaigns.length >= (params.limit ?? 20)
              ? "Use get_campaign_status with a campaign ID for detailed delivery statistics. Note: this result was capped at the requested limit — there may be more matching campaigns not shown (the server doesn't report a true total count for this list)."
              : "Use get_campaign_status with a campaign ID for detailed delivery statistics.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "get_campaign_status",
      "Get delivery statistics for a messaging campaign: sent, delivered, and failed counts. For email campaign analytics use get_email_campaign_analytics.",
      {
        campaign_id: z.string().describe("The campaign ID (from list_campaigns or create_and_send_campaign)"),
      },
      { title: "Get Campaign Status", readOnlyHint: true, destructiveHint: false },
      async ({ campaign_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const stats = await client.getCampaignStatistics(campaign_id);
          return wrapResult({
            campaign_id,
            statistics: stats,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  // ─── Create & Send Campaign ───────────────────────────────────
  if (!hasAnyScope(ctx.scopes, ["campaigns:create"])) return;

  server.tool(
    "create_and_send_campaign",
    `Create a messaging campaign and optionally send it immediately. Supports multiple channels.

Channels and their specific fields:
- **whatsapp**: Regular text or WhatsApp template messages. For templates, set message_type="whatsapp_template" and provide template_name + template_language.
- **telegram**: Text messages to Telegram subscribers.
- **sms**: SMS text messages.
- **browser_push**: Browser push notifications. Set browser_push_title for the notification title and target_url for the click-through link.
- **email**: Email campaigns (basic). For full email campaigns with HTML, subject lines, and tracking, use the SendSeven dashboard.
- No channel filter = sends on ALL available channels for each targeted contact.

A campaign ALWAYS requires at least one target list — there is no "send to all contacts"
option anymore. Use list_contact_lists first to find (or create, in the SendSeven
dashboard) the list ID(s) to target.

Examples:
- "Send a push notification to the VIP list: Flash sale today!" → channel="browser_push", list_ids=["<vip-list-id>"], browser_push_title="Flash Sale!", target_url="https://shop.example.com/sale"
- "WhatsApp campaign to VIP list: Your exclusive offer" → channel="whatsapp", list_ids=["<vip-list-id>"]
- "Send a Telegram message to the newsletter list about the event" → channel="telegram", list_ids=["<newsletter-list-id>"]
- "SMS campaign: Your appointment is tomorrow" → channel="sms", list_ids=["<list-id>"]
- "WhatsApp template campaign" → channel="whatsapp", list_ids=["<list-id>"], message_type="whatsapp_template", template_name="order_update", template_language="en"`,
    {
      name: z.string().describe("Campaign name (internal identifier)"),
      message: z.string().describe("The campaign message content"),
      channel: z.enum(["whatsapp", "telegram", "sms", "browser_push", "email"]).optional()
        .describe("Channel to send on. Omit to send on all available channels per contact."),
      list_ids: z.array(z.string()).min(1)
        .describe("REQUIRED. Target list IDs (from list_contact_lists) — at least one. There is no 'send to all contacts' mode; every campaign targets specific list(s)."),
      send_immediately: z.boolean().optional()
        .describe("Send right away (default: false, creates as draft)"),
      // Browser push specific
      browser_push_title: z.string().optional()
        .describe("Notification title (for browser_push channel only)"),
      target_url: z.string().optional()
        .describe("Click-through URL (for browser_push channel only)"),
      // WhatsApp template specific
      message_type: z.enum(["text", "whatsapp_template"]).optional()
        .describe("Message type. Use 'whatsapp_template' for WhatsApp template campaigns (default: text)"),
      template_name: z.string().optional()
        .describe("WhatsApp template name (required when message_type=whatsapp_template)"),
      template_language: z.string().optional()
        .describe("WhatsApp template language code, e.g. 'en', 'de' (required when message_type=whatsapp_template)"),
      // Scheduling
      scheduled_at: z.string().optional()
        .describe("Schedule for later (ISO 8601 datetime, e.g. '2026-03-01T09:00:00Z'). Omit for immediate or draft."),
    },
    { title: "Create and Send Campaign", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        if (!params.list_ids || params.list_ids.length === 0) {
          return wrapError({
            error: {
              code: "list_ids_required",
              message: "At least one target list is required — SendSeven no longer supports sending a campaign to all contacts.",
              recoverable: true,
              suggestion: "Use list_contact_lists to find a list ID, then retry with list_ids=[\"<list-id>\"].",
            },
          });
        }

        const campaign = await client.createCampaign({
          name: params.name,
          message_text: params.message,
          message_type: params.message_type,
          list_ids: params.list_ids,
          channel_filter: params.channel ? [params.channel] : undefined,
          browser_push_title: params.browser_push_title,
          target_url: params.target_url,
          whatsapp_template_name: params.template_name,
          whatsapp_template_language: params.template_language,
          scheduled_at: params.scheduled_at,
        });

        let costEstimate;
        try {
          costEstimate = await client.estimateCampaignCost(campaign.id);
        } catch {
          // Cost estimation may not be available
        }

        if (params.send_immediately) {
          const sendResult = await client.sendCampaign(campaign.id);
          return wrapResult({
            success: true,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            status: "sending",
            channel: params.channel || "all",
            recipient_count: sendResult.recipient_count,
            estimated_cost: costEstimate ? `EUR ${costEstimate.total_cost_eur.toFixed(2)}` : undefined,
            warnings: costEstimate?.warnings,
            message: `Campaign '${campaign.name}' is being sent to ${sendResult.recipient_count} recipients via ${params.channel || "all channels"}.`,
          });
        }

        if (params.scheduled_at) {
          return wrapResult({
            success: true,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            status: "scheduled",
            channel: params.channel || "all",
            scheduled_at: params.scheduled_at,
            estimated_cost: costEstimate ? `EUR ${costEstimate.total_cost_eur.toFixed(2)}` : undefined,
            estimated_recipients: costEstimate?.recipient_count,
            message: `Campaign '${campaign.name}' scheduled for ${params.scheduled_at}.`,
          });
        }

        return wrapResult({
          success: true,
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          status: "draft",
          channel: params.channel || "all",
          estimated_cost: costEstimate ? `EUR ${costEstimate.total_cost_eur.toFixed(2)}` : undefined,
          estimated_recipients: costEstimate?.recipient_count,
          warnings: costEstimate?.warnings,
          message: `Campaign '${campaign.name}' created as draft. Use send_immediately=true to send, or review in SendSeven first.`,
          hint: "Use list_contact_lists to see available target lists.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
