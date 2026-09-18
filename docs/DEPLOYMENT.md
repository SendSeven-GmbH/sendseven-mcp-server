# Deployment Guide

This document covers deploying the SendSeven MCP Server to Cloudflare Workers.

## Prerequisites

- **Cloudflare account** with Workers Paid plan (required for Durable Objects)
- **Node.js 18+** installed locally
- **Wrangler CLI** (bundled as devDependency, or install globally: `npm i -g wrangler`)
- **SendSeven account** with OAuth application credentials
- **Custom domain** `mcp.sendseven.com` configured in Cloudflare DNS

## Architecture Overview

The MCP server runs as a Cloudflare Worker with the following bindings:

| Binding | Type | Purpose |
|---------|------|---------|
| `MCP_OBJECT` | Durable Object | McpAgent sessions (per-user state, SQLite-backed) |
| `OAUTH_KV` | KV Namespace | OAuth state storage (PKCE codes, session tokens) |

Secrets are stored securely in Cloudflare and never exposed in code or logs.

## Step 1: Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser to authenticate your Cloudflare account. Verify with:

```bash
npx wrangler whoami
```

## Step 2: Create KV Namespace

The OAuth flow requires a KV namespace for storing authorization state.

```bash
# Create the production KV namespace
npx wrangler kv namespace create OAUTH_KV
```

This outputs something like:

```
{ binding = "OAUTH_KV", id = "abcdef1234567890abcdef1234567890" }
```

Copy the `id` value and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "abcdef1234567890abcdef1234567890"  // <-- paste your ID here
  }
]
```

For local development, also create a preview namespace:

```bash
npx wrangler kv namespace create OAUTH_KV --preview
```

Add the preview ID to `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "abcdef1234567890abcdef1234567890",
    "preview_id": "fedcba0987654321fedcba0987654321"
  }
]
```

## Step 3: Set Secrets

Secrets are set interactively via the Wrangler CLI. Each command prompts for the value.

### OAuth Client Credentials

These come from the SendSeven OAuth application registration. Contact SendSeven support to have your OAuth app registered.

```bash
# OAuth client ID (from SendSeven OAuth app registration)
npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_ID

# OAuth client secret (from SendSeven OAuth app registration)
npx wrangler secret put SENDSEVEN_OAUTH_CLIENT_SECRET
```

### Cookie Encryption Key

Generate a random 32-byte hex key for encrypting OAuth cookies:

```bash
# Generate the key
openssl rand -hex 32

# Set it as a secret (paste the generated value when prompted)
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

### Verify Secrets

List all configured secrets (values are not shown):

```bash
npx wrangler secret list
```

Expected output:

```
[
  { "name": "SENDSEVEN_OAUTH_CLIENT_ID", "type": "secret_text" },
  { "name": "SENDSEVEN_OAUTH_CLIENT_SECRET", "type": "secret_text" },
  { "name": "COOKIE_ENCRYPTION_KEY", "type": "secret_text" }
]
```

## Step 4: Custom Domain Setup

The `wrangler.jsonc` file already declares the custom domain route:

```jsonc
"routes": [
  { "pattern": "mcp.sendseven.com", "custom_domain": true }
]
```

Ensure the following DNS record exists in Cloudflare for the `sendseven.com` zone:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `mcp` | `sendseven-mcp.YOUR_SUBDOMAIN.workers.dev` | Proxied (orange cloud) |

Cloudflare handles SSL automatically when the domain is proxied. The custom domain is provisioned on the first deploy.

Alternatively, if you use the Cloudflare dashboard:
1. Go to **Workers & Pages** > `sendseven-mcp`
2. Click **Settings** > **Domains & Routes**
3. Add `mcp.sendseven.com` as a custom domain

## Step 5: Deploy

```bash
# Install dependencies
npm ci

# Run type checking
npm run typecheck

# Run tests
npm test

# Deploy to Cloudflare Workers
npm run deploy
```

The deploy command outputs the worker URL. With the custom domain configured, the server is accessible at:

- **Production:** `https://mcp.sendseven.com/mcp`
- **Workers.dev fallback:** `https://sendseven-mcp.YOUR_SUBDOMAIN.workers.dev/mcp`

## Step 6: Verify Deployment

Test the deployed server:

```bash
# Health check (should return OAuth discovery or redirect)
curl -I https://mcp.sendseven.com/

# Check the MCP endpoint responds
curl -I https://mcp.sendseven.com/mcp

# Monitor real-time logs
npm run tail
```

## Local Development

For local development, create a `.dev.vars` file (excluded from git via `.gitignore`):

```ini
SENDSEVEN_OAUTH_CLIENT_ID=your_dev_client_id
SENDSEVEN_OAUTH_CLIENT_SECRET=your_dev_client_secret
COOKIE_ENCRYPTION_KEY=your_dev_encryption_key_hex
```

Then start the dev server:

```bash
npm run dev
# Server runs at http://localhost:8787
```

The local dev server uses the preview KV namespace and in-memory Durable Objects.

## Environment Variables (Non-Secret)

These are configured in `wrangler.jsonc` under `vars` and do not need `wrangler secret put`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `SENDSEVEN_API_URL` | `https://api.sendseven.com/api/v1` | SendSeven API base URL |
| `SENDSEVEN_AUTH_URL` | `https://api.sendseven.com/api/v1/oauth-apps` | OAuth authorization endpoint |
| `MCP_SERVER_NAME` | `SendSeven MCP Server` | Server name reported to MCP clients |
| `MCP_SERVER_VERSION` | `0.3.0` | Server version reported to MCP clients |

To point a local or self-hosted deployment at a different SendSeven environment, override `SENDSEVEN_API_URL` and `SENDSEVEN_AUTH_URL` in `.dev.vars`:

```ini
SENDSEVEN_API_URL=https://your-environment/api/v1
SENDSEVEN_AUTH_URL=https://your-environment/api/v1/oauth-apps
```

## CI/CD (GitHub Actions)

Automated deployments are configured via GitHub Actions. See `.github/workflows/deploy.yml`.

### Required GitHub Secrets

Add these to the repository settings under **Settings > Secrets and variables > Actions**:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CF_KV_NAMESPACE_ID` | Your `OAUTH_KV` namespace ID (see below) |

`wrangler.jsonc` is gitignored, so it doesn't exist in a fresh checkout. The
workflow regenerates it on every run from the committed `wrangler.jsonc.example`
template, substituting `CF_KV_NAMESPACE_ID` in for the `YOUR_KV_NAMESPACE_ID`
placeholder — see the "Generate wrangler.jsonc" step in
`.github/workflows/deploy.yml`.

### Creating the Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template
4. Set permissions:
   - Account > Workers Scripts > Edit
   - Account > Workers KV Storage > Edit
   - Account > Workers Routes > Edit
   - Zone > Workers Routes > Edit (for `sendseven.com` zone)
5. Copy the token and add as `CLOUDFLARE_API_TOKEN` in GitHub

### Finding Your Account ID

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com/)
2. Select your account
3. The account ID is in the URL: `dash.cloudflare.com/ACCOUNT_ID`
4. Or find it under **Workers & Pages** > **Overview** (right sidebar)

## Rollback

If a deployment causes issues, roll back to the previous version:

```bash
# List recent deployments
npx wrangler deployments list

# Roll back to previous
npx wrangler rollback
```

## Monitoring

### Real-Time Logs

```bash
npm run tail
```

### Cloudflare Dashboard

- **Workers & Pages** > `sendseven-mcp` > **Metrics** for request counts, errors, and latency
- **Workers & Pages** > `sendseven-mcp` > **Logs** for recent invocations

### Key Metrics to Watch

| Metric | Healthy Range | Action if Exceeded |
|--------|--------------|-------------------|
| Error rate | < 1% | Check logs, verify secrets, test API connectivity |
| P99 latency | < 2000ms | Check Durable Object load, API response times |
| CPU time per request | < 30ms | Optimize tool handlers, check for loops |
| Durable Object connections | < 1000 concurrent | Scale or add rate limiting |

## Troubleshooting

### "KV namespace not found"

The KV namespace ID in `wrangler.jsonc` does not match an existing namespace. Run `npx wrangler kv namespace list` to see available namespaces and update the ID.

### "Secret not found" or authentication failures

One or more secrets are missing. Run `npx wrangler secret list` and verify all three secrets are set.

### "Custom domain not resolving"

- Verify the CNAME record exists in Cloudflare DNS
- Ensure the domain is proxied (orange cloud icon)
- Wait up to 5 minutes for DNS propagation after first deploy

### "Durable Object migration required"

If you see migration errors, ensure the `migrations` section in `wrangler.jsonc` has the correct tag. Durable Object migrations run automatically on deploy.
