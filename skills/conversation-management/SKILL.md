# Conversation Management Workflow

Guide users through triaging, managing, and resolving customer conversations.

## Steps

### 1. Assess the Situation
Start by understanding the current state:
```
Tool: list_conversations
Params:
  needs_reply: true
  status: "open"
```
This shows conversations waiting for attention, prioritized by wait time.

### 2. Triage Priority
Help the user prioritize:
- **Urgent**: Long wait times (>2 hours), VIP tags, escalation keywords
- **Normal**: Standard inquiries, first-time contacts
- **Low**: Informational, follow-ups, automated messages

### 3. Review Conversation Context
Before responding, always check the full context:
```
Tool: get_conversation
Params:
  conversation_id: "the-conv-id"
```
Look for:
- Previous messages and resolution attempts
- Contact tags (VIP, Enterprise, etc.)
- Bot session status (was the bot handling this?)
- Channel type (response format may vary)

### 4. Search Knowledge Base
If the issue needs information:
```
Tool: query_knowledge_base
Params:
  query: "customer's specific question"
```
Use the KB answer to draft a response.

### 5. Draft and Send Response
Use `send_message_to_contact` to reply:
```
Tool: send_message_to_contact
Params:
  to: "contact-phone-or-email"
  message: "Your drafted response"
  channel: "whatsapp"  # Match the conversation's channel
```

### 6. Assign or Escalate
If the issue needs a specialist:
```
Tool: assign_conversation
Params:
  conversation_id: "the-conv-id"
  agent_name_or_id: "specialist-user-id"
```

### 7. Close When Resolved
When the issue is resolved:
```
Tool: close_conversation
Params:
  conversation_id: "the-conv-id"
  notes: "Resolved: refund processed for order #12345"
  summarize: true  # Creates KB ticket
```

## Best Practices
- Always read the conversation before replying
- Match the tone to the channel (formal for email, casual for WhatsApp)
- Use the knowledge base before crafting custom responses
- Add notes when closing for future reference
- Enable AI summarization to build the knowledge base over time
- Don't close conversations prematurely - confirm resolution with the customer
