---
name: triage-inbox
description: Triage the SendSeven shared inbox. Use when the user asks what needs a reply, which conversations are urgent, or wants help prioritizing, assigning, tagging, snoozing or closing conversations.
---

# Triage the inbox

## Steps

1. List what is waiting: call `list_conversations` with `needs_reply: true` and `status: "open"`.
2. Prioritize and present a short table: contact, channel, last message, how long it has waited. Treat long waits (over 2 hours), VIP tags and words like "cancel", "refund", "complaint" or "urgent" as high priority.
3. For a conversation the user wants to look at, call `get_conversation` and summarize the thread in two or three sentences.
4. Propose one action per conversation and wait for confirmation before acting:
   - Reply: draft the answer, then use the `reply-across-channels` skill.
   - Assign: `list_team_members`, then `assign_conversation`.
   - Tag: `list_tags`, then `tag_conversation`.
   - Park it: `snooze_conversation`.
   - Finish it: `close_conversation` (only if the customer's issue is resolved).
   - Leave context for colleagues: `add_internal_note` (never visible to the customer).
5. Finish with a summary of what was changed and what is still open.

## Rules

- Never close, reassign or snooze conversations in bulk without the user confirming the exact list.
- Do not reveal internal notes or other customers' data inside a reply.
