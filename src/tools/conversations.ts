/**
 * Conversation Management Tools
 *
 * Tools for listing, viewing, closing, and assigning conversations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapStructured, wrapError, getExternalId } from "./helpers.js";

/**
 * Dual attachment input: EITHER a pre-uploaded attachment `{id}`, OR a public
 * `{url, filename?}` that SendSeven fetches server-side. URLs are resolved to
 * attachment IDs before hitting the send endpoints (POST /messages and the
 * email reply endpoint both accept attachment IDs only, never raw URLs).
 */
const attachmentInputSchema = z.union([
  z.object({ id: z.string().describe("A previously-uploaded attachment ID") }),
  z.object({
    url: z.string().describe("Public image, video, audio, or document URL - SendSeven downloads it server-side"),
    filename: z.string().optional().describe("Optional filename for the downloaded attachment (include the correct extension, e.g. invoice.pdf)"),
  }),
]);

type AttachmentInput = { id: string } | { url: string; filename?: string };

async function resolveAttachmentIds(
  client: SendSevenApiClient,
  attachments: AttachmentInput[] | undefined
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const ids: string[] = [];
  for (const att of attachments) {
    if ("id" in att) {
      ids.push(att.id);
    } else {
      const created = await client.createAttachmentFromUrl(att.url, att.filename);
      ids.push(created.id);
    }
  }
  return ids;
}

export function registerConversationTools(server: McpServer, ctx: ToolContext): void {
  const hasRead = hasAnyScope(ctx.scopes, ["conversations:read"]);
  const hasWrite = hasAnyScope(ctx.scopes, ["conversations:update"]);

  if (hasRead) {
    server.registerTool(
      "list_conversations",
      {
        description: `List and filter customer conversations. Use this to check open conversations, find conversations needing attention, or search for specific conversations.

Examples:
- "Show my open conversations" → status="open", assigned_to="me"
- "Any conversations needing reply?" → needs_reply=true
- "Find conversation about refund" → search="refund"
- "Snoozed WhatsApp conversations" → status="snoozed", channel_type="whatsapp"`,
        inputSchema: {
          status: z.enum(["open", "snoozed", "closed"]).optional().describe("Filter by tab: 'open' (excludes snoozed), 'snoozed', or 'closed'"),
          assigned_to: z.string().optional().describe("Filter by assignment: 'me', 'unassigned', 'me_and_unassigned', or a specific user ID"),
          needs_reply: z.boolean().optional().describe("Only show conversations waiting for agent reply"),
          search: z.string().optional().describe("Search by content, contact name, or subject"),
          channel_type: z.enum(["whatsapp", "telegram", "sms", "email", "messenger", "instagram", "live_chat", "rcs"]).optional().describe("Filter by channel type"),
          contact_id: z.string().optional().describe("Only conversations with this contact"),
          page: z.number().optional().describe("Page number (default: 1)"),
          page_size: z.number().optional().describe("Results per page (default: 10, max: 50)"),
        },
        outputSchema: {
          conversations: z.array(
            z.object({
              id: z.string(),
              status: z.string(),
              channel: z.string(),
              contact: z.string(),
              contact_id: z.string().nullable().optional(),
              assigned_to: z.string(),
              subject: z.string(),
              last_customer_message: z.string().nullable().optional(),
              last_agent_reply: z.string().nullable().optional(),
              tags: z.array(z.string()),
              created_at: z.string(),
            })
          ),
          total: z.number(),
          page: z.number(),
          total_pages: z.number(),
          hint: z.string().optional(),
        },
        annotations: { title: "List Conversations", readOnlyHint: true, destructiveHint: false },
      },
      async (params) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.listConversations({
            page: params.page ?? 1,
            page_size: params.page_size ?? 10,
            status: params.status,
            assigned_to: params.assigned_to,
            needs_reply: params.needs_reply,
            search: params.search,
            channel_type: params.channel_type,
            contact_id: params.contact_id,
          });

          const conversations = result.items.map((conv) => ({
            id: conv.id,
            status: conv.status,
            channel: conv.channel_type,
            contact: conv.contact
              ? String(conv.contact.name || conv.contact.phone || conv.contact.email || "Unknown")
              : "Unknown",
            contact_id: conv.contact_id,
            assigned_to: conv.assigned_user_id || "Unassigned",
            subject: conv.subject || "(no subject)",
            last_customer_message: conv.last_customer_message_at,
            last_agent_reply: conv.last_agent_reply_at,
            tags: conv.tags?.map((t) => t.name) || [],
            created_at: conv.created_at,
          }));

          return wrapStructured({
            conversations,
            total: result.pagination.total,
            page: result.pagination.page,
            total_pages: result.pagination.total_pages,
            hint: result.pagination.total > result.pagination.page * result.pagination.page_size
              ? `Showing ${conversations.length} of ${result.pagination.total}. Use page=${result.pagination.page + 1} for more.`
              : undefined,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.registerTool(
      "get_conversation",
      {
        description: "Get a conversation with its recent messages. Shows the full chat history, contact details, tags, and status. Each message includes its delivery status, any error_message, attachments, and any per-message metadata (e.g. reactions under meta.reactions). For email conversations, also returns the full email thread (HTML/text body, attachments, from/to addresses per message) and the resolved recipient of the most recent outbound email, so a send can actually be verified. After viewing, use send_reply to respond directly.",
        inputSchema: {
          conversation_id: z.string().describe("The conversation ID"),
        },
        outputSchema: {
          id: z.string(),
          status: z.string(),
          channel: z.string(),
          contact: z
            .object({
              id: z.string(),
              name: z.string(),
              phone: z.string().nullable().optional(),
              email: z.string().nullable().optional(),
            })
            .optional(),
          assigned_to: z.string(),
          subject: z.string().nullable().optional(),
          tags: z.array(z.string()),
          bot_active: z.boolean(),
          created_at: z.string(),
          messages: z
            .array(
              z.object({
                message_id: z.string().optional(),
                direction: z.string(),
                text: z.string().nullable().optional(),
                status: z.string(),
                sent_at: z.string(),
                error_message: z.string().nullable().optional(),
                attachments: z
                  .array(
                    z.object({
                      id: z.string(),
                      filename: z.string(),
                      content_type: z.string(),
                      file_size: z.number(),
                      url: z.string().optional(),
                    })
                  )
                  .optional(),
                /** Arbitrary metadata attached to the message; reactions (if any) are under meta.reactions. */
                meta: z.record(z.unknown()).optional(),
              })
            )
            .optional(),
          // Populated only for email-channel conversations (channel === "email").
          email_thread: z
            .array(
              z.object({
                message_id: z.string().optional(),
                direction: z.string(),
                from: z.string(),
                to: z.array(z.string()),
                subject: z.string().optional(),
                body_html: z.string().optional(),
                body_text: z.string().optional(),
                attachment_count: z.number(),
                status: z.string(),
                sent_at: z.string().optional(),
              })
            )
            .optional(),
          /** The address the most recent outbound email actually went to — the definitive way to verify a send_email destination. */
          resolved_recipient: z.string().optional(),
        },
        annotations: { title: "Get Conversation", readOnlyHint: true, destructiveHint: false },
      },
      async ({ conversation_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const [conv, messagesResult] = await Promise.all([
            client.getConversation(conversation_id),
            client.listMessages(conversation_id, { page: 1, page_size: 20 }).catch(() => null),
          ]);

          const isEmail = conv.channel_type === "email";
          const emailThread = isEmail
            ? await client.getConversationEmailThread(conversation_id).catch(() => null)
            : null;

          const emailThreadOut = emailThread?.messages.map((m) => ({
            message_id: m.message_id,
            direction: m.direction,
            from: m.from_email,
            to: m.to_emails.map((a) => a.email),
            subject: m.subject,
            body_html: m.html_body,
            body_text: m.text_body,
            attachment_count: m.attachments?.length ?? 0,
            status: m.status,
            sent_at: m.sent_at || m.received_at || m.created_at,
          }));

          // Most recent outbound email message's destination — the definitive
          // answer to "which address did this send actually go to".
          const resolvedRecipient = emailThread?.messages
            .filter((m) => m.direction === "outbound" && m.to_emails.length > 0)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
            ?.to_emails.map((a) => a.email)
            .join(", ");

          return wrapStructured({
            id: conv.id,
            status: conv.status,
            channel: conv.channel_type,
            contact: conv.contact
              ? {
                  id: conv.contact.id,
                  name: String(conv.contact.name || ""),
                  phone: conv.contact.phone,
                  email: conv.contact.email,
                }
              : undefined,
            assigned_to: conv.assigned_user_id || "Unassigned",
            subject: conv.subject,
            tags: conv.tags?.map((t) => t.name) || [],
            bot_active: !!conv.bot_session_id,
            created_at: conv.created_at,
            messages: messagesResult?.items.map((msg) => ({
              message_id: msg.external_id,
              direction: msg.direction,
              text: msg.text,
              status: msg.status,
              sent_at: msg.created_at,
              error_message: msg.error_message,
              attachments: msg.attachments?.length ? msg.attachments : undefined,
              meta: msg.meta && Object.keys(msg.meta).length > 0 ? msg.meta : undefined,
            })),
            email_thread: emailThreadOut,
            resolved_recipient: resolvedRecipient,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  // send_reply needs both read (to fetch conversation/contact) and messages:create
  if (hasRead && hasAnyScope(ctx.scopes, ["messages:create"])) {
    server.tool(
      "send_reply",
      `Reply to an existing conversation. Use this when you already have a conversation_id (e.g., from list_conversations or get_conversation). Much simpler than send_message_to_contact — just provide the conversation ID and your reply text.

Attachments (images, video, audio, documents): pass the attachments array. Each entry is EITHER {"id": "<attachment-id>"} (already uploaded) OR {"url": "https://...", "filename": "photo.jpg"} (public URL, downloaded server-side). Works on both chat channels and email replies.

Examples:
- After viewing a conversation: "Reply saying we'll process their refund"
- Quick reply: send_reply(conversation_id="...", text="Thanks, we're on it!")
- With a file: send_reply(conversation_id="...", text="Here's the receipt", attachments=[{"url": "https://.../receipt.pdf"}])`,
      {
        conversation_id: z.string().describe("The conversation ID to reply to"),
        text: z.string().describe("The reply message text"),
        attachments: z.array(attachmentInputSchema).optional().describe('Files to attach. Each entry is EITHER {"id": "<attachment-id>"} (already uploaded) OR {"url": "https://...", "filename?": "..."} (public URL, downloaded server-side).'),
      },
      { title: "Send Reply", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, text, attachments }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          // Step 1: Fetch conversation to get contact_id and channel_type
          const conv = await client.getConversation(conversation_id);

          if (!conv.contact_id) {
            return wrapError({
              error: {
                code: "no_contact",
                message: "Conversation has no associated contact.",
                recoverable: false,
                suggestion: "Use send_message_to_contact instead.",
              },
            });
          }

          // Step 2: Fetch contact for a display label. NOTE: getExternalId here
          // is used ONLY for a human-readable fallback label — it is NOT a
          // delivery gate. The actual send addresses the recipient via
          // contact_id + channel_id + conversation_id, which the backend
          // resolves server-side. Treating a missing externalId as fatal caused
          // a false-negative for WhatsApp contacts reachable only by their
          // Business-Scoped User ID (whatsapp_bsuid) whenever that method was
          // absent from the contact payload — replies to real, reachable
          // contacts were rejected. So this no longer blocks the send.
          const contact = await client.getContact(conv.contact_id);
          const externalId = getExternalId(contact, conv.channel_type);
          const contactLabel = contact.name || externalId || contact.id;

          // Step 3: Route based on channel type
          if (conv.channel_type === "email") {
            // Email conversations must use the dedicated email reply endpoint
            // which handles threading, subject lines, and email-specific delivery.

            // Step 3a: Fetch the email thread to find the latest message to reply to
            let latestEmailMsgId: string | undefined;
            try {
              const thread = await client.getConversationEmailThread(conversation_id);
              if (thread.messages && thread.messages.length > 0) {
                // Use the last message in the thread as the one we reply to
                latestEmailMsgId = thread.messages[thread.messages.length - 1].id;
              }
            } catch {
              // Thread fetch failed — fall through to error below
            }

            if (!latestEmailMsgId) {
              return wrapError({
                error: {
                  code: "no_email_message",
                  message: "Could not find an email message in this conversation to reply to.",
                  recoverable: false,
                  suggestion: "This conversation may not have any email messages yet. Use the send_email tool to start a new email thread.",
                },
              });
            }

            // Step 3b: Convert plain text to basic HTML paragraphs
            const bodyHtml = text
              .split("\n")
              .map((line) => (line.trim() === "" ? "<br>" : `<p>${line}</p>`))
              .join("\n");

            // Step 3c: Resolve any attachments (public URLs fetched + stored
            // server-side first; the reply endpoint accepts IDs only).
            const emailAttachmentIds = await resolveAttachmentIds(client, attachments);

            // Step 3d: Send via the email reply endpoint
            const emailResult = await client.sendEmailReply(latestEmailMsgId, {
              text_body: text,
              html_body: bodyHtml,
              attachment_ids: emailAttachmentIds.length > 0 ? emailAttachmentIds : undefined,
            });

            return wrapResult({
              success: true,
              message_id: emailResult.email_message_id,
              conversation_id,
              channel: "email",
              contact: contactLabel,
              to: emailResult.to_emails,
              hint: `Email reply sent to ${contactLabel}.`,
            });
          }

          // Step 3 (non-email): Resolve attachments, then send reply via the
          // generic messages endpoint. Address via contact_id + channel_id and
          // OMIT `to` — a non-empty `to` is treated as a literal external
          // address and short-circuits backend contact resolution.
          // conversation_id keeps the reply on this thread.
          const attachmentIds = await resolveAttachmentIds(client, attachments);
          const result = await client.sendReply({
            contact_id: contact.id,
            channel_id: conv.channel_id,
            conversation_id,
            text,
            attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
          });

          return wrapResult({
            success: true,
            message_id: result.id,
            conversation_id: result.conversation_id,
            channel: conv.channel_type,
            contact: contactLabel,
            hint: `Reply sent to ${contactLabel} via ${conv.channel_type}.`,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (hasWrite) {
    server.tool(
      "close_conversation",
      "Close a conversation. Optionally add notes and enable AI summarization to generate a knowledge base summary.",
      {
        conversation_id: z.string().describe("The conversation ID to close"),
        notes: z.string().optional().describe("Optional closing notes (e.g., 'Resolved: refund issued')"),
        summarize: z.boolean().optional().describe("Generate AI summary for knowledge base (default: true)"),
      },
      { title: "Close Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, notes, summarize }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.closeConversation(conversation_id, {
            notes,
            summarize: summarize ?? true,
          });
          return wrapResult({
            success: true,
            conversation_id: result.id,
            status: result.status,
            message: `Conversation closed successfully.${summarize !== false ? " An AI summary will be generated." : ""}`,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "assign_conversation",
      "Assign a conversation to a team member. Requires the agent's real user ID (name lookup is not supported server-side) — use list_team_members to find it. The assigned agent will be notified.",
      {
        conversation_id: z.string().describe("The conversation ID"),
        agent_name_or_id: z.string().describe("The agent's user ID to assign the conversation to. Must be a real user ID, not a name — use list_team_members to look it up."),
      },
      { title: "Assign Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, agent_name_or_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.assignConversation(conversation_id, agent_name_or_id);
          return wrapResult({
            success: true,
            conversation_id: result.id,
            assigned_to: result.assigned_user_id,
            message: "Conversation assigned successfully.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "reopen_conversation",
      "Reopen a closed conversation, returning it to the Open tab.",
      {
        conversation_id: z.string().describe("The conversation ID to reopen"),
      },
      { title: "Reopen Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.reopenConversation(conversation_id);
          return wrapResult({
            success: true,
            conversation_id: result.id,
            status: result.status,
            message: "Conversation reopened.",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "snooze_conversation",
      `Snooze (postpone) a conversation until a given time, or clear an active snooze. Snoozed conversations stay open but move off the Open tab until the snooze expires.

Examples:
- "Snooze this until tomorrow 9am" → snooze_until="2026-07-18T09:00:00Z"
- "Unsnooze the conversation" → unsnooze=true`,
      {
        conversation_id: z.string().describe("The conversation ID"),
        snooze_until: z.string().optional().describe("ISO 8601 datetime (must be in the future) when the snooze expires. Required unless unsnooze=true."),
        reopen_on_message: z.boolean().optional().describe("Clear the snooze early if the customer sends a new message (default: true)"),
        unsnooze: z.boolean().optional().describe("Set true to clear an active snooze instead of setting one"),
      },
      { title: "Snooze Conversation", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, snooze_until, reopen_on_message, unsnooze }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          if (unsnooze) {
            const result = await client.unsnoozeConversation(conversation_id);
            return wrapResult({
              success: true,
              conversation_id: result.id,
              message: "Snooze cleared — conversation is back on the Open tab.",
            });
          }

          if (!snooze_until) {
            return wrapError({
              error: {
                code: "missing_snooze_until",
                message: "snooze_until is required when setting a snooze.",
                recoverable: true,
                suggestion: "Provide an ISO 8601 datetime in the future, e.g. 2026-07-18T09:00:00Z.",
              },
            });
          }

          const result = await client.snoozeConversation(conversation_id, {
            snoozed_until: snooze_until,
            reopen_on_message: reopen_on_message ?? true,
          });
          return wrapResult({
            success: true,
            conversation_id: result.id,
            snoozed_until: snooze_until,
            message: `Conversation snoozed until ${snooze_until}.`,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );

    server.tool(
      "email_conversation_transcript",
      `Email the full conversation transcript to any email address as a branded HTML email. Useful after closing a ticket ("send the customer a copy of this conversation").

If multiple mailboxes are configured and none is specified, the default mailbox is used.`,
      {
        conversation_id: z.string().describe("The conversation ID"),
        to_email: z.string().describe("Recipient email address"),
        note: z.string().optional().describe("Optional note shown above the transcript"),
        mailbox_id: z.string().optional().describe("Email mailbox ID to send from (default: the default mailbox)"),
        save_as_contact_method: z.boolean().optional().describe("Save to_email as an email contact method on the contact (default: false)"),
      },
      { title: "Email Conversation Transcript", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, to_email, note, mailbox_id, save_as_contact_method }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          let resolvedMailboxId = mailbox_id;
          if (!resolvedMailboxId) {
            const mailboxes = await client.listEmailMailboxes().catch(() => []);
            const defaultMailbox = mailboxes.find((m) => m.is_default) || mailboxes[0];
            if (!defaultMailbox) {
              return wrapError({
                error: {
                  code: "no_mailbox",
                  message: "Could not resolve a default email mailbox to send from.",
                  recoverable: true,
                  suggestion: "Pass mailbox_id explicitly (see list_email_mailboxes), or set up an email mailbox in SendSeven settings.",
                },
              });
            }
            resolvedMailboxId = defaultMailbox.id;
          }

          const result = await client.emailConversationTranscript(conversation_id, {
            mailbox_id: resolvedMailboxId,
            to_email,
            note,
            save_as_contact_method: save_as_contact_method ?? false,
          });

          return wrapResult({
            success: true,
            conversation_id,
            to_email,
            result,
            message: `Transcript emailed to ${to_email}.`,
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  // Internal notes are messages (agent-only) — they need messages:create
  if (hasAnyScope(ctx.scopes, ["messages:create"])) {
    server.tool(
      "add_internal_note",
      `Add an internal note to a conversation. Internal notes are visible only to agents — they are NEVER sent to the customer. They appear in the conversation timeline.

Optionally @mention team members (they get notified) or assign the conversation to someone in the same step. Use list_team_members to find user IDs.

Examples:
- "Note on this conversation: customer is VIP, handle with priority"
- "Add a note and assign to Sarah" → mentioned_user_ids=[...], assign_to_user_id=...`,
      {
        conversation_id: z.string().describe("The conversation ID to attach the note to"),
        text: z.string().describe("The note text (visible to agents only)"),
        mentioned_user_ids: z.array(z.string()).optional().describe("User IDs to @mention — each gets a notification"),
        assign_to_user_id: z.string().optional().describe("Also assign the conversation to this user"),
      },
      { title: "Add Internal Note", readOnlyHint: false, destructiveHint: false },
      async ({ conversation_id, text, mentioned_user_ids, assign_to_user_id }) => {
        const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
        try {
          const result = await client.createInternalNote({
            conversation_id,
            text,
            mentioned_user_ids,
            assign_to_user_id,
          });
          return wrapResult({
            success: true,
            note_id: result.id,
            conversation_id: result.conversation_id,
            message: "Internal note added (not visible to the customer).",
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }
}
