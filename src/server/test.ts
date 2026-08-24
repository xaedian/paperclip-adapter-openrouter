// ─────────────────────────────────────────────────────────────────
// OpenRouter API key resolution - tiered, first match wins:
//   1. per-agent adapterConfig.apiKey   (supports {{SECRET_REF}} refs)
//   2. shared file %USERPROFILE%\.openrouter-adapter\config.json .apiKey
//   3. OPENROUTER_API_KEY environment variable (instance .env, Windows env)
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

export type OpenRouterKeySource = "agent_config" | "shared_config_file" | "env";

export interface ResolvedOpenRouterKey {
  key: string;
  source: OpenRouterKeySource;
}

export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}...${key.slice(-4)}` : "***";
}

export async function resolveOpenRouterApiKey(
  config: Record<string, unknown>,
): Promise<ResolvedOpenRouterKey | null> {
  const fromConfig = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  // Unresolved {{SECRET_REF}} placeholders count as absent so lower tiers can serve.
  if (fromConfig && !fromConfig.startsWith("{{")) {
    return { key: fromConfig, source: "agent_config" };
  }
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const raw = await fs.readFile(path.join(home, ".openrouter-adapter", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    const shared = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (shared) return { key: shared, source: "shared_config_file" };
  } catch {
    // No shared config file - fall through.
  }
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Environment check (Test Environment button)
// ─────────────────────────────────────────────────────────────────

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import {
  OPENROUTER_MODELS_ENDPOINT,
  type OpenRouterConfig,
  type OpenRouterModel,
} from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config as unknown as OpenRouterConfig;

  // ── 1. Check API key (tiered) ─────────────────────────────────
  const resolved = await resolveOpenRouterApiKey(ctx.config ?? {});

  if (!resolved) {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: "No OpenRouter API key found in any tier",
      detail:
        "Tiers checked: agent adapterConfig.apiKey, ~/.openrouter-adapter/config.json (.apiKey), OPENROUTER_API_KEY env var.",
      hint: "Get a key at https://openrouter.ai/keys",
    });
    return {
      adapterType: "openrouter",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const apiKey = resolved.key;

  if (!apiKey.startsWith("sk-or-")) {
    checks.push({
      code: "openrouter_api_key_format",
      level: "warn",
      message: "API key does not start with \"sk-or-\"",
      hint: "Ensure this is a valid OpenRouter key.",
    });
  }

  checks.push({
    code: "openrouter_api_key_found",
    level: "info",
    message: `API key found via ${resolved.source}: ${maskKey(apiKey)}`,
  });

  // ── 2. Test API connectivity & fetch models ───────────────────
  try {
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      checks.push({
        code: "openrouter_api_error",
        level: "error",
        message: `OpenRouter API returned ${res.status}`,
        detail: errText.slice(0, 200),
      });
      return {
        adapterType: "openrouter",
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const data = (await res.json()) as { data: OpenRouterModel[] };
    const allModels = data.data || [];

    const freeModels = allModels.filter(
      (m) =>
        m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0")
    );

    checks.push({
      code: "openrouter_connected",
      level: "info",
      message: `Connected — ${allModels.length} models available (${freeModels.length} free)`,
    });

    // ── 3. Validate selected model ──────────────────────────────
    const selectedModel = config.model || "openrouter/auto";

    if (selectedModel === "openrouter/auto") {
      checks.push({
        code: "openrouter_model_auto",
        level: "info",
        message: "Using auto-routing — OpenRouter selects the best model per request",
      });
    } else {
      const model = allModels.find((m) => m.id === selectedModel);
      if (model) {
        const promptCost = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
        const completionCost = parseFloat(model.pricing?.completion || "0") * 1_000_000;
        checks.push({
          code: "openrouter_model_found",
          level: "info",
          message: `Model "${selectedModel}" — $${promptCost.toFixed(2)}/$${completionCost.toFixed(2)} per 1M tokens, ${model.context_length?.toLocaleString()} ctx`,
        });
      } else {
        checks.push({
          code: "openrouter_model_not_found",
          level: "warn",
          message: `Model "${selectedModel}" not found — may be deprecated or misspelled`,
        });
      }
    }

    const hasErrors = checks.some((c) => c.level === "error");
    const hasWarnings = checks.some((c) => c.level === "warn");

    return {
      adapterType: "openrouter",
      status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    checks.push({
      code: "openrouter_connection_failed",
      level: "error",
      message: `Failed to connect to OpenRouter: ${err.message || err}`,
    });
    return {
      adapterType: "openrouter",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }
}

/**
 * Fetch all models from OpenRouter's public catalog - no API key required,
 * so the model picker works even before credentials are configured.
 * Returns entries sorted free-tier first, then alphabetically, each with the
 * model's advertised max completion tokens (used to clamp requests).
 */
export interface OpenRouterCatalogEntry {
  id: string;
  label: string;
  maxCompletionTokens: number | null;
  contextLength: number | null;
}

let catalogCache: { at: number; entries: OpenRouterCatalogEntry[] } | null = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

export async function fetchOpenRouterCatalog(force = false): Promise<OpenRouterCatalogEntry[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.entries;
  }
  try {
    console.error(`[openrouter] fetching model catalog (force=${force})`);
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`[openrouter] catalog fetch HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return catalogCache?.entries ?? [];
    }
    const data = (await res.json()) as { data?: OpenRouterModel[] };
    const entries: OpenRouterCatalogEntry[] = (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.name || m.id,
      maxCompletionTokens:
        typeof m.top_provider?.max_completion_tokens === "number"
          ? m.top_provider.max_completion_tokens
          : null,
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
    }));
    if (entries.length === 0) return catalogCache?.entries ?? [];
    entries.sort((a, b) => {
      const aFree = a.id.endsWith(":free");
      const bFree = b.id.endsWith(":free");
      if (aFree !== bFree) return aFree ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    catalogCache = { at: Date.now(), entries };
    console.error(`[openrouter] model catalog loaded: ${entries.length} models`);
    return entries;
  } catch (err) {
    console.error(`[openrouter] catalog fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return catalogCache?.entries ?? [];
  }
}

/** Look up a model's advertised max completion tokens (null when unknown). */
export async function getModelMaxCompletionTokens(modelId: string): Promise<number | null> {
  const entries = await fetchOpenRouterCatalog();
  return entries.find((e) => e.id === modelId)?.maxCompletionTokens ?? null;
}

export async function listOpenRouterModels(): Promise<{ id: string; label: string }[]> {
  return (await fetchOpenRouterCatalog()).map(({ id, label }) => ({ id, label }));
}
