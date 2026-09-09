# SendSeven MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Server-blue)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

The official [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [SendSeven](https://sendseven.com) - the unified messaging API platform for WhatsApp, Instagram DMs, Telegram, SMS, Messenger, Live Chat, and Email.

Connect your SendSeven account to Claude, ChatGPT, Gemini, Cursor, or any MCP-compatible AI assistant to manage your unified inbox, send omnichannel messages (WhatsApp, Instagram private replies, Telegram, SMS, Messenger, email), run marketing campaigns, staff a team chat bot, and search your knowledge base using natural language — all through your existing customer support and messaging API platform.

## Quick Start

### Option 1: Remote Server (Recommended)

No installation needed. Add to your AI client:

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "sendseven": {
      "url": "https://mcp.sendseven.com/mcp",
      "auth": {
        "type": "oauth2",
        "authorizationUrl": "https://mcp.sendseven.com/authorize",
        "scopes": ["conversations:read", "messages:create", "contacts:read"]
      }
    }
  }
}
```

**Claude Code** (`.claude/settings.json`):
```json
{
  "mcpServers": {
    "sendseven": {
      "url": "https://mcp.sendseven.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

**ChatGPT** (Settings > Connectors > Add custom connector):
```
MCP Server URL: https://mcp.sendseven.com/mcp
Authentication: OAuth
```
ChatGPT walks you through the OAuth consent + capability picker automatically — no config file needed.

### Option 2: API Token (Developer Setup)

For developers and CI/CD pipelines, use a static API token:

1. Generate an API token in SendSeven: **Settings > API Tokens**
2. Configure your MCP client with the token as a Bearer header

### Option 3: Self-Hosted

```bash
git clone https://github.com/SendSeven-GmbH/sendseven-mcp-server.git
cd sendseven-mcp-server
npm install
npm run dev  # Runs on localhost:8787
```

## What Can It Do?

### Support Operations
- "Show me open conversations" - List and filter conversations
- "What's the conversation with John about?" - View conversation details
- "Close ticket #123 with notes: refund issued" - Close conversations
- "Assign this to Sarah" - Route to team members

### Messaging
- "Send a WhatsApp to +49 170 1234567: Your order is ready" - Multi-channel messaging
- "Email john@example.com about the meeting" - Auto-detect best channel
- "Find all VIP customers" - Contact search

### Marketing
- "Create a push notification campaign about our flash sale" - Campaign creation
- "Send an email newsletter to our enterprise list" - Email campaigns
- "How much would a WhatsApp campaign cost?" - Cost estimation

### Knowledge Base
- "What does our FAQ say about refunds?" - AI-powered KB search
- "How do I set up WhatsApp integration?" - Self-service answers

## Available Tools

Tools are registered based on the capabilities selected during the OAuth
connection. The table below groups tools by function for readability; the
OAuth consent screen groups the same 42 tools into 8 coarser capability
groups (Conversations, Messaging, Email, Contacts, Campaigns, Knowledge Base,
Webhooks, Team Chat Bots) — granting a group grants every tool
listed under it below. Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md).

| Category | Tools |
|----------|-------|
| **Conversations** | `list_conversations`, `get_conversation`, `send_reply`, `close_conversation`, `reopen_conversation`, `snooze_conversation`, `assign_conversation`, `add_internal_note`, `email_conversation_transcript` |
| **Messaging** | `send_message_to_contact`, `send_whatsapp_template`, `send_email`, `upload_attachment` |
| **Contacts** | `search_contacts`, `create_contact`, `update_contact` |
| **Tags** | `list_tags`, `create_tag`, `tag_conversation`, `untag_conversation`, `tag_contact`, `untag_contact` |
| **Campaigns** | `list_contact_lists`, `list_campaigns`, `get_campaign_status`, `create_and_send_campaign`, `list_email_campaigns`, `get_email_campaign_analytics` |
| **Knowledge Base** | `query_knowledge_base`, `list_knowledge_base_folders` |
| **Channels** | `list_channels`, `list_email_mailboxes`, `list_verified_email_domains`, `list_whatsapp_templates`, `get_whatsapp_template` |
| **Team** | `list_team_members` |
| **Team Chat Bots** | `list_team_chat_channels`, `send_team_chat_channel_message`, `send_team_chat_direct_message` |
| **Webhooks (Developer)** | `list_webhooks`, `create_webhook`, `delete_webhook` |

## Authentication

### OAuth 2.0 + PKCE (Recommended)

The server is a full OAuth 2.0 authorization server for MCP clients, with
Dynamic Client Registration (DCR) so you don't need to pre-register an app:

| Endpoint | URL |
|----------|-----|
| MCP endpoint | `https://mcp.sendseven.com/mcp` (Streamable HTTP) |
| Authorization | `https://mcp.sendseven.com/authorize` |
| Token | `https://mcp.sendseven.com/token` |
| Dynamic Client Registration | `https://mcp.sendseven.com/register` |

Most MCP clients (Claude, Cursor, etc.) discover these automatically from
`https://mcp.sendseven.com/mcp` and only need the base URL — see the
`claude-desktop.json` example above and the [examples/](examples/) directory.
For a client that needs the flow spelled out:

1. The client registers itself via DCR (`POST /register`) and receives a `client_id`.
2. The client sends the user to `/authorize` with a PKCE `code_challenge` and the requested scopes.
3. The user logs in with their SendSeven account and approves the requested scopes on the consent screen.
4. The authorization code is redeemed at `/token` (with the PKCE `code_verifier`) for an access + refresh token.
5. The access token is sent as a Bearer token on every MCP request; the server refreshes it automatically using the refresh token.

Users can only grant scopes their SendSeven role already has - a Support
Agent without campaign permissions never sees campaign tools, regardless of
what the client requests.

### API Tokens (Developer)
Generate a token in SendSeven's dashboard (**Settings > API Tokens**) and pass it as a Bearer header — simpler for CI/CD and scripts, but it doesn't auto-refresh and must be rotated manually.

## Claude Skills

The repository includes workflow guides (Skills) that teach AI assistants best practices:

- **Campaign Creation** - Step-by-step campaign workflow
- **Conversation Management** - Triage, respond, and resolve
- **Contact Messaging** - Find contacts and message them
- **Team Chat Bots** - Post bot messages to Team Chat channels and users

## Configuration Examples

See the `examples/` directory for configuration files:
- `claude-desktop.json` - Claude Desktop
- `claude-code.json` - Claude Code CLI
- `cursor.json` - Cursor IDE

## Pricing

**Free for all SendSeven customers.** MCP server access is included in every plan.

- Read operations: unlimited (within rate limits)
- Write operations: billed as regular API usage
- Rate limits: 20-500 req/min depending on plan

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Deploy to Cloudflare Workers
npm run deploy
```

## Security

- OAuth 2.0 with PKCE (no client secret in browser)
- All tokens encrypted at rest
- Scope-based access control (27 granular OAuth scopes, grouped into 8 capability groups for consent)
- Tenant isolation (no cross-tenant data access)
- Rate limiting per plan
- Token revocation via SendSeven settings

## License

MIT - see [LICENSE](LICENSE)

## Links

- [SendSeven](https://sendseven.com) - The unified messaging API
- [MCP Specification](https://modelcontextprotocol.io/) - Model Context Protocol
- [API Documentation](https://api.sendseven.com/api/v1/docs) - SendSeven REST API
