/**
 * MCP prompts for the Agent Builder. They are conversation starters that tell
 * the user's LLM how to interview the user and which tools/resources to use.
 * Prompts are registered for every connection; the tools they name may need a
 * capability the connection lacks (check_permissions explains that).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Msg = { role: "user"; content: { type: "text"; text: string } };
const user = (text: string): { messages: Msg[] } => ({ messages: [{ role: "user", content: { type: "text", text } }] });

export const BUILD_AGENT_PROMPT = `You are helping me build a SendSeven Conversational Agent (an AI agent that answers my customers). Work as a guided interview: ask a few questions at a time, never all at once, summarise what you decided, and only then act. Never publish or switch anything on without my explicit approval.

Before you start: call check_permissions. If Agent Builder, Knowledge Base Authoring, Contact Data Model or Flows are missing, tell me which and that I must reconnect SendSeven and approve them. Read the resource sendseven://guides/agent-fields and sendseven://guides/skills-and-goals when you need exact fields.

Steps:
1. Business and goals. Ask for my website, what the agent should achieve (answer FAQs, qualify leads, take callback requests, handle returns) and in which language(s).
2. Knowledge. Plan the knowledge base: folders (create_knowledge_base_folder), documents written as clean markdown from facts I give you (upsert_knowledge_base_document), a website crawl (crawl_website: always action=preview first, show me the estimated pages, then start with a sensible page_limit, then poll status), and Q&A pairs (upsert_faq_entries). Then check indexing with list_knowledge_base_documents until documents are ready.
3. Agent persona. Propose a name, persona, tone, instructions and the model tier (standard is the default; advanced is smarter and costs more AI credits). Create it with create_agent (it is created as an unpublished, inactive draft).
4. Skills. Create one always_on foundation skill (company facts, tone, rules) and model_selected skills for specific tasks (upsert_skill). Where the agent should collect information (lead qualification, callback request, return registration), add a goal to the skill (see the guide), binding each answer to a contact custom field. Link them with set_agent_skills and the knowledge with set_agent_knowledge_sources.
5. Data model. Create the custom fields the goals need (manage_custom_fields, ai_access fill_if_empty or read_write), tags (create_tag) and lists (manage_lists) the agent or goal outcomes use.
6. Hand-off. Ask when a human should take over (keywords, max turns), which tags to set, and who gets the conversation; configure handoff_config / escalation with update_agent_draft.
7. Optional capabilities. These are OFF by default: web search, reading images, reading PDFs, transcribing voice messages. Ask me about each one and enable only what I approve. Explain web search sends questions to a web search provider.
8. Optional pre-check flow. Ask whether I want a flow that runs before the agent (for example collect an order number, or route by language) and then launches it with a Run AI Assistant node. If yes, read sendseven://guides/flow-format-spec and sendseven://guides/run-assistant-node, write the definition, validate_flow until valid, save_flow_draft.
9. Test. Run several realistic conversations with test_agent (draft config), including a hand-off case and a goal. Show me the replies and the AI credits per turn. Iterate with update_agent_draft / upsert_skill until I am happy.
10. Readiness. Call get_agent_readiness and fix every blocker and the first next_step.
11. Publish. Show me a summary and ask: "Publish this agent?" Only after I say yes call publish_agent with confirm=true (add activate=true only if I also want it switched on). If a flow was saved, publish_flow likewise needs my explicit yes.
12. Attach. Ask which channels should use the agent (list_channels), then attach_agent_to_channel. Tell me the agent only answers customers once it is published, active and attached.

Rules: be idempotent (tools look up by name before creating); report errors plainly; if a tool says permission_missing tell me to reconnect SendSeven and approve the named capability; if it says plan_upgrade_required tell me agents need the Professional plan or higher.`;

export const WRITE_SKILL_PROMPT = `Help me write a SendSeven skill (a reusable instruction set for a Conversational Agent). Read the resource sendseven://guides/skills-and-goals first.

Interview me briefly: what task does the skill cover, when should the agent use it, what are the exact facts/rules/steps, what must the agent never do, and is there information to collect from the customer (a goal)?

Then draft:
- title and a one-sentence description that says WHEN to use the skill (the agent picks skills from this),
- default_mode (always_on only for foundation rules that apply to every conversation; otherwise model_selected),
- a short, concrete body: steps, facts, example phrasing, what to do when unsure (hand over),
- if information must be collected: a goal with outputs (key, type, validation), bound to contact custom fields (create missing ones with manage_custom_fields), plus completion actions (tags, assignment, hand-over).

Show me the draft, adjust, then save it with upsert_skill (updating an existing slug creates a new version; manage_skill_versions can restore an earlier one). Offer to link it to an agent with set_agent_skills and to try it with test_agent using skill_slug.`;

export const DESIGN_FLOW_PROMPT = `Help me design a SendSeven automation flow. Read sendseven://guides/flow-format-spec first (and sendseven://guides/run-assistant-node if a Conversational Agent is involved).

Interview me: what triggers the flow (incoming message, tag, manual start, ...), which channels, what should happen step by step (messages, questions, conditions, delays, tags, handing over to a human or an agent), and what the end states are.

Then:
1. Describe the flow as a short list of steps and let me confirm.
2. Write the definition JSON (trigger, nodes, edges, entry_node_id). Use ids and output keys exactly as the spec requires.
3. Run validate_flow; fix every error (each has a path) and re-validate until valid.
4. Save with save_flow_draft (it only creates or updates a DRAFT).
5. Run test_flow (action=start, then reply/trace) with a realistic trigger and show me what happened.
6. Only if I explicitly say so: publish_flow with confirm=true. Publishing makes it run for real customers.`;

export function registerAgentBuilderPrompts(server: McpServer): void {
  server.registerPrompt(
    "build_conversational_agent",
    {
      title: "Build a Conversational Agent",
      description: "Guided interview that builds, tests and (with your approval) publishes a SendSeven AI agent: knowledge base, persona, skills and goals, data fields, hand-off, optional flow, test, readiness and channel attachment.",
      argsSchema: { website: z.string().optional().describe("Your website URL, if you have one"), goal: z.string().optional().describe("What the agent should achieve") },
    },
    ({ website, goal }) =>
      user(`${BUILD_AGENT_PROMPT}${website ? `\n\nMy website: ${website}` : ""}${goal ? `\nWhat I want the agent to do: ${goal}` : ""}`)
  );
  server.registerPrompt(
    "write_skill",
    {
      title: "Write an agent skill",
      description: "Interview and draft a skill (instructions, optional goal bound to contact fields) and save it as a new version.",
      argsSchema: { topic: z.string().optional().describe("What the skill is about, e.g. returns") },
    },
    ({ topic }) => user(`${WRITE_SKILL_PROMPT}${topic ? `\n\nTopic: ${topic}` : ""}`)
  );
  server.registerPrompt(
    "design_agent_flow",
    {
      title: "Design an automation flow",
      description: "Interview, write, validate, save as draft and test a SendSeven flow (optionally launching a Conversational Agent).",
      argsSchema: { idea: z.string().optional().describe("What the flow should do") },
    },
    ({ idea }) => user(`${DESIGN_FLOW_PROMPT}${idea ? `\n\nIdea: ${idea}` : ""}`)
  );
}
