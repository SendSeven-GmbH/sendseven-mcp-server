/**
 * MCP resources for the Agent Builder: reference guides the user's LLM reads
 * while authoring agents, skills and flows. Content is generated from
 * developer_docs at build time (scripts/generate-guides.mjs), never hand-copied.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GENERATED_GUIDES } from "./generated-guides.js";

export const GUIDE_URIS: Record<string, string> = {
  "flow-format-spec": "sendseven://guides/flow-format-spec",
  "skills-and-goals": "sendseven://guides/skills-and-goals",
  "agent-fields": "sendseven://guides/agent-fields",
  "run-assistant-node": "sendseven://guides/run-assistant-node",
};

export function registerGuideResources(server: McpServer): void {
  for (const [key, uri] of Object.entries(GUIDE_URIS)) {
    const g = GENERATED_GUIDES[key];
    if (!g) continue;
    server.registerResource(
      `guide-${key}`,
      uri,
      { title: g.title, description: g.description, mimeType: "text/markdown" },
      async (u) => ({ contents: [{ uri: u.href, mimeType: "text/markdown", text: g.text }] })
    );
  }
}
