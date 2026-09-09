/**
 * SendSeven API Type Definitions
 *
 * TypeScript types mirroring the SendSeven REST API response shapes.
 */

// ─── Common ──────────────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
  };
}

export interface SuccessResponse {
  success: boolean;
  id?: string;
  message?: string;
}

export interface ApiError {
  detail: string;
  status_code?: number;
}

// ─── Conversations ───────────────────────────────────────────────────
/**
 * Stored statuses are open/assigned/closed; the list endpoint's `status`
 * filter accepts the tab values "open" (excludes snoozed), "snoozed", "closed".
 */
export type ConversationStatus = "open" | "assigned" | "snoozed" | "resolved" | "closed";
export type ChannelType = "whatsapp" | "telegram" | "messenger" | "instagram" | "sms" | "email" | "live_chat" | "rcs";

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  channel_type: ChannelType;
  status: ConversationStatus;
  subject?: string;
  assigned_user_id?: string;
  bot_session_id?: string;
  needs_reply?: boolean;
  created_at: string;
  updated_at: string;
  last_customer_message_at?: string;
  last_agent_reply_at?: string;
  last_message_at?: string;
  /** Embedded contact info as Dict - has name, phone, email, id */
  contact?: Record<string, unknown>;
  tags?: Tag[];
  unread_count?: number;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  url?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  tenant_id?: string;
  platform?: string;
  channel_id?: string;
  contact_id?: string;
  direction: "inbound" | "outbound";
  message_type: string;
  text?: string;
  status: string;
  attachments?: MessageAttachment[];
  /** Customer-defined arbitrary JSON; also carries reaction data under meta.reactions. */
  meta?: Record<string, unknown>;
  created_at: string;
  sent_at?: string;
  delivered_at?: string;
  read_at?: string;
  external_id?: string;
  error_message?: string;
}

// ─── Contacts ────────────────────────────────────────────────────────
/**
 * A single contact method (1:N identifier). Mirrors backend
 * ContactMethodResponse. Platform IDs (whatsapp_id, telegram_id,
 * messenger_id, instagram_id, etc.) live ONLY here — they are no longer
 * flat fields on the contact.
 */
export interface ContactMethod {
  /** This contact method's own id — pass it to actions that need to target a specific method (e.g. setting it primary). */
  id?: string;
  method_type: string; // phone, email, whatsapp_id, telegram_id, messenger_id, instagram_id, linkedin, homepage, facebook, instagram_handle, social_other
  value: string;
  channel_id?: string | null; // set for channel-scoped methods (messenger_id, instagram_id)
  is_primary?: boolean;
}

export interface Contact {
  id: string;
  tenant_id: string;
  /** Single name field (not first_name/last_name) */
  name?: string;
  /** Denormalized from the primary phone method (still present on the contact). */
  phone?: string;
  /** Denormalized from the primary email method (still present on the contact). */
  email?: string;
  /** Platform identifiers (whatsapp/telegram/messenger/instagram) live here. */
  contact_methods?: ContactMethod[];
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  custom_fields?: Record<string, string>;
}

// ─── Contact Lists ──────────────────────────────────────────────────
export type ListType = "static" | "dynamic" | "newsletter";

export interface ContactList {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  list_type: ListType;
  contact_count: string;
  slug?: string;
  created_at: string;
  updated_at: string;
}

// ─── Campaigns ───────────────────────────────────────────────────────
export type CampaignStatus = "draft" | "in_review" | "approved" | "rejected" | "scheduled" | "sending" | "completed" | "paused" | "failed" | "cancelled";

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  message_text: string;
  message_type?: string;
  status: CampaignStatus;
  list_ids?: string[];
  channel_filter?: string[];
  target_url?: string;
  browser_push_title?: string;
  scheduled_at?: string;
  started_at?: string;
  completed_at?: string;
  total_recipients?: number;
  sent_count?: number;
  delivered_count?: number;
  read_count?: number;
  failed_count?: number;
  whatsapp_template_id?: string;
  whatsapp_template_name?: string;
  whatsapp_template_language?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Matches backend EmailCampaignListItem (GET /email-campaigns) exactly.
 * NOTE: `preview_text`, `reply_to_email`, `email_content_id`, and
 * `bounced_count` are NOT part of this schema — there's no bounce count
 * on the list view. `status`/`name` are legacy aliases; `campaign_status`/
 * `campaign_name` are the real fields.
 */
export interface EmailCampaign {
  id: string;
  tenant_id: string;
  campaign_id: string;
  name?: string;
  subject_line: string;
  from_name?: string;
  from_email?: string;
  status?: CampaignStatus;
  campaign_status?: string;
  campaign_name?: string;
  sent_count?: number;
  delivered_count?: number;
  opened_count?: number;
  clicked_count?: number;
  created_at: string;
  updated_at?: string;
}

// ─── Channels ────────────────────────────────────────────────────────
export interface Channel {
  id: string;
  tenant_id: string;
  channel_type: ChannelType;
  name: string;
  is_active: boolean;
  identifier?: string;
  created_at: string;
}

export interface ChannelHealthItem {
  channel_type: string;
  connection_status: string;
  last_error?: string;
}

export interface ChannelHealthResponse {
  has_errors: boolean;
  integrations: ChannelHealthItem[];
}

// ─── Knowledge Base ──────────────────────────────────────────────────
export interface KBSearchResult {
  query: string;
  answer: string;
  citations?: Array<Record<string, unknown>>;
  sources: KBSource[];
  source_count?: number;
}

/**
 * Matches the source dicts built by the backend's Vertex AI RAG retrieval
 * (services/gemini_service.py) — untyped `Dict[str, Any]` on the backend, but
 * always carries at least these keys. NOT `text`/`source_name`/`source_uri`
 * (those never existed backend-side).
 */
export interface KBSource {
  uri?: string;
  title?: string;
  excerpt?: string;
  score?: number;
  type?: string;
  kind?: string;
}

/** Matches backend KBFolderResponse (GET /knowledge-base/folders). */
export interface KBFolder {
  id: string;
  tenant_id?: string;
  name: string;
  slug: string;
  parent_id?: string | null;
  is_system: boolean;
  sort_order: number;
  document_count: number;
  has_corpus: boolean;
  is_ai_searchable: boolean;
  children: KBFolder[];
  created_at: string;
  updated_at: string;
}

export interface KBFolderTreeResponse {
  items: KBFolder[];
  total: number;
}

// ─── Email Providers ─────────────────────────────────────────────────
/** Matches backend EmailProviderConfigResponse (GET /email-providers). */
export interface EmailProviderConfig {
  id: string;
  provider_type: string;
  name: string;
  config?: { from_email?: string; from_name?: string } & Record<string, unknown>;
  /** Domains verified with the provider — a "from_email" using an unverified domain will typically fail to send. */
  verified_domains?: string[] | null;
  is_active: boolean;
  is_default: boolean;
}

// ─── WhatsApp Templates ─────────────────────────────────────────────
export interface WhatsAppTemplate {
  id: string;
  tenant_id: string;
  channel_id: string;
  waba_id?: string;
  template_id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  quality_score?: string;
  header_type?: string;
  header_text?: string;
  body_text?: string;
  footer_text?: string;
  buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
  variable_mapping?: Record<string, string>;
  /** How {{N}} placeholders are addressed: e.g. "positional" vs "named". */
  parameter_format?: string;
  /** Default header media (IMAGE/VIDEO) URL for send_whatsapp_template's header_media_url override. */
  default_header_media_url?: string;
  /** Default header document filename, when header_type is DOCUMENT. */
  default_header_document_filename?: string;
  /** QUICK_REPLY buttons in order, each with its 0-based index and caption. */
  quick_reply_buttons?: Array<{ index: number; caption: string }>;
  /** Carousel card definitions, present only for CAROUSEL templates. */
  carousel_cards?: Array<Record<string, unknown>>;
  last_synced_at?: string;
  created_at?: string;
  updated_at?: string;
}

/** Backend returns {templates, total} not PaginatedResponse */
export interface WhatsAppTemplateListResponse {
  templates: WhatsAppTemplate[];
  total: number;
  channel_id?: string;
  status_filter?: string;
}

// ─── Team Members ───────────────────────────────────────────────────
/** Matches backend TenantUserResponse (GET /users). No `is_active` field exists backend-side. */
export interface TeamMember {
  id: string;
  name?: string;
  email: string;
  role?: string;
  rbac_roles?: Array<{ role_id: string; role_name: string }>;
  avatar_url?: string;
  chat_nickname?: string;
  live_chat_available?: boolean;
  joined_at?: string;
}

// ─── Tags ────────────────────────────────────────────────────────────
export interface Tag {
  id: string;
  tenant_id?: string;
  name: string;
  color?: string;
  created_at?: string;
}

// ─── Notes ───────────────────────────────────────────────────────────
export interface Note {
  id: string;
  conversation_id: string;
  tenant_id: string;
  content: string;
  created_by_user_id: string;
  created_at: string;
}

// ─── Email Thread ───────────────────────────────────────────────────
export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailThreadMessage {
  id: string;
  message_id?: string;
  thread_id?: string;
  in_reply_to?: string;
  references?: string[];
  direction: "inbound" | "outbound";
  from_email: string;
  from_name?: string;
  to_emails: EmailAddress[];
  cc_emails?: EmailAddress[];
  bcc_emails?: EmailAddress[];
  reply_to?: string;
  subject?: string;
  text_body?: string;
  html_body?: string;
  attachments?: MessageAttachment[];
  status: string;
  sent_at?: string;
  received_at?: string;
  created_at: string;
}

export interface EmailThreadResponse {
  conversation_id: string;
  thread_id: string;
  subject?: string;
  messages: EmailThreadMessage[];
  total_messages: number;
  original_from?: EmailAddress;
  original_to: EmailAddress[];
  original_cc: EmailAddress[];
}

export interface EmailReplyResponse {
  email_message_id: string;
  message_id?: string;
  status: string;
  sent_at?: string;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
}

// ─── Available Channels ─────────────────────────────────────────────
export interface EmailMailboxInfo {
  id: string;
  email_address: string;
  name: string;
}

export interface EmailMailbox {
  id: string;
  email_address: string;
  name: string;
  is_default: boolean;
}

export interface AvailableChannelResponse {
  channel_id: string;
  channel_type: string;
  channel_name: string;
  identifier: string;
  status: "available" | "template_required" | "unavailable";
  window_status?: {
    in_window: boolean;
    requires_template: boolean;
    last_customer_message_at?: string;
    window_end_at?: string;
  };
  email_mailbox?: EmailMailboxInfo;
}

export interface AvailableChannelsResponse {
  contact_id: string;
  channels: AvailableChannelResponse[];
}

// ─── WhatsApp Template Send ─────────────────────────────────────────
export interface SendTemplateResponse {
  success: boolean;
  message_id?: string;
  external_id?: string;
  conversation_id: string;
  error?: string;
  error_code?: number;
  error_details?: string;
}

// ─── Webhook Endpoints ──────────────────────────────────────────────
export interface WebhookEndpoint {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  has_authorization_header: boolean;
  subscribed_events: string[];
  is_active: boolean;
  is_verified: boolean;
  max_retries?: number;
  timeout_seconds?: number;
  last_success_at?: string;
  last_failure_at?: string;
  last_error?: string;
  consecutive_failures?: number;
  /**
   * Circuit-breaker suspension state (WebhookEndpointResponse). The endpoint
   * is suspended for up to 12h with events queued rather than dropped;
   * reactivation_pending_at marks a probation period after a re-verification
   * challenge succeeds but before a real delivery confirms recovery.
   */
  suspended_at?: string;
  next_reactivation_at?: string;
  reactivation_pending_at?: string;
  incident_started_at?: string;
  queued_events_count?: number;
  queued_events_dropped?: number;
  created_at: string;
}

// ─── Team Chat (bot) ────────────────────────────────────────────────

/**
 * Either a previously-uploaded attachment ID, or a public URL SendSeven
 * downloads server-side (with an optional filename). Exactly one form
 * per entry — never both.
 */
export type BotAttachmentInput = { id: string } | { url: string; filename?: string };

export interface BotMessageCreate {
  /** Message text, 1-40,000 characters. */
  text: string;
  /** Display name for the bot (max 50 characters). Bot messages always render with a bot avatar regardless of this field. */
  bot_name?: string;
  /** Previously-uploaded attachment UUIDs. */
  attachment_ids?: string[];
  /** Richer attachment form: each entry is either {id} or {url, filename?}. */
  attachments?: BotAttachmentInput[];
}

export interface BotAttachment {
  id: string;
  filename?: string;
  content_type?: string;
  size_bytes?: number;
  url?: string;
}

export interface BotMessageResponse {
  id: string;
  /** Present for a channel message; absent for a DM. */
  channel_id?: string;
  /** Present for a DM; absent for a channel message. */
  dm_conversation_id?: string;
  sender_type: "bot";
  is_bot: true;
  bot_name?: string;
  content: string;
  message_type: string;
  attachment_ids?: string[];
  attachments?: BotAttachment[];
  mentioned_user_ids?: string[];
  mentioned_all: boolean;
  created_at: string;
}

// ─── Conversation Initiation ────────────────────────────────────────
export interface InitiateConversationResponse {
  conversation_id: string;
  message_id: string;
  channel_type: string;
  status: string;
  requires_template?: boolean;
  error?: string;
}

// ─── MCP Tool Context ────────────────────────────────────────────────
export interface ToolContext {
  accessToken: string;
  tenantId: string;
  userId: string;
  apiUrl: string;
  scopes: string[];
  /** Callback to refresh the access token. Returns the new access token. */
  tokenRefresher?: () => Promise<string>;
}

// ─── Auth ────────────────────────────────────────────────────────────
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

export interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  tenantId: string;
  userId: string;
}
