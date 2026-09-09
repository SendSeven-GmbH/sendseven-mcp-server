/**
 * Webhook Management Tools (Developer)
 *
 * Tools for managing webhook endpoints that receive real-time SendSeven
 * events (message.received, message.sent, conversation.*, contact.*, ...).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

/**
 * Canonical webhook-eligible event catalogue, mirrored from the backend's
 * WEBHOOK_EVENT_DEFINITIONS (backend/app/schemas/webhook_schema.py). Kept in
 * sync manually — update both lists together if webhook-eligible events
 * change. Folded directly into create_webhook's schema/description so agents
 * don't need a separate discovery round-trip to learn valid event names.
 */
const WEBHOOK_EVENT_TYPES = [
  // Message events (messaging channels: WhatsApp, Telegram, SMS, etc.)
  "message.received",
  "message.sent",
  "message.delivered",
  "message.failed",
  "message.read",
  "message.reaction",
  // Email events
  "email.received",
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.opened",
  "email.complained",
  // Conversation events
  "conversation.created",
  "conversation.closed",
  "conversation.assigned",
  "conversation.reopened",
  "conversation.updated",
  "conversation.transcript.created",
  // Contact events
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.subscribed",
  "contact.unsubscribed",
  // Campaign messenger events
  "campaign.message.sent",
  "campaign.message.delivered",
  "campaign.message.read",
  "campaign.message.failed",
  // Campaign email events
  "campaign.email.sent",
  "campaign.email.delivered",
  "campaign.email.bounced",
  "campaign.email.opened",
  "campaign.email.complained",
  // Channel (messaging integration) lifecycle events
  "channel.created",
  "channel.updated",
  "channel.deleted",
  // Link tracking events
  "link.clicked",
  // Social comment/post events (Instagram + Facebook Page)
  "comment.received",
  "comment.updated",
  "comment.deleted",
  "post.created",
  "post.updated",
  "post.deleted",
  // Team Chat events
  "team_chat.message.created",
] as const;

export function registerWebhookTools(server: McpServer, ctx: ToolContext): void {
  const hasRead = hasAnyScope(ctx.scopes, ["webhooks:read"]);
  const hasCreate = hasAnyScope(ctx.scopes, ["webhooks:create"]);
  const hasDelete = hasAnyScope(ctx.scopes, ["webhooks:delete"]);

  if (hasRead) {
    server.tool(
      "list_webhooks",
      `List configured webhook endpoints with their subscribed events, health status, and recent failures.

Examples:
- "Show my webhooks"
- "Is my n8n webhook still working?"`,
      {},
      { title: "List Webhooks", readOnlyHint: true, destructiveHint: false },
      async () => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const webhooks = await client.listWebhooks();
          return wrapResult({
            webhooks: webhooks.map((w) => ({
              id: w.id,
              name: w.name,
              url: w.url,
              events: w.subscribed_events,
              active: w.is_active,
              verified: w.is_verified,
              last_success_at: w.last_success_at || undefined,
              last_failure_at: w.last_failure_at || undefined,
              last_error: w.last_error || undefined,
              consecutive_failures: w.consecutive_failures || 0,
              // Circuit-breaker suspension state: the endpoint is suspended
              // (not deleted) for up to 12h while failing, with events queued
              // for replay rather than dropped.
              suspended_at: w.suspended_at || undefined,
              next_reactivation_at: w.next_reactivation_at || undefined,
              queued_events_count: w.queued_events_count ?? undefined,
            })),
            total: webhooks.length,
            hint: webhooks.some((w) => w.suspended_at)
              ? "Some webhooks are suspended by the circuit breaker after repeated failures — events are queued (see queued_events_count) and delivery will auto-resume at next_reactivation_at."
              : webhooks.some((w) => (w.consecutive_failures || 0) > 0)
                ? "Some webhooks have recent failures — check last_error. Trigger one of the webhook's subscribed events (e.g. send a message) and re-check last_success_at/last_error to confirm it recovered."
                : undefined,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasCreate) {
    server.tool(
      "create_webhook",
      `Create a webhook endpoint that receives real-time SendSeven events as HTTPS POST requests.

Valid event types (grouped by category — see the events param for the full enum):
- message: message.received, message.sent, message.delivered, message.failed, message.read, message.reaction
- email: email.received, email.sent, email.delivered, email.bounced, email.opened, email.complained
- conversation: conversation.created, conversation.closed, conversation.assigned, conversation.reopened, conversation.updated, conversation.transcript.created
- contact: contact.created, contact.updated, contact.deleted, contact.subscribed, contact.unsubscribed
- campaign (messaging channels): campaign.message.sent, campaign.message.delivered, campaign.message.read, campaign.message.failed
- campaign (email): campaign.email.sent, campaign.email.delivered, campaign.email.bounced, campaign.email.opened, campaign.email.complained
- channel: channel.created, channel.updated, channel.deleted
- link: link.clicked
- social comments/posts (Instagram + Facebook): comment.received, comment.updated, comment.deleted, post.created, post.updated, post.deleted
- team chat: team_chat.message.created

Examples:
- "Send new inbound messages to my n8n workflow" → url="https://n8n.example.com/webhook/...", events=["message.received"]
- "Notify my CRM when conversations close" → events=["conversation.closed"]`,
      {
        name: z.string().describe("A friendly name for the webhook (e.g., 'n8n inbound messages')"),
        url: z.string().describe("HTTPS URL that will receive the events"),
        events: z
          .array(z.enum(WEBHOOK_EVENT_TYPES))
          .min(1)
          .describe("Event types to subscribe to, e.g. ['message.received', 'conversation.closed'] — see the tool description for the full list of valid values"),
        authorization_header: z.string().optional().describe("Optional Authorization header value sent with each delivery (e.g., 'Bearer token123')"),
      },
      { title: "Create Webhook", readOnlyHint: false, destructiveHint: false },
      async ({ name, url, events, authorization_header }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const webhook = await client.createWebhook({
            name,
            url,
            subscribed_events: events,
            authorization_header,
          });
          return wrapResult({
            success: true,
            webhook_id: webhook.id,
            name: webhook.name,
            url: webhook.url,
            events: webhook.subscribed_events,
            message: `Webhook '${webhook.name}' created.`,
            hint: "Trigger one of the subscribed events (e.g. send a message, or close a conversation) and use list_webhooks to confirm last_success_at is set and there's no last_error.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasDelete) {
    server.tool(
      "delete_webhook",
      "Delete a webhook endpoint. It stops receiving events immediately. This cannot be undone.",
      {
        webhook_id: z.string().describe("The webhook ID to delete (from list_webhooks)"),
      },
      { title: "Delete Webhook", readOnlyHint: false, destructiveHint: true },
      async ({ webhook_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          await client.deleteWebhook(webhook_id);
          return wrapResult({
            success: true,
            webhook_id,
            message: "Webhook deleted.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }
}
