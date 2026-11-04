---
name: reply-across-channels
description: Draft and send a customer reply from SendSeven on the right channel. Use when the user wants to answer a conversation, message a contact, send a WhatsApp template or send an email.
---

# Reply across channels

## Replying inside an existing conversation

1. Call `get_conversation` to read the thread and see the channel.
2. If the answer depends on company knowledge, call `query_knowledge_base` and base the draft on what it returns. Say so if nothing relevant is found; do not guess.
3. Draft a reply that fits the channel: short and friendly for WhatsApp, Telegram and SMS; structured with a subject for email.
4. Show the draft and ask for confirmation. Then call `send_reply`.

## Messaging a contact with no open conversation

1. Find the contact with `search_contacts`. If several match, ask which one.
2. Send with `send_message_to_contact` (channel `auto` lets SendSeven choose), or `send_email` for formal email.
3. For WhatsApp outside the 24-hour customer-service window, a free-form message is rejected. Use `list_whatsapp_templates`, pick an approved template, fill its variables with real data and send it with `send_whatsapp_template`.

## Rules

- Always get explicit confirmation of the final text and the recipient before sending. Sent messages cannot be recalled.
- Respect opt-outs: if SendSeven reports that a contact is blocked or unsubscribed, do not look for a workaround; tell the user.
- Mass sends are out of scope for this skill. For campaigns use `list_campaigns` and review results, and only create one when the user clearly asks and confirms the audience.
