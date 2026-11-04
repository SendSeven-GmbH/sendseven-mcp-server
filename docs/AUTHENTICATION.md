# Authentication Guide

## Overview

The SendSeven MCP server supports two authentication methods:

1. **OAuth 2.0** - For interactive use (Claude Desktop, web-based clients)
2. **API Tokens** - For developer use (Claude Code, Cursor, CI/CD)

## OAuth 2.0 (Recommended for End Users)

### How It Works

```
1. User clicks "Connect SendSeven" in their AI client
2. Redirected to SendSeven consent screen
3. User logs in via SendSeven (Auth0 SSO)
4. User reviews and approves requested scopes
5. Authorization code returned to MCP server
6. MCP server exchanges code for access + refresh tokens
7. Tokens stored securely in Cloudflare Durable Objects
8. Access token used for API calls (auto-refreshes)
```

### Token Lifecycle

| Token | Lifetime | Refresh |
|-------|----------|---------|
| Access Token | 1 hour | Automatic via refresh token |
| Refresh Token | 30 days | User re-authorizes |

### Requested Scopes

The MCP server requests these scopes:

41 granular scopes exist in total; only the scopes required by the
capability group(s) you select are ever requested — see
[README.md's Authentication section](../README.md#authentication) and
`SKILL_GROUPS` in `src/config.ts` for the full mapping.

| Scope | Purpose |
|-------|---------|
| `openid` | User identification |
| `profile` | User name and picture |
| `email` | User email |
| `offline_access` | Refresh token |
| `conversations:read` | List and view conversations |
| `conversations:create` | Snooze/unsnooze conversations |
| `conversations:update` | Close, assign, reopen conversations |
| `messages:read` | Read message history |
| `messages:create` | Send messages, WhatsApp templates, and email; upload attachments |
| `contacts:read` | Search contacts |
| `contacts:create` | Create new contacts |
| `contacts:update` | Update contacts; tag/untag contacts |
| `campaigns:read` | View campaigns and email campaign analytics |
| `campaigns:create` | Create campaigns |
| `campaigns:send` | Send campaigns |
| `lists:read` | View contact lists |
| `lists:create` | Create contact lists (Contact Data Model) |
| `lists:update` | Add and remove list members (Contact Data Model) |
| `knowledge_base:read` | Search the knowledge base (AI-powered); list KB folders |
| `knowledge_base:create` | Add documents, FAQ entries, folders and website crawls (Knowledge Base Authoring) |
| `knowledge_base:update` | Replace the text of an existing document (Knowledge Base Authoring) |
| `custom_fields:read` | List contact custom fields (Contact Data Model) |
| `custom_fields:create` | Create custom fields (Contact Data Model) |
| `custom_fields:update` | Edit custom fields (Contact Data Model) |
| `automation:read` | View agents, skills and bot rules (Agent Builder) |
| `automation:create` | Create agents and skills (Agent Builder) |
| `automation:update` | Edit agent drafts and skills, run agent tests (Agent Builder) |
| `automation:publish` | Publish and switch on agents, attach them to channels (Agent Builder; only used after an explicit confirmation) |
| `flows:read` | View and validate flows (Flows) |
| `flows:write` | Save flow drafts and run flow tests (Flows) |
| `flows:publish` | Publish flows (Flows; only used after an explicit confirmation) |
| `channels:read` | View channel status, mailboxes, verified domains, and WhatsApp templates |
| `notes:create` | Add conversation notes |
| `tags:read` | View tags |
| `tags:create` | Create tags; tag/untag conversations |
| `team:read` | List team members (for assignment and @mentions) |
| `teamchat:write` | Send Team Chat bot messages (channel or direct) |
| `team_chat:read` | List Team Chat channels (read-only) |
| `webhooks:read` | List webhook endpoints |
| `webhooks:create` | Create webhook endpoints |
| `webhooks:delete` | Delete webhook endpoints |

Users can only grant scopes they have permission for. For example, a Support Agent without `campaigns:create` will get a token without that scope, and campaign tools won't be available.

A tool whose permission was not granted when you connected is not offered. The always-available `check_permissions` tool lists granted and missing capabilities, and a call that is denied returns `permission_missing` (reconnect and approve the capability) or, when your role is the cause, `forbidden` (ask a workspace admin).

### Revoking Access

Users can revoke MCP server access anytime:

1. Go to SendSeven **Settings > Connected Apps**
2. Find "SendSeven MCP Server"
3. Click **Revoke**

## API Tokens (For Developers)

### Generating a Token

1. Go to SendSeven **Settings > API Tokens**
2. Click **Create Token**
3. Name it (e.g., "MCP Server - Dev")
4. Select scopes (same as OAuth list above)
5. Copy the token (`s7_api_xxxxx`)

### Using the Token

Pass the token as a Bearer header:

```json
{
  "mcpServers": {
    "sendseven": {
      "url": "https://mcp.sendseven.com/mcp",
      "headers": {
        "Authorization": "Bearer s7_api_your_token_here"
      }
    }
  }
}
```

### Token Characteristics

- No expiration (valid until revoked)
- Scoped to specific permissions
- Tied to a specific tenant
- Can be revoked from the dashboard

## Security Best Practices

1. **Never commit tokens** to version control
2. **Use environment variables** for API tokens in CI/CD
3. **Minimize scopes** - only request what you need
4. **Rotate tokens** periodically
5. **Monitor usage** in the SendSeven dashboard
6. **Revoke immediately** if a token is compromised
