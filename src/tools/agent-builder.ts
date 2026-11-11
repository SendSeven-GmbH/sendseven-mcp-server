/**
 * Agent Builder tools: Conversational Agents, skills, deployment.
 *
 * Design rules (CTO, Nov 2026):
 *  - The user's own LLM authors agents and skills; we do NOT wrap the paid
 *    /agent-builder/generate endpoint.
 *  - create_agent ALWAYS sends publish:false and is_active:false. Nothing goes
 *    live without publish_agent(confirm=true).
 *  - Edits go to the DRAFT (PUT /draft with base_revision). They never touch the
 *    live agent until published.
 *  - Creates are idempotent by name/slug where the API allows lookup.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClientError, type SendSevenApiClient } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapStructured } from "./helpers.js";
import {
  asRecord, can, guard, items, makeClient, nArr, nBool, nNum, nObj, nStr, nn, norm, permissionMissing, slugify, str, toolError,
  type Json,
} from "./builder-common.js";

const AGENTS = "/automation/agents";

// ─── Input fragments shared by create_agent and update_agent_draft ─────

const toolsConfigIn = z
  .object({
    search_knowledge: z.boolean().optional().describe("Search the knowledge base (default true)"),
    web_search_mode: z.enum(["off", "model", "kb_fallback", "always"]).optional().describe("Web search, OFF by default. Ask the user before enabling; it sends questions to a web search provider."),
    read_images: z.boolean().optional().describe("Read images customers send. OFF by default; ask the user."),
    read_documents: z.boolean().optional().describe("Read PDFs customers send. OFF by default; ask the user."),
    read_voice_messages: z.boolean().optional().describe("Transcribe voice messages (Beta). OFF by default; ask the user."),
    handoff: z.boolean().optional(),
  })
  .describe("Agent capabilities. Everything that reads customer files or searches the web is off unless you set it.");

const handoffIn = z
  .object({
    keywords: z.array(z.string()).optional().describe("Words that make the agent hand over to a human"),
    max_turns: z.number().optional().describe("Hand over after this many agent turns (1-200)"),
    max_consecutive_fallbacks: z.number().optional(),
    handoff_tag_ids: z.array(z.string()).optional().describe("Tag ids the agent may set when handing over (see list_tags)"),
    handoff_tag_hints: z.record(z.string()).optional().describe("tag id -> when to use this tag"),
  })
  .describe("When the agent hands the conversation to a human");

const languageIn = z
  .object({
    base_language: z.string().optional().describe("Language the agent is written in, e.g. en"),
    response_language: z.string().optional().describe("Force replies in this language; omit to follow the customer"),
    auto_translate_messages: z.boolean().optional(),
  })
  .describe("Language behaviour");

const skillLinkIn = z.object({
  skill_id: z.string().describe("Skill id (from upsert_skill)"),
  mode: z.enum(["always_on", "model_selected", "flow_only"]).optional().describe("Override the skill's default mode"),
  pinned_version_id: z.string().optional().describe("Pin a skill version; omit to follow the current version"),
});

const knowledgeSourceIn = z.object({
  source_type: z.enum(["kb_folder", "kb_all", "web_search", "faq", "live_source", "lookup_table"]),
  kb_folder_id: z.string().optional().describe("Required for kb_folder"),
  allowed_domains: z.array(z.string()).optional().describe("web_search: restrict to these domains"),
  is_enabled: z.boolean().optional(),
});

const agentFieldsIn = {
  persona: z.string().optional().describe("Who the agent is: name, role, tone. Max ~20k chars."),
  instructions: z.string().optional().describe("What the agent does and must never do."),
  display_name: z.string().optional().describe("Name shown to customers"),
  greeting_message: z.string().optional(),
  model_tier: z.enum(["standard", "advanced"]).optional().describe("standard (default) or advanced (smarter, costs more AI credits)"),
  language_settings: languageIn.optional(),
  tools_config: toolsConfigIn.optional(),
  handoff_config: handoffIn.optional(),
  escalation: z.record(z.unknown()).optional().describe("Hand-off behaviour, e.g. {enabled:true, handoff_message:'...', offers_escalation:true}"),
  max_credits_per_conversation: z.number().optional().describe("Cap on AI credits per conversation (draft only)"),
};

// ─── Output helpers ─────────────────────────────────────────────────────

const agentRow = (a: Json) => ({
  id: nn(str(a.id)),
  bot_id: nn(str(a.bot_id)),
  name: nn(str(a.name)),
  is_active: typeof a.is_active === "boolean" ? a.is_active : null,
  publish_state: nn(str(a.publish_state)),
  has_unpublished_changes: typeof a.has_unpublished_changes === "boolean" ? a.has_unpublished_changes : null,
  model_tier: nn(str(a.model_tier)),
});
const agentRowSchema = z.object({
  id: nStr, bot_id: nStr, name: nStr, is_active: nBool, publish_state: nStr, has_unpublished_changes: nBool, model_tier: nStr,
});

const draftSchema = {
  agent_id: nStr, bot_id: nStr, publish_state: nStr, status: nStr,
  has_unpublished_changes: nBool, revision: nNum,
  validation_errors: nArr, validation_warnings: nArr, changes: nArr,
  document: nObj,
};

function draftOut(d: Json, includeDocument = false) {
  const v = asRecord(d.validation);
  return {
    agent_id: nn(str(d.agent_id)),
    bot_id: nn(str(d.bot_id)),
    publish_state: nn(str(d.publish_state)),
    status: nn(str(d.status)),
    has_unpublished_changes: typeof d.has_unpublished_changes === "boolean" ? d.has_unpublished_changes : null,
    revision: typeof d.revision === "number" ? d.revision : null,
    validation_errors: Array.isArray(v.errors) ? v.errors : [],
    validation_warnings: Array.isArray(v.warnings) ? v.warnings : [],
    changes: Array.isArray(d.changes) ? d.changes : [],
    document: includeDocument ? asRecord(d.document) : null,
  };
}

/**
 * Save part of the draft document. base_revision comes from the caller or a
 * fresh read; on a 409 draft_conflict we re-read the revision and retry ONCE
 * (the document only carries the fields being changed, so retrying over a
 * concurrent edit to other fields is safe).
 */
export async function saveDraft(client: SendSevenApiClient, agentId: string, document: Json, baseRevision?: number): Promise<Json> {
  const path = `${AGENTS}/${encodeURIComponent(agentId)}/draft`;
  const readRevision = async () => {
    const r = asRecord(await client.call("GET", `${path}/revision`));
    return typeof r.revision === "number" ? r.revision : undefined;
  };
  let rev = baseRevision ?? (await readRevision());
  try {
    return asRecord(await client.call("PUT", path, { body: { document, base_revision: rev } }));
  } catch (err) {
    if (err instanceof ApiClientError && err.statusCode === 409 && err.apiErrorCode === "draft_conflict") {
      rev = (await readRevision()) ?? (typeof err.extra?.revision === "number" ? (err.extra.revision as number) : undefined);
      return asRecord(await client.call("PUT", path, { body: { document, base_revision: rev } }));
    }
    throw err;
  }
}

/** Remove undefined keys so omitted params never reach the API (explicit null means "reset" there). */
function compact(o: Json): Json {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function documentFromParams(p: Record<string, unknown>): Json {
  return compact({
    persona: p.persona,
    instructions: p.instructions,
    display_name: p.display_name,
    greeting_message: p.greeting_message,
    model_tier: p.model_tier,
    language_settings: p.language_settings,
    tools_config: p.tools_config,
    handoff_config: p.handoff_config,
    escalation: p.escalation,
    max_credits_per_conversation: p.max_credits_per_conversation,
  });
}

export function registerAgentBuilderTools(server: McpServer, ctx: ToolContext): void {
  const canRead = hasAnyScope(ctx.scopes, ["automation:read"]);
  const canWrite = hasAnyScope(ctx.scopes, ["automation:create", "automation:update"]);
  const canPublish = hasAnyScope(ctx.scopes, ["automation:publish"]);
  if (!canRead && !canWrite && !canPublish) return;

  // ── list_agents ─────────────────────────────────────────────────
  server.registerTool(
    "list_agents",
    {
      description: `List the workspace's Conversational Agents (AI agents that answer customers). Shows whether each is active and whether it has ever been published. Conversational Agents need the Professional plan or higher.`,
      inputSchema: {
        search: z.string().optional().describe("Filter by name"),
        page: z.number().optional(),
        page_size: z.number().optional().describe("Default 50, max 100"),
      },
      outputSchema: { agents: z.array(agentRowSchema), total: nNum },
      annotations: { title: "List Agents", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "automation:read")) return permissionMissing(["automation:read"], "list agents");
        const res = asRecord(await makeClient(ctx).call("GET", AGENTS, { params: { search: p.search, page: p.page ?? 1, page_size: p.page_size ?? 50 } }));
        const rows = items(res);
        const total = asRecord(res.pagination).total_items;
        return wrapStructured({ agents: rows.map(agentRow), total: typeof total === "number" ? total : rows.length });
      })
  );

  // ── get_agent ───────────────────────────────────────────────────
  server.registerTool(
    "get_agent",
    {
      description: `Get one agent with its editable draft document (persona, instructions, skills, knowledge sources, tools, hand-off, channel rules), publish state, current draft revision and what would block publishing. Use this before editing so you change only what is needed.`,
      inputSchema: { agent_id: z.string() },
      outputSchema: { agent: agentRowSchema, ...draftSchema },
      annotations: { title: "Get Agent", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "automation:read")) return permissionMissing(["automation:read"], "read agents");
        const client = makeClient(ctx);
        const id = encodeURIComponent(p.agent_id);
        const [agent, draft] = await Promise.all([client.call("GET", `${AGENTS}/${id}`), client.call("GET", `${AGENTS}/${id}/draft`)]);
        return wrapStructured({ agent: agentRow({ ...asRecord(agent), ...pick(asRecord(draft), ["publish_state", "has_unpublished_changes"]) }), ...draftOut(asRecord(draft), true) });
      })
  );



  // ── create_agent ────────────────────────────────────────────────
  if (canWrite) {
    server.registerTool(
      "create_agent",
      {
        description: `Create a Conversational Agent as an UNPUBLISHED, INACTIVE draft. It cannot answer any customer until you test it and the user explicitly approves publish_agent. Idempotent by name: if an agent with this name exists it is returned unchanged (use update_agent_draft to change it).

Write a focused persona and instructions, link skills (upsert_skill first) and knowledge (kb folders / faq). Keep web search and reading images/PDFs/voice OFF unless the user asked for them.`,
        inputSchema: {
          name: z.string().describe("Agent name (idempotency key)"),
          ...agentFieldsIn,
          skills: z.array(skillLinkIn).optional().describe("Skills to link"),
          knowledge_sources: z.array(knowledgeSourceIn).optional().describe("Knowledge sources, e.g. [{source_type:'faq'},{source_type:'kb_folder',kb_folder_id:'...'}]"),
        },
        outputSchema: { agent: agentRowSchema, already_existed: z.boolean(), next_step: nStr },
        annotations: { title: "Create Agent (Draft)", readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      },
      async (p) =>
        guard(async () => {
          if (!can(ctx, "automation:create")) return permissionMissing(["automation:create"], "create agents");
          const client = makeClient(ctx);
          if (can(ctx, "automation:read")) {
            const hit = items(await client.call("GET", AGENTS, { params: { search: p.name, page_size: 100 } })).find((a) => norm(a.name) === norm(p.name));
            if (hit) {
              return wrapStructured({ agent: agentRow(hit), already_existed: true, next_step: "An agent with this name already exists and was not changed. Use update_agent_draft to edit it." });
            }
          }
          const body = compact({
            name: p.name,
            ...documentFromParams(p),
            skills: p.skills,
            knowledge_sources: p.knowledge_sources,
            // SAFETY DEFAULTS: never live, never active on create.
            publish: false,
            is_active: false,
          });
          const created = asRecord(await client.call("POST", AGENTS, { body }));
          return wrapStructured({
            agent: agentRow({ publish_state: "draft", ...created }),
            already_existed: false,
            next_step: "Test it with test_agent, check get_agent_readiness, then (with the user's approval) publish_agent.",
          });
        })
    );

    // ── update_agent_draft ───────────────────────────────────────
    server.registerTool(
      "update_agent_draft",
      {
        description: `Change an agent's DRAFT (send only the fields you want to change; omitted fields keep their value). Live customers are unaffected until publish_agent. Uses optimistic concurrency: pass base_revision from get_agent, or omit it to use the latest; on a conflict the revision is re-read and the save retried once.

To change linked skills or knowledge use set_agent_skills / set_agent_knowledge_sources.`,
        inputSchema: {
          agent_id: z.string(),
          name: z.string().optional(),
          ...agentFieldsIn,
          base_revision: z.number().optional().describe("Draft revision you last saw (from get_agent)"),
        },
        outputSchema: draftSchema,
        annotations: { title: "Update Agent Draft", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      },
      async (p) =>
        guard(async () => {
          if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "edit agents");
          const doc = compact({ name: p.name, ...documentFromParams(p) });
          if (Object.keys(doc).length === 0) return toolError("nothing_to_change", "No fields to change were given.", "Provide at least one field.");
          return wrapStructured(draftOut(await saveDraft(makeClient(ctx), p.agent_id, doc, p.base_revision)));
        })
    );

    // ── set_agent_skills ─────────────────────────────────────────
    server.registerTool(
      "set_agent_skills",
      {
        description: `Replace the list of skills linked to an agent's DRAFT (the list you send is the full list). Skills hold the instructions: one foundation skill with mode always_on (company facts, tone, rules) plus model_selected skills for specific tasks (returns, lead qualification). Takes effect on publish.`,
        inputSchema: { agent_id: z.string(), skills: z.array(skillLinkIn).describe("Full list of skill links"), base_revision: z.number().optional() },
        outputSchema: draftSchema,
        annotations: { title: "Set Agent Skills (Draft)", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      },
      async (p) =>
        guard(async () => {
          if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "edit agents");
          return wrapStructured(draftOut(await saveDraft(makeClient(ctx), p.agent_id, { skills: p.skills }, p.base_revision)));
        })
    );

    // ── set_agent_knowledge_sources ──────────────────────────────
    server.registerTool(
      "set_agent_knowledge_sources",
      {
        description: `Replace the knowledge sources of an agent's DRAFT (the list you send is the full list). Types: faq (the Managed FAQ), kb_folder (needs kb_folder_id), kb_all (the whole knowledge base), web_search (off unless the user wants it), live_source, lookup_table. Takes effect on publish. Check indexing with get_agent_readiness.`,
        inputSchema: { agent_id: z.string(), knowledge_sources: z.array(knowledgeSourceIn), base_revision: z.number().optional() },
        outputSchema: draftSchema,
        annotations: { title: "Set Agent Knowledge Sources (Draft)", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      },
      async (p) =>
        guard(async () => {
          if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "edit agents");
          return wrapStructured(draftOut(await saveDraft(makeClient(ctx), p.agent_id, { knowledge_sources: p.knowledge_sources }, p.base_revision)));
        })
    );

    // ── test_agent ───────────────────────────────────────────────
    server.registerTool(
      "test_agent",
      {
        description: `Run one test turn against an agent. Nothing is sent to any customer. By default tests the DRAFT. Reports the reply, which skills loaded, tool calls and the AI credits the turn used (credits.would_bill; the first 500 test turns per day are free on paid plans, trials debit trial AI credits). Max 20 turns per minute.

To continue a conversation pass the previous turns in history and send the returned state back.`,
        inputSchema: {
          agent_id: z.string(),
          message: z.string().describe("What the customer says"),
          history: z.array(z.object({ role: z.enum(["user", "agent"]), text: z.string() })).optional(),
          state: z.record(z.unknown()).optional().describe("state from the previous test_agent result"),
          skill_slug: z.string().optional().describe("Force-load this skill"),
          channel_type: z.string().optional().describe("e.g. whatsapp, email, live_chat"),
          config: z.enum(["draft", "live"]).optional().describe("Default draft"),
        },
        outputSchema: {
          replies: z.array(z.object({ text: nStr })), outcome: nStr, model: nStr,
          skills_loaded: nArr, tool_calls: nArr, credits: nObj, credits_this_turn: nNum,
          state: nObj, turn_id: nStr, goal_progress: nObj, tested_config: nStr,
        },
        annotations: { title: "Test Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (p) =>
        guard(async () => {
          if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "test agents");
          const r = asRecord(
            await makeClient(ctx).call("POST", `${AGENTS}/${encodeURIComponent(p.agent_id)}/test`, {
              body: compact({ message: p.message, history: p.history, state: p.state, skill_slug: p.skill_slug, channel_type: p.channel_type, config: p.config ?? "draft" }),
            })
          );
          const credits = asRecord(r.credits);
          const would = typeof credits.would_bill === "number" ? credits.would_bill : typeof credits.messages === "number" ? credits.messages : null;
          return wrapStructured({
            replies: (Array.isArray(r.replies) ? r.replies : []).map((x) => ({ text: nn(str(asRecord(x).text)) })),
            outcome: nn(str(r.outcome)), model: nn(str(r.model)),
            skills_loaded: Array.isArray(r.skills_loaded) ? r.skills_loaded : [],
            tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
            credits, credits_this_turn: would,
            state: asRecord(r.state), turn_id: nn(str(r.turn_id)),
            goal_progress: r.goal_progress && typeof r.goal_progress === "object" ? asRecord(r.goal_progress) : null,
            tested_config: nn(str(r.tested_config) ?? str(r.config) ?? p.config ?? "draft"),
          });
        })
    );
  }

  // ── get_agent_readiness ─────────────────────────────────────────
  server.registerTool(
    "get_agent_readiness",
    {
      description: `Check whether an agent is ready to go live: plan, publish blockers, knowledge indexing status, skills, capabilities, and which channels/flows reach it. "next_steps" is ordered: do the first one first. Read-only, uses no AI credits. Call it before publish_agent.`,
      inputSchema: { agent_id: z.string() },
      outputSchema: {
        ready: nBool, live: nBool, can_publish: nBool, blockers: nArr, next_steps: nArr,
        knowledge: nObj, skills: nObj, routing: nObj, capabilities: nObj, plan: nObj, publish_state: nStr,
      },
      annotations: { title: "Get Agent Readiness", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "automation:read")) return permissionMissing(["automation:read"], "read agent readiness");
        const r = asRecord(await makeClient(ctx).call("GET", `${AGENTS}/${encodeURIComponent(p.agent_id)}/readiness`));
        const pub = asRecord(r.publish);
        return wrapStructured({
          ready: typeof r.ready === "boolean" ? r.ready : null, live: typeof r.live === "boolean" ? r.live : null,
          can_publish: typeof pub.can_publish === "boolean" ? pub.can_publish : null,
          blockers: Array.isArray(pub.blockers) ? pub.blockers : [], next_steps: Array.isArray(r.next_steps) ? r.next_steps : [],
          knowledge: asRecord(r.knowledge), skills: asRecord(r.skills), routing: asRecord(r.routing),
          capabilities: asRecord(r.capabilities), plan: asRecord(r.plan), publish_state: nn(str(pub.publish_state)),
        });
      })
  );

  // ── publish_agent ───────────────────────────────────────────────
  server.registerTool(
    "publish_agent",
    {
      description: `PUBLISH an agent: its draft becomes the configuration real customers talk to. This is the step that puts an agent in front of customers, so only call it after the user has explicitly said to publish THIS agent. Set confirm=true only then; without it nothing is changed and you get the readiness summary to show the user.

Optionally set activate=true to also switch the agent on (is_active). An agent only answers once it is published AND active AND reachable (attach_agent_to_channel or a published flow). Needs the automation:publish permission.`,
      inputSchema: {
        agent_id: z.string(),
        confirm: z.boolean().describe("Must be true, and only after the user explicitly approved publishing this agent"),
        activate: z.boolean().optional().describe("Also switch the agent on (default false)"),
        base_revision: z.number().optional(),
      },
      outputSchema: {
        published: z.boolean(), activated: z.boolean(), confirmation_required: z.boolean(),
        publish_state: nStr, revision: nNum, blockers: nArr, next_steps: nArr, message: nStr,
      },
      annotations: { title: "Publish Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const id = encodeURIComponent(p.agent_id);
        if (p.confirm !== true) {
          let blockers: unknown[] = [];
          let next: unknown[] = [];
          if (can(ctx, "automation:read")) {
            const r = asRecord(await client.call("GET", `${AGENTS}/${id}/readiness`));
            blockers = Array.isArray(asRecord(r.publish).blockers) ? (asRecord(r.publish).blockers as unknown[]) : [];
            next = Array.isArray(r.next_steps) ? r.next_steps : [];
          }
          return wrapStructured({
            published: false, activated: false, confirmation_required: true, publish_state: null, revision: null, blockers, next_steps: next,
            message: "Nothing was published. Show the user the readiness summary, ask whether to publish this agent, and call again with confirm=true only if they say yes.",
          });
        }
        if (!can(ctx, "automation:publish")) return permissionMissing(["automation:publish"], "publish agents");
        const pub = asRecord(
          await client.call("POST", `${AGENTS}/${id}/publish`, { body: p.base_revision !== undefined ? { base_revision: p.base_revision } : {} })
        );
        let activated = false;
        if (p.activate === true) {
          await client.call("PATCH", `${AGENTS}/${id}`, { body: { is_active: true } });
          activated = true;
        }
        return wrapStructured({
          published: true, activated, confirmation_required: false,
          publish_state: nn(str(pub.publish_state) ?? "published"), revision: typeof pub.revision === "number" ? pub.revision : null,
          blockers: [], next_steps: [],
          message: activated
            ? "Published and switched on. It answers customers on every channel/flow that reaches it."
            : "Published but not switched on. Use publish_agent with activate=true (or ask the user) to switch it on, and attach it to a channel with attach_agent_to_channel.",
        });
      })
  );

  // ── attach_agent_to_channel ─────────────────────────────────────
  server.registerTool(
    "attach_agent_to_channel",
    {
      description: `Attach an agent to channels and/or website widgets by adding an activation rule on its bot, so it answers there once it is published and active (rules do not fire while the agent is inactive). Idempotent: an existing identical rule is returned. Use list_channels for channel ids. Needs the automation:publish permission.

Attaching to a channel lets the agent reply to real customers on it as soon as the agent is live: confirm the target channels with the user first.`,
      inputSchema: {
        agent_id: z.string(),
        channel_ids: z.array(z.string()).optional().describe("Channel ids (list_channels)"),
        widget_ids: z.array(z.string()).optional(),
        priority: z.number().optional().describe("0-100, default 100"),
        requires_no_agents_online: z.boolean().optional().describe("Only answer when no human agent is online"),
      },
      outputSchema: {
        rule_id: nStr, channel_ids: nArr, widget_ids: nArr, already_existed: z.boolean(),
        agent_is_active: nBool, publish_state: nStr, note: nStr,
      },
      annotations: { title: "Attach Agent to Channel", readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "automation:publish")) return permissionMissing(["automation:publish"], "attach agents to channels");
        if (!p.channel_ids?.length && !p.widget_ids?.length) {
          return toolError("missing_parameter", "Give channel_ids and/or widget_ids.", "Use list_channels to find channel ids.");
        }
        const client = makeClient(ctx);
        const agent = asRecord(await client.call("GET", `${AGENTS}/${encodeURIComponent(p.agent_id)}`));
        const botId = str(agent.bot_id);
        if (!botId) return toolError("not_found", "The agent has no bot record.", "Check the agent id with list_agents.");
        const want = (a?: string[]) => [...(a ?? [])].sort().join(",");
        const rules = items(await client.call("GET", `/automation/bots/${encodeURIComponent(botId)}/rules`));
        const same = rules.find((r) => want(r.channel_ids as string[] | undefined) === want(p.channel_ids) && want(r.widget_ids as string[] | undefined) === want(p.widget_ids));
        const state = {
          agent_is_active: typeof agent.is_active === "boolean" ? agent.is_active : null,
          publish_state: nn(str(agent.publish_state)),
        };
        const note = agent.is_active === false
          ? "The agent is inactive, so this rule does nothing yet. Publish and activate it (publish_agent) when the user approves."
          : "The agent is active: it answers customers on these channels once published.";
        if (same) {
          return wrapStructured({ rule_id: nn(str(same.id)), channel_ids: (same.channel_ids as unknown[]) ?? [], widget_ids: (same.widget_ids as unknown[]) ?? [], already_existed: true, ...state, note });
        }
        const rule = asRecord(
          await client.call("POST", `/automation/bots/${encodeURIComponent(botId)}/rules`, {
            body: compact({
              channel_ids: p.channel_ids, widget_ids: p.widget_ids, priority: p.priority ?? 100,
              is_active: true, requires_no_agents_online: p.requires_no_agents_online,
            }),
          })
        );
        return wrapStructured({ rule_id: nn(str(rule.id)), channel_ids: (rule.channel_ids as unknown[]) ?? p.channel_ids ?? [], widget_ids: (rule.widget_ids as unknown[]) ?? p.widget_ids ?? [], already_existed: false, ...state, note });
      })
  );

  // ── Skills ──────────────────────────────────────────────────────
  registerSkillTools(server, ctx);
}

function pick(o: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
}

const skillOut = (s: Json) => ({
  id: nn(str(s.id)), slug: nn(str(s.slug)), title: nn(str(s.title)), description: nn(str(s.description)),
  default_mode: nn(str(s.default_mode)), current_version: typeof s.current_version === "number" ? s.current_version : null,
  current_version_id: nn(str(s.current_version_id)), is_archived: typeof s.is_archived === "boolean" ? s.is_archived : null,
  has_goal: s.goal ? true : typeof s.has_goal === "boolean" ? s.has_goal : null,
});
const skillSchema = z.object({
  id: nStr, slug: nStr, title: nStr, description: nStr, default_mode: nStr, current_version: nNum,
  current_version_id: nStr, is_archived: nBool, has_goal: nBool,
});

function registerSkillTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "upsert_skill",
    {
      description: `Create a skill, or update it if the slug (or skill_id) already exists. A skill is a reusable instruction set an agent follows. Every content change (title, description, body, tool_allowlist, goal, attachment_instruction) creates a NEW immutable version; agents that follow the current version use it on their next turn. Nothing is lost: see manage_skill_versions to list or restore.

Fields:
- title (required on create), description (required on create; says WHEN to use the skill, the agent decides from it), body (the instructions, <=20k chars).
- default_mode: always_on (foundation: facts, tone, rules), model_selected (default), flow_only.
- goal (optional): collect structured answers and run completion actions. Read the resource sendseven://guides/skills-and-goals for the shape; invalid goals return the exact errors. Bind outputs to contact custom fields (manage_custom_fields) so answers are saved.
- slug: lowercase letters, digits, - or _; derived from the title when omitted. It cannot change later.`,
      inputSchema: {
        skill_id: z.string().optional().describe("Update this skill"),
        slug: z.string().optional().describe("Lookup/idempotency key; created with it if new"),
        title: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        default_mode: z.enum(["always_on", "model_selected", "flow_only"]).optional(),
        tool_allowlist: z.array(z.string()).nullable().optional().describe("Allowed tools (search_knowledge, web_search, handoff, set_state, load_skill, complete_task); null = all"),
        goal: z.record(z.unknown()).nullable().optional().describe("Skill goal object; null removes the goal; omit to keep"),
        attachment_instruction: z.object({ preset: z.enum(["read_text", "describe", "context", "custom"]), custom_text: z.string().nullable().optional() }).nullable().optional(),
        is_archived: z.boolean().optional(),
      },
      outputSchema: { skill: skillSchema, action: z.enum(["created", "updated", "unchanged"]), version_created: z.boolean() },
      annotations: { title: "Create or Update Skill", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        let existing: Json | undefined;
        if (p.skill_id) {
          if (!can(ctx, "automation:read")) return permissionMissing(["automation:read"], "read skills");
          existing = asRecord(await client.call("GET", `/automation/skills/${encodeURIComponent(p.skill_id)}`));
        } else {
          const slug = p.slug ?? (p.title ? slugify(p.title) : undefined);
          if (slug && can(ctx, "automation:read")) {
            existing = items(await client.call("GET", "/automation/skills", { params: { search: slug, include_archived: true, page_size: 100 } })).find((s) => s.slug === slug);
          }
        }
        const content = compact({
          title: p.title, description: p.description, body: p.body, default_mode: p.default_mode,
          tool_allowlist: p.tool_allowlist, goal: p.goal, attachment_instruction: p.attachment_instruction, is_archived: p.is_archived,
        });
        if (existing && existing.id) {
          if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "update skills");
          const before = typeof existing.current_version === "number" ? existing.current_version : null;
          if (Object.keys(content).length === 0) {
            return wrapStructured({ skill: skillOut(existing), action: "unchanged", version_created: false });
          }
          const updated = asRecord(await client.call("PATCH", `/automation/skills/${encodeURIComponent(String(existing.id))}`, { body: content }));
          const after = typeof updated.current_version === "number" ? updated.current_version : null;
          return wrapStructured({ skill: skillOut(updated), action: before !== null && after === before ? "unchanged" : "updated", version_created: before !== null && after !== null && after > before });
        }
        if (!can(ctx, "automation:create")) return permissionMissing(["automation:create"], "create skills");
        if (!p.title || !p.description || !p.body) {
          return toolError("missing_parameter", "title, description and body are required to create a skill.", "Provide all three (description says when the skill applies).");
        }
        const created = asRecord(await client.call("POST", "/automation/skills", { body: compact({ slug: p.slug, ...content }) }));
        return wrapStructured({ skill: skillOut(created), action: "created", version_created: true });
      })
  );

  server.registerTool(
    "manage_skill_versions",
    {
      description: `List a skill's versions (newest first) or restore an earlier one. Restoring makes that content the current version (agents following the current version pick it up next turn; pinned links are unaffected).

action: list (needs skill_id) | restore (needs skill_id and version_id from list).`,
      inputSchema: {
        action: z.enum(["list", "restore"]),
        skill_id: z.string(),
        version_id: z.string().optional().describe("restore: version id from list"),
      },
      outputSchema: {
        action: z.string(),
        versions: z.array(z.object({ id: nStr, version: nNum, title: nStr, is_current: nBool, body_chars: nNum, has_goal: nBool, created_at: nStr })),
        skill: skillSchema.nullable().optional(),
      },
      annotations: { title: "Skill Versions", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const id = encodeURIComponent(p.skill_id);
        if (p.action === "list") {
          if (!can(ctx, "automation:read")) return permissionMissing(["automation:read"], "read skills");
          const vs = items(await client.call("GET", `/automation/skills/${id}/versions`, { params: { page_size: 50 } }));
          return wrapStructured({
            action: "list", skill: null,
            versions: vs.map((v) => ({
              id: nn(str(v.id)), version: typeof v.version === "number" ? v.version : null, title: nn(str(v.title)),
              is_current: typeof v.is_current === "boolean" ? v.is_current : null, body_chars: typeof v.body_chars === "number" ? v.body_chars : null,
              has_goal: v.goal ? true : false, created_at: nn(str(v.created_at)),
            })),
          });
        }
        if (!can(ctx, "automation:update")) return permissionMissing(["automation:update"], "restore skill versions");
        if (!p.version_id) return toolError("missing_parameter", "version_id is required to restore.", "Use action=list to find it.");
        const s = asRecord(await client.call("POST", `/automation/skills/${id}/versions/${encodeURIComponent(p.version_id)}/restore`));
        return wrapStructured({ action: "restore", versions: [], skill: skillOut(s) });
      })
  );
}
