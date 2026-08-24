/**
 * Server module for the OpenRouter adapter.
 *
 * Exposes createServerAdapter(), the entry point Paperclip's adapter plugin
 * loader expects (see @paperclipai/server/dist/adapters/plugin-loader.js):
 * it imports this package's main entry and calls createServerAdapter(),
 * validating that the returned module has a "type".
 *
 * Everything is declared on the module itself — supportsLocalAgentJwt,
 * config schema, model discovery, skills, session codec — so no Paperclip
 * source patches are needed on any version that ships the external
 * adapter plugin store (>= 2026.40x).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type {
  AdapterConfigSchema,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterModel,
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

import { agentConfigurationDoc, label, models as fallbackModels, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment, listOpenRouterModels } from "./test.js";

export { execute };
export { testEnvironment, listOpenRouterModels };

// ─────────────────────────────────────────────────────────────────
// Model discovery
// ─────────────────────────────────────────────────────────────────

/** Cached dynamic models; refreshed by refreshModels() or when stale. */
let cachedModels: AdapterModel[] | null = null;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadModels(force: boolean): Promise<AdapterModel[]> {
  const now = Date.now();
  if (!force && cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }
  const discovered = await listOpenRouterModels();
  if (discovered.length > 0) {
    cachedModels = discovered;
    cachedModelsAt = now;
    return discovered;
  }
  // Discovery failed — fall back to the static list rather than nothing.
  return cachedModels ?? fallbackModels;
}

async function listModels(): Promise<AdapterModel[]> {
  return loadModels(false);
}

async function refreshModels(): Promise<AdapterModel[]> {
  return loadModels(true);
}

// ─────────────────────────────────────────────────────────────────
// Declarative config schema — lets the stock UI render our agent
// form without shipping any React components.
// ─────────────────────────────────────────────────────────────────

function getConfigSchema(): AdapterConfigSchema {
  // NOTE: do NOT declare `model` or `instructionsFilePath` here - the stock
  // agent form already renders a Model picker (fed by models/listModels)
  // and, when supportsInstructionsBundle is true, an instructions editor.
  return {
    fields: [
      {
        key: "apiKey",
        label: "OpenRouter API key",
        type: "text",
        hint: "sk-or-v1-... Leave blank to use OPENROUTER_API_KEY env var, or use a secret ref like {{OPENROUTER_API_KEY}}.",
      },
      {
        key: "systemPrompt",
        label: "System prompt",
        type: "textarea",
        hint: "Base system prompt prepended to every request.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: 0.7,
        hint: "Sampling temperature 0-2.",
      },
      {
        key: "maxTokens",
        label: "Max completion tokens",
        type: "number",
        default: 16384,
        hint: "Per-request completion budget. Automatically clamped to the selected model's advertised maximum.",
      },
      {
        key: "maxTurns",
        label: "Max tool-loop turns",
        type: "number",
        default: 30,
        hint: "Maximum model/tool round-trips per run.",
      },
      {
        key: "requestTimeoutSec",
        label: "Request timeout (sec)",
        type: "number",
        default: 600,
      },
      {
        key: "stream",
        label: "Token streaming",
        type: "toggle",
        default: true,
        hint: "Stream tokens live to the run transcript via SSE. Disable for plain request/response.",
      },
      {
        key: "enableLocalExec",
        label: "Workspace local execution",
        type: "toggle",
        default: true,
        hint: "Adds run_command / read_file / write_file / list_dir tools, confined to the agent workspace.",
      },
      {
        key: "workspaceDir",
        label: "Workspace directory",
        type: "text",
        hint: "Absolute root for local exec tools. Default: the host-managed per-agent workspace.",
      },
      {
        key: "environmentNotes",
        label: "Environment notes",
        type: "textarea",
        hint: "Extra facts injected into every run's system prompt (machine quirks, tool paths). Fleet-wide tier: ~/.openrouter-adapter/config.json .environmentNotes",
      },
      {
        key: "reasoning",
        label: "Extended thinking",
        type: "toggle",
        default: false,
        hint: "Enable for reasoning-capable models (DeepSeek R1, QwQ, ...).",
      },
      {
        key: "autoApprove",
        label: "Auto-approve hires",
        type: "toggle",
        default: false,
        hint: "Skip the human approval gate for hire_agent. Keep off in production.",
      },
      {
        key: "route",
        label: "Provider routing",
        type: "select",
        default: "fallback",
        options: [
          { label: "Fallback (failover on errors)", value: "fallback" },
          { label: "No fallback", value: "no-fallback" },
        ],
      },
      {
        key: "skillsDir",
        label: "Skills directory",
        type: "text",
        hint: "Directory of SKILL.md folders injected into the system prompt. Default ~/.openrouter-adapter/skills",
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────
// Session codec — persists lastGenerationId across heartbeats so the
// run viewer shows a stable display id and future versions can chain
// conversations.
// ─────────────────────────────────────────────────────────────────

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = (raw as Record<string, unknown>).lastGenerationId;
    return typeof id === "string" ? { lastGenerationId: id } : null;
  },
  serialize(params) {
    if (!params || typeof params !== "object") return null;
    const id = (params as Record<string, unknown>).lastGenerationId;
    return typeof id === "string" ? { lastGenerationId: id } : null;
  },
  getDisplayId(params) {
    if (!params || typeof params !== "object") return null;
    const id = (params as Record<string, unknown>).lastGenerationId;
    return typeof id === "string" ? id : null;
  },
};

// ─────────────────────────────────────────────────────────────────
// detectModel — OpenRouter has no local CLI config to read; the env
// var is the only meaningful source.
// ─────────────────────────────────────────────────────────────────

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
} | null> {
  const fromEnv = process.env.OPENROUTER_MODEL;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { model: fromEnv.trim(), provider: "openrouter", source: "env:OPENROUTER_MODEL" };
  }
  return { model: "openrouter/auto", provider: "openrouter", source: "default" };
}

// ─────────────────────────────────────────────────────────────────
// Skills — ephemeral mode. We scan an operator-managed root
// (~/.openrouter-adapter/skills by default) and report each subdir
// containing a SKILL.md as an external skill. Paperclip-managed
// runtime skills (config.paperclipRuntimeSkills) are additionally
// injected into the prompt by execute().
// ─────────────────────────────────────────────────────────────────

function defaultSkillsRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".openrouter-adapter", "skills");
}

export async function listSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const root = process.env.PAPERCLIP_SKILLS_DIR?.trim() || defaultSkillsRoot();
  const snapshot: AdapterSkillSnapshot = {
    adapterType: "openrouter",
    supported: true,
    mode: "ephemeral",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    snapshot.warnings.push(`Skills root ${root} not present.`);
    return snapshot;
  }

  for (const entry of dirents) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(root, entry.name);
    try {
      await fs.access(path.join(skillDir, "SKILL.md"));
    } catch {
      continue;
    }
    snapshot.entries.push({
      key: entry.name,
      runtimeName: entry.name,
      desired: true,
      managed: false,
      state: "external",
      origin: "external_unknown",
      sourcePath: skillDir,
      targetPath: skillDir,
    });
  }

  return snapshot;
}

export async function syncSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Skills are managed externally (operator drops them into the root).
  return listSkills(ctx);
}

// ─────────────────────────────────────────────────────────────────
// Module assembly
// ─────────────────────────────────────────────────────────────────

export function createServerAdapter(): ServerAdapterModule & { label: string } {
  return {
    type,
    label,
    execute: ((ctx: AdapterExecutionContext) =>
      execute(ctx)) as (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
    testEnvironment: (async (ctx): Promise<AdapterEnvironmentTestResult> =>
      testEnvironment(ctx)),
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    models: fallbackModels,
    listModels,
    refreshModels,
    detectModel,
    sessionCodec,
    listSkills,
    syncSkills,
    getConfigSchema,
    agentConfigurationDoc,
  };
}
