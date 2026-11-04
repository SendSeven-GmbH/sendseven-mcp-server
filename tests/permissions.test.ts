import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseRequiredScopes, capabilitiesForScopes, scopeGranted } from "../src/permissions.js";
import { SKILL_GROUPS } from "../src/config.js";

describe("parseRequiredScopes", () => {
  it("reads the plain require_scope() string", () => {
    expect(parseRequiredScopes("Missing required permission(s): custom_fields:create, settings:update")).toEqual(["custom_fields:create", "settings:update"]);
  });
  it("reads structured required_scopes / missing_scopes", () => {
    expect(parseRequiredScopes({ code: "agent_publish_not_allowed", required_scopes: ["automation:publish"] })).toEqual(["automation:publish"]);
    expect(parseRequiredScopes({ code: "forbidden_scope", missing_scopes: ["flows:write"] })).toEqual(["flows:write"]);
  });
  it("reads 'requires the x:y scope' messages and ignores unrelated text", () => {
    expect(parseRequiredScopes("Creating contact tokens requires the contacts:read scope")).toEqual(["contacts:read"]);
    expect(parseRequiredScopes("Something else went wrong")).toEqual([]);
  });
});

describe("scope helpers", () => {
  it("scopeGranted honours wildcards", () => {
    expect(scopeGranted(["flows:*"], "flows:write")).toBe(true);
    expect(scopeGranted(["*:*"], "x:y")).toBe(true);
    expect(scopeGranted(["flows:read"], "flows:write")).toBe(false);
  });
  it("capabilitiesForScopes names the consent group", () => {
    expect(capabilitiesForScopes(["automation:publish"])).toEqual(["Agent Builder"]);
    expect(capabilitiesForScopes(["flows:write"])).toEqual(["Flows"]);
  });
  it("every group scope is a well-formed resource:action", () => {
    for (const g of SKILL_GROUPS) for (const s of g.scopes) expect(s).toMatch(/^[a-z_]+:[a-z_]+$/);
  });
});

describe("generated guides", () => {
  it("are up to date with developer_docs (skipped when developer_docs is absent)", () => {
    const docs = resolve(__dirname, "../../developer_docs/docs/guides/flows/flow-format-spec.md");
    if (!existsSync(docs)) return;
    execFileSync("node", ["scripts/generate-guides.mjs", "--check"], { cwd: resolve(__dirname, ".."), stdio: "pipe" });
  });
});
