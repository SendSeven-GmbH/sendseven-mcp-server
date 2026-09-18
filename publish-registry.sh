#!/usr/bin/env bash
#
# Re-publish the SendSeven MCP server to the official MCP Registry.
# (This file is gitignored — it is a local operator helper, not part of the
# public repo.)
#
# ONE-TIME setup (already done, listed here for reference):
#   1. mcp-publisher installed at /usr/local/bin/mcp-publisher
#   2. DNS TXT record at the sendseven.com APEX  ->  v=MCPv1; k=ed25519; p=...
#      (leave it in place permanently; it re-proves domain ownership)
#   3. Ed25519 signing key kept at ~/mcp-key.pem  (PRIVATE — never commit it)
#
# FOR A NEW RELEASE:
#   Registry versions are IMMUTABLE — you cannot republish the same version.
#   So bump "version" in server.json FIRST (and the matching code/config), then
#   run this script. It re-authenticates (the registry JWT is short-lived) and
#   publishes the current server.json.
#
set -euo pipefail

KEY="${HOME}/mcp-key.pem"
DOMAIN="sendseven.com"

# Run from the directory this script lives in (the repo root).
cd "$(dirname "$0")"

if [[ ! -f "$KEY" ]]; then
  echo "ERROR: signing key not found at $KEY" >&2
  echo "Restore your Ed25519 key there, or regenerate one and update the" >&2
  echo "sendseven.com apex TXT record with its new public key." >&2
  exit 1
fi

VERSION="$(node -p "require('./server.json').version")"
echo "==> Publishing com.sendseven/messaging version ${VERSION}"

# Re-auth via DNS (the TXT record + key persist; only the session token expires).
PRIVATE_KEY="$(openssl pkey -in "$KEY" -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain "$DOMAIN" --private-key "$PRIVATE_KEY"

# Publish the current server.json.
mcp-publisher publish

echo "==> Done. Verify with:"
echo "    curl \"https://registry.modelcontextprotocol.io/v0/servers?search=com.sendseven/messaging\""
