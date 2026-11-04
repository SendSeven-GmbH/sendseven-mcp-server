---
name: get-started
description: Onboard a new SendSeven user. Use when the user first connects SendSeven, asks what it can do, or asks how to get started with their shared inbox, contacts, campaigns or team chat.
---

# Get started with SendSeven

SendSeven is a unified messaging platform. One workspace holds WhatsApp, Instagram, Telegram, Messenger, SMS and email conversations in a single inbox, plus contacts, campaigns, a knowledge base and team chat. This plugin connects to the user's own SendSeven workspace; it only sees what the connected account is allowed to see.

## First steps

1. Call `check_permissions` to see which capabilities the user granted. Tools for scopes that were not granted are not available. If something is missing, tell the user to reconnect and approve more access on the SendSeven consent screen.
2. Call `list_channels` to show which channels (WhatsApp, Instagram, email, ...) are connected.
3. Call `list_conversations` with `needs_reply: true` and `status: "open"` to show what is waiting for an answer, and offer to triage it.

## What you can offer next

- Triage and answer the inbox (see the `triage-inbox` and `reply-across-channels` skills).
- Look up or create contacts (`search_contacts`, `create_contact`) and tag them.
- Check campaign results (`list_campaigns`, `get_campaign_status`).
- Search the knowledge base (`query_knowledge_base`) to draft accurate answers.
- Post to a team chat channel (`send_team_chat_channel_message`).

## Ground rules

- Sending a message, closing a conversation, creating a campaign or deleting a webhook affects real customers. Always show the draft or the exact action and get the user's explicit confirmation first.
- Never invent contact data, order numbers or promises. Use only what the tools return.
- Messaging rules differ by channel (for example the WhatsApp 24-hour window). If a send fails, explain the error in plain language and offer an alternative such as an approved WhatsApp template or email.
- Stay inside the connected workspace. Do not attempt to read other workspaces or accounts.
