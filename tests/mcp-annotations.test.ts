/**
 * MCP Tool Annotation & Output-Schema Regression Tests
 *
 * Background: ChatGPT's MCP connector rendered EVERY tool as "destructive" -
 * including pure read tools like the (now-removed) get_bot_performance.
 * MCP clients default an un-annotated tool to destructive, so any tool
 * missing readOnlyHint/destructiveHint on the wire silently regresses to
 * "destructive" in client UIs even though the SDK-level annotation code
 * itself is correct and does reach the serialized tools/list response.
 *
 * This test spins up a REAL McpServer + SDK Client over an InMemoryTransport
 * (no mocks) and asserts the actual wire tools/list JSON - not just the
 * source-level annotation objects - so a future refactor that drops
 * annotations (e.g. reverting to a bare `server.tool(name, desc, schema, cb)`
 * call, which omits the annotations argument entirely) fails CI immediately.
 */
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { registerConversationTools } from "../src/tools/conversations.js";
import { registerMessagingTools } from "../src/tools/messaging.js";
import { registerContactTools } from "../src/tools/contacts.js";
import { registerCampaignTools } from "../src/tools/campaigns.js";
import { registerKnowledgeTools } from "../src/tools/knowledge.js";
import { registerChannelTools } from "../src/tools/channels.js";
import { registerEmailTools } from "../src/tools/email.js";
import { registerEmailCampaignTools } from "../src/tools/email-campaigns.js";
import { registerTagTools } from "../src/tools/tags.js";
import { registerTeamTools } from "../src/tools/team.js";
import { registerTeamChatTools } from "../src/tools/team-chat.js";
import { registerWebhookTools } from "../src/tools/webhooks.js";
import { registerAttachmentTools } from "../src/tools/attachments.js";
import { registerKnowledgeAuthoringTools } from "../src/tools/kb-authoring.js";
import { registerContactDataTools } from "../src/tools/contact-data.js";
import { registerAgentBuilderTools } from "../src/tools/agent-builder.js";
import { registerFlowTools } from "../src/tools/flow-builder.js";
import { registerPermissionTools } from "../src/tools/permissions.js";
import { SKILL_GROUPS } from "../src/config.js";
import type { ToolContext } from "../src/types.js";

const allScopes = Array.from(new Set(SKILL_GROUPS.flatMap((g) => g.scopes)));

const ctx: ToolContext = {
  accessToken: "t",
  tenantId: "tenant",
  userId: "u",
  apiUrl: "https://api.sendseven.com/api/v1",
  scopes: allScopes,
};

/**
 * destructiveHint: true = can delete, overwrite or replace existing data (OpenAI
 * Apps SDK: "being able to undo does not by itself justify false"). Purely
 * additive writes stay false so ChatGPT does not ask for needless confirmation.
 */
const EXPECTED_DESTRUCTIVE_TOOLS = [
  "delete_webhook", "publish_agent", "publish_flow",
  "update_contact", "upsert_knowledge_base_document", "crawl_website",
  "update_agent_draft", "set_agent_skills", "set_agent_knowledge_sources",
  "save_flow_draft", "upsert_skill", "manage_skill_versions",
  "manage_custom_fields", "manage_lists", "untag_contact", "untag_conversation",
];

/** Tools that reach customers or external systems (openWorldHint: true). */
const EXPECTED_OPEN_WORLD_TOOLS = [
  "crawl_website", "send_reply", "email_conversation_transcript", "send_message_to_contact",
  "send_whatsapp_template", "send_email", "create_and_send_campaign", "create_webhook", "upload_attachment",
];

/** Agent Builder tools (v0.4.0): every one declares a nullable outputSchema. */
export const AGENT_BUILDER_TOOLS = [
  "list_knowledge_base_documents", "create_knowledge_base_folder", "upsert_knowledge_base_document", "crawl_website", "upsert_faq_entries",
  "manage_custom_fields", "manage_lists",
  "list_agents", "get_agent", "create_agent", "update_agent_draft", "set_agent_skills", "set_agent_knowledge_sources",
  "test_agent", "get_agent_readiness", "publish_agent", "attach_agent_to_channel",
  "upsert_skill", "manage_skill_versions",
  "validate_flow", "save_flow_draft", "publish_flow", "test_flow",
  "check_permissions",
];

/** Tools currently migrated to registerTool() with a declared outputSchema. */
const EXPECTED_OUTPUT_SCHEMA_TOOLS = [
  "list_conversations",
  "get_conversation",
  "search_contacts",
  "query_knowledge_base",
  ...[
    "list_knowledge_base_documents", "create_knowledge_base_folder", "upsert_knowledge_base_document", "crawl_website", "upsert_faq_entries",
    "manage_custom_fields", "manage_lists",
    "list_agents", "get_agent", "create_agent", "update_agent_draft", "set_agent_skills", "set_agent_knowledge_sources",
    "test_agent", "get_agent_readiness", "publish_agent", "attach_agent_to_channel",
    "upsert_skill", "manage_skill_versions",
    "validate_flow", "save_flow_draft", "publish_flow", "test_flow",
    "check_permissions",
  ],
].sort();

const EXPECTED_TOOL_COUNT = 69;

async function listToolsOverRealWire() {
  const server = new McpServer({ name: "test-probe", version: "0.0.0" });
  registerConversationTools(server, ctx);
  registerMessagingTools(server, ctx);
  registerContactTools(server, ctx);
  registerCampaignTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  registerChannelTools(server, ctx);
  registerEmailTools(server, ctx);
  registerEmailCampaignTools(server, ctx);
  registerTagTools(server, ctx);
  registerTeamTools(server, ctx);
  registerTeamChatTools(server, ctx);
  registerWebhookTools(server, ctx);
  registerAttachmentTools(server, ctx);
  registerKnowledgeAuthoringTools(server, ctx);
  registerContactDataTools(server, ctx);
  registerAgentBuilderTools(server, ctx);
  registerFlowTools(server, ctx);
  registerPermissionTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const result = await client.request({ method: "tools/list" }, ListToolsResultSchema);

  await Promise.all([client.close(), server.close()]);

  return result.tools;
}

describe("tools/list wire annotations (full tool surface)", () => {
  it("registers the expected number of tools", async () => {
    const tools = await listToolsOverRealWire();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("gives every tool a title and boolean readOnlyHint/destructiveHint on the wire", async () => {
    const tools = await listToolsOverRealWire();

    const offenders = tools.filter(
      (t) =>
        !t.annotations ||
        typeof t.annotations.readOnlyHint !== "boolean" ||
        typeof t.annotations.destructiveHint !== "boolean" ||
        !t.annotations.title
    );

    expect(
      offenders.map((t) => t.name),
      `these tools are missing wire-level annotations and would render as ` +
        `"destructive" in MCP clients (e.g. ChatGPT) that default un-annotated ` +
        `tools to destructive: ${JSON.stringify(offenders.map((t) => t.name))}`
    ).toEqual([]);
  });

  it("gives every tool explicit boolean readOnlyHint, destructiveHint AND openWorldHint (OpenAI review requirement)", async () => {
    const tools = await listToolsOverRealWire();
    const offenders: string[] = [];
    for (const t of tools) {
      for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        if (typeof t.annotations?.[k] !== "boolean") offenders.push(`${t.name}.${k}`);
      }
    }
    expect(offenders, `tools without an explicit boolean hint (never rely on defaults): ${offenders.join(", ")}`).toEqual([]);
  });

  it("marks exactly the known open-world tools as openWorldHint: true", async () => {
    const tools = await listToolsOverRealWire();
    const open = tools.filter((t) => t.annotations?.openWorldHint === true).map((t) => t.name).sort();
    expect(open).toEqual([...EXPECTED_OPEN_WORLD_TOOLS].sort());
  });

  it("never marks a read-only tool destructive", async () => {
    const tools = await listToolsOverRealWire();
    const bad = tools.filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true);
    expect(bad.map((t) => t.name)).toEqual([]);
  });

  it("marks exactly the known-destructive tools as destructiveHint: true", async () => {
    const tools = await listToolsOverRealWire();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();

    expect(destructive).toEqual([...EXPECTED_DESTRUCTIVE_TOOLS].sort());
  });

  it("marks every non-destructive, non-mutating tool as readOnlyHint: true", async () => {
    const tools = await listToolsOverRealWire();
    // Read/query/list/search/get tools should be readOnlyHint: true. Anything
    // that creates, updates, sends, assigns, closes, or deletes should not be.
    const readNamePattern = /^(list_|get_|search_|query_|check_|validate_)/;

    for (const tool of tools) {
      const isDestructive = tool.annotations?.destructiveHint === true;
      if (isDestructive) continue; // covered by the destructive-set test above
      const expectedReadOnly = readNamePattern.test(tool.name);
      expect(
        tool.annotations?.readOnlyHint,
        `tool "${tool.name}" has readOnlyHint=${tool.annotations?.readOnlyHint}, expected ${expectedReadOnly}`
      ).toBe(expectedReadOnly);
    }
  });

  it("declares outputSchema on exactly the migrated high-value read tools", async () => {
    const tools = await listToolsOverRealWire();
    const withOutputSchema = tools
      .filter((t) => t.outputSchema !== undefined)
      .map((t) => t.name)
      .sort();

    expect(withOutputSchema).toEqual(EXPECTED_OUTPUT_SCHEMA_TOOLS);
  });

  it("does not register get_bot_performance (removed - low value, analytics tools no longer offered)", async () => {
    const tools = await listToolsOverRealWire();
    expect(tools.some((t) => t.name === "get_bot_performance")).toBe(false);
  });

  it("does not register get_dashboard_metrics (removed 2026-09-09 - MCP refocused on messaging/conversations/contacts)", async () => {
    const tools = await listToolsOverRealWire();
    expect(tools.some((t) => t.name === "get_dashboard_metrics")).toBe(false);
  });

  it("does not register test_webhook (removed 2026-09-09 - low value, superseded by checking list_webhooks health fields)", async () => {
    const tools = await listToolsOverRealWire();
    expect(tools.some((t) => t.name === "test_webhook")).toBe(false);
  });

  it("does not register list_webhook_events (removed 2026-09-09 - event catalog folded into create_webhook's description/enum)", async () => {
    const tools = await listToolsOverRealWire();
    expect(tools.some((t) => t.name === "list_webhook_events")).toBe(false);
  });
});
