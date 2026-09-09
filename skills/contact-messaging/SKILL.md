# Contact Lookup & Messaging Workflow

Guide users through finding contacts and sending them messages on the best channel.

## Steps

### 1. Identify the Contact
Ask the user who they want to message. Then search:
```
Tool: search_contacts
Params:
  query: "John Schmidt"  # or phone, email, tag
```

If multiple results, show the matches and ask the user to confirm.

### 2. Review Contact Details
For the matched contact, note:
- **Available channels**: WhatsApp, Telegram, Email, SMS, etc.
- **Tags**: VIP, Enterprise, Lead, etc.
- **History**: Recent conversations or interactions

### 3. Choose the Best Channel
Help select the right channel:
- **WhatsApp**: Best for quick, informal messages. Check 24h window.
- **Telegram**: Good for tech-savvy contacts.
- **Email**: Best for formal, detailed communications.
- **SMS**: Fallback when no messaging app available.
- **Auto**: Let SendSeven pick the best available channel.

### 4. Compose the Message
Help draft the message based on context:
- Professional tone for business contacts
- Concise for WhatsApp/SMS
- Detailed for email (include subject if applicable)
- Include relevant details (order numbers, dates, links)

### 5. Send the Message
```
Tool: send_message_to_contact
Params:
  to: "+49 170 1234567"  # or email or name
  message: "Hi John, your order #12345 has been shipped!"
  channel: "auto"
```

To attach a file, add `attachments`, e.g. `attachments: [{"url": "https://.../label.pdf", "filename": "label.pdf"}]`
(or `[{"id": "<attachment-id>"}]` for a file already uploaded to SendSeven).
On WhatsApp/Telegram, `message` becomes the caption of the first attachment.
`send_email` and `send_reply` accept the same `attachments` shape.

Outside WhatsApp's 24-hour messaging window, use `send_whatsapp_template`
with an approved template instead of `send_message_to_contact`.

### 6. Confirm Delivery
The tool returns delivery status. Inform the user:
- "Message sent via WhatsApp. Delivery status: delivered."
- If failed: "Message couldn't be delivered via WhatsApp. Try email instead?"

## Best Practices
- Always verify the contact before messaging (avoid wrong-person scenarios)
- Use "auto" channel selection when unsure - it picks the best option
- For new contacts, `send_message_to_contact` can auto-create them
- Respect channel-specific limits (WhatsApp templates outside 24h window)
- Check GDPR consent before marketing messages
