/**
 * Email Tools
 *
 * Dedicated tool for sending emails. Emails require different fields than
 * regular messages (subject line, HTML body, CC/BCC), so they get their own tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext, Contact, EmailMailbox } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

/**
 * Dual attachment input: EITHER a pre-uploaded attachment `{id}`, OR a public
 * `{url, filename?}` that SendSeven fetches server-side. URLs are resolved to
 * attachment IDs before the send.
 */
const attachmentInputSchema = z.union([
  z.object({ id: z.string().describe("A previously-uploaded attachment ID") }),
  z.object({
    url: z.string().describe("Public URL of the file to attach - SendSeven downloads it server-side"),
    filename: z.string().optional().describe("Optional filename for the attachment (include the correct extension, e.g. invoice.pdf)"),
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

export function registerEmailTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["messages:create"])) return;

  server.tool(
    "send_email",
    `Send an email to a contact. Finds the contact by email address or name, resolves the email channel, and sends with proper email fields (subject, body, CC, BCC).

This is the ONLY tool for sending emails. Do NOT use send_message_to_contact for email — it lacks email-specific fields like subject lines.

The body supports HTML formatting. For plain text emails, the text will be sent as-is (wrapped in basic HTML).

You can optionally specify a custom sender address (from_email) and display name (from_name). The from_email must belong to a verified domain configured in SendSeven — use list_verified_email_domains to check which domains are verified before sending, especially if a previous send failed.

Recipient resolution: if "to" is a full email address (contains "@"), the email is sent to THAT EXACT address — even if it's a non-primary contact method, or doesn't match the matched contact's primary email. If "to" is a name (no "@"), the email goes to the matched contact's primary email address instead.

You can attach files via the attachments array. Each entry is EITHER {"id": "<attachment-id>"} for a file already uploaded to SendSeven, OR {"url": "https://...", "filename": "invoice.pdf"} for a public URL that SendSeven downloads server-side. Note: when attachments are included, the sender's email signature is NOT appended (the include_signature option applies only to attachment-free emails).

If the account has multiple email mailboxes configured and the user hasn't specified which to use, this tool will return the list of available mailboxes so you can ask which one to send from. The default mailbox is indicated.

Mailbox precedence when both are given: mailbox_id takes priority over from_email (from_email is then ignored for mailbox selection, but still used as a display override if it doesn't match any configured mailbox). Prefer mailbox_id for reliable mailbox selection; use from_email alone only for a one-off display sender that isn't tied to a configured mailbox.

Examples:
- "Email john@example.com: Subject: Meeting Tomorrow, Body: Hi John, just a reminder about our meeting."
- "Send an email to Lisa with subject 'Invoice #123' and attach the PDF" → to="Lisa", subject="Invoice #123", attachments=[{"url": "https://.../invoice-123.pdf"}]
- "Email support@acme.com about their open ticket, CC sarah@acme.com"
- "Email from sales@ourcompany.com to john@example.com about the new pricing"`,
    {
      to: z.string().describe("Recipient email address or contact name"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body content. Supports HTML tags for formatting. Plain text is also accepted."),
      cc: z.array(z.string()).optional().describe("CC email addresses"),
      bcc: z.array(z.string()).optional().describe("BCC email addresses"),
      attachments: z.array(attachmentInputSchema).optional().describe('Files to attach. Each entry is EITHER {"id": "<attachment-id>"} (already uploaded) OR {"url": "https://...", "filename?": "..."} (public URL, downloaded server-side).'),
      include_signature: z.boolean().optional().describe("Include the sender's email signature (default: true). Ignored when attachments are provided."),
      from_email: z.string().email().optional().describe("Custom sender email address. Must be from a verified domain. If not specified, uses the default support email."),
      from_name: z.string().optional().describe("Custom sender display name. If not specified, uses the default."),
      mailbox_id: z.string().optional().describe("Email mailbox ID to send from. Use list_email_mailboxes to see available mailboxes. If not specified, uses the default mailbox."),
      create_if_not_exists: z.boolean().optional().describe("Create contact if not found (default: true)"),
    },
    { title: "Send Email", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const identifier = params.to.trim();
        const isEmailAddress = identifier.includes("@");
        // Explicit destination override: only forwarded when "to" is itself a
        // full email address. A plain name never sets this, so the backend
        // falls back to the resolved contact's primary email (unchanged
        // behavior for name-based lookups).
        const toEmail = isEmailAddress ? identifier : undefined;

        // Step 1: Find or create the contact
        let contact: Contact | undefined;

        const contacts = await client.searchContacts({ search: identifier, page_size: 5 });

        if (contacts.items.length > 0) {
          contact = contacts.items[0];
        } else if (params.create_if_not_exists !== false) {
          contact = await client.createContact({
            email: isEmailAddress ? identifier : undefined,
            name: !isEmailAddress ? identifier : undefined,
          });
        } else {
          return wrapError({
            error: {
              code: "contact_not_found",
              message: `No contact found matching '${identifier}'`,
              recoverable: true,
              suggestion: "Try searching by email address or name. Or set create_if_not_exists=true to auto-create.",
            },
          });
        }

        // Step 2: Find the email channel(s) for this contact — the backend
        // returns one channel per configured mailbox (AvailableChannelResponse.
        // email_mailbox), each with its own channel_id ("email_mailbox_{id}").
        const channelsResponse = await client.getContactAvailableChannels(contact.id);
        const emailChannels = channelsResponse.channels.filter((ch) => ch.channel_type === "email");

        if (emailChannels.length === 0) {
          const available = channelsResponse.channels.map((ch) => ch.channel_type).join(", ");
          return wrapError({
            error: {
              code: "no_email_channel",
              message: `Contact '${contact.name || identifier}' has no email channel available.${available ? ` Available channels: ${available}` : ""}`,
              recoverable: true,
              suggestion: contact.email
                ? "The email integration may not be configured. Check your email channel setup in SendSeven."
                : "The contact needs an email address. Update the contact with an email first.",
            },
          });
        }

        // Step 2b: Fetch the account's mailbox list — used for the is_default
        // flag (AvailableChannelResponse.email_mailbox doesn't carry it) and
        // for the clarification prompt below.
        let mailboxes: EmailMailbox[] = [];
        try {
          mailboxes = await client.listEmailMailboxes();
        } catch {
          // Mailbox listing failed — proceed with defaults
        }

        // Step 2c: Resolve which channel (mailbox) to actually send from.
        let emailChannel: (typeof emailChannels)[number] | undefined;
        let sentFromOverride: { email: string; name?: string } | undefined;

        if (params.mailbox_id) {
          emailChannel = emailChannels.find((ch) => ch.email_mailbox?.id === params.mailbox_id);
          if (!emailChannel) {
            return wrapError({
              error: {
                code: "mailbox_not_available",
                message: `Mailbox '${params.mailbox_id}' is not available for this contact.`,
                recoverable: true,
                suggestion: "Use list_email_mailboxes to see valid mailbox IDs, then retry with a matching mailbox_id.",
              },
            });
          }
        } else if (params.from_email) {
          emailChannel = emailChannels.find((ch) => ch.email_mailbox?.email_address === params.from_email);
          if (!emailChannel) {
            // Custom sender address that isn't tied to a configured mailbox —
            // still send via the default (or first) channel, but report
            // from_email as the actual sender since that's what recipients see.
            const defaultMailbox = mailboxes.find((m) => m.is_default);
            emailChannel =
              (defaultMailbox && emailChannels.find((ch) => ch.email_mailbox?.id === defaultMailbox.id)) ||
              emailChannels[0];
            sentFromOverride = { email: params.from_email, name: params.from_name };
          }
        } else if (emailChannels.length > 1) {
          // Multiple mailboxes and no preference given — ask for clarification
          // instead of silently guessing which one to send from.
          const defaultMailbox = mailboxes.find((m) => m.is_default);
          return wrapResult({
            action_required: "choose_mailbox",
            message: `Multiple email mailboxes are configured. Which one should I send from?`,
            mailboxes: mailboxes.map((m) => ({
              id: m.id,
              email: m.email_address,
              name: m.name,
              is_default: m.is_default,
            })),
            default_mailbox: defaultMailbox
              ? { id: defaultMailbox.id, email: defaultMailbox.email_address, name: defaultMailbox.name }
              : undefined,
            hint: defaultMailbox
              ? `The default mailbox is "${defaultMailbox.name}" <${defaultMailbox.email_address}>. Call send_email again with mailbox_id="${defaultMailbox.id}" to use it, or pick a different one.`
              : "Call send_email again with the mailbox_id of your choice.",
          });
        } else {
          const defaultMailbox = mailboxes.find((m) => m.is_default);
          emailChannel =
            (defaultMailbox && emailChannels.find((ch) => ch.email_mailbox?.id === defaultMailbox.id)) ||
            emailChannels[0];
        }

        // Step 3: Wrap plain text in basic HTML if no HTML tags detected
        let bodyHtml = params.body;
        if (!/<[a-z][\s\S]*>/i.test(bodyHtml)) {
          bodyHtml = params.body
            .split("\n")
            .map((line) => (line.trim() === "" ? "<br>" : `<p>${line}</p>`))
            .join("\n");
        }

        // Step 4: Resolve any attachments to IDs (public URLs are fetched +
        // stored server-side first).
        const attachmentIds = await resolveAttachmentIds(client, params.attachments);

        // Step 5: Send. Two paths, because the initiate endpoint has NO
        // attachment field:
        //  - No attachments → POST /conversations/initiate (message_type=email).
        //    `channel_id` is how the backend picks the mailbox (it string-splits
        //    "email_mailbox_{id}" — see conversation_initiation_service.py), and
        //    this path applies include_signature.
        //  - With attachments → open-or-create the email conversation (no send)
        //    on the resolved channel, then compose-email with attachment_ids.
        //    compose-email does NOT append the signature.
        let messageId: string | undefined;
        let conversationId: string | undefined;

        if (attachmentIds.length > 0) {
          const conv = await client.openOrCreateConversation({
            contact_id: contact.id,
            channel_id: emailChannel.channel_id,
          });
          conversationId = conv.conversation_id;
          const composed = await client.composeEmail(conversationId, {
            subject: params.subject,
            html_body: bodyHtml,
            cc_emails: params.cc,
            bcc_emails: params.bcc,
            attachment_ids: attachmentIds,
            to_email: toEmail,
          });
          messageId = composed.email_message_id;
        } else {
          const result = await client.sendEmail({
            contact_id: contact.id,
            channel_id: emailChannel.channel_id,
            subject: params.subject,
            body_html: bodyHtml,
            cc: params.cc,
            bcc: params.bcc,
            include_signature: params.include_signature,
            from_email: params.from_email,
            from_name: params.from_name,
            to_email: toEmail,
          });
          messageId = result.message_id ?? undefined;
          conversationId = result.conversation_id;
        }

        // Report the mailbox that was actually used to send (resolved in Step 2c).
        const usedMailbox = emailChannel.email_mailbox;
        const sentFrom =
          sentFromOverride ?? (usedMailbox ? { email: usedMailbox.email_address, name: usedMailbox.name } : undefined);

        // The address actually used as the destination: the explicit override
        // when given, otherwise the resolved contact's primary email.
        const sentTo = toEmail ?? contact.email ?? undefined;

        return wrapResult({
          success: true,
          message_id: messageId,
          conversation_id: conversationId,
          channel_type: "email",
          contact: contact.name || contact.email || identifier,
          sent_to: sentTo,
          subject: params.subject,
          sent_from: sentFrom,
          cc: params.cc?.length ? params.cc : undefined,
          bcc: params.bcc?.length ? params.bcc : undefined,
          attachments: attachmentIds.length > 0 ? attachmentIds.length : undefined,
          hint: sentTo
            ? `Email sent to ${sentTo} with subject "${params.subject}".`
            : `Email sent to ${contact.name || identifier} with subject "${params.subject}".`,
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
