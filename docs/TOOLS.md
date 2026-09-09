# Tool Reference

Complete reference for all 42 SendSeven MCP tools. Tools are registered
based on the capabilities you select during the OAuth connection — a tool only
appears if its required scopes were granted.

A handful of high-traffic read tools additionally declare an `outputSchema`
and return `structuredContent` alongside the usual text content, for clients
that prefer typed structured results over parsing JSON out of a text block:
`list_conversations`, `get_conversation`,
`search_contacts`, and `query_knowledge_base`. All other tools return
text-only content (a JSON blob inside a single text block) as before.

## Conversation Tools

### list_conversations

List and filter customer conversations.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `status` | string | No | Tab filter: "open" (excludes snoozed), "snoozed", "closed" |
| `assigned_to` | string | No | "me", "unassigned", "me_and_unassigned", or a user ID |
| `needs_reply` | boolean | No | Only conversations waiting for agent reply |
| `search` | string | No | Search by content, contact, or subject |
| `channel_type` | string | No | "whatsapp", "telegram", "sms", "email", "messenger", "instagram", "live_chat", "rcs" |
| `contact_id` | string | No | Only conversations with this contact |
| `page` | number | No | Page number (default: 1) |
| `page_size` | number | No | Results per page (default: 10, max: 50) |

**Required Scopes:** `conversations:read`

---

### get_conversation

Get a conversation with its recent messages (last 20), contact info, tags, and bot status.
Each message includes its `message_id`, delivery `status`, `error_message` (if any),
`attachments` (id/filename/content_type/file_size/url), and any per-message `meta`
(e.g. reactions under `meta.reactions`). For email-channel conversations, the response
additionally includes `email_thread` (each entry: `message_id`, `direction`, `from`, `to[]`,
`subject`, `body_html`, `body_text`, `attachment_count`, `status`, `sent_at`) and
`resolved_recipient` — the address the most recent outbound email actually went to, the
definitive way to verify a `send_email` destination.

**Parameters:** `conversation_id` (required)

**Required Scopes:** `conversations:read`

---

### send_reply

Reply to an existing conversation. Auto-detects the channel; email conversations
are answered through the threaded email reply endpoint (correct subject and
threading headers).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation to reply to |
| `text` | string | Yes | Reply text |
| `attachments` | array | No | Files to attach — each entry EITHER `{id}` (a previously-uploaded attachment) OR `{url, filename?}` (a public URL SendSeven downloads server-side). Works on both chat channels and threaded email replies. |

**Required Scopes:** `conversations:read`, `messages:create`

---

### close_conversation

Close a conversation with optional notes and AI summary.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation ID |
| `notes` | string | No | Closing notes (e.g., "Refund issued") |
| `summarize` | boolean | No | Generate AI summary for KB (default: true) |

**Required Scopes:** `conversations:update`

---

### reopen_conversation

Reopen a closed conversation.

**Parameters:** `conversation_id` (required)

**Required Scopes:** `conversations:update`

---

### snooze_conversation

Snooze a conversation until a given time, or clear an active snooze. Snoozed
conversations stay open but move off the Open tab.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation ID |
| `snooze_until` | string | No* | ISO 8601 datetime in the future (*required unless `unsnooze`) |
| `reopen_on_message` | boolean | No | Clear snooze on new customer message (default: true) |
| `unsnooze` | boolean | No | Clear an active snooze instead |

**Required Scopes:** `conversations:update`

---

### assign_conversation

Assign a conversation to a team member. `agent_name_or_id` must be a real
team member's user ID (or an unambiguous exact name match) — use
`list_team_members` first to find the correct ID; do not guess.

**Parameters:** `conversation_id`, `agent_name_or_id` (both required)

**Required Scopes:** `conversations:update`

---

### add_internal_note

Add an agent-only note to a conversation (never sent to the customer). Supports
@mentions and optional assignment in the same step.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation ID |
| `text` | string | Yes | Note text |
| `mentioned_user_ids` | string[] | No | Users to notify |
| `assign_to_user_id` | string | No | Also assign the conversation |

**Required Scopes:** `messages:create`

---

### email_conversation_transcript

Email the full conversation transcript as a branded HTML email — e.g. to send
the customer a copy after closing a ticket.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation ID |
| `to_email` | string | Yes | Recipient address |
| `note` | string | No | Note shown above the transcript |
| `mailbox_id` | string | No | Sender mailbox (default: the default mailbox) |
| `save_as_contact_method` | boolean | No | Save `to_email` on the contact (default: false) |

**Required Scopes:** `conversations:update`

---

## Messaging Tools

### send_message_to_contact

Send a message to a contact on the best available channel. Handles contact
lookup/creation, channel selection, and delivery.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `to` | string | Yes | Phone number or contact name |
| `message` | string | Yes | Message content |
| `channel` | string | No | "auto" (default), "whatsapp", "telegram", "messenger", "instagram", "sms" |
| `attachments` | array | No | Files to attach — each entry EITHER `{id}` (a previously-uploaded attachment) OR `{url, filename?}` (a public URL SendSeven downloads server-side). On WhatsApp/Telegram the text is delivered as the caption of the first attachment. |
| `create_if_not_exists` | boolean | No | Create contact if not found (default: true) |

**Required Scopes:** `messages:create`, `contacts:read`

---

### send_whatsapp_template

Send an approved WhatsApp template — required to reach contacts outside the
24-hour messaging window. Recipient can be a contact, a specific WhatsApp
contact method, a raw phone number/BSUID, or an existing conversation.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `template` | string | Yes | Template name or ID |
| `contact_id` | string | One of | Recipient contact |
| `contact_method_id` | string | One of | Specific WhatsApp contact-method UUID (`whatsapp_id` or `whatsapp_bsuid`). If given with `contact_id`, this wins. |
| `whatsapp_id` | string | One of | Phone number (leading `+` stripped), alphanumeric WhatsApp id, or Business-Scoped User ID (e.g. `US.1349...`, kept verbatim). AUTHENTICATION templates cannot be sent to a BSUID. |
| `conversation_id` | string | One of | Send into this conversation |
| `channel_id` | string | No | WhatsApp channel (if several are connected) |
| `language` | string | No | Template language, e.g. "en", "de" |
| `variables` | object | No | `{"1": "John"}` (positional) or `{"first_name": "John"}` (named). Reserved button keys: `url_suffix`/`url_suffix_<n>` (dynamic URL button, 0-based index `<n>` for templates with multiple such buttons) and `otp_code`/`otp_code_<n>` (authentication copy-code button). |
| `header_media_url` | string | No | Public https URL or attachment ID for an image/video/document header |
| `header_document_filename` | string | No | Filename shown to the recipient for a DOCUMENT header (with extension, e.g. "invoice.pdf"); ignored for image/video headers |
| `cards` | array | No | Per-card `{variables, header_media_url}` for a CAROUSEL template, positionally (entry 0 = first card). Only for carousel templates. |

**Required Scopes:** `messages:create`

---

### send_email

Send an email with subject, HTML body, CC/BCC, mailbox selection, and
attachments. The ONLY tool for sending email (regular messaging tools lack
email fields).

Recipient resolution: if `to` is a full email address (contains "@"), the
email is sent to that exact address — even if it's a non-primary contact
method, or doesn't match the matched contact's primary email. If `to` is a
name (no "@"), the email goes to the matched contact's primary email address.
The resolved destination is also echoed back as `sent_to` in the response,
and (for existing conversations) verifiable afterwards via `get_conversation`'s
`resolved_recipient` field.

Mailbox precedence when both are given: `mailbox_id` takes priority over
`from_email`. `from_email` must belong to a verified domain — use
`list_verified_email_domains` to check before sending if unsure.

**Parameters:** `to`, `subject`, `body` (required); `cc`, `bcc`,
`attachments` (each entry EITHER `{id}` OR `{url, filename?}` — see
`send_message_to_contact` above; note the sender's signature is NOT appended
when attachments are present), `include_signature`, `from_email`, `from_name`,
`mailbox_id`, `create_if_not_exists` (optional)

**Required Scopes:** `messages:create`

---

## Contact Tools

### search_contacts

Search contacts by name, phone, or email text, and/or filter by tag
membership. Each result includes `channels` (derived channel-type list) and
`contact_methods[]` — every individual method with its own `id`,
`method_type`, `value`, and `is_primary` flag.

**Parameters:** `query` (optional text search), `tag_id` (optional, one tag
id or an array of tag ids), `page`, `page_size` (optional). At least one of
`query`/`tag_id` is required.

**Required Scopes:** `contacts:read`

**Note:** `query` matches contact name/phone/email text only — it does NOT
match by *tag name*. To find contacts by tag, use `tag_id`: call `list_tags`
first to get the tag's id (never pass a tag name to `tag_id`). If both
`query` and `tag_id` are given, the text search applies within the set of
contacts carrying the tag(s). Multiple `tag_id` values match ANY of them
(OR), not all.

---

### create_contact

Create a new contact. At least one of `name`, `phone`, `email` required.

**Required Scopes:** `contacts:create`

---

### update_contact

Update an existing contact — only provided fields change.

**Parameters:** `contact_id` (required); `name`, `phone`, `email`,
`languages` (CSV of ISO 639-1 codes), `birthday` (YYYY-MM-DD) (optional)

**Required Scopes:** `contacts:update`

---

## Tag Tools

| Tool | Description | Scopes |
|------|-------------|--------|
| `list_tags` | List workspace tags (optionally filtered by name) | `contacts:read` or `conversations:read` |
| `create_tag` | Create a tag with optional color/description | `contacts:update` or `conversations:update` |
| `tag_conversation` / `untag_conversation` | Add/remove a tag on a conversation | `conversations:update` |
| `tag_contact` / `untag_contact` | Add/remove a tag on a contact | `contacts:update` |

---

## Campaign Tools

### list_contact_lists

List contact lists / newsletters with subscriber counts.

**Required Scopes:** `lists:read`

---

### list_campaigns

List messaging campaigns (WhatsApp, Telegram, SMS, browser push) with status
and delivery counts.

**Parameters:** `status` ("draft", "scheduled", "sending", "completed",
"paused", "failed", "cancelled"), `limit` (optional)

**Required Scopes:** `campaigns:read`

**Note:** the response's `total` reflects only the number of campaigns
returned in this call (bounded by `limit`), not a true server-side count —
the backend has no COUNT query for this list. If `total` equals your
requested `limit`, there may be more matching campaigns not shown; narrow
with `status` to check.

---

### get_campaign_status

Delivery statistics for a messaging campaign (sent/delivered/failed).

**Parameters:** `campaign_id` (required)

**Required Scopes:** `campaigns:read`

---

### create_and_send_campaign

Create a messaging campaign and optionally send it immediately or schedule it.
Supports WhatsApp (incl. template campaigns), Telegram, SMS, browser push, and
basic email.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Campaign name |
| `message` | string | Yes | Message content |
| `channel` | string | No | "whatsapp", "telegram", "sms", "browser_push", "email" (omit = all channels) |
| `list_ids` | string[] | No | Target list IDs |
| `send_immediately` | boolean | No | Send now (default: false = draft) |
| `scheduled_at` | string | No | ISO 8601 schedule time |
| `message_type` | string | No | "text" or "whatsapp_template" |
| `template_name` / `template_language` | string | No | For WhatsApp template campaigns |
| `browser_push_title` / `target_url` | string | No | For browser push |
| `all_contacts` | boolean | No | Ignore newsletter subscription status (default: false) |

**Required Scopes:** `campaigns:create` (+ `campaigns:send` to send)

---

### list_email_campaigns / get_email_campaign_analytics

List email campaigns with stats; get detailed analytics (opens, clicks,
bounces) for one campaign.

**Required Scopes:** `campaigns:read`

**Note:** each row from `list_email_campaigns` carries two different IDs:
`id` (this campaign's own identifier — pass this to
`get_email_campaign_analytics`) and `campaign_id` (an internal reference to a
related base campaign record — do not pass this). If you accidentally pass a
`campaign_id` value, `get_email_campaign_analytics` automatically looks it up
and retries with the correct `id` behind the scenes, so either value works,
but prefer `id` going forward.

---

## Knowledge Base Tools

### query_knowledge_base

AI-powered search across FAQ, website content, uploads, and ticket summaries.
Returns an answer with source citations — each source includes `title` and
`uri` as separate fields (not collapsed into one `source` string).

**Parameters:** `query` (required); `folder_id`, `limit` (optional)

**Required Scopes:** `knowledge_base:read`

### list_knowledge_base_folders

List the knowledge base's folder tree (e.g. "General", "Websites", "Ticket
Summaries", plus any custom folders), each with its own `id` and
`document_count`. Use a folder's `id` as `query_knowledge_base`'s `folder_id`
to search within just that folder.

**Required Scopes:** `knowledge_base:read`

---

## Channel Tools

| Tool | Description | Scopes |
|------|-------------|--------|
| `list_channels` | Connected channels with health status | `channels:read` |
| `list_email_mailboxes` | Email sender identities (mailboxes) | `channels:read` |
| `list_verified_email_domains` | Domains verified with your email provider(s), for validating `send_email`'s `from_email` | `channels:read` |
| `list_whatsapp_templates` | Approved WhatsApp templates (name, language, body, buttons, header type, carousel flag) with true pagination (`offset`) | `channels:read` |
| `get_whatsapp_template` | Full detail for one WhatsApp template by ID — carousel cards, quick-reply captions, default header media, parameter format | `channels:read` |

**Note on `list_channels` health:** connection-error monitoring currently
only covers `email`, `messenger`, and `instagram` channels. WhatsApp,
Telegram, SMS, live chat, and RCS channels report `health="not_monitored"` —
that means no connection-error monitoring exists for them yet, NOT that
something is wrong. Only trust the `health` field for the three monitored
types.

---

## Team Tools

### list_team_members

List team members with user IDs, roles, and status — needed for
`assign_conversation` and `add_internal_note` mentions.

**Required Scopes:** `team:read`

---

## Team Chat Bot Tools

Post messages into SendSeven Team Chat as a bot, and discover channels to post
to. Bot messages always render with a bot avatar. Sending is gated on the
bot-only `teamchat:write` scope (note the missing underscore, deliberately
distinct from the human `team_chat:*` scopes used by the product's own
UI/RBAC); listing channels is gated on the separate, read-only
`team_chat:read` scope.

### list_team_chat_channels

List Team Chat channels, for discovering a valid `channel_ref` before calling
`send_team_chat_channel_message`. Read-only.

- `include_browsable` (optional) — `false`/omitted (default): channels the
  connected user has already joined. `true`: channels that exist but the user
  hasn't joined yet. A channel doesn't need to be joined for
  `send_team_chat_channel_message` to work — only `allow_bots=true` and not
  archived matter — so browse mode helps find post-able channels the user
  hasn't personally joined.
- `include_archived` (optional) — only applies when `include_browsable` is
  false; include archived channels in the joined-channels list (default false).
- `search` (optional) — only applies when `include_browsable` is true;
  case-insensitive filter over browsable channel name/display name.

Each returned channel includes `id`, `channel_ref` (e.g. `"#general"`, ready
to pass to `send_team_chat_channel_message`), `name`, `display_name`,
`channel_type`, `scope`, `is_system`, `is_external`, `member_count`,
`allow_bots` (must be true for bot messages to be accepted), and
`is_archived` (archived channels always reject bot messages).

**Required Scopes:** `team_chat:read`

### send_team_chat_channel_message

Post a message to a Team Chat channel as a bot.

- `channel_ref` (required) — the channel UUID, or a name such as `"#general"` or `"general"`.
- `text` (required) — 1-40,000 characters.
- `bot_name` (optional) — display name for the bot, max 50 characters. Does not affect the avatar, which is always the bot avatar.
- `attachment_ids` (optional) — previously-uploaded attachment IDs.
- `attachments` (optional) — richer form, each entry `{id}` (existing attachment) or `{url, filename?}` (a public URL SendSeven downloads server-side). Both attachment forms may be combined; use whichever you have.

The channel must have "Allow Bots to send messages" enabled in its Team Chat
settings — this is a per-channel toggle, not a blanket system-channel
restriction: regular channels like `#general`/`#shoutbox` default to allowing
bots like any other channel. The one hardcoded exception is the AI Knowledge
Base channel (`#knowledgebase`), which permanently rejects bot messages
regardless of the toggle. Archived channels also reject bot messages
(403 / 409).

**Required Scopes:** `teamchat:write`

### send_team_chat_direct_message

Send a Team Chat direct message to a user as a bot.

- `user_id` (required) — the team member's user ID.
- `text` (required) — 1-40,000 characters.
- `bot_name`, `attachment_ids`, `attachments` — same as above.

Always allowed once authenticated — there is no "Allow Bots" setting or
channel restriction for direct messages.

**Required Scopes:** `teamchat:write`

### Receiving Team Chat messages (trigger)

There is no dedicated MCP tool for *receiving* Team Chat messages. The
underlying event, `team_chat.message.created`, is a normal webhook event:
it's listed in `create_webhook`'s description and subscribable via
`create_webhook` with no extra code. Two limitations to be aware of:

- **Channel-only:** this event fires only for messages posted to a Team Chat
  **channel** that has "Allow Bots" enabled. Team Chat **direct messages
  never emit a webhook event** — there is no way to subscribe to DMs.
- **No channel filter:** `create_webhook` has no per-channel filter
  parameter, so a subscription receives events from every eligible channel.
  Filter by `data.channel.id` / `data.channel.name` in your webhook receiver.

---

## Attachment Tools

### upload_attachment

Upload a file from a public URL so it can be reused as an attachment across
multiple sends (`send_reply`, `send_email`, `send_message_to_contact`,
Team Chat messages) without re-uploading the URL each time. The same URL
uploaded twice for a tenant returns the existing attachment rather than
duplicating it.

**Parameters:** `url` (required); `filename` (optional)

**Required Scopes:** `messages:create`

There is deliberately no "list attachments" tool — the backend has no
endpoint to enumerate previously-created attachments; save the returned
`id` if you'll need it again.

---

## Webhook Tools (Developer)

| Tool | Description | Scopes |
|------|-------------|--------|
| `list_webhooks` | List webhook endpoints with health/failure info | `webhooks:read` |
| `create_webhook` | Create an endpoint (name, HTTPS url, events, optional auth header) | `webhooks:create` |
| `delete_webhook` | Delete an endpoint | `webhooks:delete` |

`create_webhook`'s description enumerates the full set of subscribable event
types (grouped by category) and its `events` param is a Zod enum over the
same list, so no separate discovery tool is needed.

---

## Error Responses

All tools return structured errors:

```json
{
  "error": {
    "code": "contact_not_found",
    "message": "No contact found matching '+49123456789'",
    "recoverable": true,
    "suggestion": "Try searching by name, or set create_if_not_exists=true"
  }
}
```

| Code | Meaning | Recoverable |
|------|---------|-------------|
| `unauthorized` | Token expired or invalid | No |
| `forbidden` | Insufficient permissions | No |
| `not_found` | Resource doesn't exist | Yes |
| `validation_error` | Invalid input | Yes |
| `rate_limited` | Too many requests | Yes |
| `no_channels` | Contact has no reachable channels | Yes |
| `contact_not_found` | Contact search returned no results | Yes |
| `missing_recipient` | No recipient selector provided | Yes |
| `template_send_failed` / `whatsapp_<code>` | Meta rejected the template send | Yes |
