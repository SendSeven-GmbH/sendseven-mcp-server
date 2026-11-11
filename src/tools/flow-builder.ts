/**
 * Flow tools (Agent Builder): validate, save as draft, publish, test-run.
 *
 * Flow definitions are authored by the user's own LLM; read the resource
 * sendseven://guides/flow-format-spec for the JSON format. Everything here is
 * draft-safe: save_flow_draft refuses to overwrite a live flow, and publishing
 * needs an explicit confirm.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClientError } from "../api-client.js";
import type { ToolContext } from "../types.js";
import { hasAnyScope, wrapStructured } from "./helpers.js";
import { asRecord, can, guard, items, makeClient, nArr, nBool, nNum, nObj, nStr, nn, norm, permissionMissing, str, toolError } from "./builder-common.js";

const flowOut = (f: Record<string, unknown>) => ({
  id: nn(str(f.id)), name: nn(str(f.name)), status: nn(str(f.status)),
  version: typeof f.version === "number" ? f.version : null,
});
const flowSchema = z.object({ id: nStr, name: nStr, status: nStr, version: nNum });

export function registerFlowTools(server: McpServer, ctx: ToolContext): void {
  if (!hasAnyScope(ctx.scopes, ["flows:read", "flows:write", "flows:publish"])) return;

  server.registerTool(
    "validate_flow",
    {
      description: `Check a flow definition WITHOUT saving it. Runs exactly the checks a save runs. Returns valid=true with publish readiness (can_activate and what must still be fixed before publishing), or valid=false with errors[{path, code, message}] pointing at the exact node/field. Fix every error and validate again before save_flow_draft. Format: resource sendseven://guides/flow-format-spec.`,
      inputSchema: {
        definition: z.record(z.unknown()).describe("Flow definition: trigger + nodes[] + edges[] + entry_node_id"),
        flow_id: z.string().optional().describe("Validate as an edit of this existing flow"),
      },
      outputSchema: { valid: z.boolean(), errors: nArr, can_activate: nBool, publish_issues: nArr, is_live: nBool },
      annotations: { title: "Validate Flow", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "flows:read", "flows:write")) return permissionMissing(["flows:read", "flows:write"], "validate flows");
        try {
          const r = asRecord(await makeClient(ctx).call("POST", "/flows/validate", { body: { definition: p.definition, flow_id: p.flow_id } }));
          const v = asRecord(r.validation);
          return wrapStructured({
            valid: true, errors: [], can_activate: typeof v.can_activate === "boolean" ? v.can_activate : null,
            publish_issues: Array.isArray(v.errors) ? v.errors : Array.isArray(v.issues) ? v.issues : [],
            is_live: typeof r.is_live === "boolean" ? r.is_live : null,
          });
        } catch (err) {
          // A rejected definition is the expected answer here, not a tool failure.
          if (err instanceof ApiClientError && err.statusCode === 422) {
            const errors = Array.isArray(err.extra?.errors) ? (err.extra!.errors as unknown[]) : [{ code: err.apiErrorCode ?? "invalid", message: err.message }];
            return wrapStructured({ valid: false, errors, can_activate: null, publish_issues: [], is_live: null });
          }
          throw err;
        }
      })
  );

  server.registerTool(
    "save_flow_draft",
    {
      description: `Create a flow as a DRAFT, or update an existing DRAFT flow (looked up by flow_id, else by exact name, so re-running never duplicates). Drafts never run for customers. A flow that is already published or paused is NOT changed by this tool (edit it in the SendSeven Flow Builder); save under a new name instead. The definition is replaced as a whole. Validate first with validate_flow.`,
      inputSchema: {
        name: z.string().describe("Flow name (idempotency key)"),
        definition: z.record(z.unknown()).describe("Full definition: trigger + nodes[] + edges[] + entry_node_id"),
        description: z.string().optional(),
        flow_id: z.string().optional().describe("Update this draft flow"),
        revision_summary: z.string().optional().describe("Short note for the version history"),
      },
      outputSchema: { flow: flowSchema, action: z.enum(["created", "updated"]), next_step: nStr },
      annotations: { title: "Save Flow Draft", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "flows:write")) return permissionMissing(["flows:write"], "save flows");
        const client = makeClient(ctx);
        let existing: Record<string, unknown> | undefined;
        if (p.flow_id) existing = asRecord(await client.call("GET", `/flows/${encodeURIComponent(p.flow_id)}`));
        else if (can(ctx, "flows:read")) {
          existing = items(await client.call("GET", "/flows", { params: { name: p.name, page_size: 100 } })).find((f) => norm(f.name) === norm(p.name));
        }
        if (existing?.id) {
          if (existing.status !== "draft") {
            return toolError(
              "flow_is_live", `The flow "${String(existing.name)}" is ${String(existing.status)} and was not changed.`,
              "Edit live flows in the SendSeven Flow Builder, or save your version under a new name.", { flow_id: existing.id }
            );
          }
          const updated = asRecord(
            await client.call("PATCH", `/flows/${encodeURIComponent(String(existing.id))}`, {
              body: { version: existing.version, name: p.name, description: p.description, definition: p.definition, revision_summary: p.revision_summary },
            })
          );
          return wrapStructured({ flow: flowOut(updated), action: "updated", next_step: "Test with test_flow, then publish_flow with the user's approval." });
        }
        const created = asRecord(
          await client.call("POST", "/flows", { body: { name: p.name, description: p.description, definition: p.definition, revision_summary: p.revision_summary } })
        );
        return wrapStructured({ flow: flowOut(created), action: "created", next_step: "Test with test_flow, then publish_flow with the user's approval." });
      })
  );

  server.registerTool(
    "publish_flow",
    {
      description: `PUBLISH a flow so it starts running for real customers on its trigger. Only call after the user explicitly approved publishing THIS flow; set confirm=true only then. Without confirm=true nothing changes and you get the flow's publish readiness to show the user. Needs the flows:publish permission.`,
      inputSchema: { flow_id: z.string(), confirm: z.boolean().describe("Must be true, only after explicit user approval") },
      outputSchema: { published: z.boolean(), confirmation_required: z.boolean(), flow: flowSchema.nullable().optional(), can_activate: nBool, issues: nArr, message: nStr },
      annotations: { title: "Publish Flow", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    },
    async (p) =>
      guard(async () => {
        const client = makeClient(ctx);
        const id = encodeURIComponent(p.flow_id);
        if (p.confirm !== true) {
          let can_ = null as boolean | null;
          let issues: unknown[] = [];
          if (can(ctx, "flows:read")) {
            const v = asRecord(await client.call("GET", `/flows/${id}/validation`));
            can_ = typeof v.can_activate === "boolean" ? v.can_activate : null;
            issues = Array.isArray(v.errors) ? v.errors : [];
          }
          return wrapStructured({
            published: false, confirmation_required: true, flow: null, can_activate: can_, issues,
            message: "Nothing was published. Ask the user whether to publish this flow and call again with confirm=true only if they say yes.",
          });
        }
        if (!can(ctx, "flows:publish")) return permissionMissing(["flows:publish"], "publish flows");
        const f = asRecord(await client.call("POST", `/flows/${id}/publish`));
        return wrapStructured({ published: true, confirmation_required: false, flow: flowOut(f), can_activate: true, issues: [], message: "The flow is live." });
      })
  );

  server.registerTool(
    "test_flow",
    {
      description: `Run a flow in the test sandbox (a dry run). Nothing is sent to real customers (sends to other channels are simulated), the flow itself and all real contacts, conversations and customer data are never changed or deleted; the only thing stored is the temporary test run, which action=stop discards. A Conversational Agent step runs for real and may use AI credits.

action:
- start: needs flow_id and trigger_type (e.g. incoming_message) [+ trigger_text]. Returns run_id.
- reply: needs flow_id, run_id, text. Simulates the customer answering a question/menu.
- trace: needs flow_id, run_id. Returns the ordered steps with inputs/outputs.
- stop: needs flow_id, run_id. Ends the run.`,
      inputSchema: {
        action: z.enum(["start", "reply", "trace", "stop"]),
        flow_id: z.string(),
        run_id: z.string().optional(),
        trigger_type: z.string().optional().describe("start: e.g. incoming_message, manual"),
        trigger_text: z.string().optional().describe("start: the simulated first customer message"),
        simulate_channel_id: z.string().optional().describe("start: channel to simulate"),
        text: z.string().optional().describe("reply: customer text"),
      },
      outputSchema: { action: z.string(), run_id: nStr, conversation_id: nStr, steps: nArr, result: nObj, next_step: nStr },
      annotations: { title: "Test Flow", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (p) =>
      guard(async () => {
        if (!can(ctx, "flows:write")) return permissionMissing(["flows:write"], "test flows");
        const client = makeClient(ctx);
        const fid = encodeURIComponent(p.flow_id);
        if (p.action === "start") {
          if (!p.trigger_type) return toolError("missing_parameter", "trigger_type is required.", "Use e.g. incoming_message.");
          const r = asRecord(
            await client.call("POST", `/flows/${fid}/test-run`, {
              body: { trigger_type: p.trigger_type, trigger_text: p.trigger_text, simulate_channel_id: p.simulate_channel_id },
            })
          );
          return wrapStructured({ action: "start", run_id: nn(str(r.run_id)), conversation_id: nn(str(r.conversation_id)), steps: null, result: null, next_step: "Call test_flow action=trace to see what ran, or action=reply to answer a question." });
        }
        if (!p.run_id) return toolError("missing_parameter", "run_id is required.", "Use the run_id from action=start.");
        const rid = encodeURIComponent(p.run_id);
        if (p.action === "reply") {
          const r = asRecord(await client.call("POST", `/flows/${fid}/test-run/${rid}/inbound`, { body: { text: p.text ?? "" } }));
          return wrapStructured({ action: "reply", run_id: p.run_id, conversation_id: null, steps: null, result: r, next_step: "Call action=trace to see the result." });
        }
        if (p.action === "trace") {
          const r = asRecord(await client.call("GET", `/flows/${fid}/test-run/${rid}/trace`));
          return wrapStructured({ action: "trace", run_id: p.run_id, conversation_id: null, steps: Array.isArray(r.steps) ? r.steps : [], result: null, next_step: null });
        }
        const r = asRecord(await client.call("DELETE", `/flows/${fid}/test-run/${rid}`));
        return wrapStructured({ action: "stop", run_id: p.run_id, conversation_id: null, steps: null, result: r, next_step: null });
      })
  );
}
