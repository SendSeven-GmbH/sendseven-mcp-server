/**
 * Knowledge Base Tools
 *
 * Tools for searching the knowledge base using AI-powered retrieval.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapStructured, wrapResult, wrapError } from "./helpers.js";

export function registerKnowledgeTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["knowledge_base:read"])) return;

  server.registerTool(
    "query_knowledge_base",
    {
      description: `Search the knowledge base using AI. Queries across FAQ documents, website content, uploaded files, and past ticket summaries. Returns an AI-generated answer with source citations.

Examples:
- "What's our refund policy?" → query="refund policy"
- "How do I set up WhatsApp integration?" → query="WhatsApp integration setup"
- "What are our business hours?" → query="business hours"`,
      inputSchema: {
        query: z.string().describe("Natural language question to search the knowledge base"),
        folder_id: z.string().optional().describe("Optional: search within a specific KB folder only"),
        limit: z.number().optional().describe("Max number of source documents to consider (default: 5)"),
      },
      outputSchema: {
        answer: z.string(),
        sources: z.array(
          z.object({
            text: z.string().optional(),
            title: z.string().optional(),
            uri: z.string().optional(),
            relevance_score: z.number().optional(),
          })
        ),
      },
      annotations: { title: "Query Knowledge Base", readOnlyHint: true, destructiveHint: false },
    },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.searchKnowledgeBase({
          query: params.query,
          folder_id: params.folder_id,
          limit: params.limit ?? 5,
        });

        return wrapStructured({
          answer: result.answer,
          sources: result.sources.map((s) => ({
            text: s.excerpt?.substring(0, 200) + (s.excerpt && s.excerpt.length > 200 ? "..." : ""),
            title: s.title,
            uri: s.uri,
            relevance_score: s.score,
          })),
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );

  server.tool(
    "list_knowledge_base_folders",
    `List the knowledge base's folder structure (a tree of folders, e.g. "General", "Websites", "Ticket Summaries", and any custom folders). Each folder shows its document count and id — use a folder's id as the folder_id parameter on query_knowledge_base to search within just that folder.

Examples:
- "What folders are in our knowledge base?"
- "How many documents are in the Product Documentation folder?"`,
    {},
    { title: "List Knowledge Base Folders", readOnlyHint: true, destructiveHint: false },
    async () => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.getKnowledgeBaseFolders();

        const flatten = (folders: typeof result.items): Array<Record<string, unknown>> =>
          folders.map((f) => ({
            id: f.id,
            name: f.name,
            slug: f.slug,
            parent_id: f.parent_id ?? undefined,
            is_system: f.is_system,
            document_count: f.document_count,
            is_ai_searchable: f.is_ai_searchable,
            children: f.children.length > 0 ? flatten(f.children) : undefined,
          }));

        return wrapResult({
          folders: flatten(result.items),
          total: result.total,
          hint: "Use a folder's id as the folder_id parameter on query_knowledge_base to search within just that folder.",
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
