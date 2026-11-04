import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { instrumentServer, classifyResult } from "../src/analytics.js";
import { MCP_SERVER_VERSION, USER_AGENT } from "../src/version.js";
import { SERVER_INFO } from "../src/config.js";

function makeDataset() {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return { points, writeDataPoint: vi.fn((p) => void points.push(p)) } as unknown as AnalyticsEngineDataset & { points: typeof points };
}

async function setup(dataset?: AnalyticsEngineDataset) {
  const server = new McpServer({ name: "s", version: "1" });
  instrumentServer(server, { dataset, tenantId: "tenant-1", userId: "user-1" });
  server.tool("echo_tool", "d", { secret: z.string() }, async ({ secret }) => ({
    content: [{ type: "text" as const, text: `RESULT-${secret}` }],
  }));
  server.tool("failing_tool", "d", async () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "forbidden", message: "private detail" } }) }],
    isError: true,
  }));
  server.registerTool("throwing_tool", { description: "d" }, async () => {
    throw new Error("boom with private data");
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-ai", version: "9.9" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

describe("tool usage analytics", () => {
  it("records tool, tenant, client, outcome, latency and version for every tool", async () => {
    const ds = makeDataset();
    const client = await setup(ds);
    await client.callTool({ name: "echo_tool", arguments: { secret: "TOP-SECRET" } });
    await client.callTool({ name: "failing_tool", arguments: {} });
    await client.callTool({ name: "throwing_tool", arguments: {} });

    expect(ds.points).toHaveLength(3);
    const [ok, err, exc] = ds.points;
    expect(ok.blobs).toEqual(["echo_tool", "tenant-1", "claude-ai", "ok", "", MCP_SERVER_VERSION, "user-1"]);
    expect(ok.indexes).toEqual(["tenant-1"]);
    expect(ok.doubles![1]).toBe(1);
    expect(ok.doubles![0]).toBeGreaterThanOrEqual(0);
    expect(err.blobs).toEqual(["failing_tool", "tenant-1", "claude-ai", "error", "forbidden", MCP_SERVER_VERSION, "user-1"]);
    expect(exc.blobs![3]).toBe("error");
    expect(exc.blobs![4]).toBe("exception");
  });

  it("NEVER records arguments, results or error messages", async () => {
    const ds = makeDataset();
    const client = await setup(ds);
    await client.callTool({ name: "echo_tool", arguments: { secret: "TOP-SECRET" } });
    await client.callTool({ name: "failing_tool", arguments: {} });
    await client.callTool({ name: "throwing_tool", arguments: {} });
    const dump = JSON.stringify(ds.points);
    expect(dump).not.toContain("TOP-SECRET");
    expect(dump).not.toContain("RESULT-");
    expect(dump).not.toContain("private detail");
    expect(dump).not.toContain("private data");
  });

  it("a failing analytics write never breaks the tool call", async () => {
    const ds = { writeDataPoint: vi.fn(() => { throw new Error("AE down"); }) } as unknown as AnalyticsEngineDataset;
    const client = await setup(ds);
    const res = (await client.callTool({ name: "echo_tool", arguments: { secret: "x" } })) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toBe("RESULT-x");
  });

  it("is a no-op without the ANALYTICS binding", async () => {
    const client = await setup(undefined);
    const res = (await client.callTool({ name: "echo_tool", arguments: { secret: "x" } })) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toBe("RESULT-x");
  });

  it("classifyResult only extracts short machine codes", () => {
    expect(classifyResult({ content: [{ type: "text", text: "{}" }] })).toEqual({ outcome: "ok", errorClass: "" });
    expect(classifyResult({ isError: true, content: [{ type: "text", text: "free text with PII" }] })).toEqual({ outcome: "error", errorClass: "error" });
    expect(classifyResult({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "Has Spaces & PII" } }) }] }).errorClass).toBe("error");
  });
});

describe("single version constant", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  it("matches package.json, SERVER_INFO, wrangler var and the User-Agent", () => {
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_INFO.version).toBe(pkg.version);
    expect(USER_AGENT).toBe(`SendSeven-MCP/${pkg.version}`);
    expect(readFileSync(new URL("../wrangler.jsonc.example", import.meta.url), "utf8")).toContain(`"MCP_SERVER_VERSION": "${pkg.version}"`);
  });
  it("no source file hardcodes a User-Agent version", () => {
    for (const f of ["api-client.ts", "auth.ts", "tools/team-chat.ts"]) {
      expect(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).not.toMatch(/SendSeven-MCP\/\d/);
    }
  });
});

describe("token refresh User-Agent", () => {
  it("index.ts sends the versioned User-Agent on the refresh call", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"User-Agent": USER_AGENT/);
  });
});
