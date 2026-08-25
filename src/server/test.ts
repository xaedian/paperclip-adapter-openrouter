// ─────────────────────────────────────────────────────────────────
// OpenRouter API key resolution - Paperclip Secrets Manager ONLY:
//   1. literal per-agent adapterConfig.apiKey override
//   2. Paperclip secret resolved via the agent's granted-secrets runtime
//      surface, referenced by {{SECRET_NAME}} or a secret_ref binding
// ─────────────────────────────────────────────────────────────────

export type OpenRouterKeySource = "agent_config_literal" | "paperclip_env" | "paperclip_secret";

export interface ResolvedOpenRouterKey {
  key: string;
  source: OpenRouterKeySource;
}

export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}...${key.slice(-4)}` : "***";
}

/**
 * Config key holding the Paperclip secret binding. Kept separate from the
 * display-friendly apiKey field (which carries the {{SECRET_NAME}} reference)
 * so the UI stays clean while the runtime binding still registers.
 */
export const SECRET_BINDING_CONFIG_KEY = "openrouterApiKeySecret";

/** Fleet-default secret consulted when adapterConfig.apiKey is blank.
 *  Granted via Agent > Secrets > API Access. */
export const DEFAULT_SECRET_NAME = "OPENROUTER_API_KEY";

/**
 * API key resolution - Paperclip Secrets Manager ONLY:
 *   1. Literal non-ref string in adapterConfig.apiKey (per-agent override)
 *   2. Paperclip-resolved environment variable: adapterConfig.env
 *      .OPENROUTER_API_KEY declared as {type:"secret_ref",secretId} - the
 *      host swaps in the real value before the adapter sees it.
 *   3. {{SECRET_NAME}} / secret_ref / fleet-default resolution via the
 *      agent's granted-secrets runtime surface.
 *
 * No OS-env or file-based tiers exist by design. Grants are managed via
 * Agent > Secrets > API Access (or the env binding above).
 */
export async function resolveOpenRouterApiKey(
  config: Record<string, unknown>,
  ctx?: {
    api?: import("./paperclip-api.js").PaperclipApi | null;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<ResolvedOpenRouterKey | null> {
  const raw = config?.apiKey;

  // Per-agent literal override.
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith("{{")) {
      return { key: trimmed, source: "agent_config_literal" };
    }
  }

  // Paperclip-resolved environment variable (secret_ref swapped by host).
  const envVal = (config?.env as Record<string, unknown> | undefined)?.OPENROUTER_API_KEY;
  if (typeof envVal === "string" && envVal.trim().length > 0 && !envVal.startsWith("{{")) {
    return { key: envVal.trim(), source: "paperclip_env" };
  }

  // Derive the secret name / id from whichever reference shape is present;
  // fall back to the fleet-default secret name so a granted agent works
  // with a completely empty apiKey field.
  let name: string | null = null;
  let secretId: string | null = null;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^\{\{(.+)\}\}$/);
    if (m) name = m[1].trim();
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.type === "secret_ref" && typeof o.secretId === "string") secretId = o.secretId;
  }
  const binding = config?.[SECRET_BINDING_CONFIG_KEY] as Record<string, unknown> | undefined;
  if (!secretId && binding && typeof binding.secretId === "string") secretId = binding.secretId;
  if (!name && !secretId) name = DEFAULT_SECRET_NAME;
  if ((name || secretId) && ctx?.api) {
    const dbg = async (m: string) => {
      if (ctx.onLog) await ctx.onLog("stderr", `[openrouter] secret tier: ${m}\n`);
    };
    try {
      const list = await ctx.api.listMySecrets();
      await dbg(`granted=${list.length} name=${name ?? "-"} secretId=${secretId ?? "-"}`);
      const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
      // The host lowercases secret keys and strips secretId from list output,
      // so match by case-insensitive key/name; fall back to the sole entry
      // when only a secretId is known and the agent has exactly one grant.
      let entry =
        list.find(
          (s) =>
            (name && (norm(s.key) === norm(name) || norm(s.name) === norm(name))) ||
            (secretId && norm(s.secretId) === norm(secretId)),
        ) ?? null;
      if (!entry && secretId && list.length === 1) entry = list[0];
      if (entry && typeof entry.key === "string") {
        const val = await ctx.api.getMySecretValue(entry.key);
        if (val?.value) return { key: val.value, source: "paperclip_secret" };
        await dbg("value endpoint returned empty");
      } else {
        await dbg("no matching granted entry");
      }
    } catch (err) {
      await dbg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
