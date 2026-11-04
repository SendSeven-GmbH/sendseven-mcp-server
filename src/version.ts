/**
 * Single source of truth for the server version.
 *
 * Used by the MCP server info, the User-Agent sent to the SendSeven API and
 * the usage analytics. Keep in sync with package.json "version" (a test
 * enforces this), then bump `server.json` / CHANGELOG as usual.
 */
export const MCP_SERVER_VERSION = "0.4.0";

/** User-Agent header for every outbound call to the SendSeven API. */
export const USER_AGENT = `SendSeven-MCP/${MCP_SERVER_VERSION}`;
