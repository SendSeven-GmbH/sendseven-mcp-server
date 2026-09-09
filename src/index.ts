/**
 * SendSeven MCP Server - Cloudflare Worker Entrypoint
 *
 * A remote MCP server that exposes SendSeven's messaging API as
 * AI-callable tools. Built on Cloudflare's Agents SDK with McpAgent.
 *
 * Architecture:
 *   MCP Client (Claude/GPT/Gemini)
 *     → OAuthProvider (handles MCP client auth)
 *     → SendSevenMCP (McpAgent Durable Object)
 *     → SendSeven API (api.sendseven.com)
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

import type { Env, Props } from "./config.js";
import { SendSevenHandler } from "./auth-handler.js";
import { registerConversationTools } from "./tools/conversations.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerEmailTools } from "./tools/email.js";
import { registerEmailCampaignTools } from "./tools/email-campaigns.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTeamTools } from "./tools/team.js";
import { registerTeamChatTools } from "./tools/team-chat.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import type { ToolContext } from "./types.js";

// ─── MCP Agent (Durable Object) ─────────────────────────────────

export class SendSevenMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "SendSeven MCP Server",
    version: "0.3.0",
  });

  /** Mutable token state - updated when tokens are refreshed */
  private currentAccessToken = "";
  private currentRefreshToken: string | undefined;

  async init() {
    if (!this.props) {
      throw new Error("SendSevenMCP requires authenticated props (accessToken, tenantId, userId)");
    }

    // Initialize mutable token state from props
    this.currentAccessToken = this.props.accessToken;
    this.currentRefreshToken = this.props.refreshToken;

    // Build token refresher closure (captures mutable state via `this`)
    const tokenRefresher = this.currentRefreshToken
      ? async (): Promise<string> => {
          if (!this.currentRefreshToken) {
            throw new Error("No refresh token available");
          }

          const authUrl = this.env.SENDSEVEN_AUTH_URL.replace(/\/+$/, "");
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.currentRefreshToken,
            client_id: this.env.SENDSEVEN_OAUTH_CLIENT_ID,
            client_secret: this.env.SENDSEVEN_OAUTH_CLIENT_SECRET,
          });

          const response = await fetch(`${authUrl}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });

          if (!response.ok) {
            const errText = await response.text();
            console.error("Token refresh failed:", response.status, errText);
            throw new Error(`Token refresh failed: ${response.status}`);
          }

          const tokens = (await response.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
          };

          // Update mutable state with new tokens
          this.currentAccessToken = tokens.access_token;
          if (tokens.refresh_token) {
            this.currentRefreshToken = tokens.refresh_token;
          }

          return this.currentAccessToken;
        }
      : undefined;

    // Proactively refresh if the access token is expired or about to expire.
    // This handles Durable Object eviction: after eviction, init() runs again
    // with the original (possibly expired) props.accessToken. Without this check,
    // the first API call would fail with 401 before the retry logic kicks in.
    if (tokenRefresher && this.props.tokenExpiresAt) {
      const nowSec = Math.floor(Date.now() / 1000);
      const bufferSec = 300; // refresh 5 minutes before expiry
      if (this.props.tokenExpiresAt <= nowSec + bufferSec) {
        try {
          console.log("Access token expired or expiring soon, refreshing proactively...");
          await tokenRefresher();
          console.log("Proactive token refresh succeeded");
        } catch (err) {
          console.error("Proactive token refresh failed:", err);
          // Continue with the stale token — the per-request retry in
          // api-client.ts will attempt refresh again on 401.
        }
      }
    }

    // Build tool context with dynamic accessToken getter
    const self = this;
    const ctx: ToolContext = {
      get accessToken() {
        return self.currentAccessToken;
      },
      tenantId: this.props.tenantId,
      userId: this.props.userId,
      apiUrl: this.env.SENDSEVEN_API_URL,
      scopes: this.props.scopes || [],
      tokenRefresher,
    };

    // Register tools based on user's scopes
    registerConversationTools(this.server, ctx);
    registerMessagingTools(this.server, ctx);
    registerContactTools(this.server, ctx);
    registerCampaignTools(this.server, ctx);
    registerKnowledgeTools(this.server, ctx);
    registerChannelTools(this.server, ctx);
    registerEmailTools(this.server, ctx);
    registerEmailCampaignTools(this.server, ctx);
    registerTagTools(this.server, ctx);
    registerTeamTools(this.server, ctx);
    registerTeamChatTools(this.server, ctx);
    registerWebhookTools(this.server, ctx);
    registerAttachmentTools(this.server, ctx);
  }
}

// ─── Worker Export ───────────────────────────────────────────────

export default new OAuthProvider({
  apiHandler: SendSevenMCP.serve("/mcp"),
  apiRoute: "/mcp",
  defaultHandler: SendSevenHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
