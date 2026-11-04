#!/usr/bin/env node
/**
 * MCP tool-usage report from Cloudflare Workers Analytics Engine.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/usage-report.mjs [--days 30]
 *
 * The token needs the "Account Analytics: Read" permission. Prints calls,
 * error rate and p50/p95 latency per tool, per tenant, per MCP client and per
 * server version, plus the error classes. Data is metadata only (see
 * src/analytics.ts); the dataset is `sendseven_mcp_tool_calls`.
 *
 * Column layout: blob1 tool, blob2 tenant, blob3 client, blob4 outcome,
 * blob5 error class, blob6 server version, blob7 user, double1 latency ms.
 * SUM(_sample_interval) is the sampling-corrected call count.
 */

const DATASET = "sendseven_mcp_tool_calls";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const days = Math.max(1, Math.min(90, parseInt(arg("days", "30"), 10) || 30));
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read).");
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: query,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine SQL ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body).data ?? [];
}

const WHERE = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const CALLS = "SUM(_sample_interval)";
const ERRORS = "SUM(IF(blob4 = 'error', _sample_interval, 0))";

function table(title, rows, cols) {
  console.log(`\n== ${title} (last ${days} days) ==`);
  if (!rows.length) return console.log("(no data)");
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.fmt(r)).length)));
  console.log(cols.map((c, i) => c.label.padEnd(widths[i])).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(c.fmt(r)).padEnd(widths[i])).join("  "));
}

const pct = (e, c) => (Number(c) ? `${((100 * Number(e)) / Number(c)).toFixed(1)}%` : "-");
const num = (v) => Math.round(Number(v) || 0);

function groupQuery(dim) {
  return `SELECT ${dim} AS k, ${CALLS} AS calls, ${ERRORS} AS errors, ` +
    `quantileWeighted(0.5)(double1, _sample_interval) AS p50, quantileWeighted(0.95)(double1, _sample_interval) AS p95, ` +
    `COUNT(DISTINCT blob7) AS users, COUNT(DISTINCT blob2) AS tenants ` +
    `FROM ${DATASET} WHERE ${WHERE} GROUP BY k ORDER BY calls DESC LIMIT 100`;
}

const groupCols = (label) => [
  { label, fmt: (r) => r.k },
  { label: "calls", fmt: (r) => num(r.calls) },
  { label: "err%", fmt: (r) => pct(r.errors, r.calls) },
  { label: "p50ms", fmt: (r) => num(r.p50) },
  { label: "p95ms", fmt: (r) => num(r.p95) },
  { label: "tenants", fmt: (r) => num(r.tenants) },
  { label: "users", fmt: (r) => num(r.users) },
];

try {
  table("Calls per tool", await sql(groupQuery("blob1")), groupCols("tool"));
  table("Calls per tenant", await sql(groupQuery("blob2")), groupCols("tenant"));
  table("Calls per MCP client", await sql(groupQuery("blob3")), groupCols("client"));
  table("Calls per server version", await sql(groupQuery("blob6")), groupCols("version"));
  table(
    "Error classes per tool",
    await sql(
      `SELECT blob1 AS tool, blob5 AS cls, ${CALLS} AS calls FROM ${DATASET} ` +
        `WHERE ${WHERE} AND blob4 = 'error' GROUP BY tool, cls ORDER BY calls DESC LIMIT 100`
    ),
    [
      { label: "tool", fmt: (r) => r.tool },
      { label: "error class", fmt: (r) => r.cls },
      { label: "calls", fmt: (r) => num(r.calls) },
    ]
  );
  table(
    "Daily calls",
    await sql(
      `SELECT toDate(timestamp) AS day, ${CALLS} AS calls, ${ERRORS} AS errors FROM ${DATASET} ` +
        `WHERE ${WHERE} GROUP BY day ORDER BY day`
    ),
    [
      { label: "day", fmt: (r) => String(r.day).slice(0, 10) },
      { label: "calls", fmt: (r) => num(r.calls) },
      { label: "err%", fmt: (r) => pct(r.errors, r.calls) },
    ]
  );
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
