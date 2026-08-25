/**
 * Tool definitions and handlers for the OpenRouter adapter.
 *
 * Architecture:
 *   - Each tool = { schema (sent to the model), execute (called by the loop) }
 *   - buildTools(ctx) closes over agent/company/issue identity so the model
 *     cannot spoof IDs by passing them as arguments
 *   - Errors during execute() are caught and returned as { isError: true }
 *     tool results so the model can recover; only programmer errors throw
 *
 * The schema format matches OpenAI function-calling, which OpenRouter
 * normalizes for any provider that supports tools.
 */

import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";
import { PAPERCLIP_AGENT_ROLES, PAPERCLIP_ISSUE_PRIORITIES, PAPERCLIP_ISSUE_STATUSES } from "../index.js";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

export interface BuildToolsContext {
  api: PaperclipApi;
  agentId: string;
  companyId: string;
  /** The issue this run is working on, if any. Tools default to this when no id is supplied. */
  currentIssueId: string | null;
  /** When false, hire_agent and similar mutating actions go through request_approval first. */
  autoApprove: boolean;
}

// ----- helpers -----

function ok(content: string | Record<string, unknown>): ToolExecutionResult {
  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    isError: false,
  };
}

function fail(message: string, detail?: unknown): ToolExecutionResult {
  const body: Record<string, unknown> = { error: message };
  if (detail !== undefined) body.detail = detail;
  return { content: JSON.stringify(body), isError: true };
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<ToolExecutionResult> {
  try {
    const result = await fn();
    return ok(result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PaperclipApiError) {
      return fail(`${label} failed: ${err.message}`, { status: err.status, body: err.body });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`${label} failed: ${reason}`);
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// ----- tool builders -----

function getIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_issue",
        description:
          "Fetch the full details of an issue (title, description, status, comments, attachments). " +
          "Defaults to the current issue if no id is supplied.",
        parameters: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "Issue id. Omit to use the current issue.",
            },
          },
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("get_issue", () => ctx.api.getIssue(id));
    },
  };
}

function updateIssueStatusTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue_status",
        description:
          "Move an issue to a new status. Valid statuses: " +
          PAPERCLIP_ISSUE_STATUSES.join(", ") +
          ". Defaults to the current issue. " +
          "GUARD: moving an issue to 'done' or 'cancelled' while it still has a PENDING linked approval or pending " +
          "issue_interaction is rejected by this adapter - resolve the review path first (ask the board to decide) " +
          "or pick status='in_review'/'blocked'. This prevents closing tasks out from under unanswered sign-off " +
          "requests.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            status: {
              type: "string",
              enum: [...PAPERCLIP_ISSUE_STATUSES],
            },
            reason: {
              type: "string",
              description: "Optional explanation. When provided it is posted as a comment alongside the status change.",
            },
            force: {
              type: "boolean",
              description:
                "Set true ONLY when you have explicitly confirmed in a comment that the pending approval/interaction " +
                "is being withdrawn or superseded, and the close is intentional despite it. Default false.",
            },
          },
          required: ["status"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const status = asString(args.status);
      if (!status) return fail("status is required.");
      if (!(PAPERCLIP_ISSUE_STATUSES as readonly string[]).includes(status)) {
        return fail(`Invalid status "${status}". Valid: ${PAPERCLIP_ISSUE_STATUSES.join(", ")}`);
      }
      // Completion guard: block agent-authored done/cancelled while a review
      // path is still pending on the issue (unless explicitly forced).
      const terminal = status === "done" || status === "cancelled";
      if (terminal && args.force !== true) {
        const blockers: string[] = [];
        try {
          const approvals = await ctx.api.listIssueApprovals(id);
          const rows = Array.isArray(approvals)
            ? (approvals as Array<Record<string, unknown>>)
            : (((approvals as Record<string, unknown> | null)?.approvals ??
                (approvals as Record<string, unknown> | null)?.items ??
                []) as Array<Record<string, unknown>>);
          for (const a of rows) {
            if (a.status === "pending" || a.status === "revision_requested") {
              blockers.push(`approval ${(a.id as string)?.slice(0, 8)} (${a.type}) status=${a.status}`);
            }
          }
        } catch {
          // Read failed - do not soft-block on our own blindness; let the server decide.
        }
        try {
          const interactions = await ctx.api.listIssueInteractions(id);
          const irows = Array.isArray(interactions)
            ? (interactions as Array<Record<string, unknown>>)
            : (((interactions as Record<string, unknown> | null)?.interactions ??
                (interactions as Record<string, unknown> | null)?.items ??
                []) as Array<Record<string, unknown>>);
          for (const it of irows) {
            if (it.status === "pending") {
              blockers.push(`interaction ${(it.id as string)?.slice(0, 8)} (${it.kind}) status=pending`);
            }
          }
        } catch {
          // Same - server-side gate remains authoritative.
        }
        if (blockers.length > 0) {
          return fail(
            `Cannot set status="${status}": unresolved review paths on this issue: ${blockers.join("; ")}. ` +
              `Resolve them first (board must approve/reject/answer), or use status="in_review"/"blocked" to park ` +
              `the work legitimately. If you are deliberately withdrawing the request(s), post a comment saying so ` +
              `and retry with force=true.`,
            { pendingReviewPaths: blockers },
          );
        }
      }
      const result = await safeCall("update_issue_status", () => ctx.api.updateIssue(id, { status }));
      // Post the reason as a comment so the explanation is visible in-thread.
      const reason = asString(args.reason);
      if (!result.isError && reason) {
        try {
          await ctx.api.addIssueComment(id, { body: `Status set to "${status}": ${reason}` });
        } catch {
          // Non-fatal - the status update already succeeded.
        }
      }
      return result;
    },
  };
}

/**
 * Link an EXISTING (probably company-wide floating) approval to an issue so
 * it becomes a real task gate. Repairs pre-v2.6 approvals.
 */
function linkApprovalTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "link_approval",
        description:
          "Link an existing approval request to an issue so the issue is actually gated by it. Use this to repair " +
          "older approvals that were created without an issue link (they float company-wide and never block their " +
          "task). Defaults to linking onto the current issue.",
        parameters: {
          type: "object",
          properties: {
            approval_id: { type: "string", description: "Approval id (uuid) to link." },
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
          },
          required: ["approval_id"],
        },
      },
    },
    execute: async (args) => {
      const approvalId = asString(args.approval_id);
      if (!approvalId) return fail("approval_id is required.");
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("link_approval", () => ctx.api.linkIssueApproval(id, approvalId));
    },
  };
}

function addCommentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "add_comment",
        description:
          "Post a comment on an issue. Use this to share progress, results, or questions with " +
          "other agents and humans. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            body: { type: "string", description: "Comment body in Markdown." },
          },
          required: ["body"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const body = asString(args.body);
      if (!body) return fail("body is required.");
      return safeCall("add_comment", () => ctx.api.addIssueComment(id, { body }));
    },
  };
}

function listCommentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_comments",
        description: "List all comments on an issue. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
          },
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("list_comments", () => ctx.api.listIssueComments(id));
    },
  };
}

function createSubIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_sub_issue",
        description:
          "Create a child issue under a parent (defaults to the current issue). Use this to break work " +
          "into smaller pieces or delegate to a teammate by setting assigneeId.",
        parameters: {
          type: "object",
          properties: {
            parent_issue_id: { type: "string", description: "Parent issue id. Omit to use current issue." },
            title: { type: "string" },
            description: { type: "string" },
            assignee_agent_id: { type: "string", description: "Optional agent id to assign to." },
            priority: { type: "string", enum: [...PAPERCLIP_ISSUE_PRIORITIES] },
          },
          required: ["title"],
        },
      },
    },
    execute: async (args) => {
      const parentId = asString(args.parent_issue_id, ctx.currentIssueId ?? "");
      const title = asString(args.title);
      if (!title) return fail("title is required.");
      const payload: Record<string, unknown> = {
        title,
        description: args.description ?? "",
        parentId: parentId || undefined,
        assigneeAgentId: args.assignee_agent_id ?? undefined,
        priority: args.priority ?? undefined,
      };
      return safeCall("create_sub_issue", () => ctx.api.createIssue(ctx.companyId, payload));
    },
  };
}

function listIssuesTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_issues",
        description: "List issues in the current company, optionally filtered by status or assignee.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string" },
            assignee_agent_id: { type: "string" },
            limit: { type: "number", description: "Max results, default 20." },
          },
        },
      },
    },
    execute: async (args) => {
      const query: Record<string, string> = {};
      if (typeof args.status === "string") query.status = args.status;
      if (typeof args.assignee_agent_id === "string") query.assigneeAgentId = args.assignee_agent_id;
      query.limit = String(Math.min(Math.max(typeof args.limit === "number" ? Math.floor(args.limit) : 20, 1), 50));
      return safeCall("list_issues", () => ctx.api.listCompanyIssues(ctx.companyId, query));
    },
  };
}

function hireAgentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "hire_agent",
        description:
          "Hire a new agent into the company. By default this creates an approval request that a human " +
          "must approve before the agent is created. Use this when you need a new role on your team.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: {
              type: "string",
              enum: [...PAPERCLIP_AGENT_ROLES],
              description: "Company role. Defaults to 'general'.",
            },
            title: { type: "string", description: "Job title, e.g. 'Senior Engineer'." },
            capabilities: { type: "string", description: "What this agent is responsible for." },
            adapter_type: {
              type: "string",
              description: "Adapter for the new agent, e.g. 'openrouter', 'claude_local'. Default 'openrouter'.",
              default: "openrouter",
            },
            model: { type: "string", description: "Model id for the new agent, e.g. 'openai/gpt-4o-mini'." },
            reports_to_agent_id: { type: "string", description: "Manager agent id (uuid)." },
          },
          required: ["name"],
        },
      },
    },
    execute: async (args) => {
      const name = asString(args.name);
      if (!name) return fail("name is required.");

      const role = asString(args.role, "general");
      if (!(PAPERCLIP_AGENT_ROLES as readonly string[]).includes(role)) {
        return fail(`Invalid role "${role}". Valid: ${PAPERCLIP_AGENT_ROLES.join(", ")}`);
      }

      // Shape expected by POST /api/companies/:companyId/agent-hires
      // (createAgentHireSchema = createAgentSchema + sourceIssueIds).
      const hirePayload: Record<string, unknown> = {
        name,
        role,
        title: asString(args.title) || undefined,
        capabilities: asString(args.capabilities) || undefined,
        adapterType: asString(args.adapter_type, "openrouter"),
        adapterConfig: args.model ? { model: asString(args.model) } : {},
        reportsTo: asString(args.reports_to_agent_id) || null,
        ...(ctx.currentIssueId ? { sourceIssueId: ctx.currentIssueId } : {}),
      };

      if (ctx.autoApprove) {
        return safeCall("hire_agent", () => ctx.api.hireAgent(ctx.companyId, hirePayload));
      }

      // Default path: route through approvals so a human signs off.
      // issueIds links the approval to the task so it gates this issue
      // (linked_pending_approval review path) instead of floating company-wide.
      return safeCall("hire_agent (approval)", () =>
        ctx.api.createApproval(ctx.companyId, {
          type: "hire_agent",
          requestedByAgentId: ctx.agentId,
          ...(ctx.currentIssueId ? { issueIds: [ctx.currentIssueId] } : {}),
          payload: { ...hirePayload, summary: `Hire ${name}${hirePayload.title ? ` as ${hirePayload.title}` : ""}` },
        }),
      );
    },
  };
}

function listAgentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_agents",
        description:
          "List all agents (teammates) in the current company. Returns each agent's id, name, " +
          "role, title, adapter type, model, and status. Use this BEFORE delegating work with " +
          "create_sub_issue or hire_agent so you can reference real agent ids instead of guessing.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    execute: async () => {
      return safeCall("list_agents", async () => {
        const agents = await ctx.api.listCompanyAgents(ctx.companyId);
        // Trim to fields the model actually needs — full agent objects can be huge
        // and waste context window on hundreds of irrelevant runtime config keys.
        return agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          title: a.title,
          adapterType: a.adapterType,
          model: (a.adapterConfig as Record<string, unknown> | undefined)?.model ?? null,
          status: a.status,
          reportsToAgentId: a.reportsToAgentId ?? null,
        }));
      });
    },
  };
}

function requestApprovalTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "request_approval",
        description:
          "Open an approval request for an action that requires human sign-off. Supported types: hire_agent, " +
          "approve_ceo_strategy, budget_override_required, request_board_approval. For hiring, prefer the " +
          "dedicated hire_agent tool instead. The approval is linked to the current issue when one exists, so " +
          "the issue stays gated on the pending approval until a human resolves it.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"],
              description: "Approval type.",
            },
            summary: { type: "string", description: "One-line summary for the operator." },
            payload: { type: "object", description: "Structured payload describing the action." },
            link_issue_id: {
              type: "string",
              description:
                "Optional issue id to link the approval to. Defaults to the current issue. " +
                "Pass the empty string to create the approval without any issue link.",
            },
          },
          required: ["type", "summary"],
        },
      },
    },
    execute: async (args) => {
      const type = asString(args.type);
      const summary = asString(args.summary);
      if (!type) return fail("type is required and must be hire_agent / approve_ceo_strategy / budget_override_required.");
      if (!summary) return fail("summary is required.");
      // Linking: default to the current issue; explicit link_issue_id overrides;
      // explicit empty string opts out of linking entirely.
      let issueIds: string[] = [];
      if (typeof args.link_issue_id === "string") {
        if (args.link_issue_id.trim().length > 0) issueIds = [args.link_issue_id.trim()];
      } else if (ctx.currentIssueId) {
        issueIds = [ctx.currentIssueId];
      }
      const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
      const approval = await safeCall("request_approval", () =>
        ctx.api.createApproval(ctx.companyId, {
          type,
          requestedByAgentId: ctx.agentId,
          ...(issueIds.length > 0 ? { issueIds } : {}),
          payload: { ...payload, summary },
        }),
      );
      // Self-healing linkage: if creation succeeded but the server dropped the
      // link (older host, race with run checkout), verify and repair via the
      // agent-accessible POST /issues/:id/approvals route.
      if (!approval.isError && issueIds.length > 0) {
        try {
          const created = JSON.parse(approval.content) as { id?: string };
          if (created?.id) {
            const linked = (await ctx.api.listIssueApprovals(issueIds[0])) as unknown;
            const rows = Array.isArray(linked)
              ? (linked as Array<Record<string, unknown>>)
              : (((linked as Record<string, unknown> | null)?.approvals ??
                  (linked as Record<string, unknown> | null)?.items ??
                  []) as Array<Record<string, unknown>>);
            if (!rows.some((r) => r.id === created.id)) {
              await ctx.api.linkIssueApproval(issueIds[0], created.id);
            }
          }
        } catch {
          // Verification is best-effort; the approval itself was created.
        }
      }
      return approval;
    },
  };
}

const INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
] as const;

/**
 * Issue-thread interaction tool — THE canonical review path.
 *
 * A pending interaction satisfies Paperclip's disposition gate so the agent
 * can legitimately move an issue to in_review or blocked ("waiting for
 * board/user") instead of having the transition rejected with 422
 * invalid_issue_disposition and continuing to churn on the task.
 */
function issueInteractionTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "issue_interaction",
        description:
          "Post an interaction onto an issue thread to hand control to a human or teammate. Kinds: " +
          "request_confirmation (ask the board to accept/reject your completed work or plan), ask_user_questions " +
          "(ask questions before proceeding), suggest_tasks, request_checkbox_confirmation, request_item_verdicts. " +
          "A pending interaction parks the issue until it is resolved - use this instead of guessing when you need " +
          "a decision. For plan approvals use kind='request_confirmation' with idempotencyKey " +
          "'confirmation:{issueId}:plan:{revisionId}' after updating the plan document.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Issue id. Omit to use the current issue." },
            kind: {
              type: "string",
              enum: [...INTERACTION_KINDS],
              description: "Interaction kind. Default 'request_confirmation'.",
            },
            prompt: {
              type: "string",
              description:
                "What you need confirmed/answered (required for request_confirmation and ask_user_questions). Max ~1000 chars.",
            },
            title: { type: "string", description: "Short title for the interaction (max 240 chars)." },
            summary: { type: "string", description: "One-line context shown in the thread (max 1000 chars)." },
            idempotencyKey: {
              type: "string",
              description:
                "Stable key so retries do not duplicate the same request, e.g. 'confirmation:SUD-12:pr53' or " +
                "'confirmation:{issueId}:plan:{revisionId}'.",
            },
            continuation_policy: {
              type: "string",
              enum: ["wake_assignee", "none"],
              description:
                "wake_assignee re-wakes you automatically when the interaction is resolved; none leaves the issue parked. Default depends on kind.",
            },
          },
          required: ["kind"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const kind = asString(args.kind, "request_confirmation");
      if (!(INTERACTION_KINDS as readonly string[]).includes(kind)) {
        return fail(`Invalid kind "${kind}". Valid: ${INTERACTION_KINDS.join(", ")}`);
      }
      const prompt = asString(args.prompt);
      if ((kind === "request_confirmation" || kind === "ask_user_questions") && !prompt) {
        return fail(`prompt is required for kind="${kind}".`);
      }
      // Dedupe guard: don't stack duplicate pendings on the same issue.
      try {
        const existing = await ctx.api.listIssueInteractions(id);
        const rows = Array.isArray(existing)
          ? existing
          : ((existing as { interactions?: unknown[] } | null)?.interactions ?? []);
        const dup = (rows as Array<Record<string, unknown>>).some(
          (r) =>
            r.kind === kind &&
            r.status === "pending" &&
            (!args.idempotencyKey || r.idempotencyKey === args.idempotencyKey),
        );
        if (dup) {
          return ok({ deduped: true, message: `A pending ${kind} interaction already exists on this issue; not creating another.` });
        }
      } catch {
        // Listing failed - proceed with creation; the server's idempotencyKey still protects against duplicates.
      }
      const body: Record<string, unknown> = {
        kind,
        payload: {
          version: 1,
          ...(prompt ? { prompt } : {}),
        },
      };
      // title/summary/idempotencyKey are top-level fields on the create schema.
      if (args.title) body.title = asString(args.title);
      if (args.summary) body.summary = asString(args.summary);
      if (args.idempotencyKey) body.idempotencyKey = asString(args.idempotencyKey);
      if (args.continuation_policy && typeof args.continuation_policy === "string") {
        body.continuationPolicy = args.continuation_policy;
      }
      return safeCall("issue_interaction", () => ctx.api.createIssueInteraction(id, body));
    },
  };
}

// ----- public API -----

export function buildTools(ctx: BuildToolsContext): Tool[] {
  return [
    getIssueTool(ctx),
    updateIssueStatusTool(ctx),
    addCommentTool(ctx),
    listCommentsTool(ctx),
    createSubIssueTool(ctx),
    listIssuesTool(ctx),
    listAgentsTool(ctx),
    hireAgentTool(ctx),
    requestApprovalTool(ctx),
    issueInteractionTool(ctx),
    linkApprovalTool(ctx),
  ];
}

/** Get the schemas to send to the model. */
export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

/** Look up a tool by name. Returns null if not found. */
export function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((t) => t.schema.function.name === name) ?? null;
}
