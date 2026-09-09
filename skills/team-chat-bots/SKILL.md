# Team Chat Bot Messaging Workflow

Guide users through posting bot messages into SendSeven Team Chat — either to
a channel or directly to a team member.

## Steps

### 1. Determine the Destination

Ask whether the message should go to a **channel** (visible to everyone in
that channel) or a **direct message** to one person.

- Channel: identify it by UUID or name, e.g. `"#general"` or `"general"`. If
  you don't already know a valid channel, call `list_team_chat_channels`
  first — it returns each channel's `channel_ref` plus `allow_bots` and
  `is_archived`, so you can pick one that will actually accept a bot message.
  Pass `include_browsable=true` to also see channels the connected user
  hasn't joined yet.
- Direct message: identify the recipient's user ID (use `list_team_members`
  if you only have a name).

### 2. Check Channel Eligibility (channel messages only)

Bot messages to a channel require that channel's "Allow Bots to send
messages" setting to be enabled, and system channels (e.g.
`#knowledgebase`) never accept bot messages. If `send_team_chat_channel_message`
returns a 403, tell the user the channel needs "Allow Bots" turned on, or
suggest a different channel. Direct messages have no such restriction —
they always succeed once authenticated.

### 3. Compose the Message

- `text` — required, 1-40,000 characters.
- `bot_name` — optional display name (max 50 characters) so recipients can
  tell which integration/automation sent it, e.g. `"CI Bot"` or
  `"Deploy Notifier"`. This does not change the avatar — bot messages
  always show a bot avatar.

### 4. Attach Files (optional)

Two forms are supported, and can be combined:
- `attachment_ids` — IDs of files already uploaded to SendSeven.
- `attachments` — `{url, filename?}` entries for public image/video/audio
  URLs; SendSeven downloads them server-side.

### 5. Send It

```
Tool: send_team_chat_channel_message
Params:
  channel_ref: "#general"
  text: "Deploy finished successfully."
  bot_name: "CI Bot"
```

or

```
Tool: send_team_chat_direct_message
Params:
  user_id: "usr_abc123"
  text: "Your weekly report is ready."
  bot_name: "Reports Bot"
```

### 6. Confirm

Report back the message ID and, for channel messages, the channel it was
posted to; for direct messages, the DM conversation ID.

## Best Practices
- Prefer a descriptive `bot_name` so channel members can distinguish
  automated messages from real teammates.
- If a channel message fails with 403/404/409, don't retry blindly — surface
  the specific reason (bots disabled, channel not found, or archived) so the
  user can fix it or pick another channel.
- Team Chat **direct messages never trigger a webhook** — if you're building
  a workflow that reacts to Team Chat activity, only channel messages (from
  channels with "Allow Bots" enabled) are observable via the
  `team_chat.message.created` webhook event.
