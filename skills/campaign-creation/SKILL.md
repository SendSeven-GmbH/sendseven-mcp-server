# Campaign Creation Workflow

Guide users through creating and sending messaging campaigns with SendSeven.

## Steps

### 1. Understand the Campaign Goal
Ask the user:
- What's the campaign about? (promotion, announcement, reminder, etc.)
- Who should receive it? (all contacts, specific tags, specific lists)
- Which channel? (WhatsApp, Telegram, SMS, push, email)

### 2. Check Prerequisites
Before creating the campaign:
- Use `list_channels` to verify the target channel is active
- Use `search_contacts` with relevant tags to estimate audience size
- For WhatsApp: remind that templates may be required for out-of-window messaging

### 3. Compose the Message
Help craft the message:
- Keep it concise (SMS: 160 chars, WhatsApp: 4096 chars, push: 200 chars)
- Include a clear call-to-action
- For email: draft a subject line too
- Avoid spam triggers (ALL CAPS, excessive punctuation)

### 4. Create the Campaign
Use `create_and_send_campaign` with `send_immediately=false` to create a draft first:
```
Tool: create_and_send_campaign
Params:
  name: "February Flash Sale"
  message: "Hi! 20% off all items today only. Shop now: [link]"
  channel: "whatsapp"
  send_immediately: false
```

### 5. Review Cost Estimate
The tool returns an estimated cost. Share it with the user:
- "This campaign will reach ~500 contacts"
- "Estimated cost: EUR 7.50 (at EUR 0.015/message)"

### 6. Confirm and Send
If the user approves:
- Re-call `create_and_send_campaign` with `send_immediately=true`
- Or suggest sending from the SendSeven dashboard for additional preview options

### 7. Monitor Results
After sending, suggest checking results later:
- "You can check delivery stats with `get_campaign_status`"
- "Campaign statistics will be available in a few minutes"

## Best Practices
- Always create as draft first for cost estimation
- Suggest A/B testing for large campaigns (send to small group first)
- Remind about GDPR: only message opted-in contacts
- Time campaigns for recipient timezone (business hours)
- For WhatsApp: respect the 24-hour messaging window
