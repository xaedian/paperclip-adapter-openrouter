// ─────────────────────────────────────────────────────────────────
// OpenRouter adapter for Paperclip - root metadata.
// Shared across server · cli · ui-parser. Metadata below is dependency-
// free; createServerAdapter() is re-exported from ./server because
// Paperclip's plugin loader imports the package MAIN entry and calls it.
// ─────────────────────────────────────────────────────────────────

export { createServerAdapter } from "./server/index.js";

export const type = "openrouter" as const;
export const label = "OpenRouter";

// ── Static fallback models (shown when the API is unreachable) ──
export const models = [
  // Free tier
  { id: "openrouter/auto",                        label: "Auto (best route)" },
  { id: "meta-llama/llama-4-maverick:free",       label: "Llama 4 Maverick (free)" },
  { id: "meta-llama/llama-4-scout:free",          label: "Llama 4 Scout (free)" },
  { id: "google/gemma-3-27b-it:free",             label: "Gemma 3 27B (free)" },
  { id: "deepseek/deepseek-chat-v3-0324:free",    label: "DeepSeek V3 0324 (free)" },
  { id: "qwen/qwen3-235b-a22b:free",              label: "Qwen3 235B (free)" },
  { id: "mistralai/mistral-small-3.2-24b-instruct:free", label: "Mistral Small 3.2 (free)" },
  { id: "openai/gpt-oss-120b:free",               label: "GPT-OSS 120B (free)" },

  // Paid - frontier
  { id: "anthropic/claude-sonnet-4-6",            label: "Claude Sonnet 4.6" },
  { id: "anthropic/claude-opus-4-6",              label: "Claude Opus 4.6" },
  { id: "openai/gpt-4.1",                         label: "GPT-4.1" },
  { id: "openai/o4-mini",                         label: "o4-mini" },
  { id: "google/gemini-2.5-pro",                  label: "Gemini 2.5 Pro" },
  { id: "google/gemini-2.5-flash",                label: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-r1",                   label: "DeepSeek R1" },

  // Paid - mid-tier
  { id: "anthropic/claude-haiku-4-5",             label: "Claude Haiku 4.5" },
  { id: "openai/gpt-4.1-mini",                    label: "GPT-4.1 Mini" },
  { id: "openai/gpt-4o-mini",                     label: "GPT-4o Mini" },
  { id: "mistralai/mistral-medium-3",             label: "Mistral Medium 3" },
  { id: "qwen/qwen3-235b-a22b",                   label: "Qwen3 235B" },
];

// ── OpenRouter API constants ────────────────────────────────────
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models`;
export const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;
export const OPENROUTER_GENERATION_ENDPOINT = `${OPENROUTER_BASE_URL}/generation`;

/** Issue statuses accepted by Paperclip's issue update API. Keep in sync with ISSUE_STATUSES in @paperclipai/shared. */
export const PAPERCLIP_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;

/** Agent roles accepted by Paperclip's agent hire API. Keep in sync with AGENT_ROLES in @paperclipai/shared. */
export const PAPERCLIP_AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
] as const;

/** Priorities accepted by Paperclip's issue create/update API. Keep in sync with ISSUE_PRIORITIES in @paperclipai/shared. */
export const PAPERCLIP_ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;

// ── Adapter documentation ───────────────────────────────────────
export const agentConfigurationDoc = `# OpenRouter adapter configuration

Access 300+ models (50+ free) from every provider through a single OpenRouter API key,
with a full multi-turn tool-calling loop against Paperclip's REST API.

## Use when
- You want access to many providers/models without separate vendor keys
- You want free-tier models for cheap or experimental agents
- You need models not covered by native CLI adapters (Llama, Qwen, Mistral, DeepSeek, ...)

## Core fields
- \`model\` (string) - any OpenRouter model id, e.g. "anthropic/claude-sonnet-4-6".
  "openrouter/auto" lets OpenRouter pick per request; ":free" suffix routes to the free tier.
- \`apiKey\` (string) - per-agent override ONLY; leave blank for fleet default.
  Fleet key lives in the Paperclip Secrets Manager (OPENROUTER_API_KEY) and is
  resolved automatically at run time - no env vars or files involved.

## Tool loop
- \`maxTurns\` (number, default 30) - max model/tool round-trips per run
- \`autoApprove\` (boolean, default false) - skip the human approval gate on hire_agent
- \`requestTimeoutSec\` (number, default 600) - per-request timeout
- \`stream\` (boolean, default true) - live token streaming into the run transcript

## Local execution (workspace tools)
When \`enableLocalExec\` is true (default), the agent also gets workspace-confined
tools: \`run_command\`, \`read_file\`, \`write_file\`, \`list_dir\`. Paths are jailed to
\`workspaceDir\` (default: the host-managed per-agent workspace); command output is
byte-capped and commands are killed at their timeout.

## Sampling
- \`temperature\` (0-2, default 0.7), \`topP\` (default 1), \`maxTokens\` (default 16384,
  automatically clamped to the selected model's advertised maximum)
- \`reasoning\` (boolean) - extended thinking for reasoning-capable models
- \`transforms\` (string[]) - OpenRouter transforms, e.g. ["middle-out"]
- \`route\` ("fallback" | "no-fallback") - provider failover behaviour

## Instructions & skills
- \`systemPrompt\` (string) - base system prompt
- \`instructionsFilePath\` (string) - path to a markdown instructions file; overrides systemPrompt
- \`skillsDir\` (string) - directory of SKILL.md folders injected into the system prompt

## Don't use when
- You only need one provider and already have its native adapter/key
- You need local/offline inference

## Environment (server-side)
- OPENROUTER_API_KEY - fallback when apiKey config is empty
- PAPERCLIP_AGENT_JWT_SECRET - host-side; lets Paperclip mint the agent JWT this adapter
  uses for its tool calls (supportsLocalAgentJwt is enabled by default)
`;
// ── Types ───────────────────────────────────────────────────────

export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number;
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

export interface OpenRouterConfig {
  /** Any OpenRouter model id. Default "openrouter/auto". */
  model?: string;
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY env var. Supports Paperclip secret refs like {{OPENROUTER_API_KEY}}. */
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: boolean;
  transforms?: string[];
  route?: "fallback" | "no-fallback";
  httpReferer?: string;
  xTitle?: string;
  /** Max tool-loop turns per run. Default 30. */
  maxTurns?: number;
  /** Skip approval gates for hire_agent. Default false. */
  autoApprove?: boolean;
  /** Per-request timeout seconds. Default 600. */
  requestTimeoutSec?: number;
  /** Stream tokens via SSE. Default true; set false for plain request/response. */
  stream?: boolean;
  /** Enable guarded workspace-local tools (run_command/read_file/write_file/list_dir). Default true. */
  enableLocalExec?: boolean;
  /** Absolute workspace root for local exec tools. Default: host-managed per-agent workspace. */
  workspaceDir?: string;
  /** Extra environment notes injected into every run's system prompt (machine quirks, tool paths). Shared file tier: ~/.openrouter-adapter/config.json .environmentNotes */
  environmentNotes?: string;
  /** OS env var names surfaced into the Environment block when set on the host. Shared file tier: ~/.openrouter-adapter/config.json .environmentVars. Default ["COMSPEC"]. */
  environmentVars?: string[];
  /** Override path to skills directory. Default ~/.openrouter-adapter/skills */
  skillsDir?: string;
  /** Absolute path to a markdown file read at runtime and used as the system prompt (overrides systemPrompt). */
  instructionsFilePath?: string;
}
