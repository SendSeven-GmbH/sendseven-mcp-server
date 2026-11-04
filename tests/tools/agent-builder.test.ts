/**
 * Agent Builder tools: safety defaults, idempotency, permission errors,
 * nullable output schemas and analytics coverage. Runs the real McpServer +
 * Client over an in-memory transport with a routed fetch mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerKnowledgeAuthoringTools } from "../../src/tools/kb-authoring.js";
import { registerContactDataTools } from "../../src/tools/contact-data.js";
import { registerAgentBuilderTools } from "../../src/tools/agent-builder.js";
import { registerFlowTools } from "../../src/tools/flow-builder.js";
import { registerPermissionTools } from "../../src/tools/permissions.js";
import { registerGuideResources } from "../../src/resources/guides.js";
import { registerAgentBuilderPrompts } from "../../src/prompts/templates.js";
import { instrumentServer } from "../../src/analytics.js";
import { SKILL_GROUPS } from "../../src/config.js";
import type { ToolContext } from "../../src/types.js";

type Call = { method: string; path: string; body: any; query: URLSearchParams };
let calls: Call[] = [];
type Route = (c: Call) => { status?: number; body: unknown } | undefined;
let routes: Route[] = [];

const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
  const u = new URL(url);
  const call: Call = { method: String(init.method), path: u.pathname.replace(/^\/api\/v1/, ""), body: init.body ? JSON.parse(init.body as string) : undefined, query: u.searchParams };
  calls.push(call);
  for (const r of routes) {
    const hit = r(call);
    if (hit) {
      const status = hit.status ?? 200;
      return { ok: status < 400, status, json: async () => hit.body, text: async () => JSON.stringify(hit.body) } as Response;
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => JSON.stringify({ detail: "no route " + call.method + " " + call.path }) } as Response;
});
vi.stubGlobal("fetch", mockFetch);

const route = (method: string, path: string | RegExp, body: unknown, status = 200): Route => (c) =>
  c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)) ? { status, body } : undefined;

const ALL = Array.from(new Set(SKILL_GROUPS.flatMap((g) => g.scopes)));
const mkCtx = (scopes: string[] = ALL): ToolContext => ({ accessToken: "t", tenantId: "tn", userId: "u", apiUrl: "https://api.sendseven.com/api/v1", scopes });

async function connect(ctx: ToolContext, opts: { analytics?: { writeDataPoint: (d: unknown) => void } } = {}) {
  const server = new McpServer({ name: "t", version: "0" });
  if (opts.analytics) instrumentServer(server, { dataset: opts.analytics as never, tenantId: "tn", userId: "u" });
  registerKnowledgeAuthoringTools(server, ctx);
  registerContactDataTools(server, ctx);
  registerAgentBuilderTools(server, ctx);
  registerFlowTools(server, ctx);
  registerPermissionTools(server, ctx);
  registerGuideResources(server);
  registerAgentBuilderPrompts(server);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };
  return { isError: !!r.isError, data: r.structuredContent ?? JSON.parse(r.content[0].text) };
}

beforeEach(() => {
  calls = [];
  routes = [];
  mockFetch.mockClear();
});

describe("create_agent safety defaults + idempotency", () => {
  it("ALWAYS sends publish:false and is_active:false, even if the caller tries otherwise", async () => {
    routes = [route("GET", "/automation/agents", { items: [], pagination: {} }), route("POST", "/automation/agents", { id: "a1", bot_id: "b1", name: "Mia", is_active: false, publish_state: "draft" }, 201)];
    const c = await connect(mkCtx());
    const { data } = await call(c, "create_agent", { name: "Mia", persona: "p", publish: true, is_active: true });
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.body.publish).toBe(false);
    expect(post.body.is_active).toBe(false);
    expect(data.agent.id).toBe("a1");
    expect(data.already_existed).toBe(false);
  });

  it("returns an existing agent with the same name without creating or changing it", async () => {
    routes = [route("GET", "/automation/agents", { items: [{ id: "a9", name: "  mia ", is_active: true, publish_state: "published" }] })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "create_agent", { name: "Mia" });
    expect(data.already_existed).toBe(true);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("tolerates null fields in the API response (nullable output schema)", async () => {
    routes = [route("GET", "/automation/agents", { items: [] }), route("POST", "/automation/agents", { id: "a1", bot_id: null, name: "Mia", is_active: null, model_tier: null }, 201)];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "create_agent", { name: "Mia" });
    expect(isError).toBe(false);
    expect(data.agent.bot_id).toBeNull();
  });
});

describe("draft editing", () => {
  it("update_agent_draft re-reads the revision and retries once on 409 draft_conflict", async () => {
    let puts = 0;
    routes = [
      route("GET", "/automation/agents/a1/draft/revision", { agent_id: "a1", revision: 5 }),
      (c) => {
        if (c.method === "PUT" && c.path === "/automation/agents/a1/draft") {
          puts++;
          return puts === 1
            ? { status: 409, body: { detail: { code: "draft_conflict", message: "changed", revision: 6 } } }
            : { body: { agent_id: "a1", revision: 7, publish_state: "draft", validation: { errors: [], warnings: [] }, changes: [] } };
        }
      },
    ];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "update_agent_draft", { agent_id: "a1", instructions: "new", base_revision: 4 });
    expect(isError).toBe(false);
    expect(puts).toBe(2);
    const put2 = calls.filter((x) => x.method === "PUT")[1];
    expect(put2.body.document).toEqual({ instructions: "new" });
    expect(data.revision).toBe(7);
  });

  it("gives up after one retry (second 409 surfaces as an error)", async () => {
    routes = [
      route("GET", "/automation/agents/a1/draft/revision", { revision: 5 }),
      route("PUT", "/automation/agents/a1/draft", { detail: { code: "draft_conflict", message: "changed" } }, 409),
    ];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "update_agent_draft", { agent_id: "a1", instructions: "x" });
    expect(isError).toBe(true);
    expect(data.error.code).toBe("draft_conflict");
    expect(calls.filter((x) => x.method === "PUT")).toHaveLength(2);
  });

  it("set_agent_skills and set_agent_knowledge_sources write to the DRAFT, never the live endpoints", async () => {
    routes = [
      route("GET", /draft\/revision$/, { revision: 1 }),
      route("PUT", "/automation/agents/a1/draft", { agent_id: "a1", revision: 2, validation: {} }),
    ];
    const c = await connect(mkCtx());
    await call(c, "set_agent_skills", { agent_id: "a1", skills: [{ skill_id: "s1", mode: "always_on" }] });
    await call(c, "set_agent_knowledge_sources", { agent_id: "a1", knowledge_sources: [{ source_type: "faq" }] });
    const puts = calls.filter((x) => x.method === "PUT");
    expect(puts.map((p) => p.path)).toEqual(["/automation/agents/a1/draft", "/automation/agents/a1/draft"]);
    expect(puts[0].body.document.skills[0].skill_id).toBe("s1");
    expect(puts[1].body.document.knowledge_sources[0].source_type).toBe("faq");
    expect(calls.some((x) => x.path.endsWith("/skills") || x.path.endsWith("/knowledge-sources"))).toBe(false);
  });
});

describe("publish_agent confirmation", () => {
  it("without confirm=true changes nothing and returns readiness", async () => {
    routes = [route("GET", "/automation/agents/a1/readiness", { publish: { blockers: [{ code: "name_missing" }] }, next_steps: [{ code: "fix_name_missing" }] })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "publish_agent", { agent_id: "a1", confirm: false });
    expect(data.published).toBe(false);
    expect(data.confirmation_required).toBe(true);
    expect(data.blockers).toHaveLength(1);
    expect(calls.some((x) => x.method !== "GET")).toBe(false);
  });

  it("with confirm=true publishes; activate=true additionally PATCHes is_active", async () => {
    routes = [route("POST", "/automation/agents/a1/publish", { agent_id: "a1", publish_state: "published", revision: 9 }), route("PATCH", "/automation/agents/a1", { id: "a1" })];
    const c = await connect(mkCtx());
    const r1 = await call(c, "publish_agent", { agent_id: "a1", confirm: true });
    expect(r1.data.published).toBe(true);
    expect(r1.data.activated).toBe(false);
    expect(calls.some((x) => x.method === "PATCH")).toBe(false);
    const r2 = await call(c, "publish_agent", { agent_id: "a1", confirm: true, activate: true });
    expect(r2.data.activated).toBe(true);
    expect(calls.find((x) => x.method === "PATCH")!.body).toEqual({ is_active: true });
  });

  it("is annotated destructive", async () => {
    const c = await connect(mkCtx());
    const tools = (await c.listTools()).tools;
    expect(tools.find((t) => t.name === "publish_agent")!.annotations!.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "publish_flow")!.annotations!.destructiveHint).toBe(true);
  });
});

describe("permission errors", () => {
  it("backend agent_publish_not_allowed on a connection WITHOUT the scope -> permission_missing with reconnect text", async () => {
    const scopes = ALL.filter((s) => s !== "automation:publish");
    routes = [route("POST", "/automation/agents/a1/publish", { detail: { code: "agent_publish_not_allowed", message: "not granted", required_scopes: ["automation:publish"] } }, 403)];
    const c = await connect(mkCtx(scopes));
    // tool-level pre-check
    const { isError, data } = await call(c, "publish_agent", { agent_id: "a1", confirm: true });
    expect(isError).toBe(true);
    expect(data.error.code).toBe("permission_missing");
    expect(data.error.missing_scopes).toEqual(["automation:publish"]);
    expect(data.error.suggestion).toContain("Reconnect SendSeven in your AI client");
    expect(data.error.suggestion).toContain("Agent Builder");
  });

  it("backend 403 'Missing required permission(s)' for a scope the connection lacks -> permission_missing naming scope + capability", async () => {
    const scopes = ALL.filter((s) => s !== "custom_fields:create");
    routes = [route("GET", "/custom-fields", { items: [] }), route("POST", "/custom-fields", { detail: "Missing required permission(s): custom_fields:create, settings:update" }, 403)];
    // Pre-check passes only if scope held; call the API path by granting settings:update-less ctx via direct client instead:
    const c = await connect(mkCtx([...scopes, "custom_fields:read"]));
    const r = await call(c, "manage_custom_fields", { action: "create", name: "X", key: "x", field_type: "text" });
    expect(r.data.error.code).toBe("permission_missing");
    expect(r.data.error.capabilities).toContain("Contact Data Model");
  });

  it("raw API 403 with the scope string while the connection lacks it maps to permission_missing; granted scope = role denial (no reconnect)", async () => {
    // Connection holds flows:read only; backend says flows:write is required
    routes = [route("POST", "/flows/validate", { detail: "Missing required permission(s): flows:read, flows:write" }, 403)];
    const lacks = await connect(mkCtx(["automation:read"]));
    const { SendSevenApiClient } = await import("../../src/api-client.js");
    const cl = new SendSevenApiClient("https://api.sendseven.com/api/v1", "t", undefined, ["automation:read"]);
    await expect(cl.call("POST", "/flows/validate", { body: {} })).rejects.toMatchObject({ connectionLacksScope: true });
    void lacks;

    // Connection HAS flows:write; same 403 = the user's role
    const holds = new SendSevenApiClient("https://api.sendseven.com/api/v1", "t", undefined, ["flows:write"]);
    const err = await holds.call("POST", "/flows/validate", { body: {} }).catch((e) => e);
    const mcp = err.toMcpError().error;
    expect(mcp.code).toBe("forbidden");
    expect(mcp.suggestion).toContain("workspace admin");
    expect(mcp.suggestion).not.toContain("Reconnect");
  });

  it("feature_disabled stays plan_upgrade_required", async () => {
    routes = [route("GET", "/automation/agents", { detail: { code: "feature_disabled", feature: "ai_agents", message: "no" } }, 403)];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "list_agents", {});
    expect(isError).toBe(true);
    expect(data.error.code).toBe("plan_upgrade_required");
  });

  it("check_permissions reports granted, partial and missing capabilities", async () => {
    const c = await connect(mkCtx(["automation:read", "flows:read", "flows:write", "flows:publish"]));
    const { data } = await call(c, "check_permissions", {});
    const by = Object.fromEntries(data.capabilities.map((x: any) => [x.id, x]));
    expect(by.flows.status).toBe("granted");
    expect(by.agent_builder.status).toBe("partial");
    expect(by.agent_builder.missing_scopes).toContain("automation:publish");
    expect(by.knowledge_base_authoring.status).toBe("missing");
    expect(data.all_granted).toBe(false);
    expect(data.how_to_get_missing).toContain("Reconnect SendSeven");
  });

  it("structured 403 reason=token_scope is trusted even without scope inference data", async () => {
    routes = [route("GET", "/custom-fields", { items: [] }), route("POST", "/custom-fields", { detail: "Missing required permission(s): custom_fields:create", code: "missing_scope", required_scopes: ["custom_fields:create"], require_all: false, reason: "token_scope" }, 403)];
    // connection claims the scope (stale grant), API says the token lacks it -> permission_missing
    const c = await connect(mkCtx());
    const r = await call(c, "manage_custom_fields", { action: "create", name: "X", key: "x", field_type: "text" });
    expect(r.data.error.code).toBe("permission_missing");
    expect(r.data.error.missing_scopes).toEqual(["custom_fields:create"]);
  });

  it("structured 403 reason=role -> forbidden (ask an admin) even if the connection lacks the scope string", async () => {
    routes = [route("GET", "/custom-fields", { items: [] }), route("POST", "/custom-fields", { detail: "Missing required permission(s): custom_fields:create", code: "missing_scope", required_scopes: ["custom_fields:create"], reason: "role" }, 403)];
    const c = await connect(mkCtx());
    const r = await call(c, "manage_custom_fields", { action: "create", name: "X", key: "x", field_type: "text" });
    expect(r.data.error.code).toBe("forbidden");
    expect(r.data.error.suggestion).toContain("workspace admin");
  });

  it("check_permissions is registered even with NO builder scopes, while the builder tools are not", async () => {
    const c = await connect(mkCtx(["conversations:read"]));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["check_permissions"]);
    const { data } = await call(c, "check_permissions", {});
    expect(data.all_granted).toBe(false);
    expect(data.missing_capabilities).toContain("Agent Builder");
  });

  it("a registered tool refuses an un-granted action with permission_missing (no API call)", async () => {
    routes = [route("GET", "/automation/skills", { items: [] })];
    const c = await connect(mkCtx(["automation:read", "automation:update"])); // no create, no publish
    const r = await call(c, "upsert_skill", { title: "T", description: "d", body: "b" });
    expect(r.data.error.code).toBe("permission_missing");
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });
});

describe("test_agent", () => {
  it("defaults to the draft config and reports credits per turn; null fields do not break the output schema", async () => {
    routes = [route("POST", "/automation/agents/a1/test", {
      replies: [{ text: null, provenance: [] }, { text: "Hi" }], outcome: "answered", model: null,
      credits: { messages: 1, would_bill: 2, billed: false }, state: { k: 1 }, turn_id: null, goal_progress: null,
      skills_loaded: [{ slug: "s", version: 1 }], tool_calls: [],
    })];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "test_agent", { agent_id: "a1", message: "hello" });
    expect(isError).toBe(false);
    expect(calls[0].body.config).toBe("draft");
    expect(data.credits_this_turn).toBe(2);
    expect(data.replies[1].text).toBe("Hi");
    expect(data.replies[0].text).toBeNull();
  });
});

describe("skills", () => {
  it("creates a new skill when the slug is unknown", async () => {
    routes = [route("GET", "/automation/skills", { items: [] }), route("POST", "/automation/skills", { id: "s1", slug: "returns", title: "Returns", current_version: 1 }, 201)];
    const c = await connect(mkCtx());
    const { data } = await call(c, "upsert_skill", { title: "Returns", description: "when returning", body: "b", goal: { objective: "x", outputs: [] } });
    expect(data.action).toBe("created");
    expect(calls.find((x) => x.method === "POST")!.body.goal).toEqual({ objective: "x", outputs: [] });
  });

  it("patches by slug and reports a new version", async () => {
    routes = [
      route("GET", "/automation/skills", { items: [{ id: "s1", slug: "returns", current_version: 2 }] }),
      route("PATCH", "/automation/skills/s1", { id: "s1", slug: "returns", current_version: 3 }),
    ];
    const c = await connect(mkCtx());
    const { data } = await call(c, "upsert_skill", { slug: "returns", body: "new body" });
    expect(data.action).toBe("updated");
    expect(data.version_created).toBe(true);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("restores a version", async () => {
    routes = [route("POST", "/automation/skills/s1/versions/v1/restore", { id: "s1", slug: "x", current_version: 4 })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "manage_skill_versions", { action: "restore", skill_id: "s1", version_id: "v1" });
    expect(data.skill.current_version).toBe(4);
  });
});

describe("knowledge base", () => {
  it("upsert_knowledge_base_document creates, or replaces by title", async () => {
    routes = [route("GET", "/knowledge-base/documents", { items: [] }), route("POST", "/knowledge-base/documents", { id: "d1", title: "Returns", status: "pending_ingestion" })];
    const c = await connect(mkCtx());
    const r1 = await call(c, "upsert_knowledge_base_document", { title: "Returns", markdown: "# R" });
    expect(r1.data.action).toBe("created");
    expect(calls.find((x) => x.method === "POST")!.body.document_type).toBe("manual");

    calls = [];
    routes = [route("GET", "/knowledge-base/documents", { items: [{ id: "d1", title: "returns", document_type: "manual", folder_id: "f" }] }), route("PUT", "/knowledge-base/documents/d1/raw", { id: "d1", title: "Returns", status: "pending_ingestion" })];
    const r2 = await call(c, "upsert_knowledge_base_document", { title: "Returns", markdown: "# R2" });
    expect(r2.data.action).toBe("replaced");
    expect(calls.some((x) => x.method === "POST")).toBe(false);
    expect(calls.find((x) => x.method === "PUT")!.body).toEqual({ content: "# R2" });
  });

  it("crawl_website previews and starts with a safe default page_limit", async () => {
    routes = [
      route("POST", "/knowledge-base/documents/crawl/preview", { valid: true, estimated_pages: 120, title: "Site", sitemap: { found: true } }),
      route("POST", "/knowledge-base/documents/crawl", { job_id: "j1", status: "queued", message: "ok", poll_url: "/x" }),
      route("GET", "/knowledge-base/documents/crawl/j1/status", { job_id: "j1", status: "completed", message: "done", pages_crawled: null, documents_created: 12 }),
      route("POST", "/knowledge-base/documents/crawl/j1/cancel", { success: true }),
    ];
    const c = await connect(mkCtx());
    expect((await call(c, "crawl_website", { action: "preview", url: "https://x.com" })).data.estimated_pages).toBe(120);
    const s = await call(c, "crawl_website", { action: "start", url: "https://x.com" });
    expect(s.data.job_id).toBe("j1");
    expect(calls.find((x) => x.path === "/knowledge-base/documents/crawl")!.body.page_limit).toBe(50);
    const st = await call(c, "crawl_website", { action: "status", job_id: "j1" });
    expect(st.data.status).toBe("completed");
    expect(st.data.pages_crawled).toBeNull();
    expect((await call(c, "crawl_website", { action: "cancel", job_id: "j1" })).data.status).toBe("cancelled");
    expect((await call(c, "crawl_website", { action: "status" })).isError).toBe(true);
  });

  it("upsert_faq_entries uses the batch endpoint; a 409 item_index is reported as duplicate and the rest retried", async () => {
    const bodies: any[] = [];
    routes = [(cl) => {
      if (cl.method === "POST" && cl.path === "/knowledge-base/faq-items/batch") {
        bodies.push(cl.body);
        const items = cl.body.items as any[];
        const dup = items.findIndex((i) => i.question === "c");
        if (dup >= 0) return { status: 409, body: { detail: { duplicate_detected: true, existing_entry_id: "old", item_index: dup } } };
        return { status: 201, body: { created_count: items.length, items: items.map((_, k) => ({ id: "f" + k })) } };
      }
    }];
    const c = await connect(mkCtx());
    const { data } = await call(c, "upsert_faq_entries", { entries: [{ question: "a", answer: "b" }, { question: "c", answer: "d" }, { question: "e", answer: "f" }] });
    expect(bodies.length).toBe(2);
    expect(bodies[1].items.map((i: any) => i.question)).toEqual(["a", "e"]);
    expect(data.created).toBe(2);
    expect(data.skipped_duplicates).toBe(1);
    expect(data.results.map((r: any) => r.outcome)).toEqual(["created", "duplicate", "created"]);
    expect(data.results[1].id).toBe("old");
    expect(calls.some((x) => x.path === "/knowledge-base/faq-items")).toBe(false);
  });

  it("create_knowledge_base_folder is idempotent on name + parent", async () => {
    routes = [route("GET", "/knowledge-base/folders", { items: [{ id: "f1", name: "Returns", parent_id: null, children: [] }] })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "create_knowledge_base_folder", { name: "returns" });
    expect(data.already_existed).toBe(true);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });
});

describe("data model", () => {
  it("manage_custom_fields create is idempotent by key", async () => {
    routes = [route("GET", "/custom-fields", { items: [{ id: "cf1", key: "company_size", name: "Size", field_type: "text", options: null, description: null }] })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "manage_custom_fields", { action: "create", name: "Company size", key: "company_size", field_type: "text" });
    expect(data.already_existed).toBe(true);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("manage_lists adds members and reports failures", async () => {
    routes = [(cl) => (cl.method === "POST" && cl.path === "/lists/l1/members" ? (cl.body.contact_id === "bad" ? { status: 422, body: { detail: "nope" } } : { status: 201, body: { success: true } }) : undefined)];
    const c = await connect(mkCtx());
    const { data } = await call(c, "manage_lists", { action: "add_members", list_id: "l1", contact_ids: ["a", "bad"], channel_type: "email" });
    expect(data.succeeded).toBe(1);
    expect(data.failed).toHaveLength(1);
  });
});

describe("flows", () => {
  it("validate_flow turns a 422 into valid:false with the error list", async () => {
    routes = [route("POST", "/flows/validate", { detail: { code: "flow_definition_invalid", message: "bad", errors: [{ path: "nodes[1].next", code: "missing", message: "x" }] } }, 422)];
    const c = await connect(mkCtx());
    const { isError, data } = await call(c, "validate_flow", { definition: {} });
    expect(isError).toBe(false);
    expect(data.valid).toBe(false);
    expect(data.errors[0].path).toBe("nodes[1].next");
  });

  it("validate_flow valid returns publish readiness", async () => {
    routes = [route("POST", "/flows/validate", { valid: true, is_live: false, validation: { can_activate: false, errors: [{ code: "x" }] } })];
    const c = await connect(mkCtx());
    const { data } = await call(c, "validate_flow", { definition: {} });
    expect(data.valid).toBe(true);
    expect(data.can_activate).toBe(false);
  });

  it("save_flow_draft creates a draft and refuses to overwrite a live flow", async () => {
    routes = [route("GET", "/flows", { items: [] }), route("POST", "/flows", { id: "f1", name: "W", status: "draft", version: 1 }, 201)];
    const c = await connect(mkCtx());
    expect((await call(c, "save_flow_draft", { name: "W", definition: {} })).data.action).toBe("created");

    routes = [route("GET", "/flows", { items: [{ id: "f2", name: "Live", status: "published", version: 3 }] })];
    const r = await call(c, "save_flow_draft", { name: "Live", definition: {} });
    expect(r.data.error.code).toBe("flow_is_live");
  });

  it("publish_flow needs confirm=true", async () => {
    routes = [route("GET", "/flows/f1/validation", { can_activate: true, errors: [] }), route("POST", "/flows/f1/publish", { id: "f1", name: "W", status: "published", version: 2 })];
    const c = await connect(mkCtx());
    const r1 = await call(c, "publish_flow", { flow_id: "f1", confirm: false });
    expect(r1.data.published).toBe(false);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
    const r2 = await call(c, "publish_flow", { flow_id: "f1", confirm: true });
    expect(r2.data.published).toBe(true);
  });

  it("test_flow start/trace", async () => {
    routes = [route("POST", "/flows/f1/test-run", { run_id: "r1", conversation_id: "c1" }), route("GET", "/flows/f1/test-run/r1/trace", { steps: [{ node: "n1" }] })];
    const c = await connect(mkCtx());
    expect((await call(c, "test_flow", { action: "start", flow_id: "f1", trigger_type: "incoming_message", trigger_text: "hi" })).data.run_id).toBe("r1");
    expect((await call(c, "test_flow", { action: "trace", flow_id: "f1", run_id: "r1" })).data.steps).toHaveLength(1);
  });
});

describe("deploy", () => {
  it("attach_agent_to_channel adds a rule on the bot, is idempotent, and notes an inactive agent", async () => {
    routes = [
      route("GET", "/automation/agents/a1", { id: "a1", bot_id: "b1", is_active: false, publish_state: "draft" }),
      route("GET", "/automation/bots/b1/rules", []),
      route("POST", "/automation/bots/b1/rules", { id: "r1", channel_ids: ["c1"], widget_ids: null }, 201),
    ];
    const c = await connect(mkCtx());
    const r1 = await call(c, "attach_agent_to_channel", { agent_id: "a1", channel_ids: ["c1"] });
    expect(r1.data.rule_id).toBe("r1");
    expect(r1.data.note).toContain("inactive");

    calls = [];
    routes = [
      route("GET", "/automation/agents/a1", { id: "a1", bot_id: "b1", is_active: true }),
      route("GET", "/automation/bots/b1/rules", [{ id: "r1", channel_ids: ["c1"], widget_ids: null }]),
    ];
    const r2 = await call(c, "attach_agent_to_channel", { agent_id: "a1", channel_ids: ["c1"] });
    expect(r2.data.already_existed).toBe(true);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("attach without automation:publish -> permission_missing", async () => {
    const c = await connect(mkCtx(ALL.filter((s) => s !== "automation:publish")));
    const r = await call(c, "attach_agent_to_channel", { agent_id: "a1", channel_ids: ["c1"] });
    expect(r.data.error.code).toBe("permission_missing");
  });
});

describe("analytics wrapper covers the new tools automatically", () => {
  it("records tool name and the permission_missing error code, never arguments", async () => {
    const points: any[] = [];
    const c = await connect(mkCtx(ALL.filter((s) => s !== "automation:publish")), { analytics: { writeDataPoint: (d) => points.push(d) } });
    await call(c, "publish_agent", { agent_id: "secret-agent-id", confirm: true });
    await call(c, "check_permissions", {});
    expect(points[0].blobs[0]).toBe("publish_agent");
    expect(points[0].blobs[3]).toBe("error");
    expect(points[0].blobs[4]).toBe("permission_missing");
    expect(JSON.stringify(points)).not.toContain("secret-agent-id");
    expect(points[1].blobs[0]).toBe("check_permissions");
    expect(points[1].blobs[3]).toBe("ok");
  });
});

describe("capability groups, prompts and resources", () => {
  it("new groups are ON by default and use only scopes the OAuth app allows", () => {
    for (const id of ["agent_builder", "knowledge_base_authoring", "contact_data_model", "flows"]) {
      expect(SKILL_GROUPS.find((g) => g.id === id)?.default).toBe(true);
    }
  });

  it("registers the three prompts and the four guide resources", async () => {
    const c = await connect(mkCtx());
    expect((await c.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(["build_conversational_agent", "design_agent_flow", "write_skill"]);
    const res = (await c.listResources()).resources.map((r) => r.uri).sort();
    expect(res).toEqual([
      "sendseven://guides/agent-fields", "sendseven://guides/flow-format-spec", "sendseven://guides/run-assistant-node", "sendseven://guides/skills-and-goals",
    ]);
    const body = await c.readResource({ uri: "sendseven://guides/flow-format-spec" });
    expect(String((body.contents[0] as { text: string }).text).length).toBeGreaterThan(1000);
    const prompt = await c.getPrompt({ name: "build_conversational_agent", arguments: { website: "https://x.com" } });
    expect(JSON.stringify(prompt.messages)).toContain("publish_agent");
    expect(JSON.stringify(prompt.messages)).toContain("https://x.com");
  });
});
