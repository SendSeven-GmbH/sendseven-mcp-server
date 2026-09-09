# Setup Guide

## Prerequisites

- A [SendSeven](https://sendseven.com) account
- An AI assistant that supports MCP (Claude, Cursor, etc.)

## Quick Setup (Remote Server)

The easiest way to get started is using our hosted MCP server at `mcp.sendseven.com`.

### Claude Desktop

1. Open Claude Desktop settings
2. Go to **MCP Servers**
3. Add a new server with URL: `https://mcp.sendseven.com/mcp`
4. Select **OAuth 2.0** authentication
5. Click **Connect** - you'll be redirected to SendSeven to authorize

### Claude Code

Add to your project's `.claude/settings.json`:

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

Get your API token from: **SendSeven Dashboard > Settings > API Tokens**

### Cursor IDE

Add to Cursor's MCP settings:

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

## Developer Setup (Self-Hosted)

### Requirements

- Node.js 18+
- npm or pnpm
- Cloudflare account (for deployment) or local development

### Installation

```bash
git clone https://github.com/SendSeven-GmbH/sendseven-mcp-server.git
cd sendseven-mcp-server
npm install
```

### Local Development

```bash
# Start development server
npm run dev
# Server runs at http://localhost:8787
```

Configure your MCP client to point to `http://localhost:8787/mcp`.

### Environment Variables

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
real values (`.dev.vars` is gitignored):

```ini
SENDSEVEN_OAUTH_CLIENT_ID=your_client_id
SENDSEVEN_OAUTH_CLIENT_SECRET=your_client_secret
COOKIE_ENCRYPTION_KEY=your_encryption_key
```

### Deploy to Cloudflare Workers

```bash
# Set secrets
npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_ID
npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

# Deploy
npm run deploy
```

## Authentication Methods

### OAuth 2.0 (Interactive)

Best for end users. The MCP server handles the full OAuth flow:

1. User initiates connection
2. Redirected to SendSeven consent screen
3. User approves scopes
4. Tokens stored securely in Durable Objects
5. Auto-refresh when expired

### API Token (Headless)

Best for developers, CI/CD, and scripts:

1. Generate token in SendSeven: **Settings > API Tokens**
2. Select required scopes
3. Pass as `Authorization: Bearer s7_api_xxxxx` header

## Troubleshooting

### "Authentication required"
- Ensure your token/OAuth session is valid
- For API tokens: verify the token hasn't been revoked
- For OAuth: try disconnecting and reconnecting

### "Insufficient scopes"
- Your token doesn't have permission for the requested action
- For API tokens: regenerate with additional scopes
- For OAuth: reconnect and approve all requested scopes

### "Rate limited"
- You've exceeded your plan's rate limit
- Wait 60 seconds and try again
- Consider upgrading your SendSeven plan for higher limits

### "Contact not found"
- Try searching by different criteria (phone, email, name)
- Use `create_if_not_exists=true` in `send_message_to_contact`
