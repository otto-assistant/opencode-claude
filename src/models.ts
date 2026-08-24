/**
 * Claude Code model catalog (from OpenChamber harness registry).
 *
 * In multi-account mode every model appears once per account as
 * `<model>@<account>` (the default account keeps bare ids so single-account
 * setups and pinned configs never see a rename). Model NAMES carry the
 * account label and the remaining quota, because the name is the one string
 * the host renders next to the composer — the place where "how much is left
 * on the account I am about to use" can actually be read.
 */
import {
  ACCOUNT_MODEL_SEPARATOR,
  EFFORT_LEVELS,
  type ClaudeEffort,
} from "./constants.js";
import {
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
  type ClaudeAccount,
} from "./accounts.js";
import { formatShortDuration, getAccountQuota } from "./quota.js";
import { getRateLimitSnapshot } from "./rate-limit.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

/** OpenCode may inject these before merging plugin variants — disable extras. */
export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
): ClaudeModel {
  return {
    id,
    name,
    reasoning: true,
    contextWindow: limit.context,
    maxTokens: limit.output,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

const ALIAS_MODELS: ClaudeModel[] = [
  model("fable", "Fable 5", LIMIT_1M),
  model("opus", "Opus 5", LIMIT_1M),
  model("sonnet", "Sonnet 5", LIMIT_1M),
  model("haiku", "Haiku 4.5", LIMIT_200K, "claude-haiku-4-5"),
];

const PINNED_MODELS: ClaudeModel[] = [
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
  model("claude-sonnet-4-6", "Sonnet 4.6", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K),
];

function buildCatalog(): ClaudeModel[] {
  const aliasResolved = new Set(
    ALIAS_MODELS.map((m) => m.resolvedId).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  const aliasNames = new Set(ALIAS_MODELS.map((m) => m.name));
  const visiblePins = PINNED_MODELS.filter(
    (m) => !aliasResolved.has(m.id) && !aliasNames.has(m.name),
  );
  return [...ALIAS_MODELS, ...visiblePins];
}

export const CLAUDE_CODE_MODELS: ClaudeModel[] = buildCatalog();

/**
 * Split `opus@work` into its parts. A bare id carries no account, which means
 * "whatever the session is already bound to, else the default account".
 */
export function parseAccountModelId(modelId: string): {
  baseModelId: string;
  accountId: string | null;
} {
  const raw = (modelId || "").trim();
  const at = raw.lastIndexOf(ACCOUNT_MODEL_SEPARATOR);
  if (at <= 0 || at === raw.length - 1) {
    return { baseModelId: raw, accountId: null };
  }
  return {
    baseModelId: raw.slice(0, at),
    accountId: raw.slice(at + 1).toLowerCase(),
  };
}

/**
 * Model id for an account. The default account keeps bare ids so existing
 * sessions, pinned configs and single-account setups never see a rename.
 */
export function composeAccountModelId(
  baseModelId: string,
  account: ClaudeAccount,
): string {
  if (!isMultiAccount() || account.isDefault) return baseModelId;
  return `${baseModelId}${ACCOUNT_MODEL_SEPARATOR}${account.id}`;
}

function nameQuotaDisabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_MODEL_QUOTA ?? "").toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

/**
 * One window as `<label> <pct-left>%[ <time until refill>]`.
 *
 * Once `resetsAt` is behind us the stored utilization describes a window
 * that has since rolled over — it does NOT mean the window came back full.
 * An unknown is worth saying; a wrong number is not.
 */
function windowLabel(
  window: { remaining: number; resetsAt?: number } | undefined,
  label: string,
  now: number,
): string | null {
  if (!window) return null;
  if (window.resetsAt !== undefined && window.resetsAt <= now) {
    return `${label} ?`;
  }
  const pct = `${Math.round(Math.min(1, Math.max(0, window.remaining)) * 100)}%`;
  if (window.resetsAt === undefined) return `${label} ${pct}`;
  return `${label} ${pct} ${formatShortDuration(window.resetsAt - now)}`;
}

/**
 * Remaining quota as a model-name suffix, e.g. ` · 5h 96% 2h 20m · 7d 4% 5d`.
 * A hard block outranks any percentage: the next turn on this account will
 * be refused, and that is the only thing worth reading when choosing.
 * Disable with OPENCODE_CLAUDE_MODEL_QUOTA=0.
 */
export function quotaNameSuffix(
  accountId: string,
  now: number = Date.now(),
): string {
  if (nameQuotaDisabled()) return "";
  const gate = getRateLimitSnapshot(now, accountId);
  if (gate.limited) {
    const until = gate.limitedUntil ?? gate.resetsAt;
    const wait = until && until > now ? ` ${formatShortDuration(until - now)}` : "";
    return ` · limited${wait}`;
  }
  const quota = getAccountQuota(accountId);
  if (!quota) return "";
  const parts = [
    windowLabel(quota.windows.fiveHour, "5h", now),
    windowLabel(quota.windows.sevenDay, "7d", now),
  ].filter((p): p is string => p !== null);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Catalog as the host should show it. Single account: the plain catalog with
 * a quota suffix when one is known. Several accounts: every model appears
 * once per account, named `<Model> (<account label>)<quota suffix>`.
 */
export function getClaudeModels(): ClaudeModel[] {
  if (!isMultiAccount()) {
    const suffix = quotaNameSuffix(getDefaultAccount().id);
    if (!suffix) return CLAUDE_CODE_MODELS;
    return CLAUDE_CODE_MODELS.map((entry) => ({
      ...entry,
      name: `${entry.name}${suffix}`,
    }));
  }
  const result: ClaudeModel[] = [];
  for (const account of getAccounts()) {
    const suffix = quotaNameSuffix(account.id);
    for (const entry of CLAUDE_CODE_MODELS) {
      result.push({
        ...entry,
        id: composeAccountModelId(entry.id, account),
        name: `${entry.name} (${account.label})${suffix}`,
      });
    }
  }
  return result;
}

/** Resolve a base model id (account suffix already stripped) to the SDK id. */
export function resolveClaudeModelId(modelId: string): string {
  const { baseModelId } = parseAccountModelId(modelId);
  const match = CLAUDE_CODE_MODELS.find((m) => m.id === baseModelId);
  if (!match) return baseModelId || modelId;
  return match.resolvedId || match.id;
}

/**
 * Runtime variants for the provider.models() hook.
 * Keys are OpenCode UI choices; values carry the effort level for chat.headers.
 */
export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  if (!model.reasoning) return {};
  const variants: Record<
    string,
    { effort: ClaudeEffort } | { disabled: true }
  > = Object.fromEntries(EFFORT_LEVELS.map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

/**
 * Static config variants. Same effort map; OpenCode merges these into the menu.
 * Mark config model `reasoning: false` so OpenCode does not prepend its own
 * generic low/medium/high ahead of this map.
 */
export function buildConfigVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
