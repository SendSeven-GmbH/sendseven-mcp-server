# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - Agent Builder

- Added the **Agent Builder**: 24 new tools (69 total) in four new capability groups, all on by default:
  Agent Builder (`list_agents`, `get_agent`, `create_agent`, `update_agent_draft`, `set_agent_skills`,
  `set_agent_knowledge_sources`, `test_agent`, `get_agent_readiness`, `publish_agent`,
  `attach_agent_to_channel`, `upsert_skill`, `manage_skill_versions`), Knowledge Base Authoring
  (`list_knowledge_base_documents`, `create_knowledge_base_folder`, `upsert_knowledge_base_document`,
  `crawl_website`, `upsert_faq_entries`), Contact Data Model (`manage_custom_fields`, `manage_lists`) and
  Flows (`validate_flow`, `save_flow_draft`, `publish_flow`, `test_flow`). All existing tools are unchanged.
- Safety: agents are always created unpublished and inactive; `publish_agent` and `publish_flow` need
  `confirm=true` and carry the destructive annotation; edits go to the draft (with `base_revision` and one
  automatic retry on conflict); creates are idempotent by name/slug/key.
- Added MCP prompts `build_conversational_agent`, `write_skill`, `design_agent_flow` and MCP resources
  `sendseven://guides/{flow-format-spec,skills-and-goals,agent-fields,run-assistant-node}`, generated from
  developer_docs by `npm run generate:guides` (a test checks they are fresh).
- Permission errors: a 403 for a scope this connection was not granted is now `permission_missing`
  (names the scope and capability, tells the user to reconnect and approve it); a 403 caused by the user's role
  stays `forbidden` ("ask a workspace admin"). New always-available `check_permissions` tool lists granted and
  missing capabilities.
- 14 new OAuth scopes (41 total): `automation:read/create/update/publish`, `flows:read/write/publish`,
  `knowledge_base:create/update`, `custom_fields:read/create/update`, `lists:create/update`. Connected users
  must reconnect once to use the new tools.

- Fixed tool errors seen in production usage: `list_conversations`, `get_conversation`
  and `query_knowledge_base` no longer fail the whole call when the backend returns
  null fields (e.g. a conversation whose channel was removed); `send_reply` no longer
  needs `contacts:read` just to label the reply; `send_message_to_contact` normalises
  phone numbers, reuses an existing contact on a duplicate-contact 409, never creates
  a contact from a bare name, never auto-picks email, and reports a closed WhatsApp
  24-hour window as `whatsapp_window_expired`. `page_size` is clamped to 1..100.
  WhatsApp template send failures now carry the Meta error code.
- Added privacy-preserving tool-usage analytics (Workers Analytics Engine, metadata
  only, never arguments or results; see `docs/DEPLOYMENT.md`) and
  `scripts/usage-report.mjs`. The User-Agent and server info derive from
  `src/version.ts`.

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
