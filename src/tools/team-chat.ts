/**
 * Team Chat Bot Tools
 *
 * Lets an authenticated bot/agent post messages into SendSeven Team Chat,
 * either to a channel or directly to a team member. Message-sending tools
 * are gated on the bot-only `teamchat:write` scope (deliberately no
 * underscore — distinct from the human `team_chat:*` scopes used by the
 * product's own UI/RBAC). `list_team_chat_channels` is a separate, read-only
 * tool gated on `team_chat:read` instead, so a caller that only wants
 * discovery doesn't need write access.
 *
 * Trigger note: there is no MCP tool to *receive* Team Chat messages here.
 * `team_chat.message.created` is a regular webhook event — listed in
 * create_webhook's description and subscribable via create_webhook with zero
 * extra code in this file — but create_webhook has no channel-filter parameter,
 * so a subscription receives every eligible channel's messages. It also
 * fires ONLY for channel messages from channels with "Allow Bots" enabled;
 * Team Chat direct messages never emit a webhook event.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendSevenApiClient, ApiClientError } from "../api-client.js";
import type { ToolContext, BotMessageCreate } from "../types.js";
import { hasAnyScope, wrapResult, wrapError } from "./helpers.js";

const attachmentInputSchema = z.union([
  z.object({ id: z.string().describe("A previously-uploaded attachment ID") }),
  z.object({
    url: z.string().describe("Public image, video, or audio URL - SendSeven downloads it server-side"),
    filename: z.string().optional().describe("Optional filename for the downloaded attachment"),
  }),
]);

function buildBody(params: {
  text: string;
  bot_name?: string;
  attachment_ids?: string[];
  attachments?: Array<{ id: string } | { url: string; filename?: string }>;
}): BotMessageCreate {
  const body: BotMessageCreate = { text: params.text };
  if (params.bot_name) body.bot_name = params.bot_name;
  if (params.attachment_ids && params.attachment_ids.length > 0) {
    body.attachment_ids = params.attachment_ids;
  }
  if (params.attachments && params.attachments.length > 0) {
    body.attachments = params.attachments;
  }
  return body;
}

/**
 * Raw shape of backend `ChannelResponse` (team_chat_schema.py), as returned
 * by both GET /team-chat/channels (joined) and GET /team-chat/channels/browse
 * (not-yet-joined). Kept local to this file rather than added to types.ts -
 * this tool's build is scoped to team-chat.ts + config.ts only.
 */
interface RawTeamChatChannel {
  id: string;
  name: string;
  display_name: string;
  description?: string;
  channel_type: string;
  scope: string;
  is_default: boolean;
  is_system: boolean;
  is_archived: boolean;
  allow_threads: boolean;
  allow_bots: boolean;
  muted?: boolean;
  member_count?: number;
  created_at: string;
  last_message_at?: string;
  is_external: boolean;
  source_tenant_id?: string;
}

/**
 * Minimal standalone GET helper for this file's read-only endpoints.
 * Deliberately does NOT extend SendSevenApiClient (api-client.ts is out of
 * scope for this build) - mirrors its auth-header/401-retry/error-shape
 * conventions so ApiClientError.toMcpError() stays consistent with the rest
 * of the codebase. A future cross-cutting pass could fold this into
 * api-client.ts + types.ts alongside the other tool files.
 */
async function getTeamChatJson<T>(
  ctx: ToolContext,
  path: string,
  params: Record<string, string | boolean | undefined>
): Promise<T> {
  const url = new URL(`${ctx.apiUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const doFetch = (token: string) =>
    fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "SendSeven-MCP/1.0.0",
      },
    });

  let response = await doFetch(ctx.accessToken);
  if (response.status === 401 && ctx.tokenRefresher) {
    try {
      const refreshed = await ctx.tokenRefresher();
      response = await doFetch(refreshed);
    } catch {
      // Refresh failed - fall through to throw the original 401 below.
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    let detail = errorBody;
    try {
      const parsed = JSON.parse(errorBody) as { detail?: string };
      detail = parsed.detail || errorBody;
    } catch {
      // Not JSON - use raw body as the detail.
    }
    throw new ApiClientError(response.status, detail, path);
  }

  return (await response.json()) as T;
}

function summarizeChannel(c: RawTeamChatChannel) {
  return {
    id: c.id,
    channel_ref: `#${c.name}`,
    name: c.name,
    display_name: c.display_name,
    channel_type: c.channel_type,
    scope: c.scope,
    allow_bots: c.allow_bots,
    is_archived: c.is_archived,
    is_system: c.is_system,
    is_external: c.is_external,
    member_count: c.member_count,
  };
}

export function registerTeamChatTools(server: McpServer, ctx: ToolContext): void {
  const canWriteBotMessages = hasAnyScope(ctx.scopes, ["teamchat:write"]);
  const canReadChannels = hasAnyScope(ctx.scopes, ["team_chat:read"]);
  if (!canWriteBotMessages && !canReadChannels) return;

  if (canReadChannels) {
    server.tool(
      "list_team_chat_channels",
      `List SendSeven Team Chat channels, for discovering a valid channel_ref before calling send_team_chat_channel_message. Read-only - requires team_chat:read (a separate scope from the teamchat:write bot-messaging tools).

Two modes:
- Default (include_browsable omitted or false): channels the connected user has already joined.
- include_browsable=true: channels that exist but the user hasn't joined yet (discoverable/joinable channels). A channel doesn't need to be "joined" for send_team_chat_channel_message to work - only allow_bots=true and not archived matter - so this mode is useful for finding channels to post to that the user simply hasn't joined as a human.

Each returned channel includes allow_bots (must be true for bot messages to be accepted) and is_archived (archived channels always reject bot messages), plus id, channel_ref (e.g. "#general", ready to pass straight to send_team_chat_channel_message), name, display_name, channel_type, scope, is_system, is_external, and member_count.

Examples:
- "What channels can I post updates to?" -> include_browsable=false (default), then filter for allow_bots=true and is_archived=false
- "What Team Chat channels exist that I haven't joined?" -> include_browsable=true`,
      {
        include_browsable: z
          .boolean()
          .optional()
          .describe(
            'false (default): list channels the connected user has joined. true: list channels that exist but the user has not joined yet ("browse" mode).'
          ),
        include_archived: z
          .boolean()
          .optional()
          .describe("Only applies when include_browsable is false. Include archived channels in the joined-channels list. Default false."),
        search: z
          .string()
          .optional()
          .describe('Only applies when include_browsable is true. Case-insensitive search filter over browsable channel name/display name.'),
      },
      { title: "List Team Chat Channels", readOnlyHint: true, destructiveHint: false },
      async (params) => {
        try {
          let channels: RawTeamChatChannel[];
          if (params.include_browsable) {
            channels = await getTeamChatJson<RawTeamChatChannel[]>(
              ctx,
              "/team-chat/channels/browse",
              { search: params.search }
            );
          } else {
            const result = await getTeamChatJson<{ channels: RawTeamChatChannel[]; total: number }>(
              ctx,
              "/team-chat/channels",
              { include_archived: params.include_archived ?? false, include_external: true }
            );
            channels = result.channels;
          }

          return wrapResult({
            mode: params.include_browsable ? "browsable" : "joined",
            count: channels.length,
            channels: channels.map(summarizeChannel),
            hint: params.include_browsable
              ? 'These channels exist but the connected user has not joined them yet. A channel with allow_bots=true can still be targeted by send_team_chat_channel_message via channel_ref.'
              : 'These are the channels the connected user has joined. Pass channel_ref (e.g. "#general") to send_team_chat_channel_message.',
          });
        } catch (err) {
          if (err instanceof ApiClientError) return wrapError(err.toMcpError());
          throw err;
        }
      }
    );
  }

  if (!canWriteBotMessages) return;

  server.tool(
    "send_team_chat_channel_message",
    `Post a message to a SendSeven Team Chat channel as a bot. The channel must have "Allow Bots to send messages" enabled in its Team Chat settings; archived channels always reject bot messages, and the AI Knowledge Base channel (#knowledgebase) permanently rejects them too (allow_bots is forced off there). Other system channels like #general/#shoutbox default to allowing bots and behave like any other channel. Bot messages always render with a bot avatar.

Attachments: provide EITHER attachment_ids (previously uploaded) OR attachments (public URLs, downloaded server-side) - both forms are accepted and may be combined.

Examples:
- "Post to #general: Deploy finished successfully" -> channel_ref="#general", text="Deploy finished successfully"
- "Send a screenshot to the ops channel" -> channel_ref="ops", attachments=[{"url": "https://..."}]`,
    {
      channel_ref: z.string().describe('The channel to post to: either the channel UUID or a name such as "#general" or "general"'),
      text: z.string().min(1).max(40000).describe("Message text (1-40,000 characters)"),
      bot_name: z.string().max(50).optional().describe('Display name for the bot (max 50 characters), e.g. "CI Bot". Does not affect the bot avatar, which is always shown.'),
      attachment_ids: z.array(z.string()).optional().describe("Previously-uploaded attachment IDs"),
      attachments: z.array(attachmentInputSchema).optional().describe("Attachments as {id} (existing) or {url, filename?} (public URL, downloaded server-side)"),
    },
    { title: "Send Team Chat Channel Message", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.sendBotChannelMessage(
          params.channel_ref,
          buildBody(params)
        );
        return wrapResult({
          success: true,
          message_id: result.id,
          channel_id: result.channel_id,
          content: result.content,
          hint: `Message posted to Team Chat channel ${params.channel_ref}.`,
        });
      } catch (err) {
        if (err instanceof ApiClientError) {
          const mcpError = err.toMcpError();
          if (err.statusCode === 403) {
            mcpError.error.suggestion =
              'This channel either has "Allow Bots" disabled, or is the AI Knowledge Base channel (#knowledgebase), which never accepts bot messages. Check the channel\'s Team Chat settings, or choose a different channel.';
          } else if (err.statusCode === 404) {
            mcpError.error.suggestion =
              'No channel matched that ID or name. Channel names are matched case-insensitively with or without a leading "#".';
          } else if (err.statusCode === 409) {
            mcpError.error.suggestion = "This channel is archived and no longer accepts new messages.";
          }
          return wrapResult(mcpError);
        }
        throw err;
      }
    }
  );

  server.tool(
    "send_team_chat_direct_message",
    `Send a SendSeven Team Chat direct message to a user as a bot. Always allowed once authenticated - unlike channel messages, there is no "Allow Bots" setting or archived-channel restriction for DMs. Bot messages always render with a bot avatar.

Attachments: provide EITHER attachment_ids (previously uploaded) OR attachments (public URLs, downloaded server-side) - both forms are accepted and may be combined.

Example: "DM user U123: Your report is ready" -> user_id="U123", text="Your report is ready"`,
    {
      user_id: z.string().describe("The user ID of the team member to DM"),
      text: z.string().min(1).max(40000).describe("Message text (1-40,000 characters)"),
      bot_name: z.string().max(50).optional().describe('Display name for the bot (max 50 characters), e.g. "CI Bot". Does not affect the bot avatar, which is always shown.'),
      attachment_ids: z.array(z.string()).optional().describe("Previously-uploaded attachment IDs"),
      attachments: z.array(attachmentInputSchema).optional().describe("Attachments as {id} (existing) or {url, filename?} (public URL, downloaded server-side)"),
    },
    { title: "Send Team Chat Direct Message", readOnlyHint: false, destructiveHint: false },
    async (params) => {
      const client = new SendSevenApiClient(ctx.apiUrl, ctx.accessToken, ctx.tokenRefresher);
      try {
        const result = await client.sendBotDirectMessage(
          params.user_id,
          buildBody(params)
        );
        return wrapResult({
          success: true,
          message_id: result.id,
          dm_conversation_id: result.dm_conversation_id,
          content: result.content,
          hint: `Direct message sent to user ${params.user_id}.`,
        });
      } catch (err) {
        if (err instanceof ApiClientError) return wrapError(err.toMcpError());
        throw err;
      }
    }
  );
}
