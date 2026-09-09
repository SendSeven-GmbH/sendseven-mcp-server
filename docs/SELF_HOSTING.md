# Self-Hosting Guide

Run the SendSeven MCP server on your own infrastructure.

## Cloudflare Workers (Recommended)

### Prerequisites

- Cloudflare account (free tier works)
- Node.js 18+
- `wrangler` CLI

### Steps

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SendSeven-GmbH/sendseven-mcp-server.git
   cd sendseven-mcp-server
   npm install
   ```

2. **Register an OAuth app** with SendSeven:
   - Contact SendSeven support or use the API
   - Get a `client_id` and `client_secret`
   - Set your redirect URI to `https://your-domain.com/callback`

3. **Copy the Cloudflare config template:**
   ```bash
   cp wrangler.jsonc.example wrangler.jsonc
   ```
   `wrangler.jsonc` is gitignored — it holds your own KV namespace ID and
   custom domain and is never committed.

4. **Configure secrets:**
   ```bash
   npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_ID
   npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```

5. **Create a KV namespace for OAuth state:**
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   # Copy the returned id into wrangler.jsonc's kv_namespaces[0].id
   ```

6. **Update `wrangler.jsonc`'s route** to your own domain:
   ```jsonc
   "routes": [
     { "pattern": "your-domain.example.com", "custom_domain": true }
   ]
   ```

7. **Deploy:**
   ```bash
   npm run deploy
   ```

## Docker (Alternative)

For non-Cloudflare deployments, a Dockerfile is provided:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 8787
CMD ["node", "dist/index.js"]
```

> Note: The Docker option runs as a standard Node.js HTTP server
> without Cloudflare-specific features (Durable Objects, KV).
> Session storage uses in-memory maps instead.

### Docker Compose

```yaml
version: '3.8'
services:
  sendseven-mcp:
    build: .
    ports:
      - "8787:8787"
    environment:
      - SENDSEVEN_API_URL=https://api.sendseven.com/api/v1
      - SENDSEVEN_AUTH_URL=https://api.sendseven.com/api/v1/oauth-apps
      - SENDSEVEN_OAUTH_CLIENT_ID=your_client_id
      - SENDSEVEN_OAUTH_CLIENT_SECRET=your_client_secret
      - COOKIE_ENCRYPTION_KEY=your_key
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SENDSEVEN_API_URL` | Yes | SendSeven API base URL |
| `SENDSEVEN_AUTH_URL` | Yes | OAuth endpoints base URL |
| `SENDSEVEN_OAUTH_CLIENT_ID` | Yes | OAuth client ID |
| `SENDSEVEN_OAUTH_CLIENT_SECRET` | Yes | OAuth client secret |
| `COOKIE_ENCRYPTION_KEY` | Yes | Session encryption key |
| `LOG_LEVEL` | No | "debug", "info", "warn", "error" |
