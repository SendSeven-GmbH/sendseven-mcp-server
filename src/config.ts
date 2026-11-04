/**
 * SendSeven MCP Server Configuration
 *
 * Environment bindings and configuration types for Cloudflare Workers.
 */

import type { SendSevenMCP } from "./index.js";
import { MCP_SERVER_VERSION } from "./version.js";

export interface Env {
  // SendSeven API
  SENDSEVEN_API_URL: string;
  SENDSEVEN_AUTH_URL: string;        // Backend token endpoint base (api.sendseven.com/api/v1/oauth-apps)
  SENDSEVEN_CONSENT_URL: string;     // Frontend consent page (app.sendseven.com/oauth/consent)

  // MCP Server info
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;

  // OAuth credentials (secrets)
  SENDSEVEN_OAUTH_CLIENT_ID: string;
  SENDSEVEN_OAUTH_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;

  // Durable Objects
  MCP_OBJECT: DurableObjectNamespace<SendSevenMCP>;

  // KV for OAuth state
  OAUTH_KV: KVNamespace;

  // Rate limiting for POST /register (DCR registration-spam control, see
  // register-guard.ts). Optional: falls back to an OAUTH_KV counter when
  // this binding isn't configured (e.g. local dev).
  RATE_LIMITER?: RateLimit;

  // Tool-usage analytics (Workers Analytics Engine, see analytics.ts).
  // Optional: without the binding nothing is recorded.
  ANALYTICS?: AnalyticsEngineDataset;
}

/**
 * Props passed to McpAgent after OAuth authentication.
 * Encrypted and stored in the auth token by OAuthProvider.
 */
export interface Props extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  tenantId: string;
  userId: string;
  email: string;
  scopes: string[];
}

/** @deprecated Use SKILL_GROUPS + scopesForSkills() instead */
export const MCP_REQUESTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "conversations:read",
  "conversations:create",
  "conversations:update",
  "messages:read",
  "messages:create",
  "contacts:read",
  "contacts:create",
  "lists:read",
  "campaigns:read",
  "campaigns:create",
  "campaigns:send",
  "analytics:read",
  "knowledge_base:read",
  "channels:read",
  "notes:create",
  "tags:read",
  "tags:create",
] as const;

/** Skill groups shown during onboarding. Each group maps to required OAuth scopes. */
export const SKILL_GROUPS = [
  {
    id: "conversations",
    label: "Conversations",
    description: "View, reply to, snooze, close, and assign customer conversations; add internal notes; email transcripts",
    icon: "message-square",
    scopes: ["conversations:read", "conversations:create", "conversations:update", "messages:read", "messages:create", "notes:create", "team:read", "channels:read"],
    default: true,
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Send messages and WhatsApp templates via WhatsApp, Telegram, SMS, Messenger, Instagram",
    icon: "send",
    scopes: ["messages:create", "contacts:read", "contacts:create", "channels:read"],
    default: true,
  },
  {
    id: "email",
    label: "Email",
    description: "Send emails with subject lines, HTML body, CC/BCC, and mailbox selection",
    icon: "mail",
    scopes: ["messages:create", "contacts:read", "contacts:create", "channels:read"],
    default: true,
  },
  {
    id: "contacts",
    label: "Contacts",
    description: "Search, create, update, and manage contacts and tags",
    icon: "users",
    scopes: ["contacts:read", "contacts:create", "contacts:update", "tags:read", "tags:create"],
    default: true,
  },
  {
    id: "campaigns",
    label: "Campaigns",
    description: "Create and send messaging and email campaigns",
    icon: "megaphone",
    scopes: ["campaigns:read", "campaigns:create", "campaigns:send", "lists:read", "channels:read"],
    default: false,
  },
  {
    id: "knowledge_base",
    label: "Knowledge Base",
    description: "Search your FAQ, website content, and ticket summaries with AI",
    icon: "book-open",
    scopes: ["knowledge_base:read"],
    default: false,
  },
  {
    id: "webhooks",
    label: "Webhooks (Developer)",
    description: "List, create, and delete webhook endpoints for real-time events",
    icon: "webhook",
    scopes: ["webhooks:read", "webhooks:create", "webhooks:delete"],
    default: false,
  },
  {
    id: "team_chat_bots",
    label: "Team Chat Bots",
    description: "Post bot messages to a Team Chat channel or send a bot direct message to a team member, and list Team Chat channels",
    icon: "message-circle",
    // team_chat:read (added 2026-09-09) powers the read-only list_team_chat_channels
    // tool; teamchat:write (deliberately no underscore) powers the bot-message-send
    // tools. Existing connected users need to reconnect once to pick up this scope.
    scopes: ["teamchat:write", "team_chat:read"],
    default: false,
  },
  {
    id: "agent_builder",
    label: "Agent Builder",
    description: "Build, test and (with your confirmation) publish Conversational Agents and their skills, and attach them to channels",
    icon: "bot",
    // automation:publish is needed to publish/activate an agent and to attach it
    // to a channel (bot activation rules). Publishing always needs an explicit
    // confirm from the user inside the tool call.
    scopes: ["automation:read", "automation:create", "automation:update", "automation:publish", "channels:read", "tags:read"],
    default: true,
  },
  {
    id: "knowledge_base_authoring",
    label: "Knowledge Base Authoring",
    description: "Add documents, FAQ entries and website crawls to your knowledge base and organise folders",
    icon: "book-open",
    scopes: ["knowledge_base:read", "knowledge_base:create", "knowledge_base:update"],
    default: true,
  },
  {
    id: "contact_data_model",
    label: "Contact Data Model",
    description: "Create custom contact fields, lists and tags that agents and flows use",
    icon: "database",
    scopes: ["custom_fields:read", "custom_fields:create", "custom_fields:update", "lists:read", "lists:create", "lists:update", "tags:read", "tags:create"],
    default: true,
  },
  {
    id: "flows",
    label: "Flows",
    description: "Design, validate, test and (with your confirmation) publish automation flows",
    icon: "workflow",
    scopes: ["flows:read", "flows:write", "flows:publish"],
    default: true,
  },
] as const;

/** Base scopes always requested (auth infrastructure) */
export const BASE_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** Compute OAuth scopes from selected skill group IDs */
export function scopesForSkills(skillIds: string[]): string[] {
  const scopes = new Set<string>(BASE_SCOPES);
  for (const group of SKILL_GROUPS) {
    if (skillIds.includes(group.id)) {
      for (const scope of group.scopes) {
        scopes.add(scope);
      }
    }
  }
  return Array.from(scopes);
}

/** Rate limits by pricing plan */
export const RATE_LIMITS = {
  payg: { requestsPerMinute: 20, dailyLimit: 1000 },
  scale: { requestsPerMinute: 100, dailyLimit: 10000 },
  business: { requestsPerMinute: 500, dailyLimit: 50000 },
} as const;

/** MCP server metadata */
export const SERVER_INFO = {
  name: "sendseven-mcp",
  version: MCP_SERVER_VERSION,
  description: "SendSeven MCP Server - AI-native messaging API for multi-channel communication",
  vendor: "SendSeven GmbH",
  homepage: "https://sendseven.com",
} as const;
