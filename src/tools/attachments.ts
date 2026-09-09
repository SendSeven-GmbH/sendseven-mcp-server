/**
 * Attachment Tools
 *
 * Upload a file from a public URL so it can be attached to a message, reply,
 * or email without re-uploading it for every send. There is deliberately no
 * "list attachments" tool — the backend has no endpoint to enumerate
 * previously-created attachments, only to create one from a URL or fetch
 * conversation/message attachments already surfaced by other tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

export function registerAttachmentTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["messages:create"])) return;

  server.tool(
    "upload_attachment",
    `Upload a file from a public URL so it can be reused as an attachment across multiple sends. Returns an attachment id you can pass as {"id": "..."} to send_reply, send_email, or send_message_to_contact's attachments parameter, instead of passing the URL each time.

Note: if the same URL was already uploaded for this tenant, the existing attachment is returned instead of creating a duplicate.

There is no way to list previously-uploaded attachments — save the returned id if you'll need it again.

Examples:
- "Upload this PDF so I can attach it to several replies" → url="https://.../invoice.pdf"
- "Prepare this image as an attachment" → url="https://.../photo.jpg", filename="photo.jpg"`,
    {
      url: z.string().describe("Public URL of the file to upload — SendSeven downloads it server-side"),
      filename: z.string().optional().describe("Optional filename (include the correct extension, e.g. invoice.pdf)"),
    },
    { title: "Upload Attachment", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.createAttachmentFromUrl(params.url, params.filename);

        return wrapResult({
          id: result.id,
          filename: result.filename,
          content_type: result.content_type,
          size: result.size,
          download_url: result.download_url,
          hint: 'Pass {"id": "' + result.id + '"} in the attachments array of send_reply, send_email, or send_message_to_contact.',
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
