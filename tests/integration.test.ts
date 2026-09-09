/**
 * Integration Tests
 *
 * Verify the MCP tool registration helpers and scope filtering.
 */

import { describe, it, expect } from "vitest";
import { hasAnyScope, wrapResult, wrapStructured, wrapError } from "../src/tools/helpers.js";

describe("Scope Checking", () => {
  it("should match exact scope", () => {
    expect(hasAnyScope(["conversations:read"], ["conversations:read"])).toBe(true);
  });

  it("should not match different scope", () => {
    expect(hasAnyScope(["conversations:read"], ["contacts:read"])).toBe(false);
  });

  it("should match admin wildcard *:*", () => {
    expect(hasAnyScope(["*:*"], ["conversations:read"])).toBe(true);
    expect(hasAnyScope(["*:*"], ["campaigns:create"])).toBe(true);
  });

  it("should match resource wildcard", () => {
    expect(hasAnyScope(["conversations:*"], ["conversations:read"])).toBe(true);
    expect(hasAnyScope(["conversations:*"], ["conversations:write"])).toBe(true);
    expect(hasAnyScope(["conversations:*"], ["contacts:read"])).toBe(false);
  });

  it("should return true if any scope matches", () => {
    expect(
      hasAnyScope(
        ["conversations:read", "contacts:read"],
        ["contacts:read", "campaigns:create"]
      )
    ).toBe(true);
  });

  it("should return false for empty scopes", () => {
    expect(hasAnyScope([], ["conversations:read"])).toBe(false);
  });
});

describe("wrapResult", () => {
  it("should wrap object in MCP content format", () => {
    const result = wrapResult({ success: true, id: "123" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe("123");
  });

  it("should handle arrays", () => {
    const result = wrapResult([1, 2, 3]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("should handle nested objects", () => {
    const result = wrapResult({
      error: {
        code: "not_found",
        message: "Not found",
        recoverable: true,
        suggestion: "Try again",
      },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("not_found");
    expect(parsed.error.recoverable).toBe(true);
  });
});

describe("wrapStructured", () => {
  it("attaches structuredContent alongside the text content block", () => {
    const data = { total: 3, items: [1, 2, 3] };
    const result = wrapStructured(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual(data);
    // structuredContent must be the raw object (not re-serialized) - the SDK's
    // validateToolOutput() parses this directly against the tool's outputSchema.
    expect(result.structuredContent).toEqual(data);
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe("wrapError", () => {
  it("sets isError: true so the SDK skips outputSchema validation", () => {
    // Tools with an outputSchema must use wrapError() (not wrapResult()) in
    // their catch block: the {error: {...}} envelope never matches a
    // success-shaped outputSchema, and the SDK's validateToolOutput() only
    // skips validation when isError is true.
    const errorPayload = {
      error: { code: "not_found", message: "Not found", recoverable: true, suggestion: "Try again" },
    };
    const result = wrapError(errorPayload);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(errorPayload);
    expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  });
});
