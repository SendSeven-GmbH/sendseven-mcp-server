/**
 * Channel Management Tools
 *
 * Tools for viewing connected channels, their health status,
 * and WhatsApp message templates.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerChannelTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["channels:read"])) return;

  server.tool(
    "list_channels",
    `List all connected messaging channels (WhatsApp, Telegram, Email, etc.) with their health status. Shows which channels are active and if any have issues.

Health monitoring currently only covers email, messenger, and instagram channels. WhatsApp, Telegram, SMS, live chat, and RCS channels report health="not_monitored" — that means no connection-error monitoring exists for them yet, NOT that something is wrong. Only trust the health field for the three monitored types.

Examples:
- "Which channels are active?"
- "Is our WhatsApp integration working?"
- "Show me the channel health status"`,
    {},
    { title: "List Channels", readOnlyHint: true, destructiveHint: false },
    async () => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const [channels, health] = await Promise.all([
          client.listChannels(),
          client.getChannelHealth().catch(() => null),
        ]);

        // GET /channels/health only returns entries for integrations that
        // currently have an error — it is not a full per-channel health
        // snapshot. It also only checks email, messenger, and instagram
        // integrations today; whatsapp/telegram/sms/live_chat/rcs have no
        // server-side health monitoring yet.
        const MONITORED_TYPES = new Set(["email", "messenger", "instagram"]);
        const healthMap = new Map(
          health?.integrations.map((i) => [i.channel_type, i]) || []
        );
        const healthCheckAvailable = health !== null;

        const result = channels.map((ch) => {
          const healthInfo = healthMap.get(ch.channel_type);
          let healthStatus: string;
          if (healthInfo) {
            healthStatus = healthInfo.connection_status; // e.g. "error", "disconnected"
          } else if (!healthCheckAvailable) {
            healthStatus = "unknown"; // the health endpoint itself failed - genuinely unknown
          } else if (MONITORED_TYPES.has(ch.channel_type)) {
            healthStatus = "connected"; // monitored type, no error reported
          } else {
            healthStatus = "not_monitored"; // this channel type has no server-side health check yet
          }
          return {
            id: ch.id,
            name: ch.name,
            type: ch.channel_type,
            active: ch.is_active,
            identifier: ch.identifier,
            health: healthStatus,
            error: healthInfo?.last_error,
          };
        });

        return wrapResult({
          channels: result,
          total: result.length,
          active_count: result.filter((c) => c.active).length,
          has_issues: health?.has_errors || false,
          hint: health?.has_errors
            ? "Some channels have issues. Check the SendSeven dashboard for details."
            : "Note: channel health monitoring currently only covers email, messenger, and instagram. WhatsApp, Telegram, SMS, live chat, and RCS channels report health=\"not_monitored\" (no connection errors are surfaced for them here) rather than a real status.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "list_email_mailboxes",
    `List email mailboxes (sender identities) configured for your account. Each mailbox has an email address and display name used as the 'From' field when sending emails.

Use the mailbox ID with the send_email tool's mailbox_id parameter to send from a specific mailbox.

Examples:
- "What email addresses can I send from?"
- "Show me our configured mailboxes"
- "Which mailbox is the default?"`,
    {},
    { title: "List Email Mailboxes", readOnlyHint: true, destructiveHint: false },
    async () => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const mailboxes = await client.listEmailMailboxes();

        return wrapResult({
          mailboxes: mailboxes.map((m) => ({
            id: m.id,
            email_address: m.email_address,
            name: m.name,
            is_default: m.is_default,
          })),
          total: mailboxes.length,
          hint: mailboxes.length > 0
            ? "Use the mailbox ID with send_email's mailbox_id parameter to send from a specific mailbox."
            : "No email mailboxes configured. Set up email in the SendSeven dashboard.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "list_verified_email_domains",
    `List email sender domains that are verified with your email provider(s). A send_email using a "from_email"/mailbox whose domain is NOT in this list will typically fail to send or be marked unauthenticated by the recipient's mail server. Use this before send_email if you're unsure whether a given from address will work.

Examples:
- "Which domains can we send email from?"
- "Is example.com verified for sending?"
- "Why did my email send fail — is the domain verified?"`,
    {},
    { title: "List Verified Email Domains", readOnlyHint: true, destructiveHint: false },
    async () => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const providers = await client.listEmailProviders();

        const result = providers.map((p) => ({
          provider_id: p.id,
          provider_name: p.name,
          provider_type: p.provider_type,
          is_default: p.is_default,
          is_active: p.is_active,
          verified_domains: p.verified_domains ?? [],
        }));

        const allDomains = Array.from(new Set(result.flatMap((p) => p.verified_domains)));

        return wrapResult({
          providers: result,
          all_verified_domains: allDomains,
          hint: allDomains.length > 0
            ? "A send_email from_email (or mailbox) whose domain isn't in all_verified_domains will likely fail or be flagged as unauthenticated."
            : "No verified domains found. Verify a sending domain with your email provider in the SendSeven dashboard, or check list_email_mailboxes for configured sender identities.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "list_whatsapp_templates",
    `List approved WhatsApp message templates. Use these templates to send messages to contacts outside the 24-hour messaging window. Shows template name, language, status, and content, including buttons, header type/media, and whether it's a carousel template. Use get_whatsapp_template for a single template's full detail (e.g. carousel cards).

Note: "total" is the true total count of matching templates on the server (not just the count returned on this page) — use offset to page through when total exceeds the returned count.

Examples:
- "Show me our WhatsApp templates"
- "What templates do we have for order confirmations?"
- "List approved WhatsApp templates"`,
    {
      status: z.enum(["APPROVED", "PENDING", "REJECTED"]).optional().describe("Filter by approval status (default: all)"),
      limit: z.number().optional().describe("Max results to return (default: 100)"),
      offset: z.number().optional().describe("Number of results to skip, for paging (default: 0)"),
    },
    { title: "List WhatsApp Templates", readOnlyHint: true, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.listWhatsAppTemplates({
          status: params.status,
          limit: params.limit ?? 100,
          offset: params.offset ?? 0,
        });

        const templates = result.templates.map((t) => ({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          header_type: t.header_type,
          header: t.header_text,
          body: t.body_text,
          footer: t.footer_text,
          buttons: t.buttons?.map((b) => ({ type: b.type, text: b.text })),
          quick_reply_buttons: t.quick_reply_buttons,
          is_carousel: !!(t.carousel_cards && t.carousel_cards.length > 0),
        }));

        return wrapResult({
          templates,
          total: result.total,
          offset: params.offset ?? 0,
          hint: templates.length > 0
            ? "Use send_whatsapp_template to send one of these templates — required for contacts outside the 24h WhatsApp window. Use get_whatsapp_template with a template's id for full detail (e.g. carousel cards)."
            : "No templates found. Create templates in the SendSeven dashboard or Meta Business Manager.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "get_whatsapp_template",
    `Get full details for a single WhatsApp message template by ID, including carousel cards, quick-reply button captions, default header media, and parameter format. Use list_whatsapp_templates first to find the template's id.

Examples:
- "Show me everything about the order_confirmation template"
- "What are the carousel cards on this template?"`,
    {
      template_id: z.string().describe("The template's id (from list_whatsapp_templates)"),
    },
    { title: "Get WhatsApp Template", readOnlyHint: true, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const t = await client.getWhatsAppTemplate(params.template_id);

        return wrapResult({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          quality_score: t.quality_score,
          waba_id: t.waba_id,
          parameter_format: t.parameter_format,
          header_type: t.header_type,
          header_text: t.header_text,
          default_header_media_url: t.default_header_media_url,
          default_header_document_filename: t.default_header_document_filename,
          body: t.body_text,
          footer: t.footer_text,
          buttons: t.buttons,
          quick_reply_buttons: t.quick_reply_buttons,
          carousel_cards: t.carousel_cards,
          variable_mapping: t.variable_mapping,
          last_synced_at: t.last_synced_at,
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
