/**
 * Register SendSeven MCP Server as an OAuth App
 *
 * This script documents the OAuth app configuration for the MCP server.
 * Registering a new OAuth app requires SendSeven admin access, so contact
 * SendSeven support with this configuration to have it registered.
 *
 * Usage:
 *   npx ts-node scripts/register-oauth-app.ts
 */

const MCP_OAUTH_CONFIG = {
  name: "SendSeven MCP Server",
  description:
    "Official MCP server for AI assistant integration. Enables Claude, GPT, Gemini, and other AI assistants to manage SendSeven accounts via natural language.",
  homepage_url: "https://github.com/SendSeven-GmbH/sendseven-mcp-server",
  logo_url: "https://sendseven.com/logo.png",
  redirect_uris: [
    "https://mcp.sendseven.com/callback",
    "http://localhost:8787/callback", // Local development
  ],
  allowed_scopes: [
    // OIDC
    "openid",
    "profile",
    "email",
    "offline_access",
    // Conversations
    "conversations:read",
    "conversations:create",
    "conversations:update",
    // Messages
    "messages:read",
    "messages:create",
    // Contacts
    "contacts:read",
    "contacts:create",
    "contacts:update",
    // Campaigns
    "campaigns:read",
    "campaigns:create",
    "campaigns:send",
    // Lists
    "lists:read",
    // Knowledge Base
    "knowledge_base:read",
    // Channels
    "channels:read",
    // Notes
    "notes:create",
    // Tags
    "tags:read",
    "tags:create",
    // Team
    "team:read",
    // Team Chat Bots
    "teamchat:write",
    "team_chat:read",
    // Webhooks
    "webhooks:read",
    "webhooks:create",
    "webhooks:delete",
  ],
  is_verified: true,
  is_public: true,
  is_active: true,
};

console.log("=".repeat(80));
console.log("  SendSeven MCP Server - OAuth App Registration");
console.log("=".repeat(80));
console.log();
console.log("Configuration:");
console.log(JSON.stringify(MCP_OAUTH_CONFIG, null, 2));
console.log();
console.log("This configuration is registered on SendSeven's side by SendSeven staff.");
console.log("If you are self-hosting this server and need it registered as an OAuth");
console.log("app, contact SendSeven support (see SECURITY.md / SUPPORT) with the");
console.log("configuration above.");
console.log();
console.log("=".repeat(80));
