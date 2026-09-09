/**
 * Authentication Tests
 *
 * Tests for API token detection and scope checking.
 */

import { describe, it, expect } from "vitest";
import { isApiToken, hasScope, hasAnyScope } from "../src/auth.js";

describe("isApiToken", () => {
  it("should detect s7_api_ tokens", () => {
    expect(isApiToken("s7_api_abc123def456")).toBe(true);
  });

  it("should reject unknown-prefixed tokens", () => {
    expect(isApiToken("legacy_abc123def456")).toBe(false);
  });

  it("should reject JWT tokens", () => {
    expect(isApiToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.sig")).toBe(false);
  });

  it("should reject empty strings", () => {
    expect(isApiToken("")).toBe(false);
  });

  it("should reject random strings", () => {
    expect(isApiToken("random-string")).toBe(false);
  });
});

describe("hasScope", () => {
  it("should match exact scope", () => {
    expect(hasScope(["conversations:read", "messages:send"], "conversations:read")).toBe(true);
    expect(hasScope(["conversations:read", "messages:send"], "messages:send")).toBe(true);
  });

  it("should not match missing scope", () => {
    expect(hasScope(["conversations:read"], "campaigns:create")).toBe(false);
  });

  it("should match wildcard resource scope", () => {
    const scopes = ["contacts:*"];
    expect(hasScope(scopes, "contacts:read")).toBe(true);
    expect(hasScope(scopes, "contacts:create")).toBe(true);
    expect(hasScope(scopes, "contacts:delete")).toBe(true);
  });

  it("should not cross resource wildcard boundary", () => {
    expect(hasScope(["contacts:*"], "conversations:read")).toBe(false);
  });

  it("should match admin wildcard", () => {
    const scopes = ["*:*"];
    expect(hasScope(scopes, "anything:anywhere")).toBe(true);
    expect(hasScope(scopes, "conversations:read")).toBe(true);
  });

  it("should handle empty scopes", () => {
    expect(hasScope([], "conversations:read")).toBe(false);
  });
});

describe("hasAnyScope", () => {
  it("should return true if any scope matches", () => {
    expect(
      hasAnyScope(["conversations:read", "contacts:read"], ["contacts:read", "campaigns:create"])
    ).toBe(true);
  });

  it("should return false if no scopes match", () => {
    expect(
      hasAnyScope(["conversations:read"], ["campaigns:create", "messages:send"])
    ).toBe(false);
  });

  it("should return false for empty user scopes", () => {
    expect(hasAnyScope([], ["conversations:read"])).toBe(false);
  });

  it("should handle admin access", () => {
    expect(hasAnyScope(["*:*"], ["conversations:write", "campaigns:send"])).toBe(true);
  });
});
