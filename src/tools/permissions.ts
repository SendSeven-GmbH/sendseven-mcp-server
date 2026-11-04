/**
 * check_permissions: always registered, needs no scope.
 *
 * Tools whose permission was not granted at connect time are not registered, so
 * the assistant cannot even see them. This one lightweight tool lists which
 * capabilities this connection has and which are missing, so the assistant can
 * answer "why can't you build an agent?" and tell the user how to fix it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPermissionReport } from "../permissions.js";
import type { ToolContext } from "../types.js";
import { wrapStructured } from "./helpers.js";

export function registerPermissionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "check_permissions",
    {
      description: `List which SendSeven capabilities this connection has been granted and which are missing (e.g. Agent Builder, Flows, Knowledge Base Authoring). Call it when the user asks for something you have no tool for, or when a tool fails with permission_missing. Missing capabilities are granted by reconnecting SendSeven in the AI client and approving them; a permission the user's SendSeven role does not allow has to be granted by a workspace admin.`,
      inputSchema: {},
      outputSchema: {
        capabilities: z.array(
          z.object({
            id: z.string(), capability: z.string(), description: z.string(),
            status: z.enum(["granted", "partial", "missing"]), missing_scopes: z.array(z.string()),
          })
        ),
        missing_capabilities: z.array(z.string()),
        all_granted: z.boolean(),
        how_to_get_missing: z.string().nullable().optional(),
      },
      annotations: { title: "Check Permissions", readOnlyHint: true, destructiveHint: false },
    },
    async () => wrapStructured(buildPermissionReport(ctx.scopes))
  );
}
