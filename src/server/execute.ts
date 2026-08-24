/**
 * OpenRouter adapter execute() — multi-turn tool-calling loop.
 *
 * Restored from the originally-verified v2 implementation and updated for
 * the Paperclip external-adapter contract (adapter-utils >= 2026.4xx):
 *   - AdapterExecutionContext is non-generic; config is merged from
 *     ctx.agent.adapterConfig over ctx.config
 *   - AdapterExecutionResult: exitCode/signal/timedOut required; usage has
 *     input/output (+cached) tokens only; costUsd is top-level
 *   - wake prompt rendered via renderPaperclipWakePrompt(context) — no
 *     skillsPrompt option; skills are appended to the system prompt here
 *   - issue updates send only schema-known fields (status); reasons go
 *     into comments instead of a statusReason field
 *
 * Auth model (important):
 *   - ctx.authToken is the PAPERCLIP agent JWT (minted by the host because
 *     we declare supportsLocalAgentJwt: true). It authenticates tool calls
 *     against Paperclip's REST API ONLY.
 *   - The OpenRouter key always comes from adapterConfig.apiKey or the
 *     OPENROUTER_API_KEY env var — never from ctx.authToken.
 */

import fs from "node:fs/promises";
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
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools, findTool, toolSchemas, type Tool } from "./tools.js";
import { getModelMaxCompletionTokens, resolveOpenRouterApiKey } from "./test.js";
import { loadSkills, renderSkillsForPrompt } from "./skills.js";
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

// ── OpenRouter / OpenAI chat completion types ───────────────────

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

// ── helpers ─────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_REQUEST_TIMEOUT_SEC = 600;
const DEFAULT_SYSTEM_PROMPT =
  "You are an AI agent working inside Paperclip, an autonomous company orchestration system. " +
  "When you receive a wake payload, your job is to EXECUTE the assigned task - not describe it. " +
  "Use the tools available to you to read context, post comments, update status, and delegate work. " +
  "When finished, post a summary comment via add_comment and call update_issue_status with status='done'. " +
  "If you cannot complete the work, explain why in a comment and set status='blocked'.";

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

async function callOpenRouterOnce(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  timeoutMs: number,
): Promise<ChatCompletionResponse> {
  const requestedMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    max_tokens: requestedMaxTokens,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
  };
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

  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(apiKey, config),
      body: JSON.stringify(body),
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

  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new OpenRouterHttpError(`OpenRouter returned invalid JSON: ${text.slice(0, 200)}`, 500);
  }
}

/** One conservative retry for transient failures (429 / 5xx / network). */
async function callOpenRouter(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
  timeoutMs: number,
): Promise<ChatCompletionResponse> {
  try {
    return await callOpenRouterOnce(apiKey, config, messages, tools, timeoutMs);
  } catch (err) {
    const retriable =
      err instanceof OpenRouterHttpError && (err.status === 429 || err.status >= 500);
    if (!retriable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return callOpenRouterOnce(apiKey, config, messages, tools, timeoutMs);
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

// ── main ────────────────────────────────────────────────────────

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = resolveConfig(ctx);
  const { onLog, authToken } = ctx;
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
    });
  }

  await emitInit(onLog, { model, sessionId: ctx.runId });

  // ── build messages ───────────────────────────────────────────

  const messages: ChatMessage[] = [];
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // instructionsFilePath overrides systemPrompt (mirrors claude_local et al).
  if (typeof config.instructionsFilePath === "string" && config.instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(config.instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) systemContent = fileContent.trim();
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
  messages.push({ role: "system", content: systemContent });

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

  // ── acquire the issue run lock ───────────────────────────────
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

  // ── mark issue in_progress ───────────────────────────────────

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not set issue in_progress: ${reason}`);
    }
  }

  // ── resolve OpenRouter key (tiered) ──────────────────────────

  let apiKey: string;
  try {
    const resolved = await resolveOpenRouterApiKey(config);
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

  // ── tool loop ────────────────────────────────────────────────

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let finalAssistantText = "";
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: { message: string; code: string; family?: ErrorFamily | null } | null = null;

  // Repeat-call detection: same tool + same args N times in a row breaks the
  // loop instead of burning budget on a stuck model.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;

  try {
    while (turn < maxTurns) {
      turn += 1;

      let response: ChatCompletionResponse;
      try {
        response = await callOpenRouter(apiKey, effectiveConfig, messages, tools, requestTimeoutMs);
      } catch (err) {
        const family = err instanceof OpenRouterHttpError ? err.family : null;
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "openrouter_request_failed", family };
        stoppedReason = "error";
        break;
      }

      lastGenerationId = response.id || lastGenerationId;
      if (response.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (response.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (response.usage.completion_tokens ?? 0),
        };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        runError = {
          message: "OpenRouter returned no choices (model may not exist or is unavailable)",
          code: "openrouter_empty_response",
          family: "transient_upstream",
        };
        stoppedReason = "error";
        break;
      }

      const msg = choice.message;
      const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls ?? [];

      if (reasoning) await emitThinking(onLog, reasoning);
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }

      // No tool calls => model is done.
      if (toolCalls.length === 0) {
        stoppedReason = "completed";
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
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });

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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runError = { message: reason, code: "openrouter_loop_failed" };
    stoppedReason = "error";
  }

  // ── post-loop: cost, comment, status ─────────────────────────

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
      try {
        await api.updateIssue(currentIssueId, { status: "blocked" });
        await api.addIssueComment(currentIssueId, { body: `Run blocked: ${blockReason}` });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not update final status: ${reason}`);
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
    sessionParams: lastGenerationId ? { lastGenerationId } : null,
    summary: finalAssistantText.slice(0, 500),
  };
}
