# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- 0.3.5: contact owner support. `search_contacts` filters by `owner_user_id`
  (user id, `me`, `none`) and returns `owner_user_id` / `owner`;
  `create_contact` and `update_contact` accept `owner_user_id` (`null` removes).
- Added `set_out_of_office` and `end_out_of_office` tools (the connected
  user's own absence and substitute), bringing the total to 45 tools.

- Added `get_attachment_summary` tool (read the AI summary of an inbound
  image/PDF; scope `messages:read`), bringing the total to 43 tools.
- `get_conversation` attachments now include `ai_summary`,
  `ai_summary_available` and `ai_summary_credits`.
- `create_webhook` accepts the new `attachment.summarized` event.

Initial public release of the SendSeven MCP server — a hosted, remote Model
Context Protocol server for the SendSeven unified messaging platform.

- **42 tools across 8 OAuth capability groups**: Conversations, Messaging,
  Email, Contacts, Campaigns, Knowledge Base, Webhooks, and Team Chat Bots.
- **27 granular OAuth scopes**, grouped for consent.
- OAuth 2.0 + PKCE with Dynamic Client Registration (DCR); API-token
  authentication for developer/CI use.
- Streamable-HTTP transport at `https://mcp.sendseven.com/mcp`, deployed on
  Cloudflare Workers with Durable Objects and KV-backed OAuth state.

See [docs/TOOLS.md](docs/TOOLS.md) for the full tool reference.
