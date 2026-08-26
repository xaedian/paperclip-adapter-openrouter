/**
 * OpenRouter adapter execute() -- multi-turn tool-calling loop.
 *
 * Restored from the originally-verified v2 implementation and updated for
 * the Paperclip external-adapter contract (adapter-utils >= 2026.4xx):
 *   - AdapterExecutionContext is non-generic; config is merged from
 *     ctx.agent.adapterConfig over ctx.config
 *   - AdapterExecutionResult: exitCode/signal/timedOut required; usage has
 *     input/output (+cached) tokens only; costUsd is top-level
 *   - wake prompt rendered via renderPaperclipWakePrompt(context) -- no
 *     skillsPrompt option; skills are appended to the system prompt here
 *   - issue updates send only schema-known fields (status); reasons go
 *     into comments instead of a statusReason field
 *
 * Auth model (important):
 *   - ctx.authToken is the PAPERCLIP agent JWT (minted by the host because
 *     we declare supportsLocalAgentJwt: true). It authenticates tool calls
 *     against Paperclip's REST API ONLY.
 *   - The OpenRouter key always comes from adapterConfig.apiKey or the
 *     OPENROUTER_API_KEY env var -- never from ctx.authToken.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

/** Mirrors adapter-utils' AdapterExecutionErrorFamily (not exported from its package root). */
type ErrorFamily = "transient_upstream" | "provider_quota" | "model_refusal" |
  "refresh_token_reused" | "refresh_token_expired" | "refresh_token_invalidated";

import {
  OPENROUTER_CHAT_ENDPOINT,
  OPENROUTER_GENERATION_ENDPOINT,
  type OpenRouterConfig,
} from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools, findTool, toolSchemas, type Tool } from "./tools.js";
import { buildExecTools, buildEnvironmentBlock, resolveWorkspaceRoot } from "./exec-tools.js";
import { getModelMaxCompletionTokens, resolveOpenRouterApiKey } from "./test.js";
import { loadSkills, renderSkillsForPrompt } from "./skills.js";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  readPaperclipSkillMarkdown,
} from "@paperclipai/adapter-utils/server-utils";
import {
  emitAssistant,
  emitInit,
  emitResult,
  emitSystem,
  emitThinking,
  emitToolCall,
  emitToolResult,
  writeRawStderr,
} from "./transcript.js";

// -- OpenRouter / OpenAI chat completion types --

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices?: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Unified per-turn result regardless of streaming mode. */
interface TurnOutcome {
  generationId: string | null;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** true when deltas were already emitted to the transcript during the stream. */
  emittedDeltas: boolean;
}

// -- helpers --

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_REQUEST_TIMEOUT_SEC = 600;
const DEFAULT_SYSTEM_PROMPT =
  "You are an AI agent working inside Paperclip, an autonomous company orchestration system. " +
  "When you receive a wake payload, your job is to EXECUTE the assigned task - not describe it. " +
  "Use the tools available to you to read context, post comments, update status, and delegate work. " +
  "Hand-off rules (important): when your work needs human or board sign-off, call issue_interaction with " +
  "kind='request_confirmation' (payload.prompt describes what to confirm), then set status='in_review'. " +
  "When a decision or answer is missing and you cannot proceed, call issue_interaction (kind='ask_user_questions' " +
  "or 'request_confirmation') and set status='blocked'. A pending interaction or a linked approval makes these " +
  "status changes valid; without one they will be rejected. When finished with no review needed, post a summary " +
  "comment via add_comment and call update_issue_status with status='done'. If you cannot complete the work at " +
  "all, explain why in a comment, create an interaction explaining the blocker, then set status='blocked'. " +
  "Approval discipline: NEVER close a task (done/cancelled) while it has a pending linked approval or a pending " +
  "interaction - the update_issue_status tool will refuse; park the task as in_review/blocked instead and wait. " +
  "If you find an older approval floating without an issue link, repair it with link_approval instead of " +
  "creating a duplicate request.";

/**
 * Operating protocol appended to EVERY run's system prompt, including runs
 * with custom instruction files (which otherwise REPLACE the default prompt).
 * This is the single source of truth for Paperclip workflow discipline;
 * per-agent instruction files should only carry role/company specifics.
 */
const OPERATING_PROTOCOL =
  "# Paperclip operating protocol (mandatory - overrides any conflicting guidance)\n\n" +
  "- Hand-off: when work needs human/board sign-off, call issue_interaction kind='request_confirmation' " +
  "(payload.prompt states what to confirm), then set status='in_review'. When blocked on a decision or answer, " +
  "call issue_interaction (kind='ask_user_questions' or 'request_confirmation') and set status='blocked'. " +
  "A pending interaction or linked approval makes these transitions valid.\n" +
  "- Approvals: use the request_approval tool for board sign-off - never raw REST calls. It links the approval to " +
  "the current issue automatically (or pass link_issue_id). One decision = one card; check the thread for an " +
  "existing pending approval before creating another. After filing, name the approval id in a comment and park " +
  "the issue as in_review.\n" +
  "- Completion guard: update_issue_status refuses done/cancelled while a linked approval or pending interaction " +
  "is unresolved. Never close a task out from under an unanswered sign-off; wait, or withdraw the request first " +
  "(issue_interaction action='withdraw') if it was a mistake.\n" +
  "- Plan reviews: put the plan via issue_document (key='plan') first, then request_confirmation with " +
  "idempotencyKey confirmation:{issueId}:plan:{revisionId}. Register deliverables with register_work_product " +
  "(pull_request/branch/commit/preview_url/artifact/document). Resolve stalled-review recovery_action proposals " +
  "instead of ignoring them.\n" +
  "- Prefer the provided tools over raw REST: they validate inputs, link entities correctly, and post visible "
  "evidence. Raw curl bypasses guards and creates unlinked/orphaned records.\n" +
  "- One task per run: identify the single issue this wake is about (stated above or in the wake payload) and do "
  "all work against it. If no issue is pinned, list your assigned issues, pick the one this wake concerns "
  "(in_progress first, then todo), and state your choice explicitly before working.\n" +
  "- Before requesting sign-off you MUST already be working inside that task's context, so request_approval "
  "auto-links it. Never file an approval \"to mention an issue\" - approvals are filed FROM a task.";


/** Merge agent-level adapterConfig over any host-level defaults. */
function resolveConfig(ctx: AdapterExecutionContext): OpenRouterConfig & Record<string, unknown> {
  const hostConfig = (ctx.config ?? {}) as Record<string, unknown>;
  const agentConfig = (ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  return { ...hostConfig, ...agentConfig } as OpenRouterConfig & Record<string, unknown>;
}

function resolveBillingType(_config: OpenRouterConfig): "api" {
  return "api";
}

function buildHeaders(apiKey: string, config: OpenRouterConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.httpReferer || "https://paperclip.ing",
    "X-Title": config.xTitle || "Paperclip",
  };
}

function extractCurrentIssueId(ctx: AdapterExecutionContext): string | null {
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const wakeRaw = context.paperclipWake ?? context;
  const candidates = [
    normalizePaperclipWakePayload(wakeRaw)?.issue?.id ?? undefined,
    context.taskId,
    context.issueId,
    ctx.runtime?.taskKey ?? undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0 && c !== "null") return c.trim();
  }
  return null;
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
  get family(): ErrorFamily | null {
    if (this.status === 429) return "provider_quota";
    if (this.status >= 500) return "transient_upstream";
    return null;
  }
}


/** Unified per-turn result regardless of streaming mode. */
interface TurnOutcome {
  generationId: string | null;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** true when deltas were already emitted to the transcript during the stream. */
  emittedDeltas: boolean;
}

function buildRequestBody(
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (config.reasoning) body.reasoning = { effort: "high" };
  if (config.transforms?.length) body.transforms = config.transforms;
  // Route handling: OpenRouter's legacy "no-fallback" top-level value was
  // retired - the API now accepts route: "fallback" | "sort", and disabling
  // failover is expressed via provider.allow_fallbacks instead.
  if (config.route === "fallback") {
    body.route = "fallback";
  } else if (config.route === "no-fallback") {
    body.provider = { allow_fallbacks: false };
  }
  return body;
}

async function chatTurnNonStream(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  timeoutMs: number,
): Promise<TurnOutcome> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(apiKey, config),
      body: JSON.stringify(buildRequestBody(config, messages, tools, false)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenRouterHttpError(`Network error calling OpenRouter: ${reason}`, 599);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new OpenRouterHttpError(
      `OpenRouter API error (${response.status}): ${text.slice(0, 500)}`,
      response.status,
    );
  }

  let json: ChatCompletionResponse;
  try {
    json = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new OpenRouterHttpError(`OpenRouter returned invalid JSON: ${text.slice(0, 200)}`, 500);
  }

  const choice = json.choices?.[0];
  return {
    generationId: json.id ?? null,
    content: typeof choice?.message.content === "string" ? choice.message.content : "",
    reasoning: typeof choice?.message.reasoning === "string" ? choice.message.reasoning : "",
    toolCalls: (choice?.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage
      ? { prompt_tokens: json.usage.prompt_tokens, completion_tokens: json.usage.completion_tokens }
      : null,
    emittedDeltas: false,
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function mergeToolCallDeltas(
  acc: Map<number, ToolCallAccumulator>,
  deltas: Array<{
    index?: number;
    id?: string | null;
    function?: { name?: string | null; arguments?: string | null };
  }>,
): void {
  for (const d of deltas) {
    const idx = typeof d.index === "number" ? d.index : acc.size;
    const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
    if (typeof d.id === "string" && d.id) cur.id = d.id;
    if (typeof d.function?.name === "string") cur.name += d.function.name;
    if (typeof d.function?.arguments === "string") cur.args += d.function.arguments;
    acc.set(idx, cur);
  }
}

async function chatTurnStream(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  timeoutMs: number,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<TurnOutcome> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(apiKey, config),
      body: JSON.stringify(buildRequestBody(config, messages, tools, true)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpenRouterHttpError(`Network error calling OpenRouter: ${reason}`, 599);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new OpenRouterHttpError(
      `OpenRouter API error (${response.status}): ${errText.slice(0, 500)}`,
      response.status,
    );
  }
  if (!response.body) {
    throw new OpenRouterHttpError("OpenRouter returned an empty stream", 500);
  }

  const outcome: TurnOutcome = {
    generationId: null,
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: null,
    emittedDeltas: true,
  };

  interface StreamEvent {
    id?: string;
    choices?: Array<{
      finish_reason?: string | null;
      delta?: {
        content?: string | null;
        reasoning?: string | null;
        tool_calls?: Array<{
          index?: number;
          id?: string | null;
          function?: { name?: string | null; arguments?: string | null };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: number | string };
  }

  const acc = new Map<number, ToolCallAccumulator>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.error) {
        throw new OpenRouterHttpError(
          `OpenRouter stream error: ${event.error.message ?? JSON.stringify(event.error).slice(0, 200)}`,
          typeof event.error.code === "number" ? event.error.code : 500,
        );
      }
      if (event.id && !outcome.generationId) outcome.generationId = event.id;
      if (event.usage) {
        outcome.usage = {
          prompt_tokens: event.usage.prompt_tokens,
          completion_tokens: event.usage.completion_tokens,
        };
      }
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) outcome.finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        outcome.reasoning += delta.reasoning;
        await emitThinking(onLog, delta.reasoning, { delta: true });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        outcome.content += delta.content;
        await emitAssistant(onLog, delta.content, { delta: true });
      }
      if (delta.tool_calls?.length) mergeToolCallDeltas(acc, delta.tool_calls);
    }
  }

  outcome.toolCalls = [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, v]) => v.name.length > 0)
    .map(([, v]) => ({
      id: v.id || `call_${v.name}_${acc.size}`,
      function: { name: v.name, arguments: v.args || "{}" },
    }));
  return outcome;
}

/** One conservative retry for transient failures (429 / 5xx / network). */
async function chatTurnWithRetry(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  timeoutMs: number,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<TurnOutcome> {
  const attempt = (): Promise<TurnOutcome> =>
    config.stream === false
      ? chatTurnNonStream(apiKey, config, messages, tools, timeoutMs)
      : chatTurnStream(apiKey, config, messages, tools, timeoutMs, onLog);

  try {
    return await attempt();
  } catch (err) {
    const retriable =
      err instanceof OpenRouterHttpError && (err.status === 429 || err.status >= 500 || err.status === 599);
    if (!retriable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return attempt();
  }
}

async function fetchGenerationCost(
  generationId: string,
  apiKey: string,
): Promise<{ costUsd: number | null; inputTokens: number; outputTokens: number }> {
  const fallback = { costUsd: null as number | null, inputTokens: 0, outputTokens: 0 };
  try {
    // OpenRouter's /generation endpoint takes a moment to populate.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(
      `${OPENROUTER_GENERATION_ENDPOINT}?id=${encodeURIComponent(generationId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Record<string, unknown> };
    const d = data.data ?? {};
    return {
      costUsd: typeof d.total_cost === "number" ? d.total_cost : null,
      inputTokens: typeof d.tokens_prompt === "number" ? d.tokens_prompt : 0,
      outputTokens: typeof d.tokens_completion === "number" ? d.tokens_completion : 0,
    };
  } catch {
    return fallback;
  }
}

// -- main --

const ADAPTER_BUILD_MARKER = "openrouter-adapter-build-v2.10.0-live-events";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  await writeRawStderr(ctx.onLog, `[openrouter] ${ADAPTER_BUILD_MARKER}`);
  const config = resolveConfig(ctx);
  const { onLog, authToken } = ctx;
  // Structured-event bridge: mirror key transcript moments into Paperclip's
  // heartbeatRunEvents feed so the live run view renders them in real time
  // (the raw NDJSON transcript is only fully readable after the run ends).
  // Never let telemetry failures break the run.
  const onEvent = ctx.onEvent;
  const emitStructured = async (
    eventType: string,
    message: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> => {
    if (!onEvent) return;
    try {
      await onEvent({
        eventType,
        stream: "system",
        level: "info",
        ...(message !== undefined ? { message } : {}),
        ...(payload !== undefined ? { payload } : {}),
      });
    } catch {
      // Telemetry only - ignore.
    }
  };
  const agent = ctx.agent;

  const model = config.model || "openrouter/auto";
  const maxTurns =
    typeof config.maxTurns === "number" && config.maxTurns > 0
      ? Math.floor(config.maxTurns)
      : DEFAULT_MAX_TURNS;
  const autoApprove = config.autoApprove === true;
  const requestTimeoutMs =
    (typeof config.requestTimeoutSec === "number" && config.requestTimeoutSec > 0
      ? config.requestTimeoutSec
      : DEFAULT_REQUEST_TIMEOUT_SEC) * 1000;

  const resultBase = {
    signal: null as string | null,
    timedOut: false,
    model,
    provider: "openrouter",
    biller: "openrouter",
    billingType: resolveBillingType(config),
    usageBasis: "per_run" as const,
  };

  // Tool handlers need a Paperclip API client. Without authToken the model
  // can still respond, but cannot act.
  let api: PaperclipApi | null = null;
  let tools: Tool[] = [];

  if (authToken) {
    api = new PaperclipApi({ authToken, runId: ctx.runId });
  } else {
    await writeRawStderr(
      onLog,
      "[openrouter] No authToken on context - tool calls disabled. Agent can only generate text.",
    );
  }

  // Resolve the issue this run is working. Wake payload first (assignment /
  // automation wakes carry it); on-demand wakes often don't, so fall back to
  // probing the agent's in-progress issues.
  let currentIssueId = extractCurrentIssueId(ctx);
  if (!currentIssueId && api) {
    try {
      const mine = (await api.listCompanyIssues(agent.companyId, {
        assigneeAgentId: agent.id,
        status: "in_progress",
        limit: "10",
      })) as unknown;
      const list = Array.isArray(mine)
        ? (mine as Record<string, unknown>[])
        : ((mine as { issues?: Record<string, unknown>[] }).issues ?? []);
      const candidate = list
        .slice()
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
      if (candidate && typeof candidate.id === "string") {
        currentIssueId = candidate.id;
        await writeRawStderr(onLog, `[openrouter] wake carried no issue; using in-progress issue ${currentIssueId}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] issue probe failed: ${reason}`);
    }
  }

  if (api) {
    tools = buildTools({
      api,
      agentId: agent.id,
      companyId: agent.companyId,
      currentIssueId,
      autoApprove,
      runIdHint: ctx.runId,
    });

    // Guarded local execution toolset (workspace-confined). Enabled by default;
    // set enableLocalExec: false in adapterConfig to opt an agent out.
    if (config.enableLocalExec !== false) {
      const wsRoot = resolveWorkspaceRoot(config, agent.id);
      if (wsRoot) {
        try {
          const fsMk = await import("node:fs/promises");
          await fsMk.mkdir(wsRoot, { recursive: true });
          tools = tools.concat(buildExecTools({ workspaceRoot: wsRoot, runId: ctx.runId, onLog }));
          await writeRawStderr(onLog, `[openrouter] local exec tools enabled (workspace ${wsRoot})`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await writeRawStderr(onLog, `[openrouter] exec tools disabled - workspace unusable: ${reason}`);
        }
      } else {
        await writeRawStderr(onLog, "[openrouter] exec tools disabled - no home directory resolved");
      }
    }
  }

  await emitInit(onLog, { model, sessionId: ctx.runId });
  await emitStructured("adapter.init", `OpenRouter run starting (model ${model})`, {
    adapter: "openrouter",
    model,
    issueId: currentIssueId,
  });

  // -- build messages --

  const messages: ChatMessage[] = [];
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // Custom instruction files provide ROLE/COMPANY context. They used to REPLACE
  // the whole system prompt, which meant agents with custom files never saw the
  // operating discipline. Now the mandatory OPERATING_PROTOCOL is always
  // appended, so the adapter remains the single source of truth for workflow
  // rules regardless of what an instruction file says.
  if (typeof config.instructionsFilePath === "string" && config.instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(config.instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        const hasProtocol = fileContent.includes("Paperclip operating protocol");
        systemContent = fileContent.trim() +
          (hasProtocol ? "" : `\n\n${OPERATING_PROTOCOL}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] could not read instructionsFilePath ${config.instructionsFilePath}: ${reason}. Falling back to systemPrompt.`,
      );
    }
  }

  try {
    const skills = await loadSkills({ agentConfig: config, onLog });
    if (skills.length > 0) {
      systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
      await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] skill loading error (continuing): ${reason}`);
  }

  // Paperclip-managed skills: desiredSkills synced by the host are materialized
  // and referenced via config; read them and inject alongside external skills.
  try {
    const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
    const desired = new Set(resolvePaperclipDesiredSkillNames(config, entries));
    let injected = 0;
    const blocks: string[] = [];
    for (const entry of entries) {
      if (!desired.has(entry.key)) continue;
      const md = await readPaperclipSkillMarkdown(__moduleDir, entry.key);
      if (!md) continue;
      blocks.push("## Skill: " + entry.runtimeName + "\n\n" + md.trim());
      injected++;
    }
    if (injected > 0) {
      systemContent = systemContent + "\n\n" + blocks.join("\n\n---\n\n");
      await emitSystem(onLog, "Injected " + injected + " Paperclip-managed skill(s)");
    }
  } catch (err) {
    await writeRawStderr(onLog, "[openrouter] managed skill injection failed (continuing): " + (err instanceof Error ? err.message : String(err)));
  }

  // Run-context pinning (mirrors openclaw-gateway): surface the resolved issue
  // in the prompt so the model never guesses which task it is working. Every
  // disposition/approval call should target this issue unless the payload says
  // otherwise.
  let runContextBlock = "";
  if (currentIssueId && api) {
    let identifier: string | null = null;
    try {
      const issueRow = (await api.getIssue(currentIssueId)) as Record<string, unknown>;
      if (typeof issueRow.identifier === "string") identifier = issueRow.identifier;
    } catch {
      /* identifier optional */
    }
    runContextBlock =
      `\n\n## Run context\n` +
      `- Pinned issue: ${identifier ?? "(id only)"} - ${currentIssueId}\n` +
      `- ALL work this run targets the pinned issue: request_approval, update_issue_status, ` +
      `add_comment, issue_interaction, register_work_product default to it automatically.\n` +
      `- When filing a board approval, do NOT restate the issue inside payload; the tool ` +
      `links the pinned issue for you. If you must reference it, use its uuid (${currentIssueId}).\n`;

    // Interaction outcomes: board decisions (accept/reject + reason) are stored
    // on the interaction result, never posted as comments, so without this the
    // agent wakes up blind to WHY its sign-off was rejected. Surface recent
    // resolutions verbatim, oldest-first within the window.
    try {
      const rawRows = await api.listIssueInteractions(currentIssueId);
      const rows = (
        Array.isArray(rawRows) ? rawRows : ((rawRows as { interactions?: unknown[] } | null)?.interactions ?? [])
      ) as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        const fmtWhen = (iso: unknown) => {
          const d = typeof iso === "string" ? new Date(iso) : null;
          return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 16) + "Z" : "?";
        };
        const describe = (r: Record<string, unknown>): string | null => {
          const kind = typeof r.kind === "string" ? r.kind : "interaction";
          const status = typeof r.status === "string" ? r.status : "?";
          const when = fmtWhen(r.resolvedAt);
          const by =
            (typeof r.resolvedByUserId === "string" && r.resolvedByUserId) ||
            (typeof r.resolvedByAgentId === "string" && r.resolvedByAgentId.slice(0, 8)) ||
            "?";
          if (status === "pending") {
            return `[${when}] ${kind} PENDING (awaiting resolution) id=${String(r.id).slice(0, 8)}`;
          }
          const result = (r.result ?? {}) as Record<string, unknown>;
          const outcome = typeof result.outcome === "string" ? result.outcome : status;
          let line = `[${when}] ${kind} ${outcome.toUpperCase()} by ${by}`;
          if (typeof result.reason === "string" && result.reason.trim()) {
            const reason = result.reason.trim().length > 1500 ? result.reason.trim().slice(0, 1500) + "..." : result.reason.trim();
            line += `\n    REASON (authoritative board feedback): ${reason}`;
          }
          return line;
        };
        const sorted = [...rows].sort((a, b) =>
          String(a.resolvedAt ?? a.createdAt ?? "").localeCompare(String(b.resolvedAt ?? b.createdAt ?? ""))
        );
        const relevant = sorted.filter((r) => r.status !== "pending").slice(-8);
        const pending = sorted.filter((r) => r.status === "pending");
        const lines = [
          ...relevant.map(describe).filter((x): x is string => !!x),
          ...pending.map(describe).filter((x): x is string => !!x),
        ];
        if (lines.length > 0) {
          runContextBlock +=
            `\n\n## Recent interaction outcomes (board decisions)\n` +
            lines.map((l) => "- " + l).join("\n") +
            `\n- A REJECTED card's reason above is the board's authoritative change request. ` +
            `Address it before re-filing any confirmation; never re-file an identical ask.\n`;
        }
      }
    } catch {
      /* interactions listing optional */
    }
  }
  if (systemContent.includes("Paperclip operating protocol") || systemContent.length > 0) {
    systemContent += runContextBlock;
  }

  // Runtime environment facts + configured operator notes. Injected for every
  // run so machine quirks never depend on ticket comments or bundle state.
  const wsRootForEnv = resolveWorkspaceRoot(config, agent.id);
  const envBlock = buildEnvironmentBlock(config, wsRootForEnv);
  systemContent = `${systemContent}\n\n${envBlock}`;
  await writeRawStderr(
    onLog,
    `[openrouter] environment block injected (${(envBlock.match(/^- /gm) ?? []).length} entries)`,
  );

  messages.push({ role: "system", content: systemContent });

  // Session persistence: inject previous conversation context so the agent
  // maintains continuity across heartbeats instead of starting fresh.
  const prevSession = ctx.runtime?.sessionParams as Record<string, unknown> | undefined;
  if (prevSession && Array.isArray(prevSession.lastMessages) && prevSession.lastMessages.length > 0) {
    const ctxLines = (prevSession.lastMessages as Array<{ role: string; content: string }>).map(function(m: any) { return "[" + m.role + "]: " + m.content; }).join("\n");
    messages.push({ role: "user", content: "Previous conversation context (for continuity):\n" + ctxLines + "\n\nCurrent task follows." });
  }

  // User prompt = Paperclip wake payload rendered as text.
  const resumedSession = !!ctx.runtime?.sessionId;
  let wakePrompt = "";
  try {
    wakePrompt = renderPaperclipWakePrompt(ctx.context ?? {}, { resumedSession }) || "";
  } catch {
    wakePrompt = "";
  }
  messages.push({
    role: "user",
    content: wakePrompt || JSON.stringify(ctx.context ?? {}),
  });

  // -- acquire the issue run lock --
  //
  // Paperclip rejects writes to an issue unless the caller's run owns its
  // checkout. Heartbeat-dispatched runs are pre-checked-out by the host
  // (wake payload checkedOutByHarness); otherwise we check out explicitly.
  // A failed checkout is not fatal - Paperclip re-verifies ownership on
  // each write anyway.

  const wakeRaw = (ctx.context ?? {}) as Record<string, unknown>;
  const wake = normalizePaperclipWakePayload(wakeRaw.paperclipWake ?? wakeRaw);
  const preLocked = wake?.checkedOutByHarness === true;

  let issueLocked = preLocked;
  if (api && currentIssueId && !preLocked) {
    try {
      await api.checkoutIssue(currentIssueId, agent.id);
      issueLocked = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] checkout call failed for ${currentIssueId}: ${reason}. Continuing - Paperclip may still accept writes if the heartbeat pre-locked the issue.`,
      );
      issueLocked = true;
    }
  }

  // -- mark issue in_progress --

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not set issue in_progress: ${reason}`);
    }
  }

  // -- resolve OpenRouter key (tiered) --

  let apiKey: string;
  try {
    const resolved = await resolveOpenRouterApiKey(config, { api, onLog });
    if (!resolved) {
      throw new Error(
        "OpenRouter API key not found in any tier. Set agent adapterConfig.apiKey (or {{SECRET_REF}}), ~/.openrouter-adapter/config.json (.apiKey), or the OPENROUTER_API_KEY env var on the Paperclip server.",
      );
    }
    apiKey = resolved.key;
    await writeRawStderr(onLog, `[openrouter] using API key from ${resolved.source}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] ${reason}\n`);
    if (api && currentIssueId) {
      await api
        .updateIssue(currentIssueId, { status: "blocked" })
        .catch(() => undefined);
      await api
        .addIssueComment(currentIssueId, { body: `Run blocked: ${reason}` })
        .catch(() => undefined);
    }
    await emitResult(onLog, {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      subtype: "error",
      isError: true,
      errors: [reason],
    });
    return {
      ...resultBase,
      exitCode: 1,
      errorMessage: reason,
      errorCode: "missing_api_key",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: null,
    };
  }

  // Clamp the completion budget to the selected model's advertised maximum
  // (OpenRouter's public catalog). Unknown models keep the configured value.
  let effectiveConfig: OpenRouterConfig & Record<string, unknown> = config;
  try {
    const cap = await getModelMaxCompletionTokens(model);
    const requested = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (cap && cap > 0 && requested > cap) {
      effectiveConfig = { ...config, maxTokens: cap };
      await writeRawStderr(
        onLog,
        `[openrouter] clamped max_tokens ${requested} -> ${cap} (advertised maximum for ${model})`,
      );
    }
  } catch {
    // Catalog unavailable - send the configured value as-is.
  }

  // -- tool loop --

  let lastGenerationId: string | null = null;
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let finalAssistantText = "";
  let turn = 0;
  let toolCallsEmitted = 0;
  let stoppedReason: "completed" | "error" | "max_turns" | "repeat_loop" = "completed";
  let runError: { message: string; code: string; family?: ErrorFamily | null } | null = null;

  // Repeat-call detection: same tool + same args N times in a row breaks the
  // loop instead of burning budget on a stuck model.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;

  try {
    while (turn < maxTurns) {
      turn += 1;

      let outcome: TurnOutcome;
      try {
          // Live transcript events -> heartbeat_run_events feed (drives the Tasks live view).
  const _ignored = ctx.onEvent
    ? async (entry: unknown) => {
        try {
          const ev = ctx.onEvent;
        } catch {
          // Live view feed only - never break the run over telemetry.
        }
      }
    : undefined;

outcome = await chatTurnWithRetry(apiKey, effectiveConfig, messages, tools, requestTimeoutMs, onLog);
      } catch (err) {
        const family = err instanceof OpenRouterHttpError ? err.family : null;
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "openrouter_request_failed", family };
        stoppedReason = "error";
        break;
      }

      if (outcome.generationId) lastGenerationId = outcome.generationId;
      if (outcome.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (outcome.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (outcome.usage.completion_tokens ?? 0),
        };
      }

      const reasoning = outcome.reasoning;
      const text = outcome.content;
      const toolCalls = outcome.toolCalls;

      // Streaming already emitted thinking/content deltas; only emit here for
      // the non-streaming path.
      if (!outcome.emittedDeltas) {
        if (reasoning) await emitThinking(onLog, reasoning);
        if (text) await emitAssistant(onLog, text);
      }
      if (text) finalAssistantText = text;

      // Turn-budget awareness: tell the model when it is close to the cap
      // so it wraps up (commit, post status) instead of being cut off mid-action.
      const remaining = maxTurns - turn;
      if (remaining === 5 || remaining === 2) {
        messages.push({ role: "system", content: `[budget] Tool-turn budget nearly exhausted: ${remaining} round(s) left this run. Wrap up NOW: commit completed work, post a progress comment summarizing state and exact next steps for the next wake.` });
      }

      // No tool calls => model is done.
      if (toolCalls.length === 0) {
        if (outcome.finishReason === "length" && !finalAssistantText.trim()) {
          // Model burned its entire completion budget (often on reasoning)
          // before emitting any user-visible content.
          runError = {
            message:
              `Model hit the completion token limit before producing output (finish_reason=length). ` +
              `Increase "Max completion tokens" for this agent.`,
            code: "token_budget_exhausted",
            family: null,
          };
          stoppedReason = "error";
        } else {
          stoppedReason = "completed";
        }
        break;
      }

      // Echo the assistant message so the model sees its own tool request.
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call and feed results back.
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = safeParseToolArgs(tc.function.arguments);
        toolCallsEmitted += 1;
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });
        await emitStructured("tool.started", `Calling ${toolName}`, {
          toolName,
          toolUseId: tc.id,
          turn,
          inputPreview: JSON.stringify(args).slice(0, 400),
        });

        const tool = findTool(tools, toolName);
        let resultContent: string;
        let isError: boolean;
        if (!tool) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
          isError = true;
        } else if (!api) {
          resultContent = JSON.stringify({
            error: `Tool "${toolName}" unavailable: this run has no Paperclip auth token.`,
          });
          isError = true;
        } else {
          try {
            const out = await tool.execute(args);
            resultContent = out.content;
            isError = out.isError;
          } catch (err) {
            resultContent = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            isError = true;
          }
        }

        await emitToolResult(onLog, { toolUseId: tc.id, toolName, content: resultContent, isError });
        // Structured-event mirror: keep the live run view moving in real time.
        await emitStructured(
          isError ? "tool.error" : "tool.completed",
          `${toolName} ${isError ? "failed" : "completed"}`,
          { toolName, toolUseId: tc.id, isError, turn },
        );
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultContent });

        const callSig = `${toolName}::${JSON.stringify(args)}`;
        recentCalls.push(callSig);
        if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
        if (recentCalls.length === REPEAT_THRESHOLD && recentCalls.every((s) => s === callSig)) {
          await writeRawStderr(
            onLog,
            `[openrouter] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args - breaking loop.`,
          );
          runError = {
            message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments. The model appears stuck in a retry loop.`,
            code: "tool_repeat_loop",
          };
          stoppedReason = "repeat_loop";
          break;
        }
      }
      if (stoppedReason === "repeat_loop") break;
    }

    if (turn >= maxTurns && stoppedReason === "completed") {
      stoppedReason = "max_turns";
      await writeRawStderr(onLog, `[openrouter] hit max_turns (${maxTurns}), stopping`);
    }
    if (stoppedReason === "completed" && toolCallsEmitted > 0) {
      await emitStructured("run.progress", `Run finishing after ${turn} turns, ${toolCallsEmitted} tool calls`, {
        turns: turn,
        toolCalls: toolCallsEmitted,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runError = { message: reason, code: "openrouter_loop_failed" };
    stoppedReason = "error";
  }

  // -- post-loop: cost, comment, status --

  let costUsd: number | null = null;
  if (lastGenerationId) {
    const cost = await fetchGenerationCost(lastGenerationId, apiKey);
    costUsd = cost.costUsd;
    // Prefer the generation endpoint's token counts when present.
    if (cost.inputTokens > 0 || cost.outputTokens > 0) {
      totalUsage = { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
    }
  }

  if (api && currentIssueId && finalAssistantText.trim().length > 0) {
    try {
      await api.addIssueComment(currentIssueId, { body: finalAssistantText });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not post final comment: ${reason}`);
    }
  }

  if (api && currentIssueId && stoppedReason !== "completed") {
    const blockReason =
      stoppedReason === "max_turns"
        ? `Hit max_turns (${maxTurns}) without completing`
        : runError?.message ?? null;
    if (blockReason) {
      // Paperclip's disposition gate rejects a bare agent-authored transition
      // to blocked (422) unless the issue has a pending interaction/approval,
      // unresolved blockers, or an unblockDescriptor. So: post the comment
      // FIRST, then create a request_confirmation interaction describing the
      // blocker, and only then attempt the blocked transition. If the
      // transition is still rejected the issue simply stays in its current
      // state with a visible pending interaction - which is the correct
      // outcome (the board sees the parked question) instead of an exception.
      const commentBody = `Run blocked: ${blockReason}`;
      try {
        await api.addIssueComment(currentIssueId, { body: commentBody });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not post block comment: ${reason}`);
      }
      try {
        await api.createIssueInteraction(currentIssueId, {
          kind: "request_confirmation",
          payload: {
            version: 1,
            prompt:
              `The run ended abnormally (${stoppedReason}). Reason: ${blockReason.slice(0, 900)}. ` +
              "Confirm to re-run this task, or reject to close it.",
          },
          idempotencyKey: `run-blocked:${ctx.runId ?? lastGenerationId ?? currentIssueId}`,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not create blocked-run interaction: ${reason}`);
      }
      try {
        await api.updateIssue(currentIssueId, { status: "blocked" });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Expected when no review path exists - the pending interaction above
        // already hands the issue to the board, so this is non-fatal.
        await writeRawStderr(onLog, `[openrouter] could not update final status (non-fatal): ${reason}`);
      }
    }
  }

  await emitResult(onLog, {
    text: finalAssistantText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    costUsd: costUsd ?? 0,
    subtype: stoppedReason === "completed" ? "success" : stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message] : [],
  });

  return {
    ...resultBase,
    exitCode: stoppedReason === "error" ? 1 : 0,
    ...(runError
      ? {
          errorMessage: runError.message,
          errorCode: runError.code,
          errorFamily: runError.family ?? undefined,
        }
      : {}),
    usage: totalUsage,
    costUsd,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: {
      ...(lastGenerationId ? { lastGenerationId } : {}),
      lastMessages: messages.slice(-6).map(function(m) { return { role: m.role, content: (m.content ?? "").slice(0, 500) }; }),
    },
    summary: finalAssistantText.slice(0, 500),
  };
}