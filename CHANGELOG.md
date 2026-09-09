# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-09

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
