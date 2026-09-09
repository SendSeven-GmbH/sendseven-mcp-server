/**
 * Messaging Tools
 *
 * High-level tool for sending messages to contacts across any channel.
 * The backend handles contact lookup, conversation resolution, and channel selection.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext, Contact, AvailableChannelResponse } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

/**
 * Dual attachment input: EITHER a pre-uploaded attachment `{id}`, OR a public
 * `{url, filename?}` that SendSeven fetches server-side. Mirrors the team-chat
 * tools' schema. URLs are resolved to attachment IDs client-side (via
 * POST /attachments/from-url) before hitting POST /messages, which accepts
 * attachment IDs only — never raw URLs.
 */
const attachmentInputSchema = z.union([
  z.object({ id: z.string().describe("A previously-uploaded attachment ID") }),
  z.object({
    url: z.string().describe("Public image, video, audio, or document URL - SendSeven downloads it server-side"),
    filename: z.string().optional().describe("Optional filename for the downloaded attachment (include the correct extension, e.g. invoice.pdf)"),
  }),
]);

type AttachmentInput = { id: string } | { url: string; filename?: string };

/**
 * Resolve dual-form attachments to a flat list of attachment IDs. `{url}`
 * entries are fetched+stored server-side first (their filename, if given, is
 * persisted as the attachment's filename); `{id}` entries pass straight
 * through. Order is preserved.
 */
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

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["messages:create"])) return;

  server.tool(
    "send_message_to_contact",
    `Send a message to a contact on the best available channel (WhatsApp, Telegram, SMS, Messenger, Instagram). Finds the contact by phone number or name. If no open conversation exists, one is created automatically.

For sending EMAILS, use the send_email tool instead — it supports subject lines, HTML body, CC/BCC.

Attachments (images, video, audio, documents): pass the attachments array. Each entry is EITHER {"id": "<attachment-id>"} for a file already uploaded to SendSeven, OR {"url": "https://...", "filename": "photo.jpg"} for a public URL that SendSeven downloads server-side. On WhatsApp/Telegram each attachment is delivered with the text as the caption of the first one.

Examples:
- "Send WhatsApp to +49 170 1234567: Hey, your order is ready"
- "Message Lisa: Can you call me back?"
- "SMS +49 170 1234567: Your appointment is tomorrow"
- "WhatsApp the product photo to Lisa" → to="Lisa", message="Here it is!", attachments=[{"url": "https://.../photo.jpg"}]`,
    {
      to: z.string().describe("Contact identifier: phone number (e.g., +49170123456) or contact name"),
      message: z.string().describe("The message to send"),
      channel: z.enum(["auto", "whatsapp", "telegram", "messenger", "instagram", "sms"]).optional().describe("Channel to use. 'auto' (default) picks the best available channel. For email, use the send_email tool."),
      attachments: z.array(attachmentInputSchema).optional().describe('Files to attach. Each entry is EITHER {"id": "<attachment-id>"} (already uploaded) OR {"url": "https://...", "filename?": "..."} (public URL, downloaded server-side).'),
      create_if_not_exists: z.boolean().optional().describe("Create contact if not found (default: true)"),
    },
    { title: "Send Message to Contact", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const identifier = params.to.trim();

        // Step 1: Find or create the contact
        let contact: Contact | undefined;

        const contacts = await client.searchContacts({ search: identifier, page_size: 5 });

        if (contacts.items.length > 0) {
          contact = contacts.items[0];
        } else if (params.create_if_not_exists !== false) {
          const isEmail = identifier.includes("@");
          const isPhone = /^\+?\d[\d\s-]{6,}$/.test(identifier);
          contact = await client.createContact({
            phone: isPhone ? identifier : undefined,
            email: isEmail ? identifier : undefined,
            name: !isEmail && !isPhone ? identifier : undefined,
          });
        } else {
          return wrapError({
            error: {
              code: "contact_not_found",
              message: `No contact found matching '${identifier}'`,
              recoverable: true,
              suggestion: "Try searching by phone number, email, or name. Or set create_if_not_exists=true to auto-create.",
            },
          });
        }

        // Step 2: Resolve channel - always needed to get channel_id and external recipient ID
        const channelsResponse = await client.getContactAvailableChannels(contact.id);
        const availableChannels = channelsResponse.channels;

        if (availableChannels.length === 0) {
          return wrapError({
            error: {
              code: "no_channels",
              message: `Contact '${contact.name || identifier}' has no available channels.`,
              recoverable: true,
              suggestion: "The contact needs a phone number or email address to be reachable.",
            },
          });
        }

        let selectedChannel: AvailableChannelResponse;

        if (params.channel && params.channel !== "auto") {
          const match = availableChannels.find((ch) => ch.channel_type === params.channel);
          if (!match) {
            const available = availableChannels.map((ch) => ch.channel_type).join(", ");
            return wrapError({
              error: {
                code: "channel_unavailable",
                message: `Channel '${params.channel}' is not available for this contact. Available: ${available}`,
                recoverable: true,
                suggestion: `Try one of: ${available}`,
              },
            });
          }
          selectedChannel = match;
        } else {
          // Auto: pick the first available channel
          selectedChannel = availableChannels[0];
        }

        // Step 3: Confirm the resolved channel has a deliverable identifier.
        // available-channels already resolves the per-channel external recipient
        // id (AvailableChannelResponse.identifier), so trust it here.
        if (!selectedChannel.identifier) {
          return wrapError({
            error: {
              code: "missing_recipient_id",
              message: `Contact '${contact.name || identifier}' doesn't have a ${selectedChannel.channel_type} identifier.`,
              recoverable: true,
              suggestion: "Update the contact with the required identifier (phone, etc.).",
            },
          });
        }

        // Step 4: Resolve any attachments to IDs (public URLs are fetched +
        // stored server-side first; POST /messages accepts IDs only).
        const attachmentIds = await resolveAttachmentIds(client, params.attachments);

        // Step 5: Send message. Address via contact_id + channel_id (NOT `to`);
        // a non-empty `to` short-circuits backend contact resolution. The backend
        // finds/creates the conversation from contact_id + channel_id.
        const result = await client.sendMessageToContact({
          contact_id: contact.id,
          text: params.message,
          channel_id: selectedChannel.channel_id,
          attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
        });

        return wrapResult({
          success: true,
          message_id: result.id,
          conversation_id: result.conversation_id,
          channel_used: selectedChannel.channel_type,
          contact: contact.name || identifier,
          hint: `Message sent to ${contact.name || identifier} via ${selectedChannel.channel_type}.`,
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "send_whatsapp_template",
    `Send an approved WhatsApp template message. Templates are required to reach contacts OUTSIDE the 24-hour messaging window. Use list_whatsapp_templates to see available templates and their variables.

Identify the recipient with ANY ONE of:
- contact_id — a SendSeven contact
- contact_method_id — a specific WhatsApp contact-method UUID (whatsapp_id or whatsapp_bsuid). Highest priority: if given with contact_id, this wins.
- whatsapp_id — sent directly: a phone number (leading '+' is stripped), an alphanumeric WhatsApp id, OR a Business-Scoped User ID like "US.13491208655302741918" (kept verbatim). Note: AUTHENTICATION templates cannot be sent to a BSUID.
- conversation_id — send into an existing conversation

Template body variables (via the variables object):
- Positional templates: variables={"1": "John", "2": "ORD-98765"}
- Named templates: variables={"first_name": "John", "order_id": "ORD-98765"}
- Omit variables entirely to auto-fill from the contact's profile via the template's variable mapping.

Button reserved keys (put INSIDE the variables object; only valid as a dict):
- "url_suffix" — fills the {{1}} placeholder inside a dynamic URL button. Pass ONLY the suffix, not the full URL. Targets button index 0.
- "url_suffix_<n>" — same, but addresses the button at 0-based index <n> (e.g. "url_suffix_1" for the second button). Use these when a template has MULTIPLE dynamic URL buttons.
- "otp_code" — the code for an authentication/OTP copy-code button (index 0).
- "otp_code_<n>" — indexed variant for templates with more than one copy-code button.

Header media / documents:
- header_media_url — for IMAGE/VIDEO/DOCUMENT headers. Accepts a public https URL (customer CDN etc.) OR a bare attachment ID. To attach a PDF/doc you already have locally, upload it first, then pass its attachment ID here.
- header_document_filename — filename shown to the recipient for a DOCUMENT header (include the extension, e.g. "invoice.pdf"). Ignored for image/video headers.

Carousel templates: pass cards — one entry per card, POSITIONALLY (entry 0 = first card). Each card has its own variables (same rules as top-level) and its own header_media_url.

Examples:
- "Send the order_update template to +49 170 1234567" → template="order_update", whatsapp_id="+491701234567", variables={"1": "..."}
- "Send appointment_reminder to contact X in German" → template="appointment_reminder", contact_id="...", language="de"
- "Send invoice_ready with the PDF" → template="invoice_ready", contact_id="...", header_media_url="https://.../inv.pdf", header_document_filename="invoice-2026-001.pdf"`,
    {
      template: z.string().describe("Template name or template ID"),
      contact_id: z.string().optional().describe("Recipient contact ID (one of contact_id / contact_method_id / whatsapp_id / conversation_id required)"),
      contact_method_id: z.string().optional().describe("Recipient WhatsApp contact-method UUID (whatsapp_id or whatsapp_bsuid). If given with contact_id, this wins."),
      whatsapp_id: z.string().optional().describe("Recipient sent directly: phone number (leading '+' stripped), alphanumeric WhatsApp id, or Business-Scoped User ID like 'US.1349...' (kept verbatim)"),
      conversation_id: z.string().optional().describe("Send into this existing conversation"),
      channel_id: z.string().optional().describe("WhatsApp channel to send from (needed only if multiple WhatsApp channels are connected)"),
      language: z.string().optional().describe("Template language code, e.g. 'en', 'de'. Needed when the template exists in multiple languages and was addressed by name."),
      variables: z.record(z.string()).optional().describe('Body variable values, e.g. {"1": "John"} (positional) or {"first_name": "John"} (named). Reserved keys for buttons: url_suffix, url_suffix_<n>, otp_code, otp_code_<n>.'),
      header_media_url: z.string().optional().describe("Public https URL OR attachment ID of the image/video/document for a media header"),
      header_document_filename: z.string().optional().describe('Filename for a DOCUMENT header, with extension (e.g. "invoice.pdf"). Ignored for image/video headers.'),
      cards: z.array(
        z.object({
          variables: z.record(z.string()).optional().describe("This card's body variables (same rules as top-level variables, including reserved button keys)"),
          header_media_url: z.string().optional().describe("This card's header media (public https URL or attachment ID)"),
        })
      ).optional().describe("Per-card parameters for a CAROUSEL template, positionally (entry 0 = first card). Only for carousel templates."),
    },
    { title: "Send WhatsApp Template", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      if (!params.contact_id && !params.contact_method_id && !params.whatsapp_id && !params.conversation_id) {
        return wrapError({
          error: {
            code: "missing_recipient",
            message: "Provide one of: contact_id, contact_method_id, whatsapp_id, or conversation_id.",
            recoverable: true,
            suggestion: "Use search_contacts to find the contact, or pass the phone number as whatsapp_id.",
          },
        });
      }

      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.sendWhatsAppTemplate(params.template, {
          contact_id: params.contact_id,
          contact_method_id: params.contact_method_id,
          whatsapp_id: params.whatsapp_id,
          conversation_id: params.conversation_id,
          channel_id: params.channel_id,
          language: params.language,
          variable_values: params.variables,
          header_media_url: params.header_media_url,
          header_document_filename: params.header_document_filename,
          // Tool exposes `variables` per card for consistency with the top-level
          // field; the backend's per-card shape uses `variable_values`.
          cards: params.cards?.map((c) => ({
            variable_values: c.variables,
            header_media_url: c.header_media_url,
          })),
        });

        if (!result.success) {
          return wrapError({
            error: {
              code: result.error_code ? `whatsapp_${result.error_code}` : "template_send_failed",
              message: result.error || "Template send failed.",
              recoverable: true,
              suggestion: result.error_details || "Check the template variables and recipient, then try again.",
            },
            conversation_id: result.conversation_id,
          });
        }

        return wrapResult({
          success: true,
          message_id: result.message_id,
          external_id: result.external_id,
          conversation_id: result.conversation_id,
          template: params.template,
          hint: "Template message sent via WhatsApp.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
