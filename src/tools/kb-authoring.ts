/**
 * Knowledge Base authoring tools (Agent Builder).
 *
 * Complements query_knowledge_base / list_knowledge_base_folders (read-only,
 * knowledge_base group). Writes need knowledge_base:create (crawl is allowed on
 * create) and knowledge_base:update (replacing a document's text).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapStructured } from "./helpers.js";
import {
  asRecord, can, guard, items, makeClient, nBool, nNum, nObj, nStr, nn, norm, permissionMissing, str, toolError,
  type Json,
} from "./builder-common.js";

const docOut = (d: Json) => ({
  id: nn(str(d.id)),
  title: nn(str(d.title)),
  document_type: nn(str(d.document_type)),
  status: nn(str(d.status)),
  last_error: nn(str(d.last_error)),
  folder_id: nn(str(d.folder_id)),
  source_url: nn(str(d.source_url)),
});

export function registerKnowledgeAuthoringTools(server: McpServer, ctx: ToolContext): void {
  const canRead = hasAnyScope(ctx.scopes, ["knowledge_base:read"]);
  const canCreate = hasAnyScope(ctx.scopes, ["knowledge_base:create"]);
  if (!canRead && !canCreate) return;

  // ── list_knowledge_base_documents ────────────────────────────────
  if (canRead) {
    server.registerTool(
      "list_knowledge_base_documents",
      {
        description: `List knowledge base documents with their indexing status. A document is only searchable by an agent once its status is "ready" ("pending_ingestion" = still being indexed, "failed" = see last_error). Use this after adding documents or a crawl to check whether indexing finished before testing an agent.

Examples:
- "Are my documents indexed yet?" -> status_filter omitted, check summary.not_ready
- "What is in the Returns folder?" -> folder_id=<id from list_knowledge_base_folders>`,
        inputSchema: {
          folder_id: z.string().optional().describe("Only documents in this folder (id from list_knowledge_base_folders)"),
          search: z.string().optional().describe("Match on title or source URL"),
          status_filter: z.string().optional().describe("Comma-separated: pending_upload, pending_ingestion, ready, deleting, failed"),
          page: z.number().optional().describe("Page number (default 1)"),
          page_size: z.number().optional().describe("Items per page (default 50, max 100)"),
        },
        outputSchema: {
          documents: z.array(
            z.object({
              id: nStr, title: nStr, document_type: nStr, status: nStr, last_error: nStr, folder_id: nStr, source_url: nStr,
            })
          ),
          total: nNum,
          summary: z.object({ ready: z.number(), not_ready: z.number(), failed: z.number() }),
        },
        annotations: { title: "List Knowledge Base Documents", readOnlyHint: true, destructiveHint: false },
      },
      async (p) =>
        guard(async () => {
          const res = asRecord(
            await makeClient(ctx).call("GET", "/knowledge-base/documents", {
              params: {
                folder_id: p.folder_id, search: p.search, status: p.status_filter,
                page: p.page ?? 1, page_size: p.page_size ?? 50,
              },
            })
          );
          const docs = items(res).map(docOut);
          const ready = docs.filter((d) => d.status === "ready").length;
          const failed = docs.filter((d) => d.status === "failed").length;
          return wrapStructured({
            documents: docs,
            total: nn(typeof asRecord(res.pagination).total_items === "number" ? (asRecord(res.pagination).total_items as number) : docs.length),
            summary: { ready, not_ready: docs.length - ready, failed },
          });
        })
    );
  }

  if (!canCreate) {
    return;
  }

  // ── create_knowledge_base_folder ─────────────────────────────────
  server.registerTool(
    "create_knowledge_base_folder",
    {
      description: `Create a knowledge base folder (idempotent: if a folder with the same name already exists under the same parent, it is returned instead of creating a duplicate). Folders let an agent search only a relevant part of the knowledge base (e.g. "Returns", "Pricing").`,
      inputSchema: {
        name: z.string().describe("Folder name"),
        parent_id: z.string().optional().describe("Parent folder id; omit for a top-level folder"),
      },
      outputSchema: { id: nStr, name: nStr, parent_id: nStr, already_existed: z.boolean() },
      annotations: { title: "Create Knowledge Base Folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const tree = asRecord(await client.call("GET", "/knowledge-base/folders"));
        const found = findFolder(items(tree), norm(p.name), p.parent_id ?? null);
        if (found) {
          return wrapStructured({ id: nn(str(found.id)), name: nn(str(found.name)), parent_id: nn(str(found.parent_id)), already_existed: true });
        }
        const created = asRecord(
          await client.call("POST", "/knowledge-base/folders", { body: { name: p.name, parent_id: p.parent_id ?? null } })
        );
        return wrapStructured({ id: nn(str(created.id)), name: nn(str(created.name)), parent_id: nn(str(created.parent_id)), already_existed: false });
      })
  );

  // ── upsert_knowledge_base_document ───────────────────────────────
  server.registerTool(
    "upsert_knowledge_base_document",
    {
      description: `Add a text/markdown document to the knowledge base, or REPLACE its text if a document with the same title already exists in that folder (idempotent by title, so re-running never duplicates). The text is indexed asynchronously: check list_knowledge_base_documents until status is "ready" before testing an agent. Max 1 MB.

Write clear, self-contained markdown: one topic per document, headings, short paragraphs, concrete facts (prices, times, policies). Replacing text needs the knowledge_base:update permission.`,
      inputSchema: {
        title: z.string().describe("Document title (also the idempotency key within the folder)"),
        markdown: z.string().describe("Document body as markdown"),
        folder_id: z.string().optional().describe("Target folder id; omit for the General folder"),
      },
      outputSchema: {
        id: nStr, title: nStr, status: nStr, folder_id: nStr, action: z.enum(["created", "replaced"]),
        hint: nStr,
      },
      annotations: { title: "Add or Replace Knowledge Base Document", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const existing = items(
          await client.call("GET", "/knowledge-base/documents", { params: { search: p.title, folder_id: p.folder_id, page_size: 100 } })
        ).find((d) => norm(d.title) === norm(p.title) && ["manual", "faq"].includes(String(d.document_type)) &&
          (!p.folder_id || d.folder_id === p.folder_id));
        if (existing) {
          if (!can(ctx, "knowledge_base:update")) return permissionMissing(["knowledge_base:update"], "replace an existing document's text");
          const res = asRecord(await client.call("PUT", `/knowledge-base/documents/${encodeURIComponent(String(existing.id))}/raw`, { body: { content: p.markdown } }));
          return wrapStructured({
            id: nn(str(res.id) ?? str(existing.id)), title: nn(str(res.title) ?? str(existing.title)),
            status: nn(str(res.status)), folder_id: nn(str(res.folder_id) ?? str(existing.folder_id)), action: "replaced",
            hint: "Re-indexing started; wait for status ready (list_knowledge_base_documents).",
          });
        }
        const res = asRecord(
          await client.call("POST", "/knowledge-base/documents", {
            body: { title: p.title, document_type: "manual", content: p.markdown, folder_id: p.folder_id },
          })
        );
        return wrapStructured({
          id: nn(str(res.id)), title: nn(str(res.title)), status: nn(str(res.status)), folder_id: nn(str(res.folder_id)),
          action: "created", hint: "Indexing started; wait for status ready (list_knowledge_base_documents).",
        });
      })
  );

  // ── crawl_website ────────────────────────────────────────────────
  server.registerTool(
    "crawl_website",
    {
      description: `Import a website into the knowledge base. Always "preview" first (checks the URL, finds the sitemap, estimates the page count), then "start", then poll "status" until it reports completed (then wait for indexing via list_knowledge_base_documents). "cancel" stops a running crawl.

action:
- preview: needs url. Free, no import.
- start: needs url. Imports pages (page_limit defaults to 50 here to stay safe; raise it on purpose). Crawled pages are indexed and count against your knowledge base usage.
- status: needs job_id from start.
- cancel: needs job_id.`,
      inputSchema: {
        action: z.enum(["preview", "start", "status", "cancel"]),
        url: z.string().optional().describe("Website URL (preview, start)"),
        job_id: z.string().optional().describe("Crawl job id (status, cancel)"),
        follow_links: z.boolean().optional().describe("start: follow links to crawl multiple pages (default true); false = only this page"),
        page_limit: z.number().optional().describe("start: maximum pages (default 50)"),
        max_depth: z.number().optional().describe("start: link depth 1-10"),
        exclude_paths: z.array(z.string()).optional().describe("start: URL path patterns to skip, e.g. /blog/*"),
        language: z.string().optional().describe("start: keep only this language when the site has translations (e.g. en)"),
        title_prefix: z.string().optional().describe("start: prefix for created document titles"),
      },
      outputSchema: {
        action: z.string(), job_id: nStr, status: nStr, message: nStr, valid: nBool, estimated_pages: nNum,
        pages_crawled: nNum, pages_failed: nNum, documents_created: nNum, total_pages: nNum,
        title: nStr, error_message: nStr, details: nObj, next_step: nStr,
      },
      annotations: { title: "Crawl Website into Knowledge Base", readOnlyHint: false, destructiveHint: false },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const need = (field: "url" | "job_id") =>
          toolError("missing_parameter", `${field} is required for action ${p.action}.`, `Provide ${field} and retry.`);
        if (p.action === "preview") {
          if (!p.url) return need("url");
          const r = asRecord(await client.call("POST", "/knowledge-base/documents/crawl/preview", { body: { url: p.url } }));
          return wrapStructured({
            action: "preview", job_id: null, status: null, message: null, valid: nn(typeof r.valid === "boolean" ? r.valid : null),
            estimated_pages: nn(typeof r.estimated_pages === "number" ? r.estimated_pages : null),
            pages_crawled: null, pages_failed: null, documents_created: null, total_pages: null,
            title: nn(str(r.title)), error_message: nn(str(r.error_message)), details: asRecord(r.sitemap),
            next_step: r.valid ? "Call crawl_website with action=start to import it." : "Fix the URL (see error_message) and preview again.",
          });
        }
        if (p.action === "start") {
          if (!p.url) return need("url");
          const r = asRecord(
            await client.call("POST", "/knowledge-base/documents/crawl", {
              body: {
                url: p.url, follow_links: p.follow_links ?? true, page_limit: p.page_limit ?? 50, max_depth: p.max_depth,
                exclude_paths: p.exclude_paths ?? [], language: p.language, title_prefix: p.title_prefix,
              },
            })
          );
          return wrapStructured({
            action: "start", job_id: nn(str(r.job_id)), status: nn(str(r.status)), message: nn(str(r.message)), valid: null,
            estimated_pages: null, pages_crawled: null, pages_failed: null, documents_created: null, total_pages: null,
            title: null, error_message: null, details: null,
            next_step: "Poll crawl_website with action=status and this job_id until status is completed.",
          });
        }
        if (!p.job_id) return need("job_id");
        const id = encodeURIComponent(p.job_id);
        if (p.action === "status") {
          const r = asRecord(await client.call("GET", `/knowledge-base/documents/crawl/${id}/status`));
          const done = r.status === "completed";
          return wrapStructured({
            action: "status", job_id: p.job_id, status: nn(str(r.status)), message: nn(str(r.message)), valid: null, estimated_pages: null,
            pages_crawled: nn(typeof r.pages_crawled === "number" ? r.pages_crawled : null),
            pages_failed: nn(typeof r.pages_failed === "number" ? r.pages_failed : null),
            documents_created: nn(typeof r.documents_created === "number" ? r.documents_created : null),
            total_pages: nn(typeof r.total_pages === "number" ? r.total_pages : null),
            title: null, error_message: null, details: null,
            next_step: done ? "Crawl finished. Check indexing with list_knowledge_base_documents." : "Still running; check again shortly.",
          });
        }
        const r = asRecord(await client.call("POST", `/knowledge-base/documents/crawl/${id}/cancel`));
        return wrapStructured({
          action: "cancel", job_id: p.job_id, status: r.success === false ? "not_cancelled" : "cancelled", message: nn(str(r.message)), valid: null,
          estimated_pages: null, pages_crawled: null, pages_failed: null, documents_created: null, total_pages: null,
          title: null, error_message: null, details: null, next_step: null,
        });
      })
  );

  // ── upsert_faq_entries ───────────────────────────────────────────
  server.registerTool(
    "upsert_faq_entries",
    {
      description: `Add question/answer pairs to the Managed FAQ (the most direct source an agent answers from). Up to 50 per call. Entries whose question already exists (near-identical) are skipped, not duplicated, so re-running is safe. New entries are published immediately and become searchable after indexing.

Write answers as the agent should say them: short, factual, in the customer's language.`,
      inputSchema: {
        entries: z.array(z.object({ question: z.string(), answer: z.string(), language: z.string().optional().describe("e.g. en, de") })).min(1).max(50),
        folder_id: z.string().optional().describe("FAQ folder id; omit for the Managed FAQ folder"),
      },
      outputSchema: {
        created: z.number(), skipped_duplicates: z.number(), failed: z.number(),
        results: z.array(z.object({ question: z.string(), outcome: z.enum(["created", "duplicate", "failed"]), id: nStr, error: nStr })),
      },
      annotations: { title: "Add FAQ Entries", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        type Outcome = { question: string; outcome: "created" | "duplicate" | "failed"; id: string | null; error: string | null };
        // One all-or-nothing batch call. A 409 names the near-duplicate (item_index): drop it,
        // report it as a duplicate and retry the rest, so a re-run is safe.
        let pending = p.entries.map((e, i) => ({ e, i }));
        const results = new Map<number, Outcome>();
        for (let attempt = 0; attempt < 50 && pending.length > 0; attempt++) {
          try {
            const r = asRecord(
              await client.call("POST", "/knowledge-base/faq-items/batch", {
                body: { items: pending.map(({ e }) => ({ question: e.question, answer: e.answer, folder_id: p.folder_id, language: e.language })) },
              })
            );
            const created = items(r);
            pending.forEach(({ e, i }, k) => {
              results.set(i, { question: e.question, outcome: "created", id: nn(str(asRecord(created[k]).id)), error: null });
            });
            pending = [];
          } catch (err) {
            const idx = err instanceof ApiClientError && err.statusCode === 409 ? err.extra?.item_index : undefined;
            if (typeof idx === "number" && idx >= 0 && idx < pending.length) {
              const dup = pending[idx];
              results.set(dup.i, { question: dup.e.question, outcome: "duplicate", id: nn(str(err instanceof ApiClientError ? err.extra?.existing_entry_id : undefined)), error: null });
              pending = pending.filter((_, k) => k !== idx);
            } else if (err instanceof ApiClientError && [401, 402, 403].includes(err.statusCode)) {
              throw err; // same for every entry: fail the call with the mapped error
            } else {
              const msg = err instanceof Error ? err.message : "error";
              for (const { e, i } of pending) results.set(i, { question: e.question, outcome: "failed", id: null, error: msg });
              pending = [];
            }
          }
        }
        const ordered = [...results.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
        return wrapStructured({
          created: ordered.filter((r) => r.outcome === "created").length,
          skipped_duplicates: ordered.filter((r) => r.outcome === "duplicate").length,
          failed: ordered.filter((r) => r.outcome === "failed").length,
          results: ordered,
        });
      })
  );
}

/** Depth-first search of the folder tree for a name under a parent (null = top level). */
function findFolder(folders: Json[], name: string, parentId: string | null): Json | undefined {
  for (const f of folders) {
    if (norm(f.name) === name && (f.parent_id ?? null) === parentId) return f;
    const kids = Array.isArray(f.children) ? (f.children as Json[]) : [];
    const hit = findFolder(kids, name, parentId);
    if (hit) return hit;
  }
  return undefined;
}


