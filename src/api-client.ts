/**
 * SendSeven REST API Client
 *
 * Typed HTTP client that wraps all SendSeven API calls.
 * Used by MCP tools to interact with the SendSeven backend.
 */

import type {
  PaginatedResponse,
  SuccessResponse,
  Conversation,
  Message,
  Contact,
  ContactList,
  Campaign,
  EmailCampaign,
  EmailMailbox,
  EmailProviderConfig,
  Channel,
  ChannelHealthResponse,
  KBSearchResult,
  KBFolderTreeResponse,
  WhatsAppTemplate,
  WhatsAppTemplateListResponse,
  Tag,
  Note,
  ApiError,
  InitiateConversationResponse,
  EmailThreadResponse,
  EmailReplyResponse,
  AvailableChannelsResponse,
  TeamMember,
  SendTemplateResponse,
  WebhookEndpoint,
  BotMessageCreate,
  BotMessageResponse,
} from "./types.js";

export class SendSevenApiClient {
  private baseUrl: string;
  private accessToken: string;
  private tokenRefresher?: () => Promise<string>;

  constructor(baseUrl: string, accessToken: string, tokenRefresher?: () => Promise<string>) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.accessToken = accessToken;
    this.tokenRefresher = tokenRefresher;
  }

  // ─── HTTP Helpers ────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string | number | boolean | string[] | undefined>;
    } = {},
    isRetry = false
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          // Repeatable query param (e.g. ?tag_id=a&tag_id=b) - matches
          // FastAPI's Query(List[str]) parsing on the backend.
          for (const item of value) url.searchParams.append(key, item);
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "SendSeven-MCP/0.2.0",
    };

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // On 401, try refreshing the token once and retry
    if (response.status === 401 && !isRetry && this.tokenRefresher) {
      try {
        this.accessToken = await this.tokenRefresher();
        return this.request<T>(method, path, options, true);
      } catch {
        // Refresh failed - fall through to throw the original 401 error
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      let detail: string;
      try {
        const parsed = JSON.parse(errorBody) as ApiError;
        detail = parsed.detail || errorBody;
      } catch {
        detail = errorBody;
      }

      throw new ApiClientError(response.status, detail, path);
    }

    if (response.status === 204) {
      return { success: true } as T;
    }

    return (await response.json()) as T;
  }

  private get<T>(
    path: string,
    params?: Record<string, string | number | boolean | string[] | undefined>
  ): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // ─── Conversations ──────────────────────────────────────────────

  async listConversations(params: {
    page?: number;
    page_size?: number;
    status?: string;
    assigned_to?: string;
    needs_reply?: boolean;
    search?: string;
    channel_type?: string;
    contact_id?: string;
  } = {}): Promise<PaginatedResponse<Conversation>> {
    return this.get("/conversations", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 20,
      status: params.status,
      assigned_to: params.assigned_to,
      needs_reply: params.needs_reply,
      search: params.search,
      channel_type: params.channel_type,
      contact_id: params.contact_id,
    });
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.get(`/conversations/${conversationId}`);
  }

  async closeConversation(
    conversationId: string,
    options: { notes?: string; summarize?: boolean } = {}
  ): Promise<Conversation> {
    return this.post(`/conversations/${conversationId}/close`, options);
  }

  async assignConversation(
    conversationId: string,
    userId: string
  ): Promise<Conversation> {
    return this.post(`/conversations/${conversationId}/assign/${userId}`);
  }

  async reopenConversation(conversationId: string): Promise<Conversation> {
    return this.post(`/conversations/${conversationId}/reopen`);
  }

  /**
   * Snooze a conversation until a given time. Snooze is a derived state:
   * status stays open, the conversation moves to the Snoozed tab until
   * `snoozed_until` passes.
   */
  async snoozeConversation(
    conversationId: string,
    params: { snoozed_until: string; reopen_on_message?: boolean }
  ): Promise<Conversation> {
    return this.post(`/conversations/${conversationId}/snooze`, {
      snoozed_until: params.snoozed_until,
      reopen_on_message: params.reopen_on_message ?? true,
    });
  }

  /** Clear an active snooze, returning the conversation to the Open tab. */
  async unsnoozeConversation(conversationId: string): Promise<Conversation> {
    return this.delete(`/conversations/${conversationId}/snooze`);
  }

  /**
   * Email the conversation transcript as a branded HTML email.
   * Sent synchronously from the given mailbox.
   */
  async emailConversationTranscript(
    conversationId: string,
    params: {
      mailbox_id: string;
      to_email: string;
      note?: string;
      save_as_contact_method?: boolean;
      language?: string;
    }
  ): Promise<{ success?: boolean; to_email?: string; [key: string]: unknown }> {
    return this.post(`/conversations/${conversationId}/email-transcript`, params);
  }

  /**
   * Create an internal note on a conversation (visible to agents only,
   * never sent to the customer). Appears in the conversation timeline.
   */
  async createInternalNote(params: {
    conversation_id: string;
    text: string;
    mentioned_user_ids?: string[];
    assign_to_user_id?: string;
  }): Promise<Message> {
    return this.post("/messages/internal-notes", {
      conversation_id: params.conversation_id,
      text: params.text,
      mentioned_user_ids: params.mentioned_user_ids ?? [],
      assign_to_user_id: params.assign_to_user_id,
    });
  }

  async initiateConversation(params: {
    contact_id: string;
    channel_id: string;
    message_type?: string;
    content?: string;
  }): Promise<InitiateConversationResponse> {
    return this.post("/conversations/initiate", {
      contact_id: params.contact_id,
      channel_id: params.channel_id,
      message_type: params.message_type || "text",
      content: params.content,
    });
  }

  /**
   * Send an email via POST /conversations/initiate with message_type=email.
   * There is no `mailbox_id` request field — the backend resolves the mailbox
   * by string-splitting `channel_id` ("email_mailbox_{id}"), so the caller
   * must pass the channel_id for the mailbox it wants (see
   * conversation_initiation_service.py).
   */
  async sendEmail(params: {
    contact_id: string;
    channel_id: string;
    subject: string;
    body_html: string;
    cc?: string[];
    bcc?: string[];
    include_signature?: boolean;
    from_email?: string;
    from_name?: string;
    /**
     * Explicit destination override. When set, the backend sends to THIS
     * exact address (even a non-primary contact method, or an address that
     * doesn't match the contact's primary email) instead of falling back to
     * the contact's primary email. See InitiateEmailData.to_email.
     */
    to_email?: string;
  }): Promise<InitiateConversationResponse> {
    const emailPayload: Record<string, unknown> = {
      subject: params.subject,
      body_html: params.body_html,
      cc: params.cc ?? [],
      bcc: params.bcc ?? [],
      include_signature: params.include_signature ?? true,
    };
    if (params.from_email) emailPayload.from_email = params.from_email;
    if (params.from_name) emailPayload.from_name = params.from_name;
    if (params.to_email) emailPayload.to_email = params.to_email;

    return this.post("/conversations/initiate", {
      contact_id: params.contact_id,
      channel_id: params.channel_id,
      message_type: "email",
      email: emailPayload,
    });
  }

  /**
   * Send a message with auto-resolved conversation (backend finds/creates conversation).
   *
   * Addressing: pass `contact_id` (+ `channel_id`) and OMIT `to`. A non-empty
   * `to` is treated by the backend as a literal external channel-address string
   * and short-circuits all server-side contact resolution — passing a contact
   * UUID as `to` was a latent bug. The backend resolves the recipient from
   * contact_id + channel_id.
   */
  async sendMessageToContact(params: {
    contact_id: string;
    text: string;
    channel_id: string;
    /** Attachment IDs (from createAttachmentFromUrl or a prior upload). NOT raw URLs. */
    attachments?: string[];
    /** Positional filename overrides aligned to `attachments` by index. */
    attachment_filenames?: string[];
  }): Promise<Message> {
    const body: Record<string, unknown> = {
      contact_id: params.contact_id,
      text: params.text,
      channel_id: params.channel_id,
    };
    if (params.attachments && params.attachments.length > 0) {
      body.attachments = params.attachments;
      if (params.attachment_filenames && params.attachment_filenames.length > 0) {
        body.attachment_filenames = params.attachment_filenames;
      }
    }
    return this.post("/messages", body);
  }

  /**
   * Resolve a public URL into a stored attachment and return its ID.
   * POST /attachments/from-url fetches the URL server-side (SSRF-guarded,
   * MIME/size validated) and returns the same shape as POST /upload. The
   * returned `id` can be passed in MessageCreate.attachments — POST /messages
   * accepts attachment IDs only, never raw URLs. Per-tenant URL dedup: the
   * same URL returns the existing attachment without re-fetching.
   * Requires scope `messages:create`.
   */
  async createAttachmentFromUrl(
    url: string,
    filename?: string
  ): Promise<{
    id: string;
    attachment_id?: string;
    filename: string;
    content_type: string;
    size: number;
    download_url: string;
    public_url?: string;
  }> {
    const body: Record<string, unknown> = { url };
    if (filename) body.filename = filename;
    return this.post("/attachments/from-url", body);
  }

  // ─── Messages ───────────────────────────────────────────────────

  async listMessages(
    conversationId: string,
    params: { page?: number; page_size?: number } = {}
  ): Promise<PaginatedResponse<Message>> {
    return this.get("/messages", {
      conversation_id: conversationId,
      page: params.page ?? 1,
      page_size: params.page_size ?? 50,
    });
  }

  /**
   * Reply within an existing conversation. Address via `contact_id` + `channel_id`
   * (omit `to`); a non-empty `to` would be treated as a literal external address
   * and short-circuit server-side resolution. `conversation_id` keeps the reply on
   * the existing thread.
   */
  async sendReply(params: {
    contact_id: string;
    channel_id: string;
    conversation_id: string;
    text: string;
    /** Attachment IDs (from createAttachmentFromUrl or a prior upload). NOT raw URLs. */
    attachments?: string[];
    /** Positional filename overrides aligned to `attachments` by index. */
    attachment_filenames?: string[];
  }): Promise<Message> {
    const body: Record<string, unknown> = {
      contact_id: params.contact_id,
      channel_id: params.channel_id,
      conversation_id: params.conversation_id,
      text: params.text,
    };
    if (params.attachments && params.attachments.length > 0) {
      body.attachments = params.attachments;
      if (params.attachment_filenames && params.attachment_filenames.length > 0) {
        body.attachment_filenames = params.attachment_filenames;
      }
    }
    return this.post("/messages", body);
  }

  async sendInteractiveMessage(params: {
    channel_id: string;
    contact_id: string;
    type: string;
    body: string;
    buttons?: Array<{ id: string; title: string }>;
    sections?: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  }): Promise<{ id: string; status: string; external_id?: string }> {
    return this.post("/messages/send/interactive", params);
  }

  // ─── Team Chat (bot) ─────────────────────────────────────────────

  /**
   * Post a message to a Team Chat channel as a bot.
   * `channelRef` accepts either the channel UUID or a name such as "#general"/"general".
   * The channel must have "Allow Bots to send messages" enabled; archived
   * channels always reject bot messages, and the AI Knowledge Base channel
   * (#knowledgebase) permanently has allow_bots forced false — it is the only
   * channel where this is hardcoded rather than a per-channel setting.
   * #general/#shoutbox (system channels) default allow_bots=true and accept
   * bot messages like any other channel unless an admin disables it (403/409).
   */
  async sendBotChannelMessage(
    channelRef: string,
    body: BotMessageCreate
  ): Promise<BotMessageResponse> {
    return this.post(`/team-chat/bot/channels/${encodeURIComponent(channelRef)}/messages`, body);
  }

  /**
   * Send a Team Chat direct message to a user as a bot. Always allowed once
   * authenticated — there is no "Allow Bots" setting or channel restriction for DMs.
   */
  async sendBotDirectMessage(
    userId: string,
    body: BotMessageCreate
  ): Promise<BotMessageResponse> {
    return this.post(`/team-chat/bot/users/${encodeURIComponent(userId)}/messages`, body);
  }

  // ─── Email Thread & Reply ───────────────────────────────────────

  /** Get the full email thread for a conversation (ordered by date). */
  async getConversationEmailThread(conversationId: string): Promise<EmailThreadResponse> {
    return this.get(`/email-integrations/conversations/${conversationId}/email-thread`);
  }

  /** Send an email reply via the dedicated email reply endpoint. */
  async sendEmailReply(
    emailMessageId: string,
    params: {
      text_body: string;
      html_body?: string;
      cc_emails?: string[];
      bcc_emails?: string[];
      subject_override?: string;
      /** IDs of existing attachments to include (from createAttachmentFromUrl or a prior upload). */
      attachment_ids?: string[];
    }
  ): Promise<EmailReplyResponse> {
    return this.post(`/email-integrations/email-messages/${emailMessageId}/reply`, params);
  }

  /**
   * Open an existing conversation for a contact+channel, or create a new one,
   * WITHOUT sending a message (POST /conversations/open-or-create). Used by
   * send_email to obtain a conversation to attach files to via composeEmail,
   * since the initiate path (conversations/initiate) has no attachment field.
   * For email, `channel_id` is the synthetic `email_mailbox_{id}` /
   * `email_integration_{id}` id, which binds the conversation to that mailbox.
   */
  async openOrCreateConversation(params: {
    contact_id: string;
    channel_id: string;
  }): Promise<{ conversation_id: string; is_new: boolean; channel_type: string }> {
    return this.post("/conversations/open-or-create", {
      contact_id: params.contact_id,
      channel_id: params.channel_id,
    });
  }

  /**
   * Compose and send a NEW outbound email inside an existing conversation
   * (POST /email-integrations/conversations/{id}/compose-email). Unlike the
   * initiate path this supports attachment_ids + CC/BCC. Note: this endpoint
   * does NOT append the agent email signature (initiate does).
   */
  async composeEmail(
    conversationId: string,
    params: {
      subject: string;
      html_body?: string;
      text_body?: string;
      cc_emails?: string[];
      bcc_emails?: string[];
      attachment_ids?: string[];
      sender_id?: string;
      /** Explicit destination override — see sendEmail()'s to_email. */
      to_email?: string;
    }
  ): Promise<EmailReplyResponse> {
    return this.post(
      `/email-integrations/conversations/${conversationId}/compose-email`,
      params
    );
  }

  // ─── Contacts ───────────────────────────────────────────────────

  async searchContacts(params: {
    page?: number;
    page_size?: number;
    search?: string;
    tag_id?: string[];
  } = {}): Promise<PaginatedResponse<Contact>> {
    return this.get("/contacts", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 20,
      search: params.search,
      tag_id: params.tag_id,
    });
  }

  async getContact(contactId: string): Promise<Contact> {
    return this.get(`/contacts/${contactId}`);
  }

  async createContact(params: {
    name?: string;
    phone?: string;
    email?: string;
  }): Promise<Contact> {
    return this.post("/contacts", params);
  }

  /** Partial update of a contact (only provided fields are changed). */
  async updateContact(
    contactId: string,
    params: {
      name?: string;
      first_name?: string;
      last_name?: string;
      phone?: string;
      email?: string;
      languages?: string;
      birthday?: string;
    }
  ): Promise<Contact> {
    return this.patch(`/contacts/${contactId}`, params);
  }

  async getContactAvailableChannels(
    contactId: string
  ): Promise<AvailableChannelsResponse> {
    return this.get(`/contacts/${contactId}/available-channels`);
  }

  // ─── Contact Lists ─────────────────────────────────────────────

  async listContactLists(params: {
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<ContactList>> {
    return this.get("/lists", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 50,
    });
  }

  // ─── Campaigns ──────────────────────────────────────────────────

  async listCampaigns(params: {
    campaign_status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Campaign[]> {
    return this.get("/campaigns", {
      campaign_status: params.campaign_status,
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    });
  }

  async createCampaign(params: {
    name: string;
    message_text: string;
    message_type?: string;
    /** Required non-empty — the backend rejects campaigns with no target list (there is no "send to all" mode). */
    list_ids: string[];
    channel_filter?: string[];
    target_url?: string;
    browser_push_title?: string;
    scheduled_at?: string;
    whatsapp_template_name?: string;
    whatsapp_template_language?: string;
  }): Promise<Campaign> {
    return this.post("/campaigns", params);
  }

  async sendCampaign(
    campaignId: string
  ): Promise<{ success: boolean; recipient_count: number }> {
    return this.post(`/campaigns/${campaignId}/send`);
  }

  async getCampaignStatistics(
    campaignId: string
  ): Promise<{ sent_count: number; delivered_count: number; failed_count: number }> {
    return this.get(`/campaigns/${campaignId}/statistics`);
  }

  async estimateCampaignCost(
    campaignId: string
  ): Promise<{ total_cost_eur: number; recipient_count: number; warnings: string[] }> {
    return this.get(`/campaigns/${campaignId}/estimate-cost`);
  }

  // ─── Analytics ──────────────────────────────────────────────────

  async getAgentPerformance(params: {
    start_date?: string;
    end_date?: string;
  } = {}): Promise<Array<{ user_id: string; conversation_count: number; avg_response_time?: number }>> {
    return this.get("/analytics/agents/performance", params);
  }

  // ─── Channels ───────────────────────────────────────────────────

  async listChannels(): Promise<Channel[]> {
    return this.get("/channels");
  }

  async getChannelCapabilities(
    channelId: string
  ): Promise<Record<string, boolean>> {
    return this.get(`/channels/${channelId}/capabilities`);
  }

  async getChannelHealth(): Promise<ChannelHealthResponse> {
    return this.get("/channels/health");
  }

  // ─── Knowledge Base ─────────────────────────────────────────────

  async searchKnowledgeBase(params: {
    query: string;
    limit?: number;
    folder_id?: string;
  }): Promise<KBSearchResult> {
    return this.post("/knowledge-base/search", params);
  }

  /** Get the full KB folder tree (root-level folders with nested children). */
  async getKnowledgeBaseFolders(): Promise<KBFolderTreeResponse> {
    return this.get("/knowledge-base/folders");
  }

  // ─── Tags ───────────────────────────────────────────────────────

  async createTag(params: {
    name: string;
    color?: string;
    description?: string;
  }): Promise<Tag> {
    return this.post("/tags", params);
  }

  async listTags(params: {
    page?: number;
    page_size?: number;
    search?: string;
  } = {}): Promise<PaginatedResponse<Tag>> {
    return this.get("/tags", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 50,
      search: params.search,
    });
  }

  async addTagToConversation(
    conversationId: string,
    tagId: string
  ): Promise<SuccessResponse> {
    return this.post(`/conversations/${conversationId}/tags/${tagId}`);
  }

  async removeTagFromConversation(
    conversationId: string,
    tagId: string
  ): Promise<SuccessResponse> {
    return this.delete(`/conversations/${conversationId}/tags/${tagId}`);
  }

  async addTagToContact(
    contactId: string,
    tagId: string
  ): Promise<SuccessResponse> {
    return this.post(`/contacts/${contactId}/tags/${tagId}`);
  }

  async removeTagFromContact(
    contactId: string,
    tagId: string
  ): Promise<SuccessResponse> {
    return this.delete(`/contacts/${contactId}/tags/${tagId}`);
  }

  // ─── Notes ──────────────────────────────────────────────────────

  async createNote(
    conversationId: string,
    content: string
  ): Promise<Note> {
    return this.post(`/conversations/${conversationId}/notes`, { content });
  }

  async listNotes(
    conversationId: string,
    params: { page?: number; page_size?: number } = {}
  ): Promise<PaginatedResponse<Note>> {
    return this.get(`/conversations/${conversationId}/notes`, {
      page: params.page ?? 1,
      page_size: params.page_size ?? 20,
    });
  }

  // ─── WhatsApp Templates ─────────────────────────────────────────

  async listWhatsAppTemplates(params: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<WhatsAppTemplateListResponse> {
    return this.get("/whatsapp-templates", {
      status: params.status,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    });
  }

  /** Get full details for a single WhatsApp template, including carousel cards and quick-reply buttons. */
  async getWhatsAppTemplate(templateId: string): Promise<WhatsAppTemplate> {
    return this.get(`/whatsapp-templates/${templateId}`);
  }

  /**
   * Send an approved WhatsApp template message.
   *
   * The template can be addressed by name or ID. Recipient selectors
   * (any ONE of): contact_id, contact_method_id, conversation_id, or
   * whatsapp_id (a raw phone number without leading `+`).
   * `variable_values` accepts a list (positional) or dict (positional
   * numeric keys or named keys); reserved dict keys `url_suffix` /
   * `otp_code` fill dynamic URL buttons / OTP copy-code buttons.
   */
  async sendWhatsAppTemplate(
    templateNameOrId: string,
    params: {
      contact_id?: string;
      contact_method_id?: string;
      whatsapp_id?: string;
      conversation_id?: string;
      channel_id?: string;
      language?: string;
      variable_values?: string[] | Record<string, string>;
      header_media_url?: string;
      header_document_filename?: string;
      cards?: Array<{
        variable_values?: string[] | Record<string, string>;
        header_media_url?: string;
      }>;
    }
  ): Promise<SendTemplateResponse> {
    return this.post(`/whatsapp-templates/${encodeURIComponent(templateNameOrId)}/send`, params);
  }

  // ─── Team Members ───────────────────────────────────────────────

  async listTeamMembers(params: {
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<TeamMember>> {
    return this.get("/users", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 50,
    });
  }

  // ─── Email Mailboxes ─────────────────────────────────────────────

  /** GET /email-mailboxes returns a paginated {items, pagination} envelope. */
  async listEmailMailboxes(): Promise<EmailMailbox[]> {
    const result = await this.get<PaginatedResponse<EmailMailbox>>("/email-mailboxes");
    return result.items;
  }

  /** GET /email-providers — includes each provider's verified_domains, useful for validating a send_email from_email before sending. */
  async listEmailProviders(): Promise<EmailProviderConfig[]> {
    return this.get("/email-providers");
  }

  // ─── Email Campaigns ─────────────────────────────────────────────

  async listEmailCampaigns(params: {
    page?: number;
    page_size?: number;
  } = {}): Promise<PaginatedResponse<EmailCampaign>> {
    return this.get("/email-campaigns", {
      page: params.page ?? 1,
      page_size: params.page_size ?? 20,
    });
  }

  async sendEmailCampaign(campaignId: string): Promise<{ success: boolean }> {
    return this.post(`/email-campaigns/${campaignId}/send`);
  }

  async getEmailCampaignAnalytics(campaignId: string): Promise<Record<string, unknown>> {
    return this.get(`/email-campaigns/${campaignId}/analytics`);
  }

  // ─── Webhook Endpoints ───────────────────────────────────────────

  async listWebhooks(): Promise<WebhookEndpoint[]> {
    return this.get("/webhook-endpoints");
  }

  async createWebhook(params: {
    name: string;
    url: string;
    subscribed_events: string[];
    authorization_header?: string;
  }): Promise<WebhookEndpoint> {
    return this.post("/webhook-endpoints", params);
  }

  async deleteWebhook(webhookId: string): Promise<SuccessResponse> {
    return this.delete(`/webhook-endpoints/${webhookId}`);
  }
}

/**
 * Custom error class for API client errors with recovery hints.
 */
export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly path: string;
  public readonly recoverable: boolean;
  public readonly suggestion: string;

  constructor(statusCode: number, detail: string, path: string) {
    super(detail);
    this.name = "ApiClientError";
    this.statusCode = statusCode;
    this.path = path;

    // Determine recoverability and suggestions
    switch (statusCode) {
      case 401:
        this.recoverable = false;
        this.suggestion = "Your session has expired. Please reconnect your SendSeven account.";
        break;
      case 403:
        this.recoverable = false;
        this.suggestion = "You don't have permission for this action. Check your role in SendSeven settings.";
        break;
      case 404:
        this.recoverable = true;
        this.suggestion = "The requested resource was not found. Try searching with different criteria.";
        break;
      case 422:
        this.recoverable = true;
        this.suggestion = "Invalid input. Please check the parameters and try again.";
        break;
      case 429:
        this.recoverable = true;
        this.suggestion = "Rate limit exceeded. Please wait a moment and try again.";
        break;
      default:
        this.recoverable = statusCode < 500;
        this.suggestion = statusCode >= 500
          ? "SendSeven is experiencing issues. Please try again later."
          : "An unexpected error occurred. Please try again.";
    }
  }

  toMcpError(): { error: { code: string; message: string; recoverable: boolean; suggestion: string } } {
    return {
      error: {
        code: this.errorCode(),
        message: this.message,
        recoverable: this.recoverable,
        suggestion: this.suggestion,
      },
    };
  }

  private errorCode(): string {
    switch (this.statusCode) {
      case 401: return "unauthorized";
      case 403: return "forbidden";
      case 404: return "not_found";
      case 422: return "validation_error";
      case 429: return "rate_limited";
      default: return `http_${this.statusCode}`;
    }
  }
}
