/**
 * Tool Registry
 *
 * Re-exports tool registration functions from each domain module.
 * Each module registers tools on the McpServer via server.tool()
 * based on the user's authenticated scopes.
 */

export { registerConversationTools } from "./conversations.js";
export { registerMessagingTools } from "./messaging.js";
export { registerContactTools } from "./contacts.js";
export { registerCampaignTools } from "./campaigns.js";
export { registerKnowledgeTools } from "./knowledge.js";
export { registerChannelTools } from "./channels.js";
export { registerEmailCampaignTools } from "./email-campaigns.js";
export { registerTagTools } from "./tags.js";
export { registerTeamTools } from "./team.js";
export { registerTeamChatTools } from "./team-chat.js";
export { registerWebhookTools } from "./webhooks.js";
export { hasAnyScope, wrapResult } from "./helpers.js";
