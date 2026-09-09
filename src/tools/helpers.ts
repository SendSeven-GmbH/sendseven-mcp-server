/**
 * Shared helpers for MCP tool registration.
 */

import type { Contact } from "../types.js";

/**
 * Read a contact method value by method_type from the contact_methods[] list.
 * Platform identifiers (whatsapp_id, telegram_id, messenger_id, instagram_id)
 * now live ONLY in contact_methods[] — there are no flat fields anymore.
 */
export function getContactMethodValue(contact: Contact, methodType: string): string | undefined {
  const methods = contact.contact_methods ?? [];
  // Prefer the primary method of this type, else the first one.
  const primary = methods.find((m) => m.method_type === methodType && m.is_primary);
  const any = methods.find((m) => m.method_type === methodType);
  return (primary ?? any)?.value;
}

/**
 * Check if user has any of the required scopes.
 */
export function hasAnyScope(userScopes: string[], required: string[]): boolean {
  return required.some((scope) => {
    if (userScopes.includes("*:*")) return true;
    if (userScopes.includes(scope)) return true;
    const [resource] = scope.split(":");
    return userScopes.includes(`${resource}:*`);
  });
}

/**
 * Extract the external recipient ID for a given channel type from a contact.
 * This is what the platform needs to deliver the message (phone number, etc.).
 *
 * NOTE: For the actual send paths, prefer the per-channel `identifier` returned
 * by GET /contacts/{id}/available-channels (AvailableChannelResponse.identifier) —
 * the backend resolves it correctly. This helper is a presence/fallback check
 * that reads platform IDs from contact_methods[] (NOT the removed flat fields).
 */
export function getExternalId(contact: Contact, channelType: string): string | undefined {
  switch (channelType) {
    case "whatsapp":
      // A contact that has adopted a WhatsApp username is addressed ONLY by
      // its Business-Scoped User ID (whatsapp_bsuid) — phone/whatsapp_id are
      // withheld from webhooks once that happens, so both must be checked.
      return (
        getContactMethodValue(contact, "whatsapp_id") ??
        getContactMethodValue(contact, "whatsapp_bsuid") ??
        contact.phone
      );
    case "sms":
      return contact.phone ?? getContactMethodValue(contact, "phone");
    case "telegram":
      return getContactMethodValue(contact, "telegram_id");
    case "messenger":
      return getContactMethodValue(contact, "messenger_id");
    case "instagram":
      return getContactMethodValue(contact, "instagram_id");
    case "email":
      return contact.email ?? getContactMethodValue(contact, "email");
    case "live_chat":
      return contact.id;
    default:
      return contact.phone ?? contact.email;
  }
}

/**
 * Wrap a result object into MCP content format.
 */
export function wrapResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Like wrapResult(), but also attaches `structuredContent`. Required for the
 * success path of any tool registered via server.registerTool() with an
 * `outputSchema` — the SDK's validateToolOutput() throws "no structured
 * content was provided" if structuredContent is missing whenever an
 * outputSchema is declared. Not needed (and harmless to skip) for tools
 * without an outputSchema — keep using plain wrapResult() there.
 */
export function wrapStructured(data: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Error-path response for a tool that has an `outputSchema`. Setting
 * `isError: true` makes the SDK skip output-schema validation for this
 * response (see validateToolOutput() in @modelcontextprotocol/sdk/server/mcp.js,
 * which returns early `if (result.isError) return;`), since the shared
 * `{error: {code, message, recoverable, suggestion}}` envelope from
 * ApiClientError.toMcpError() never matches a tool's success outputSchema.
 * Use this instead of wrapResult() in the catch block of any tool that
 * declares an outputSchema.
 */
export function wrapError(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: true,
  };
}
