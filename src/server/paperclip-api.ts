/**
 * Thin HTTP client for the Paperclip API.
 *
 * Used by tool handlers to call Paperclip as the agent (not the server).
 * Auth is per-call: pass the agent's authToken from AdapterExecutionContext.
 *
 * Base URL resolution order:
 *   1. explicit baseUrl arg
 *   2. PAPERCLIP_API_URL env var
 *   3. http://localhost:3100 (default Paperclip dev port)
 */

export interface PaperclipApiOptions {
  baseUrl?: string;
  authToken: string;
  /** Heartbeat run id - sent as X-Paperclip-Run-Id so writes attribute correctly. */
  runId?: string;
  /** Optional fetch impl override for tests. */
  fetchImpl?: typeof fetch;
}

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/+$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  return "http://localhost:3100";
}

export class PaperclipApi {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly runId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipApiOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.authToken = opts.authToken;
    this.runId = opts.runId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "application/json",
    };
    // Attribute every mutation to this heartbeat run (cross-issue write cap
    // + audit trail require it).
    if (this.runId) headers["X-Paperclip-Run-Id"] = this.runId;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PaperclipApiError(
        `Network error calling Paperclip API: ${reason}`,
        0,
        null,
        `${method} ${path}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = await response.text();
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string"
          ? (parsed as any).error
          : null) ?? `Paperclip API ${response.status} ${response.statusText}`;
      throw new PaperclipApiError(message, response.status, parsed, `${method} ${path}`);
    }

    return parsed as T;
  }

  // ----- Issues -----

  getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
  }

  updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }

  listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/issues${qs}`);
  }

  createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, issue);
  }

  getHeartbeatContext(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  }

  /**
   * Acquire the issue lock for the current run. Required before any
   * write operation (add_comment, update status) on an issue, otherwise
   * Paperclip's sameRunLock check rejects with 409 "Issue run ownership
   * conflict". The run id is read by Paperclip from the JWT claims, so
   * we only need to send agentId + expectedStatuses in the body.
   */
  /**
   * Default checkout statuses: every pre-terminal status an issue can
   * be in when a run picks it up. Excludes "done" and "cancelled" since
   * a finished issue should not be re-checked-out by a new run.
   *
   * Source of truth: ISSUE_STATUSES in @paperclipai/shared/constants.
   * Keep this list in sync if Paperclip ever adds new statuses.
   */
  checkoutIssue(
    issueId: string,
    agentId: string,
    expectedStatuses: string[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
    ],
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/checkout`, {
      agentId,
      expectedStatuses,
    });
  }


  // ----- Comments -----

  listIssueComments(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments`);
  }

  addIssueComment(issueId: string, body: { body: string; [k: string]: unknown }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, body);
  }

  // ----- Agent-scoped secrets -----

  /** List secrets granted to this agent for the current run. */
  async listMySecrets(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request<{ secrets?: Array<Record<string, unknown>> }>(
      "GET",
      "/api/agents/me/secrets",
    );
    return Array.isArray(res?.secrets) ? res.secrets : [];
  }

  /** Resolve the current value of one of this agent's granted secrets. */
  getMySecretValue(key: string): Promise<{ key: string; value: string; version?: string }> {
    return this.request("POST", `/api/agents/me/secrets/${encodeURIComponent(key)}/value`);
  }

  // ----- Agents -----

  /**
   * List all agents in a company. Returns the array directly (no envelope).
   * Used by the list_agents tool so a CEO can discover teammate IDs before
   * delegating work via create_sub_issue or update_issue_status.
   */
  listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  }

  hireAgent(companyId: string, hire: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/agent-hires`, hire);
  }

  wakeAgent(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, body);
  }

  // ----- Approvals -----
  /**
   * Create a company-level approval. Pass `issueIds` to link the approval to
   * specific issues - a pending issue-linked approval counts as a real review
   * path (invalid_issue_disposition gate) and gates the task until resolved.
   * Schema: createApprovalSchema = { type, requestedByAgentId?, payload, issueIds?: uuid[] }.
   */
  createApproval(
    companyId: string,
    approval: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/approvals`, approval);
  }

  listCompanyApprovals(
    companyId: string,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/approvals${qs}`);
  }

  // ----- Issue-thread interactions -----
  /**
   * Create an interaction on an issue thread (request_confirmation,
   * ask_user_questions, ...). A pending interaction is THE canonical review
   * path: it lets the agent move the issue to in_review/blocked without
   * tripping invalid_issue_disposition, and hands control to the board/user.
   *
   * Everything must be nested under `payload`; `payload.version` (literal 1)
   * and `payload.prompt` are mandatory for request_confirmation.
   * The run id is sent via X-Paperclip-Run-Id (set in request()).
   */
  createIssueInteraction(
    issueId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions`, body);
  }

  /**
   * List interactions on an issue (used to check whether a pending
   * confirmation already exists before creating a duplicate).
   */
  listIssueInteractions(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/interactions`);
  }

  // ----- Issue â†” approval linking -----
  /**
   * List approvals linked to an issue (agent-readable). Used by the
   * update_status completion guard: a pending linked approval must block
   * agent-authored done/cancelled so sign-off requests cannot be silently
   * orphaned by closing the task.
   */
  listIssueApprovals(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/approvals`);
  }

  /**
   * Link an EXISTING approval to an issue. Agent-accessible route
   * (POST /api/issues/:id/approvals, body {approvalId}). This repairs
   * approvals created before v2.6 that float company-wide with no issue link,
   * turning them into real gates (linked_pending_approval review path).
   */
  linkIssueApproval(issueId: string, approvalId: string): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/approvals`, {
      approvalId,
    });
  }

  // ----- Interaction lifecycle (respond / accept / reject / withdraw) -----
  /**
   * Answer an ask_user_questions interaction. Body:
   * { answers: [{questionId, optionIds[], otherText?}], summaryMarkdown? }.
   */
  respondIssueInteraction(issueId: string, interactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/respond`, body);
  }

  /** Accept a checkbox/suggest_tasks interaction. Body: {selectedClientKeys?[], selectedOptionIds?[]}. */
  acceptIssueInteraction(issueId: string, interactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`, body);
  }

  /** Reject an interaction. Body: {reason?} (max 4000 chars). */
  rejectIssueInteraction(issueId: string, interactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/reject`, body);
  }

  /** Withdraw YOUR OWN pending interaction (e.g. superseded by new info). Body: {reason?}. */
  withdrawIssueInteraction(issueId: string, interactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/withdraw`, body);
  }

  // ----- Issue documents (versioned markdown: plans, specs, reports) -----
  listIssueDocuments(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/documents`);
  }

  getIssueDocument(issueId: string, key: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`);
  }

  /**
   * Create or update a versioned issue document (the plan-approval primitive).
   * Schema upsertIssueDocumentSchema: {title?, format:"markdown", body<=512KB,
   * changeSummary?<500, baseRevisionId?}. Key must match ^[a-z0-9][a-z0-9_-]*$.
   */
  putIssueDocument(issueId: string, key: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`, body);
  }

  // ----- Work products (PRs, branches, commits, artifacts...) -----
  /** Register a deliverable on an issue. See createIssueWorkProductSchema. */
  createWorkProduct(issueId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/work-products`, body);
  }

  listIssueWorkProducts(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/work-products`);
  }

  // ----- Recovery actions -----
  listRecoveryActions(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/recovery-actions`);
  }

  /**
   * Resolve an active recovery action. Schema resolveIssueRecoveryActionSchema:
   * {actionId?, outcome: restored|false_positive|blocked|cancelled,
   *  sourceIssueStatus: todo|done|in_review|blocked, resolutionNote?}.
   */
  resolveRecoveryAction(issueId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/recovery-actions/resolve`, body);
  }

  // ----- Agent inbox (compact assigned/blocked view) -----
  /** GET /api/agents/me/inbox-lite - compact list of the calling agent's work. */
  getInboxLite(): Promise<unknown> {
    return this.request("GET", `/api/agents/me/inbox-lite`);
  }

  // ----- Item-verdict resolution (request_item_verdicts cards) -----
  /**
   * Submit verdicts on a request_item_verdicts interaction.
   * Schema submitIssueThreadInteractionVerdictsSchema:
   * {verdicts: [{id, verdict: approve|reject|defer, reason?<=4000}]} (1..200).
   */
  submitInteractionVerdicts(issueId: string, interactionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/verdicts`,
      body,
    );
  }

  // ----- Approvals: resubmit after request-revision -----
  /**
   * Resubmit an approval that is in revision_requested status.
   * Body: {payload?} - replaces the approval payload.
   */
  resubmitApproval(approvalId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/approvals/${encodeURIComponent(approvalId)}/resubmit`, body);
  }

  // ----- Decisions (agent-proposed, board-decided) -----
  /**
   * Propose a structured decision. Route requires run context
   * (X-Paperclip-Run-Id, sent automatically). See createDecisionSchema.
   */
  proposeDecision(companyId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/decisions`, body);
  }

  // ----- Attachments -----
  /**
   * Upload a file as an issue attachment. Multipart field name must be `file`.
   * Size cap is the company's attachmentMaxBytes.
   */
  async uploadAttachment(companyId: string, issueId: string, filePath: string): Promise<unknown> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const data = await readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), basename(filePath));
    const headers: Record<string, string> = {};
    if (this.runId) headers["X-Paperclip-Run-Id"] = this.runId;
    if (!this.authToken) throw new Error("uploadAttachment requires an API key");
    headers["Authorization"] = `Bearer ${this.authToken}`;
    const res = await fetch(`${this.baseUrl}/api/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/attachments`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Paperclip API ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /** Download an attachment's content to destPath. Returns bytes written. */
  async downloadAttachment(attachmentId: string, destPath: string): Promise<number> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const headers: Record<string, string> = {};
    headers["Authorization"] = `Bearer ${this.authToken}`;
    const res = await fetch(`${this.baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}/content`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Paperclip API ${res.status}: ${text.slice(0, 500)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, buf);
    return buf.length;
  }
}
