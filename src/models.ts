/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import {
  ACCOUNT_MODEL_SEPARATOR,
  EFFORT_LEVELS,
  type ClaudeEffort,
} from "./constants.js";
import {
  accountIcons,
  getAccounts,
  getDefaultAccount,
  isMultiAccount,
  type ClaudeAccount,
} from "./accounts.js";
import { formatShortDuration, getAccountQuota } from "./quota.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
  /** List API price, $/1M tokens. See API_PRICING. */
  cost?: ModelCost;
};

export type ModelCost = {
  input: number;
  output: number;
  cache: { read: number; write: number };
};

/**
 * Anthropic list prices, $ per 1M tokens — what these turns WOULD cost on an
 * API key. Nothing here is billed: a subscription turn costs quota, not money.
 * It is published because "what am I spending" is unanswerable otherwise, and
 * because the host renders cost per response from this very field: without it
 * every turn reads $0.00, which is a claim, not a blank.
 *
 * Cache rates follow Anthropic's published multipliers on the input rate:
 * reads at 0.1x, 5-minute writes at 1.25x.
 *
 * Set OPENCODE_CLAUDE_MODEL_COST=0 to publish nothing and go back to zeros.
 */
const API_PRICING: Record<string, { input: number; output: number }> = {
  "Fable 5": { input: 10, output: 50 },
  "Opus 5": { input: 5, output: 25 },
  "Opus 4.8": { input: 5, output: 25 },
  "Sonnet 5": { input: 3, output: 15 },
  "Sonnet 4.6": { input: 3, output: 15 },
  "Haiku 4.5": { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function costFor(name: string): ModelCost | undefined {
  if (modelCostDisabled()) return undefined;
  const listed = API_PRICING[name];
  if (!listed) return undefined;
  return {
    input: listed.input,
    output: listed.output,
    cache: {
      read: Number((listed.input * CACHE_READ_MULTIPLIER).toFixed(4)),
      write: Number((listed.input * CACHE_WRITE_MULTIPLIER).toFixed(4)),
    },
  };
}

export function modelCostDisabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_MODEL_COST ?? "").toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

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
  const cost = costFor(name);
  return {
    id,
    name,
    reasoning: true,
    contextWindow: limit.context,
    maxTokens: limit.output,
    ...(resolvedId ? { resolvedId } : {}),
    ...(cost ? { cost } : {}),
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

/** Placeholder so OpenCode keeps the provider visible while logged out. */
export const LOGIN_PLACEHOLDER_MODELS: ClaudeModel[] = [
  {
    id: "login",
    name: "Sign in to Claude Code",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

export function isLoginPlaceholderModel(id: string): boolean {
  return id === "login" || id.startsWith(`login${ACCOUNT_MODEL_SEPARATOR}`);
}

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

/**
 * Catalog as OpenCode should show it.
 *
 * Single account: the plain catalog, unchanged. Several accounts: every model
 * appears once per account, and each NAME leads with the account ICON — that
 * name is what OpenChamber prints in the model picker and in the session
 * header, so the account a session runs on is readable at a glance.
 *
 * A one-glyph mark rather than the label: the label is up to 64 characters and
 * sits in front of a name that already carries model plus two quota figures,
 * where it pushed the numbers off the visible line. The full label stays in the
 * provider group header, which is where there is room for it.
 */
/** Short window (five-hour) marker. */
const SHORT_WINDOW_MARK = "\u{1F7E2}"; // green circle
/** Long window (seven-day) marker. */
const LONG_WINDOW_MARK = "\u{1F535}"; // blue circle

/**
 * One window as `<mark> <pct>% <time until it refills>`.
 *
 * Naming the window ("5h", "7d") spent characters on the one thing that never
 * changes. What an operator actually decides on is when the ceiling lifts, so
 * the countdown takes that slot and the colour carries the identity instead:
 * green is the short window, blue the long one.
 *
 * Once `resetsAt` is behind us the stored utilization describes a window that
 * has already refilled, and printing it would answer a question nobody asked.
 * The store is written from live turns, so no update since the reset means no
 * spend since the reset: report it full, and drop the countdown because the
 * next window's reset is not known until the account is used again.
 */
function windowLabel(
  window: { remaining: number; resetsAt?: number } | undefined,
  mark: string,
  now: number,
): string | null {
  if (!window) return null;
  const refilled = window.resetsAt !== undefined && window.resetsAt <= now;
  if (refilled) return `${mark} 100%`;
  const pct = `${Math.round(window.remaining * 100)}%`;
  if (window.resetsAt === undefined) return `${mark} ${pct}`;
  return `${mark} ${pct} ${formatShortDuration(window.resetsAt - now)}`;
}

/**
 * Remaining quota as a model-name suffix, e.g. `🟢 96% 2h 20m · 🔵 4% 5d 3h`.
 *
 * The model name is the one string this plugin controls that the host renders
 * next to the composer, so it is where "how much is left on the account I am
 * about to use" can actually be read at the moment of choosing. Refreshes
 * whenever the host rebuilds the catalog — the countdowns are computed then,
 * so a picker left open drifts until the next rebuild.
 */
export function quotaNameSuffix(accountId: string): string {
  if (nameQuotaDisabled()) return "";
  const quota = getAccountQuota(accountId);
  if (!quota) return "";
  const now = Date.now();
  const parts = [
    windowLabel(quota.windows.fiveHour, SHORT_WINDOW_MARK, now),
    windowLabel(quota.windows.sevenDay, LONG_WINDOW_MARK, now),
  ].filter((p): p is string => p !== null);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function nameQuotaDisabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_MODEL_QUOTA ?? "").toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

export function getClaudeModels(): ClaudeModel[] {
  if (!isMultiAccount()) {
    // Single account: no label to add, but the remaining quota is just as
    // useful — it is the same question, asked of the only subscription there is.
    const suffix = quotaNameSuffix(getDefaultAccount().id);
    if (!suffix) return CLAUDE_CODE_MODELS;
    return CLAUDE_CODE_MODELS.map((model) => ({
      ...model,
      name: `${model.name}${suffix}`,
    }));
  }
  const icons = accountIcons();
  return getAccounts().flatMap((account) => {
    const suffix = quotaNameSuffix(account.id);
    const icon = icons.get(account.id);
    return CLAUDE_CODE_MODELS.map((model) => ({
      ...model,
      id: composeAccountModelId(model.id, account),
      name: `${icon ? `${icon} ` : ""}${model.name}${suffix}`,
      // resolvedId stays the real Claude model — the account rides the id.
      ...(model.resolvedId ? { resolvedId: model.resolvedId } : {}),
    }));
  });
}

/**
 * Catalog for ONE account's provider: plain model ids, and names carrying the
 * account icon plus the quota — the provider group already says which account
 * it is, so repeating the whole label in every row is noise, but the glyph is
 * what makes the SESSION HEADER (which shows the model name alone) say which
 * subscription is being spent.
 */
export function getClaudeModelsForAccount(account: ClaudeAccount): ClaudeModel[] {
  const suffix = quotaNameSuffix(account.id);
  const icon = isMultiAccount() ? accountIcons().get(account.id) : undefined;
  return CLAUDE_CODE_MODELS.map((model) => ({
    ...model,
    name: `${icon ? `${icon} ` : ""}${model.name}${suffix}`,
  }));
}

export function resolveClaudeModelId(modelId: string): string {
  const { baseModelId } = parseAccountModelId(modelId);
  const match = CLAUDE_CODE_MODELS.find((m) => m.id === baseModelId);
  if (!match) return baseModelId || modelId;
  return match.resolvedId || match.id;
}

/**
 * Account a model id points at. Bare ids resolve to the default account, so a
 * config pinned before multi-account existed keeps working.
 */
export function accountIdFromModelId(modelId: string): string {
  const { accountId } = parseAccountModelId(modelId);
  return accountId ?? getDefaultAccount().id;
}

/**
 * Runtime variants for the provider.models() hook.
 * Keys are OpenCode UI choices; values carry the effort level for chat.headers.
 */
export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  if (!model.reasoning || isLoginPlaceholderModel(model.id)) return {};
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
